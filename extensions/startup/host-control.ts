import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assertStartupPath, bootSelection, ensureStartupRoot, persistBinding } from "./src/boot";
import { encode, hostStatusQuerySchema, hostStatusSchema, idSchema, jsonSchema, ownerControlReceiptSchema, ownerControlRequestSchema, scopeSchema, timeSchema, StoreAuthorityError, StoreConflictError, StoreFenceError, type Json, type OwnerControlReceipt, type Scope } from "./src/contracts";
import { createHerdrRuntime, runHerdrCommand } from "./src/herdr-runtime";
import { validateRoleSettings } from "./src/profiles";
import { roleSettingsInputSchema } from "./src/runtime-contracts";
import { applyOfflineOwnerControl, openStore, readOwnerControl, readOwnerControlReceipt } from "./src/store";
import { launchRuntimeHost, parseRuntimeHostConfig, readPrivateJson, type RuntimeHostConfig } from "./src/v7-launch";

export const hostControlCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list"), configHome: z.string().startsWith("/"), after: z.string().nullable(), limit: z.number().int().min(1).max(100) }),
  z.strictObject({ kind: z.literal("create"), requestId: idSchema, scope: scopeSchema, skillsRoot: z.string().startsWith("/"), executionLimit: z.number().int().min(3), harness: z.enum(["omp", "claude"]), expectedOwnerEpoch: z.literal(0), expectedRevision: z.literal(0) }),
  z.strictObject({ kind: z.enum(["select"]), scope: scopeSchema }),
  z.strictObject({ kind: z.enum(["status", "staff", "progress", "alerts"]), scope: scopeSchema, query: hostStatusQuerySchema.optional() }),
  z.strictObject({ kind: z.literal("settings"), scope: scopeSchema, after: idSchema.optional(), limit: z.number().int().min(1).max(100).optional() }),
  z.strictObject({ kind: z.literal("settings_draft"), scope: scopeSchema, selection: roleSettingsInputSchema }),
  z.strictObject({ kind: z.literal("receipt"), scope: scopeSchema, requestId: idSchema }),
  z.strictObject({ kind: z.literal("resume"), scope: scopeSchema, requestId: idSchema, expectedOwnerEpoch: timeSchema, expectedRevision: timeSchema }),
  ...ownerControlRequestSchema.options,
]);
export type HostControlCommand = z.infer<typeof hostControlCommandSchema>;
export type HostControlRuntime = Readonly<{ now: () => number; executionHost: () => string; observeManager: (config: RuntimeHostConfig) => Promise<boolean>; resume: (config: RuntimeHostConfig) => Promise<RuntimeHostConfig> }>;
function binding(scope: Scope): void {
  const path = join(scope.startupRoot, "binding.json");
  assertStartupPath(scope.startupRoot, path, "file");
  const saved = z.object({ scope: scopeSchema }).parse(readPrivateJson(path));
  if (encode(saved.scope) !== encode(scope)) throw new StoreAuthorityError("Selected Startup binding differs from the requested scope");
}
function operationPath(scope: Scope, requestId: string): string {
  const directory = join(scope.startupRoot, "control");
  assertStartupPath(scope.startupRoot, directory, "directory");
  const path = join(directory, createHash("sha256").update(requestId).digest("hex") + ".json");
  assertStartupPath(scope.startupRoot, path, "file");
  return path;
}
function readOperation(scope: Scope, requestId: string): OwnerControlReceipt | null {
  const path = operationPath(scope, requestId);
  if (!existsSync(path)) return null;
  const receipt = ownerControlReceiptSchema.parse(readPrivateJson(path));
  if (encode(receipt.scope) !== encode(scope) || receipt.requestId !== requestId) throw new StoreAuthorityError("Saved control operation scope differs");
  return receipt;
}
function beginOperation(receipt: OwnerControlReceipt): void {
  const path = operationPath(receipt.scope, receipt.requestId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, encode(receipt), { mode: 0o600, flag: "wx" });
}
function finishOperation(receipt: OwnerControlReceipt): void {
  const path = operationPath(receipt.scope, receipt.requestId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  assertStartupPath(receipt.scope.startupRoot, temporary, "file");
  writeFileSync(temporary, encode(receipt), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
async function ownerRequest(scope: Scope, path: string, body: Json | null): Promise<Json> {
  const config = parseRuntimeHostConfig(readPrivateJson(join(scope.startupRoot, "runtime-config.json")));
  if (config.skillsHome !== scope.skillsHome || config.startupRoot !== scope.startupRoot || config.name !== scope.name || config.managerSession !== scope.managerSession || config.boundRoot !== scope.boundRoot) throw new StoreAuthorityError("Owner endpoint config does not match selected Startup");
  const response = await fetch(`http://localhost${path}`, { unix: config.socketPath, method: body === null ? "GET" : "POST", ...(body === null ? {} : { headers: { "Content-Type": "application/json" }, body: encode(body) }), signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  if (!response.ok) throw new StoreConflictError(`Owner control ${path} HTTP ${response.status}: ${text.slice(0, 2048)}; mutation outcomes must be looked up by requestId, never automatically replayed`);
  return jsonSchema.parse(JSON.parse(text));
}
export async function executeHostControl(value: unknown, runtime: HostControlRuntime): Promise<Json> {
  const request = hostControlCommandSchema.parse(value);
  if (request.kind === "list") {
    const directory = join(request.configHome, "ronin", "startups");
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
      const existing = readOperation(scope, request.requestId);
      if (existing !== null) { if (existing.digest !== digest) throw new StoreConflictError("Create idempotency key payload conflict"); return jsonSchema.parse(existing); }
      const selection = bootSelection({ cwd: scope.boundRoot, skillsHome: scope.skillsHome, startupRoot: scope.startupRoot, configHome: dirname(dirname(dirname(scope.startupRoot))), skillsRoot: request.skillsRoot, host: scope.host, managerSession: scope.managerSession, command: { kind: "new", name: scope.name, directory: scope.boundRoot, work: null }, explicitName: scope.name, executionLimit: request.executionLimit });
      if (selection === null || encode({ skillsHome: selection.skillsHome, startupRoot: selection.startupRoot, host: selection.host, name: selection.name, boundRoot: selection.boundRoot, managerSession: selection.managerSession }) !== encode(scope)) throw new StoreAuthorityError("Create selection differs from requested canonical scope");
      const intent = ownerControlReceiptSchema.parse({ requestId: request.requestId, digest, scope, kind: "create", state: "uncertain", ownerEpoch: 0, revision: 0, sideEffects: "root_initialized", result: { reason: "Inspect initialized root before any retry" } });
      beginOperation(intent);
      persistBinding(selection);
      const store = openStore({ path: join(scope.startupRoot, "staff.sqlite"), scope, owner: { id: randomUUID(), managerGeneration: 1, leaseMs: 60000 }, now: runtime.now });
      try { store.initializeRoleSettings(request.harness); } finally { store.close(); }
      const snapshot = readOwnerControl(scope);
      const receipt = ownerControlReceiptSchema.parse({ ...intent, state: "committed", ownerEpoch: snapshot.ownerEpoch, revision: snapshot.revision, result: { selection: scope, readiness: "manager_session_required" } });
      finishOperation(receipt);
      return jsonSchema.parse(receipt);
    } finally { closeSync(lock); unlinkSync(lockPath); }
  }
  binding(scope);
  if (request.kind === "receipt") return jsonSchema.parse(readOperation(scope, request.requestId) ?? readOwnerControlReceipt(scope, request.requestId));
  const snapshot = readOwnerControl(scope);
  if (request.kind === "select") return jsonSchema.parse({ scope, ...snapshot, sideEffects: "none" });
  if (request.kind === "settings_draft") return jsonSchema.parse({ draft: validateRoleSettings(request.selection), scope: "future_launch", sideEffects: "none" });
  if (request.kind === "settings_apply" || request.kind === "archive") {
    const receipt = readOperation(scope, request.requestId) ?? readOwnerControlReceipt(scope, request.requestId);
    if (receipt !== null) {
      if (receipt.digest !== createHash("sha256").update(encode(request)).digest("hex")) throw new StoreConflictError("Control idempotency key payload conflict");
      return jsonSchema.parse(receipt);
    }
    if (snapshot.leaseExpires > runtime.now()) return ownerRequest(scope, "/host/control", jsonSchema.parse(request));
    return jsonSchema.parse(applyOfflineOwnerControl(request, runtime.now()));
  }
  if (request.kind === "resume") {
    const digest = createHash("sha256").update(encode(request)).digest("hex");
    const existing = readOperation(scope, request.requestId) ?? readOwnerControlReceipt(scope, request.requestId);
    if (existing !== null) { if (existing.digest !== digest) throw new StoreConflictError("Resume idempotency key payload conflict"); return jsonSchema.parse(existing); }
    if (snapshot.ownerEpoch !== request.expectedOwnerEpoch || snapshot.revision !== request.expectedRevision || snapshot.archived) throw new StoreFenceError("Resume snapshot changed or Startup archived");
    const base = { requestId: request.requestId, digest, scope, kind: "resume" as const, ownerEpoch: snapshot.ownerEpoch, revision: snapshot.revision };
    const configPath = join(scope.startupRoot, "runtime-config.json");
    if (!existsSync(configPath)) {
      const receipt = ownerControlReceiptSchema.parse({ ...base, state: "missing_session", sideEffects: "none", result: { reason: "No saved manager runtime; create a real native manager session first" } });
      beginOperation(receipt); return jsonSchema.parse(receipt);
    }
    const config = parseRuntimeHostConfig(readPrivateJson(configPath));
    if (config.skillsHome !== scope.skillsHome || config.startupRoot !== scope.startupRoot || config.name !== scope.name || config.managerSession !== scope.managerSession || config.boundRoot !== scope.boundRoot) throw new StoreAuthorityError("Resume cannot replace saved manager identity");
    if (!(await runtime.observeManager(config))) {
      const receipt = ownerControlReceiptSchema.parse({ ...base, state: "missing_session", sideEffects: "none", result: { reason: "Saved manager native session is absent" } });
      beginOperation(receipt); return jsonSchema.parse(receipt);
    }
    const fresh = readOwnerControl(scope);
    if (fresh.ownerEpoch !== snapshot.ownerEpoch || fresh.revision !== snapshot.revision || fresh.archived) throw new StoreFenceError("Resume authority changed during native observation");
    const intent = ownerControlReceiptSchema.parse({ ...base, state: "uncertain", sideEffects: "owner_resumed", result: { reason: "Owner resume outcome requires receipt/health reconciliation" } });
    beginOperation(intent);
    await runtime.resume(config);
    const observed = readOwnerControl(scope);
    const receipt = ownerControlReceiptSchema.parse({ ...intent, state: "committed", ownerEpoch: observed.ownerEpoch, revision: observed.revision, result: { managerSession: scope.managerSession } });
    finishOperation(receipt);
    return jsonSchema.parse(receipt);
  }
  if (snapshot.leaseExpires <= runtime.now()) return jsonSchema.parse({ state: snapshot.archived ? "archived" : "offline", scope, ...snapshot, effective: { status: "unavailable", reason: "owner_offline" } });
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
    process.stderr.write(encode({ error: error instanceof Error ? error.constructor.name : "HostControlError", message: (error instanceof Error ? error.message : String(error)).slice(0, 2048) }) + "\n");
    process.exitCode = 1;
  }
}
