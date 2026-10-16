import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type StartupStore } from "../src/store";
import type { RuntimeBinding } from "../src/runtime-contracts";

const roots: string[] = [];
const stores: StartupStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "startup-runtime-"));
  roots.push(root);
  const home = join(root, "home");
  const boundRoot = join(root, "repo");
  mkdirSync(boundRoot);
  const scope = { home, boundRoot, host: "fixture", name: "test", managerSession: "manager-session" };
  const owner = { id: "coordinator", managerGeneration: 1, leaseMs: 10000 };
  const path = join(home, "startup", "test", "staff.sqlite");
  let clock = 100;
  const store = openStore({ path, scope, owner, now: () => clock });
  stores.push(store);
  const source = { rolePath: "/canonical/startup-role-manager/SKILL.md", roleRevision: "role-hash", loopPath: "/canonical/startup-loop/SKILL.md", loopRevision: "loop-hash" };
  const launch: RuntimeBinding = { employeeId: "manager", generation: 1, launchId: "launch-manager", credentialDigest: "digest", source, paneId: "w1:p1", terminalId: "term1", tabId: "w1:t1", nativeSession: "manager-session", state: "ready", error: null, lastSeen: 100, lastPoll: 100, lastProgress: 100, turnActive: false, stateSequence: null, observedState: null };
  return { store, launch, path, scope, owner, advance: (time: number): void => { clock = time; } };
}

test("launch reservations are durable, replay-safe and reject another credential for one generation", () => {
  const f = fixture();
  f.store.prepareRuntime(f.launch);
  expect(f.store.prepareRuntime(f.launch)).toEqual(f.launch);
  expect(() => f.store.prepareRuntime({ ...f.launch, credentialDigest: "other" })).toThrow();
  expect(() => f.store.prepareRuntime({ ...f.launch, generation: 0 })).toThrow();
  f.store.close();
  const reopened = openStore({ path: f.path, scope: f.scope, owner: f.owner, now: () => 101 });
  stores.push(reopened);
  expect(reopened.runtimeBindings()).toEqual([f.launch]);
});

test("observed idle and done share one completion episode without settling work", () => {
  const { store, launch } = fixture();
  store.prepareRuntime(launch);
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "idle", sequence: 1, observedAt: 110 });
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "idle", sequence: 1, observedAt: 111 });
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "done", sequence: 2, observedAt: 112 });
  expect(store.snapshot().messages.map((m) => [m.recipient, m.kind])).toEqual([["manager", "alert"]]);
  expect(store.snapshot().results).toHaveLength(0);
  expect(store.runtimeBindings()[0]?.lastProgress).toBe(100);
  expect(store.runtimeBindings()[0]?.lastSeen).toBe(112);
  expect(() => store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "wrong", state: "done", sequence: 3, observedAt: 113 })).toThrow();
});

test("increasing Herdr sequences cannot flood an unchanged completion episode", () => {
  const { store, launch } = fixture();
  store.prepareRuntime(launch);
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: sequence % 2 === 0 ? "idle" : "done", sequence, observedAt: 110 + sequence });
  }
  expect(store.snapshot().messages).toHaveLength(1);
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "working", sequence: 101, observedAt: 211 });
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "done", sequence: 102, observedAt: 212 });
  expect(store.snapshot().messages).toHaveLength(2);
  expect(store.snapshot().messages.filter((message) => message.status === "pending")).toHaveLength(1);
  expect(store.runtimeBindings()[0]).toMatchObject({ lastSeen: 212, stateSequence: 102, lastProgress: 100 });
});

test("legacy observation compaction preserves claimed mail, task reports, latest observations and audit", () => {
  const { store, launch, path } = fixture();
  store.prepareRuntime(launch);
  store.bindEmployee({ manager: store.managerBinding, binding: { ...store.managerBinding, assignment: null, source: launch.source } });
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    store.runtimeAlert({ id: `legacy-${sequence}`, correlation: launch.launchId, payload: { kind: "runtime-observation", employeeId: "manager", generation: 1, state: "done", sequence } });
  }
  const legacy = new Database(path);
  legacy.query("UPDATE records SET payload=json_set(payload,'$.status','claimed') WHERE kind='message' AND id='legacy-1'").run();
  legacy.query("INSERT INTO records VALUES('claim','legacy-claim',?)").run(JSON.stringify({ id: "legacy-claim", employeeId: "manager", messageId: "legacy-1", ownerEpoch: store.ownerEpoch, generation: store.managerBinding.generation, status: "active" }));
  legacy.close();
  expect(store.snapshot().messages.find((message) => message.id === "legacy-1")?.status).toBe("claimed");
  store.runtimeAlert({ id: "task-report", correlation: "work", payload: { kind: "stale-item", itemId: "important" } });
  const result = store.compactRuntimeObservations();
  expect(result).toEqual({ acknowledged: 2 });
  const snapshot = store.snapshot();
  expect(snapshot.messages.map((m) => [m.id, m.status])).toEqual([["legacy-1", "claimed"], ["legacy-2", "acknowledged"], ["legacy-3", "acknowledged"], ["legacy-4", "pending"], ["task-report", "pending"]]);
  expect(snapshot.claims).toHaveLength(1);
  expect(snapshot.results).toHaveLength(0);
  expect(store.compactRuntimeObservations()).toEqual({ acknowledged: 0 });
});

test("runtime alerts deduplicate durably and stale session observations cannot overwrite newer states", () => {
  const { store, launch } = fixture();
  store.prepareRuntime(launch);
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "working", sequence: 4, observedAt: 120 });
  expect(() => store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "idle", sequence: 3, observedAt: 121 })).toThrow();
  store.runtimeAlert({ id: "missing-pa", correlation: "manager", payload: { reason: "PA missing" } });
  store.runtimeAlert({ id: "missing-pa", correlation: "manager", payload: { reason: "PA missing" } });
  expect(store.snapshot().messages.filter((m) => m.id === "missing-pa")).toHaveLength(1);
});

test("working observations remain queryable without waking the manager", () => {
  const { store, launch } = fixture();
  store.prepareRuntime(launch);
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "working", sequence: 4, observedAt: 120 });
  expect(store.snapshot().messages).toHaveLength(0);
  expect(store.runtimeBindings()[0]?.observedState).toBe("working");
});

test("seen completions can alternate done and idle at the same sequence without changing progress or duplicating alerts", () => {
  const { store, launch } = fixture();
  store.prepareRuntime(launch);
  for (const [index, state] of ["done", "idle", "done", "idle"].entries()) {
    store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: state === "done" ? "done" : "idle", sequence: 4, observedAt: 110 + index });
  }
  expect(store.runtimeBindings()[0]).toMatchObject({ observedState: "idle", stateSequence: 4, lastProgress: 100, lastSeen: 113 });
  expect(store.snapshot().messages).toHaveLength(1);
  expect(() => store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "working", sequence: 4, observedAt: 114 })).toThrow("conflicts");
});

test("an existing immutable observation alert survives replay from a legacy stale runtime checkpoint", () => {
  const { store, launch } = fixture();
  store.prepareRuntime(launch);
  const payload = { kind: "runtime-observation", employeeId: "manager", generation: 1, state: "done", observedAt: 109, previousSequence: 1, sequence: 4 };
  store.runtimeAlert({ id: "runtime-launch-manager-4-done", correlation: launch.launchId, payload });
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "done", sequence: 4, observedAt: 120 });
  expect(store.snapshot().messages).toHaveLength(1);
  expect(store.snapshot().messages[0]?.payload).toEqual(payload);
  expect(store.runtimeBindings()[0]).toMatchObject({ stateSequence: 4, observedState: "done", lastSeen: 120, lastProgress: 100 });
});

test("a stale runtime update cannot erase a newer lifecycle observation checkpoint", () => {
  const { store, launch } = fixture();
  store.prepareRuntime(launch);
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "working", sequence: 4, observedAt: 120 });
  expect(() => store.updateRuntime({ ...launch, lastSeen: 120 })).toThrow("observation");
});

test("observation replay rejects an existing alert with a different employee identity", () => {
  const { store, launch } = fixture();
  store.prepareRuntime(launch);
  store.runtimeAlert({ id: "runtime-launch-manager-4-done", correlation: launch.launchId, payload: { kind: "runtime-observation", employeeId: "other", generation: 1, state: "done", sequence: 4 } });
  expect(() => store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "done", sequence: 4, observedAt: 120 })).toThrow("launch identity");
  expect(store.runtimeBindings()[0]?.stateSequence).toBeNull();
});

test("item progress advances only for a new revision and survives restart without a replay reset", () => {
  const f = fixture();
  const first = { itemId: "ITEM-1", revision: 1, status: "QUEUED", observedAt: 100 };
  expect(f.store.observeItemProgress(first)).toEqual({ itemId: "ITEM-1", revision: 1, status: "QUEUED", changedAt: 100 });
  expect(f.store.observeItemProgress({ ...first, observedAt: 150 }).changedAt).toBe(100);
  expect(() => f.store.observeItemProgress({ ...first, status: "REVIEW", observedAt: 151 })).toThrow("revision");
  expect(f.store.observeItemProgress({ ...first, revision: 2, observedAt: 160 }).changedAt).toBe(160);
  expect(() => f.store.observeItemProgress({ ...first, observedAt: 170 })).toThrow("regressed");
  expect(() => f.store.observeItemProgress({ ...first, revision: 3, observedAt: 159 })).toThrow("regressed");
  f.store.close();
  const reopened = openStore({ path: f.path, scope: f.scope, owner: f.owner, now: () => 175 });
  stores.push(reopened);
  expect(reopened.itemProgress()).toEqual([{ itemId: "ITEM-1", revision: 2, status: "QUEUED", changedAt: 160 }]);
  expect(reopened.observeItemProgress({ ...first, revision: 2, observedAt: 175 }).changedAt).toBe(160);
});

test("abandoning an absent never-admitted launch consumes its generation and preserves recovery history", () => {
  const f = fixture();
  const hired = f.store.reserveHire({ authority: { kind: "employee", binding: f.store.managerBinding }, request: { requestId: "stranded", role: "dev", additional: 1, revision: "role-hash" } });
  const id = hired.employees[0]?.id;
  if (!id) throw new Error("Missing hired employee");
  const source = { ...f.launch.source, rolePath: "/canonical/startup-role-dev/SKILL.md" };
  const old: RuntimeBinding = { ...f.launch, employeeId: id, generation: 1, launchId: "stranded-launch", credentialDigest: "old-digest", source, paneId: null, terminalId: null, tabId: null, nativeSession: null, state: "uncertain", lastPoll: 0 };
  f.store.prepareRuntime(old);
  f.advance(1200);
  const request = { manager: f.store.managerBinding, employeeId: id, launchId: old.launchId, evidence: "Verified unknown shell allocation stopped and original root absent", verifiedAbsentAt: 1200, connectionDeadlineMs: 1000 };
  expect(f.store.abandonUnadmittedRuntime(request)).toBe(2);
  expect(f.store.abandonUnadmittedRuntime(request)).toBe(2);
  expect(f.store.runtimeBindings()[0]).toEqual({ ...old, state: "abandoned", turnActive: false, error: "Abandoned by explicit manager recovery" });
  expect(f.store.runtimeAbandonments()).toHaveLength(1);
  expect(f.store.runtimeAbandonments()[0]).toMatchObject({ employeeId: id, launchId: old.launchId, generation: 1, nextGeneration: 2, evidence: request.evidence });
  expect(() => f.store.abandonUnadmittedRuntime({ ...request, evidence: "different recovery" })).toThrow("conflict");
  expect(() => f.store.updateRuntime({ ...old, state: "starting" })).toThrow("abandoned");
  expect(() => f.store.bindEmployee({ manager: f.store.managerBinding, binding: { employeeId: id, generation: 1, nativeHandle: "old-root", source, assignment: null } })).toThrow("generation");
  f.store.prepareRuntime({ ...old, generation: 2, launchId: "fresh-launch", credentialDigest: "new-digest", state: "prepared" });
  expect(f.store.bindEmployee({ manager: f.store.managerBinding, binding: { employeeId: id, generation: 2, nativeHandle: "fresh-root", source, assignment: null } }).generation).toBe(2);
  f.store.close();
  const reopened = openStore({ path: f.path, scope: f.scope, owner: f.owner, now: () => 1201 });
  stores.push(reopened);
  expect(reopened.runtimeAbandonments()[0]).toMatchObject({ launchId: old.launchId, evidence: request.evidence });
  expect(reopened.runtimeBindings()).toHaveLength(2);
});

test("abandonment requires manager evidence, expired connection and a never-admitted generation", () => {
  const f = fixture();
  const hired = f.store.reserveHire({ authority: { kind: "employee", binding: f.store.managerBinding }, request: { requestId: "stranded", role: "dev", additional: 1, revision: "role-hash" } });
  const id = hired.employees[0]?.id;
  if (!id) throw new Error("Missing hired employee");
  const old: RuntimeBinding = { ...f.launch, employeeId: id, generation: 1, launchId: "stranded-launch", source: { ...f.launch.source, rolePath: "/canonical/startup-role-dev/SKILL.md" }, state: "prepared", nativeSession: null, paneId: null, terminalId: null, tabId: null, lastPoll: 0 };
  f.store.prepareRuntime(old);
  const request = { manager: f.store.managerBinding, employeeId: id, launchId: old.launchId, evidence: "absent", verifiedAbsentAt: 100, connectionDeadlineMs: 1000 };
  expect(() => f.store.abandonUnadmittedRuntime(request)).toThrow("recent");
  f.advance(1200);
  expect(() => f.store.abandonUnadmittedRuntime({ ...request, verifiedAbsentAt: 1200, evidence: null })).toThrow("evidence");
  expect(() => f.store.abandonUnadmittedRuntime({ ...request, verifiedAbsentAt: 100 })).toThrow("verification");
  expect(() => f.store.abandonUnadmittedRuntime({ ...request, verifiedAbsentAt: 1200, manager: { employeeId: id, generation: 0, nativeHandle: "forged" } })).toThrow();
  expect(f.store.runtimeAbandonments()).toHaveLength(0);
  expect(f.store.snapshot().employees.find((e) => e.id === id)?.generation).toBe(0);
});


test("employee polling selects only its pending messages, unresolved claims and reconciliation grants", () => {
  const f = fixture();
  const db = new Database(f.path);
  const insert = db.query("INSERT INTO records(kind,id,payload) VALUES(?,?,?)");
  f.store.runtimeAlert({ id: "own-alert", correlation: "manager", payload: "pending" });
  for (const [kind, fields, states] of [
    ["message", { recipient: "other" }, ["pending", "claimed", "acknowledged"]],
    ["claim", { employeeId: "other" }, ["active", "reconciliation", "settled"]],
    ["grant", { employeeId: "other" }, ["held", "reconciliation", "released"]],
  ] satisfies readonly (readonly [string, object, readonly string[]])[]) {
    for (const state of states) insert.run(kind, `${kind}-${state}`, JSON.stringify({ ...fields, [kind === "grant" ? "state" : "status"]: state }));
  }
  insert.run("message", "old-own-message", JSON.stringify({ recipient: "manager", status: "acknowledged" }));
  insert.run("claim", "old-own-claim", JSON.stringify({ employeeId: "manager", status: "settled" }));
  insert.run("grant", "released-own-grant", JSON.stringify({ employeeId: "manager", state: "released" }));
  expect(f.store.employeeView("manager")).toMatchObject({ team: null, claims: [], grants: [] });
  expect(f.store.employeeView("manager").messages.map((m) => m.id)).toEqual(["own-alert"]);
  insert.run("claim", "malformed-own-active", JSON.stringify({ employeeId: "manager", status: "active" }));
  expect(() => f.store.employeeView("manager")).toThrow();
  db.close();
});

test("polling indexes migrate existing records and stay current through message settlement", () => {
  const f = fixture();
  const alert = f.store.runtimeAlert({ id: "own-alert", correlation: "manager", payload: "pending" });
  const db = new Database(f.path);
  for (const name of ["records_message_recipient_status", "records_claim_employee_status", "records_grant_employee_state", "records_runtime_employee_generation"]) db.exec(`DROP INDEX ${name}`);
  db.close(); f.store.close();
  const reopened = openStore({ path: f.path, scope: f.scope, owner: f.owner, now: () => 101 }); stores.push(reopened);
  reopened.bindEmployee({ manager: reopened.managerBinding, binding: { ...reopened.managerBinding, assignment: null, source: f.launch.source } });
  expect(reopened.employeeView("manager").messages).toEqual([alert]);
  const check = new Database(f.path);
  const plan = JSON.stringify(check.query("EXPLAIN QUERY PLAN SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')=? AND json_extract(payload,'$.status')='pending' ORDER BY rowid").all("manager"));
  expect(plan).toContain("SEARCH records USING INDEX records_message_recipient_status");
  check.close();
  const receipt = reopened.claimNext({ employee: reopened.managerBinding });
  const claim = receipt?.claim;
  if (!claim) throw new Error("Missing alert claim");
  expect(reopened.employeeView("manager").messages).toHaveLength(0);
  expect(reopened.employeeView("manager").claims).toEqual([claim]);
});
