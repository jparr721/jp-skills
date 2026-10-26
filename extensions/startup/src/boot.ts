import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { homedir } from "node:os";
import { scopeSchema, type Scope } from "./contracts";
import type { Environment } from "./employee-entry";

export class StartupBootError extends Error {}
function executionConfigHome(xdg: string | undefined): string {
  return xdg !== undefined && isAbsolute(xdg) ? resolve(xdg) : join(homedir(), ".config");
}
export function executionSkillsHome(environment: Environment): string {
  return resolve(environment.JP_SKILLS_HOME ?? join(executionConfigHome(environment.XDG_CONFIG_HOME), "jp-skills"));
}
export const ompProfileSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .refine((value) => !value.endsWith(".") && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value));
// Mirrors OMP 18.11.1 packages/utils/src/dirs.ts (normalizeProfileName, resolveProfileEnv): the schema is its profile-name rule and OMP_PROFILE wins even when empty, then PI_PROFILE; empty or "default" is the default profile.
export function ompProfileFromEnvironment(environment: Environment): string {
  const requested: string = (environment.OMP_PROFILE ?? environment.PI_PROFILE ?? "").trim();
  const profile = ompProfileSchema.safeParse(requested === "" ? "default" : requested);
  if (!profile.success) throw new StartupBootError(`Invalid OMP_PROFILE/PI_PROFILE "${requested}"; use the active OMP profile name and retry Startup`);
  return profile.data;
}
// Mirrors OMP 18.11.1 packages/utils/src/dirs.ts (DirResolver, getSessionsDir, getPluginsDir): PI_CONFIG_DIR under the home, a named profile's own root, an agent directory override that only the default profile honours,
// and the XDG data directory that replaces both when it exists and the agent directory is not overridden. `agent` holds sessions/ and `root` holds plugins/.
export function ompDirectories(environment: Environment, profile: string): Readonly<{ root: string; agent: string }> {
  const at = (directory: string): string => (profile === "default" ? directory : join(directory, "profiles", profile));
  const root: string = at(join(environment.HOME || homedir(), environment.PI_CONFIG_DIR || ".omp"));
  const override: string | undefined = profile === "default" ? environment.PI_CODING_AGENT_DIR : undefined;
  const agent: string = override ? resolve(override) : join(root, "agent");
  const xdgRoot: string | null = environment.XDG_DATA_HOME ? at(join(resolve(environment.XDG_DATA_HOME), "omp")) : null;
  const data: string | null = xdgRoot !== null && agent === join(root, "agent") && existsSync(xdgRoot) ? xdgRoot : null;
  return { root: data ?? root, agent: data ?? agent };
}
export function startupsDirectory(skillsHome: string): string {
  return join(skillsHome, "startup");
}
export function contains(parent: string, child: string): boolean {
  const within: string = relative(parent, child);
  return within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within));
}
const nameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const limitSchema = z.number().int().positive().safe().nullable();
const bindingSchema = z.strictObject({ scope: scopeSchema, executionLimit: limitSchema });
export type BootCommand =
  | Readonly<{
      kind: "new" | "select";
      name: string;
      directory: string | null;
      work: string | null;
    }>
  | Readonly<{ kind: "current" | "status"; work: string | null }>;
export type Selection = Scope & Readonly<{ skillsRoot: string; executionLimit: number | null }>;
type Binding = z.infer<typeof bindingSchema>;
type PathKind = "file" | "directory" | "socket" | "any";

function maybeStat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    const parsed = z.object({ code: z.string() }).safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") return null;
    throw error;
  }
}

function pathSegments(path: string): readonly string[] {
  return path.split(sep).filter((part) => part.length > 0);
}

function canonicalDirectory(path: string, label: string, allowMissing: boolean, privateDirectory: boolean): string {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new StartupBootError(`${label} must be an absolute canonical path: ${path}`);
  let cursor: string = sep;
  let missing: boolean = false;
  const segments: readonly string[] = pathSegments(path);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index]!);
    const stat = maybeStat(cursor);
    if (stat === null) {
      missing = true;
      continue;
    }
    if (missing)
      throw new StartupBootError(`${label} has an unexpected existing child below a missing ancestor: ${cursor}`);
    if (stat.isSymbolicLink())
      throw new StartupBootError(`${label} may not contain a symlink: ${cursor}`);
    if (!stat.isDirectory())
      throw new StartupBootError(`${label} component must be a directory: ${cursor}`);
    if (index === segments.length - 1 && privateDirectory && (stat.mode & 0o077) !== 0)
      throw new StartupBootError(`${label} must be owner-only: ${cursor}`);
  }
  if (missing && !allowMissing)
    throw new StartupBootError(`${label} directory does not exist: ${path}`);
  if (!missing && realpathSync(path) !== path)
    throw new StartupBootError(`${label} is not canonical: ${path}`);
  return path;
}

export function canonicalStartupRoot(path: string, allowMissing: boolean): string {
  return canonicalDirectory(path, "Startup root", allowMissing, true);
}

export function assertStartupPath(startupRoot: string, path: string, kind: PathKind): void {
  assertContainedPath(canonicalStartupRoot(startupRoot, false), path, kind);
}

export function assertSharedOmpTranscript(root: string, path: string): void {
  assertContainedPath(canonicalDirectory(root, "Shared OMP root", false, false), path, "file");
}

function assertContainedPath(root: string, path: string, kind: PathKind): void {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new StartupBootError(`Startup artifact path must be absolute and canonical: ${path}`);
  if (!contains(root, path))
    throw new StartupBootError(`Startup artifact escapes the selected root: ${path}`);
  const within: string = relative(root, path);
  let cursor: string = root;
  const segments: readonly string[] = within === "" ? [] : pathSegments(within);
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) cursor = join(cursor, segments[index]!);
    const stat = maybeStat(cursor);
    if (stat === null) break;
    if (stat.isSymbolicLink())
      throw new StartupBootError(`Startup artifact may not be a symlink: ${cursor}`);
    const final: boolean = index === segments.length - 1;
    if (!final && !stat.isDirectory())
      throw new StartupBootError(`Startup artifact parent must be a directory: ${cursor}`);
    if (final && kind === "file" && !stat.isFile())
      throw new StartupBootError(`Startup artifact must be a regular file: ${cursor}`);
    if (final && kind === "directory" && !stat.isDirectory())
      throw new StartupBootError(`Startup artifact must be a directory: ${cursor}`);
    if (final && kind === "socket" && !stat.isSocket())
      throw new StartupBootError(`Startup artifact must be a socket: ${cursor}`);
  }
}

export function ensureStartupRoot(path: string): string {
  const root: string = canonicalStartupRoot(path, true);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return canonicalStartupRoot(root, false);
}

function rejectRootOverlap(startupRoot: string, skillsHome: string, boundRoot: string): void {
  if (contains(startupRoot, skillsHome))
    throw new StartupBootError("Startup root may not contain JP_SKILLS_HOME");
  if (contains(startupRoot, boundRoot) || contains(boundRoot, startupRoot))
    throw new StartupBootError("Startup state must remain outside the bound repository");
}

function combineLimit(first: number | null, second: number | null): number | null {
  return first === null ? second : second === null ? first : Math.min(first, second);
}

function sameScope(first: Scope, second: Scope): boolean {
  return first.skillsHome === second.skillsHome && first.startupRoot === second.startupRoot &&
    first.host === second.host && first.name === second.name && first.boundRoot === second.boundRoot &&
    first.managerSession === second.managerSession;
}

function bindingPath(startupRoot: string): string {
  return join(startupRoot, "binding.json");
}

// An old-format Startup (binding.json without scope) is historical evidence: enumerators skip it, an explicit select refuses it.
export function isLegacyBinding(startupRoot: string): boolean {
  const path: string = bindingPath(startupRoot);
  if (maybeStat(path) === null) return false;
  const saved = z.record(z.string(), z.unknown()).safeParse(JSON.parse(readFileSync(path, "utf8")));
  return saved.success && !("scope" in saved.data);
}

function readBinding(startupRoot: string): Binding | null {
  const path: string = bindingPath(startupRoot);
  const stat = maybeStat(path);
  if (stat === null) return null;
  assertStartupPath(startupRoot, path, "file");
  if ((stat.mode & 0o077) !== 0)
    throw new StartupBootError(`Startup binding must be owner-only: ${path}`);
  let saved: Binding;
  try {
    saved = bindingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error: unknown) {
    throw new StartupBootError(`Startup binding is invalid and needs explicit recovery: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (saved.scope.startupRoot !== startupRoot)
    throw new StartupBootError(`Persisted Startup root does not match the selected root: ${path}`);
  canonicalDirectory(saved.scope.skillsHome, "JP_SKILLS_HOME", false, false);
  canonicalStartupRoot(saved.scope.startupRoot, false);
  canonicalDirectory(saved.scope.boundRoot, "Startup bound root", false, false);
  return saved;
}

function currentBoundRoot(cwd: string): string {
  const path: string = realpathSync(resolve(cwd));
  if (!lstatSync(path).isDirectory())
    throw new StartupBootError(`Startup bound root must be a directory: ${path}`);
  return path;
}

function discoverCurrentBinding(input: Readonly<{
  cwd: string;
  skillsHome: string;
  host: string;
  managerSession: string;
}>): Binding | null {
  const parent: string = startupsDirectory(input.skillsHome);
  const parentStat = maybeStat(parent);
  if (parentStat === null) return null;
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
    throw new StartupBootError(`Startup roots directory may not redirect: ${parent}`);
  const boundRoots: Set<string> = new Set();
  let directory: string = currentBoundRoot(input.cwd);
  while (true) {
    boundRoots.add(directory);
    const parentDirectory: string = dirname(directory);
    if (parentDirectory === directory) break;
    directory = parentDirectory;
  }
  const matches: Binding[] = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const root: string = join(parent, entry.name);
    const stat = maybeStat(root);
    if (stat === null) continue;
    if (stat.isSymbolicLink())
      throw new StartupBootError(`Startup root may not be a symlink: ${root}`);
    if (!stat.isDirectory() || isLegacyBinding(root)) continue;
    const binding = readBinding(root);
    if (binding === null) continue;
    if (binding.scope.skillsHome !== input.skillsHome)
      throw new StartupBootError(`Startup binding belongs to another JP_SKILLS_HOME: ${bindingPath(root)}`);
    if (boundRoots.has(binding.scope.boundRoot)) matches.push(binding);
  }
  if (matches.length > 1)
    throw new StartupBootError(`Bound repository has multiple Startup bindings: ${currentBoundRoot(input.cwd)}`);
  if (matches.length === 0) return null;
  const saved: Binding = matches[0]!;
  if (saved.scope.host !== input.host || saved.scope.managerSession !== input.managerSession)
    throw new StartupBootError(`Startup binding belongs to another host or manager session: ${bindingPath(saved.scope.startupRoot)}`);
  return saved;
}

export function parseBootCommand(args: string): BootCommand {
  const scanned = Array.from(args.matchAll(/"(?:[^"\\]|\\.)*"|\S+/g));
  const delimiter = scanned.findIndex((token) => token[0] === "--");
  const separator = delimiter < 0 ? undefined : scanned[delimiter];
  const work = separator === undefined ? null : args.slice(separator.index + 2).trimStart();
  if (work !== null && !work.trim()) throw new StartupBootError("Startup work after -- must be nonempty");
  const tokens = (delimiter < 0 ? scanned : scanned.slice(0, delimiter)).map((match): string =>
    match[0].startsWith('"') ? z.string().parse(JSON.parse(match[0])) : match[0]);
  if (tokens.length === 0) return { kind: "current", work };
  if (tokens[0] === "status" && tokens.length === 1 && work === null) return { kind: "status", work: null };
  if ((tokens[0] !== "new" && tokens[0] !== "select") || !tokens[1])
    throw new StartupBootError("Use /startup new <name> [--dir <JSON-quoted-path>] [-- <work>], /startup select <name> [-- <work>], or /startup status");
  const name: string = nameSchema.parse(tokens[1]);
  if (tokens.length !== 2 && (tokens[0] !== "new" || tokens.length !== 4 || tokens[2] !== "--dir" || !tokens[3]))
    throw new StartupBootError("Invalid Startup boot options; only new accepts --dir");
  return { kind: tokens[0], name, directory: tokens[3] ?? null, work };
}

export function bootSelection(input: Readonly<{
  cwd: string;
  skillsHome: string;
  startupRoot: string | null;
  skillsRoot: string;
  host: string;
  managerSession: string;
  command: BootCommand | null;
  explicitName: string | null;
  executionLimit: number | null;
}>): Selection | null {
  const executionLimit: number | null = limitSchema.parse(input.executionLimit);
  const skillsHome: string = canonicalDirectory(resolve(input.skillsHome), "JP_SKILLS_HOME", false, false);
  const skillsRoot: string = realpathSync(resolve(input.skillsRoot));
  const command: BootCommand | null = input.command;
  let name: string | null = command?.kind === "new" || command?.kind === "select"
    ? command.name
    : input.explicitName === null ? null : nameSchema.parse(input.explicitName);
  const override: string | null = input.startupRoot;
  if (override !== null && !isAbsolute(override))
    throw new StartupBootError(`STARTUP_ROOT must be absolute: ${override}`);
  if (name === null && override !== null) {
    const candidate: string = canonicalStartupRoot(resolve(override), true);
    const saved: Binding | null = maybeStat(candidate) === null ? null : readBinding(candidate);
    if (saved === null) return null;
    name = saved.scope.name;
  }
  if (name === null) {
    const saved: Binding | null = discoverCurrentBinding({
      cwd: input.cwd,
      skillsHome,
      host: input.host,
      managerSession: input.managerSession,
    });
    if (saved === null) return null;
    const scope: Scope = scopeSchema.parse({ ...saved.scope, skillsHome, host: input.host, managerSession: input.managerSession });
    return { ...scope, skillsRoot, executionLimit: combineLimit(executionLimit, saved.executionLimit) };
  }
  const startupRoot: string = canonicalStartupRoot(resolve(override ?? join(startupsDirectory(skillsHome), name)), true);
  const parentStat = maybeStat(dirname(startupRoot));
  if (parentStat?.isSymbolicLink())
    throw new StartupBootError(`Startup root parent may not be a symlink: ${dirname(startupRoot)}`);
  let boundRoot: string | null = command?.kind === "new"
    ? realpathSync(resolve(input.cwd, command.directory ?? input.cwd))
    : null;
  const saved: Binding | null = maybeStat(startupRoot) === null ? null : readBinding(startupRoot);
  if (saved !== null) {
    if (command?.kind === "new")
      throw new StartupBootError(`Startup root already has a binding: ${bindingPath(startupRoot)}`);
    if (saved.scope.name !== name)
      throw new StartupBootError(`Startup root is bound to ${saved.scope.name}, not ${name}: ${bindingPath(startupRoot)}`);
    if (saved.scope.skillsHome !== skillsHome || saved.scope.host !== input.host || saved.scope.managerSession !== input.managerSession)
      throw new StartupBootError(`Startup binding belongs to another skills home, host or manager session: ${bindingPath(startupRoot)}`);
    if (boundRoot !== null && saved.scope.boundRoot !== boundRoot)
      throw new StartupBootError(`Startup binding belongs to another bound root: ${bindingPath(startupRoot)}`);
    boundRoot = saved.scope.boundRoot;
  }
  if (command?.kind === "select" && saved === null)
    throw new StartupBootError(`Startup binding missing: ${bindingPath(startupRoot)}`);
  if (boundRoot === null) boundRoot = currentBoundRoot(input.cwd);
  const canonicalBoundRoot: string = canonicalDirectory(boundRoot, "Startup bound root", false, false);
  rejectRootOverlap(startupRoot, skillsHome, canonicalBoundRoot);
  const scope: Scope = scopeSchema.parse({
    skillsHome,
    startupRoot,
    host: input.host,
    name,
    boundRoot: canonicalBoundRoot,
    managerSession: input.managerSession,
  });
  if (saved !== null && !sameScope(saved.scope, scope))
    throw new StartupBootError(`Persisted Startup root or binding identity does not match the selection: ${bindingPath(startupRoot)}`);
  return { ...scope, skillsRoot, executionLimit: combineLimit(executionLimit, saved?.executionLimit ?? null) };
}

export function persistBinding(selection: Selection): void {
  const root: string = ensureStartupRoot(selection.startupRoot);
  rejectRootOverlap(root, selection.skillsHome, selection.boundRoot);
  const path: string = bindingPath(root);
  assertStartupPath(root, path, "file");
  const { skillsHome, startupRoot, host, name, boundRoot, managerSession, executionLimit } = selection;
  const scopeValue: Scope = { skillsHome, startupRoot, host, name, boundRoot, managerSession };
  const next: Binding = { scope: scopeSchema.parse(scopeValue), executionLimit };
  const existing: Binding | null = readBinding(root);
  if (existing !== null) {
    if (!sameScope(existing.scope, next.scope))
      throw new StartupBootError(`Persisted Startup binding changed; explicit recovery required: ${path}`);
    return;
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
