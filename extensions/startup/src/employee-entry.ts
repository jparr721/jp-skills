import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import type { HostAPI } from "../index";
import { StartupBootError } from "./boot";
import { captureSchema, cueSchema, encode, idSchema, jsonSchema, resultSchema, roleSchema, sourceSchema, type Json } from "./contracts";
import { connectEmployee, EmployeeCommandError, EmployeeSettlementError, installEmployeeBridge, installEmployeeToolGuard, reportLaunchFailure, type EmployeeClient } from "./employee-client";
import { itemActionSchema } from "./items";
import { herdrContext } from "./herdr-runtime";
import { readOmpSessionSettings, type NativeContext, type NativeResult } from "./omp-adapter";
import { loadProfile, profileText, verifyProfile, type Profile } from "./profiles";
import { readPrivateJson } from "./v7-launch";

const manifestSchema = z.strictObject({
  socketPath: z.string().startsWith("/"), credential: z.string().min(1), source: sourceSchema,
  employeeId: idSchema, generation: z.number().int().nonnegative().safe(), skillsHome: z.string().startsWith("/"), startupRoot: z.string().startsWith("/"),
  profile: z.literal("default"), harness: z.enum(["omp", "claude"]), skillsRoot: z.string().startsWith("/"),
});
export type LaunchManifest = z.infer<typeof manifestSchema>;
export type Environment = Readonly<Record<string, string | undefined>>;
export type Admission = Readonly<{ client: EmployeeClient; context: NativeContext; close: () => void }>;
export const inputSchema = z.object({ id: idSchema.optional(), text: z.string(), source: z.enum(["interactive", "rpc", "extension"]), images: z.array(jsonSchema).optional() });
export type NativeRoot = Readonly<{ nativeSession: string; file: string; lastAssistant: unknown }>;
export type NativeRootFn = (host: HostAPI, ctx: NativeContext) => Promise<NativeRoot>;
export async function nativeRoot(host: HostAPI, ctx: NativeContext): Promise<NativeRoot> {
  if (typeof ctx.abort !== "function") throw new StartupBootError("Startup V7 requires the actual native abort capability before admission");
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
  const assistant = z.object({ message: z.object({ role: z.literal("assistant"), stopReason: z.string().optional() }).passthrough() });
  const lastAssistant = records.findLast((row) => {
    const parsed = assistant.safeParse(row);
    return parsed.success && parsed.data.message.stopReason !== "aborted";
  });
  return { nativeSession: file, file, lastAssistant: lastAssistant === undefined ? undefined : assistant.parse(lastAssistant).message };
}
export async function paneEnvironment(environment: Environment): Promise<Readonly<{ paneId: string; workspaceId: string; session: string; profile: "default" }>> {
  const session = environment.STARTUP_HERDR_SESSION?.trim() || environment.HERDR_SESSION?.trim() || null;
  const paneId = environment.HERDR_PANE_ID?.trim();
  const workspaceId = environment.HERDR_WORKSPACE_ID?.trim();
  const location = paneId && workspaceId && session ? { paneId, workspaceId, session } :
    await herdrContext({ binary: environment.HERDR_BIN_PATH?.trim() || "herdr", session });
  const requestedProfile: string = environment.OMP_PROFILE?.trim() || environment.PI_PROFILE?.trim() || "default";
  if (requestedProfile !== "default") throw new StartupBootError("Startup requires the stock OMP default profile; named profiles are unsupported");
  return {
    ...location, profile: "default",
  };
}
function verifyManifest(manifest: LaunchManifest): Profile {
  const role = roleSchema.parse(basename(dirname(manifest.source.rolePath)).replace(/^startup-role-/, ""));
  const profile = loadProfile({ skillsRoot: manifest.skillsRoot, role, employeeId: manifest.employeeId, generation: manifest.generation });
  verifyProfile(profile);
  if (encode(profile.source) !== encode(manifest.source)) throw new StartupBootError("Canonical source hashes differ from the launch manifest");
  if ((role === "manager") !== (manifest.employeeId === "manager")) throw new StartupBootError("Manager source does not match the launch employee identity");
  return profile;
}
export function sameRoot(admission: Admission, ctx: NativeContext): boolean {
  return ctx.agent.kind === "main" && ctx.agent.id === admission.context.agent.id &&
    ctx.sessionManager.getSessionId() === admission.context.sessionManager.getSessionId();
}
export async function attach(host: HostAPI, ctx: NativeContext, manifest: LaunchManifest, environment: Environment, nativeRootOf: NativeRootFn): Promise<Admission> {
  const profile: Profile = verifyManifest(manifest);
  if (environment.STARTUP_ROOT !== manifest.startupRoot || environment.JP_SKILLS_HOME !== manifest.skillsHome ||
      (manifest.harness === "omp" && environment.PI_CODING_AGENT_DIR !== manifest.startupRoot) ||
      (manifest.harness === "claude" && environment.CLAUDE_CONFIG_DIR !== manifest.startupRoot))
    throw new StartupBootError("Employee process roots do not match the Startup launch manifest");
  if (manifest.harness === "omp" && (environment.OMP_PROFILE?.trim() || environment.PI_PROFILE?.trim() || "default") !== "default")
    throw new StartupBootError("Startup requires the stock OMP default profile; named profiles are unsupported");
  const root: NativeRoot = await nativeRootOf(host, ctx);
  const nativeSession: string = root.nativeSession;
  const actualProfile = environment.OMP_PROFILE?.trim() || environment.PI_PROFILE?.trim();
  if (actualProfile && actualProfile !== manifest.profile) throw new StartupBootError("Actual named OMP profile differs from the launch manifest");
  const paneId: string = environment.HERDR_PANE_ID?.trim() || (await paneEnvironment(environment)).paneId;
  const agentSessionId: string | null = manifest.harness === "omp" ? ctx.sessionManager.getSessionId() : null;
  const client: EmployeeClient = await connectEmployee({ socketPath: manifest.socketPath, credential: manifest.credential, source: manifest.source, nativeSession, paneId, ...(agentSessionId === null ? {} : { agentSessionId }) });
  const settingsReport = manifest.harness === "omp" ? (): ReturnType<typeof readOmpSessionSettings> => {
      const current = host.pi.AgentRegistry.global().get(ctx.agent.id);
      if (agentSessionId === null || current?.kind !== "main" || current.parentId !== undefined || current.session === null || current.session.sessionManager.getSessionId() !== agentSessionId || current.session.sessionManager.getSessionFile() !== root.nativeSession)
        throw new StartupBootError("OMP settings observation no longer matches the admitted native root session");
      return readOmpSessionSettings({ session: current.session, nativeSession: root.nativeSession, agentSessionId, observedAt: Date.now() });
    } : undefined;
  const bridge = installEmployeeBridge(host, { client, ctx, intervalMs: 1000, instructions: profileText(profile), lastAssistant: root.lastAssistant, ...(settingsReport === undefined ? {} : { settingsReport }) });
  try { await bridge.poll(); }
  catch (error: unknown) { bridge.close(); throw error; }
  return { client, context: ctx, close: bridge.close };
}
function nativeResult(value: Json): NativeResult {
  const image = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string().startsWith("image/") }).passthrough().safeParse(value);
  if (image.success) return { content: [image.data], details: value };
  return { content: [{ type: "text", text: encode(value) }], details: value };
}
export function registerTools(host: HostAPI, admission: () => Admission | null): void {
  installEmployeeToolGuard(host);
  const b = host.zod;
  type Field = Readonly<{ native: unknown; schema: z.ZodType<Json> }>;
  const text: Field = { native: b.string(), schema: idSchema };
  const json: Field = { native: b.unknown(), schema: jsonSchema };
  const count: Field = { native: b.number(), schema: z.number().int().positive().safe() };
  const strings: Field = { native: b.array(b.string()), schema: z.array(idSchema) };
  async function execute(current: Admission, ctx: NativeContext, command: Json): Promise<NativeResult> {
    const stopped: boolean = current.client.settlementBlock() !== null;
    try { return nativeResult(await current.client.request(command)); }
    catch (error: unknown) {
      if ((error instanceof EmployeeSettlementError || error instanceof EmployeeCommandError) && error.repeated) {
        ctx.abort?.();
        if (!stopped) host.sendMessage({ customType: error instanceof EmployeeSettlementError ? "startup-settlement-blocked" : "startup-command-blocked", content: error.message, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
      }
      throw error;
    }
  }
  function register(name: string, fields: Readonly<Record<string, Field>>, command: (params: Readonly<Record<string, Json>>) => Json): void {
    const shape = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema]));
    const schema = z.strictObject(shape);
    host.registerTool({
      name, label: name, description: `Startup V7 ${name.replace(/^startup_/, "")}; authenticated employee scope and canonical workflow authority apply.`,
      parameters: b.object(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.native]))),
      execute: async (_id, params, _signal, _update, ctx) => {
        const current: Admission | null = admission();
        if (current === null || !sameRoot(current, ctx)) throw new StartupBootError("Startup tool requires the admitted native root session");
        return execute(current, ctx, command(schema.parse(params)));
      },
    });
  }
  const direct = (kind: string) => (params: Readonly<Record<string, Json>>): Json => ({ kind, ...params });
  register("startup_claim", {}, direct("claim"));
  register("startup_settle", { result: { native: b.unknown(), schema: resultSchema } }, direct("settle"));
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
      return execute(current, ctx, { kind: "item", request: itemActionSchema.parse(params) });
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
export async function receive(admission: Admission, event: unknown): Promise<string | null> {
  const parsed = inputSchema.parse(event);
  if (parsed.source === "extension") return null;
  const id: string = parsed.id ?? randomUUID();
  await admission.client.request({ kind: "receive", id, source: parsed.source, raw: { text: parsed.text, images: parsed.images ?? [] } });
  return id;
}
export function installLaunchedEmployee(host: HostAPI, manifestPath: string): void {
  installLaunchedEmployeeWith(host, manifestPath, nativeRoot);
}
export function installLaunchedEmployeeWith(host: HostAPI, manifestPath: string, root: NativeRootFn): void {
  let admitted: Admission | null = null;
  let failure: string | null = null;
  let failureTurnPending: boolean = false;
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let pending: Promise<void> | null = null;
  let stopped: boolean = false;
  async function initialize(ctx: NativeContext): Promise<void> {
    let manifest: LaunchManifest | null = null;
    try {
      manifest = manifestSchema.parse(readPrivateJson(manifestPath));
      const next = await attach(host, ctx, manifest, process.env, root);
      if (stopped) { next.close(); return; }
      admitted = next;
      failure = null;
      failureTurnPending = false;
      if (retryTimer !== null) { ctx.clearTimer(retryTimer); retryTimer = null; }
    } catch (error: unknown) {
      const detail: string = error instanceof Error ? error.message : String(error);
      const reason: string = manifest === null ? detail : detail.replaceAll(manifest.credential, "[redacted]");
      if (stopped) return;
      if (failure !== reason) {
        failureTurnPending = true;
        host.sendMessage({ customType: "startup-boot-error", content: `Startup employee boot blocked: ${reason}. Admission will retry in 5 seconds; /startup-retry retries immediately.`, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
      }
      failure = reason;
      ctx.abort?.();
      if (manifest !== null) {
        try { await reportLaunchFailure({ socketPath: manifest.socketPath, credential: manifest.credential, error: reason }); }
        catch (reportError: unknown) {
          host.sendMessage({ customType: "startup-boot-report-error", content: reportError instanceof Error ? reportError.message : String(reportError), display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
        }
      }
      if (!stopped && retryTimer === null) retryTimer = ctx.setInterval(() => { void retry(ctx); }, 5000);
    }
  }
  async function retry(ctx: NativeContext): Promise<void> {
    if (stopped || ctx.agent.kind !== "main" || admitted !== null) return;
    if (pending !== null) return pending;
    pending = initialize(ctx);
    try { await pending; } finally { pending = null; }
  }
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
  host.registerCommand("startup-retry", { description: "Retry Startup employee admission in the existing pane.", handler: async (_args, ctx) => { await retry(ctx); } });
  host.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    if (admitted !== null) {
      failure = "Launched employee is already bound; root switching requires explicit relaunch";
      host.sendMessage({ customType: "startup-boot-error", content: failure, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
      ctx.abort?.();
      return;
    }
    await retry(ctx);
  });
  host.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    stopped = true;
    if (retryTimer !== null) { ctx.clearTimer(retryTimer); retryTimer = null; }
    admitted?.close();
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

