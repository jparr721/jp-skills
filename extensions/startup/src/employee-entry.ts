import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import type { HostAPI } from "../index";
import { ompProfileSchema } from "../install";
import { StartupBootError } from "./boot";
import { captureSchema, cueSchema, encode, idSchema, jsonSchema, resultSchema, roleSchema, sourceSchema, type Json } from "./contracts";
import { connectEmployee, installEmployeeBridge, installEmployeeToolGuard, type EmployeeClient } from "./employee-client";
import { itemActionSchema } from "./items";
import type { NativeContext, NativeResult } from "./omp-adapter";
import { loadProfile, verifyProfile } from "./profiles";
import { readPrivateJson } from "./v7-launch";

const manifestSchema = z.strictObject({
  socketPath: z.string().startsWith("/"), credential: z.string().min(1), source: sourceSchema,
  employeeId: idSchema, generation: z.number().int().nonnegative().safe(),
  profile: ompProfileSchema, skillsRoot: z.string().startsWith("/"),
});
export type LaunchManifest = z.infer<typeof manifestSchema>;
export type Environment = Readonly<Record<string, string | undefined>>;
export type Admission = Readonly<{ client: EmployeeClient; context: NativeContext }>;
export const inputSchema = z.object({ text: z.string(), source: z.enum(["interactive", "rpc", "extension"]), images: z.array(jsonSchema).optional() });
export async function nativeRoot(host: HostAPI, ctx: NativeContext): Promise<string> {
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
  return file;
}
export function paneEnvironment(environment: Environment): Readonly<{ paneId: string; workspaceId: string; session: string; profile: string }> {
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
export function sameRoot(admission: Admission, ctx: NativeContext): boolean {
  return ctx.agent.kind === "main" && ctx.agent.id === admission.context.agent.id &&
    ctx.sessionManager.getSessionId() === admission.context.sessionManager.getSessionId();
}
export async function attach(host: HostAPI, ctx: NativeContext, manifest: LaunchManifest, environment: Environment): Promise<Admission> {
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
export function registerTools(host: HostAPI, admission: () => Admission | null): void {
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
export async function receive(admission: Admission, event: unknown): Promise<string | null> {
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

