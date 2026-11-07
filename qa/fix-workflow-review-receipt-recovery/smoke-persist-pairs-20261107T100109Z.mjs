import { mkdtempSync, mkdirSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openStore } from "../../extensions/startup/src/store.ts";
function shaFull(s) { return createHash("sha256").update(s).digest("hex"); }
function j(v) { return JSON.stringify(v); }
const wallStart = new Date().toISOString();
const monoStart = process.hrtime.bigint().toString();
console.log("wallStart=" + wallStart + " monoStart=" + monoStart);
console.log("runSourceHead=bc500d85239840b6622e24a28c3d8c75a5b9e706");
const base = "/var/tmp";
const root = realpathSync(mkdtempSync(join(base, "qa-persist-")));
const home = join(root, "home");
const startupRoot = join(home, "startup", "test");
const boundRoot = join(root, "repo");
mkdirSync(home, { recursive: true });
mkdirSync(boundRoot, { recursive: true });
chmodSync(root, 0o700);
chmodSync(home, 0o700);
const scope = { skillsHome: home, startupRoot, boundRoot, host: "host", name: "test", managerSession: "native-manager" };
const owner = { id: "owner", managerGeneration: 1, leaseMs: 1000 };
const store = openStore({ path: join(startupRoot, "staff.sqlite"), scope, owner, now: () => 100 });
function src(role) { return { rolePath: "/skills/jp-startup-role-" + role + "/SKILL.md", roleRevision: "rev", loopPath: "/skills/jp-startup-loop/SKILL.md", loopRevision: "loop-rev" }; }
store.bindEmployee({ manager: store.managerBinding, binding: Object.assign({}, store.managerBinding, { assignment: null, source: src("manager") }) });
const user = { kind: "user", acceptedEventId: "accepted" };
const arch = store.reserveHire({ authority: user, request: { requestId: "pa-arch", role: "architect", additional: 1, revision: "rev" } }).employees.map((e) => e.id)[0];
const qa = store.reserveHire({ authority: user, request: { requestId: "pa-qa", role: "qa", additional: 1, revision: "rev" } }).employees.map((e) => e.id)[0];
const dev = store.reserveHire({ authority: user, request: { requestId: "pa-dev", role: "dev", additional: 1, revision: "rev" } }).employees.map((e) => e.id)[0];
if (!arch || !qa || !dev) throw new Error("missing hire");
store.recordIntake({ manager: store.managerBinding, event: { eventId: "ev-pa", input: "req", amendItemIds: [] } });
const team = store.reserveTeam({ manager: store.managerBinding, request: { eventId: "ev-pa", architect: arch, qa, devs: [dev], cues: [arch, qa, dev].map((r) => ({ id: "as-ev-pa-" + r, recipient: r, kind: "assignment", correlation: "ev-pa", payload: { request: "req" } })) } });
function bindEmp(id, role) { const h = "native-" + id + "-1"; store.bindEmployee({ manager: store.managerBinding, binding: { employeeId: id, generation: 1, nativeHandle: h, source: src(role), assignment: team.id } }); return { employeeId: id, generation: 1, nativeHandle: h }; }
const ab = bindEmp(arch, "architect"); const qb = bindEmp(qa, "qa"); const db = bindEmp(dev, "dev");
function completed(id) { return { id, kind: "completed", output: "done", checkpoint: null, outgoing: [] }; }
store.captureIntake({ architect: ab, capture: { captureId: "cap-ev-pa", eventId: "ev-pa", rows: [{ id: "item1", expectedRevision: null, fields: { request: "Review this change", acceptance: "Acceptance", blocked_on: null, status: "QUEUED" } }], receipt: "captured" } });
for (const b of [ab, qb, db]) { const n = store.claimNext({ employee: b }); if (!n) throw new Error("missing notice"); store.settleClaim({ employee: b, result: completed("notice-" + b.employeeId) }); }
store.workflowReview({ employee: store.managerBinding, request: { action: "reserve", changeId: "item1", reservationId: "r-p1", head: "h-p1", limit: 2, reviewerId: qa } });
const claim = store.claimNext({ employee: qb });
if (!claim) throw new Error("missing review assignment");
const out = { kind: "workflow-review", reservationId: "r-p1", head: "h-p1", verdict: "changes-requested", detail: "extra report metadata", evidence: { lines: 3 } };
store.settleClaim({ employee: qb, result: { id: "receipt-p1", kind: "completed", output: out, checkpoint: null, outgoing: [] } });
function sel() {
  const snap = store.snapshot();
  const res = snap.results.find((r) => r.result.id === "receipt-p1");
  const cl = snap.claims.find((c) => c.id === claim.claim.id);
  const msg = snap.messages.find((m) => m.id === claim.message.id);
  if (!res || !cl || !msg) throw new Error("missing stored records");
  return { res, cl, msg };
}
const before = sel();
const bRes = j(before.res); const bCl = j(before.cl); const bMsg = j(before.msg);
const bResH = shaFull(bRes); const bClH = shaFull(bCl); const bMsgH = shaFull(bMsg);
console.log("BEFORE result sha256=" + bResH);
console.log("BEFORE claim sha256=" + bClH);
console.log("BEFORE message sha256=" + bMsgH);
console.log("BEFORE result=" + bRes);
console.log("BEFORE claim=" + bCl);
console.log("BEFORE message=" + bMsg);
const settled = store.workflowReview({ employee: ab, request: { action: "settle", reservationId: "r-p1", resultId: "receipt-p1" } });
console.log("FINALIZE verdict=" + settled.verdict + " resultId=" + settled.resultId + " reservation=" + settled.reservationId);
const after = sel();
const aRes = j(after.res); const aCl = j(after.cl); const aMsg = j(after.msg);
const aResH = shaFull(aRes); const aClH = shaFull(aCl); const aMsgH = shaFull(aMsg);
console.log("AFTER result sha256=" + aResH);
console.log("AFTER claim sha256=" + aClH);
console.log("AFTER message sha256=" + aMsgH);
console.log("AFTER result=" + aRes);
console.log("AFTER claim=" + aCl);
console.log("AFTER message=" + aMsg);
const eqRes = bRes === aRes; const eqCl = bCl === aCl; const eqMsg = bMsg === aMsg;
console.log("PAIR result byteEqual=" + eqRes + " hashEqual=" + (bResH === aResH));
console.log("PAIR claim byteEqual=" + eqCl + " hashEqual=" + (bClH === aClH));
console.log("PAIR message byteEqual=" + eqMsg + " hashEqual=" + (bMsgH === aMsgH));
const outAfter = after.res.result.output;
console.log("PRESERVE ids/result=" + after.res.result.id + " claim=" + after.cl.id + " message=" + after.msg.id + " actor=" + after.cl.employeeId + " gen=" + after.cl.generation + " resv=" + String(outAfter["reservationId"]) + " head=" + String(outAfter["head"]) + " verdict=" + String(outAfter["verdict"]) + " detail=" + String(outAfter["detail"]) + " evidence=" + j(outAfter["evidence"]));
let replayOk = false;
try {
  const r = store.settleClaim({ employee: qb, result: { id: "receipt-p1", kind: "completed", output: out, checkpoint: null, outgoing: [] } });
  replayOk = true;
  console.log("REPLAY exact same id+payload returned saved claimId=" + r.claimId);
  const afterReplay = sel();
  const arRes = j(afterReplay.res);
  console.log("REPLAY stored result unchanged=" + (arRes === aRes) + " sha=" + shaFull(arRes));
} catch (e) { console.log("REPLAY rejected=" + String(e).slice(0, 400)); }
let changedRejected = false;
try {
  store.settleClaim({ employee: qb, result: { id: "receipt-p1", kind: "completed", output: Object.assign({}, out, { verdict: "approve" }), checkpoint: null, outgoing: [] } });
} catch (e) { changedRejected = true; console.log("CHANGED-PAYLOAD reuse rejected=" + e.constructor.name + ":" + String(e.message).slice(0, 300) + " recovery=" + j(e.recovery)); }
console.log("CHANGED-PAYLOAD rejected=" + changedRejected);
const afterChanged = sel();
console.log("AFTER-CHANGED result unchanged=" + (j(afterChanged.res) === aRes) + " sha=" + shaFull(j(afterChanged.res)));
let newIdRejected = false;
try {
  store.settleClaim({ employee: qb, claimId: claim.claim.id, result: { id: "receipt-p1-new", kind: "completed", output: out, checkpoint: null, outgoing: [] } });
} catch (e) { newIdRejected = true; console.log("NEW-ID on settled claim rejected=" + e.constructor.name + ":" + String(e.message).slice(0, 300) + " recovery=" + j(e.recovery)); }
console.log("NEW-ID rejected=" + newIdRejected);
const afterNewId = sel();
console.log("AFTER-NEWID result unchanged=" + (j(afterNewId.res) === aRes) + " claim unchanged=" + (j(afterNewId.cl) === aCl) + " message unchanged=" + (j(afterNewId.msg) === aMsg));
const wallEnd = new Date().toISOString();
const monoEnd = process.hrtime.bigint().toString();
console.log("wallEnd=" + wallEnd + " monoEnd=" + monoEnd);
console.log("LAYER=public-store-API-only snapshot-results-claims-messages no-coordinator-HTTP");
console.log("PAIR SMOKE COMPLETE pairEqual=" + (eqRes && eqCl && eqMsg) + " replayOk=" + replayOk + " changedRejected=" + changedRejected + " newIdRejected=" + newIdRejected);
store.close(); rmSync(root, { recursive: true, force: true });
