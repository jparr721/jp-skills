import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

export class StartupBootError extends Error {}
const nameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const limitSchema = z.number().int().positive().safe().nullable();
const bindingSchema = z
  .object({
    name: nameSchema,
    bound_root: z.string().min(1),
    executionLimit: limitSchema.optional(),
  })
  .passthrough();
export type BootCommand =
  | Readonly<{
      kind: "new" | "select";
      name: string;
      directory: string | null;
      work: string | null;
    }>
  | Readonly<{ kind: "current" | "status"; work: string | null }>;
export type Selection = Readonly<{
  name: string;
  boundRoot: string;
  home: string;
  skillsRoot: string;
  executionLimit: number | null;
}>;
const begin = "<!-- jp-skills-startup:begin -->";
const end = "<!-- jp-skills-startup:end -->";
export function parseBootCommand(args: string): BootCommand {
  const scanned = Array.from(args.matchAll(/"(?:[^"\\]|\\.)*"|\S+/g));
  const delimiter = scanned.findIndex((token) => token[0] === "--");
  const separator = delimiter < 0 ? undefined : scanned[delimiter];
  const work =
    separator === undefined
      ? null
      : args.slice(separator.index + 2).trimStart();
  if (work !== null && !work.trim())
    throw new StartupBootError("Startup work after -- must be nonempty");
  const tokens = (delimiter < 0 ? scanned : scanned.slice(0, delimiter)).map(
    (match): string =>
      match[0].startsWith('"')
        ? z.string().parse(JSON.parse(match[0]))
        : match[0],
  );
  if (tokens.length === 0) return { kind: "current", work };
  if (tokens[0] === "status" && tokens.length === 1 && work === null)
    return { kind: "status", work: null };
  if ((tokens[0] !== "new" && tokens[0] !== "select") || !tokens[1])
    throw new StartupBootError(
      "Use /startup new <name> [--dir <JSON-quoted-path>] [-- <work>], /startup select <name> [-- <work>], or /startup status",
    );
  const name = nameSchema.parse(tokens[1]);
  if (
    tokens.length !== 2 &&
    (tokens[0] !== "new" ||
      tokens.length !== 4 ||
      tokens[2] !== "--dir" ||
      !tokens[3])
  )
    throw new StartupBootError(
      "Invalid Startup boot options; only new accepts --dir",
    );
  return { kind: tokens[0], name, directory: tokens[3] ?? null, work };
}
function regular(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new StartupBootError(
      `Startup file must be a regular file, not a symlink: ${path}`,
    );
}
function readBinding(path: string) {
  regular(path);
  return bindingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
function combineLimit(
  first: number | null,
  second: number | null,
): number | null {
  return first === null
    ? second
    : second === null
      ? first
      : Math.min(first, second);
}
export function bootSelection(
  input: Readonly<{
    cwd: string;
    home: string;
    skillsRoot: string;
    command: BootCommand | null;
    explicitName: string | null;
    executionLimit: number | null;
  }>,
): Selection | null {
  const limit = limitSchema.parse(input.executionLimit);
  const home = resolve(input.home);
  const command = input.command;
  let boundRoot: string | null = null;
  let name: string | null =
    input.explicitName === null ? null : nameSchema.parse(input.explicitName);
  if (command?.kind === "new") {
    name = command.name;
    boundRoot = realpathSync(
      resolve(input.cwd, command.directory ?? input.cwd),
    );
  }
  if (command?.kind === "select") name = command.name;
  if (name !== null && boundRoot === null) {
    const path = join(home, "startup", name, "binding.json");
    if (existsSync(path)) {
      const binding = readBinding(path);
      if (binding.name !== name)
        throw new StartupBootError(`Startup binding name conflicts: ${path}`);
      boundRoot = realpathSync(binding.bound_root);
    } else if (command?.kind === "select")
      throw new StartupBootError(`Startup binding missing: ${path}`);
    else boundRoot = realpathSync(input.cwd);
  }
  if (name === null) {
    let directory = realpathSync(input.cwd);
    while (true) {
      if (existsSync(join(directory, ".startup", "config.md"))) {
        const state = join(home, "startup");
        const matches = existsSync(state)
          ? readdirSync(state, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .flatMap((entry) => {
                const path = join(state, entry.name, "binding.json");
                if (!existsSync(path)) return [];
                const binding = readBinding(path);
                return existsSync(binding.bound_root) &&
                  realpathSync(binding.bound_root) === directory
                  ? [binding]
                  : [];
              })
          : [];
        if (matches.length !== 1)
          throw new StartupBootError(
            `Startup root requires exactly one matching binding.json: ${directory}`,
          );
        name = matches[0]!.name;
        boundRoot = directory;
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (name === null || boundRoot === null) return null;
  const statePath = join(home, "startup", name);
  let ancestor = statePath;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonicalState = resolve(
    realpathSync(ancestor),
    relative(ancestor, statePath),
  );
  const within = relative(boundRoot, canonicalState);
  if (within === "" || (!within.startsWith("..") && !isAbsolute(within)))
    throw new StartupBootError(
      "Startup state must be outside the bound repository",
    );
  const path = join(home, "startup", name, "binding.json");
  let executionLimit = limit;
  if (existsSync(path)) {
    const saved = readBinding(path);
    if (saved.name !== name || realpathSync(saved.bound_root) !== boundRoot)
      throw new StartupBootError(
        `Startup binding conflicts with selected name/root: ${path}`,
      );
    executionLimit = combineLimit(limit, saved.executionLimit ?? null);
  }
  const state = join(home, "startup");
  if (existsSync(state))
    for (const entry of readdirSync(state, { withFileTypes: true })) {
      const candidate = join(state, entry.name, "binding.json");
      if (
        entry.isDirectory() &&
        entry.name !== name &&
        existsSync(candidate) &&
        existsSync(readBinding(candidate).bound_root) &&
        realpathSync(readBinding(candidate).bound_root) === boundRoot
      )
        throw new StartupBootError(
          `Startup root already belongs to another binding: ${candidate}`,
        );
    }
  return {
    name,
    boundRoot,
    home,
    skillsRoot: realpathSync(input.skillsRoot),
    executionLimit,
  };
}
function atomicFile(path: string, prior: Buffer | null, next: string): void {
  const nextBytes = Buffer.from(next);
  if (prior?.equals(nextBytes)) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const mode = prior === null ? 0o600 : lstatSync(path).mode & 0o777;
  writeFileSync(temporary, nextBytes, { flag: "wx", mode });
  try {
    if (
      prior === null
        ? existsSync(path)
        : !existsSync(path) || !readFileSync(path).equals(prior)
    )
      throw new StartupBootError(
        `Startup file changed during initialization: ${path}`,
      );
    if (existsSync(path)) regular(path);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}
export function writeBootGuidance(selection: Selection): string {
  const { boundRoot, skillsRoot, name } = selection;
  const source = (skill: string): string =>
    join(skillsRoot, "skills", skill, "SKILL.md");
  for (const skill of ["startup-role-manager", "startup-loop"])
    if (!readFileSync(source(skill), "utf8").trim())
      throw new StartupBootError(`Canonical source empty: ${source(skill)}`);
  const identity = JSON.stringify({ version: 1, name, boundRoot, skillsRoot });
  const content = [
    begin,
    `<!-- identity: ${identity} -->`,
    "## Startup boot guidance",
    `Selected Startup: ${name}. Bound root: ${boundRoot}.`,
    `The actual bound manager loads the complete ${source("startup-role-manager")} and ${source("startup-loop")}. An assigned child retains its assigned startup-role-* source and the complete shared loop; this file does not appoint children manager.`,
    `For each new work event the manager saves raw input and dispatches a fresh complete team: exactly one architect leader, one QA, one or more devs. The architect reads ${source("startup-intake")}, handles technical detail, and reports only to manager. Members report through architect.`,
    `Load ${source("hire")} for additive hiring and retries. Reuse idle staff or hire missing roles and dispatch ready independent teams immediately within actual capacity, including review/buddy turns. Sweep ready work before wait/final; unrelated intake or CI is no barrier. Manager alone scales shared DevOps, relays authorization and lands work.`,
    `Runtime commands and tools: ${join(skillsRoot, "extensions/startup/README.md")}. Use startup_claim/startup_settle/startup_send for scoped work; startup_route then task startup=delegate for manager intake; architect startup_capture and typed startup_item for canonical queue updates. Source readiness and immutable duty/repair authority remain required.`,
    `For role bindings and active-harness selection read ${join(skillsRoot, "skills/startup/references/role-dispatch.md")}. For each assigned persona load the complete ${join(skillsRoot, "skills/startup-role-<assigned-role>/SKILL.md")} at its actual canonical role path.`,
    end,
  ].join("\n");
  const path = join(boundRoot, "AGENTS.md");
  const prior = existsSync(path) ? (regular(path), readFileSync(path)) : null;
  const text = prior?.toString("utf8") ?? "";
  if (prior !== null && !Buffer.from(text).equals(prior))
    throw new StartupBootError(
      `AGENTS.md must be valid UTF-8; original bytes preserved: ${path}`,
    );
  const starts = text.split(begin).length - 1;
  const ends = text.split(end).length - 1;
  if (
    starts !== ends ||
    starts > 1 ||
    text.split("<!-- jp-skills-startup:").length - 1 !== starts + ends ||
    (starts === 0 && text.includes("<!-- jp-skills-startup:"))
  )
    throw new StartupBootError(`Malformed Startup managed section: ${path}`);
  let next: string;
  if (starts === 1) {
    const start = text.indexOf(begin);
    const finish = text.indexOf(end);
    if (
      finish < start ||
      !text.slice(start, finish).includes(`<!-- identity: ${identity} -->`)
    )
      throw new StartupBootError(
        `Conflicting Startup managed section: ${path}`,
      );
    next = text.slice(0, start) + content + text.slice(finish + end.length);
  } else
    next = text + (text && !text.endsWith("\n") ? "\n" : "") + content + "\n";
  const directory = join(boundRoot, ".startup");
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
    throw new StartupBootError(
      `Startup directory may not redirect: ${directory}`,
    );
  const state = join(selection.home, "startup", name);
  const binding = join(state, "binding.json");
  if (existsSync(binding)) {
    const saved = readBinding(binding);
    if (saved.name !== name || realpathSync(saved.bound_root) !== boundRoot)
      throw new StartupBootError(`Conflicting binding: ${binding}`);
  }
  mkdirSync(directory, { recursive: true });
  const config = join(directory, "config.md");
  if (existsSync(config)) regular(config);
  atomicFile(path, prior, next);
  if (!existsSync(config))
    writeFileSync(config, `# Startup ${name}\n\nBinding: ${binding}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (!existsSync(binding))
    writeFileSync(
      binding,
      JSON.stringify(
        {
          name,
          bound_root: boundRoot,
          executionLimit: selection.executionLimit,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  return path;
}
if (import.meta.main) {
  const [home, skillsRoot, name, root] = z
    .tuple([z.string(), z.string(), nameSchema, z.string()])
    .parse(process.argv.slice(2));
  const selected = bootSelection({
    cwd: root,
    home,
    skillsRoot,
    command: { kind: "new", name, directory: root, work: null },
    explicitName: null,
    executionLimit: null,
  });
  if (!selected) throw new StartupBootError("Startup selection missing");
  process.stdout.write(writeBootGuidance(selected) + "\n");
}
