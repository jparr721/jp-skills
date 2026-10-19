import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeHostControl as executeTypedHostControl, hostControlResponseSchema, hostControlReceiptSchema, type HostControlRuntime } from "../host-control";
import { type Scope } from "../src/contracts";
import { prepareManagerLaunch, launchRuntimeHost, type RuntimeHostConfig } from "../src/v7-launch";
import { openStore, readOwnerControl } from "../src/store";

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
  const skillsHome = join(root, "skills-home");
  const boundRoot = join(root, "repo");
  mkdirSync(skillsHome); mkdirSync(boundRoot);
  const configHome = join(root, "config");
  const scope: Scope = { skillsHome, boundRoot, startupRoot: join(configHome, "ronin", "startups", "alpha"), name: "alpha", host: hostname(), managerSession: "native-manager" };
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
