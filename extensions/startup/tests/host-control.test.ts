import { createHash } from "node:crypto";
import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, chmodSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeHostControl as executeTypedHostControl, hostControlResponseSchema, hostControlReceiptSchema, HostControlUncertainError, type HostControlRuntime } from "../host-control";
import { type Scope } from "../src/contracts";
import { prepareManagerLaunch, launchRuntimeHost, type RuntimeHostConfig } from "../src/v7-launch";
import { openCoordinator, serveCoordinator } from "../src/coordinator";
import { openStore, ownerControlOperationPath, readOwnerControl } from "../src/store";

async function executeHostControl(value: unknown, runtime: HostControlRuntime) {
  const response = await executeTypedHostControl(value, runtime);
  if (response.operation === "receipt") return response.result.state === "found" ? response.result.receipt : null;
  return response.result;
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-control-")));
  roots.push(root);
  const configHome = join(root, "config");
  const skillsHome = join(configHome, "jp-skills");
  const boundRoot = join(root, "repo");
  mkdirSync(skillsHome, { recursive: true }); mkdirSync(boundRoot);
  const scope: Scope = { skillsHome, boundRoot, startupRoot: join(skillsHome, "startup", "alpha"), name: "alpha", host: hostname(), managerSession: "native-manager" };
  const runtime: HostControlRuntime = { now: () => 1000, executionHost: hostname, observeManager: async () => false, resume: async () => { throw new Error("No runtime launch authorized in fixture"); } };
  const create = { kind: "create", requestId: "create-alpha", scope, skillsRoot: resolve(import.meta.dir, "../../.."), executionLimit: 8, harness: "omp", expectedOwnerEpoch: 0, expectedRevision: 0 };
  return { root, configHome, scope, runtime, create };
}
test("cold create and list need no running owner and select is read-only", async () => {
  const f = fixture();
  expect(await executeHostControl({ kind: "list", configHome: f.configHome, after: null, limit: 10 }, f.runtime)).toEqual({ rows: [], nextCursor: null });
  const created = hostControlReceiptSchema.parse(await executeHostControl(f.create, f.runtime));
  expect(created).toMatchObject({ state: "committed", kind: "create", sideEffects: "root_initialized" });
  expect(await executeHostControl(f.create, f.runtime)).toEqual(created);
  const before = readOwnerControl(f.scope);
  expect(before.leaseExpires).toBe(0);
  expect(await executeHostControl({ kind: "select", scope: f.scope }, f.runtime)).toMatchObject({ sideEffects: "none", settings: expect.any(Array) });
  expect(readOwnerControl(f.scope)).toEqual(before);
  expect(await executeHostControl({ kind: "list", configHome: f.configHome, after: null, limit: 10 }, f.runtime)).toMatchObject({ rows: [{ scope: f.scope }], nextCursor: null });
  await expect(executeHostControl({ ...f.create, requestId: "another-create" }, f.runtime)).rejects.toThrow("already has a binding");
  await expect(executeHostControl({ ...f.create, harness: "claude" }, f.runtime)).rejects.toThrow("payload conflict");
});
test("offline settings preserve future-launch scope, revision fencing and exact receipts", async () => {
  const f = fixture();
  await executeHostControl(f.create, f.runtime);
  const before = readOwnerControl(f.scope);
  const apply = { kind: "settings_apply", requestId: "settings-1", scope: f.scope, expectedOwnerEpoch: before.ownerEpoch, expectedRevision: before.revision, role: "dev", harness: "claude", model: "sonnet", effort: "high", baseSettingsRevision: 0 };
  await expect(executeHostControl({ ...apply, requestId: f.create.requestId }, f.runtime)).rejects.toThrow("payload conflict");
  const receipt = await executeHostControl(apply, f.runtime);
  expect(receipt).toMatchObject({ state: "committed", sideEffects: "future_launch_settings", result: { requested: { harness: "claude" }, scope: "future_launch", revision: 1, provenance: { kind: "host_request" } } });
  const after = readOwnerControl(f.scope);
  expect(await executeHostControl(apply, f.runtime)).toEqual(receipt);
  expect(await executeHostControl({ kind: "receipt", scope: f.scope, requestId: "settings-1" }, f.runtime)).toEqual(receipt);
  expect(readOwnerControl(f.scope)).toEqual(after);
  await expect(executeHostControl({ ...apply, model: "opus" }, f.runtime)).rejects.toThrow("payload conflict");
  await expect(executeHostControl({ ...apply, requestId: "settings-2" }, f.runtime)).rejects.toThrow("revision changed");
  await expect(executeHostControl({ ...apply, requestId: "settings-3", expectedRevision: after.revision }, f.runtime)).rejects.toThrow("base revision");
  expect(await executeHostControl({ kind: "settings", scope: f.scope }, f.runtime)).toMatchObject({ state: "offline", effective: { status: "unavailable" } });
});
test("archive preserves cold history, refuses a live lease and permanently prevents reopening", async () => {
  const f = fixture();
  await executeHostControl(f.create, f.runtime);
  const store = openStore({ path: join(f.scope.startupRoot, "staff.sqlite"), scope: f.scope, owner: { id: "active", managerGeneration: 1, leaseMs: 60000 }, now: f.runtime.now });
  const live = readOwnerControl(f.scope);
  const archive = { kind: "archive" as const, requestId: "archive-1", scope: f.scope, expectedOwnerEpoch: live.ownerEpoch, expectedRevision: live.revision };
  expect(() => store.hostControl(archive)).toThrow("live lease");
  store.close();
  expect(await executeHostControl(archive, f.runtime)).toMatchObject({ state: "committed", result: { history: "preserved" } });
  expect(readOwnerControl(f.scope).archived).toBe(true);
  expect(() => openStore({ path: join(f.scope.startupRoot, "staff.sqlite"), scope: f.scope, owner: { id: "new", managerGeneration: 1, leaseMs: 60000 }, now: f.runtime.now })).toThrow("archived");
});
test("cold resume cannot create a replacement manager and cross-root requests fail", async () => {
  const f = fixture();
  await executeHostControl(f.create, f.runtime);
  const before = readOwnerControl(f.scope);
  expect(await executeHostControl({ kind: "resume", scope: f.scope, requestId: "resume-1", expectedOwnerEpoch: before.ownerEpoch, expectedRevision: before.revision }, f.runtime)).toMatchObject({ state: "missing_session", sideEffects: "none" });
  expect(readOwnerControl(f.scope)).toEqual(before);
  await expect(executeHostControl({ kind: "select", scope: { ...f.scope, managerSession: "different" } }, f.runtime)).rejects.toThrow("binding differs");
});

function runtimeConfig(f: ReturnType<typeof fixture>): RuntimeHostConfig {
  return { name: f.scope.name, ompConfigRoot: join(f.configHome, "ronin"), skillsHome: f.scope.skillsHome, startupRoot: f.scope.startupRoot, stateDirectory: f.scope.startupRoot, boundRoot: f.scope.boundRoot, skillsRoot: f.create.skillsRoot, socketPath: join(f.scope.startupRoot, "runtime.sock"), profile: "default", managerSession: f.scope.managerSession, managerFile: join(f.scope.startupRoot, "manager.jsonl"), managerPaneId: "w1:p1", managerCredential: "private-fixture", herdrSession: "fixture", workspaceId: "w1", herdrBinary: "herdr", herdrIntegration: "/fixture/herdr-agent-state.sh", ownerGeneration: 1, policy: { tickMs: 1000, paCadenceMs: 60000, progressDeadlineMs: 300000, connectionDeadlineMs: 30000, executionLimit: 4 } };
}
test("uncertain resume is looked up without replay and concurrent creates cannot duplicate initialization", async () => {
  const f = fixture();
  const [first, replay] = await Promise.all([executeHostControl(f.create, f.runtime), executeHostControl(f.create, f.runtime)]);
  expect(first).toEqual(replay);
  const config = runtimeConfig(f);
  writeFileSync(join(f.scope.startupRoot, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  const snapshot = readOwnerControl(f.scope);
  const request = { kind: "resume", scope: f.scope, requestId: "uncertain-resume", expectedOwnerEpoch: snapshot.ownerEpoch, expectedRevision: snapshot.revision };
  let dispatches = 0;
  const runtime: HostControlRuntime = { now: f.runtime.now, executionHost: hostname, observeManager: async () => true, resume: async () => { dispatches++; throw new Error("lost response after dispatch"); } };
  await expect(executeHostControl(request, runtime)).rejects.toThrow("lost response");
  expect(await executeHostControl(request, runtime)).toMatchObject({ state: "uncertain", sideEffects: "owner_resumed" });
  expect(await executeHostControl({ kind: "receipt", scope: f.scope, requestId: request.requestId }, runtime)).toMatchObject({ state: "uncertain" });
  expect(dispatches).toBe(1);
});
test("archive and launch share the same exclusion lock and archived roots never spawn", async () => {
  const f = fixture();
  await executeHostControl(f.create, f.runtime);
  const snapshot = readOwnerControl(f.scope);
  const request = { kind: "archive", scope: f.scope, requestId: "archive-locked", expectedOwnerEpoch: snapshot.ownerEpoch, expectedRevision: snapshot.revision };
  const lock = join(f.scope.startupRoot, "runtime-launch.lock");
  writeFileSync(lock, "fixture launch in progress", { mode: 0o600 });
  await expect(executeHostControl(request, f.runtime)).rejects.toThrow("exist");
  expect(readOwnerControl(f.scope).archived).toBe(false);
  rmSync(lock);
  await executeHostControl(request, f.runtime);
  await expect(launchRuntimeHost(runtimeConfig(f))).rejects.toThrow("Archived Startup");
  expect(existsSync(join(f.scope.startupRoot, "runtime-launch.json"))).toBe(false);
  expect(existsSync(join(f.scope.startupRoot, "runtime.log"))).toBe(false);
});

test("cold create rejects a foreign execution host before creating the root", async () => {
  const f = fixture();
  await expect(executeHostControl({ ...f.create, scope: { ...f.scope, host: "wrong-host" } }, f.runtime)).rejects.toThrow("execution host");
  expect(existsSync(f.scope.startupRoot)).toBe(false);
});

test("cold create excludes a distinct request while another process owns initialization", async () => {
  const f = fixture();
  mkdirSync(f.scope.startupRoot, { recursive: true, mode: 0o700 });
  const lock = join(f.scope.startupRoot, "create.lock");
  const child = Bun.spawn([process.execPath, "-e", 'const fs = require("node:fs"); const fd = fs.openSync(process.argv[1], "wx", 0o600); fs.writeFileSync(fd, "first-request"); console.log("locked"); await Bun.stdin.text(); fs.closeSync(fd); fs.unlinkSync(process.argv[1]);', lock], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    await expect(executeHostControl({ ...f.create, requestId: "second-request", harness: "claude" }, f.runtime)).rejects.toThrow("initialization");
    expect(existsSync(join(f.scope.startupRoot, "binding.json"))).toBe(false);
  } finally { reader.releaseLock(); child.stdin.end(); await child.exited; }
  expect(await executeHostControl(f.create, f.runtime)).toMatchObject({ state: "committed" });
  await expect(executeHostControl({ ...f.create, requestId: "second-request", harness: "claude" }, f.runtime)).rejects.toThrow("already has a binding");
  expect(readOwnerControl(f.scope).settings.every((entry) => entry.requested.harness === "omp")).toBe(true);
});

test("host output identifies the operation and typed missing receipt", async () => {
  const f = fixture();
  const created = await executeTypedHostControl(f.create, f.runtime);
  expect(created).toMatchObject({ operation: "create", result: { state: "committed", kind: "create" } });
  expect(await executeTypedHostControl({ kind: "receipt", scope: f.scope, requestId: "missing" }, f.runtime)).toEqual({ operation: "receipt", result: { state: "missing", requestId: "missing" } });
  expect(hostControlResponseSchema.safeParse({ ...created, operation: "archive" }).success).toBe(false);
  if (created.operation !== "create") throw new Error("Expected create response");
  expect(hostControlResponseSchema.safeParse({ ...created, result: { ...created.result, state: "missing_session" } }).success).toBe(false);
});

test("OMP manager preparation freezes applied settings before launch and receipt replay", async () => {
  const f = fixture();
  await executeHostControl(f.create, f.runtime);
  const cold = readOwnerControl(f.scope);
  await executeHostControl({ kind: "settings_apply", requestId: "manager-settings", scope: f.scope, expectedOwnerEpoch: cold.ownerEpoch, expectedRevision: cold.revision, role: "manager", harness: "omp", model: "provider/model", effort: "high", baseSettingsRevision: 0 }, f.runtime);
  const saved = readOwnerControl(f.scope);
  const request = { kind: "prepare_manager", scope: f.scope, requestId: "prepare-1", harness: "omp", expectedOwnerEpoch: saved.ownerEpoch, expectedRevision: saved.revision };
  const prepared = await executeHostControl(request, f.runtime);
  expect(prepared).toMatchObject({ state: "committed", sideEffects: "manager_prepared", result: { argv: ["--model", "provider/model", "--thinking", "high"], settings: { revision: 1 } } });
  const after = readOwnerControl(f.scope);
  await executeHostControl({ kind: "settings_apply", requestId: "later-settings", scope: f.scope, expectedOwnerEpoch: after.ownerEpoch, expectedRevision: after.revision, role: "manager", harness: "omp", model: "provider/later", effort: "low", baseSettingsRevision: 1 }, f.runtime);
  expect(await executeHostControl(request, f.runtime)).toEqual(prepared);
  await expect(executeHostControl({ ...request, harness: "claude" }, f.runtime)).rejects.toThrow("payload conflict");
});

test("manager preparation excludes archive and rejects stale acquisition without freezing", async () => {
  const f = fixture();
  await executeHostControl(f.create, f.runtime);
  const cold = readOwnerControl(f.scope);
  const request = { kind: "prepare_manager", scope: f.scope, requestId: "locked-prep", harness: "omp", expectedOwnerEpoch: cold.ownerEpoch, expectedRevision: cold.revision };
  const lock = join(f.scope.startupRoot, "runtime-launch.lock");
  writeFileSync(lock, "archive in progress", { mode: 0o600 });
  await expect(executeHostControl(request, f.runtime)).rejects.toThrow("exist");
  expect(existsSync(join(f.scope.startupRoot, "manager-launch.json"))).toBe(false);
  rmSync(lock);
});
test("wrong manager harness cannot freeze selection for a later launch", async () => {
  const f = fixture();
  await executeHostControl(f.create, f.runtime);
  expect(() => prepareManagerLaunch({ scope: f.scope, harness: "claude", now: f.runtime.now, expectedControl: null })).toThrow("harness");
  const current = readOwnerControl(f.scope);
  await executeHostControl({ kind: "settings_apply", requestId: "correct-harness", scope: f.scope, expectedOwnerEpoch: current.ownerEpoch, expectedRevision: current.revision, role: "manager", harness: "claude", model: "sonnet", effort: "high", baseSettingsRevision: 0 }, f.runtime);
  expect(prepareManagerLaunch({ scope: f.scope, harness: "claude", now: f.runtime.now, expectedControl: null }).requested.harness).toBe("claude");
});

test("manager preparation cannot reuse or mask an already committed settings request", async () => {
  const f = fixture();
  await executeHostControl(f.create, f.runtime);
  const cold = readOwnerControl(f.scope);
  const apply = { kind: "settings_apply", requestId: "shared-key", scope: f.scope, expectedOwnerEpoch: cold.ownerEpoch, expectedRevision: cold.revision, role: "manager", harness: "omp", model: "provider/model", effort: "high", baseSettingsRevision: 0 };
  const original = await executeHostControl(apply, f.runtime);
  const saved = readOwnerControl(f.scope);
  const file = join(f.scope.startupRoot, "control", createHash("sha256").update(apply.requestId).digest("hex") + ".json");
  await expect(executeHostControl({ kind: "prepare_manager", scope: f.scope, requestId: apply.requestId, harness: "omp", expectedOwnerEpoch: saved.ownerEpoch, expectedRevision: saved.revision }, f.runtime)).rejects.toThrow("payload conflict");
  expect(existsSync(file)).toBe(false);
  expect(existsSync(join(f.scope.startupRoot, "manager-launch.json"))).toBe(false);
  expect(readOwnerControl(f.scope)).toEqual(saved);
  expect(await executeHostControl({ kind: "receipt", scope: f.scope, requestId: apply.requestId }, f.runtime)).toEqual(original);
  expect(await executeHostControl(apply, f.runtime)).toEqual(original);
});

test("a concurrent request reservation excludes preparation and direct owner settings commits", async () => {
  const f = fixture();
  await executeHostControl(f.create, f.runtime);
  const store = openStore({ path: join(f.scope.startupRoot, "staff.sqlite"), scope: f.scope, owner: { id: "concurrent-owner", managerGeneration: 1, leaseMs: 60000 }, now: f.runtime.now });
  const before = readOwnerControl(f.scope);
  const requestId = "reserved-key";
  const lockPath = ownerControlOperationPath(f.scope, requestId) + ".lock";
  const child = Bun.spawn([process.execPath, "-e", 'const fs = require("node:fs"); const fd = fs.openSync(process.argv[1], "wx", 0o600); console.log("locked"); await Bun.stdin.text(); fs.closeSync(fd); fs.unlinkSync(process.argv[1]);', lockPath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const apply = { kind: "settings_apply" as const, requestId, scope: f.scope, expectedOwnerEpoch: before.ownerEpoch, expectedRevision: before.revision, role: "manager" as const, harness: "omp" as const, model: "provider/model", effort: "high", baseSettingsRevision: 0 };
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    expect(() => store.hostControl(apply)).toThrow("exist");
    store.close();
    const offline = readOwnerControl(f.scope);
    await expect(executeHostControl({ kind: "prepare_manager", requestId, scope: f.scope, harness: "omp", expectedOwnerEpoch: offline.ownerEpoch, expectedRevision: offline.revision }, f.runtime)).rejects.toThrow("exist");
    expect(existsSync(join(f.scope.startupRoot, "manager-launch.json"))).toBe(false);
    expect(existsSync(ownerControlOperationPath(f.scope, requestId))).toBe(false);
    expect(readOwnerControl(f.scope).settings).toEqual(before.settings);
  } finally { store.close(); reader.releaseLock(); child.stdin.end(); await child.exited; }
  expect(await executeHostControl(apply, f.runtime)).toMatchObject({ state: "committed", kind: "settings_apply" });
});

test("interrupted create intent is readable without binding, initialization, unlocking or replay", async () => {
  const f = fixture();
  const bootPath = resolve(import.meta.dir, "../src/boot.ts");
  const hostPath = resolve(import.meta.dir, "../host-control.ts");
  const script = `import { mock } from "bun:test";
const boot = await import(${JSON.stringify(bootPath)});
mock.module(${JSON.stringify(bootPath)}, () => ({ ...boot, persistBinding: () => process.exit(73) }));
const { executeHostControl } = await import(${JSON.stringify(hostPath)});
await executeHostControl(JSON.parse(process.argv[1]), { now: () => 1000, executionHost: () => ${JSON.stringify(f.scope.host)}, observeManager: async () => false, resume: async () => { throw new Error("Forbidden replay"); } });`;
  const child = Bun.spawn([process.execPath, "-e", script, JSON.stringify(f.create)], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(73);
  expect(existsSync(join(f.scope.startupRoot, "binding.json"))).toBe(false);
  expect(existsSync(join(f.scope.startupRoot, "staff.sqlite"))).toBe(false);
  expect(existsSync(join(f.scope.startupRoot, "create.lock"))).toBe(true);
  const tree = () => readdirSync(f.scope.startupRoot, { recursive: true }).map(String).sort().map((name) => {
    const path = join(f.scope.startupRoot, name);
    const stat = statSync(path);
    return { name, mode: stat.mode, content: stat.isFile() ? readFileSync(path, "utf8") : null };
  });
  const before = tree();
  expect(await executeTypedHostControl({ kind: "receipt", scope: f.scope, requestId: f.create.requestId }, f.runtime)).toMatchObject({ operation: "receipt", result: { state: "found", receipt: { state: "uncertain", kind: "create", requestId: f.create.requestId, scope: f.scope } } });
  expect(tree()).toEqual(before);
  for (const scope of [{ ...f.scope, managerSession: "foreign" }, { ...f.scope, name: "foreign" }, { ...f.scope, host: "foreign-host" }]) await expect(executeHostControl({ kind: "receipt", scope, requestId: f.create.requestId }, f.runtime)).rejects.toThrow();
  expect(tree()).toEqual(before);
  writeFileSync(join(f.scope.startupRoot, "binding.json"), JSON.stringify({ scope: { ...f.scope, managerSession: "foreign" }, executionLimit: 8 }), { mode: 0o600 });
  await expect(executeHostControl({ kind: "receipt", scope: f.scope, requestId: f.create.requestId }, f.runtime)).rejects.toThrow("binding differs");
  rmSync(join(f.scope.startupRoot, "binding.json"));
  const path = ownerControlOperationPath(f.scope, f.create.requestId);
  chmodSync(path, 0o644);
  await expect(executeHostControl({ kind: "receipt", scope: f.scope, requestId: f.create.requestId }, f.runtime)).rejects.toThrow();
  chmodSync(path, 0o600);
  const intent = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...intent, kind: "resume", sideEffects: "owner_resumed" }), { mode: 0o600 });
  await expect(executeHostControl({ kind: "receipt", scope: f.scope, requestId: f.create.requestId }, f.runtime)).rejects.toThrow();
  expect(existsSync(join(f.scope.startupRoot, "staff.sqlite"))).toBe(false);
  expect(existsSync(join(f.scope.startupRoot, "create.lock"))).toBe(true);
});

for (const loss of ["fetch", "body"] as const) test(`live settings ${loss} loss exposes typed uncertainty and recovers one committed receipt without replay`, async () => {
  const base = fixture();
  const scope = { ...base.scope, startupRoot: join(base.root, "s") };
  const f = { ...base, scope };
  await executeHostControl({ ...f.create, scope }, f.runtime);
  const store = openStore({ path: join(scope.startupRoot, "staff.sqlite"), scope, owner: { id: "live-writer", managerGeneration: 1, leaseMs: 60000 }, now: f.runtime.now });
  const config = runtimeConfig(f);
  const coordinator = openCoordinator({ store, config, now: f.runtime.now, herdr: { check: async () => { throw new Error("No native probes"); }, observe: async () => [], renameCrew: async () => {}, createCrew: async () => { throw new Error("No native layout"); }, split: async () => { throw new Error("No native layout"); }, launch: async () => { throw new Error("No native launch"); } } });
  const server = serveCoordinator({ coordinator, socketPath: config.socketPath });
  writeFileSync(join(scope.startupRoot, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  const snapshot = readOwnerControl(scope);
  const request = { kind: "settings_apply", requestId: `lost-${loss}`, scope, expectedOwnerEpoch: snapshot.ownerEpoch, expectedRevision: snapshot.revision, role: "dev", harness: "omp", model: "provider/model", effort: "high", baseSettingsRevision: 0 };
  const nativeFetch = globalThis.fetch;
  let writes = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Promise<Response> => {
    const response = await nativeFetch(url, init);
    if (String(url).includes("/host/control")) {
      writes++;
      if (loss === "fetch") throw new Error("response lost after commit");
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("response body lost after commit")); } }));
    }
    return response;
  }, { preconnect: nativeFetch.preconnect }));
  try {
    let failure: unknown;
    try { await executeTypedHostControl(request, f.runtime); } catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(HostControlUncertainError);
    expect(failure).toMatchObject({ outcome: { state: "uncertain", kind: "settings_apply", requestId: request.requestId, scope, replay: "forbidden", recovery: { kind: "receipt", requestId: request.requestId, scope } } });
    const recovered = await executeTypedHostControl({ kind: "receipt", requestId: request.requestId, scope }, f.runtime);
    expect(recovered).toMatchObject({ operation: "receipt", result: { state: "found", receipt: { kind: "settings_apply", state: "committed", requestId: request.requestId, result: { revision: 1 } } } });
    expect(store.roleSettings("dev").revision).toBe(1);
    expect(writes).toBe(1);
  } finally { fetchSpy.mockRestore(); server.stop(true); store.close(); }
});

test("CLI serializes the original uncertain settings identity after a committed live write", async () => {
  const base = fixture();
  const scope = { ...base.scope, startupRoot: join(base.root, "s") };
  const f = { ...base, scope, runtime: { ...base.runtime, now: Date.now } };
  await executeHostControl({ ...f.create, scope }, f.runtime);
  const store = openStore({ path: join(scope.startupRoot, "staff.sqlite"), scope, owner: { id: "cli-writer", managerGeneration: 1, leaseMs: 60000 }, now: Date.now });
  const config = runtimeConfig(f);
  const coordinator = openCoordinator({ store, config, now: Date.now, herdr: { check: async () => {}, observe: async () => [], renameCrew: async () => {}, createCrew: async () => { throw new Error("No native layout"); }, split: async () => { throw new Error("No native layout"); }, launch: async () => { throw new Error("No native launch"); } } });
  let writes = 0;
  const server = serveCoordinator({ coordinator: { ...coordinator, hostControl: async (request) => { const result = await coordinator.hostControl(request); writes++; return result; } }, socketPath: config.socketPath });
  writeFileSync(join(scope.startupRoot, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  const snapshot = readOwnerControl(scope);
  const request = { kind: "settings_apply", requestId: "cli-lost-write", scope, expectedOwnerEpoch: snapshot.ownerEpoch, expectedRevision: snapshot.revision, role: "dev", harness: "omp", model: "provider/model", effort: "high", baseSettingsRevision: 0 };
  const preload = join(f.root, "lost-body.ts");
  writeFileSync(preload, 'const originalFetch = globalThis.fetch; globalThis.fetch = async (url, init) => { await originalFetch(url, init); return new Response(new ReadableStream({ start(controller) { controller.error(new Error("lost body after commit")); } })); };', { mode: 0o600 });
  try {
    const child = Bun.spawn([process.execPath, "--preload", preload, resolve(import.meta.dir, "../host-control.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({ error: "HostControlUncertainError", outcome: { state: "uncertain", kind: "settings_apply", requestId: request.requestId, scope, replay: "forbidden", recovery: { kind: "receipt", requestId: request.requestId, scope } } });
    expect(await executeTypedHostControl({ kind: "receipt", requestId: request.requestId, scope }, f.runtime)).toMatchObject({ operation: "receipt", result: { state: "found", receipt: { state: "committed", requestId: request.requestId, result: { revision: 1 } } } });
    expect(writes).toBe(1);
    expect(store.roleSettings("dev").revision).toBe(1);
  } finally { server.stop(true); store.close(); }
});

test("read-only transport loss and pre-dispatch refusal are not typed as uncertain writes", async () => {
  const base = fixture();
  const scope = { ...base.scope, startupRoot: join(base.root, "s") };
  const f = { ...base, scope };
  await executeHostControl({ ...f.create, scope }, f.runtime);
  const store = openStore({ path: join(scope.startupRoot, "staff.sqlite"), scope, owner: { id: "readonly-owner", managerGeneration: 1, leaseMs: 60000 }, now: f.runtime.now });
  const config = runtimeConfig(f);
  writeFileSync(join(scope.startupRoot, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  const transport = new Error("read-only endpoint unavailable");
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(transport);
  try {
    await expect(executeTypedHostControl({ kind: "settings", scope }, f.runtime)).rejects.toBe(transport);
    await expect(executeTypedHostControl({ kind: "settings_apply", scope, requestId: "invalid-write" }, f.runtime)).rejects.not.toBeInstanceOf(HostControlUncertainError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally { fetchSpy.mockRestore(); store.close(); }
});

for (const field of ["boundRoot", "skillsHome"] as const) test(`live host projections preserve a long ${field} through setup receipts`, async () => {
  const base = fixture();
  const longPath: string = join(base.root, ...Array.from({ length: 11 }, () => "directory".repeat(6)));
  mkdirSync(longPath, { recursive: true });
  expect(longPath.length).toBeGreaterThan(512);
  const scope: Scope = { ...base.scope, startupRoot: join(base.root, "s"), [field]: longPath };
  const f = { ...base, scope };
  await executeHostControl({ ...f.create, scope }, f.runtime);
  const store = openStore({ path: join(scope.startupRoot, "staff.sqlite"), scope, owner: { id: "long-path-owner", managerGeneration: 1, leaseMs: 60000 }, now: f.runtime.now });
  const config = runtimeConfig(f);
  const coordinator = openCoordinator({ store, config, now: f.runtime.now, herdr: { check: async () => { throw new Error("No native probes"); }, observe: async () => [], renameCrew: async () => {}, createCrew: async () => { throw new Error("No native layout"); }, split: async () => { throw new Error("No native layout"); }, launch: async () => { throw new Error("No native launch"); } } });
  const server = serveCoordinator({ coordinator, socketPath: config.socketPath });
  writeFileSync(join(scope.startupRoot, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  try {
    const before = readOwnerControl(scope);
    const status = await executeTypedHostControl({ kind: "status", scope }, f.runtime);
    expect(status).toMatchObject({ operation: "status", result: {
      binding: { boundRoot: scope.boundRoot, home: scope.skillsHome },
      setup: { receipts: expect.arrayContaining([{ kind: "scope", name: scope.name, host: scope.host, boundRoot: scope.boundRoot, home: scope.skillsHome }]) },
    } });
    for (const kind of ["staff", "progress", "alerts"] as const) {
      expect(await executeTypedHostControl({ kind, scope }, f.runtime)).toMatchObject({ operation: kind, result: { scope } });
    }
    expect(readOwnerControl(scope)).toEqual(before);
  } finally { server.stop(true); store.close(); }
});

test("association command reads the owner socket and refuses offline state without lifecycle or settings effects", async () => {
  const base = fixture();
  const scope: Scope = { ...base.scope, startupRoot: join(base.root, "s") };
  const f = { ...base, scope };
  await executeHostControl({ ...f.create, scope }, f.runtime);
  const request = { kind: "associations", scope, after: null, limit: 64 };
  const beforeOffline = readOwnerControl(scope);
  expect(await executeHostControl(request, f.runtime)).toMatchObject({ state: "offline", effective: { status: "unavailable" } });
  expect(readOwnerControl(scope)).toEqual(beforeOffline);
  const store = openStore({ path: join(scope.startupRoot, "staff.sqlite"), scope, owner: { id: "association-reader", managerGeneration: 1, leaseMs: 60000 }, now: f.runtime.now });
  const config = runtimeConfig(f);
  const forbidden = async (): Promise<never> => { throw new Error("Association read cannot invoke native operations"); };
  const coordinator = openCoordinator({ store, config, now: f.runtime.now, herdr: { check: forbidden, observe: forbidden, renameCrew: forbidden, createCrew: forbidden, split: forbidden, launch: forbidden } });
  const server = serveCoordinator({ coordinator, socketPath: config.socketPath });
  writeFileSync(join(scope.startupRoot, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  try {
    const before = readOwnerControl(scope);
    const result = await executeTypedHostControl(request, f.runtime);
    expect(result).toMatchObject({ operation: "associations", result: { state: "observed", scope, ownerId: "association-reader", herdrSession: "fixture", rows: [{ employeeId: "manager", status: "unavailable", reason: "unprepared" }] } });
    expect(hostControlResponseSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-fixture|managerCredential|credentialDigest|bootId/);
    expect(readOwnerControl(scope)).toEqual(before);
    const source = { rolePath: "/fixture/startup-role-manager/SKILL.md", roleRevision: "fixture-role", loopPath: "/fixture/startup-loop/SKILL.md", loopRevision: "fixture-loop" };
    store.prepareRuntime({ employeeId: "manager", generation: 1, launchId: "fixture-launch", credentialDigest: "private-fixture-digest", source, settings: store.roleSettings("manager"), paneId: "actual-fixture-pane", terminalId: "actual-fixture-terminal", tabId: null, nativeSession: config.managerFile, state: "ready", error: null, lastSeen: 1000, lastPoll: 1000, lastProgress: 1000, turnActive: false, stateSequence: null, observedState: null });
    store.bindEmployee({ manager: store.managerBinding, binding: { ...store.managerBinding, source, assignment: null } });
    store.admitRuntimeConnection({ startupRoot: scope.startupRoot, harness: "omp", ownerId: store.ownerId, ownerEpoch: store.ownerEpoch, employeeId: "manager", generation: 1, launchId: "fixture-launch", nativeSession: config.managerFile, agentSessionId: null, connectionEpoch: "private-fixture-connection" });
    const admitted = readOwnerControl(scope);
    expect(await executeTypedHostControl(request, f.runtime)).toMatchObject({ operation: "associations", result: { rows: [{ status: "current", launchId: "fixture-launch", nativeSession: config.managerFile, terminalId: "actual-fixture-terminal" }] } });
    expect(readOwnerControl(scope)).toEqual(admitted);
    await expect(executeTypedHostControl({ ...request, scope: { ...scope, managerSession: "foreign" } }, f.runtime)).rejects.toThrow("binding differs");
  } finally { server.stop(true); store.close(); }
  const archived = fixture();
  await executeHostControl(archived.create, archived.runtime);
  const snapshot = readOwnerControl(archived.scope);
  await executeHostControl({ kind: "archive", requestId: "association-archive", scope: archived.scope, expectedOwnerEpoch: snapshot.ownerEpoch, expectedRevision: snapshot.revision }, archived.runtime);
  expect(await executeHostControl({ ...request, scope: archived.scope }, archived.runtime)).toMatchObject({ state: "archived", effective: { status: "unavailable" } });
});
