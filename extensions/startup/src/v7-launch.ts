import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CoordinatorConfig } from "./coordinator";
import { runtimePolicySchema } from "./runtime-contracts";

export type RuntimeHostConfig = CoordinatorConfig & Readonly<{
  home: string;
  herdrSession: string;
  workspaceId: string;
  herdrBinary: string;
  herdrIntegration: string;
  ownerGeneration: number;
}>;
export const runtimeHostConfigSchema: z.ZodType<RuntimeHostConfig> = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  home: z.string().startsWith("/"), stateDirectory: z.string().startsWith("/"),
  boundRoot: z.string().startsWith("/"), skillsRoot: z.string().startsWith("/"),
  socketPath: z.string().startsWith("/"), profile: z.string().min(1),
  managerSession: z.string().min(1), managerFile: z.string().startsWith("/"),
  managerPaneId: z.string().min(1), managerCredential: z.string().min(1),
  herdrSession: z.string().min(1), workspaceId: z.string().min(1),
  herdrBinary: z.string().min(1), herdrIntegration: z.string().startsWith("/"),
  ownerGeneration: z.number().int().nonnegative().safe(), policy: runtimePolicySchema,
});
const intentSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("prepared"), startedAt: z.number().int().nonnegative() }),
  z.strictObject({ state: z.literal("spawned"), startedAt: z.number().int().nonnegative(), pid: z.number().int().positive() }),
]);
export class RuntimeLaunchError extends Error {}
class RuntimeStartupError extends RuntimeLaunchError {}
export function readPrivateJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new RuntimeLaunchError(`Startup private file must be a regular owner-only file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}
function processAlive(pid: number): boolean {
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
export async function launchRuntimeHost(input: RuntimeHostConfig): Promise<RuntimeHostConfig> {
  const proposed: RuntimeHostConfig = runtimeHostConfigSchema.parse(input);
  mkdirSync(proposed.stateDirectory, { recursive: true, mode: 0o700 });
  const configPath: string = join(proposed.stateDirectory, "runtime-config.json");
  let config: RuntimeHostConfig = proposed;
  if (existsSync(configPath)) {
    config = runtimeHostConfigSchema.parse(readPrivateJson(configPath));
    const { managerCredential: savedCredential, ...saved } = config;
    const { managerCredential: proposedCredential, ...requested } = proposed;
    void savedCredential; void proposedCredential;
    if (JSON.stringify(saved) !== JSON.stringify(requested))
      throw new RuntimeLaunchError("Saved runtime configuration belongs to another manager, profile, source root or Herdr target; explicit recovery required");
  } else writeFileSync(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  const intentPath: string = join(config.stateDirectory, "runtime-launch.json");
  const lockPath: string = join(config.stateDirectory, "runtime-launch.lock");
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
    if (existsSync(intentPath)) {
      const intent = intentSchema.parse(readPrivateJson(intentPath));
      if (intent.state === "prepared")
        throw new RuntimeLaunchError("Coordinator launch outcome is uncertain; preserve the prepared intent and reconcile before another spawn");
      if (processAlive(intent.pid)) { await health(config.socketPath); return config; }
    }
    const startedAt: number = Date.now();
    const temporary: string = `${intentPath}.${process.pid}.tmp`;
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
    if (existsSync(logPath)) readPrivateLog(logPath);
    const log: number = openSync(logPath, "a", 0o600);
    try {
      const child = spawn(bun, [join(import.meta.dir, "../runtime-host.ts"), configPath], {
        detached: true, stdio: ["ignore", log, log], env: { ...process.env, OMPCODE: "" },
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
    return config;
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

function readPrivateLog(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new RuntimeLaunchError(`Startup runtime log must be a regular owner-only file: ${path}`);
}
