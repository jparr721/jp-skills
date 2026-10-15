import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { cfgTaskMaxConcurrency } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { HostAPI } from "./index";
import { bootSelection, parseBootCommand, StartupBootError, writeBootGuidance, type BootCommand, type Selection } from "./src/boot";
import { encode } from "./src/contracts";
import { attach, inputSchema, installLaunchedEmployee, nativeRoot, paneEnvironment, receive, registerTools, sameRoot, type Admission, type Environment } from "./src/employee-entry";
import type { NativeContext } from "./src/omp-adapter";
import { loadProfile, verifyProfile } from "./src/profiles";
import { launchRuntimeHost, type RuntimeHostConfig } from "./src/v7-launch";

export { installLaunchedEmployee } from "./src/employee-entry";
type EntryConfig = Readonly<{
  home: string;
  skillsRoot: string;
  environment: Environment;
  launch: (config: RuntimeHostConfig) => Promise<RuntimeHostConfig>;
  nativeLimit: (ctx: NativeContext) => number;
}>;

function integrationPath(environment: Environment): string {
  const path: string = realpathSync(environment.STARTUP_HERDR_OMP_EXTENSION ?? join(environment.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "extensions", "herdr-omp-agent-state.ts"));
  const source: string = readFileSync(path, "utf8");
  if (!/^\/\/ HERDR_INTEGRATION_ID=omp$/m.test(source) || !/^\/\/ HERDR_INTEGRATION_VERSION=10$/m.test(source))
    throw new StartupBootError("Startup requires the managed Herdr OMP integration v10; configure STARTUP_HERDR_OMP_EXTENSION with its canonical file");
  return path;
}
export function installStartupV7(host: HostAPI, input: EntryConfig): void {
  let admitted: Admission | null = null;
  let selection: Selection | null = null;
  let initializing: Promise<void> | null = null;
  let attempted: boolean = false;
  let failure: string | null = null;
  let failureTurnPending: boolean = false;
  let commandReceipt: Readonly<{ args: string; inputId: string; work: boolean }> | null = null;
  host.on("tool_call", (_event, ctx) => {
    if (!attempted || ctx.agent.kind !== "main") return;
    if (failure !== null || admitted === null || initializing !== null || !sameRoot(admitted, ctx))
      return { block: true, reason: `Startup V7 blocked: ${failure ?? "manager root admission is pending"}` };
    return;
  });
  host.on("before_agent_start", (_event, ctx) => {
    if (attempted && ctx.agent.kind === "main" && (failure !== null || admitted === null)) ctx.abort?.();
  });
  registerTools(host, () => failure === null ? admitted : null);
  async function initialize(ctx: NativeContext, command: BootCommand | null): Promise<void> {
    const nativeFile: string = await nativeRoot(host, ctx);
    const location = paneEnvironment(input.environment);
    const next: Selection | null = bootSelection({ cwd: ctx.cwd, home: input.home, skillsRoot: input.skillsRoot, command, explicitName: input.environment.STARTUP_NAME ?? null, executionLimit: input.environment.STARTUP_EXECUTION_LIMIT === undefined ? null : z.coerce.number().int().positive().parse(input.environment.STARTUP_EXECUTION_LIMIT) });
    if (next === null) return;
    if (admitted !== null) {
      if (!sameRoot(admitted, ctx) || next.name !== selection?.name || next.boundRoot !== selection.boundRoot)
        throw new StartupBootError("Startup already belongs to another selected manager root");
      await admitted.client.poll();
      failure = null;
      failureTurnPending = false;
      return;
    }
    const executionLimit: number = next.executionLimit ?? (z.number().int().positive().safe().parse(input.nativeLimit(ctx)) + 2);
    if (executionLimit < 3) throw new StartupBootError("Startup V7 requires at least three root slots for manager, PA and employee work");
    const profile = loadProfile({ skillsRoot: next.skillsRoot, role: "manager", employeeId: "manager", generation: 1 });
    verifyProfile(profile);
    writeBootGuidance(next);
    const stateDirectory: string = join(next.home, "startup", next.name);
    const config: RuntimeHostConfig = await input.launch({
      name: next.name, stateDirectory, boundRoot: next.boundRoot, skillsRoot: next.skillsRoot,
      socketPath: join(stateDirectory, "runtime.sock"), profile: location.profile,
      managerSession: ctx.sessionManager.getSessionId(), managerFile: nativeFile, managerPaneId: location.paneId,
      managerCredential: randomUUID(), policy: { tickMs: 1000, paCadenceMs: 60000, progressDeadlineMs: 300000, connectionDeadlineMs: 30000, executionLimit },
      home: next.home, herdrSession: location.session, workspaceId: location.workspaceId,
      herdrBinary: input.environment.HERDR_BIN_PATH ?? "herdr", herdrIntegration: integrationPath(input.environment), ownerGeneration: 1,
    });
    admitted = await attach(host, ctx, { socketPath: config.socketPath, credential: config.managerCredential, source: profile.source, employeeId: "manager", generation: 1, profile: location.profile, skillsRoot: next.skillsRoot }, input.environment);
    selection = next;
    failure = null;
  }
  async function boot(ctx: NativeContext, command: BootCommand | null): Promise<void> {
    attempted = true;
    if (initializing !== null) await initializing;
    const operation: Promise<void> = initialize(ctx, command);
    initializing = operation;
    try { await operation; }
    finally { if (initializing === operation) initializing = null; }
  }
  function report(error: unknown): void {
    failure = error instanceof Error ? error.message : String(error);
    failureTurnPending = true;
    host.sendMessage({ customType: "startup-boot-error", content: `Startup V7 boot blocked: ${failure}`, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
  }
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
    } catch (error: unknown) { report(error); ctx.abort?.(); return { handled: true }; }
    return;
  });
  host.registerCommand("startup", {
    description: "Select or create a Startup V7 with an independent coordinator and directly interactive employee panes.",
    handler: async (args, ctx) => {
      try {
        const command: BootCommand = parseBootCommand(args);
        await boot(ctx, command);
        if (admitted === null) throw new StartupBootError("No Startup selected");
        if (command.work !== null && (commandReceipt?.args !== args || !commandReceipt.work))
          throw new StartupBootError("Startup work requires its original interactive/RPC input receipt");
        if (command.work !== null)
          host.sendMessage({ customType: "startup-work", content: `Saved Startup work event ${commandReceipt?.inputId}. Delegate a complete architect-led crew through startup_delegate.`, display: true }, { triggerTurn: true, deliverAs: "nextTurn" });
        else host.sendMessage({ customType: "startup-status", content: encode(await admitted.client.request({ kind: "staff" })), display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
        commandReceipt = null;
      } catch (error: unknown) { report(error); ctx.abort?.(); throw error; }
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
    home: resolve(process.env.JP_SKILLS_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "jp-skills")),
    skillsRoot: resolve(process.env.STARTUP_SKILLS_ROOT ?? join(import.meta.dir, "../..")),
    environment: process.env, launch: launchRuntimeHost,
    nativeLimit: (ctx) => {
      const session = host.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (session === undefined || session === null) throw new StartupBootError("Native root execution capacity is unavailable; set STARTUP_EXECUTION_LIMIT explicitly");
      return cfgTaskMaxConcurrency.get(session.settings);
    },
  });
}
