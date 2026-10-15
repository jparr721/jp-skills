import { afterEach, expect, test } from "bun:test";
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

test("observed idle and done become durable manager messages without settling work", () => {
  const { store, launch } = fixture();
  store.prepareRuntime(launch);
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "idle", sequence: 1, observedAt: 110 });
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "idle", sequence: 1, observedAt: 111 });
  store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "manager-session", state: "done", sequence: 2, observedAt: 112 });
  expect(store.snapshot().messages.map((m) => [m.recipient, m.kind])).toEqual([["manager", "alert"], ["manager", "alert"]]);
  expect(store.snapshot().results).toHaveLength(0);
  expect(store.runtimeBindings()[0]?.lastProgress).toBe(100);
  expect(store.runtimeBindings()[0]?.lastSeen).toBe(112);
  expect(() => store.observeRuntime({ employeeId: "manager", generation: 1, nativeSession: "wrong", state: "done", sequence: 3, observedAt: 113 })).toThrow();
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
