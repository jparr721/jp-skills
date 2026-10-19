import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { cfgTaskMaxConcurrency } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { HostAPI } from "./index";
import { executionConfigHome, bootSelection, parseBootCommand, persistBinding, StartupBootError, type BootCommand, type Selection } from "./src/boot";
import { encode } from "./src/contracts";
import { assertNativeTranscript, attach, inputBlock, reconcileInput, inputSchema, installLaunchedEmployee, nativeRoot, paneEnvironment, receive, registerTools, sameRoot, type Admission, type Environment, type NativeRootFn } from "./src/employee-entry";
import type { NativeContext } from "./src/omp-adapter";
import { loadProfile, verifyProfile } from "./src/profiles";
import { integrationPath, launchRuntimeHost, readPrivateJson, parseRuntimeHostConfig, type RuntimeHostConfig } from "./src/v7-launch";

export { integrationPath } from "./src/v7-launch";
export { installLaunchedEmployee } from "./src/employee-entry";
export type EntryConfig = Readonly<{
  skillsHome: string;
  startupRoot: string | null;
  configHome: string;
  skillsRoot: string;
  environment: Environment;
  launch: (config: RuntimeHostConfig) => Promise<RuntimeHostConfig>;
  nativeLimit: (ctx: NativeContext) => number;
  harness: "omp" | "claude";
  root: NativeRootFn;
  integration: (environment: Environment) => string;
}>;

export function installStartupV7(host: HostAPI, input: EntryConfig): void {
  let admitted: Admission | null = null;
  let selection: Selection | null = null;
  let runtimeConfig: RuntimeHostConfig | null = null;
  let initializing: Promise<void> | null = null;
  let attempted: boolean = false;
  let failure: string | null = null;
  let failureTurnPending: boolean = false;
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let stopped: boolean = false;
  let commandReceipt: Readonly<{ args: string; inputId: string; work: boolean }> | null = null;
  host.on("tool_call", (_event, ctx) => {
    if (!attempted || ctx.agent.kind !== "main") return;
    if (failure !== null || admitted === null || admitted.client.isClosed() || initializing !== null || !sameRoot(admitted, ctx) || inputBlock(admitted) !== null)
      return { block: true, reason: `Startup V7 blocked: ${failure ?? "manager root admission is pending"}` };
    return;
  });
  host.on("before_agent_start", (_event, ctx) => {
    if (attempted && ctx.agent.kind === "main" && (failure !== null || admitted === null || admitted.client.isClosed())) ctx.abort?.();
  });
  registerTools(host, () => failure === null ? admitted : null);
  async function initialize(ctx: NativeContext, command: BootCommand | null): Promise<void> {
    const nativeSession = ctx.sessionManager.getSessionId();
    const nativeFile: string = (await input.root(host, ctx)).file;
    const contextFile = ctx.sessionManager.getSessionFile();
    const location = await paneEnvironment(input.environment);
    if (stopped || ctx.sessionManager.getSessionId() !== nativeSession || ctx.sessionManager.getSessionFile() !== contextFile) throw new StartupBootError("Manager native identity changed during startup discovery");
    const next: Selection | null = bootSelection({ cwd: ctx.cwd, skillsHome: input.skillsHome, startupRoot: input.environment.STARTUP_ROOT ?? input.startupRoot, configHome: input.configHome, skillsRoot: input.skillsRoot, host: hostname(), managerSession: ctx.sessionManager.getSessionId(), command, explicitName: input.environment.STARTUP_NAME ?? null, executionLimit: input.environment.STARTUP_EXECUTION_LIMIT === undefined ? null : z.coerce.number().int().positive().parse(input.environment.STARTUP_EXECUTION_LIMIT) });
    if (next === null) return;
    if (admitted !== null) {
      if (!sameRoot(admitted, ctx) || next.name !== selection?.name || next.boundRoot !== selection.boundRoot)
        throw new StartupBootError("Startup already belongs to another selected manager root");
      if (runtimeConfig === null) throw new StartupBootError("Admitted manager lost its coordinator configuration");
      await admitted.close();
      admitted = null;
    }
    const ompConfigRoot: string = resolve(input.configHome, "ronin");
    assertNativeTranscript({ harness: input.harness, startupRoot: next.startupRoot, ompConfigRoot, sessionId: nativeSession, file: nativeFile });
    const savedPath: string = join(next.startupRoot, "runtime-config.json");
    const saved: RuntimeHostConfig | null = runtimeConfig ?? (existsSync(savedPath) ? parseRuntimeHostConfig(readPrivateJson(savedPath)) : null);
    if (saved !== null && (("harness" in saved ? saved.harness : "omp") !== input.harness || saved.ompConfigRoot !== ompConfigRoot || saved.name !== next.name || saved.skillsHome !== next.skillsHome || saved.startupRoot !== next.startupRoot || saved.stateDirectory !== next.startupRoot ||
      saved.boundRoot !== next.boundRoot || saved.skillsRoot !== next.skillsRoot || saved.managerSession !== ctx.sessionManager.getSessionId() ||
      (input.harness === "omp" && realpathSync(saved.managerFile) !== realpathSync(nativeFile)) || saved.managerPaneId !== location.paneId || saved.profile !== location.profile ||
      saved.workspaceId !== location.workspaceId || saved.herdrSession !== location.session))
      throw new StartupBootError("Resume requires the saved manager transcript, Herdr pane, profile and Startup root. Reopen that manager session; do not create another crew or replace its state.");
    const executionLimit: number = saved?.policy.executionLimit ?? next.executionLimit ?? (z.number().int().positive().safe().parse(input.nativeLimit(ctx)) + 2);
    if (executionLimit < 3) throw new StartupBootError("Startup V7 requires at least three root slots for manager, PA and employee work");
    const profile = loadProfile({ skillsRoot: next.skillsRoot, role: "manager", employeeId: "manager", generation: 1 });
    verifyProfile(profile);
    persistBinding(next);
    const stateDirectory: string = next.startupRoot;
    const fresh: RuntimeHostConfig = {
      name: next.name, ompConfigRoot, stateDirectory, boundRoot: next.boundRoot, skillsRoot: next.skillsRoot,
      socketPath: join(stateDirectory, "runtime.sock"), profile: location.profile,
      managerSession: ctx.sessionManager.getSessionId(), managerFile: nativeFile, managerPaneId: location.paneId,
      managerCredential: randomUUID(), policy: { tickMs: 1000, paCadenceMs: 60000, progressDeadlineMs: 300000, connectionDeadlineMs: 30000, executionLimit },
      skillsHome: next.skillsHome, startupRoot: next.startupRoot, herdrSession: location.session, workspaceId: location.workspaceId,
      herdrBinary: input.environment.HERDR_BIN_PATH ?? "herdr", herdrIntegration: input.integration(input.environment), ownerGeneration: 1,
    };
    const config: RuntimeHostConfig = await input.launch(saved ?? (input.harness === "claude" ? { ...fresh, harness: "claude" } : fresh));
    runtimeConfig = config;
    if (stopped || ctx.sessionManager.getSessionId() !== nativeSession || ctx.sessionManager.getSessionFile() !== contextFile) throw new StartupBootError("Manager identity changed during owner launch; preserve launch evidence and reconcile before retry");
    const connected = await attach(host, ctx, { socketPath: config.socketPath, credential: config.managerCredential, source: profile.source, employeeId: "manager", generation: 1, profile: location.profile, harness: input.harness, ompConfigRoot, skillsHome: next.skillsHome, startupRoot: next.startupRoot, skillsRoot: next.skillsRoot }, { ...input.environment, STARTUP_ROOT: next.startupRoot, JP_SKILLS_HOME: next.skillsHome }, input.root);
    if (stopped) { await connected.close(); return; }
    admitted = connected;
    await reconcileInput(connected);
    selection = next;
    failure = null;
    failureTurnPending = false;
    if (saved !== null) host.sendMessage({ customType: "startup-manager-reconnected", content: `Startup ${next.name} manager reconnected in its saved pane; polling resumed. Existing crews, PA, claims and history are preserved. Reconcile interrupted claims before advancing work.`, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
  }
  async function boot(ctx: NativeContext, command: BootCommand | null): Promise<void> {
    attempted = true;
    if (initializing !== null) await initializing;
    const operation: Promise<void> = initialize(ctx, command);
    initializing = operation;
    try {
      await operation;
      if (retryTimer !== null) { ctx.clearTimer(retryTimer); retryTimer = null; }
    }
    finally { if (initializing === operation) initializing = null; }
  }
  function report(error: unknown, ctx: NativeContext): void {
    const reason: string = error instanceof Error ? error.message : String(error);
    if (failure !== reason) host.sendMessage({ customType: "startup-boot-error", content: `Startup V7 boot blocked: ${reason}. Admission retries in 5 seconds; /startup-retry retries in this pane.`, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
    failure = reason;
    failureTurnPending = true;
    if (!stopped && retryTimer === null) retryTimer = ctx.setInterval(() => { void retry(ctx); }, 5000);
  }
  async function retry(ctx: NativeContext): Promise<void> {
    if (stopped || initializing !== null || ctx.agent.kind !== "main") return;
    try { await boot(ctx, null); }
    catch (error: unknown) { report(error, ctx); ctx.abort?.(); }
  }
  host.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main" || stopped) return;
    if (admitted !== null && !sameRoot(admitted, ctx)) { await admitted.close(); stopped = true; report(new StartupBootError("Manager native session changed; explicit re-admission required"), ctx); ctx.abort?.(); return; }
    if (admitted !== null) return;
    try {
      const next = bootSelection({ cwd: ctx.cwd, skillsHome: input.skillsHome, startupRoot: input.environment.STARTUP_ROOT ?? input.startupRoot, configHome: input.configHome, skillsRoot: input.skillsRoot, host: hostname(), managerSession: ctx.sessionManager.getSessionId(), command: null, explicitName: input.environment.STARTUP_NAME ?? null, executionLimit: null });
      if (next === null || !existsSync(join(next.startupRoot, "runtime-config.json"))) return;
      await retry(ctx);
    } catch (error: unknown) { attempted = true; report(error, ctx); ctx.abort?.(); }
  });
  host.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    stopped = true;
    if (retryTimer !== null) { ctx.clearTimer(retryTimer); retryTimer = null; }
    await admitted?.close();
  });
  host.registerCommand("startup-retry", { description: "Reconnect the saved Startup manager in its existing pane.", handler: async (_args, ctx) => { await retry(ctx); } });
  host.on("input", async (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const parsed = inputSchema.parse(event);
    if (parsed.source === "extension") return;
    const match = /^\/startup(?: (.*))?$/s.exec(parsed.text);
    try {
      if (match !== null) {
        const args: string = match[1] ?? "";
        const command: BootCommand = parseBootCommand(args);
        await boot(ctx, command);
        if (admitted === null) throw new StartupBootError("No Startup selected; use /startup new NAME or /startup select NAME");
        const inputId: string | null = await receive(admitted, event);
        if (inputId === null) throw new StartupBootError("Native input receipt unavailable");
        await admitted.client.request({ kind: "route", inputId, disposition: command.work === null ? "control" : "work", reason: command.work === null ? "Native Startup control command" : "Explicit native Startup work command", amendItemIds: [] });
        commandReceipt = { args, inputId, work: command.work !== null };
      } else if (admitted !== null && sameRoot(admitted, ctx)) await receive(admitted, event);
    } catch (error: unknown) { report(error, ctx); ctx.abort?.(); return { handled: true }; }
    return;
  });
  host.registerCommand("startup", {
    description: "Select or create a Startup V7 with an independent coordinator and directly interactive employee panes.",
    handler: async (args, ctx) => {
      try {
        const command: BootCommand = parseBootCommand(args);
        if (commandReceipt?.args !== args) await boot(ctx, command);
        if (admitted === null) throw new StartupBootError("No Startup selected");
        if (command.work !== null && (commandReceipt?.args !== args || !commandReceipt.work))
          throw new StartupBootError("Startup work requires its original interactive/RPC input receipt");
        if (command.work !== null)
          host.sendMessage({ customType: "startup-work", content: `Saved Startup work event ${commandReceipt?.inputId}. Delegate a complete architect-led crew through startup_delegate.`, display: true }, { triggerTurn: true, deliverAs: "nextTurn" });
        else host.sendMessage({ customType: "startup-status", content: encode(await admitted.client.request({ kind: "staff" })), display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
        commandReceipt = null;
      } catch (error: unknown) { report(error, ctx); ctx.abort?.(); }
    },
  });
  host.on("session_stop", (_event, ctx) => {
    if (failure === null || !failureTurnPending || ctx.agent.kind !== "main") return;
    failureTurnPending = false;
    return { continue: true, additionalContext: `Startup V7 blocked: ${failure}` };
  });
}
export default function startupV7(host: HostAPI): void {
  const manifest: string | undefined = process.env.STARTUP_V7_MANIFEST;
  if (manifest !== undefined) { installLaunchedEmployee(host, manifest); return; }
  installStartupV7(host, {
    skillsHome: resolve(process.env.JP_SKILLS_HOME ?? join(executionConfigHome(process.env.XDG_CONFIG_HOME), "jp-skills")),
    startupRoot: process.env.STARTUP_ROOT ?? null,
    configHome: executionConfigHome(process.env.XDG_CONFIG_HOME),
    skillsRoot: resolve(process.env.STARTUP_SKILLS_ROOT ?? join(import.meta.dir, "../..")),
    environment: process.env, launch: launchRuntimeHost,
    harness: "omp", root: nativeRoot, integration: integrationPath,
    nativeLimit: (ctx) => {
      const session = host.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (session === undefined || session === null) throw new StartupBootError("Native root execution capacity is unavailable; set STARTUP_EXECUTION_LIMIT explicitly");
      return cfgTaskMaxConcurrency.get(session.settings);
    },
  });
}
