import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { assertStartupPath, bootSelection, canonicalStartupRoot, ensureStartupRoot, persistBinding } from "./src/boot";
import { encode, hostStatusQuerySchema, hostStatusSchema, idSchema, jsonSchema, ownerControlReceiptSchema, ownerControlRequestSchema, scopeSchema, timeSchema, StoreAuthorityError, StoreConflictError, StoreFenceError, type Json, type OwnerControlReceipt, type Scope } from "./src/contracts";
import { createHerdrRuntime, runHerdrCommand } from "./src/herdr-runtime";
import { ompSettingsArgs, validateRoleSettings } from "./src/profiles";
import { hostAssociationQuerySchema, hostAssociationPageSchema, effectiveRoleSettingsSchema, requestedRoleSettingsSchema, runtimeCapabilitySchema, savedRoleSettingsSchema, roleSettingsInputSchema } from "./src/runtime-contracts";
import { applyOfflineOwnerControl, openStore, ownerControlOperationPath, readOwnerControl, readOwnerControlReceipt, readOwnerControlFile, withOwnerControlRequest } from "./src/store";
import { prepareManagerLaunch, launchRuntimeHost, parseRuntimeHostConfig, readPrivateJson, type RuntimeHostConfig } from "./src/v7-launch";

export const hostControlCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list"), configHome: z.string().startsWith("/"), after: z.string().nullable(), limit: z.number().int().min(1).max(100) }),
  z.strictObject({ kind: z.literal("create"), requestId: idSchema, scope: scopeSchema, skillsRoot: z.string().startsWith("/"), executionLimit: z.number().int().min(3), harness: z.enum(["omp", "claude"]), expectedOwnerEpoch: z.literal(0), expectedRevision: z.literal(0) }),
  z.strictObject({ kind: z.enum(["select"]), scope: scopeSchema }),
  z.strictObject({ kind: z.enum(["status", "staff", "progress", "alerts"]), scope: scopeSchema, query: hostStatusQuerySchema.optional() }),
  z.strictObject({ kind: z.literal("associations"), scope: scopeSchema, ...hostAssociationQuerySchema.shape }),
  z.strictObject({ kind: z.literal("settings"), scope: scopeSchema, after: idSchema.optional(), limit: z.number().int().min(1).max(100).optional() }),
  z.strictObject({ kind: z.literal("settings_draft"), scope: scopeSchema, selection: roleSettingsInputSchema }),
  z.strictObject({ kind: z.literal("receipt"), scope: scopeSchema, requestId: idSchema }),
  z.strictObject({ kind: z.literal("resume"), scope: scopeSchema, requestId: idSchema, expectedOwnerEpoch: timeSchema, expectedRevision: timeSchema }),
  z.strictObject({ kind: z.literal("prepare_manager"), scope: scopeSchema, requestId: idSchema, harness: z.enum(["omp", "claude"]), expectedOwnerEpoch: timeSchema, expectedRevision: timeSchema }),
  ...ownerControlRequestSchema.options,
]);
const receiptBase = ownerControlReceiptSchema.omit({ kind: true, state: true, sideEffects: true, result: true });
const reasonResult = z.strictObject({ reason: z.string().min(1) });
const createReceipt = z.union([
  receiptBase.extend({ kind: z.literal("create"), state: z.literal("committed"), sideEffects: z.literal("root_initialized"), result: z.strictObject({ selection: scopeSchema, readiness: z.literal("manager_session_required") }) }),
  receiptBase.extend({ kind: z.literal("create"), state: z.literal("uncertain"), sideEffects: z.literal("root_initialized"), result: reasonResult }),
]);
const resumeReceipt = z.union([
  receiptBase.extend({ kind: z.literal("resume"), state: z.literal("committed"), sideEffects: z.literal("owner_resumed"), result: z.strictObject({ managerSession: idSchema }) }),
  receiptBase.extend({ kind: z.literal("resume"), state: z.literal("uncertain"), sideEffects: z.literal("owner_resumed"), result: reasonResult }),
  receiptBase.extend({ kind: z.literal("resume"), state: z.literal("missing_session"), sideEffects: z.literal("none"), result: reasonResult }),
]);
const settingsReceipt = receiptBase.extend({ kind: z.literal("settings_apply"), state: z.literal("committed"), sideEffects: z.literal("future_launch_settings"), result: savedRoleSettingsSchema });
const archiveReceipt = receiptBase.extend({ kind: z.literal("archive"), state: z.literal("committed"), sideEffects: z.literal("history_archived"), result: z.strictObject({ archivedAt: timeSchema, history: z.literal("preserved") }) });
const managerReceipt = z.union([
  receiptBase.extend({ kind: z.literal("prepare_manager"), state: z.literal("committed"), sideEffects: z.literal("manager_prepared"), result: z.strictObject({ settings: savedRoleSettingsSchema, argv: z.array(z.string()) }) }),
  receiptBase.extend({ kind: z.literal("prepare_manager"), state: z.literal("uncertain"), sideEffects: z.literal("manager_prepared"), result: reasonResult }),
]);
export const hostControlReceiptSchema = z.union([createReceipt, resumeReceipt, settingsReceipt, archiveReceipt, managerReceipt]);
const snapshotSchema = z.strictObject({ ownerEpoch: timeSchema, revision: timeSchema, leaseExpires: timeSchema, archived: z.boolean(), settings: z.array(savedRoleSettingsSchema) });
const offlineSchema = snapshotSchema.extend({ state: z.enum(["offline", "archived"]), scope: scopeSchema, effective: z.strictObject({ status: z.literal("unavailable"), reason: z.literal("owner_offline") }) }).refine((value) => (value.state === "archived") === value.archived, "Offline archive state must match the snapshot");
const picture = hostStatusSchema.options[0].shape;
const projectionSchema = z.strictObject({ scope: scopeSchema, observedAt: timeSchema, revision: timeSchema });
const draftSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("accepted"), requested: requestedRoleSettingsSchema }),
  z.strictObject({ status: z.literal("unsupported"), requested: roleSettingsInputSchema, reason: z.string().min(1) }),
]);
export const hostControlResponseSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("create"), result: createReceipt }),
  z.strictObject({ operation: z.literal("prepare_manager"), result: managerReceipt }),
  z.strictObject({ operation: z.literal("resume"), result: resumeReceipt }),
  z.strictObject({ operation: z.literal("settings_apply"), result: settingsReceipt }),
  z.strictObject({ operation: z.literal("archive"), result: archiveReceipt }),
  z.strictObject({ operation: z.literal("receipt"), result: z.discriminatedUnion("state", [z.strictObject({ state: z.literal("missing"), requestId: idSchema }), z.strictObject({ state: z.literal("found"), receipt: hostControlReceiptSchema })]) }),
  z.strictObject({ operation: z.literal("list"), result: z.strictObject({ rows: z.array(z.strictObject({ scope: scopeSchema, state: z.enum(["selected", "archived"]) })), nextCursor: idSchema.nullable() }) }),
  z.strictObject({ operation: z.literal("select"), result: snapshotSchema.extend({ scope: scopeSchema, sideEffects: z.literal("none") }) }),
  z.strictObject({ operation: z.literal("settings_draft"), result: z.strictObject({ draft: draftSchema, scope: z.literal("future_launch"), sideEffects: z.literal("none") }) }),
  z.strictObject({ operation: z.literal("settings"), result: z.union([offlineSchema, z.strictObject({ saved: z.array(savedRoleSettingsSchema), active: z.array(z.strictObject({ employeeId: idSchema, launchId: idSchema, effective: effectiveRoleSettingsSchema, capability: runtimeCapabilitySchema })), nextCursor: idSchema.nullable() })]) }),
  z.strictObject({ operation: z.literal("status"), result: z.union([offlineSchema, hostStatusSchema]) }),
  z.strictObject({ operation: z.literal("associations"), result: z.union([offlineSchema, hostAssociationPageSchema]) }),
  z.strictObject({ operation: z.literal("staff"), result: z.union([offlineSchema, projectionSchema.extend({ staff: picture.staff })]) }),
  z.strictObject({ operation: z.literal("progress"), result: z.union([offlineSchema, projectionSchema.extend({ queue: picture.queue, teams: picture.teams })]) }),
  z.strictObject({ operation: z.literal("alerts"), result: z.union([offlineSchema, projectionSchema.extend({ state: z.enum(["unsupported", "recovery-required", "missing", "offline", "stale", "live"]), reasons: picture.reasons, supervision: picture.supervision })]) }),
]);
export const hostControlUncertaintySchema = z.strictObject({
  state: z.literal("uncertain"), kind: z.literal("settings_apply"), requestId: idSchema, scope: scopeSchema,
  replay: z.literal("forbidden"), recovery: z.strictObject({ kind: z.literal("receipt"), requestId: idSchema, scope: scopeSchema }),
});
export class HostControlUncertainError extends Error {
  readonly outcome: z.infer<typeof hostControlUncertaintySchema>;
  constructor(request: Readonly<{ requestId: string; scope: Scope }>, cause: unknown) {
    super(`Settings write outcome is uncertain; requestId=${request.requestId}; startupRoot=${request.scope.startupRoot}; use read-only receipt lookup and never replay. Cause: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.outcome = hostControlUncertaintySchema.parse({ state: "uncertain", kind: "settings_apply", requestId: request.requestId, scope: request.scope, replay: "forbidden", recovery: { kind: "receipt", requestId: request.requestId, scope: request.scope } });
  }
}
export type HostControlResponse = z.infer<typeof hostControlResponseSchema>;
export type HostControlCommand = z.infer<typeof hostControlCommandSchema>;
export type HostControlRuntime = Readonly<{ now: () => number; executionHost: () => string; observeManager: (config: RuntimeHostConfig) => Promise<boolean>; resume: (config: RuntimeHostConfig) => Promise<RuntimeHostConfig> }>;
function binding(scope: Scope): void {
  const path = join(scope.startupRoot, "binding.json");
  assertStartupPath(scope.startupRoot, path, "file");
  const saved = z.object({ scope: scopeSchema }).parse(readPrivateJson(path));
  if (encode(saved.scope) !== encode(scope)) throw new StoreAuthorityError("Selected Startup binding differs from the requested scope");
}
function beginOperation(receipt: OwnerControlReceipt): OwnerControlReceipt | null {
  return withOwnerControlRequest(receipt.scope, receipt.requestId, () => {
    const previous = readOwnerControlFile(receipt.scope, receipt.requestId) ?? (existsSync(join(receipt.scope.startupRoot, "staff.sqlite")) ? readOwnerControlReceipt(receipt.scope, receipt.requestId) : null);
    if (previous !== null) {
      if (previous.digest !== receipt.digest) throw new StoreConflictError("Control idempotency key payload conflict");
      return previous;
    }
    writeFileSync(ownerControlOperationPath(receipt.scope, receipt.requestId), encode(receipt), { mode: 0o600, flag: "wx" });
    return null;
  });
}
function finishOperation(receipt: OwnerControlReceipt): void {
  const path = ownerControlOperationPath(receipt.scope, receipt.requestId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  assertStartupPath(receipt.scope.startupRoot, temporary, "file");
  writeFileSync(temporary, encode(receipt), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
async function ownerRequest(scope: Scope, path: string, body: Json | null): Promise<Json> {
  const config = parseRuntimeHostConfig(readPrivateJson(join(scope.startupRoot, "runtime-config.json")));
  if (config.skillsHome !== scope.skillsHome || config.startupRoot !== scope.startupRoot || config.name !== scope.name || config.managerSession !== scope.managerSession || config.boundRoot !== scope.boundRoot) throw new StoreAuthorityError("Owner endpoint config does not match selected Startup");
  const mutation = body === null ? null : ownerControlRequestSchema.parse(body);
  const encodedBody = body === null ? null : encode(body);
  let response: Response;
  let text: string;
  try {
    response = await fetch(`http://localhost${path}`, { unix: config.socketPath, method: encodedBody === null ? "GET" : "POST", ...(encodedBody === null ? {} : { headers: { "Content-Type": "application/json" }, body: encodedBody }), signal: AbortSignal.timeout(10000) });
    text = await response.text();
  } catch (error: unknown) {
    if (mutation?.kind === "settings_apply") throw new HostControlUncertainError(mutation, error);
    throw error;
  }
  if (!response.ok) throw new StoreConflictError(`Owner control ${path} HTTP ${response.status}: ${text.slice(0, 2048)}; mutation outcomes must be looked up by requestId, never automatically replayed`);
  try { return jsonSchema.parse(JSON.parse(text)); }
  catch (error: unknown) {
    if (mutation?.kind === "settings_apply") throw new HostControlUncertainError(mutation, error);
    throw error;
  }
}
async function dispatchHostControl(request: HostControlCommand, runtime: HostControlRuntime): Promise<Json> {
  if (request.kind === "list") {
    const directory = join(request.configHome, "jp-skills", "startup");
    if (!existsSync(directory)) return { rows: [], nextCursor: null };
    const names = readdirSync(directory).filter((name) => /^[a-zA-Z0-9_-]+$/.test(name)).sort().filter((name) => request.after === null || name > request.after);
    const rows = names.slice(0, request.limit).flatMap((name) => {
      const root = join(directory, name);
      assertStartupPath(root, join(root, "binding.json"), "file");
      if (!existsSync(join(root, "binding.json"))) return [];
      const saved = z.object({ scope: scopeSchema }).parse(readPrivateJson(join(root, "binding.json")));
      if (saved.scope.startupRoot !== root || saved.scope.name !== name) throw new StoreAuthorityError("Listed binding does not match its canonical root");
      return [{ scope: saved.scope, state: readOwnerControl(saved.scope).archived ? "archived" : "selected" }];
    });
    return jsonSchema.parse({ rows, nextCursor: names.length > request.limit ? names[request.limit - 1] : null });
  }
  const scope = request.scope;
  if (scope.host !== runtime.executionHost()) throw new StoreAuthorityError("Requested Startup host differs from the execution host");
  if (request.kind === "create") {
    const digest = createHash("sha256").update(encode(request)).digest("hex");
    ensureStartupRoot(scope.startupRoot);
    const lockPath: string = join(scope.startupRoot, "create.lock");
    assertStartupPath(scope.startupRoot, lockPath, "file");
    let lock: number;
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch (error: unknown) {
      const parsed = z.object({ code: z.string() }).safeParse(error);
      if (parsed.success && parsed.data.code === "EEXIST") throw new StoreConflictError("Startup initialization is already claimed; preserve create.lock and reconcile its request before retry");
      throw error;
    }
    try {
      writeFileSync(lock, encode({ requestId: request.requestId, digest, pid: process.pid }));
      const existing = readOwnerControlFile(scope, request.requestId);
      if (existing !== null) { if (existing.digest !== digest) throw new StoreConflictError("Create idempotency key payload conflict"); return jsonSchema.parse(existing); }
      const selection = bootSelection({ cwd: scope.boundRoot, skillsHome: scope.skillsHome, startupRoot: scope.startupRoot, skillsRoot: request.skillsRoot, host: scope.host, managerSession: scope.managerSession, command: { kind: "new", name: scope.name, directory: scope.boundRoot, work: null }, explicitName: scope.name, executionLimit: request.executionLimit });
      if (selection === null || encode({ skillsHome: selection.skillsHome, startupRoot: selection.startupRoot, host: selection.host, name: selection.name, boundRoot: selection.boundRoot, managerSession: selection.managerSession }) !== encode(scope)) throw new StoreAuthorityError("Create selection differs from requested canonical scope");
      const intent = ownerControlReceiptSchema.parse({ requestId: request.requestId, digest, scope, kind: "create", state: "uncertain", ownerEpoch: 0, revision: 0, sideEffects: "root_initialized", result: { reason: "Inspect initialized root before any retry" } });
      const previous = beginOperation(intent);
      if (previous !== null) return jsonSchema.parse(previous);
      persistBinding(selection);
      const store = openStore({ path: join(scope.startupRoot, "staff.sqlite"), scope, owner: { id: randomUUID(), managerGeneration: 1, leaseMs: 60000 }, now: runtime.now });
      try { store.initializeRoleSettings(request.harness); } finally { store.close(); }
      const snapshot = readOwnerControl(scope);
      const receipt = ownerControlReceiptSchema.parse({ ...intent, state: "committed", ownerEpoch: snapshot.ownerEpoch, revision: snapshot.revision, result: { selection: scope, readiness: "manager_session_required" } });
      finishOperation(receipt);
      return jsonSchema.parse(receipt);
    } finally { closeSync(lock); unlinkSync(lockPath); }
  }
  if (request.kind === "receipt") {
    canonicalStartupRoot(scope.startupRoot, false);
    const bindingPath = join(scope.startupRoot, "binding.json");
    assertStartupPath(scope.startupRoot, bindingPath, "file");
    if (!existsSync(bindingPath)) {
      const receipt = readOwnerControlFile(scope, request.requestId);
      if (receipt?.kind !== "create" || receipt.state !== "uncertain" || receipt.ownerEpoch !== 0 || receipt.revision !== 0 || receipt.sideEffects !== "root_initialized") throw new StoreAuthorityError("Missing binding permits only an exact-scope interrupted create intent lookup");
      return jsonSchema.parse({ state: "found", receipt });
    }
  }
  binding(scope);
  if (request.kind === "receipt") {
    const receipt = readOwnerControlFile(scope, request.requestId) ?? readOwnerControlReceipt(scope, request.requestId);
    return receipt === null ? { state: "missing", requestId: request.requestId } : jsonSchema.parse({ state: "found", receipt });
  }
  const snapshot = readOwnerControl(scope);
  if (request.kind === "prepare_manager") {
    const digest: string = createHash("sha256").update(encode(request)).digest("hex");
    const existing = readOwnerControlFile(scope, request.requestId) ?? readOwnerControlReceipt(scope, request.requestId);
    if (existing !== null) {
      if (existing.digest !== digest) throw new StoreConflictError("Manager preparation idempotency key payload conflict");
      return jsonSchema.parse(existing);
    }
    if (snapshot.ownerEpoch !== request.expectedOwnerEpoch || snapshot.revision !== request.expectedRevision || snapshot.archived || snapshot.leaseExpires > runtime.now()) throw new StoreFenceError("Manager preparation snapshot changed, Startup archived or owner live");
    if (existsSync(join(scope.startupRoot, "runtime-config.json"))) throw new StoreConflictError("Saved manager must resume its native identity; preparation cannot replace it");
    const intent = ownerControlReceiptSchema.parse({ requestId: request.requestId, digest, scope, kind: "prepare_manager", state: "uncertain", ownerEpoch: snapshot.ownerEpoch, revision: snapshot.revision, sideEffects: "manager_prepared", result: { reason: "Inspect manager-launch.json before another native launch" } });
    const previous = beginOperation(intent);
    if (previous !== null) return jsonSchema.parse(previous);
    const settings = prepareManagerLaunch({ scope, harness: request.harness, now: runtime.now, expectedControl: { ownerEpoch: request.expectedOwnerEpoch, revision: request.expectedRevision } });
    const argv: readonly string[] = settings.requested.harness === "omp" ? ompSettingsArgs(settings) : [
      ...(settings.requested.model.value === null ? [] : ["--model", settings.requested.model.value]),
      ...(settings.requested.effort.value === null ? [] : ["--effort", settings.requested.effort.value]),
    ];
    const observed = readOwnerControl(scope);
    const receipt = ownerControlReceiptSchema.parse({ ...intent, state: "committed", ownerEpoch: observed.ownerEpoch, revision: observed.revision, result: { settings, argv } });
    finishOperation(receipt);
    return jsonSchema.parse(receipt);
  }
  if (request.kind === "select") return jsonSchema.parse({ scope, ...snapshot, sideEffects: "none" });
  if (request.kind === "settings_draft") return jsonSchema.parse({ draft: validateRoleSettings(request.selection), scope: "future_launch", sideEffects: "none" });
  if (request.kind === "settings_apply" || request.kind === "archive") {
    const receipt = readOwnerControlFile(scope, request.requestId) ?? readOwnerControlReceipt(scope, request.requestId);
    if (receipt !== null) {
      if (receipt.digest !== createHash("sha256").update(encode(request)).digest("hex")) throw new StoreConflictError("Control idempotency key payload conflict");
      return jsonSchema.parse(receipt);
    }
    if (snapshot.leaseExpires > runtime.now()) return ownerRequest(scope, "/host/control", jsonSchema.parse(request));
    return jsonSchema.parse(applyOfflineOwnerControl(request, runtime.now()));
  }
  if (request.kind === "resume") {
    const digest = createHash("sha256").update(encode(request)).digest("hex");
    const existing = readOwnerControlFile(scope, request.requestId) ?? readOwnerControlReceipt(scope, request.requestId);
    if (existing !== null) { if (existing.digest !== digest) throw new StoreConflictError("Resume idempotency key payload conflict"); return jsonSchema.parse(existing); }
    if (snapshot.ownerEpoch !== request.expectedOwnerEpoch || snapshot.revision !== request.expectedRevision || snapshot.archived) throw new StoreFenceError("Resume snapshot changed or Startup archived");
    const base = { requestId: request.requestId, digest, scope, kind: "resume" as const, ownerEpoch: snapshot.ownerEpoch, revision: snapshot.revision };
    const configPath = join(scope.startupRoot, "runtime-config.json");
    if (!existsSync(configPath)) {
      const receipt = ownerControlReceiptSchema.parse({ ...base, state: "missing_session", sideEffects: "none", result: { reason: "No saved manager runtime; create a real native manager session first" } });
      return jsonSchema.parse(beginOperation(receipt) ?? receipt);
    }
    const config = parseRuntimeHostConfig(readPrivateJson(configPath));
    if (config.skillsHome !== scope.skillsHome || config.startupRoot !== scope.startupRoot || config.name !== scope.name || config.managerSession !== scope.managerSession || config.boundRoot !== scope.boundRoot) throw new StoreAuthorityError("Resume cannot replace saved manager identity");
    if (!(await runtime.observeManager(config))) {
      const receipt = ownerControlReceiptSchema.parse({ ...base, state: "missing_session", sideEffects: "none", result: { reason: "Saved manager native session is absent" } });
      return jsonSchema.parse(beginOperation(receipt) ?? receipt);
    }
    const fresh = readOwnerControl(scope);
    if (fresh.ownerEpoch !== snapshot.ownerEpoch || fresh.revision !== snapshot.revision || fresh.archived) throw new StoreFenceError("Resume authority changed during native observation");
    const intent = ownerControlReceiptSchema.parse({ ...base, state: "uncertain", sideEffects: "owner_resumed", result: { reason: "Owner resume outcome requires receipt/health reconciliation" } });
    const previous = beginOperation(intent);
    if (previous !== null) return jsonSchema.parse(previous);
    await runtime.resume(config);
    const observed = readOwnerControl(scope);
    const receipt = ownerControlReceiptSchema.parse({ ...intent, state: "committed", ownerEpoch: observed.ownerEpoch, revision: observed.revision, result: { managerSession: scope.managerSession } });
    finishOperation(receipt);
    return jsonSchema.parse(receipt);
  }
  if (snapshot.leaseExpires <= runtime.now()) return jsonSchema.parse({ state: snapshot.archived ? "archived" : "offline", scope, ...snapshot, effective: { status: "unavailable", reason: "owner_offline" } });
  if (request.kind === "associations") {
    const params = new URLSearchParams({ limit: String(request.limit), ...(request.after === null ? {} : { after: request.after }) });
    const page = hostAssociationPageSchema.parse(await ownerRequest(scope, `/host/associations?${params}`, null));
    if (encode(page.scope) !== encode(scope)) throw new StoreAuthorityError("Association owner response differs from the requested scope");
    return jsonSchema.parse(page);
  }
  if (request.kind === "settings") {
    const params = new URLSearchParams({ limit: String(request.limit ?? 100), ...(request.after === undefined ? {} : { after: request.after }) });
    return ownerRequest(scope, `/host/settings?${params}`, null);
  }
  const query = hostStatusQuerySchema.parse(request.query ?? {});
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const status = hostStatusSchema.parse(await ownerRequest(scope, `/status?${params}`, null));
  if (request.kind === "staff") return jsonSchema.parse({ scope, observedAt: status.observedAt, revision: status.storeRevision, staff: status.staff });
  if (request.kind === "progress") return jsonSchema.parse({ scope, observedAt: status.observedAt, revision: status.storeRevision, queue: status.queue, teams: status.teams });
  if (request.kind === "alerts") return jsonSchema.parse({ scope, observedAt: status.observedAt, revision: status.storeRevision, state: status.state, reasons: status.reasons, supervision: status.supervision });
  return jsonSchema.parse(status);
}
export async function executeHostControl(value: unknown, runtime: HostControlRuntime): Promise<HostControlResponse> {
  const request = hostControlCommandSchema.parse(value);
  const result = await dispatchHostControl(request, runtime);
  return hostControlResponseSchema.parse({ operation: request.kind, result });
}
if (import.meta.main) {
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of Bun.stdin.stream()) {
      size += chunk.byteLength;
      if (size > 65536) throw new StoreAuthorityError("Host control request exceeds 64 KiB");
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const result = await executeHostControl(JSON.parse(text), { now: Date.now, executionHost: hostname, resume: launchRuntimeHost, observeManager: async (config) => {
      const herdr = createHerdrRuntime({ session: config.herdrSession, workspaceId: config.workspaceId, binary: config.herdrBinary, run: runHerdrCommand });
      const expectedHarness = "harness" in config ? "claude" : "omp";
      return (await herdr.observe()).some((item) => item.harness === expectedHarness && item.paneId === config.managerPaneId && item.nativeSession === (expectedHarness === "omp" ? config.managerFile : config.managerSession));
    } });
    process.stdout.write(encode(result) + "\n");
  } catch (error: unknown) {
    process.stderr.write(encode({ error: error instanceof Error ? error.constructor.name : "HostControlError", message: (error instanceof Error ? error.message : String(error)).slice(0, 2048), ...(error instanceof HostControlUncertainError ? { outcome: error.outcome } : {}) }) + "\n");
    process.exitCode = 1;
  }
}
