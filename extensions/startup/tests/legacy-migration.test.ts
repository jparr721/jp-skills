import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store";
import { verifyCancelledLegacySnapshot } from "../src/legacy-cancel-verifier";
import { migrateLegacyStartup, transferCancelledLegacyItem } from "../src/legacy-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-legacy-migration-")));
  roots.push(root);
  const source = join(root, "old");
  const target = join(root, "home", "startup", "new");
  const repository = join(root, "repo");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(repository, { mode: 0o700 });
  writeFileSync(join(source, "binding.json"), JSON.stringify({ name: "old", bound_root: repository }));
  const original = [{ id: "A", status: "QUEUED", request: "Implement A", acceptance: "A works" }, { id: "B", status: "IN_PROGRESS", request: "Implement B", dispatched_at: 123 }];
  writeFileSync(join(source, "queue.json"), JSON.stringify({ items: original, extra: "preserve" }));
  const db = new Database(join(source, "staff.sqlite"));
  db.run("CREATE TABLE records(kind TEXT, id TEXT, payload TEXT)");
  db.run("CREATE TABLE audit(sequence INTEGER, kind TEXT, id TEXT, payload TEXT)");
  db.run("CREATE TABLE lease(singleton INTEGER, token TEXT, epoch INTEGER, generation INTEGER, expires INTEGER)");
  db.run("INSERT INTO records VALUES('claim','old-claim','{\"status\":\"active\"}')");
  db.close();
  const scope = { skillsHome: join(root, "home"), startupRoot: target, boundRoot: repository, host: "host", name: "new", managerSession: "manager-session" };
  const store = openStore({ path: join(target, "staff.sqlite"), scope, owner: { id: "owner", managerGeneration: 1, leaseMs: 1000 }, now: () => 100 });
  store.bindEmployee({ manager: store.managerBinding, binding: { ...store.managerBinding, assignment: null, source: { rolePath: "/skills/jp-startup-role-manager/SKILL.md", roleRevision: "r", loopPath: "/skills/jp-startup-loop/SKILL.md", loopRevision: "l" } } });
  return { root, source, target, store, original };
}

test("imports legacy queue with durable provenance, safe unresolved state and idempotent receipts", () => {
  const f = fixture();
  const input = { sourceRoot: f.source, targetRoot: f.target, migrationId: "legacy-one", store: f.store, manager: f.store.managerBinding };
  const receipt = migrateLegacyStartup(input);
  expect(receipt.items).toEqual(["A", "B"]);
  expect(migrateLegacyStartup(input)).toEqual(receipt);
  const queue = JSON.parse(readFileSync(join(f.target, "queue.json"), "utf8"));
  expect(queue.map((row: { id: string; status: string }) => [row.id, row.status])).toEqual([["A", "NEEDS_DECISION"], ["B", "NEEDS_DECISION"]]);
  expect(queue[0].legacy_import.original).toEqual(f.original[0]);
  expect(JSON.parse(readFileSync(join(f.source, "queue.json"), "utf8")).items).toEqual(f.original);
  const snapshot = new Database(join(receipt.archive, "staff.sqlite"), { readonly: true });
  expect(snapshot.query("SELECT id FROM records").all()).toEqual([{ id: "old-claim" }]);
  snapshot.close();
  f.store.close();
});

test("rejects changed source on replay and leaves imported queue intact", () => {
  const f = fixture();
  const input = { sourceRoot: f.source, targetRoot: f.target, migrationId: "legacy-one", store: f.store, manager: f.store.managerBinding };
  migrateLegacyStartup(input);
  const before = readFileSync(join(f.target, "queue.json"), "utf8");
  writeFileSync(join(f.source, "queue.json"), JSON.stringify([{ id: "C" }]));
  expect(() => migrateLegacyStartup(input)).toThrow();
  expect(readFileSync(join(f.target, "queue.json"), "utf8")).toBe(before);
  f.store.close();
});

test("refuses malformed scoped roots and duplicate legacy item identities without modifying the target queue", () => {
  const f = fixture();
  const input = { sourceRoot: f.source, targetRoot: f.target, migrationId: "legacy-one", store: f.store, manager: f.store.managerBinding };
  const binding = join(f.source, "binding.json");
  writeFileSync(binding, JSON.stringify({ scope: { name: "already-scoped" } }));
  expect(() => migrateLegacyStartup(input)).toThrow();
  writeFileSync(binding, JSON.stringify({ name: "old", bound_root: "/legacy-repo" }));
  writeFileSync(join(f.source, "queue.json"), JSON.stringify([{ id: "A" }, { id: "A" }]));
  expect(() => migrateLegacyStartup(input)).toThrow("duplicate");
  expect(f.store.snapshot().intakes).toHaveLength(0);
  f.store.close();
});

test("will not overwrite a current target item with the same legacy identity", () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "current-event", input: "current", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "current-capture", eventId: "current-event", rows: [{ id: "A", expectedRevision: null, fields: { request: "Current work", acceptance: null, blocked_on: null, status: "QUEUED" } }], receipt: null } });
  const before = readFileSync(join(f.target, "queue.json"), "utf8");
  expect(() => migrateLegacyStartup({ sourceRoot: f.source, targetRoot: f.target, migrationId: "legacy-one", store: f.store, manager: f.store.managerBinding })).toThrow();
  expect(readFileSync(join(f.target, "queue.json"), "utf8")).toBe(before);
  expect(f.store.snapshot().intakes).toHaveLength(1);
  f.store.close();
});

test("retains terminal legacy history in the archive without reopening it", () => {
  const f = fixture();
  const path = join(f.source, "queue.json");
  const original = [...f.original, { id: "C", status: "DONE", request: "Completed work" }];
  writeFileSync(path, JSON.stringify({ items: original }));
  const receipt = migrateLegacyStartup({ sourceRoot: f.source, targetRoot: f.target, migrationId: "legacy-terminal", store: f.store, manager: f.store.managerBinding });
  expect(receipt.items).toEqual(["A", "B"]);
  expect(receipt.retained).toEqual(["C"]);
  expect(JSON.parse(readFileSync(join(receipt.archive, "queue.json"), "utf8")).items).toEqual(original);
  expect(f.store.queueItems().map((row) => row.id)).toEqual(["A", "B"]);
  f.store.close();
});

test("archives a scoped source and quarantines every nonterminal row without rewriting it", () => {
  const f = fixture();
  const scope = { skillsHome: join(f.root, "old-home"), startupRoot: f.source, boundRoot: join(f.root, "repo"), host: "host", name: "old", managerSession: "old-session" };
  writeFileSync(join(f.source, "binding.json"), JSON.stringify({ scope, executionLimit: 4 }));
  const db = new Database(join(f.source, "staff.sqlite"));
  db.run("INSERT INTO records VALUES('meta','scope',?)", [JSON.stringify(scope)]);
  db.close();
  const input = { sourceRoot: f.source, targetRoot: f.target, migrationId: "scoped-one", store: f.store, manager: f.store.managerBinding };
  const before = readFileSync(join(f.source, "binding.json"), "utf8");
  const receipt = migrateLegacyStartup(input);
  expect(receipt.items).toEqual(["A", "B"]);
  expect(receipt.unresolved).toEqual(["A", "B"]);
  expect(migrateLegacyStartup(input)).toEqual(receipt);
  expect(f.store.queueItems().map((row) => row.status)).toEqual(["NEEDS_DECISION", "NEEDS_DECISION"]);
  expect(readFileSync(join(f.source, "binding.json"), "utf8")).toBe(before);
  f.store.close();
});

test("rejects a scoped binding whose database belongs to another owner", () => {
  const f = fixture();
  const scope = { skillsHome: join(f.root, "old-home"), startupRoot: f.source, boundRoot: join(f.root, "repo"), host: "host", name: "old", managerSession: "old-session" };
  writeFileSync(join(f.source, "binding.json"), JSON.stringify({ scope, executionLimit: null }));
  const db = new Database(join(f.source, "staff.sqlite"));
  db.run("INSERT INTO records VALUES('meta','scope',?)", [JSON.stringify({ ...scope, managerSession: "other" })]);
  db.close();
  expect(() => migrateLegacyStartup({ sourceRoot: f.source, targetRoot: f.target, migrationId: "wrong-owner", store: f.store, manager: f.store.managerBinding })).toThrow("does not match its database");
  expect(f.store.snapshot().intakes).toHaveLength(0);
  f.store.close();
});

test("archives a terminal-only queue without reopening work or claiming old effects are resolved", () => {
  const f = fixture();
  const rows = [{ id: "A", status: "DONE", request: "Done" }, { id: "B", status: "MERGED", request: "Merged" }];
  writeFileSync(join(f.source, "queue.json"), JSON.stringify({ items: rows }));
  const input = { sourceRoot: f.source, targetRoot: f.target, migrationId: "drained", store: f.store, manager: f.store.managerBinding };
  const receipt = migrateLegacyStartup(input);
  expect(receipt).toMatchObject({ items: [], unresolved: [], retained: ["A", "B"] });
  expect(migrateLegacyStartup(input)).toEqual(receipt);
  expect(f.store.queueItems()).toEqual([]);
  const snapshot = new Database(join(receipt.archive, "staff.sqlite"), { readonly: true });
  expect(snapshot.query("SELECT id FROM records WHERE kind='claim'").all()).toEqual([{ id: "old-claim" }]);
  snapshot.close();
  f.store.close();
});

test("transfers a cooperatively cancelled undispatched item after its team finishes", async () => {
  const f = fixture();
  const scope = { skillsHome: join(f.root, "old-home"), startupRoot: f.source, boundRoot: join(f.root, "repo"), host: "host", name: "old", managerSession: "old-session" };
  writeFileSync(join(f.source, "binding.json"), JSON.stringify({ scope, executionLimit: 4 }));
  const db = new Database(join(f.source, "staff.sqlite"));
  const put = (kind: string, id: string, value: unknown): void => { db.run("INSERT INTO records VALUES(?,?,?)", [kind, id, JSON.stringify(value)]); };
  const before = [{ id: "A", status: "QUEUED", request: "A", acceptance: "works" }, { id: "B", status: "QUEUED", request: "B" }];
  const after = [{ ...before[0], status: "CANCELLED" }, before[1]];
  put("meta", "scope", scope);
  put("hostReceipt", "cancel:cancel-a", { kind: "cancel", id: "cancel:cancel-a", intentId: "cancel-a", requestOrItemId: "A", digest: createHash("sha256").update(JSON.stringify({ intentId: "cancel-a", requestOrItemId: "A" })).digest("hex"), createdAt: 1, target: { kind: "item", itemId: "A", revision: 2, status: "CANCELLED", slots: [] } });
  put("intent", "host-cancel/cancel-a", { state: "complete", file: "queue.json", before: JSON.stringify(before), after: JSON.stringify(after), hostCancel: { itemId: "A", eventId: "event-a", teamId: "team-a", revision: 2 } });
  put("queueOwner", "A", { id: "A", eventId: "event-a", revision: 2 });
  put("team", "team-a", { id: "team-a", eventId: "event-a", state: "finished" });
  put("workflowLimit", "A", 2);
  put("workflowTarget", "A", "main");
  put("workflowScope", "empty-scope", { itemId: "A", claimId: "unclaimed" });
  const verify = () => verifyCancelledLegacySnapshot({ snapshot: join(f.source, "staff.sqlite"), sourceRoot: f.source, itemId: "A", intentId: "cancel-a", migrationId: "move-a" });
  db.run("UPDATE records SET payload=? WHERE kind='team' AND id='team-a'", [JSON.stringify({ id: "team-a", eventId: "event-a", state: "ready" })]);
  expect(verify).toThrow();
  db.run("UPDATE records SET payload=? WHERE kind='team' AND id='team-a'", [JSON.stringify({ id: "team-a", eventId: "event-a", state: "finished" })]);
  put("itemExecution", "A", { itemId: "A" });
  expect(verify).toThrow("execution history");
  db.run("DELETE FROM records WHERE kind='itemExecution' AND id='A'");
  put("workflowLaunch", "launched", { scopeId: "empty-scope" });
  expect(verify).toThrow("workflow or execution history");
  db.run("DELETE FROM records WHERE kind='workflowLaunch' AND id='launched'");
  put("workflowLaunch", "closed-launch", { scopeId: "empty-scope", state: "closed", location: { pane: "old" } });
  expect(verify).toThrow("workflow or execution history");
  db.run("DELETE FROM records WHERE kind='workflowLaunch' AND id='closed-launch'");
  put("workflowChild", "failed-child", { itemId: "A", state: "failed" });
  expect(verify).toThrow("workflow or execution history");
  db.run("DELETE FROM records WHERE kind='workflowChild' AND id='failed-child'");
  put("claim", "unclaimed", { status: "active" });
  expect(verify).toThrow("workflow or execution history");
  db.run("DELETE FROM records WHERE kind='claim' AND id='unclaimed'");
  db.run("UPDATE records SET payload=json_set(payload,'$.state','pending') WHERE kind='intent' AND id='host-cancel/cancel-a'");
  expect(verify).toThrow();
  db.run("UPDATE records SET payload=json_set(payload,'$.state','complete') WHERE kind='intent' AND id='host-cancel/cancel-a'");
  db.run("UPDATE records SET payload='3' WHERE kind='workflowLimit' AND id='A'");
  expect(verify().limit).toBe(3);
  db.run("UPDATE records SET payload='2' WHERE kind='workflowLimit' AND id='A'");
  db.close();
  writeFileSync(join(f.source, "queue.json"), JSON.stringify({ items: before }));
  migrateLegacyStartup({ sourceRoot: f.source, targetRoot: f.target, migrationId: "move-a", store: f.store, manager: f.store.managerBinding });
  const oldQueue = JSON.parse(readFileSync(join(f.target, "queue.json"), "utf8"));
  delete oldQueue.find((row: { id: string }) => row.id === "A").legacy_import.sourceRoot;
  writeFileSync(join(f.target, "queue.json"), JSON.stringify(oldQueue));
  writeFileSync(join(f.source, "queue.json"), JSON.stringify({ items: after }));
  const input = { sourceRoot: f.source, targetRoot: f.target, migrationId: "move-a", itemId: "A", intentId: "cancel-a", store: f.store, manager: f.store.managerBinding };
  const other = fixture();
  await expect(transferCancelledLegacyItem({ ...input, store: other.store, manager: other.store.managerBinding })).rejects.toThrow("destination does not match");
  other.store.recordIntake({ manager: other.store.managerBinding, event: { eventId: "conflict-event", input: "other", amendItemIds: [] } });
  other.store.captureIntake({ architect: other.store.managerBinding, capture: { captureId: "conflict-capture", eventId: "conflict-event", rows: [{ id: "A", expectedRevision: null, fields: { request: "different", acceptance: null, blocked_on: null, status: "QUEUED" } }], receipt: null } });
  await expect(transferCancelledLegacyItem({ ...input, targetRoot: other.target, store: other.store, manager: other.store.managerBinding })).rejects.toThrow("different source");
  expect(existsSync(join(f.source, "legacy-handovers"))).toBe(false);
  other.store.close();
  const competitor = fixture();
  const interrupted = new Proxy(f.store, { get(target, property, receiver) { if (property === "reconcileLegacyItem") return () => { throw new Error("Simulated crash after source receipt"); }; return Reflect.get(target, property, receiver); } });
  const attempts = await Promise.allSettled([
    transferCancelledLegacyItem({ ...input, store: interrupted }),
    transferCancelledLegacyItem({ ...input, targetRoot: competitor.target, store: competitor.store, manager: competitor.store.managerBinding }),
  ]);
  expect(attempts[0]).toMatchObject({ status: "rejected" });
  expect(attempts[1]).toMatchObject({ status: "rejected" });
  expect(competitor.store.queueItems()).toEqual([]);
  const receipt = await transferCancelledLegacyItem(input);
  expect(receipt).toMatchObject({ itemId: "A", limit: 2, target: "main", original: before[0] });
  competitor.store.close();
  expect(await transferCancelledLegacyItem(input)).toEqual(receipt);
  expect(f.store.queueItems().find((row) => row.id === "A")?.status).toBe("QUEUED");
  expect(JSON.parse(readFileSync(join(f.source, "queue.json"), "utf8")).items).toEqual(after);
  f.store.close();
});

test("source handover receipt has one winner across concurrent processes", async () => {
  const f = fixture();
  const modulePath = join(import.meta.dir, "../src/legacy-migration.ts");
  const program = `import { claimLegacyHandover } from ${JSON.stringify(modulePath)}; const [sourceRoot, targetRoot] = process.argv.slice(1); claimLegacyHandover({ sourceRoot, targetRoot, itemId: "parallel-item", intentId: "cancel", migrationId: "move" });`;
  const start = (targetRoot: string) => Bun.spawn([process.execPath, "-e", program, f.source, targetRoot], { stdout: "pipe", stderr: "pipe" });
  const first = start(join(f.root, "destination-a"));
  const second = start(join(f.root, "destination-b"));
  const codes = await Promise.all([first.exited, second.exited]);
  expect([...codes].sort()).toEqual([0, 1]);
  const winner = codes[0] === 0 ? join(f.root, "destination-a") : join(f.root, "destination-b");
  expect(await start(winner).exited).toBe(0);
  f.store.close();
});
