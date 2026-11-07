import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openStore } from "/var/tmp/qa-final-8b7/extensions/startup/src/store.ts";
function sha(s) { return createHash("sha256").update(s).digest("hex").slice(0, 16); }
function j(v) { return JSON.stringify(v); }
const wallStart = new Date().toISOString();
const monoStart = process.hrtime.bigint().toString();
console.log("wallStart=" + wallStart + " monoStart=" + monoStart);
function mk() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-supp-")));
  const home = join(root, "home");
  const startupRoot = join(home, "startup", "test");
  const boundRoot = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(boundRoot, { recursive: true });
  const scope = { skillsHome: home, startupRoot, boundRoot, host: "host", name: "test", managerSession: "native-manager" };
  const owner = { id: "owner", managerGeneration: 1, leaseMs: 1000 };
  const store = openStore({ path: join(startupRoot, "staff.sqlite"), scope, owner, now: () => 100 });
  return { root, store };
}
function src(role) { return { rolePath: "/skills/jp-startup-role-" + role + "/SKILL.md", roleRevision: "rev", loopPath: "/skills/jp-startup-loop/SKILL.md", loopRevision: "loop-rev" }; }
function setup(store, limit) {
  store.bindEmployee({ manager: store.managerBinding, binding: Object.assign({}, store.managerBinding, { assignment: null, source: src("manager") }) });
  const user = { kind: "user", acceptedEventId: "accepted" };
  function hire(role, rid) { const r = store.reserveHire({ authority: user, request: { requestId: rid, role, additional: 1, revision: "rev" } }); return r.employees.map((e) => e.id)[0]; }
  const arch = hire("architect", "a1-" + limit + "-" + Math.random().toString(36).slice(2, 6));
  const qa = hire("qa", "q1-" + limit + "-" + Math.random().toString(36).slice(2, 6));
  const dev = hire("dev", "d1-" + limit + "-" + Math.random().toString(36).slice(2, 6));
  store.recordIntake({ manager: store.managerBinding, event: { eventId: "ev-" + qa, input: "req", amendItemIds: [] } });
  const ev = "ev-" + qa;
  const team = store.reserveTeam({ manager: store.managerBinding, request: { eventId: ev, architect: arch, qa, devs: [dev], cues: [arch, qa, dev].map((rr) => ({ id: "as-" + ev + "-" + rr, recipient: rr, kind: "assignment", correlation: ev, payload: { request: "req" } })) } });
  function bindEmp(id, role) { const h = "native-" + id + "-1"; store.bindEmployee({ manager: store.managerBinding, binding: { employeeId: id, generation: 1, nativeHandle: h, source: src(role), assignment: team.id } }); return { employeeId: id, generation: 1, nativeHandle: h }; }
  const ab = bindEmp(arch, "architect"); const qb = bindEmp(qa, "qa"); const db = bindEmp(dev, "dev");
  function completed(id) { return { id, kind: "completed", output: "done", checkpoint: null, outgoing: [] }; }
  store.captureIntake({ architect: ab, capture: { captureId: "cap-" + ev, eventId: ev, rows: [{ id: "item1", expectedRevision: null, fields: { request: "Review this change", acceptance: "Acceptance", blocked_on: null, status: "QUEUED" } }], receipt: "captured" } });
  for (const b of [ab, qb, db]) { const n = store.claimNext({ employee: b }); if (!n) throw new Error("missing notice"); store.settleClaim({ employee: b, claimId: n.claim.id, result: completed("notice-" + b.employeeId) }); }
  return { ab, qb, db, qa, arch, dev, completed, ev };
}
// CASE A nominal with extra keys + hashes
{
  const { root, store } = mk();
  const s = setup(store, 1);
  store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "receipt-1", head: "commit-one", limit: 1, reviewerId: s.qa } });
  const claim = store.claimNext({ employee: s.qb });
  const beforeClaim = j(claim.claim);
  const beforeMsg = j(claim.message);
  console.log("A before claim hash=" + sha(beforeClaim) + " msg hash=" + sha(beforeMsg) + " ids=" + claim.message.id + "/" + claim.claim.id);
  const out = { kind: "workflow-review", reservationId: "receipt-1", head: "commit-one", verdict: "changes-requested", detail: "extra report metadata", evidence: { lines: 3 } };
  const outHashBefore = sha(j(out));
  store.settleClaim({ employee: s.qb, claimId: claim.claim.id, result: Object.assign({}, s.completed("receipt-result"), { output: out }) });
  const afterSettle = sha(j(out));
  console.log("A output hash before=" + outHashBefore + " after=" + afterSettle + " immutable=" + (outHashBefore === afterSettle));
  const settled = store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "receipt-1", resultId: "receipt-result" } });
  console.log("A nominal finalize verdict=" + settled.verdict + " resultId=" + settled.resultId + " PASS=" + (settled.verdict === "changes-requested"));
  // exact replay same result
  const again = store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "receipt-1", resultId: "receipt-result" } });
  console.log("A exact replay verdict=" + again.verdict + " PASS=" + (again.verdict === "changes-requested"));
  // overwite with another result must conflict
  let conflict = false;
  try { store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "receipt-1", resultId: "other-result" } }); } catch (e) { conflict = true; console.log("A overwrite conflict=" + e.constructor.name + ":" + String(e.message).slice(0, 120)); }
  console.log("A overwrite rejected PASS=" + conflict);
  // exhausted budget: second reserve after 1 completed limit1
  let budget = false;
  try { store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "receipt-2", head: "commit-two", limit: 1, reviewerId: s.qa } }); } catch (e) { budget = true; console.log("A budget exhausted=" + String(e.message).slice(0, 140)); }
  console.log("A budget exhausted PASS=" + budget);
  store.close(); rmSync(root, { recursive: true, force: true });
}
// CASE B malformed missing core + invalid verdict + wrong reservation head
{
  const { root, store } = mk();
  const s = setup(store, 1);
  store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "r-b", head: "h-b", limit: 2, reviewerId: s.qa } });
  const claim = store.claimNext({ employee: s.qb });
  // missing core
  let m1 = false;
  try {
    store.settleClaim({ employee: s.qb, claimId: claim.claim.id, result: Object.assign({}, s.completed("bad-1"), { output: { kind: "workflow-review", head: "h-b", verdict: "changes-requested" } }) });
    store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-b", resultId: "bad-1" } });
  } catch (e) { m1 = true; console.log("B missing core rejected=" + String(e.message).slice(0, 140)); }
  console.log("B missing core PASS=" + m1);
  store.close(); rmSync(root, { recursive: true, force: true });
}
{
  const { root, store } = mk();
  const s = setup(store, 1);
  store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "r-c", head: "h-c", limit: 2, reviewerId: s.qa } });
  const claim = store.claimNext({ employee: s.qb });
  let m2 = false;
  try {
    store.settleClaim({ employee: s.qb, claimId: claim.claim.id, result: Object.assign({}, s.completed("bad-2"), { output: { kind: "workflow-review", reservationId: "r-c", head: "h-c", verdict: "bogus" } }) });
    store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-c", resultId: "bad-2" } });
  } catch (e) { m2 = true; console.log("B invalid verdict rejected=" + String(e.message).slice(0, 140)); }
  console.log("B invalid verdict PASS=" + m2);
  store.close(); rmSync(root, { recursive: true, force: true });
}
{
  const { root, store } = mk();
  const s = setup(store, 1);
  store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "r-d", head: "h-d", limit: 2, reviewerId: s.qa } });
  const claim = store.claimNext({ employee: s.qb });
  store.settleClaim({ employee: s.qb, claimId: claim.claim.id, result: Object.assign({}, s.completed("good-d"), { output: { kind: "workflow-review", reservationId: "WRONG", head: "h-d", verdict: "approve" } }) });
  let m3 = false;
  try { store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-d", resultId: "good-d" } }); } catch (e) { m3 = true; console.log("B wrong reservation rejected=" + String(e.message).slice(0, 140)); }
  console.log("B wrong reservation PASS=" + m3);
  store.close(); rmSync(root, { recursive: true, force: true });
}
{
  const { root, store } = mk();
  const s = setup(store, 1);
  store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "r-e", head: "h-e", limit: 2, reviewerId: s.qa } });
  const claim = store.claimNext({ employee: s.qb });
  store.settleClaim({ employee: s.qb, claimId: claim.claim.id, result: Object.assign({}, s.completed("good-e"), { output: { kind: "workflow-review", reservationId: "r-e", head: "WRONGHEAD", verdict: "approve" } }) });
  let m4 = false;
  try { store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-e", resultId: "good-e" } }); } catch (e) { m4 = true; console.log("B wrong head rejected=" + String(e.message).slice(0, 140)); }
  console.log("B wrong head PASS=" + m4);
  store.close(); rmSync(root, { recursive: true, force: true });
}
// CASE C wrong actor foreign result substitute claim stale generation noncompleted unsettled
{
  const { root, store } = mk();
  const s = setup(store, 1);
  store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "r-f", head: "h-f", limit: 2, reviewerId: s.qa } });
  const claim = store.claimNext({ employee: s.qb });
  store.settleClaim({ employee: s.qb, claimId: claim.claim.id, result: Object.assign({}, s.completed("good-f"), { output: { kind: "workflow-review", reservationId: "r-f", head: "h-f", verdict: "approve" } }) });
  let f1 = false;
  try { store.workflowReview({ employee: s.db, request: { action: "settle", reservationId: "r-f", resultId: "good-f" } }); } catch (e) { f1 = true; console.log("C wrong actor dev rejected=" + String(e.message).slice(0, 140)); }
  console.log("C wrong actor PASS=" + f1);
  // stale generation binding
  let f2 = false;
  try { store.workflowReview({ employee: { employeeId: s.ab.employeeId, generation: 999, nativeHandle: s.ab.nativeHandle }, request: { action: "settle", reservationId: "r-f", resultId: "good-f" } }); } catch (e) { f2 = true; console.log("C stale generation rejected=" + e.constructor.name + ":" + String(e.message).slice(0, 120)); }
  console.log("C stale generation PASS=" + f2);
  // nominal architect settle should still succeed after failed attempts
  const ok = store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-f", resultId: "good-f" } });
  console.log("C nominal after negatives verdict=" + ok.verdict + " PASS=" + (ok.verdict === "approve"));
  store.close(); rmSync(root, { recursive: true, force: true });
}
{
  const { root, store } = mk();
  const s = setup(store, 1);
  store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "r-g", head: "h-g", limit: 2, reviewerId: s.qa } });
  // unsettled: finalize before settleClaim
  let g1 = false;
  try { store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-g", resultId: "missing-result" } }); } catch (e) { g1 = true; console.log("C unsettled missing result rejected=" + String(e.message).slice(0, 140)); }
  console.log("C unsettled PASS=" + g1);
  const claim = store.claimNext({ employee: s.qb });
  // noncompleted kind question
  store.settleClaim({ employee: s.qb, claimId: claim.claim.id, result: { id: "q-kind", kind: "question", output: { kind: "workflow-review", reservationId: "r-g", head: "h-g", verdict: "approve" }, checkpoint: null, outgoing: [] } });
  let g2 = false;
  try { store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-g", resultId: "q-kind" } }); } catch (e) { g2 = true; console.log("C noncompleted question rejected=" + String(e.message).slice(0, 140)); }
  console.log("C noncompleted PASS=" + g2);
  store.close(); rmSync(root, { recursive: true, force: true });
}
{
  const { root, store } = mk();
  const s = setup(store, 2);
  store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "r-h", head: "h-h", limit: 2, reviewerId: s.qa } });
  const claim = store.claimNext({ employee: s.qb });
  store.settleClaim({ employee: s.qb, claimId: claim.claim.id, result: Object.assign({}, s.completed("good-h"), { output: { kind: "workflow-review", reservationId: "r-h", head: "h-h", verdict: "block" } }) });
  const okH = store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-h", resultId: "good-h" } });
  console.log("C nominal r-h settles verdict=" + okH.verdict + " PASS=" + (okH.verdict === "block"));
  // second reservation now allowed (r-h completed, limit 2); foreign result good-h must reject on r-h2
  store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "r-h2", head: "h-h2", limit: 2, reviewerId: s.qa } });
  const claim2 = store.claimNext({ employee: s.qb });
  store.settleClaim({ employee: s.qb, claimId: claim2.claim.id, result: Object.assign({}, s.completed("good-h2"), { output: { kind: "workflow-review", reservationId: "r-h2", head: "h-h2", verdict: "approve" } }) });
  let h1 = false;
  try { store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-h2", resultId: "good-h" } }); } catch (e) { h1 = true; console.log("C foreign result rejected=" + String(e.message).slice(0, 140)); }
  console.log("C foreign result PASS=" + h1);
  const okH2 = store.workflowReview({ employee: s.ab, request: { action: "settle", reservationId: "r-h2", resultId: "good-h2" } });
  console.log("C nominal r-h2 settles verdict=" + okH2.verdict + " PASS=" + (okH2.verdict === "approve"));
  store.close(); rmSync(root, { recursive: true, force: true });
}
const wallEnd = new Date().toISOString();
const monoEnd = process.hrtime.bigint().toString();
console.log("wallEnd=" + wallEnd + " monoEnd=" + monoEnd);
console.log("LAYER=public-store-API-only no-coordinator-HTTP native-deployment-gap-owner-lease-local");
console.log("SUPP SMOKE COMPLETE");
