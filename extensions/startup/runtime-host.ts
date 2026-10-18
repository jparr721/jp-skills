import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isClaudeConfig, openCoordinator, serveCoordinator, type Coordinator } from "./src/coordinator";
import { createHerdrRuntime, runHerdrCommand, type HerdrRuntime } from "./src/herdr-runtime";
import { openStore, type StartupStore } from "./src/store";
import { readPrivateJson, parseRuntimeHostConfig, type RuntimeHostConfig } from "./src/v7-launch";

export type RuntimeHost = Readonly<{
  coordinator: Coordinator;
  server: ReturnType<typeof serveCoordinator>;
  close: () => Promise<void>;
}>;
function report(config: RuntimeHostConfig, operation: string, error: unknown): void {
  const detail: string = (error instanceof Error ? error.message : String(error)).replaceAll(config.managerCredential, "[redacted]");
  process.stderr.write(JSON.stringify({ level: "error", component: "startup-v7-runtime", startup: config.name, operation, error: detail, observedAt: Date.now() }) + "\n");
}
export async function startRuntimeHost(input: RuntimeHostConfig): Promise<RuntimeHost> {
  const config: RuntimeHostConfig = parseRuntimeHostConfig(input);
  if (process.env.HERDR_ENV !== "1") throw new Error("Startup runtime requires its inherited Herdr environment");
  const store = openStore({
    path: join(config.startupRoot, "staff.sqlite"),
    scope: { skillsHome: config.skillsHome, startupRoot: config.startupRoot, host: `${hostname()}:startup-v7`, name: config.name, boundRoot: config.boundRoot, managerSession: config.managerSession },
    owner: { id: randomUUID(), managerGeneration: config.ownerGeneration, leaseMs: 60000 }, now: Date.now,
  });
  const herdr = createHerdrRuntime({ session: config.herdrSession, workspaceId: config.workspaceId, binary: config.herdrBinary, run: runHerdrCommand, agent: isClaudeConfig(config) ? "claude" : "omp" });
  return serveRuntimeHost({ config, store, herdr });
}
export async function serveRuntimeHost(input: Readonly<{ config: RuntimeHostConfig; store: StartupStore; herdr: HerdrRuntime }>): Promise<RuntimeHost> {
  const { config, store, herdr } = input;
  const snapshot = store.snapshot();
  if (snapshot.duties.length > 0) {
    store.close();
    throw new Error("Configured V6 duties require explicit migration; V7 does not omit or assume repair authority");
  }
  const coordinator: Coordinator = openCoordinator({ store, herdr, config, now: Date.now });
  let startupFailure: string | null = null;
  const endpoint: Coordinator = {
    ...coordinator,
    health: () => ({ ...coordinator.health(), ...(startupFailure === null ? {} : { error: startupFailure }) }),
  };
  let server: ReturnType<typeof serveCoordinator>;
  try { server = serveCoordinator({ coordinator: endpoint, socketPath: config.socketPath }); }
  catch (error: unknown) { store.close(); throw error; }
  let closed: boolean = false;
  let tickWork: Promise<void> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  const leaseTimer: ReturnType<typeof setInterval> = setInterval(() => {
    try { store.renewLease(); }
    catch (error: unknown) {
      report(config, "lease-renewal", error);
      void close().catch((closeError: unknown) => report(config, "close-after-lease-failure", closeError));
    }
  }, 1000);
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(leaseTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    server.stop(true);
    if (tickWork !== null) await tickWork;
    await coordinator.launching();
    store.close();
  }
  try { await coordinator.start(); }
  catch (error: unknown) {
    report(config, "start", error);
    startupFailure = (error instanceof Error ? error.message : String(error)).replaceAll(config.managerCredential, "[redacted]");
    store.runtimeAlert({ id: `runtime-startup-blocked-${store.ownerEpoch}`, correlation: "manager-supervision", payload: { kind: "startup-blocked", managerReady: coordinator.health().status === "running", error: startupFailure, observedAt: Date.now() } });
  }
  tickTimer = setInterval(() => {
    if (closed || tickWork !== null || coordinator.health().status === "starting") return;
    const pending: Promise<void> = coordinator.tick().catch((error: unknown) => report(config, "supervision", error));
    tickWork = pending;
    void pending.then(() => { tickWork = null; });
  }, config.policy.tickMs);
  return { coordinator, server, close };
}
if (import.meta.main) {
  const [path] = z.tuple([z.string().startsWith("/")]).parse(process.argv.slice(2));
  const config: RuntimeHostConfig = parseRuntimeHostConfig(readPrivateJson(path));
  try {
    const host: RuntimeHost = await startRuntimeHost(config);
    process.stderr.write(JSON.stringify({ level: "info", component: "startup-v7-runtime", startup: config.name, operation: "started", pid: process.pid, observedAt: Date.now() }) + "\n");
    const shutdown = (): void => {
      void host.close().then(() => { process.exitCode = 0; }, (error: unknown) => { report(config, "shutdown", error); process.exitCode = 1; });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error: unknown) { report(config, "fatal", error); process.exitCode = 1; }
}
