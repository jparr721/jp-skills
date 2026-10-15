import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { cfgTaskMaxConcurrency } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { HostAPI } from "./index";
import { ompProfileSchema } from "./install";
import { bootSelection, parseBootCommand, StartupBootError, writeBootGuidance, type BootCommand, type Selection } from "./src/boot";
import { captureSchema, cueSchema, encode, idSchema, jsonSchema, resultSchema, roleSchema, sourceSchema, type Json } from "./src/contracts";
import { connectEmployee, installEmployeeBridge, installEmployeeToolGuard, type EmployeeClient } from "./src/employee-client";
import { itemActionSchema } from "./src/items";
import type { NativeContext, NativeResult } from "./src/omp-adapter";
import { loadProfile, verifyProfile } from "./src/profiles";
import { launchRuntimeHost, readPrivateJson, type RuntimeHostConfig } from "./src/v7-launch";

const manifestSchema = z.strictObject({
  socketPath: z.string().startsWith("/"), credential: z.string().min(1), source: sourceSchema,
  employeeId: idSchema, generation: z.number().int().nonnegative().safe(),
  profile: ompProfileSchema, skillsRoot: z.string().startsWith("/"),
});
type LaunchManifest = z.infer<typeof manifestSchema>;
type Environment = Readonly<Record<string, string | undefined>>;
type Admission = Readonly<{ client: EmployeeClient; context: NativeContext }>;
type EntryConfig = Readonly<{
  home: string;
  skillsRoot: string;
  environment: Environment;
  launch: (config: RuntimeHostConfig) => Promise<RuntimeHostConfig>;
  nativeLimit: (ctx: NativeContext) => number;
}>;
const inputSchema = z.object({ text: z.string(), source: z.enum(["interactive", "rpc", "extension"]), images: z.array(jsonSchema).optional() });
async function nativeRoot(host: HostAPI, ctx: NativeContext): Promise<string> {
  if (typeof ctx.abort !== "function") throw new StartupBootError("Startup V7 requires the actual native abort capability before admission");
  if (host.pi.VERSION !== "18.8.9") throw new StartupBootError(`Startup V7 requires OMP 18.8.9; actual host is ${host.pi.VERSION}`);
  const ref = host.pi.AgentRegistry.global().get(ctx.agent.id);
  if (ctx.agent.kind !== "main" || ref?.kind !== "main" || ref.parentId !== undefined ||
    ref.session?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId())
    throw new StartupBootError("Startup admission requires the actual native root session");
  const initialFile: string | undefined = ctx.sessionManager.getSessionFile();
  if ((initialFile === undefined || !existsSync(initialFile)) && ref.session?.sessionManager.ensureOnDisk !== undefined)
    await ref.session.sessionManager.ensureOnDisk();
  const file: string | undefined = ctx.sessionManager.getSessionFile();
  if (file === undefined || !existsSync(file)) throw new StartupBootError("Startup root requires an existing persistent native transcript");
  const records = readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)));
  const headers = records.filter((row) => row.type === "session");
  if (headers.length !== 1) throw new StartupBootError("Native transcript must have exactly one session header");
  const header = z.object({ id: z.string(), parentSession: z.string().nullable().optional() }).parse(headers[0]);
  if (header.id !== ctx.sessionManager.getSessionId()) throw new StartupBootError("Native transcript session does not match the actual root");
  if (header.parentSession !== undefined && header.parentSession !== null)
    throw new StartupBootError("A parented native transcript cannot become a Startup employee root");
  return file;
}
function paneEnvironment(environment: Environment): Readonly<{ paneId: string; workspaceId: string; session: string; profile: string }> {
  if (environment.HERDR_ENV !== "1") throw new StartupBootError("Startup requires an existing Herdr pane with HERDR_ENV=1");
  return {
    paneId: z.string().min(1).parse(environment.HERDR_PANE_ID),
    workspaceId: z.string().min(1).parse(environment.HERDR_WORKSPACE_ID),
    session: z.string().min(1).parse(environment.STARTUP_HERDR_SESSION ?? environment.HERDR_SESSION),
    profile: ompProfileSchema.parse(environment.OMP_PROFILE),
  };
}
function verifyManifest(manifest: LaunchManifest): void {
  const role = roleSchema.parse(basename(dirname(manifest.source.rolePath)).replace(/^startup-role-/, ""));
  const profile = loadProfile({ skillsRoot: manifest.skillsRoot, role, employeeId: manifest.employeeId, generation: manifest.generation });
  verifyProfile(profile);
  if (encode(profile.source) !== encode(manifest.source)) throw new StartupBootError("Canonical source hashes differ from the launch manifest");
  if ((role === "manager") !== (manifest.employeeId === "manager")) throw new StartupBootError("Manager source does not match the launch employee identity");
}
function sameRoot(admission: Admission, ctx: NativeContext): boolean {
  return ctx.agent.kind === "main" && ctx.agent.id === admission.context.agent.id &&
    ctx.sessionManager.getSessionId() === admission.context.sessionManager.getSessionId();
}
async function attach(host: HostAPI, ctx: NativeContext, manifest: LaunchManifest, environment: Environment): Promise<Admission> {
  verifyManifest(manifest);
  const nativeSession: string = await nativeRoot(host, ctx);
  const location = paneEnvironment(environment);
  if (location.profile !== manifest.profile) throw new StartupBootError("Actual named OMP profile differs from the launch manifest");
  const client: EmployeeClient = await connectEmployee({ socketPath: manifest.socketPath, credential: manifest.credential, source: manifest.source, nativeSession, paneId: location.paneId });
  const bridge = installEmployeeBridge(host, { client, ctx, intervalMs: 1000 });
  try { await bridge.poll(); }
  catch (error: unknown) { bridge.close(); throw error; }
  return { client, context: ctx };
}
function nativeResult(value: Json): NativeResult {
  const image = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string().startsWith("image/") }).passthrough().safeParse(value);
  if (image.success) return { content: [image.data], details: value };
  return { content: [{ type: "text", text: encode(value) }], details: value };
}
function registerTools(host: HostAPI, admission: () => Admission | null): void {
  installEmployeeToolGuard(host);
  const b = host.zod;
  type Field = Readonly<{ native: unknown; schema: z.ZodType<Json> }>;
  const text: Field = { native: b.string(), schema: idSchema };
  const json: Field = { native: b.unknown(), schema: jsonSchema };
  const count: Field = { native: b.number(), schema: z.number().int().positive().safe() };
  const strings: Field = { native: b.array(b.string()), schema: z.array(idSchema) };
  function register(name: string, fields: Readonly<Record<string, Field>>, command: (params: Readonly<Record<string, Json>>) => Json): void {
    const shape = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema]));
    const schema = z.strictObject(shape);
    host.registerTool({
      name, label: name, description: `Startup V7 ${name.replace(/^startup_/, "")}; authenticated employee scope and canonical workflow authority apply.`,
      parameters: b.object(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.native]))),
      execute: async (_id, params, _signal, _update, ctx) => {
        const current: Admission | null = admission();
        if (current === null || !sameRoot(current, ctx)) throw new StartupBootError("Startup tool requires the admitted native root session");
        return nativeResult(await current.client.request(command(schema.parse(params))));
      },
    });
  }
  const direct = (kind: string) => (params: Readonly<Record<string, Json>>): Json => ({ kind, ...params });
  register("startup_claim", {}, direct("claim"));
  register("startup_settle", { claimId: text, result: { native: b.unknown(), schema: resultSchema } }, direct("settle"));
  register("startup_send", {
    id: text, recipient: text, kind: { native: b.enum(["assignment", "report", "question", "answer", "alert", "duty"]), schema: cueSchema.unwrap().shape.kind }, correlation: text, payload: json,
  }, (params) => ({ kind: "send", cue: cueSchema.parse(params) }));
  const itemCommon = { requestId: b.string(), itemId: b.string(), expectedRevision: b.number() };
  const itemParameters = b.object({ ...itemCommon, action: b.literal("assign"), employeeId: b.string(), evidence: b.unknown() })
    .or(b.object({ ...itemCommon, action: b.literal("review"), resultId: b.string(), evidence: b.unknown() }))
    .or(b.object({ ...itemCommon, action: b.literal("qa_assign"), evidence: b.unknown() }))
    .or(b.object({ ...itemCommon, action: b.literal("qa"), resultId: b.string(), verdict: b.enum(["APPROVE", "REDO"]), proof: b.unknown() }))
    .or(b.object({ ...itemCommon, action: b.literal("gate"), verdict: b.enum(["APPROVE", "REDO"]), evidence: b.unknown() }))
    .or(b.object({ ...itemCommon, action: b.literal("decide"), status: b.enum(["BLOCKED", "NEEDS_DECISION", "QUEUED", "REJECTED", "MERGED", "DONE"]), evidence: b.unknown() }));
  host.registerTool({
    name: "startup_item", label: "Startup item", description: "Typed canonical item action; own architect gates and manager landing remain required.",
    parameters: itemParameters,
    execute: async (_id, params, _signal, _update, ctx) => {
      const current = admission();
      if (current === null || !sameRoot(current, ctx)) throw new StartupBootError("Startup item requires the admitted native root session");
      return nativeResult(await current.client.request({ kind: "item", request: itemActionSchema.parse(params) }));
    },
  });
  register("startup_capture", { captureId: text, eventId: text, rows: { native: b.array(b.unknown()), schema: captureSchema.unwrap().shape.rows }, receipt: json }, (params) => ({ kind: "capture", capture: captureSchema.parse(params) }));
  register("startup_staff", {}, direct("staff"));
  register("startup_hire", { requestId: text, role: { native: b.enum(["architect", "qa", "dev", "devops", "pa"]), schema: roleSchema.exclude(["manager"]) }, additional: count }, direct("hire"));
  register("startup_delegate", { eventId: text, developers: count }, direct("delegate"));
  register("startup_activate", { employeeIds: strings }, direct("activate"));
  register("startup_replace", { employeeId: text, evidence: json }, direct("replace"));
  register("startup_intake", { eventId: text, input: json, amendItemIds: strings }, direct("intake"));
  register("startup_route", { inputId: text, disposition: { native: b.enum(["work", "status", "control", "conversation", "decision"]), schema: z.enum(["work", "status", "control", "conversation", "decision"]) }, reason: text, amendItemIds: strings }, direct("route"));
  register("startup_input", { inputId: text, offset: { native: b.number(), schema: z.number().int().nonnegative().safe() } }, direct("input"));
  register("startup_image", { inputId: text, index: { native: b.number(), schema: z.number().int().nonnegative().safe() } }, direct("image"));
  register("startup_reconcile", { claimId: text, evidence: json }, direct("reconcile"));
  register("startup_resolve", { assignmentId: text, evidence: json }, direct("resolve"));
  register("startup_finish_team", { teamId: text, evidence: json }, direct("finish"));
  register("startup_refresh", { employeeId: text, evidence: json }, direct("refresh"));
  register("startup_block", { key: text, evidence: json }, direct("block"));
  register("startup_retire", { employeeIds: strings, evidence: json }, direct("retire"));
}
async function receive(admission: Admission, event: unknown): Promise<string | null> {
  const parsed = inputSchema.parse(event);
  if (parsed.source === "extension") return null;
  const id: string = randomUUID();
  await admission.client.request({ kind: "receive", id, source: parsed.source, raw: { text: parsed.text, images: parsed.images ?? [] } });
  return id;
}
export function installLaunchedEmployee(host: HostAPI, manifestPath: string): void {
  let admitted: Admission | null = null;
  let failure: string | null = null;
  let failureTurnPending: boolean = false;
  host.on("tool_call", (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    if (failure !== null || admitted === null || !sameRoot(admitted, ctx))
      return { block: true, reason: `Startup employee blocked: ${failure ?? "native root admission is pending"}` };
    return;
  });
  host.on("before_agent_start", (_event, ctx) => {
    if (ctx.agent.kind === "main" && (failure !== null || admitted === null || !sameRoot(admitted, ctx))) ctx.abort?.();
  });
  registerTools(host, () => failure === null ? admitted : null);
  host.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    try {
      if (admitted !== null) throw new StartupBootError("Launched employee is already bound; root switching requires explicit relaunch");
      const manifest: LaunchManifest = manifestSchema.parse(readPrivateJson(manifestPath));
      admitted = await attach(host, ctx, manifest, process.env);
      failure = null;
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error);
      failureTurnPending = true;
      host.sendMessage({ customType: "startup-boot-error", content: `Startup employee boot blocked: ${failure}`, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
      ctx.abort?.();
      throw error;
    }
  });
  host.on("session_stop", (_event, ctx) => {
    if (failure === null || !failureTurnPending || ctx.agent.kind !== "main") return;
    failureTurnPending = false;
    return { continue: true, additionalContext: `Startup employee blocked: ${failure}` };
  });
  host.on("input", async (event, ctx) => {
    if (failure === null && admitted !== null && sameRoot(admitted, ctx)) await receive(admitted, event);
  });
}

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
