import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { hostname } from "node:os";
import { openStore, readOwnerControl } from "./store";
import type { Environment } from "./employee-entry";
import { encode, scopeSchema, type Scope } from "./contracts";
import { savedRoleSettingsSchema, runtimePolicySchema, type SavedRoleSettings } from "./runtime-contracts";
import { assertStartupPath, contains, ensureStartupRoot, ompProfileSchema, StartupBootError } from "./boot";
import { createTernCommandRunner, createTernRuntime, ternParentPid } from "./tern-runtime";
export const managerProcessInstance = randomUUID();

export function integrationPath(environment: Environment): string {
  const path: string = realpathSync(z.string().startsWith("/").parse(environment.STARTUP_HERDR_OMP_EXTENSION));
  const source: string = readFileSync(path, "utf8");
  if (!/^\/\/ HERDR_INTEGRATION_ID=omp$/m.test(source) || !/^\/\/ HERDR_INTEGRATION_VERSION=[1-9]\d*$/m.test(source))
    throw new StartupBootError("Startup requires the managed Herdr OMP integration headers; configure STARTUP_HERDR_OMP_EXTENSION with its canonical file");
  return path;
}
const preparedManagerSchema = z.strictObject({ scope: scopeSchema, settings: savedRoleSettingsSchema });
export function readPreparedManagerSettings(scope: Scope): SavedRoleSettings | null {
  const path: string = join(scope.startupRoot, "manager-launch.json");
  assertStartupPath(scope.startupRoot, path, "file");
  if (!existsSync(path)) return null;
  const saved = preparedManagerSchema.parse(readPrivateJson(path));
  if (encode(saved.scope) !== encode(scope) || saved.settings.role !== "manager") throw new StartupBootError("Prepared manager launch belongs to another Startup/native identity");
  return saved.settings;
}
export function prepareManagerLaunch(input: Readonly<{ scope: Scope; harness: "omp" | "claude"; now: () => number; expectedControl: Readonly<{ ownerEpoch: number; revision: number }> | null }>): SavedRoleSettings {
  const scope: Scope = scopeSchema.parse(input.scope);
  const lockPath: string = join(scope.startupRoot, "runtime-launch.lock");
  assertStartupPath(scope.startupRoot, lockPath, "file");
  const lock: number = openSync(lockPath, "wx", 0o600);
  try {
  const existing = readPreparedManagerSettings(scope);
  if (existing !== null) {
    const current = readOwnerControl(scope);
    if (current.archived || current.leaseExpires > input.now()) throw new StartupBootError("Prepared manager launch refuses an archived Startup or live owner");
    if (input.expectedControl !== null && (current.ownerEpoch !== input.expectedControl.ownerEpoch || current.revision !== input.expectedControl.revision)) throw new StartupBootError("Prepared manager launch snapshot changed");
    if (existing.requested.harness !== input.harness) throw new StartupBootError("Prepared manager harness differs; reconcile the prior native launch before another launch");
    return existing;
  }
  const store = openStore({ path: join(scope.startupRoot, "staff.sqlite"), scope, owner: { id: randomUUID(), managerGeneration: 1, leaseMs: 60000 }, now: input.now, ...(input.expectedControl === null ? {} : { expectedControl: input.expectedControl }) });
  try {
    store.initializeRoleSettings(input.harness);
    const settings: SavedRoleSettings = store.freezeManagerSettings(input.harness);
    const path: string = join(scope.startupRoot, "manager-launch.json");
    assertStartupPath(scope.startupRoot, path, "file");
    writeFileSync(path, encode({ scope, settings }), { flag: "wx", mode: 0o600 });
    return settings;
  } finally { store.close(); }
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
const commonConfigShape = {
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  skillsHome: z.string().startsWith("/"), startupRoot: z.string().startsWith("/"), stateDirectory: z.string().startsWith("/"),
  boundRoot: z.string().startsWith("/"), skillsRoot: z.string().startsWith("/"),
  socketPath: z.string().startsWith("/"), profile: ompProfileSchema,
  managerSession: z.string().min(1), managerFile: z.string().startsWith("/"),
  managerPaneId: z.string().min(1), managerCredential: z.string().min(1),
};
const herdrConfigShape = {
  ...commonConfigShape,
  herdrSession: z.string().min(1), workspaceId: z.string().min(1),
  herdrBinary: z.string().min(1), herdrIntegration: z.string().startsWith("/"),
  ownerGeneration: z.number().int().nonnegative().safe(), policy: runtimePolicySchema,
};
const ternConfigShape = {
  ...commonConfigShape,
  backend: z.literal("tern"), ternSession: z.string().min(1), ternWindow: z.string(),
  ternBinary: z.string().min(1), ternSocket: z.string().startsWith("/"), managerPid: z.number().int().positive().safe(), managerInstance: z.uuid(),
  ownerGeneration: z.number().int().nonnegative().safe(), policy: runtimePolicySchema,
};
const herdrOmpConfigSchema = z.strictObject(herdrConfigShape);
const herdrClaudeConfigSchema = z.strictObject({ ...herdrConfigShape, harness: z.literal("claude") });
const ternOmpConfigSchema = z.strictObject(ternConfigShape);
const ternClaudeConfigSchema = z.strictObject({ ...ternConfigShape, harness: z.literal("claude") });
export type RuntimeHostConfig = Readonly<z.infer<typeof herdrOmpConfigSchema> | z.infer<typeof herdrClaudeConfigSchema> | z.infer<typeof ternOmpConfigSchema> | z.infer<typeof ternClaudeConfigSchema>>;
export function parseRuntimeHostConfig(value: unknown): RuntimeHostConfig {
  const object = typeof value === "object" && value !== null ? value : {};
  const claude = "harness" in object;
  if ("backend" in object) return claude ? ternClaudeConfigSchema.parse(value) : ternOmpConfigSchema.parse(value);
  return claude ? herdrClaudeConfigSchema.parse(value) : herdrOmpConfigSchema.parse(value);
}
export const intentSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("prepared"), startedAt: z.number().int().nonnegative() }),
  z.strictObject({ state: z.literal("spawned"), startedAt: z.number().int().nonnegative(), pid: z.number().int().positive() }),
]);
export const rebindSchema = z.strictObject({
  state: z.literal("prepared"), oldPid: z.number().int().positive().safe(), newPid: z.number().int().positive().safe(), oldInstance: z.uuid(), newInstance: z.uuid(),
  ownerEpoch: z.number().int().nonnegative().safe(), revision: z.number().int().nonnegative().safe(),
});
export class RuntimeLaunchError extends Error {}
class RuntimeStartupError extends RuntimeLaunchError {}
function validateRuntimePaths(config: RuntimeHostConfig): string {
  const root: string = ensureStartupRoot(config.startupRoot);
  if (root !== config.startupRoot || config.stateDirectory !== root || resolve(config.socketPath) !== config.socketPath || !contains(root, config.socketPath))
    throw new RuntimeLaunchError("Runtime state and coordinator socket must stay inside the canonical Startup root");
  if (!isAbsolute(config.skillsHome) || resolve(config.skillsHome) !== config.skillsHome || realpathSync(config.skillsHome) !== config.skillsHome ||
      !isAbsolute(config.boundRoot) || resolve(config.boundRoot) !== config.boundRoot || realpathSync(config.boundRoot) !== config.boundRoot)
    throw new RuntimeLaunchError("JP_SKILLS_HOME and bound repository must be canonical directories");
  if (contains(root, config.skillsHome) || contains(root, config.boundRoot) || contains(config.boundRoot, root))
    throw new RuntimeLaunchError("Startup root may not contain JP_SKILLS_HOME and must stay separate from the bound repository");
  assertStartupPath(root, config.socketPath, "socket");
  return root;
}
function assertRuntimeFile(config: RuntimeHostConfig, path: string): void {
  assertStartupPath(config.startupRoot, path, "file");
}
export function readPrivateJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new RuntimeLaunchError(`Startup private file must be a regular owner-only file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) {
    const parsed = z.object({ code: z.string() }).safeParse(error);
    if (parsed.success && parsed.data.code === "ESRCH") return false;
    if (parsed.success && parsed.data.code === "EPERM") return true;
    throw error;
  }
}
async function health(socketPath: string): Promise<void> {
  let lastError: unknown = new RuntimeLaunchError("Coordinator has no health response");
  const deadline: number = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response: Response = await fetch("http://localhost/health", { unix: socketPath, signal: AbortSignal.timeout(1000) });
      const body: string = await response.text();
      if (!response.ok) {
        const blocked = z.object({ error: z.string() }).safeParse(JSON.parse(body));
        if (blocked.success) throw new RuntimeStartupError(`Coordinator startup blocked: ${blocked.data.error}`);
        const readiness = z.object({ status: z.literal("degraded"), readyForAdmission: z.literal(true) }).safeParse(JSON.parse(body));
        if (response.status === 503 && readiness.success) return;
        throw new RuntimeLaunchError(`Coordinator health HTTP ${response.status}: ${body}`);
      }
      z.object({ status: z.literal("running") }).parse(JSON.parse(body));
      return;
    } catch (error: unknown) {
      if (error instanceof RuntimeStartupError) throw error;
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new RuntimeLaunchError(`Coordinator health deadline 10000ms exceeded: ${lastError instanceof Error ? lastError.message : String(lastError)}; inspect runtime.log and preserve launch intent before recovery`);
}
export async function launchRuntimeHost(input: RuntimeHostConfig, options?: Readonly<{ allowManagerRebind: boolean }>): Promise<RuntimeHostConfig> {
  const proposed: RuntimeHostConfig = parseRuntimeHostConfig(input);
  validateRuntimePaths(proposed);
  mkdirSync(proposed.startupRoot, { recursive: true, mode: 0o700 });
  const configPath: string = join(proposed.stateDirectory, "runtime-config.json");
  assertRuntimeFile(proposed, configPath);
  let config: RuntimeHostConfig = proposed;
  const intentPath: string = join(proposed.stateDirectory, "runtime-launch.json");
  const lockPath: string = join(proposed.stateDirectory, "runtime-launch.lock");
  const rebindPath: string = join(proposed.stateDirectory, "runtime-rebind.json");
  assertRuntimeFile(proposed, intentPath);
  assertRuntimeFile(proposed, lockPath);
  assertRuntimeFile(proposed, rebindPath);
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch (error: unknown) {
    const parsed = z.object({ code: z.string() }).safeParse(error);
    if (parsed.success && parsed.data.code === "EEXIST")
      throw new RuntimeLaunchError("Coordinator launch lock already exists; preserve its owner evidence and reconcile before spawning");
    throw error;
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  try {
    if (existsSync(rebindPath))
      throw new RuntimeLaunchError("Interrupted manager rebind needs explicit reconciliation; preserve its journal");
    let rebinding = false;
    if (existsSync(configPath)) {
      config = parseRuntimeHostConfig(readPrivateJson(configPath));
      const { managerCredential: savedCredential, ...saved } = config;
      const { managerCredential: proposedCredential, ...requested } = proposed;
      void savedCredential; void proposedCredential;
      if (JSON.stringify(saved) !== JSON.stringify(requested)) {
        if (!("backend" in config) || !("backend" in proposed) ||
            JSON.stringify({ ...saved, managerPid: proposed.managerPid, managerInstance: proposed.managerInstance }) !== JSON.stringify(requested))
          throw new RuntimeLaunchError("Saved runtime configuration belongs to another manager, profile, source root or terminal target; explicit recovery required");
        if (options?.allowManagerRebind !== true)
          throw new RuntimeLaunchError("Manager process changed; explicit rebind authorization is required");
        if (proposed.managerPid !== process.pid || proposed.managerInstance !== managerProcessInstance || processAlive(config.managerPid))
          throw new RuntimeLaunchError("Prior manager process is live or the proposed process is not the current manager; explicit recovery required");
        if (!existsSync(intentPath))
          throw new RuntimeLaunchError("Prior coordinator launch evidence is missing; explicit recovery required");
        const intent = intentSchema.parse(readPrivateJson(intentPath));
        if (intent.state !== "spawned" || processAlive(intent.pid))
          throw new RuntimeLaunchError("Prior coordinator is live or its launch outcome is uncertain; explicit recovery required");
        const scope = { skillsHome: config.skillsHome, startupRoot: config.startupRoot, host: hostname(), name: config.name, boundRoot: config.boundRoot, managerSession: config.managerSession };
        const control = readOwnerControl(scope);
        if (control.archived || control.leaseExpires > Date.now())
          throw new RuntimeLaunchError("Prior owner lease is live or archived; explicit recovery required");
        const tern = createTernRuntime({ binary: config.ternBinary, window: config.ternWindow, sessionId: config.ternSession, run: createTernCommandRunner({ socket: config.ternSocket, timeoutMs: 35000 }), parentPid: ternParentPid });
        if (!await tern.ownsProcess({ blockId: config.managerPaneId, pid: proposed.managerPid }))
          throw new RuntimeLaunchError("New manager process is not verified in the saved Tern block");
        if (processAlive(config.managerPid) || processAlive(intent.pid))
          throw new RuntimeLaunchError("Prior manager or coordinator process became live during rebind");
        const current = readOwnerControl(scope);
        if (current.archived || current.leaseExpires > Date.now() || current.ownerEpoch !== control.ownerEpoch || current.revision !== control.revision)
          throw new RuntimeLaunchError("Owner control changed during manager rebind; explicit recovery required");
        const journal = rebindSchema.parse({ state: "prepared", oldPid: config.managerPid, newPid: proposed.managerPid, oldInstance: config.managerInstance, newInstance: proposed.managerInstance, ownerEpoch: control.ownerEpoch, revision: control.revision });
        const journalFd = openSync(rebindPath, "wx", 0o600);
        try { writeFileSync(journalFd, JSON.stringify(journal)); fsyncSync(journalFd); } finally { closeSync(journalFd); }
        const replacement = `${configPath}.${process.pid}.tmp`;
        assertRuntimeFile(config, replacement);
        const fd = openSync(replacement, "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify({ ...proposed, managerCredential: config.managerCredential })); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(replacement, configPath);
        config = { ...proposed, managerCredential: config.managerCredential };
        rebinding = true;
      }
    }
    if (existsSync(join(config.startupRoot, "staff.sqlite")) && readOwnerControl({ skillsHome: config.skillsHome, startupRoot: config.startupRoot, host: hostname(), name: config.name, boundRoot: config.boundRoot, managerSession: config.managerSession }).archived)
      throw new RuntimeLaunchError("Archived Startup cannot launch an owner");
    if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
    if (existsSync(intentPath)) {
      const intent = intentSchema.parse(readPrivateJson(intentPath));
      if (intent.state === "prepared")
        throw new RuntimeLaunchError("Coordinator launch outcome is uncertain; preserve the prepared intent and reconcile before another spawn");
      if (processAlive(intent.pid)) { await health(config.socketPath); return config; }
    }
    const startedAt: number = Date.now();
    const temporary: string = `${intentPath}.${process.pid}.tmp`;
    assertRuntimeFile(config, temporary);
    if (existsSync(temporary))
      throw new RuntimeLaunchError("Interrupted coordinator launch intent needs explicit reconciliation");
    writeFileSync(temporary, JSON.stringify({ state: "prepared", startedAt }), { flag: "wx", mode: 0o600 });
    if (existsSync(intentPath)) renameSync(temporary, intentPath);
    else {
      writeFileSync(intentPath, JSON.stringify({ state: "prepared", startedAt }), { flag: "wx", mode: 0o600 });
      unlinkSync(temporary);
    }
    const bun: string | null = Bun.which("bun");
    if (bun === null) throw new RuntimeLaunchError("A Bun executable is required to launch Startup runtime-host.ts");
    const logPath: string = join(config.stateDirectory, "runtime.log");
    assertRuntimeFile(config, logPath);
    if (existsSync(logPath)) readPrivateLog(logPath);
    const log: number = openSync(logPath, "a", 0o600);
    try {
      const child = spawn(bun, [join(import.meta.dir, "../runtime-host.ts"), configPath], {
        detached: true, stdio: ["ignore", log, log], env: {
          ...process.env,
          JP_SKILLS_HOME: config.skillsHome,
          STARTUP_ROOT: config.startupRoot,
          OMPCODE: "",
          ...("harness" in config ? { CLAUDE_CONFIG_DIR: config.startupRoot } : {}),
        },
      });
      const pid: number = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => {
          if (child.pid === undefined) reject(new RuntimeLaunchError("Coordinator spawn returned no process identity"));
          else resolve(child.pid);
        });
      });
      writeFileSync(temporary, JSON.stringify({ state: "spawned", startedAt, pid }), { flag: "wx", mode: 0o600 });
      renameSync(temporary, intentPath);
      child.unref();
    } finally { closeSync(log); }
    await health(config.socketPath);
    if (rebinding) unlinkSync(rebindPath);
    return config;
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

function readPrivateLog(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new RuntimeLaunchError(`Startup runtime log must be a regular owner-only file: ${path}`);
}
