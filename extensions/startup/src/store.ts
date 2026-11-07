import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { hostAssociationQuerySchema, hostAssociationPageSchema, nativeRootSchema, type NativeRoot, type HostAssociationPage, type HostAssociationRow, runtimeConnectionSchema, runtimeIdentitySchema, type RuntimeIdentity, effectiveRoleSettingsSchema, requestedRoleSettingsSchema, roleSettingsInputSchema, roleSettingsProvenanceSchema, runtimeAbandonmentSchema, runtimeBindingSchema, runtimeCapabilitySchema, runtimeHarnessSchema, savedRoleSettingsSchema, type EffectiveRoleSettings, type RequestedRoleSettings, type RuntimeAbandonment, type RuntimeBinding, type RuntimeCapability, type SavedRoleSettings } from "./runtime-contracts";
import { assertStartupPath, contains, ensureStartupRoot } from "./boot";
import { validateRoleSettings } from "./profiles";
import {
  ownerControlRequestSchema, ownerControlReceiptSchema, type OwnerControlRequest, type OwnerControlReceipt,
  authoritySchema,
  bindingSchema,
  bindSchema,
  captureSchema,
  claimSchema,
  cueSchema,
  dutySchema,
  employeeSchema,
  encode,
  grantSchema,
  hireSchema,
  HOST_LINK_CAP,
  HOST_PAGE_MAX,
  HOST_PREVIEW_CHARS,
  hostAdmitReceiptSchema,
  hostAdmitRequestSchema,
  hostCancelReceiptSchema,
  hostCancelRequestSchema,
  hostClaimSlotSchema,
  hostImageSchema,
  hostQueuePageSchema,
  hostModeSchema,
  hostReceiptSchema,
  idSchema,
  intakeSchema,
  jsonSchema,
  messageSchema,
  ownerSchema,
  resultSchema,
  roleSchema,
  rowSchema,
  scopeSchema,
  sourceSchema,
  teamRequestSchema,
  teamSchema,
  timeSchema,
  StoreAuthorityError,
  StoreConflictError,
  StoreFenceError,
  ClaimSettlementError,
  type SettlementRecovery,
  StoreRecoveryError,
  type Authority,
  type Bind,
  type Binding,
  type Capture,
  type Claim,
  type Cue,
  type Duty,
  type Employee,
  type Grant,
  type Hire,
  type HostAdmitRequest,
  type HostCancelRequest,
  type HostReceipt,
  type HostStatusQuery,
  type Intake,
  type Json,
  type Message,
  type Owner,
  type Result,
  type Scope,
  type Source,
  type Team,
  type TeamRequest,
} from "./contracts";
import {
  legacyLockSchema,
  projectResources,
  readLegacyLocks,
  resourceDocumentSchema,
  sameDocument,
  type LegacyLock,
  type ResourceDocument,
} from "./resources";

import {
  itemActionSchema,
  itemExecutionSchema,
  itemTransitionSchema,
  terminalItemStatuses,
  type ItemAction,
  type ItemExecution,
  type ItemTransition,
} from "./items";
import { dispatchWorkflow, executeWorkflow, type WorkflowRequest, type WorkflowView } from "./workflow-engine";
import type { WorkflowBridgeAuthority, WorkflowRoleAssignment, WorkflowRunHandoff } from "./workflow-bridge";
type WorkflowRoleReceipt = Parameters<NonNullable<WorkflowBridgeAuthority["settleRole"]>>[2];
// Historical-envelope consumer: intentionally non-strict projection of the four core receipt fields. Producers stay strict; the saved immutable result is never rewritten.
const workflowReviewReceiptSchema = z
  .object({
    kind: z.literal("workflow-review"),
    reservationId: idSchema,
    head: z.string().trim().min(1),
    verdict: z.enum(["approve", "changes-requested", "block"]),
  })
  .readonly();
const workflowReviewSchema = z.strictObject({
  changeId: idSchema, reservationId: idSchema, head: z.string().trim().min(1),
  reviewerId: idSchema, messageId: idSchema, limit: z.number().int().min(1).max(3),
  state: z.enum(["active", "completed", "uncertain"]),
  verdict: z.enum(["approve", "changes-requested", "block"]).nullable(),
  resultId: idSchema.nullable(),
}).readonly();
const workflowScopeSchema = z.strictObject({
  id: idSchema, parentId: idSchema.nullable(), itemId: idSchema, claimId: idSchema,
  employeeId: idSchema, generation: timeSchema, ownerEpoch: timeSchema,
  workflow: z.enum(["factory", "pipeline", "hotfix"]), limit: z.number().int().min(1).max(3),
}).readonly();
const workflowFactoryScopeSchema = z.strictObject({
  id: idSchema, parentId: idSchema.nullable(), managerId: idSchema, generation: timeSchema, ownerEpoch: timeSchema,
  workflow: z.enum(["factory", "pipeline", "hotfix"]), limit: z.number().int().min(1).max(3),
  items: z.array(z.strictObject({ itemId: idSchema, claimId: idSchema, employeeId: idSchema, generation: timeSchema, teamId: idSchema, limit: z.number().int().min(1).max(3) })).min(1),
}).readonly();
const workflowPlanSchema = z.strictObject({
  reservationId: idSchema, state: z.enum(["active", "completed", "failed", "uncertain"]),
  frozen: z.boolean(), dependencies: z.record(idSchema, z.array(idSchema)), targets: z.record(idSchema, z.array(idSchema)),
}).readonly();
const workflowReadySchema = z.strictObject({
  itemId: idSchema, worktree: z.string().startsWith("/"), head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), prNumber: z.number().int().positive().safe(),
}).readonly();
const workflowChildSchema = z.strictObject({
  id: idSchema, scopeId: idSchema, claimId: idSchema, itemId: idSchema,
  assignmentKey: idSchema, state: z.enum(["active", "completed", "failed", "uncertain"]),
  role: z.strictObject({ kind: z.enum(["architect", "dev", "qa"]), worktree: z.string().startsWith("/") }).optional(),
  proof: z.strictObject({ itemId: idSchema, role: z.enum(["architect", "dev", "qa"]), agentId: idSchema, head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), evidence: z.record(z.string().min(1), z.string().min(1)) }).optional(),
  roleEvidence: z.literal("invalid").optional(),
}).readonly();
const workflowLaunchSchema = z.strictObject({
  launchKey: idSchema, scopeId: idSchema, claimId: idSchema, employeeId: idSchema,
  generation: timeSchema, ownerEpoch: timeSchema,
  state: z.enum(["starting", "accepted", "uncertain", "closed"]), location: jsonSchema.nullable(),
  handoff: z.strictObject({ items: z.array(z.strictObject({ itemId: idSchema, worktree: z.string().startsWith("/"), head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), prNumber: z.number().int().positive().safe() })).min(1) }).optional(),
}).readonly();
function requireWorkflowHandoff(children: readonly z.infer<typeof workflowChildSchema>[], workflow: "factory" | "pipeline" | "hotfix", handoff: WorkflowRunHandoff["items"][number]): void {
  if (children.some((child) => child.state === "active" || child.state === "uncertain"))
    throw new StoreRecoveryError("Handoff has active or uncertain child effects");
  const proof = (role: "architect" | "dev" | "qa") => children.find((child) =>
    child.state === "completed" && child.role?.kind === role && child.role.worktree === handoff.worktree &&
    child.proof?.role === role && child.proof.head === handoff.head)?.proof;
  const dev = proof("dev");
  const architect = proof("architect");
  const qa = proof("qa");
  if (!dev || (workflow !== "hotfix" && (!architect || !qa || new Set([dev.agentId, architect.agentId, qa.agentId]).size !== 3)))
    throw new StoreAuthorityError("Handoff requires distinct correlated role proofs for the exact worktree and head");
}
const managerRunSchema = z.strictObject({
  launchKey: idSchema, itemId: idSchema, eventId: idSchema, revision: timeSchema,
  workflow: z.enum(["pipeline", "hotfix"]), limit: z.number().int().min(1).max(2),
  target: z.string().trim().min(1).max(512), branch: z.string().trim().min(1).max(512).optional(), repository: z.string().refine(isAbsolute), worktree: z.string().refine(isAbsolute),
  assignment: rowSchema, ownerEpoch: timeSchema,
  state: z.enum(["starting", "accepted", "reported", "failed", "uncertain", "completed", "released"]),
  location: jsonSchema.nullable(), outcome: jsonSchema.nullable(),
  completion: z.unknown().optional(),
  termination: z.unknown().optional(),
}).readonly();
export type ManagerRun = z.infer<typeof managerRunSchema>;
const managerInputSchema = z.strictObject({
  launchKey: idSchema, messageId: idSchema, textDigest: z.string().regex(/^[0-9a-f]{64}$/), ownerEpoch: timeSchema,
  state: z.enum(["sending", "delivered", "uncertain"]),
}).readonly();
export type ManagerInput = z.infer<typeof managerInputSchema>;
const managerCompletionSchema = z.strictObject({
  launchKey: idSchema, itemId: idSchema, location: jsonSchema,
  repository: z.string().refine(isAbsolute), worktree: z.string().refine(isAbsolute),
  target: z.string().trim().min(1), head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  prNumber: z.number().int().positive().safe(),
  prState: z.enum(["OPEN", "MERGED"]), prDraft: z.boolean(),
  mergeCommit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).nullable(),
  review: z.strictObject({ reviewId: idSchema, reviewerId: idSchema, invocationId: idSchema, head: z.string(), verdict: z.literal("approve"), rounds: z.number().int().positive().safe() }),
}).readonly();
export type ManagerCompletion = z.infer<typeof managerCompletionSchema>;
const managerReviewSchema = z.strictObject({
  reviewId: idSchema, launchKey: idSchema, itemId: idSchema,
  head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  reviewerId: idSchema.nullable(), invocationId: idSchema.nullable(), state: z.enum(["active", "completed", "uncertain", "failed", "cancelled"]),
  verdict: z.enum(["approve", "changes-requested", "block"]).nullable(), resolution: z.unknown().optional(),
}).readonly();
export type ManagerReview = z.infer<typeof managerReviewSchema>;
const managerReviewEvidenceSchema = z.strictObject({
  reviewId: idSchema, launchKey: idSchema, head: z.string(),
  reviewerId: idSchema, invocationId: idSchema, verdict: z.enum(["approve", "changes-requested", "block"]),
}).readonly();
const managerTerminationSchema = z.strictObject({
  launchKey: idSchema, itemId: idSchema, location: jsonSchema,
  status: z.literal("terminated"), evidence: z.string().trim().min(1), outcome: z.literal("failed-no-effect").optional(),
}).readonly();
export type ManagerTermination = z.infer<typeof managerTerminationSchema>;
const managerItemSchema = z.strictObject({
  itemId: idSchema, eventId: idSchema, revision: timeSchema, teamId: idSchema, migrationId: idSchema,
}).readonly();
const managerMigrationSchema = z.strictObject({
  migrationId: idSchema, migrated: z.array(idSchema), alreadyManaged: z.array(idSchema),
  blocked: z.array(z.strictObject({ itemId: idSchema, reason: z.string().min(1) })),
}).readonly();
const workflowRunClaimSchema = z.strictObject({ launchKey: idSchema, claimId: idSchema }).readonly();
const storedSchema = z.strictObject({ payload: z.string() });
type QueueDocument = Readonly<{ before: string | null; rows: readonly z.infer<typeof rowSchema>[] }> & (
  Readonly<{ container: null; key: null }> |
  Readonly<{ container: Readonly<Record<string, Json>>; key: "items" | "rows" }>
);
const leaseSchema = z.strictObject({
  token: z.string(),
  epoch: timeSchema,
  generation: timeSchema,
  expires: timeSchema,
});
const hireRecordSchema = z
  .strictObject({ request: hireSchema, ids: z.array(idSchema).readonly() })
  .readonly();
const intakeRecordSchema = z
  .strictObject({ request: intakeSchema, teamId: idSchema.nullable() })
  .readonly();
const inputDispositionSchema = z
  .strictObject({
    kind: z.enum(["work", "status", "control", "conversation", "decision"]),
    reason: z.string().trim().min(1),
    amendItemIds: z.array(idSchema),
  })
  .readonly();
const teamRequirementSchema = z
  .strictObject({
    eventId: idSchema,
    developers: z.number().int().positive().safe(),
  })
  .readonly();
const nativeReceivedInputSchema = z.strictObject({
  kind: z.literal("native"),
  id: idSchema,
  receivedAt: timeSchema,
  source: z.enum(["interactive", "rpc"]),
  raw: z.strictObject({ text: z.string(), images: z.array(jsonSchema) }),
  disposition: inputDispositionSchema.nullable(),
}).readonly();
const hostReceivedInputSchema = z.strictObject({
  kind: z.literal("host"),
  id: idSchema,
  receivedAt: timeSchema,
  source: z.literal("host"),
  origin: z.string().min(1).max(512),
  mode: hostModeSchema,
  raw: z.strictObject({ text: z.string(), images: z.array(hostImageSchema) }),
  disposition: inputDispositionSchema.nullable(),
  hold: z.strictObject({ kind: z.literal("cancelled"), intentId: idSchema, at: timeSchema }).nullable(),
}).readonly();
const receivedInputSchema = z.preprocess((value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.hasOwn(value, "kind")) return value;
  return { ...value, kind: "native" };
}, z.discriminatedUnion("kind", [nativeReceivedInputSchema, hostReceivedInputSchema]));
const hostHoldSchema = z.strictObject({ targetId: idSchema, intentId: idSchema, at: timeSchema }).readonly();
const hostCancelFinalizeSchema = z.strictObject({
  itemId: idSchema,
  eventId: idSchema,
  teamId: idSchema,
  revision: timeSchema,
}).readonly();
const openInputSql = "json_extract(payload,'$.disposition') IS NULL AND NOT EXISTS (SELECT 1 FROM records AS host_hold WHERE host_hold.kind='hostHold' AND host_hold.id=records.id)";
export type ReceivedInput = z.infer<typeof receivedInputSchema>;
const resultRecordSchema = z
  .strictObject({
    claimId: idSchema,
    result: resultSchema,
    messages: z.array(messageSchema).readonly(),
  })
  .readonly();
const captureRecordSchema = z
  .strictObject({
    request: captureSchema,
    teamId: idSchema.nullable(),
    items: teamSchema.unwrap().shape.items,
  })
  .readonly();
const writeIntentSchema = z
  .strictObject({
    file: z.enum(["queue.json", "resources.json"]),
    before: z.string().nullable(),
    after: z.string(),
    state: z.enum(["pending", "complete"]),
    capture: captureRecordSchema.nullable(),
    managerCompletion: z.strictObject({
      original: managerRunSchema, evidence: managerCompletionSchema,
      revision: timeSchema, status: z.enum(["MERGED", "READY_TO_LAND"]),
    }).optional(),
    item: itemTransitionSchema.optional(),
    hostCancel: hostCancelFinalizeSchema.optional(),
  })
  .readonly();
const occurrenceSchema = z
  .strictObject({
    id: idSchema,
    dutyId: idSchema,
    employeeId: idSchema,
    scheduledFor: timeSchema,
    claimedAt: timeSchema,
    observation: jsonSchema,
    observedAt: timeSchema.nullable(),
    generation: timeSchema,
    ownerEpoch: timeSchema,
  })
  .readonly();
const queueOwnerSchema = z
  .strictObject({ id: idSchema, eventId: idSchema, revision: timeSchema })
  .readonly();
const itemProgressSchema = z.strictObject({
  itemId: idSchema,
  revision: timeSchema,
  status: z.string().min(1),
  changedAt: timeSchema,
}).readonly();
export type ItemProgress = z.infer<typeof itemProgressSchema>;
const assignmentSchema = z
  .strictObject({
    id: idSchema,
    employeeId: idSchema,
    state: z.enum(["pending", "waiting", "reconciliation", "complete"]),
  })
  .readonly();
const authorizationSchema = z
  .strictObject({
    id: idSchema,
    employeeId: idSchema,
    target: idSchema,
    authority: jsonSchema,
  })
  .readonly();
export type HireReceipt = Readonly<{
  requestId: string;
  requested: number;
  reserved: number;
  ready: number;
  starting: number;
  failed: number;
  retired: number;
  employees: readonly Employee[];
}>;
export type Settlement = z.infer<typeof resultRecordSchema>;
export type Occurrence = z.infer<typeof occurrenceSchema>;
export type CaptureReceipt = z.infer<typeof captureRecordSchema>;
export type HireRecord = z.infer<typeof hireRecordSchema>;
export type IntakeRecord = z.infer<typeof intakeRecordSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type TargetAuthorization = z.infer<typeof authorizationSchema>;
export type QueueRevision = z.infer<typeof queueOwnerSchema>;
export type Snapshot = Readonly<{
  ownerEpoch: number;
  employees: readonly Employee[];
  hires: readonly HireRecord[];
  captures: readonly CaptureReceipt[];
  queueRevisions: readonly QueueRevision[];
  authorizations: readonly TargetAuthorization[];
  teams: readonly Team[];
  itemExecutions: readonly ItemExecution[];
  itemTransitions: readonly ItemTransition[];
  messages: readonly Message[];
  claims: readonly Claim[];
  results: readonly Settlement[];
  duties: readonly Duty[];
  dutySchedules: readonly Readonly<{ id: string; nextDue: number | null }>[];
  occurrences: readonly Occurrence[];
  grants: readonly Grant[];
  legacyLocks: readonly LegacyLock[];
  teamRequirements: readonly z.infer<typeof teamRequirementSchema>[];
  intakes: readonly IntakeRecord[];
  inputs: readonly ReceivedInput[];
  assignments: readonly Assignment[];
}>;

// This connector is host-only. The adapter supplies scope, authority and bindings from native evidence.
const supervisionAlertSchema = z.object({
  kind: z.string(), employeeId: z.string().optional(), observedAt: z.number().optional(),
  lastProgress: z.number().optional(), itemId: z.string().optional(), revision: z.number().optional(),
  inputId: z.string().optional(), claimId: z.string().nullable().optional(), herdrObserved: z.boolean().nullable().optional(),
});

export function openStore(args: {
  readonly path: string;
  readonly scope: Scope;
  readonly owner: Owner;
  readonly now: () => number;
  readonly expectedControl?: Readonly<{ ownerEpoch: number; revision: number }>;
}) {
  const scope: Scope = scopeSchema.parse(args.scope);
  const owner: Owner = ownerSchema.parse(args.owner);
  const startupRoot: string = ensureStartupRoot(scope.startupRoot);
  const stateDirectory: string = startupRoot;
  const expected: string = join(startupRoot, "staff.sqlite");
  const skillsHome: string = resolve(scope.skillsHome);
  const boundRootPath: string = resolve(scope.boundRoot);
  if (
    !isAbsolute(scope.skillsHome) ||
    skillsHome !== scope.skillsHome ||
    !isAbsolute(scope.boundRoot) ||
    boundRootPath !== scope.boundRoot ||
    resolve(args.path) !== expected
  )
    throw new StoreAuthorityError(
      "Store path must be <startupRoot>/staff.sqlite with canonical scope roots",
    );
  if (realpathSync(scope.skillsHome) !== scope.skillsHome || realpathSync(scope.boundRoot) !== scope.boundRoot)
    throw new StoreAuthorityError("Startup scope roots must be canonical directories");
  if (contains(startupRoot, skillsHome) || contains(startupRoot, boundRootPath) || contains(boundRootPath, startupRoot))
    throw new StoreAuthorityError(
      "Startup state may not contain JP_SKILLS_HOME and must stay outside the bound repository",
    );
  for (const path of [expected, `${expected}-wal`, `${expected}-shm`, `${expected}-journal`]) {
    assertStartupPath(startupRoot, path, "file");
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new StoreAuthorityError(`SQLite file may not be foreign or symlinked: ${path}`);
    }
  }
  const db: Database = new Database(expected, { create: true, strict: true });
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, epoch INTEGER NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL);",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS records_message_recipient_status ON records(json_extract(payload,'$.recipient'),json_extract(payload,'$.status')) WHERE kind='message';
    CREATE INDEX IF NOT EXISTS records_message_delivery ON records(json_extract(payload,'$.recipient'),json_extract(payload,'$.status'),json_extract(payload,'$.kind'),json_extract(payload,'$.sender')) WHERE kind='message';
    CREATE INDEX IF NOT EXISTS records_claim_employee_status ON records(json_extract(payload,'$.employeeId'),json_extract(payload,'$.status')) WHERE kind='claim';
    CREATE INDEX IF NOT EXISTS records_claim_message ON records(json_extract(payload,'$.messageId')) WHERE kind='claim';
    CREATE INDEX IF NOT EXISTS records_workflow_review_change ON records(json_extract(payload,'$.changeId')) WHERE kind='workflowReview';
    CREATE INDEX IF NOT EXISTS records_workflow_child_claim ON records(json_extract(payload,'$.claimId')) WHERE kind='workflowChild';
    CREATE INDEX IF NOT EXISTS records_workflow_launch_employee ON records(json_extract(payload,'$.employeeId'),json_extract(payload,'$.generation')) WHERE kind='workflowLaunch';
    CREATE INDEX IF NOT EXISTS records_workflow_run_claim ON records(json_extract(payload,'$.claimId')) WHERE kind='workflowRunClaim';
    CREATE INDEX IF NOT EXISTS records_grant_employee_state ON records(json_extract(payload,'$.employeeId'),json_extract(payload,'$.state')) WHERE kind='grant';
    CREATE INDEX IF NOT EXISTS records_item_execution_employee_generation ON records(json_extract(payload,'$.employeeId'),json_extract(payload,'$.generation')) WHERE kind='itemExecution';
    CREATE INDEX IF NOT EXISTS records_result_claim ON records(json_extract(payload,'$.claimId')) WHERE kind='result';
    CREATE INDEX IF NOT EXISTS records_runtime_employee_generation ON records(json_extract(payload,'$.employeeId'),json_extract(payload,'$.generation')) WHERE kind='runtimeBinding';
  `);
  const token: string = randomUUID();
  let closed: boolean = false;
  function now(): number {
    return timeSchema.parse(args.now());
  }
  function read<T>(kind: string, id: string, schema: z.ZodType<T>): T | null {
    const row: unknown = db
      .query("SELECT payload FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row === null
      ? null
      : schema.parse(JSON.parse(storedSchema.parse(row).payload));
  }
  function all<T>(kind: string, schema: z.ZodType<T>): readonly T[] {
    return db
      .query("SELECT payload FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map(
        (row: unknown): T =>
          schema.parse(JSON.parse(storedSchema.parse(row).payload)),
      );
  }
  function selected<T>(sql: string, params: readonly (string | number)[], schema: z.ZodType<T>): readonly T[] {
    return db.query(sql).all(...params).map((row: unknown): T => schema.parse(JSON.parse(storedSchema.parse(row).payload)));
  }
  function pendingInbox(current: Employee): Readonly<{ messages: readonly Message[]; deferredMessageCount: number; latestPaReport: Message | null }> {
    const where = "kind='message' AND json_extract(payload,'$.recipient')=? AND json_extract(payload,'$.status')='pending'";
    if (current.role !== "manager") return { messages: selected(`SELECT payload FROM records WHERE ${where} ORDER BY rowid`, [current.id], messageSchema), deferredMessageCount: 0, latestPaReport: null };
    const paReport = "(json_extract(payload,'$.kind')='report' AND json_extract(payload,'$.sender') IN (SELECT id FROM records WHERE kind='employee' AND json_extract(payload,'$.role')='pa'))";
    const pending = selected(`SELECT payload FROM records WHERE ${where} AND NOT COALESCE(${paReport}, 0) ORDER BY rowid`, [current.id], messageSchema);
    const count = z.object({ count: z.number().int().nonnegative() }).parse(db.query(`SELECT count(*) AS count FROM records WHERE ${where} AND ${paReport}`).get(current.id)).count;
    const latestPaReport = selected(`SELECT payload FROM records WHERE ${where} AND ${paReport} ORDER BY rowid DESC LIMIT 1`, [current.id], messageSchema)[0] ?? null;
    const runtimes = new Map<string, RuntimeBinding | null>();
    function runtimeFor(id: string): RuntimeBinding | null {
      if (!runtimes.has(id)) {
        const member = read("employee", id, employeeSchema);
        runtimes.set(id, member === null ? null : read("runtimeBinding", `${id}/${member.generation}`, runtimeBindingSchema));
      }
      return runtimes.get(id) ?? null;
    }
    function priority(message: Message): 0 | 1 | 2 | null {
      if (message.sender !== "manager") return message.kind === "alert" || message.kind === "question" ? 0 : 1;
      const parsed = supervisionAlertSchema.safeParse(message.payload);
      if (!parsed.success) return 2;
      const data = parsed.data;
      if (data.kind === "runtime-observation") return null;
      if (["boot-failed", "launch-uncertain", "layout-uncertain", "launch-stalled"].includes(data.kind)) {
        const runtime = data.employeeId === undefined ? null : runtimeFor(data.employeeId);
        return runtime?.state === "ready" && runtime.error === null ? null : 0;
      }
      const presenceId = data.kind === "manager-offline" ? "manager" : data.employeeId;
      if (["employee-offline", "manager-offline", "observation-gap"].includes(data.kind) && presenceId !== undefined && data.observedAt !== undefined) {
        const member = read("employee", presenceId, employeeSchema);
        const runtime = runtimeFor(presenceId);
        const recoveredAt = runtime === null ? 0 : data.kind === "manager-offline"
          ? data.herdrObserved === true ? runtime.lastPoll : Math.min(runtime.lastSeen, runtime.lastPoll)
          : data.kind === "observation-gap" ? runtime.lastSeen : runtime.lastPoll;
        if (member?.employment === "retired" || (runtime !== null && runtime.error === null && recoveredAt > data.observedAt)) return null;
        return data.kind === "observation-gap" ? 2 : 0;
      }
      if (data.kind === "stale-progress" && data.employeeId !== undefined && data.lastProgress !== undefined) {
        const runtime = runtimeFor(data.employeeId);
        if (runtime !== null && runtime.lastProgress > data.lastProgress) return null;
      }
      if (data.kind === "stale-item" && data.itemId !== undefined && data.revision !== undefined) {
        const owner = read("queueOwner", data.itemId, queueOwnerSchema);
        if (owner !== null && owner.revision !== data.revision) return null;
      }
      if (data.kind === "stale-input" && data.inputId !== undefined) {
        const input = read("receivedInput", data.inputId, receivedInputSchema);
        if (input !== null && input.disposition !== null) return null;
      }
      if (data.kind === "settlement-blocked" && data.claimId !== undefined && data.claimId !== null) {
        const claim = read("claim", data.claimId, claimSchema);
        if (claim?.status === "settled") return null;
      }
      return 2;
    }
    const ranked: { message: Message; priority: 0 | 1 | 2 }[] = [];
    let deferredMessageCount = count;
    for (const message of pending) {
      const rank = priority(message);
      if (rank === null) deferredMessageCount += 1;
      else ranked.push({ message, priority: rank });
    }
    return {
      messages: ranked.sort((a, b) => a.priority - b.priority || a.message.sequence - b.message.sequence).map((entry) => entry.message),
      deferredMessageCount,
      latestPaReport,
    };
  }
  function employeeView(employeeId: string) {
    const current = employee(employeeId);
    let itemReview: { itemId: string; resultId: string; revision: number } | null = null;
    if (current.role === "dev") {
      for (const execution of selected("SELECT payload FROM records WHERE kind='itemExecution' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.generation')=?", [current.id, current.generation], itemExecutionSchema)) {
        if (execution.reviewResultId !== null) continue;
        const ownership = read("queueOwner", execution.itemId, queueOwnerSchema);
        const assigned = read("itemTransition", execution.attemptId, itemTransitionSchema);
        if (ownership === null || assigned?.revision !== ownership.revision || assigned.status !== "EXECUTING") continue;
        const claim = selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status')='settled' AND json_extract(payload,'$.messageId')=?", [current.id, execution.messageId], claimSchema)[0];
        if (claim === undefined || claim.generation !== current.generation) continue;
        const result = selected("SELECT payload FROM records WHERE kind='result' AND json_extract(payload,'$.claimId')=?", [claim.id], resultRecordSchema)[0];
        if (result?.result.kind !== "completed") continue;
        itemReview = { itemId: execution.itemId, resultId: result.result.id, revision: ownership.revision };
        break;
      }
    }
    const inbox = pendingInbox(current);
    return {
      itemReview,
      deferredMessageCount: inbox.deferredMessageCount,
      latestPaReport: inbox.latestPaReport,
      team: current.assignment === null ? null : team(current.assignment),
      messages: inbox.messages,
      claims: selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status') IN ('active','reconciliation') ORDER BY rowid", [current.id], claimSchema),
      grants: selected("SELECT payload FROM records WHERE kind='grant' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.state')='reconciliation' ORDER BY rowid", [current.id], grantSchema),
    };
  }
  function put(kind: string, id: string, payload: unknown): void {
    const body: string = encode(payload);
    db.query(
      "INSERT INTO records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
    ).run(kind, id, body);
    db.query("INSERT INTO audit(kind,id,payload) VALUES(?,?,?)").run(
      kind,
      id,
      body,
    );
  }
  let epoch: number;
  try {
    epoch = db
      .transaction((): number => {
        const saved: Scope | null = read("meta", "scope", scopeSchema);
        if (saved !== null && !sameDocument(saved, scope))
          throw new StoreAuthorityError(
            "Database belongs to a different host, Startup, bound root or manager session",
          );
        if (read("controlArchive", "startup", jsonSchema) !== null) throw new StoreAuthorityError("Startup is archived; history is retained and launch is refused");
        const previous: unknown = db
          .query(
            "SELECT token,epoch,generation,expires FROM lease WHERE singleton=1",
          )
          .get();
        const lease = previous === null ? null : leaseSchema.parse(previous);
        if (args.expectedControl !== undefined && (args.expectedControl.ownerEpoch !== (lease?.epoch ?? 0) || args.expectedControl.revision !== controlRevision(db))) throw new StoreFenceError("Manager preparation snapshot changed before owner acquisition");
        const timestamp: number = now();
        if (lease !== null && lease.expires > timestamp)
          throw new StoreFenceError(
            "A live runtime owner already holds this Startup lease",
          );
        const next: number = timeSchema.parse((lease?.epoch ?? 0) + 1);
        if (lease !== null && owner.managerGeneration < lease.generation)
          throw new StoreFenceError("Manager native generation is stale");
        db.query(
          "INSERT INTO lease VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,epoch=excluded.epoch,generation=excluded.generation,expires=excluded.expires",
        ).run(
          token,
          next,
          owner.managerGeneration,
          timeSchema.parse(timestamp + owner.leaseMs),
        );
        if (saved === null) put("meta", "scope", scope);
        put("owner", String(next), {
          ...owner,
          epoch: next,
          acquiredAt: timestamp,
        });
        const manager: Employee | null = read(
          "employee",
          "manager",
          employeeSchema,
        );
        if (
          manager !== null &&
          manager.error !== null &&
          read("managerFailure", "manager", employeeSchema) === null
        )
          put("managerFailure", "manager", manager);
        if (manager === null)
          put(
            "employee",
            "manager",
            employeeSchema.parse({
              id: "manager",
              role: "manager",
              employment: "hired",
              generation: owner.managerGeneration,
              nativeHandle: scope.managerSession,
              source: null,
              assignment: null,
              canonicalRevision: null,
              checkpoint: null,
              error: null,
            }),
          );
        else if (manager.generation !== owner.managerGeneration)
          put("employee", "manager", {
            ...manager,
            generation: owner.managerGeneration,
            source: null,
          });
        for (const claim of all("claim", claimSchema).filter(
          (entry): boolean => entry.status === "active",
        ))
          put("claim", claim.id, { ...claim, status: "reconciliation" });
        for (const child of selected("SELECT payload FROM records WHERE kind='workflowChild' AND json_extract(payload,'$.state')='active'", [], workflowChildSchema))
          put("workflowChild", child.id, { ...child, state: "uncertain" });
        for (const launch of selected("SELECT payload FROM records WHERE kind='workflowLaunch' AND json_extract(payload,'$.state') IN ('starting','accepted')", [], workflowLaunchSchema)) {
          put("workflowLaunch", launch.launchKey, { ...launch, state: "uncertain" });
          const plan = read("workflowPlan", launch.scopeId, workflowPlanSchema);
          if (plan?.state === "active") put("workflowPlan", launch.scopeId, { ...plan, state: "uncertain" });
        }
        for (const run of all("managerRun", managerRunSchema)) {
          if (run.state === "starting" || run.state === "accepted" || run.state === "reported") put("managerRun", run.launchKey, { ...run, state: "uncertain" });
        }
        for (const entry of all("managerInput", managerInputSchema)) {
          if (entry.state === "sending") put("managerInput", createHash("sha256").update(JSON.stringify([entry.launchKey, entry.messageId])).digest("hex"), { ...entry, state: "uncertain" });
        }
        for (const review of all("managerReview", managerReviewSchema)) {
          if (review.state === "active") put("managerReview", review.reviewId, { ...review, state: "uncertain" });
        }
        for (const grant of all("grant", grantSchema).filter(
          (entry): boolean => entry.state === "held",
        ))
          put("grant", grant.id, { ...grant, state: "reconciliation" });
        return next;
      })
      .immediate();
  } catch (error: unknown) {
    db.close();
    throw error;
  }
  function fence(): void {
    if (closed) throw new StoreFenceError("Store connection is closed");
    const lease = leaseSchema.parse(
      db
        .query(
          "SELECT token,epoch,generation,expires FROM lease WHERE singleton=1",
        )
        .get(),
    );
    const timestamp: number = now();
    if (
      lease.token !== token ||
      lease.epoch !== epoch ||
      lease.generation !== owner.managerGeneration ||
      lease.expires <= timestamp
    )
      throw new StoreFenceError(
        "Runtime owner lease or generation is stale; reopen and reconcile",
      );
    db.query("UPDATE lease SET expires=? WHERE singleton=1").run(
      timeSchema.parse(timestamp + owner.leaseMs),
    );
  }
  function tx<T>(operation: () => T): T {
    return db
      .transaction((): T => {
        fence();
        return operation();
      })
      .immediate();
  }
  function employee(id: string): Employee {
    const found: Employee | null = read(
      "employee",
      idSchema.parse(id),
      employeeSchema,
    );
    if (found === null || found.employment !== "hired")
      throw new StoreAuthorityError(
        `Employee ${id} is not hired in this Startup`,
      );
    return found;
  }
  function actor(input: Binding): Employee {
    const binding: Binding = bindingSchema.parse(input);
    const found: Employee = employee(binding.employeeId);
    if (
      found.generation !== binding.generation ||
      found.nativeHandle !== binding.nativeHandle
    )
      throw new StoreFenceError(
        `Native binding is stale for employee ${found.id}`,
      );
    if (found.error !== null)
      throw new StoreFenceError(
        `Employee ${found.id} has a failed native binding`,
      );
    if (found.role !== "manager" && found.source === null)
      throw new StoreAuthorityError(
        `Employee ${found.id} has no complete source-load receipt`,
      );
    return found;
  }
  function manager(binding: Binding): Employee {
    const found: Employee = actor(binding);
    if (found.role !== "manager")
      throw new StoreAuthorityError(
        `Employee ${found.id} is not the bound manager`,
      );
    return found;
  }
  function authorize(input: Authority): void {
    const authority: Authority = authoritySchema.parse(input);
    if (authority.kind === "employee") manager(authority.binding);
  }
  function team(id: string): Team {
    const found: Team | null = read("team", id, teamSchema);
    if (found === null)
      throw new StoreConflictError(`Team ${id} does not exist`);
    return found;
  }
  function members(current: Team): readonly string[] {
    return [current.architect, current.qa, ...current.devs];
  }
  // The caller already holds the fenced SQLite transaction.
  function workflow<T>(request: WorkflowRequest, apply: () => T, reviewLimit = 3): T {
    return executeWorkflow(request, {
      transaction: (run) => run(),
      read: (): WorkflowView => {
        const claimOperation = request.kind === "reconcile" || ((request.kind === "reserve" || request.kind === "settle") && request.purpose === "claim");
        const itemIds = request.kind === "admit" || request.kind === "reserve" ? request.itemIds : [];
        const admitted = itemIds.filter((id) => claimOperation
          ? read("message", id, messageSchema) !== null
          : read("intake", id, intakeRecordSchema) !== null);
        const reservations: WorkflowView["reservations"][number][] = [];
        if (claimOperation) {
          const claims = request.kind === "reserve"
            ? itemIds.flatMap((id) => selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.messageId')=?", [id], claimSchema))
            : request.kind === "settle" || request.kind === "reconcile"
              ? [read("claim", request.reservationId, claimSchema)].filter((entry): entry is Claim => entry !== null)
              : [];
          for (const entry of claims) reservations.push({ id: entry.id, itemIds: [entry.messageId], state: entry.status === "settled" ? "completed" : entry.status === "reconciliation" ? "uncertain" : "active" });
        } else if (request.kind === "reserve" || request.kind === "settle") {
          const teams = request.kind === "settle"
            ? [read("team", request.reservationId, teamSchema)]
            : itemIds.map((id) => {
                const intake = read("intake", id, intakeRecordSchema);
                return intake?.teamId ? read("team", intake.teamId, teamSchema) : null;
              });
          for (const entry of teams) if (entry !== null)
            reservations.push({ id: entry.id, itemIds: [entry.eventId], state: entry.state === "finished" ? "completed" : "active" });
        }
        const reviewId = request.kind === "review" || request.kind === "review-settle" ? request.reservationId : null;
        const byId = reviewId === null ? null : read("workflowReview", reviewId, workflowReviewSchema);
        const changeId = request.kind === "review" ? request.changeId : byId?.changeId;
        const reviews = changeId === undefined ? [] : [...selected("SELECT payload FROM records WHERE kind='workflowReview' AND json_extract(payload,'$.changeId')=?", [changeId], workflowReviewSchema)];
        if (byId !== null && !reviews.some((entry) => entry.reservationId === byId.reservationId)) reviews.push(byId);
        return { scope: { kind: "startup" }, admitted, reservations, reviews, reviewLimit, workflow: "startup" };
      },
      apply,
    });
  }
  // A non-architect member's team reservation cue only announces readiness; it carries no work to pause.
  function readinessNotice(message: Message): boolean {
    if (message.kind !== "assignment" || message.teamId === null) return false;
    const owner: Team = team(message.teamId);
    return (
      message.recipient !== owner.architect &&
      read("teamRequest", owner.eventId, teamRequestSchema)?.cues.some(
        (cue): boolean => cue.id === message.id,
      ) === true
    );
  }
  function assertNoUnresolvedWork(employeeId: string, label: string): void {
    const blocking: Assignment | undefined = all("assignment", assignmentSchema).find(
      (assignment): boolean =>
        assignment.employeeId === employeeId && assignment.state !== "complete",
    );
    if (blocking === undefined) return;
    const recovery: string =
      blocking.state === "pending"
        ? "its recipient must claim and settle it first"
        : blocking.state === "waiting"
          ? "the manager must startup_resolve it with evidence"
          : "the manager must startup_reconcile its claim first";
    throw new StoreConflictError(
      `${label} has unresolved work: assignment ${blocking.id} is ${blocking.state}; ${recovery}`,
    );
  }
  function ready(current: Team): boolean {
    return members(current).every((id): boolean => {
      const member: Employee = employee(id);
      return (
        member.assignment === current.id &&
        member.generation === current.generations[id] &&
        member.nativeHandle !== null &&
        member.source !== null &&
        member.error === null
      );
    });
  }
  function assertHostOpen(id: string): void {
    if (read("hostHold", id, hostHoldSchema) !== null)
      throw new StoreConflictError(`Host cancelled ${id} before it became item work`);
  }
  function assertReplay(saved: unknown, input: unknown, id: string): void {
    if (!sameDocument(saved, input))
      throw new StoreConflictError(
        `Immutable request ${id} conflicts with its saved payload`,
      );
  }
  function hireReceipt(request: Hire, ids: readonly string[]): HireReceipt {
    const employees: readonly Employee[] = ids.map((id): Employee => {
      const found = read("employee", id, employeeSchema);
      if (found === null)
        throw new StoreRecoveryError(
          `Hire ${request.requestId} lost employee ${id}`,
        );
      return found;
    });
    const readyCount: number = employees.filter(
      (entry): boolean =>
        entry.nativeHandle !== null &&
        entry.source !== null &&
        entry.error === null &&
        entry.employment === "hired",
    ).length;
    const failed: number = employees.filter(
      (entry): boolean => entry.error !== null && entry.employment === "hired",
    ).length;
    const retired: number = employees.filter(
      (entry): boolean => entry.employment === "retired",
    ).length;
    return {
      requestId: request.requestId,
      requested: request.additional,
      reserved: ids.length,
      ready: readyCount,
      starting: ids.length - readyCount - failed - retired,
      failed,
      retired,
      employees,
    };
  }
  function route(sender: Employee, cue: Cue): void {
    employee(cue.recipient);
    if (sender.role === "manager") return;
    if (sender.assignment !== null) {
      const current: Team = team(sender.assignment);
      if (current.state === "finished")
        throw new StoreAuthorityError("Finished team cannot send new work");
      if (sender.id === current.architect) {
        if (
          cue.kind === "report" ||
          cue.kind === "question" ||
          cue.kind === "alert"
        ) {
          if (cue.recipient !== "manager")
            throw new StoreAuthorityError(
              "Architect reports only to the manager",
            );
        } else if (
          !members(current).includes(cue.recipient) ||
          cue.recipient === sender.id
        )
          throw new StoreAuthorityError(
            "Architect may assign only its own team members",
          );
      } else if (
        cue.recipient !== current.architect ||
        !["report", "question", "alert"].includes(cue.kind)
      )
        throw new StoreAuthorityError(
          "Team members report only through their architect",
        );
    } else if (
      cue.recipient !== "manager" ||
      !["report", "question", "alert"].includes(cue.kind)
    )
      throw new StoreAuthorityError(
        "Standing staff must route reports and capacity requests to the manager",
      );
  }
  function saveCue(sender: Employee, cue: Cue, teamId: string | null): Message {
    route(sender, cue);
    const previous: Message | null = read("message", cue.id, messageSchema);
    if (previous !== null) {
      assertReplay(
        {
          id: previous.id,
          recipient: previous.recipient,
          kind: previous.kind,
          correlation: previous.correlation,
          payload: previous.payload,
          sender: previous.sender,
          teamId: previous.teamId,
        },
        { ...cue, sender: sender.id, teamId },
        cue.id,
      );
      return previous;
    }
    const sequence: number = all("message", messageSchema).length + 1;
    const message: Message = messageSchema.parse({
      ...cue,
      sender: sender.id,
      sequence,
      teamId,
      status: "pending",
    });
    put("message", cue.id, message);
    if (cue.kind === "assignment")
      put("assignment", cue.id, {
        id: cue.id,
        employeeId: cue.recipient,
        state: "pending",
      });
    return message;
  }
  function readFile(file: string): string | null {
    const path: string = join(stateDirectory, file);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }
  function observeItemProgress(input: Readonly<{ itemId: string; revision: number; status: string; observedAt: number }>): ItemProgress {
    const next: ItemProgress = itemProgressSchema.parse({ itemId: input.itemId, revision: input.revision, status: input.status, changedAt: input.observedAt });
    const previous: ItemProgress | null = read("itemProgress", next.itemId, itemProgressSchema);
    if (previous !== null) {
      if (next.revision < previous.revision || next.changedAt < previous.changedAt)
        throw new StoreFenceError("Item progress revision or timestamp regressed");
      if (next.revision === previous.revision) {
        if (next.status !== previous.status) throw new StoreConflictError("Item status changed without a new queue revision");
        return previous;
      }
    }
    put("itemProgress", next.itemId, next);
    return next;
  }
  function finalizeCapture(receipt: CaptureReceipt): void {
    const current = receipt.teamId === null ? null : team(receipt.teamId);
    const rows = canonicalQueue().rows;
    for (const item of receipt.items.filter((entry): boolean =>
      receipt.request.rows.some((change): boolean => change.id === entry.id),
    )) {
      put("queueOwner", item.id, {
        id: item.id,
        eventId: receipt.request.eventId,
        revision: item.revision,
      });
      const row = rows.find((entry) => entry.id === item.id);
      if (row === undefined) throw new StoreRecoveryError("Captured item is missing from the canonical queue");
      observeItemProgress({ itemId: item.id, revision: item.revision, status: z.string().parse(row.status), observedAt: now() });
    }
    put("capture", receipt.request.captureId, receipt);
    if (current !== null) put("team", current.id, {
      ...current,
      items: receipt.items,
      state: "active",
    });
  }
  function canonicalQueue(): QueueDocument {
    const before = readFile("queue.json");
    if (before === null)
      return { before, rows: z.array(rowSchema).parse([]), container: null, key: null };
    const document = jsonSchema.parse(JSON.parse(before));
    if (Array.isArray(document))
      return {
        before,
        rows: z.array(rowSchema).parse(document),
        container: null,
        key: null,
      };
    const container = z.record(z.string(), jsonSchema).parse(document);
    if (Object.hasOwn(container, "items") && Object.hasOwn(container, "rows"))
      throw new StoreRecoveryError("Canonical queue contains both items and rows; preserve the document and resolve its ownership");
    const key: "items" | "rows" = Object.hasOwn(container, "rows") ? "rows" : "items";
    const parsed = z.array(rowSchema).safeParse(container[key]);
    if (!parsed.success) throw new StoreRecoveryError(`Canonical queue ${key} must be a valid row array: ${parsed.error.message}`);
    return {
      before,
      rows: parsed.data,
      container, key,
    };
  }
  function queueText(document: ReturnType<typeof canonicalQueue>, rows: readonly z.infer<typeof rowSchema>[]): string {
    return JSON.stringify(document.container === null ? rows : { ...document.container, [document.key]: rows }, null, 2) + "\n";
  }
  function finalizeItem(receipt: ItemTransition): void {
    const current = team(receipt.teamId);
    put("queueOwner", receipt.request.itemId, {
      id: receipt.request.itemId,
      eventId: receipt.eventId,
      revision: receipt.revision,
    });
    observeItemProgress({ itemId: receipt.request.itemId, revision: receipt.revision, status: receipt.status, observedAt: now() });
    put("team", current.id, {
      ...current,
      items: current.items.map((item) =>
        item.id === receipt.request.itemId
          ? { id: item.id, revision: receipt.revision }
          : item,
      ),
    });
    if (receipt.execution !== null)
      put("itemExecution", receipt.request.itemId, receipt.execution);
    for (const draft of receipt.cues)
      saveCue(draft.sender, draft.cue, draft.teamId);
    put("itemTransition", receipt.request.requestId, receipt);
  }
  function finalizeManagerCompletion(completion: NonNullable<z.infer<typeof writeIntentSchema>["managerCompletion"]>): void {
    const current = read("managerRun", completion.original.launchKey, managerRunSchema);
    const owner = read("queueOwner", completion.original.itemId, queueOwnerSchema);
    if (current === null || owner === null || owner.eventId !== completion.original.eventId || owner.revision !== completion.original.revision)
      throw new StoreFenceError("Manager run ownership changed before completion");
    const resumed = current.state === "uncertain" && completion.original.state === "accepted" &&
      sameDocument({ ...current, state: "accepted" }, completion.original);
    if (!sameDocument(current, completion.original) && !resumed)
      throw new StoreFenceError("Manager run changed before completion");
    const row = canonicalQueue().rows.find((entry) => entry.id === current.itemId);
    if (row === undefined || row.status !== completion.status)
      throw new StoreRecoveryError("Manager completion queue readback does not match its receipt");
    put("queueOwner", current.itemId, { id: current.itemId, eventId: current.eventId, revision: completion.revision });
    observeItemProgress({ itemId: current.itemId, revision: completion.revision, status: completion.status, observedAt: now() });
    put("managerRun", current.launchKey, managerRunSchema.parse({ ...current, state: "completed", completion: completion.evidence }));
  }
  function finalizeHostCancel(cancel: z.infer<typeof hostCancelFinalizeSchema>): void {
    const saved = hostCancelFinalizeSchema.parse(cancel);
    const ownership = read("queueOwner", saved.itemId, queueOwnerSchema);
    if (ownership === null || ownership.eventId !== saved.eventId) throw new StoreRecoveryError("Cancelled item lost its queue owner");
    if (ownership.revision > saved.revision) throw new StoreFenceError("Cancelled item revision advanced past the host receipt");
    put("queueOwner", saved.itemId, { id: saved.itemId, eventId: saved.eventId, revision: saved.revision });
    observeItemProgress({ itemId: saved.itemId, revision: saved.revision, status: "CANCELLED", observedAt: now() });
    const current = team(saved.teamId);
    if (!current.items.some((item) => item.id === saved.itemId)) throw new StoreRecoveryError("Cancelled item is not on its team");
    put("team", current.id, { ...current, items: current.items.map((item) => item.id === saved.itemId ? { id: item.id, revision: saved.revision } : item) });
  }
  function applyIntent(id: string): void {
    tx((): void => {
      const intent = read("intent", id, writeIntentSchema);
      if (intent === null || intent.state === "complete") return;
      const actual: string | null = readFile(intent.file);
      if (actual !== intent.before && actual !== intent.after)
        throw new StoreRecoveryError(
          `Interrupted write ${id} conflicts with ${intent.file}; preserve both versions and reconcile`,
        );
      if (actual !== intent.after) {
        const destination: string = join(stateDirectory, intent.file);
        const temporary: string = `${destination}.${token}.pending`;
        writeFileSync(temporary, intent.after, {
          encoding: "utf8",
          flush: true,
          mode: 0o600,
        });
        renameSync(temporary, destination);
        const directory: number = openSync(stateDirectory, "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
      if (readFile(intent.file) !== intent.after)
        throw new StoreRecoveryError(
          `Read-back verification failed for ${intent.file}, write ${id}`,
        );
      if (intent.capture !== null) finalizeCapture(intent.capture);
      if (intent.managerCompletion !== undefined) finalizeManagerCompletion(intent.managerCompletion);
      if (intent.item !== undefined) finalizeItem(intent.item);
      if (intent.hostCancel !== undefined) finalizeHostCancel(intent.hostCancel);
      if (intent.file === "resources.json")
        put(
          "resources",
          "projection",
          jsonSchema.parse(JSON.parse(intent.after)),
        );
      put("intent", id, { ...intent, state: "complete" });
    });
  }
  function pendingWrites(): void {
    const records: readonly {
      readonly id: string;
      readonly payload: string;
    }[] = z
      .array(z.strictObject({ id: z.string(), payload: z.string() }))
      .parse(
        db
          .query(
            "SELECT id,payload FROM records WHERE kind='intent' ORDER BY rowid",
          )
          .all(),
      );
    for (const record of records)
      if (
        writeIntentSchema.parse(JSON.parse(record.payload)).state === "pending"
      )
        applyIntent(record.id);
  }
  try {
    pendingWrites();
  } catch (error: unknown) {
    db.close();
    throw error;
  }

  function compactObservations(pending: readonly Message[]): Readonly<{ acknowledged: number }> {
    const latest = new Set<string>();
    let acknowledged: number = 0;
    for (const message of pending) {
      const payload = z.object({ employeeId: idSchema, generation: timeSchema, sequence: timeSchema }).safeParse(message.payload);
      if (!payload.success) continue;
      const key = encode([message.correlation, payload.data.employeeId, payload.data.generation]);
      if (!latest.has(key)) { latest.add(key); continue; }
      put("message", message.id, { ...message, status: "acknowledged" });
      put("observationCompaction", message.id, { reason: "Superseded pending lifecycle observation; latest observation retained", acknowledgedAt: now() });
      acknowledged += 1;
    }
    return { acknowledged };
  }

  function countRecords(sql: string): number {
    return z.strictObject({ n: z.number().int().nonnegative() }).parse(db.query(sql).get()).n;
  }
  function latestRuntime(employeeId: string, generation: number): RuntimeBinding | null {
    return selected("SELECT payload FROM records WHERE kind='runtimeBinding' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.generation')>=? ORDER BY json_extract(payload,'$.generation') DESC LIMIT 1", [employeeId, generation], runtimeBindingSchema)[0] ?? null;
  }
  function pageRows<T extends { readonly id: string }>(rows: readonly T[], cursor: string | undefined, limit: number): { total: number; nextCursor: string | null; rows: T[] } {
    const found = cursor === undefined ? -1 : rows.findIndex((row) => row.id === cursor);
    if (cursor !== undefined && found < 0) throw new StoreAuthorityError(`Unknown status cursor ${cursor}`);
    const start = cursor === undefined ? 0 : found + 1;
    const slice = rows.slice(start, start + limit);
    const following = rows[start + limit];
    return { total: rows.length, nextCursor: following === undefined ? null : following.id, rows: [...slice] };
  }
  function stringList(value: unknown): readonly string[] {
    const parsed = z.array(z.string()).safeParse(value);
    return parsed.success ? parsed.data : [];
  }
  function dutyFacts(): { count: number; unreadable: boolean } {
    const rows = z.array(z.strictObject({ payload: z.string() })).parse(db.query("SELECT payload FROM records WHERE kind='duty'").all());
    let count = 0;
    let unreadable = false;
    for (const row of rows) {
      try {
        if (dutySchema.safeParse(JSON.parse(row.payload)).success) count += 1;
        else unreadable = true;
      } catch { unreadable = true; }
    }
    return { count, unreadable };
  }
  function pendingQueueIntents(): readonly { id: string }[] {
    return z.array(z.strictObject({ id: z.string(), payload: z.string() })).parse(db.query("SELECT id,payload FROM records WHERE kind='intent' ORDER BY rowid").all()).flatMap((record) => {
      let value: unknown;
      try { value = JSON.parse(record.payload); } catch { return []; }
      const intent = writeIntentSchema.safeParse(value);
      return intent.success && intent.data.state === "pending" && intent.data.file === "queue.json" ? [{ id: record.id }] : [];
    });
  }
  function readHostQueue(): { kind: "readable"; rows: readonly z.infer<typeof rowSchema>[] } | { kind: "ambiguous" } | { kind: "invalid"; message: string } {
    const before = readFile("queue.json");
    if (before === null) return { kind: "readable", rows: [] };
    let document: unknown;
    try { document = JSON.parse(before); }
    catch (error: unknown) { return { kind: "invalid", message: (error instanceof Error ? error.message : "invalid queue json").slice(0, HOST_PREVIEW_CHARS) }; }
    const parsed = jsonSchema.safeParse(document);
    if (!parsed.success) return { kind: "invalid", message: parsed.error.message.slice(0, HOST_PREVIEW_CHARS) };
    if (Array.isArray(parsed.data)) {
      const rows = z.array(rowSchema).safeParse(parsed.data);
      return rows.success ? { kind: "readable", rows: rows.data } : { kind: "invalid", message: rows.error.message.slice(0, HOST_PREVIEW_CHARS) };
    }
    const container = z.record(z.string(), jsonSchema).safeParse(parsed.data);
    if (!container.success) return { kind: "invalid", message: "queue must be an array or object" };
    if (Object.hasOwn(container.data, "items") && Object.hasOwn(container.data, "rows")) return { kind: "ambiguous" };
    const key = Object.hasOwn(container.data, "rows") ? "rows" : "items";
    const rows = z.array(rowSchema).safeParse(container.data[key]);
    return rows.success ? { kind: "readable", rows: rows.data } : { kind: "invalid", message: rows.error.message.slice(0, HOST_PREVIEW_CHARS) };
  }
  function projectRuntime(employeeId: string, runtime: RuntimeBinding | null) {
    if (runtime === null) return null;
    return { employeeId, generation: runtime.generation, launchId: runtime.launchId, state: runtime.state, observedState: runtime.observedState, nativeSession: runtime.nativeSession, paneId: runtime.paneId, lastPoll: runtime.lastPoll };
  }
  function observeHost(input: { readonly observedAt: number; readonly query: HostStatusQuery }) {
    const observedAt = timeSchema.parse(input.observedAt);
    const query = input.query;
    return db.transaction(() => {
      const lease = leaseSchema.parse(db.query("SELECT token,epoch,generation,expires FROM lease WHERE singleton=1").get());
      const storeRevision = countRecords("SELECT COALESCE(MAX(sequence),0) AS n FROM audit");
      const duties = dutyFacts();
      const pending = pendingQueueIntents();
      const queueFile = readHostQueue();
      const employees = all("employee", employeeSchema);
      const manager = employees.find((entry) => entry.id === "manager") ?? null;
      if (manager === null) throw new StoreRecoveryError("Manager employee is missing");
      const managerRuntime = latestRuntime("manager", manager.generation);
      const pas = employees.filter((entry) => entry.role === "pa" && entry.employment === "hired");
      const pa = pas.length === 1 ? pas[0] ?? null : null;
      const paHireRecord = pa === null ? null : all("hire", hireRecordSchema).find((hire) => hire.ids.includes(pa.id)) ?? null;
      const claims = countRecords("SELECT COUNT(*) AS n FROM records WHERE kind='claim' AND json_extract(payload,'$.status')='reconciliation'");
      const grants = countRecords("SELECT COUNT(*) AS n FROM records WHERE kind='grant' AND json_extract(payload,'$.state')='reconciliation'");
      const assignments = countRecords("SELECT COUNT(*) AS n FROM records WHERE kind='assignment' AND json_extract(payload,'$.state')='reconciliation'");
      const progress = new Map(all("itemProgress", itemProgressSchema).map((entry) => [entry.itemId, entry]));
      const owners = new Map(all("queueOwner", queueOwnerSchema).map((entry) => [entry.id, entry]));
      const executions = new Map(all("itemExecution", itemExecutionSchema).map((entry) => [entry.itemId, entry]));
      const captures = all("capture", captureRecordSchema);
      const transitions = all("itemTransition", itemTransitionSchema);
      const receipts = all("hostReceipt", hostReceiptSchema);
      let queue: z.infer<typeof hostQueuePageSchema>;
      let oldestProgressAt: number | null = null;
      if (pending.length > 0) {
        if (query.queueCursor !== undefined) throw new StoreAuthorityError("Queue is not pageable while an intent is pending");
        queue = { kind: "intent-pending", total: pending.length, intentIds: pending.slice(0, HOST_PAGE_MAX).map((entry) => entry.id) };
      } else if (queueFile.kind !== "readable") {
        if (query.queueCursor !== undefined) throw new StoreAuthorityError("Queue is not pageable");
        queue = queueFile.kind === "ambiguous" ? { kind: "ambiguous" } : { kind: "invalid", message: queueFile.message };
      } else {
        const projected = queueFile.rows.map((row) => {
          const request = typeof row.request === "string" ? row.request : "";
          const execution = executions.get(row.id) ?? null;
          const changedAt = progress.get(row.id)?.changedAt ?? null;
          const status = typeof row.status === "string" ? row.status : "invalid";
          const watched = !terminalItemStatuses.includes(status) && status !== "BLOCKED" && status !== "NEEDS_DECISION";
          if (watched && changedAt !== null && (oldestProgressAt === null || changedAt < oldestProgressAt)) oldestProgressAt = changedAt;
          return {
            id: row.id,
            status,
            revision: owners.get(row.id)?.revision ?? null,
            requestPreview: request.slice(0, HOST_PREVIEW_CHARS),
            requestTruncated: request.length > HOST_PREVIEW_CHARS,
            progressChangedAt: changedAt,
            captureIds: captures.filter((capture) => capture.items.some((item) => item.id === row.id)).map((capture) => capture.request.captureId).slice(0, HOST_LINK_CAP),
            transitionIds: transitions.filter((transition) => transition.request.itemId === row.id).map((transition) => transition.request.requestId).slice(0, HOST_LINK_CAP),
            hostReceiptIds: receipts.flatMap((receipt) => receipt.kind === "cancel" && receipt.target.kind === "item" && receipt.target.itemId === row.id ? [receipt.id] : []).slice(0, HOST_LINK_CAP),
            execution: execution === null ? null : { employeeId: execution.employeeId, generation: execution.generation, messageId: execution.messageId, qaMessageId: execution.qaMessageId, qaGeneration: execution.qaGeneration },
          };
        });
        queue = { kind: "readable", ...pageRows(projected, query.queueCursor, query.limit) };
      }
      const teams = all("team", teamSchema).slice().sort((left, right) => left.id.localeCompare(right.id));
      const staff = employees.slice().sort((left, right) => left.id.localeCompare(right.id)).map((entry) => {
        const runtime = latestRuntime(entry.id, entry.employment === "retired" ? 0 : entry.generation);
        const lifecycle = entry.employment === "retired" ? "retired" : runtime?.state === "abandoned" ? "abandoned" : runtime?.state === "uncertain" ? "uncertain" : entry.error !== null ? "failed" : runtime === null ? "unprepared" : runtime.state;
        return { id: entry.id, role: entry.role, generation: entry.generation, employment: entry.employment, lifecycle, assignment: entry.assignment, nativeHandle: entry.nativeHandle, nativeSession: runtime?.nativeSession ?? null, runtimeState: runtime?.state ?? null, observedState: runtime?.observedState ?? null, sourceRevision: entry.source?.roleRevision ?? null };
      });
      const openInputs = selected(`SELECT payload FROM records AS records WHERE kind='receivedInput' AND ${openInputSql} ORDER BY rowid`, [], receivedInputSchema);
      let oldestUnclassifiedAt: number | null = null;
      const pendingInputs = openInputs.slice().sort((left, right) => left.receivedAt - right.receivedAt || left.id.localeCompare(right.id)).map((entry) => {
        if (oldestUnclassifiedAt === null || entry.receivedAt < oldestUnclassifiedAt) oldestUnclassifiedAt = entry.receivedAt;
        return { id: entry.id, receivedAt: entry.receivedAt, source: entry.source, mode: entry.kind === "host" ? entry.mode : null, origin: entry.kind === "host" ? entry.origin : null, textPreview: entry.raw.text.slice(0, HOST_PREVIEW_CHARS), textLength: entry.raw.text.length, attachmentCount: entry.raw.images.length };
      });
      const teamRows = teams.map((entry) => ({
        id: entry.id,
        eventId: entry.eventId,
        state: entry.state,
        members: [entry.architect, entry.qa, ...entry.devs].map((id) => {
          const member = employees.find((candidate) => candidate.id === id);
          const generation = member?.generation ?? entry.generations[id];
          if (member === undefined || generation === undefined) throw new StoreRecoveryError(`Team ${entry.id} lost member ${id}`);
          return { id, role: member.role, generation };
        }),
        items: entry.items.slice(0, query.limit),
        itemsTruncated: entry.items.length > query.limit,
      }));
      return {
        binding: { name: scope.name, boundRoot: scope.boundRoot, home: scope.skillsHome, host: scope.host },
        storeRevision, ownerEpoch: epoch, leaseExpires: lease.expires, observedAt, duties,
        pendingIntentCount: pending.length,
        queue,
        reconciliation: { claims, grants, assignments },
        manager: { error: manager.error, generation: manager.generation, sourceRevision: manager.source?.roleRevision ?? null, runtime: projectRuntime("manager", managerRuntime) },
        paCount: pas.length,
        pa: pa === null ? null : { id: pa.id, generation: pa.generation, sourceRevision: pa.source?.roleRevision ?? null, runtime: projectRuntime(pa.id, latestRuntime(pa.id, pa.generation)) },
        paHire: paHireRecord === null ? null : { requestId: paHireRecord.request.requestId, employeeIds: paHireRecord.ids },
        teams: pageRows(teamRows, query.teamCursor, query.limit),
        staff: pageRows(staff, query.staffCursor, query.limit),
        pendingInputs: pageRows(pendingInputs, query.inputCursor, query.limit),
        watched: { oldestProgressAt, oldestUnclassifiedAt },
      };
    }).deferred();
  }
  function hostAdmit(request: HostAdmitRequest): HostReceipt {
    const parsed = hostAdmitRequestSchema.parse(request);
    return tx((): HostReceipt => {
      const duties = dutyFacts();
      if (duties.count > 0 || duties.unreadable) throw new StoreAuthorityError("Configured duties are unsupported; host intake was not recorded");
      const digest = createHash("sha256").update(encode({ images: parsed.images, mode: parsed.mode, origin: parsed.origin, requestId: parsed.requestId, text: parsed.text })).digest("hex");
      const id = `admit:${parsed.requestId}`;
      const existing = read("hostReceipt", id, hostReceiptSchema);
      if (existing !== null) {
        if (existing.kind !== "admit" || existing.digest !== digest) throw new StoreConflictError(`Host request ${parsed.requestId} conflicts with its saved payload`);
        return existing;
      }
      if (read("receivedInput", parsed.requestId, receivedInputSchema) !== null) throw new StoreConflictError(`Host request ${parsed.requestId} conflicts with an existing input`);
      const receivedAt = now();
      const stored = hostReceivedInputSchema.parse({ kind: "host", id: parsed.requestId, receivedAt, source: "host", origin: parsed.origin, mode: parsed.mode, raw: { text: parsed.text, images: [...parsed.images] }, disposition: null, hold: null });
      put("receivedInput", stored.id, stored);
      const receipt = hostAdmitReceiptSchema.parse({ kind: "admit", id, requestId: parsed.requestId, inputId: parsed.requestId, mode: parsed.mode, origin: parsed.origin, receivedAt, digest, textPreview: parsed.text.slice(0, HOST_PREVIEW_CHARS), textLength: parsed.text.length, attachmentCount: parsed.images.length });
      put("hostReceipt", id, receipt);
      return receipt;
    });
  }
  function claimSlots(execution: ItemExecution, current: Team, intentId: string, itemId: string): readonly z.infer<typeof hostClaimSlotSchema>[] {
    const targets: { role: "execution" | "qa"; employeeId: string; generation: number; messageId: string }[] = [
      { role: "execution", employeeId: execution.employeeId, generation: execution.generation, messageId: execution.messageId },
    ];
    if (execution.qaMessageId !== null && execution.qaGeneration !== null) targets.push({ role: "qa", employeeId: current.qa, generation: execution.qaGeneration, messageId: execution.qaMessageId });
    return targets.map((target) => {
      const worker = read("employee", target.employeeId, employeeSchema);
      if (worker === null) throw new StoreRecoveryError(`Cancelled worker ${target.employeeId} is missing`);
      if (worker.role === "manager" || worker.id === "manager") throw new StoreAuthorityError("Host cancel cannot settle or stop the shared manager root");
      const claims = all("claim", claimSchema).filter((claim) => claim.messageId === target.messageId);
      if (claims.some((claim) => claim.employeeId !== target.employeeId || claim.generation !== target.generation)) throw new StoreConflictError(`Message ${target.messageId} has a claim outside the cancelled generation`);
      const exact = claims.filter((claim) => claim.employeeId === target.employeeId && claim.generation === target.generation);
      if (exact.length > 1) throw new StoreConflictError(`Message ${target.messageId} has ambiguous claims for one generation`);
      const message = read("message", target.messageId, messageSchema);
      if (message === null) throw new StoreRecoveryError(`Cancelled execution lost message ${target.messageId}`);
      const claim = exact[0] ?? null;
      if (claim !== null && claim.status !== "settled") {
        const resultId = `host-cancel-${intentId}-${claim.id}`;
        const existing = read("result", resultId, resultRecordSchema);
        if (existing !== null && existing.claimId !== claim.id) throw new StoreConflictError(`Cancel result ${resultId} belongs to another claim`);
        if (existing === null) put("result", resultId, { claimId: claim.id, result: { id: resultId, kind: "completed", output: { hostCancel: intentId, itemId }, checkpoint: null, outgoing: [] }, messages: [] });
        put("claim", claim.id, { ...claim, status: "settled" });
      }
      if (message.status !== "acknowledged") put("message", message.id, { ...message, status: "acknowledged" });
      const assignment = read("assignment", message.id, assignmentSchema);
      if (assignment !== null && assignment.state !== "complete") put("assignment", assignment.id, { ...assignment, state: "complete" });
      return { ...target, outcome: claim === null ? "withdrawn-before-claim" : claim.status === "settled" ? "already-settled" : "settled" };
    });
  }
  function hostCancel(request: HostCancelRequest): HostReceipt {
    const parsed = hostCancelRequestSchema.parse(request);
    const digest = createHash("sha256").update(encode({ intentId: parsed.intentId, requestOrItemId: parsed.requestOrItemId })).digest("hex");
    const receiptId = `cancel:${parsed.intentId}`;
    const written = tx((): { receipt: HostReceipt; apply: string | null } => {
      const existing = read("hostReceipt", receiptId, hostReceiptSchema);
      if (existing !== null) {
        if (existing.kind !== "cancel" || existing.digest !== digest) throw new StoreConflictError(`Host cancel ${parsed.intentId} conflicts with its saved payload`);
        const intent = read("intent", `host-cancel/${parsed.intentId}`, writeIntentSchema);
        return { receipt: existing, apply: intent?.state === "pending" ? `host-cancel/${parsed.intentId}` : null };
      }
      if (pendingQueueIntents().length > 0) throw new StoreConflictError("A queue intent is pending; host cancel will not replay it");
      const queue = readHostQueue();
      if (queue.kind !== "readable") throw new StoreConflictError("Queue is not readable; host cancel was not recorded");
      const byId = queue.rows.filter((row) => row.id === parsed.requestOrItemId);
      if (byId.length > 1) throw new StoreConflictError(`Queue row ${parsed.requestOrItemId} is duplicated`);
      const referenced = queue.rows.filter((row) => [...stringList(row.intake_refs), ...stringList(row.startup_state_refs)].includes(parsed.requestOrItemId));
      const row = byId[0] ?? (referenced.length === 1 ? referenced[0] : undefined);
      if (byId.length === 0 && referenced.length > 1) throw new StoreConflictError(`Host id ${parsed.requestOrItemId} matches more than one queue row; cancel the item id`);
      if (row === undefined) {
        const received = read("receivedInput", parsed.requestOrItemId, receivedInputSchema);
        if (received === null) throw new StoreAuthorityError(`Host cancel target ${parsed.requestOrItemId} is not a request or queue item`);
        if (read("hostHold", received.id, hostHoldSchema) !== null) throw new StoreConflictError(`Host request ${received.id} is already cancelled`);
        const intake = read("intake", received.id, intakeRecordSchema);
        const createdAt = now();
        put("hostHold", received.id, { targetId: received.id, intentId: parsed.intentId, at: createdAt });
        if (received.kind === "host") put("receivedInput", received.id, { ...received, hold: { kind: "cancelled", intentId: parsed.intentId, at: createdAt } });
        const receipt = hostCancelReceiptSchema.parse({ kind: "cancel", id: receiptId, intentId: parsed.intentId, requestOrItemId: parsed.requestOrItemId, digest, createdAt, target: { kind: "request", inputId: received.id, delegated: intake?.teamId !== null && intake?.teamId !== undefined } });
        put("hostReceipt", receiptId, receipt);
        return { receipt, apply: null };
      }
      const status = typeof row.status === "string" ? row.status : "";
      if (terminalItemStatuses.includes(status)) throw new StoreConflictError(`Item ${row.id} is already terminal`);
      const ownership = read("queueOwner", row.id, queueOwnerSchema);
      const event = ownership === null ? null : read("intake", ownership.eventId, intakeRecordSchema);
      if (ownership === null || event?.teamId === null || event?.teamId === undefined) throw new StoreConflictError(`Item ${row.id} has no owning team`);
      const current = team(event.teamId);
      const execution = read("itemExecution", row.id, itemExecutionSchema);
      const slots = execution === null ? [] : claimSlots(execution, current, parsed.intentId, row.id);
      const revision = ownership.revision + 1;
      const nextRow = rowSchema.parse({ ...row, status: "CANCELLED", startup_state_refs: [...stringList(row.startup_state_refs), parsed.intentId] });
      const document = canonicalQueue();
      const after = queueText(document, document.rows.map((entry) => entry.id === row.id ? nextRow : entry));
      const intentKey = `host-cancel/${parsed.intentId}`;
      put("intent", intentKey, { file: "queue.json", before: document.before, after, state: "pending", capture: null, hostCancel: { itemId: row.id, eventId: ownership.eventId, teamId: current.id, revision } });
      const createdAt = now();
      const receipt = hostCancelReceiptSchema.parse({ kind: "cancel", id: receiptId, intentId: parsed.intentId, requestOrItemId: parsed.requestOrItemId, digest, createdAt, target: { kind: "item", itemId: row.id, revision, status: "CANCELLED", slots } });
      put("hostReceipt", receiptId, receipt);
      if (parsed.requestOrItemId !== row.id && read("receivedInput", parsed.requestOrItemId, receivedInputSchema) !== null && read("hostHold", parsed.requestOrItemId, hostHoldSchema) === null) {
        put("hostHold", parsed.requestOrItemId, { targetId: parsed.requestOrItemId, intentId: parsed.intentId, at: createdAt });
        const linked = read("receivedInput", parsed.requestOrItemId, receivedInputSchema);
        if (linked?.kind === "host") put("receivedInput", linked.id, { ...linked, hold: { kind: "cancelled", intentId: parsed.intentId, at: createdAt } });
      }
      return { receipt, apply: intentKey };
    });
    if (written.apply !== null) applyIntent(written.apply);
    return hostReceiptSchema.parse(read("hostReceipt", receiptId, hostReceiptSchema) ?? written.receipt);
  }

  return {
    scope,
    ownerEpoch: epoch,
    ownerId: owner.id,
    getEmployee: employee,
    getTeam: team,
    hasMessage(id: string): boolean { return read("message", id, messageSchema) !== null; },
    employees(): readonly Employee[] { return all("employee", employeeSchema); },
    employeeView,
    outstandingMessages(employeeId: string): readonly Message[] {
      return selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')=? AND json_extract(payload,'$.status') IN ('pending','claimed') ORDER BY rowid", [employeeId], messageSchema);
    },
    lastPaCheck(employeeId: string): Message | null {
      return selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')=? AND id LIKE 'pa-check-%' ORDER BY rowid DESC LIMIT 1", [employeeId], messageSchema)[0] ?? null;
    },
    managerPendingWork(): Readonly<{ unclassifiedInput: boolean; undelegatedIntake: boolean }> {
      return {
        unclassifiedInput: db.query(`SELECT 1 FROM records WHERE kind='receivedInput' AND ${openInputSql} LIMIT 1`).get() !== null,
        undelegatedIntake: db.query("SELECT 1 FROM records AS intake WHERE intake.kind='intake' AND json_extract(intake.payload,'$.teamId') IS NULL AND NOT EXISTS (SELECT 1 FROM records AS capture WHERE capture.kind='capture' AND json_extract(capture.payload,'$.request.eventId')=intake.id) LIMIT 1").get() !== null,
      };
    },
    supervisionView(): Pick<Snapshot, "employees" | "teams" | "messages" | "claims" | "inputs" | "queueRevisions" | "itemExecutions"> {
      return {
        employees: all("employee", employeeSchema),
        teams: all("team", teamSchema),
        messages: selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.status') IN ('pending','claimed') ORDER BY rowid", [], messageSchema),
        claims: selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.status') IN ('active','reconciliation') ORDER BY rowid", [], claimSchema),
        inputs: selected(`SELECT payload FROM records WHERE kind='receivedInput' AND ${openInputSql} ORDER BY rowid`, [], receivedInputSchema),
        queueRevisions: all("queueOwner", queueOwnerSchema),
        itemExecutions: all("itemExecution", itemExecutionSchema),
      };
    },
    managerBinding: bindingSchema.parse({
      employeeId: "manager",
      generation: owner.managerGeneration,
      nativeHandle: scope.managerSession,
    }),
    renewLease(): void {
      tx((): void => {});
    },
    initializeRoleSettings(defaultHarness: "omp" | "claude"): readonly SavedRoleSettings[] {
      const harness = runtimeHarnessSchema.parse(defaultHarness);
      return tx((): readonly SavedRoleSettings[] => roleSchema.options.map((role) => {
        const current: SavedRoleSettings | null = read("roleSettings", role, savedRoleSettingsSchema);
        if (current !== null) return current;
        const input = roleSettingsInputSchema.parse({ role, harness, model: null, effort: null });
        const requested = requestedRoleSettingsSchema.parse({
          role: input.role,
          harness: input.harness,
          model: { value: input.model, validation: "not_requested" },
          effort: { value: input.effort, validation: "not_requested" },
        });
        const saved = savedRoleSettingsSchema.parse({
          role,
          requested,
          scope: "future_launch",
          revision: 0,
          provenance: roleSettingsProvenanceSchema.parse({ kind: "startup_default", actor: "startup", generation: null, updatedAt: now() }),
        });
        put("roleSettings", role, saved);
        return saved;
      }));
    },
    freezeManagerSettings(harness: "omp" | "claude"): SavedRoleSettings {
      return tx(() => {
        const frozen = read("managerLaunchSettings", scope.managerSession, savedRoleSettingsSchema);
        if (frozen !== null) {
          if (frozen.requested.harness !== harness) throw new StoreConflictError("Prepared manager harness differs from the requested launch");
          return frozen;
        }
        const selected = read("roleSettings", "manager", savedRoleSettingsSchema);
        if (selected === null) throw new StoreConflictError("Manager launch requires saved settings");
        if (selected.requested.harness !== harness) throw new StoreConflictError("Saved manager harness differs from the requested new native launch");
        put("managerLaunchSettings", scope.managerSession, selected);
        return selected;
      });
    },
    roleSettings(role: Employee["role"]): SavedRoleSettings {
      const parsed = roleSchema.parse(role);
      const found: SavedRoleSettings | null = read("roleSettings", parsed, savedRoleSettingsSchema);
      if (found === null) throw new StoreConflictError(`No saved runtime settings for role ${parsed}`);
      return found;
    },
    allRoleSettings(): readonly SavedRoleSettings[] {
      return all("roleSettings", savedRoleSettingsSchema);
    },
    saveRoleSettings(input: Readonly<{ manager: Binding; requested: RequestedRoleSettings; expectedRevision: number }>): SavedRoleSettings {
      return tx((): SavedRoleSettings => {
        const actor = manager(input.manager);
        const request = requestedRoleSettingsSchema.parse(input.requested);
        const validation = validateRoleSettings({ role: request.role, harness: request.harness, model: request.model.value, effort: request.effort.value });
        if (validation.status === "unsupported") throw new StoreAuthorityError(validation.reason);
        const requested = validation.requested;
        const current: SavedRoleSettings | null = read("roleSettings", requested.role, savedRoleSettingsSchema);
        if (current === null) throw new StoreConflictError(`No saved runtime settings for role ${requested.role}`);
        if (current.revision !== timeSchema.parse(input.expectedRevision))
          throw new StoreConflictError(`Runtime settings revision changed for role ${requested.role}; refresh the saved setting before retrying`);
        const saved: SavedRoleSettings = savedRoleSettingsSchema.parse({
          role: requested.role,
          requested,
          scope: "future_launch",
          revision: current.revision + 1,
          provenance: roleSettingsProvenanceSchema.parse({ kind: "manager_request", actor: actor.id, generation: actor.generation, updatedAt: now() }),
        });
        put("roleSettings", requested.role, saved);
        return saved;
      });
    },
    hostControl(request: OwnerControlRequest): OwnerControlReceipt {
      return withOwnerControlRequest(scope, request.requestId, () => tx(() => applyOwnerControl(db, scope, request, now(), epoch)));
    },
    recoverManager(input: { readonly evidence: Json }): Employee {
      return tx((): Employee => {
        const current: Employee = employee("manager");
        const failure: Employee | null = read(
          "managerFailure",
          "manager",
          employeeSchema,
        );
        const evidence: Json = jsonSchema.parse(input.evidence);
        if (
          evidence === null ||
          failure === null ||
          current.error === null ||
          failure.generation >= owner.managerGeneration ||
          current.generation !== owner.managerGeneration ||
          current.nativeHandle !== scope.managerSession
        )
          throw new StoreRecoveryError(
            "Manager recovery requires a failed prior generation, current owner/root evidence and a newer native generation",
          );
        const recovered: Employee = { ...current, error: null, source: null };
        put("managerRecovery", String(epoch), {
          ownerEpoch: epoch,
          ownerId: owner.id,
          managerSession: scope.managerSession,
          generation: owner.managerGeneration,
          failure,
          evidence,
        });
        put("employee", "manager", recovered);
        return recovered;
      });
    },
    reserveHire(input: {
      readonly authority: Authority;
      readonly request: Hire;
    }): HireReceipt {
      return tx((): HireReceipt => {
        authorize(input.authority);
        const request: Hire = hireSchema.parse(input.request);
        const previous = read("hire", request.requestId, hireRecordSchema);
        if (previous !== null) {
          assertReplay(previous.request, request, request.requestId);
          return hireReceipt(request, previous.ids);
        }
        const existingCount: number = all("employee", employeeSchema).length;
        if (!Number.isSafeInteger(existingCount + request.additional))
          throw new StoreConflictError(
            "Employee count exceeds safe integer capacity",
          );
        const ids: readonly string[] = Array.from(
          { length: request.additional },
          (): string => randomUUID(),
        );
        for (const id of ids)
          put(
            "employee",
            id,
            employeeSchema.parse({
              id,
              role: request.role,
              employment: "hired",
              generation: 0,
              nativeHandle: null,
              source: null,
              assignment: null,
              canonicalRevision: request.revision,
              checkpoint: null,
              error: null,
            }),
          );
        put("hire", request.requestId, { request, ids });
        return hireReceipt(request, ids);
      });
    },
    bindEmployee(input: {
      readonly manager: Binding;
      readonly binding: Bind;
    }): Employee {
      return tx((): Employee => {
        manager(input.manager);
        const binding: Bind = bindSchema.parse(input.binding);
        const current: Employee = employee(binding.employeeId);
        if (
          !binding.source.rolePath.endsWith(
            `/jp-startup-role-${current.role}/SKILL.md`,
          ) ||
          !binding.source.loopPath.endsWith("/jp-startup-loop/SKILL.md") ||
          (current.canonicalRevision !== null &&
            binding.source.roleRevision !== current.canonicalRevision)
        )
          throw new StoreAuthorityError(
            "Source-load receipt does not match the reserved canonical role and revision",
          );
        if (current.assignment !== binding.assignment)
          throw new StoreConflictError(
            "Native assignment does not match employee reservation",
          );
        const prior = read(
          "binding",
          `${binding.employeeId}/${binding.generation}`,
          bindSchema,
        );
        if (prior !== null) {
          assertReplay(
            prior,
            binding,
            `binding ${binding.employeeId}/${binding.generation}`,
          );
          if (
            current.generation !== binding.generation ||
            current.nativeHandle !== binding.nativeHandle ||
            current.error !== null ||
            current.source === null
          )
            throw new StoreFenceError(
              "Cannot replay a superseded native binding",
            );
          return current;
        }
        if (current.nativeHandle !== null && current.role !== "manager")
          throw new StoreConflictError(
            "Reserve explicit native replacement before rebinding an active employee",
          );
        if (
          binding.generation !== current.generation + 1 &&
          current.role !== "manager"
        )
          throw new StoreFenceError(
            "A new native binding must advance the employee generation by one",
          );
        if (
          current.role === "manager" &&
          (binding.generation !== owner.managerGeneration ||
            binding.nativeHandle !== scope.managerSession)
        )
          throw new StoreFenceError(
            "Manager binding must match the owner root",
          );
        if (
          binding.assignment !== null &&
          team(binding.assignment).generations[current.id] !==
            binding.generation
        )
          throw new StoreFenceError(
            "Team binding must use its reserved generation",
          );
        if (
          all("binding", bindSchema).some(
            (entry): boolean =>
              entry.nativeHandle === binding.nativeHandle &&
              entry.employeeId !== "manager",
          )
        )
          throw new StoreConflictError(
            "Native handle was already used; a fresh assignment requires fresh context",
          );
        const unresolved = all("claim", claimSchema).find(
          (claim): boolean =>
            claim.employeeId === current.id && claim.status !== "settled",
        );
        if (unresolved !== undefined)
          throw new StoreRecoveryError(
            `Employee ${current.id} has unresolved claim ${unresolved.id}`,
          );
        const updated: Employee = employeeSchema.parse({
          ...current,
          generation: binding.generation,
          nativeHandle: binding.nativeHandle,
          source: binding.source,
          error: null,
        });
        put("employee", current.id, updated);
        put("binding", `${current.id}/${binding.generation}`, binding);
        if (current.assignment !== null) {
          const reserved: Team = team(current.assignment);
          if (ready(reserved)) {
            const captured: boolean = all("capture", captureRecordSchema).some(
              (receipt): boolean => receipt.teamId === reserved.id,
            );
            put("team", reserved.id, {
              ...reserved,
              state: captured ? "active" : "ready",
            });
          }
        }
        return updated;
      });
    },
    reserveReplacement(input: {
      readonly manager: Binding;
      readonly employeeId: string;
      readonly evidence: Json;
    }): number {
      return tx((): number => {
        manager(input.manager);
        const current: Employee = employee(input.employeeId);
        if (current.role === "manager")
          throw new StoreAuthorityError(
            "Manager replacement requires a new owner lease",
          );
        if (input.evidence === null)
          throw new StoreRecoveryError(
            "Native replacement requires explicit recovery evidence",
          );
        if (
          all("claim", claimSchema).some(
            (claim): boolean =>
              claim.employeeId === current.id && claim.status !== "settled",
          ) ||
          all("grant", grantSchema).some(
            (grant): boolean =>
              grant.employeeId === current.id && grant.state !== "released",
          )
        )
          throw new StoreRecoveryError(
            "Reconcile claims and target grants before replacing the native context",
          );
        const generation: number = timeSchema.parse(current.generation + 1);
        put(
          "replacement",
          `${current.id}/${generation}`,
          jsonSchema.parse(input.evidence),
        );
        put("employee", current.id, {
          ...current,
          nativeHandle: null,
          source: null,
          error: null,
        });
        if (current.assignment !== null) {
          const assigned: Team = team(current.assignment);
          put("team", assigned.id, {
            ...assigned,
            state: "reserved",
            generations: { ...assigned.generations, [current.id]: generation },
          });
        }
        return generation;
      });
    },
    refreshCanonical(input: {
      readonly manager: Binding;
      readonly employeeId: string;
      readonly source: Source;
      readonly evidence: Json;
    }): number {
      return tx((): number => {
        manager(input.manager);
        const current: Employee = employee(input.employeeId);
        const source: Source = sourceSchema.parse(input.source);
        if (current.role === "manager" || current.employment !== "hired")
          throw new StoreAuthorityError(
            "Canonical refresh requires an employed non-manager; manager refresh requires a newer native owner context",
          );
        if (
          !source.rolePath.endsWith(`/jp-startup-role-${current.role}/SKILL.md`) ||
          !source.loopPath.endsWith("/jp-startup-loop/SKILL.md") ||
          input.evidence === null
        )
          throw new StoreAuthorityError(
            "Canonical refresh requires role-matched host source and explicit evidence",
          );
        if (
          current.assignment !== null ||
          all("claim", claimSchema).some(
            (entry) =>
              entry.employeeId === current.id && entry.status !== "settled",
          ) ||
          all("grant", grantSchema).some(
            (entry) =>
              entry.employeeId === current.id && entry.state !== "released",
          ) ||
          all("assignment", assignmentSchema).some(
            (entry) =>
              entry.employeeId === current.id &&
              entry.state !== "complete" &&
              !(
                entry.state === "pending" &&
                all("message", messageSchema).some(
                  (message) =>
                    message.id === entry.id &&
                    message.recipient === current.id &&
                    message.status === "pending",
                )
              ),
          ) ||
          all("message", messageSchema).some(
            (entry) =>
              entry.recipient === current.id && entry.status === "claimed",
          ) ||
          all("occurrence", occurrenceSchema).some(
            (entry) =>
              entry.employeeId === current.id && entry.observedAt === null,
          )
        )
          throw new StoreRecoveryError(
            "Canonical refresh requires an idle boundary with resolved claims, started assignments, claimed incoming mail, grants and active duty occurrences",
          );
        const generation: number = timeSchema.parse(current.generation + 1);
        put("canonicalRefresh", `${current.id}/${generation}`, {
          previous: current,
          source,
          generation,
          evidence: jsonSchema.parse(input.evidence),
        });
        put("replacement", `${current.id}/${generation}`, {
          kind: "canonical-refresh",
          source,
          evidence: jsonSchema.parse(input.evidence),
        });
        put("employee", current.id, {
          ...current,
          nativeHandle: null,
          source: null,
          error: null,
          canonicalRevision: source.roleRevision,
        });
        return generation;
      });
    },
    recordBindingFailure(input: {
      readonly manager: Binding;
      readonly employeeId: string;
      readonly error: string;
    }): void {
      tx((): void => {
        manager(input.manager);
        const current = employee(input.employeeId);
        put("employee", current.id, {
          ...current,
          error: z.string().min(1).parse(input.error),
        });
        if (current.role === "manager")
          put("managerFailure", "manager", { ...current, error: input.error });
        for (const claim of all("claim", claimSchema).filter(
          (entry): boolean =>
            entry.employeeId === current.id && entry.status === "active",
        ))
          put("claim", claim.id, { ...claim, status: "reconciliation" });
        for (const grant of all("grant", grantSchema).filter(
          (entry): boolean =>
            entry.employeeId === current.id && entry.state === "held",
        ))
          put("grant", grant.id, { ...grant, state: "reconciliation" });
        if (current.assignment !== null)
          put("team", current.assignment, {
            ...team(current.assignment),
            state: "reserved",
          });
      });
    },
    receiveInput(input: {
      readonly id: string;
      readonly receivedAt: number;
      readonly source: "interactive" | "rpc";
      readonly raw: { readonly text: string; readonly images: readonly Json[] };
      readonly disposition: null;
    }): ReceivedInput {
      return tx((): ReceivedInput => {
        const received: ReceivedInput = receivedInputSchema.parse(input);
        if (received.kind !== "native" || received.disposition !== null)
          throw new StoreAuthorityError(
            "Native ingress must begin unclassified",
          );
        const previous = read(
          "receivedInput",
          received.id,
          receivedInputSchema,
        );
        if (previous !== null) {
          assertReplay(
            { ...previous, disposition: null },
            received,
            received.id,
          );
          return previous;
        }
        put("receivedInput", received.id, received);
        return received;
      });
    },
    routeInput(input: {
      readonly manager: Binding;
      readonly inputId: string;
      readonly disposition: z.infer<typeof inputDispositionSchema>;
    }): ReceivedInput {
      return tx((): ReceivedInput => {
        manager(input.manager);
        const id: string = idSchema.parse(input.inputId);
        const received = read("receivedInput", id, receivedInputSchema);
        if (received === null)
          throw new StoreAuthorityError("Native received input does not exist");
        const disposition = inputDispositionSchema.parse(input.disposition);
        if (
          disposition.kind !== "work" &&
          disposition.amendItemIds.length !== 0
        )
          throw new StoreAuthorityError(
            "Only work disposition may reference amended items",
          );
        if (received.disposition !== null) {
          assertReplay(received.disposition, disposition, id);
          return received;
        }
        assertHostOpen(id);
        if (disposition.kind === "work") {
          const event: Intake = intakeSchema.parse({
            eventId: id,
            input: received.raw,
            amendItemIds: disposition.amendItemIds,
          });
          const previous = read("intake", id, intakeRecordSchema);
          if (previous !== null) assertReplay(previous.request, event, id);
          else workflow({ kind: "admit", role: "manager", itemIds: [id] }, () => put("intake", id, { request: event, teamId: null }));
        }
        const routed: ReceivedInput = { ...received, disposition };
        put("receivedInput", id, routed);
        return routed;
      });
    },
    recordIntake(input: {
      readonly manager: Binding;
      readonly event: Intake;
    }): Intake {
      return tx((): Intake => {
        manager(input.manager);
        const event: Intake = intakeSchema.parse(input.event);
        const previous = read("intake", event.eventId, intakeRecordSchema);
        if (previous !== null)
          assertReplay(previous.request, event, event.eventId);
        else {
          assertHostOpen(event.eventId);
          workflow({ kind: "admit", role: "manager", itemIds: [event.eventId] }, () => put("intake", event.eventId, { request: event, teamId: null }));
        }
        return event;
      });
    },
    recordTeamRequirement(input: {
      readonly manager: Binding;
      readonly request: z.infer<typeof teamRequirementSchema>;
    }): void {
      tx(() => {
        manager(input.manager);
        const request = teamRequirementSchema.parse(input.request);
        if (read("intake", request.eventId, intakeRecordSchema) === null)
          throw new StoreAuthorityError(
            "Team requirements require saved intake",
          );
        const previous = read(
          "teamRequirement",
          request.eventId,
          teamRequirementSchema,
        );
        if (previous !== null) assertReplay(previous, request, request.eventId);
        else {
          assertHostOpen(request.eventId);
          put("teamRequirement", request.eventId, request);
        }
      });
    },
    reserveTeam(input: {
      readonly manager: Binding;
      readonly request: TeamRequest;
    }): Team {
      return tx((): Team => {
        const leader: Employee = manager(input.manager);
        const request: TeamRequest = teamRequestSchema.parse(input.request);
        const event = read("intake", request.eventId, intakeRecordSchema);
        if (event === null)
          throw new StoreConflictError(
            "Record immutable intake before team reservation",
          );
        const previous = read(
          "teamRequest",
          request.eventId,
          teamRequestSchema,
        );
        if (previous !== null) {
          assertReplay(previous, request, request.eventId);
          if (event.teamId === null)
            throw new StoreRecoveryError(
              "Saved team request is missing its team",
            );
          return team(event.teamId);
        }
        assertHostOpen(request.eventId);
        const ids: readonly string[] = [
          request.architect,
          request.qa,
          ...request.devs,
        ];
        if (new Set(ids).size !== ids.length)
          throw new StoreConflictError(
            "Each team member must be a distinct employee",
          );
        const staff: readonly Employee[] = ids.map(employee);
        for (const member of staff) {
          const expectedRole: string =
            member.id === request.architect
              ? "architect"
              : member.id === request.qa
                ? "qa"
                : "dev";
          if (member.role !== expectedRole || member.assignment !== null)
            throw new StoreConflictError(
              `Employee ${member.id} is not an idle ${expectedRole}`,
            );
          if (
            all("claim", claimSchema).some(
              (claim): boolean =>
                claim.employeeId === member.id && claim.status !== "settled",
            ) ||
            all("grant", grantSchema).some(
              (grant): boolean =>
                grant.employeeId === member.id && grant.state !== "released",
            ) ||
            all("assignment", assignmentSchema).some(
              (assignment): boolean =>
                assignment.employeeId === member.id &&
                assignment.state !== "complete",
            ) ||
            all("message", messageSchema).some(
              (message): boolean =>
                message.recipient === member.id &&
                message.status !== "acknowledged",
            )
          )
            throw new StoreConflictError(
              `Employee ${member.id} has unfinished work, mail or target grants`,
            );
        }
        if (
          request.cues.length !== ids.length ||
          new Set(request.cues.map((cue): string => cue.recipient)).size !==
            ids.length ||
          request.cues.some(
            (cue): boolean =>
              !ids.includes(cue.recipient) ||
              cue.kind !== "assignment" ||
              cue.correlation !== request.eventId,
          )
        )
          throw new StoreConflictError(
            "Team reservation requires exactly one event-bound assignment cue per member",
          );
        const id: string = randomUUID();
        const reserved: Team = teamSchema.parse({
          id,
          eventId: request.eventId,
          architect: request.architect,
          qa: request.qa,
          devs: request.devs,
          generations: Object.fromEntries(
            staff.map((member): [string, number] => [
              member.id,
              member.generation + 1,
            ]),
          ),
          state: "reserved",
          items: [],
        });
        return workflow({ kind: "reserve", role: leader.role, itemIds: [request.eventId], reservationId: id }, () => {
          put("team", id, reserved);
          for (const member of staff)
            put("employee", member.id, {
              ...member, assignment: id, nativeHandle: null, source: null, error: null, checkpoint: null,
            });
          for (const cue of request.cues) saveCue(leader, cue, id);
          put("teamRequest", request.eventId, request);
          put("intake", request.eventId, { ...event, teamId: id });
          return reserved;
        });
      });
    },
    captureIntake(input: {
      readonly architect: Binding;
      readonly capture: Capture;
    }): CaptureReceipt {
      pendingWrites();
      const receipt: CaptureReceipt = tx((): CaptureReceipt => {
        const leader: Employee = actor(input.architect);
        const capture: Capture = captureSchema.parse(input.capture);
        const event = read("intake", capture.eventId, intakeRecordSchema);
        if (event === null) throw new StoreAuthorityError("Intake event is unavailable");
        const current = event.teamId === null ? null : team(event.teamId);
        if (current === null) {
          if (leader.role !== "manager") throw new StoreAuthorityError("Only the manager may capture unassigned intake");
        } else if (leader.role !== "architect" || current.architect !== leader.id || leader.assignment !== current.id || current.state === "finished" || !ready(current)) {
          throw new StoreAuthorityError("Only the ready event team's architect may capture its intake");
        }
        const previous = read(
          "capture",
          capture.captureId,
          captureRecordSchema,
        );
        if (previous !== null) {
          assertReplay(previous.request, capture, capture.captureId);
          return previous;
        }
        const document = canonicalQueue();
        const { before, rows } = document;
        if (new Set(rows.map((row): string => row.id)).size !== rows.length)
          throw new StoreRecoveryError(
            "Canonical queue contains duplicate IDs",
          );
        if (
          new Set(capture.rows.map((row): string => row.id)).size !==
          capture.rows.length
        )
          throw new StoreConflictError("Capture contains duplicate row IDs");
        const changes = capture.rows.map((change) => {
          if (leader.role !== "manager" && read("managerItem", change.id, managerItemSchema) !== null) throw new StoreAuthorityError("Queue item belongs to the manager");
          if (all("managerRun", managerRunSchema).some((entry) => entry.itemId === change.id)) throw new StoreConflictError("Queue item has an active, uncertain or reported manager run");
          const found = rows.find((row): boolean => row.id === change.id);
          const ownership = read("queueOwner", change.id, queueOwnerSchema);
          if (found !== undefined) {
            if (found.legacy_import != null && (change.fields.status === "QUEUED" || ("legacy_import" in change.fields && !sameDocument(change.fields.legacy_import, found.legacy_import))))
              throw new StoreRecoveryError("Legacy work requires verified reconciliation before resume");
            if ((ownership?.revision ?? 0) !== change.expectedRevision)
              throw new StoreConflictError(
                `Queue row ${change.id} has a stale revision`,
              );
            if (
              ownership?.eventId !== capture.eventId &&
              !event.request.amendItemIds.includes(change.id)
            )
              throw new StoreAuthorityError(
                `Queue row ${change.id} is outside this delegated event`,
              );
            if (
              !["QUEUED", "NEEDS_DECISION"].includes(
                z.string().parse(found.status),
              ) ||
              found.dispatched_at != null
            )
              throw new StoreAuthorityError(
                `Queue row ${change.id} is dispatched or terminal; create a linked follow-up`,
              );
            if (ownership !== null && ownership.eventId !== capture.eventId) {
              const previousEvent = read(
                "intake",
                ownership.eventId,
                intakeRecordSchema,
              );
              if (
                previousEvent?.teamId !== null &&
                previousEvent?.teamId !== undefined
              ) {
                const previousTeam: Team = team(previousEvent.teamId);
                if (
                  !["waiting", "finished"].includes(previousTeam.state) ||
                  all("claim", claimSchema).some(
                    (claim): boolean =>
                      members(previousTeam).includes(claim.employeeId) &&
                      claim.status !== "settled",
                  )
                )
                  throw new StoreAuthorityError(
                    `Queue row ${change.id} belongs to a competing active team`,
                  );
              }
            }
            if (
              typeof found.request === "string" &&
              typeof change.fields.request === "string" &&
              !change.fields.request.startsWith(found.request)
            )
              throw new StoreConflictError(
                "Queue amendments must retain the previous request text",
              );
          }
          if (found === undefined && change.expectedRevision !== null)
            throw new StoreConflictError(
              `New queue row ${change.id} requires null expectedRevision`,
            );
          if ("id" in change.fields && change.fields.id !== change.id)
            throw new StoreConflictError("Queue ID cannot be changed");
          const revision: number = (ownership?.revision ?? 0) + 1;
          const previousRefs: readonly Json[] =
            found?.intake_refs === undefined
              ? []
              : z.array(jsonSchema).parse(found.intake_refs);
          const suppliedRefs: readonly Json[] =
            change.fields.intake_refs === undefined
              ? []
              : z.array(jsonSchema).parse(change.fields.intake_refs);
          const row = rowSchema.parse({
            ...found,
            ...change.fields,
            id: change.id,
            intake_refs: [
              ...previousRefs,
              ...suppliedRefs.filter(
                (ref): boolean =>
                  !previousRefs.some((old): boolean => sameDocument(old, ref)),
              ),
              capture.eventId,
            ],
          });
          z.object({
            request: z.string().min(1),
            acceptance: jsonSchema,
            blocked_on: jsonSchema,
            status: z.enum(["QUEUED", "NEEDS_DECISION", "REJECTED"]),
          }).parse(row);
          return { row, id: change.id, revision };
        });
        const nextRows = [
          ...rows.map(
            (row) =>
              changes.find((change): boolean => change.id === row.id)?.row ??
              row,
          ),
          ...changes
            .filter(
              (change): boolean =>
                !rows.some((row): boolean => row.id === change.id),
            )
            .map((change) => change.row),
        ];
        const after: string = queueText(document, nextRows);
        const saved: CaptureReceipt = captureRecordSchema.parse({
          request: capture,
          teamId: current?.id ?? null,
          items: [
            ...(current?.items ?? all("capture", captureRecordSchema).filter((entry) => entry.teamId === null && entry.request.eventId === capture.eventId).flatMap((entry) => entry.items)).filter(
              (item): boolean =>
                !changes.some((change): boolean => change.id === item.id),
            ),
            ...changes.map((change) => ({
              id: change.id,
              revision: change.revision,
            })),
          ],
        });
        put("intent", `capture/${capture.captureId}`, {
          file: "queue.json",
          before,
          after,
          state: "pending",
          capture: saved,
        });
        return saved;
      });
      applyIntent(`capture/${receipt.request.captureId}`);
      return receipt;
    },
    migrateManagerQueue(input: { readonly manager: Binding; readonly migrationId: string }): z.infer<typeof managerMigrationSchema> {
      pendingWrites();
      return tx(() => {
        manager(input.manager);
        const migrationId = idSchema.parse(input.migrationId);
        const previous = read("managerMigration", migrationId, managerMigrationSchema);
        if (previous !== null) return previous;
        const rows = canonicalQueue().rows;
        if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new StoreRecoveryError("Canonical queue contains duplicate IDs");
        const migrated: string[] = [];
        const alreadyManaged: string[] = [];
        const blocked: { itemId: string; reason: string }[] = [];
        const scopes = all("workflowScope", workflowScopeSchema);
        const factories = all("workflowFactoryScope", workflowFactoryScopeSchema);
        const launches = all("workflowLaunch", workflowLaunchSchema);
        const managerRuns = all("managerRun", managerRunSchema);
        const managerReviews = all("managerReview", managerReviewSchema);
        for (const row of rows) {
          const owner = read("queueOwner", row.id, queueOwnerSchema);
          if (owner === null) { blocked.push({ itemId: row.id, reason: "missing queue ownership" }); continue; }
          const event = read("intake", owner.eventId, intakeRecordSchema);
          if (event === null) { blocked.push({ itemId: row.id, reason: "missing intake" }); continue; }
          if (row.status !== "QUEUED") { blocked.push({ itemId: row.id, reason: `status ${String(row.status)} retained` }); continue; }
          if (row.dispatched_at != null || read("itemExecution", row.id, itemExecutionSchema) !== null) { blocked.push({ itemId: row.id, reason: "assigned or dispatched work requires reconciliation" }); continue; }
          if (managerRuns.some((run) => run.itemId === row.id && run.state !== "released") || managerReviews.some((review) => review.itemId === row.id && (review.state === "active" || review.state === "uncertain" || review.verdict === "approve"))) { blocked.push({ itemId: row.id, reason: "manager run or review requires reconciliation" }); continue; }
          const activeScopeIds = new Set([
            ...scopes.filter((scope) => scope.itemId === row.id).map((scope) => scope.id),
            ...factories.filter((scope) => scope.items.some((item) => item.itemId === row.id)).map((scope) => scope.id),
          ]);
          const reviews = all("workflowReview", workflowReviewSchema).filter((review) => review.changeId === row.id);
          if (launches.some((launch) => activeScopeIds.has(launch.scopeId) && launch.state !== "closed") ||
              all("workflowChild", workflowChildSchema).some((child) => child.itemId === row.id && (child.state === "active" || child.state === "uncertain")) ||
              reviews.some((review) => review.state !== "completed" || review.verdict === null)) {
            blocked.push({ itemId: row.id, reason: "active or uncertain workflow evidence requires reconciliation" }); continue;
          }
          if (reviews.some((review) => review.verdict === "approve") ||
              (reviews.length > 0 && reviews.length >= Math.min(...reviews.map((review) => review.limit)))) {
            blocked.push({ itemId: row.id, reason: "prior review is approved or its budget is exhausted" }); continue;
          }
          if (event.teamId === null) { alreadyManaged.push(row.id); continue; }
          const prior = read("managerItem", row.id, managerItemSchema);
          if (prior !== null) {
            if (prior.eventId !== owner.eventId || prior.revision !== owner.revision || prior.teamId !== event.teamId) { blocked.push({ itemId: row.id, reason: "manager ownership no longer matches queue revision" }); continue; }
            alreadyManaged.push(row.id); continue;
          }
          put("managerItem", row.id, managerItemSchema.parse({ itemId: row.id, eventId: owner.eventId, revision: owner.revision, teamId: event.teamId, migrationId }));
          migrated.push(row.id);
        }
        const receipt = managerMigrationSchema.parse({ migrationId, migrated, alreadyManaged, blocked });
        put("managerMigration", migrationId, receipt);
        return receipt;
      });
    },
    managerRuns(): readonly ManagerRun[] {
      return all("managerRun", managerRunSchema);
    },
    managerRunExit(launchKey: string): Json | null {
      return read("managerRunExit", idSchema.parse(launchKey), jsonSchema);
    },
    recordManagerRunExit(input: { readonly manager: Binding; readonly launchKey: string; readonly location: Json }): void {
      tx(() => {
        manager(input.manager);
        const run = read("managerRun", input.launchKey, managerRunSchema);
        if (run === null || run.location === null || !sameDocument(run.location, input.location)) throw new StoreFenceError("Exit observation does not match the original run");
        const previous = read("managerRunExit", run.launchKey, jsonSchema);
        if (previous !== null && !sameDocument(previous, input.location)) throw new StoreConflictError("Exit observation belongs to a different native location");
        if (previous === null) put("managerRunExit", run.launchKey, input.location);
      });
    },
    reserveManagerRun(input: { readonly manager: Binding; readonly itemId: string; readonly workflow: "pipeline" | "hotfix"; readonly limit: number; readonly target: string; readonly branch: string; readonly launchKey: string; readonly repository: string; readonly worktree: string }): Readonly<{ run: ManagerRun; created: boolean }> {
      pendingWrites();
      return tx(() => {
        manager(input.manager);
        const launchKey = idSchema.parse(input.launchKey);
        const itemId = idSchema.parse(input.itemId);
        const limit = z.number().int().min(1).max(input.workflow === "hotfix" ? 1 : 2).parse(input.limit);
        const target = z.string().trim().min(1).max(512).parse(input.target);
        const branch = z.string().trim().min(1).max(512).parse(input.branch);
        if (branch === target) throw new StoreAuthorityError("Run branch must differ from target");
        const repository = realpathSync(z.string().refine(isAbsolute).parse(input.repository));
        const worktree = realpathSync(z.string().refine(isAbsolute).parse(input.worktree));
        const prior = read("managerRun", launchKey, managerRunSchema);
        if (prior !== null) {
          if (prior.itemId !== itemId || prior.workflow !== input.workflow || prior.limit !== limit || prior.target !== target || (prior.branch !== undefined && prior.branch !== branch) || prior.repository !== repository || prior.worktree !== worktree) throw new StoreConflictError("Manager launch key belongs to a different request");
          return { run: prior, created: false };
        }
        const owner = read("queueOwner", itemId, queueOwnerSchema);
        const row = canonicalQueue().rows.find((entry) => entry.id === itemId);
        if (owner === null || row === undefined || row.status !== "QUEUED" || row.dispatched_at != null) throw new StoreAuthorityError("Manager run requires a captured, undispatched queued item");
        const event = read("intake", owner.eventId, intakeRecordSchema);
        const migrated = read("managerItem", itemId, managerItemSchema);
        if (event === null || (event.teamId !== null && (migrated === null || migrated.eventId !== owner.eventId || migrated.revision !== owner.revision || migrated.teamId !== event.teamId))) throw new StoreAuthorityError("Manager run requires manager ownership of the intake item");
        const runs = all("managerRun", managerRunSchema);
        const priorRuns = runs.filter((entry) => entry.itemId === itemId);
        if (priorRuns.some((entry) => entry.state !== "released")) throw new StoreConflictError("Item already has an unreconciled or completed run");
        if (priorRuns.some((entry) => entry.workflow !== input.workflow || entry.limit !== limit || entry.target !== target || entry.branch !== branch || entry.repository !== repository || entry.worktree !== worktree)) throw new StoreConflictError("Retry must preserve the original workflow, review limit, target and repository");
        const managerReviews = all("managerReview", managerReviewSchema).filter((entry) => entry.itemId === itemId && entry.state !== "failed" && entry.state !== "cancelled");
        if (managerReviews.some((entry) => entry.state !== "completed" || entry.verdict === null || entry.verdict === "approve")) throw new StoreAuthorityError("Prior manager review is unresolved or already approved");
        if (runs.some((entry) => (entry.worktree === worktree || (entry.repository === repository && entry.branch === branch)) && entry.state !== "released" && entry.termination === undefined)) throw new StoreConflictError("Worktree has an unreconciled manager run");
        const savedLimit = read("workflowLimit", itemId, z.number().int().min(1).max(3));
        const savedTarget = read("workflowTarget", itemId, z.string().min(1));
        const reviews = all("workflowReview", workflowReviewSchema).filter((entry) => entry.changeId === itemId);
        if (reviews.some((entry) => entry.state !== "completed" || entry.verdict === null || entry.verdict === "approve")) throw new StoreAuthorityError("Prior review is unresolved or already approved");
        const inheritedLimit = savedLimit ?? (reviews.length ? Math.min(...reviews.map((entry) => entry.limit)) : limit);
        if (limit + reviews.length > inheritedLimit || managerReviews.length >= limit) throw new StoreAuthorityError("Run exceeds the remaining inherited review limit");
        if (savedTarget !== null && target !== savedTarget) throw new StoreAuthorityError("Run target differs from the frozen target");
        if (savedLimit === null) put("workflowLimit", itemId, inheritedLimit);
        if (savedTarget === null) put("workflowTarget", itemId, target);
        const run = managerRunSchema.parse({ launchKey, itemId, eventId: owner.eventId, revision: owner.revision, workflow: input.workflow, limit, target, branch, repository, worktree, assignment: row, ownerEpoch: epoch, state: "starting", location: null, outcome: null });
        put("managerRun", launchKey, run);
        return { run, created: true };
      });
    },
    acceptManagerRun(input: { readonly manager: Binding; readonly launchKey: string; readonly location: Json }): ManagerRun {
      return tx(() => {
        manager(input.manager);
        const run = read("managerRun", input.launchKey, managerRunSchema);
        if (run === null || run.ownerEpoch !== epoch || run.state !== "starting") throw new StoreFenceError("Manager run is not an active launch in this owner epoch");
        if (input.location === null || typeof input.location !== "object" || Array.isArray(input.location) || Object.keys(input.location).length === 0) throw new StoreAuthorityError("Manager run requires a native location identity");
        const updated = managerRunSchema.parse({ ...run, state: "accepted", location: input.location });
        put("managerRun", run.launchKey, updated);
        return updated;
      });
    },
    settleManagerRun(input: { readonly manager: Binding; readonly launchKey: string; readonly state: "reported" | "failed" | "uncertain"; readonly outcome: Json }): ManagerRun {
      return tx(() => {
        manager(input.manager);
        const run = read("managerRun", input.launchKey, managerRunSchema);
        if (run === null || run.ownerEpoch !== epoch || (run.state !== "accepted" && run.state !== "reported" && !(run.state === "starting" && input.state === "uncertain"))) throw new StoreFenceError("Manager run has no current accepted launch");
        const updated = managerRunSchema.parse({ ...run, state: input.state === "reported" ? "accepted" : input.state, outcome: jsonSchema.parse(input.outcome) });
        put("managerRun", run.launchKey, updated);
        return updated;
      });
    },
    managerInputs(launchKey: string): readonly ManagerInput[] {
      return all("managerInput", managerInputSchema).filter((entry) => entry.launchKey === idSchema.parse(launchKey));
    },
    reserveManagerInput(input: { readonly manager: Binding; readonly launchKey: string; readonly messageId: string; readonly text: string }): Readonly<{ receipt: ManagerInput; created: boolean }> {
      return tx(() => {
        manager(input.manager);
        const launchKey = idSchema.parse(input.launchKey);
        const messageId = idSchema.parse(input.messageId);
        const text = z.string().min(1).max(100_000).parse(input.text);
        const id = createHash("sha256").update(JSON.stringify([launchKey, messageId])).digest("hex");
        const textDigest = createHash("sha256").update(text).digest("hex");
        const prior = read("managerInput", id, managerInputSchema);
        if (prior !== null) {
          if (prior.launchKey !== launchKey || prior.messageId !== messageId || prior.textDigest !== textDigest) throw new StoreConflictError("Input key belongs to a different message");
          return { receipt: prior, created: false };
        }
        const run = read("managerRun", launchKey, managerRunSchema);
        if (run === null || run.ownerEpoch !== epoch || (run.state !== "accepted" && run.state !== "reported")) throw new StoreFenceError("Input requires a current active manager run");
        const receipt = managerInputSchema.parse({ launchKey, messageId, textDigest, ownerEpoch: epoch, state: "sending" });
        put("managerInput", id, receipt);
        return { receipt, created: true };
      });
    },
    settleManagerInput(input: { readonly manager: Binding; readonly launchKey: string; readonly messageId: string; readonly state: "delivered" | "uncertain" }): ManagerInput {
      return tx(() => {
        manager(input.manager);
        const id = createHash("sha256").update(JSON.stringify([idSchema.parse(input.launchKey), idSchema.parse(input.messageId)])).digest("hex");
        const prior = read("managerInput", id, managerInputSchema);
        if (prior === null) throw new StoreFenceError("Input reservation is unavailable");
        if (prior.state === input.state) return prior;
        if (prior.state !== "sending" || prior.ownerEpoch !== epoch) throw new StoreFenceError("Input outcome is already settled or uncertain");
        const receipt = managerInputSchema.parse({ ...prior, state: input.state });
        put("managerInput", id, receipt);
        return receipt;
      });
    },
    reserveManagerReview(input: { readonly manager: Binding; readonly launchKey: string; readonly reviewId: string; readonly head: string }): ManagerReview {
      return tx(() => {
        manager(input.manager);
        const run = read("managerRun", input.launchKey, managerRunSchema);
        if (run === null || run.ownerEpoch !== epoch || run.state !== "accepted" && run.state !== "reported") throw new StoreFenceError("Review requires the current accepted run");
        const review = managerReviewSchema.parse({ reviewId: input.reviewId, launchKey: run.launchKey, itemId: run.itemId, head: input.head, reviewerId: null, invocationId: null, state: "active", verdict: null });
        const previous = read("managerReview", review.reviewId, managerReviewSchema);
        if (previous !== null) {
          if (previous.launchKey !== review.launchKey || previous.itemId !== review.itemId || previous.head !== review.head) throw new StoreConflictError("Review key belongs to another review");
          if (previous.state === "failed" || previous.state === "cancelled") throw new StoreConflictError("Review key is already closed; use a new assignment");
          return previous;
        }
        const reviews = all("managerReview", managerReviewSchema).filter((entry) => entry.itemId === run.itemId && entry.state !== "failed" && entry.state !== "cancelled");
        if (reviews.some((entry) => entry.state !== "completed")) throw new StoreConflictError("Existing review is active or uncertain");
        if (reviews.some((entry) => entry.verdict === "approve")) throw new StoreConflictError("Review already approved");
        if (reviews.length >= run.limit) throw new StoreConflictError("Review budget exhausted");
        put("managerReview", review.reviewId, review);
        return review;
      });
    },
    managerReviews(launchKey: string): readonly ManagerReview[] {
      return all("managerReview", managerReviewSchema).filter((review) => review.launchKey === idSchema.parse(launchKey));
    },
    bindManagerReview(input: { readonly manager: Binding; readonly reviewId: string; readonly reviewerId: string; readonly invocationId: string }): ManagerReview {
      return tx(() => {
        manager(input.manager);
        const review = read("managerReview", input.reviewId, managerReviewSchema);
        if (review === null) throw new StoreFenceError("Review reservation is unavailable");
        const reviewerId = idSchema.parse(input.reviewerId);
        const invocationId = idSchema.parse(input.invocationId);
        if (review.reviewerId !== null || review.invocationId !== null) {
          if (review.reviewerId !== reviewerId || review.invocationId !== invocationId) throw new StoreConflictError("Review is bound to another native invocation");
          return review;
        }
        if (all("managerReview", managerReviewSchema).some((entry) => entry.reviewId !== review.reviewId && entry.launchKey === review.launchKey && entry.invocationId === invocationId)) throw new StoreConflictError("Native invocation already belongs to another review");
        const run = read("managerRun", review.launchKey, managerRunSchema);
        if (run === null || run.ownerEpoch !== epoch || (run.state !== "accepted" && run.state !== "reported") || review.state !== "active") throw new StoreFenceError("Review binding requires its current active run");
        const bound = managerReviewSchema.parse({ ...review, reviewerId, invocationId });
        put("managerReview", review.reviewId, bound);
        return bound;
      });
    },
    async failManagerReview(input: { readonly manager: Binding; readonly reviewId: string; readonly verify: (review: ManagerReview, run: ManagerRun) => Promise<unknown> }): Promise<ManagerReview> {
      const original = tx(() => {
        manager(input.manager);
        const review = read("managerReview", input.reviewId, managerReviewSchema);
        if (review === null || review.reviewerId === null || review.invocationId === null || (review.state !== "active" && review.state !== "uncertain")) throw new StoreFenceError("Review has no unresolved bound native invocation");
        const run = read("managerRun", review.launchKey, managerRunSchema);
        if (run === null || run.location === null || run.state === "completed" || run.state === "released") throw new StoreFenceError("Review run has no verifiable original native identity");
        return { review, run };
      });
      const evidence = z.strictObject({ reviewId: idSchema, launchKey: idSchema, head: z.string(), reviewerId: idSchema, invocationId: idSchema, status: z.literal("invalid"), evidence: z.string().trim().min(1) }).parse(await input.verify(original.review, original.run));
      if (evidence.reviewId !== original.review.reviewId || evidence.launchKey !== original.run.launchKey || evidence.head !== original.review.head || evidence.reviewerId !== original.review.reviewerId || evidence.invocationId !== original.review.invocationId) throw new StoreAuthorityError("Invalid review evidence does not match its native reservation");
      return tx(() => {
        manager(input.manager);
        const review = read("managerReview", input.reviewId, managerReviewSchema);
        const run = read("managerRun", original.run.launchKey, managerRunSchema);
        if (review === null || run === null || !sameDocument(review, original.review) || !sameDocument({ ...run, outcome: original.run.outcome }, original.run)) throw new StoreFenceError("Review or run changed during verification");
        const failed = managerReviewSchema.parse({ ...review, state: "failed", resolution: evidence });
        put("managerReview", review.reviewId, failed);
        return failed;
      });
    },
    async cancelManagerReview(input: { readonly manager: Binding; readonly reviewId: string; readonly verify: (review: ManagerReview, run: ManagerRun) => Promise<unknown> }): Promise<ManagerReview> {
      const original = tx(() => {
        manager(input.manager);
        const review = read("managerReview", input.reviewId, managerReviewSchema);
        if (review === null || review.reviewerId !== null || review.invocationId !== null || (review.state !== "active" && review.state !== "uncertain")) throw new StoreFenceError("Review is not an unbound unresolved reservation");
        const run = read("managerRun", review.launchKey, managerRunSchema);
        if (run === null || run.location === null || run.state === "completed" || run.state === "released") throw new StoreFenceError("Review run has no verifiable original native identity");
        return { review, run };
      });
      const evidence = z.strictObject({ reviewId: idSchema, launchKey: idSchema, status: z.literal("not-dispatched"), evidence: z.string().trim().min(1) }).parse(await input.verify(original.review, original.run));
      if (evidence.reviewId !== original.review.reviewId || evidence.launchKey !== original.run.launchKey) throw new StoreAuthorityError("No-dispatch proof does not match the original review");
      return tx(() => {
        manager(input.manager);
        const review = read("managerReview", input.reviewId, managerReviewSchema);
        const run = read("managerRun", original.run.launchKey, managerRunSchema);
        if (review === null || run === null || !sameDocument(review, original.review) || !sameDocument({ ...run, outcome: original.run.outcome }, original.run)) throw new StoreFenceError("Review or run changed during verification");
        const cancelled = managerReviewSchema.parse({ ...review, state: "cancelled", resolution: evidence });
        put("managerReview", review.reviewId, cancelled);
        return cancelled;
      });
    },
    async settleManagerReview(input: { readonly manager: Binding; readonly reviewId: string; readonly verify: (review: ManagerReview, run: ManagerRun) => Promise<unknown> }): Promise<ManagerReview> {
      const original = tx(() => {
        manager(input.manager);
        const review = read("managerReview", input.reviewId, managerReviewSchema);
        if (review === null) throw new StoreFenceError("Review is unavailable");
        if (review.state === "completed") return { review, run: null };
        if (review.reviewerId === null || review.invocationId === null) throw new StoreFenceError("Review native identity is unavailable; reconcile the original dispatch");
        const run = read("managerRun", review.launchKey, managerRunSchema);
        if (run === null || run.location === null || run.state === "completed" || run.state === "released") throw new StoreFenceError("Review run has no verifiable original native identity");
        return { review, run };
      });
      if (original.run === null) return original.review;
      const evidence = managerReviewEvidenceSchema.parse(await input.verify(original.review, original.run));
      if (evidence.reviewId !== original.review.reviewId || evidence.launchKey !== original.run.launchKey || evidence.head !== original.review.head || evidence.reviewerId !== original.review.reviewerId || evidence.invocationId !== original.review.invocationId)
        throw new StoreAuthorityError("Verified review does not match its native reservation");
      return tx(() => {
        manager(input.manager);
        const review = read("managerReview", input.reviewId, managerReviewSchema);
        const run = read("managerRun", original.run.launchKey, managerRunSchema);
        if (review === null || run === null || !sameDocument(review, original.review) || !sameDocument({ ...run, outcome: original.run.outcome }, original.run)) throw new StoreFenceError("Review or run changed during verification");
        const settled = managerReviewSchema.parse({ ...review, state: "completed", verdict: evidence.verdict });
        put("managerReview", review.reviewId, settled);
        return settled;
      });
    },
    async completeManagerRun(input: { readonly manager: Binding; readonly launchKey: string; readonly verify: (run: ManagerRun) => Promise<unknown> }): Promise<ManagerRun> {
      pendingWrites();
      const original = tx(() => {
        manager(input.manager);
        const run = read("managerRun", input.launchKey, managerRunSchema);
        if (run === null || run.state === "starting" || run.state === "released" || run.location === null)
          throw new StoreFenceError("Manager run has no verifiable original native location");
        return run;
      });
      if (original.state === "completed") return original;
      const evidence = managerCompletionSchema.parse(await input.verify(original));
      if (evidence.launchKey !== original.launchKey || evidence.itemId !== original.itemId ||
          !sameDocument(evidence.location, original.location) ||
          evidence.repository !== original.repository || evidence.worktree !== original.worktree ||
          evidence.target !== original.target || evidence.review.head !== evidence.head ||
          evidence.review.rounds > original.limit || evidence.prDraft ||
          (evidence.prState === "MERGED" ? evidence.mergeCommit === null : evidence.mergeCommit !== null))
        throw new StoreAuthorityError("Verified completion does not match the original run, review or PR");
      pendingWrites();
      const intentId = `manager-complete/${original.launchKey}`;
      tx(() => {
        manager(input.manager);
        const current = read("managerRun", input.launchKey, managerRunSchema);
        if (current === null || !sameDocument({ ...current, outcome: original.outcome }, original))
          throw new StoreFenceError("Manager run changed during completion verification");
        const owner = read("queueOwner", current.itemId, queueOwnerSchema);
        if (owner === null || owner.eventId !== current.eventId || owner.revision !== current.revision)
          throw new StoreFenceError("Manager run item changed during completion verification");
        const reviews = all("managerReview", managerReviewSchema).filter((review) => review.itemId === current.itemId && review.state === "completed");
        const review = reviews.find((entry) => entry.reviewId === evidence.review.reviewId);
        if (review === undefined || review.verdict !== "approve" || review.head !== evidence.head || review.reviewerId !== evidence.review.reviewerId || review.invocationId !== evidence.review.invocationId || review.launchKey !== current.launchKey || reviews.length !== evidence.review.rounds)
          throw new StoreAuthorityError("Completion requires the independently verified exact-head review receipt");
        const document = canonicalQueue();
        const row = document.rows.find((entry) => entry.id === current.itemId);
        if (row === undefined || row.status !== "QUEUED") throw new StoreFenceError("Manager run queue item is no longer queued");
        const status = evidence.prState === "MERGED" ? "MERGED" : "READY_TO_LAND";
        const nextRow = rowSchema.parse({ ...row, status });
        const after = queueText(document, document.rows.map((entry) => entry.id === current.itemId ? nextRow : entry));
        put("intent", intentId, { file: "queue.json", before: document.before, after, state: "pending", capture: null,
          managerCompletion: { original: current, evidence, revision: owner.revision + 1, status } });
      });
      applyIntent(intentId);
      const completed = read("managerRun", original.launchKey, managerRunSchema);
      if (completed === null || completed.state !== "completed") throw new StoreRecoveryError("Manager completion did not persist");
      return completed;
    },
    async releaseUndispatchedManagerRun(input: { readonly manager: Binding; readonly launchKey: string; readonly verify: (run: ManagerRun) => Promise<unknown> }): Promise<ManagerRun> {
      pendingWrites();
      const original = tx(() => {
        manager(input.manager);
        const run = read("managerRun", input.launchKey, managerRunSchema);
        if (run === null || run.location !== null || (run.state !== "starting" && run.state !== "uncertain")) throw new StoreFenceError("Run is not an unlocated pending launch");
        return run;
      });
      const evidence = z.strictObject({ launchKey: idSchema, itemId: idSchema, status: z.literal("not-dispatched"), evidence: z.string().trim().min(1) }).parse(await input.verify(original));
      if (evidence.launchKey !== original.launchKey || evidence.itemId !== original.itemId) throw new StoreAuthorityError("No-dispatch proof does not match the original run");
      pendingWrites();
      return tx(() => {
        manager(input.manager);
        const current = read("managerRun", input.launchKey, managerRunSchema);
        if (current === null || !sameDocument(current, original)) throw new StoreFenceError("Run changed during no-dispatch verification");
        const released = managerRunSchema.parse({ ...current, state: "released", termination: evidence });
        put("managerRun", current.launchKey, released);
        return released;
      });
    },
    async releaseManagerRun(input: { readonly manager: Binding; readonly launchKey: string; readonly verify: (run: ManagerRun) => Promise<unknown> }): Promise<ManagerRun> {
      pendingWrites();
      const original = tx(() => {
        manager(input.manager);
        const run = read("managerRun", input.launchKey, managerRunSchema);
        if (run === null || run.state === "starting" || run.state === "released" || run.location === null)
          throw new StoreFenceError("Manager run has no verifiable original native location");
        return run;
      });
      const evidence = managerTerminationSchema.parse(await input.verify(original));
      if (evidence.launchKey !== original.launchKey || evidence.itemId !== original.itemId || !sameDocument(evidence.location, original.location))
        throw new StoreAuthorityError("Verified termination does not match the original run");
      pendingWrites();
      return tx(() => {
        manager(input.manager);
        const current = read("managerRun", input.launchKey, managerRunSchema);
        if (current === null || !sameDocument({ ...current, outcome: original.outcome }, original))
          throw new StoreFenceError("Manager run changed during termination verification");
        const released = managerRunSchema.parse({ ...current, state: current.state === "completed" ? "completed" : evidence.outcome === "failed-no-effect" ? "released" : "uncertain", termination: evidence });
        put("managerRun", current.launchKey, released);
        return released;
      });
    },
    queueItems(): readonly z.infer<typeof rowSchema>[] {
      return canonicalQueue().rows;
    },
    transitionItem(input: {
      readonly employee: Binding;
      readonly request: ItemAction;
    }): ItemTransition {
      pendingWrites();
      const receipt: ItemTransition = tx(() => {
        const sender = actor(input.employee);
        const request = itemActionSchema.parse(input.request);
        if (read("managerItem", request.itemId, managerItemSchema) !== null) throw new StoreAuthorityError("Item belongs to manager execution");
        const ownership = read("queueOwner", request.itemId, queueOwnerSchema);
        const event =
          ownership === null
            ? null
            : read("intake", ownership.eventId, intakeRecordSchema);
        if (
          ownership === null ||
          event?.teamId === null ||
          event?.teamId === undefined
        )
          throw new StoreAuthorityError(
            "Canonical item has no owning delegated team",
          );
        const current = team(event.teamId);
        if (
          sender.role !== "manager" &&
          (sender.assignment !== current.id ||
            !members(current).includes(sender.id))
        )
          throw new StoreAuthorityError(
            "Item transition is outside the current owning team",
          );
        const previous = read(
          "itemTransition",
          request.requestId,
          itemTransitionSchema,
        );
        if (previous !== null) {
          assertReplay(previous.request, request, request.requestId);
          if (previous.actorId !== sender.id)
            throw new StoreAuthorityError(
              "Item receipt belongs to another actor",
            );
          return previous;
        }
        if (current.state === "finished")
          throw new StoreAuthorityError(
            "Finished team cannot transition items",
          );
        if (
          ownership.revision !== request.expectedRevision ||
          !current.items.some(
            (item) =>
              item.id === request.itemId &&
              item.revision === request.expectedRevision,
          )
        )
          throw new StoreConflictError("Item transition has a stale revision");
        const document = canonicalQueue();
        const row = document.rows.find((row) => row.id === request.itemId);
        if (!row)
          throw new StoreRecoveryError("Canonical item row is unavailable");
        const status = z.string().parse(row.status);
        let nextStatus = status;
        let execution = read(
          "itemExecution",
          request.itemId,
          itemExecutionSchema,
        );
        const cues: { sender: Employee; cue: Cue; teamId: string }[] = [];
        const evidence =
          request.action === "qa" ? request.proof : request.evidence;
        if (evidence === null)
          throw new StoreAuthorityError(
            "Item transition requires explicit evidence",
          );
        const leader =
          sender.role === "manager" || sender.id === current.architect;
        const cue = (recipient: string, kind: Cue["kind"], payload: Json) => {
          const value: Cue = {
            id: `item-${request.requestId}-${recipient}`,
            recipient,
            kind,
            correlation: request.itemId,
            payload,
          };
          route(sender, value);
          cues.push({ sender, cue: value, teamId: current.id });
          return value.id;
        };
        const resolved = (value: ItemExecution | null): boolean =>
          value === null ||
          ![value.messageId, value.qaMessageId].some(
            (id) =>
              id !== null &&
              (all("claim", claimSchema).some(
                (claim) => claim.messageId === id && claim.status !== "settled",
              ) ||
                all("assignment", assignmentSchema).some(
                  (assignment) =>
                    assignment.id === id && assignment.state !== "complete",
                )),
          );
        const completedResult = (
          resultId: string,
          messageId: string,
          employeeId: string,
          generation: number,
        ) => {
          const saved = read("result", resultId, resultRecordSchema);
          const claim =
            saved === null ? null : read("claim", saved.claimId, claimSchema);
          if (
            saved === null ||
            saved.result.kind !== "completed" ||
            claim?.messageId !== messageId ||
            claim.employeeId !== employeeId ||
            claim.generation !== generation ||
            claim.status !== "settled"
          )
            throw new StoreAuthorityError(
              "Item requires its own durable completed assignment result",
            );
          return saved.result;
        };
        switch (request.action) {
          case "assign": {
            if (!leader || status !== "QUEUED" || !ready(current))
              throw new StoreAuthorityError(
                "Only the ready own-team architect or manager may assign a queued item",
              );
            if (!resolved(execution))
              throw new StoreRecoveryError(
                "Resolve prior item claims and assignments before another execution",
              );
            if (!current.devs.includes(request.employeeId))
              throw new StoreAuthorityError(
                "Item assignee must be an owning team dev",
              );
            assertNoUnresolvedWork(request.employeeId, "Item dev");
            const member = employee(request.employeeId);
            const messageId = cue(member.id, "assignment", {
              kind: "item-execution",
              itemId: row.id,
              eventId: ownership.eventId,
              teamId: current.id,
              revision: ownership.revision + 1,
              directive: request.evidence,
              reportTo: current.architect,
              instruction: "Execute directive as the current attempt scope; snapshot preserves original intake. Implement requested rework even when the original procedure was review-only. Preserve explicit user restrictions. After completed settlement, submit startup_item review with the saved resultId and current revision. Settlement reports the result to reportTo automatically.",
              snapshot: row,
            });
            execution = itemExecutionSchema.parse({
              itemId: row.id,
              eventId: ownership.eventId,
              teamId: current.id,
              attemptId: request.requestId,
              employeeId: member.id,
              generation: member.generation,
              messageId,
              qaMessageId: null,
              qaGeneration: null,
              reviewResultId: null,
              qa: null,
              snapshot: row,
            });
            nextStatus = "EXECUTING";
            break;
          }
          case "review": {
            if (
              status !== "EXECUTING" ||
              execution === null ||
              execution.employeeId !== sender.id ||
              execution.generation !== sender.generation
            )
              throw new StoreAuthorityError(
                "Only the current assigned dev may submit item review",
              );
            completedResult(
              request.resultId,
              execution.messageId,
              sender.id,
              sender.generation,
            );
            execution = { ...execution, reviewResultId: request.resultId };
            nextStatus = "REVIEW";
            cue(current.architect, "report", {
              kind: "item-review",
              itemId: row.id,
              resultId: request.resultId,
            });
            break;
          }
          case "qa_assign": {
            if (
              sender.id !== current.architect ||
              status !== "REVIEW" ||
              execution === null ||
              execution.reviewResultId === null ||
              execution.qaMessageId !== null ||
              !ready(current)
            )
              throw new StoreAuthorityError(
                "Only the owning architect may assign pending QA review",
              );
            assertNoUnresolvedWork(current.qa, "QA");
            execution = {
              ...execution,
              qaGeneration: employee(current.qa).generation,
              qaMessageId: cue(current.qa, "assignment", {
                kind: "item-qa",
                itemId: row.id,
                eventId: ownership.eventId,
                revision: ownership.revision + 1,
                resultId: execution.reviewResultId,
              }),
            };
            break;
          }
          case "qa": {
            if (
              sender.id !== current.qa ||
              status !== "REVIEW" ||
              execution?.qaMessageId === null ||
              execution?.qaMessageId === undefined
            )
              throw new StoreAuthorityError(
                "Only the owning assigned QA may record proof",
              );
            const result = completedResult(
              request.resultId,
              execution.qaMessageId,
              sender.id,
              sender.generation,
            );
            if (execution.qaGeneration !== sender.generation)
              throw new StoreFenceError("QA execution generation has changed");
            if (!sameDocument(result.output, request.proof))
              throw new StoreConflictError(
                "QA proof must equal its saved result",
              );
            execution = {
              ...execution,
              qa: {
                verdict: request.verdict,
                resultId: request.resultId,
                proof: request.proof,
              },
            };
            cue(current.architect, "report", {
              kind: "item-qa-verdict",
              itemId: row.id,
              resultId: request.resultId,
              verdict: request.verdict,
            });
            break;
          }
          case "gate": {
            if (
              sender.id !== current.architect ||
              status !== "REVIEW" ||
              execution === null
            )
              throw new StoreAuthorityError(
                "Only the owning architect may gate review",
              );
            if (
              request.verdict === "APPROVE" &&
              execution.qa?.verdict !== "APPROVE"
            )
              throw new StoreAuthorityError(
                "Architect approval requires matching completed QA proof",
              );
            if (!resolved(execution))
              throw new StoreRecoveryError(
                "Reconcile item claims and assignments before gate or REDO",
              );
            nextStatus =
              request.verdict === "APPROVE" ? "READY_TO_LAND" : "QUEUED";
            cue("manager", "report", {
              kind: "item-architect-gate",
              itemId: row.id,
              verdict: request.verdict,
            });
            break;
          }
          case "decide": {
            if (!leader)
              throw new StoreAuthorityError(
                "Only the manager or own architect may record item decisions",
              );
            if (
              ["MERGED", "DONE", "REJECTED"].includes(request.status) &&
              sender.role !== "manager"
            )
              throw new StoreAuthorityError(
                "Only the manager may record authorized item completion",
              );
            if (
              ["MERGED", "DONE"].includes(request.status) &&
              status !== "READY_TO_LAND"
            )
              throw new StoreAuthorityError(
                "Completion requires READY_TO_LAND review gates",
              );
            if ((request.status === "MERGED" || request.status === "DONE") && row.kind === "code") {
              const proof = z.object({ reviewReservationId: idSchema, head: z.string().trim().min(1) }).parse(request.evidence);
              const review = read("workflowReview", proof.reviewReservationId, workflowReviewSchema);
              if (review === null || review.changeId !== request.itemId || review.head !== proof.head ||
                  review.state !== "completed" || review.verdict !== "approve" || execution?.employeeId === review.reviewerId)
                throw new StoreAuthorityError("Landing requires an approved review for this change and exact head");
            }
            if (
              request.status === "QUEUED" &&
              !["BLOCKED", "NEEDS_DECISION"].includes(status)
            )
              throw new StoreAuthorityError(
                "Explicit resume requires blocked or decision state",
              );
            if (
              (request.status === "QUEUED" ||
                terminalItemStatuses.includes(request.status)) &&
              (!resolved(execution) ||
                all("grant", grantSchema).some(
                  (grant) =>
                    members(current).includes(grant.employeeId) &&
                    grant.state !== "released",
                ))
            )
              throw new StoreRecoveryError(
                "Reconcile item claims, assignments and grants before resume or completion",
              );
            if (terminalItemStatuses.includes(status))
              throw new StoreAuthorityError(
                "Terminal item requires a linked follow-up",
              );
            nextStatus = request.status;
            break;
          }
        }
        const revision = ownership.revision + 1;
        const refs =
          row.startup_state_refs === undefined
            ? []
            : z.array(jsonSchema).parse(row.startup_state_refs);
        const nextRow = rowSchema.parse({
          ...row,
          status: nextStatus,
          ...(request.action === "assign"
            ? { dispatched_at: row.dispatched_at ?? now() }
            : {}),
          startup_state_refs: [...refs, request.requestId],
        });
        const after = queueText(document, document.rows.map((old) => old.id === row.id ? nextRow : old));
        const receipt = itemTransitionSchema.parse({
          request,
          actorId: sender.id,
          eventId: ownership.eventId,
          teamId: current.id,
          revision,
          status: nextStatus,
          row: nextRow,
          execution,
          cues,
        });
        put("intent", `item/${request.requestId}`, {
          file: "queue.json",
          before: document.before,
          after,
          state: "pending",
          capture: null,
          item: receipt,
        });
        return receipt;
      });
      applyIntent(`item/${receipt.request.requestId}`);
      return receipt;
    },
    finishTeam(input: {
      readonly manager: Binding;
      readonly teamId: string;
      readonly evidence: Json;
    }): Team {
      return tx((): Team => {
        manager(input.manager);
        jsonSchema.parse(input.evidence);
        const current: Team = team(input.teamId);
        if (current.state === "finished") return current;
        if (
          !all("capture", captureRecordSchema).some(
            (capture): boolean => capture.teamId === current.id,
          )
        )
          throw new StoreConflictError(
            "A team cannot finish before its architect records intake capture",
          );
        const rows = canonicalQueue().rows;
        if (
          current.items.some((item) => {
            const ownership = read("queueOwner", item.id, queueOwnerSchema);
            return (
              ownership?.eventId === current.eventId &&
              !terminalItemStatuses.includes(
                z
                  .string()
                  .parse(rows.find((row) => row.id === item.id)?.status),
              )
            );
          })
        )
          throw new StoreConflictError(
            "Team has currently owned nonterminal canonical items",
          );
        return workflow({ kind: "settle", role: "manager", reservationId: current.id, outcome: "completed" }, () => {
        for (const id of members(current)) {
          if (
            all("grant", grantSchema).some(
              (grant): boolean =>
                grant.employeeId === id && grant.state !== "released",
            ) ||
            all("claim", claimSchema).some(
              (claim): boolean =>
                claim.employeeId === id && claim.status !== "settled",
            ) ||
            all("assignment", assignmentSchema).some(
              (assignment): boolean =>
                assignment.employeeId === id && assignment.state !== "complete",
            ) ||
            all("message", messageSchema).some(
              (message): boolean =>
                (message.recipient === id || message.sender === id) &&
                message.status !== "acknowledged",
            )
          )
            throw new StoreConflictError(
              `Team member ${id} has unresolved work, mail or target grants`,
            );
          put("employee", id, { ...employee(id), assignment: null });
        }
        put("teamCompletion", current.id, input.evidence);
        const finished: Team = { ...current, state: "finished" };
        put("team", current.id, finished);
        return finished;
        });
      });
    },
    workflowContext(input: { readonly employee: Binding; readonly itemId: string }): Readonly<{ itemId: string; claimId: string; teamId: string; employeeId: string; generation: number; ownerEpoch: number; assignment: Json }> {
      return tx(() => {
        const current = actor(input.employee);
        const itemId = idSchema.parse(input.itemId);
        const execution = read("itemExecution", itemId, itemExecutionSchema);
        const ownership = read("queueOwner", itemId, queueOwnerSchema);
        if (execution === null || ownership === null || execution.employeeId !== current.id ||
            execution.generation !== current.generation || current.assignment !== execution.teamId ||
            ownership.eventId !== execution.eventId)
          throw new StoreAuthorityError("Bounded context requires the current assigned item execution");
        const claim = selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status')='active'", [current.id], claimSchema)
          .find((entry) => entry.messageId === execution.messageId && entry.generation === current.generation && entry.ownerEpoch === epoch);
        if (claim === undefined) throw new StoreAuthorityError("Bounded context requires the active current-epoch item claim");
        const message = read("message", claim.messageId, messageSchema);
        if (message === null || message.status !== "claimed" || message.recipient !== current.id)
          throw new StoreFenceError("Claimed item assignment is unavailable");
        return { itemId, claimId: claim.id, teamId: execution.teamId, employeeId: current.id, generation: current.generation, ownerEpoch: epoch, assignment: message.payload };
      });
    },
    invalidateWorkflowEmployee(input: { readonly employeeId: string; readonly generation: number }): void {
      tx(() => {
        const claims = selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status')='active'", [input.employeeId], claimSchema)
          .filter((claim) => claim.generation === input.generation && claim.ownerEpoch === epoch);
        for (const claim of claims) {
          const children = selected("SELECT payload FROM records WHERE kind='workflowChild' AND json_extract(payload,'$.claimId')=?", [claim.id], workflowChildSchema);
          for (const child of children) if (child.state === "active") put("workflowChild", child.id, { ...child, state: "uncertain" });
        }
        const launches = selected("SELECT payload FROM records WHERE kind='workflowLaunch' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.generation')=?", [input.employeeId, input.generation], workflowLaunchSchema);
        for (const launch of launches) if (launch.ownerEpoch === epoch && (launch.state === "starting" || launch.state === "accepted")) {
          put("workflowLaunch", launch.launchKey, { ...launch, state: "uncertain" });
          const factory = read("workflowFactoryScope", launch.scopeId, workflowFactoryScopeSchema);
          const plan = read("workflowPlan", launch.scopeId, workflowPlanSchema);
          if (plan?.state === "active") put("workflowPlan", launch.scopeId, { ...plan, state: "uncertain" });
          for (const item of factory?.items ?? []) {
            const children = selected("SELECT payload FROM records WHERE kind='workflowChild' AND json_extract(payload,'$.claimId')=?", [item.claimId], workflowChildSchema);
            for (const child of children) if (child.state === "active") put("workflowChild", child.id, { ...child, state: "uncertain" });
          }
        }
      });
    },
    setWorkflowLimit(input: { readonly manager: Binding; readonly itemId: string; readonly limit: number; readonly target: string }): number {
      return tx(() => {
        manager(input.manager);
        const itemId = idSchema.parse(input.itemId);
        const limit = z.number().int().min(1).max(3).parse(input.limit);
        const target = z.string().trim().min(1).max(512).parse(input.target);
        const previousTarget = read("workflowTarget", itemId, z.string().min(1));
        if (previousTarget !== null && previousTarget !== target) throw new StoreConflictError("The manager-selected landing target is immutable");
        if (read("queueOwner", itemId, queueOwnerSchema) === null) throw new StoreAuthorityError("Review limit requires a canonical item");
        const previous = read("workflowLimit", itemId, z.number().int().min(1).max(3));
        const reviews = selected("SELECT payload FROM records WHERE kind='workflowReview' AND json_extract(payload,'$.changeId')=?", [itemId], workflowReviewSchema);
        if ((previous !== null && previous !== limit) || reviews.some((entry) => entry.limit !== limit))
          throw new StoreConflictError("The manager-selected review limit is immutable");
        if (previous === null) put("workflowLimit", itemId, limit);
        if (previousTarget === null) put("workflowTarget", itemId, target);
        return limit;
      });
    },
    createWorkflowAuthority(input: {
      readonly employee: Binding; readonly itemId: string; readonly claimId: string;
      readonly workflow: "pipeline" | "hotfix"; readonly limit: number; readonly launchKey: string;
      readonly assertConnection: () => void;
    }) {
      const validate = () => {
        input.assertConnection();
        const current = actor(input.employee);
        const claim = read("claim", input.claimId, claimSchema);
        const execution = read("itemExecution", input.itemId, itemExecutionSchema);
        const owner = read("queueOwner", input.itemId, queueOwnerSchema);
        if (claim === null || claim.status !== "active" || claim.ownerEpoch !== epoch ||
            claim.employeeId !== current.id || claim.generation !== current.generation ||
            execution === null || execution.messageId !== claim.messageId ||
            execution.employeeId !== current.id || execution.generation !== current.generation ||
            current.assignment !== execution.teamId || owner?.eventId !== execution.eventId)
          throw new StoreFenceError("Bounded authority requires its original active item claim and employee generation");
      };
      const rootId = tx(() => {
        validate();
        const cap = read("workflowLimit", input.itemId, z.number().int().min(1).max(3));
        const modeCap = input.workflow === "hotfix" ? 1 : 2;
        if (cap === null || read("workflowTarget", input.itemId, z.string().min(1)) === null || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > cap || input.limit > modeCap)
          throw new StoreAuthorityError("Bounded scope requires a manager-selected inherited review limit within its workflow cap");
        const launchKey = idSchema.parse(input.launchKey);
        if (read("workflowLaunch", launchKey, workflowLaunchSchema) !== null)
          throw new StoreConflictError("Workflow launch key was already attempted; reconcile before retrying");
        const id = randomUUID();
        put("workflowScope", id, workflowScopeSchema.parse({ id, parentId: null, itemId: input.itemId, claimId: input.claimId, employeeId: input.employee.employeeId, generation: input.employee.generation, ownerEpoch: epoch, workflow: input.workflow, limit: input.limit }));
        put("workflowLaunch", launchKey, workflowLaunchSchema.parse({ launchKey, scopeId: id, claimId: input.claimId, employeeId: input.employee.employeeId, generation: input.employee.generation, ownerEpoch: epoch, state: "starting", location: null }));
        put("workflowRunClaim", `${launchKey}/${input.claimId}`, { launchKey, claimId: input.claimId });
        return id;
      });
      const scope = (id: string) => {
        validate();
        const saved = read("workflowScope", id, workflowScopeSchema);
        if (saved === null || saved.claimId !== input.claimId || saved.itemId !== input.itemId ||
            saved.employeeId !== input.employee.employeeId || saved.generation !== input.employee.generation || saved.ownerEpoch !== epoch)
          throw new StoreAuthorityError("Bounded scope does not belong to the active claim");
        return saved;
      };
      const view = (id: string): WorkflowView => {
        const saved = scope(id);
        const children = selected("SELECT payload FROM records WHERE kind='workflowChild' AND json_extract(payload,'$.claimId')=?", [input.claimId], workflowChildSchema);
        return { scope: { kind: "bounded", itemIds: [saved.itemId] }, admitted: [saved.itemId],
          reservations: children.map((child) => ({ id: child.id, itemIds: [child.itemId], state: child.state, purpose: "assignment" as const, assignmentKey: child.assignmentKey, ...(child.role ? { role: child.role } : {}), ...(child.roleEvidence ? { roleEvidence: child.roleEvidence } : {}) })),
          completedItemIds: [], graphFrozen: true,
          reviews: selected("SELECT payload FROM records WHERE kind='workflowReview' AND json_extract(payload,'$.changeId')=?", [saved.itemId], workflowReviewSchema), reviewLimit: saved.limit, workflow: saved.workflow };
      };
      return {
        launchState: (state: "accepted" | "uncertain", location: Json | null): void => tx(() => {
          validate();
          const saved = read("workflowLaunch", input.launchKey, workflowLaunchSchema);
          if (saved === null || saved.scopeId !== rootId || saved.state !== "starting")
            throw new StoreFenceError("Workflow launch intent is no longer pending");
          put("workflowLaunch", input.launchKey, { ...saved, state, location });
        }),
        rootId,
        finishRun: (scopeId: string, handoff: WorkflowRunHandoff): void => tx(() => {
          if (scopeId !== rootId) throw new StoreAuthorityError("Only the root run may hand off");
          scope(rootId);
          const launch = read("workflowLaunch", input.launchKey, workflowLaunchSchema);
          if (launch === null || launch.scopeId !== rootId || launch.state !== "accepted") throw new StoreFenceError("Bounded run is not eligible for handoff");
          const children = selected("SELECT payload FROM records WHERE kind='workflowChild' AND json_extract(payload,'$.claimId')=?", [input.claimId], workflowChildSchema).filter((child) => {
            let cursor: string | null = child.scopeId;
            while (cursor !== null && cursor !== rootId) cursor = read("workflowScope", cursor, workflowScopeSchema)?.parentId ?? null;
            return cursor === rootId;
          });
          if (handoff.items.length !== 1 || handoff.items[0]?.itemId !== input.itemId) throw new StoreAuthorityError("Handoff must cover exactly the frozen item");
          requireWorkflowHandoff(children, input.workflow, handoff.items[0]);
          put("workflowLaunch", input.launchKey, workflowLaunchSchema.parse({ ...launch, state: "closed", handoff }));
        }),
        finishTarget: (scopeId: string, itemId: string): string | null => tx(() => {
          const saved = scope(scopeId);
          return saved.itemId === itemId ? read("workflowTarget", saved.itemId, z.string().min(1)) : null;
        }),
        view: (id: string): WorkflowView => tx(() => view(id)),
        nest: (parentId: string, childWorkflow: "factory" | "pipeline" | "hotfix", itemIds: readonly string[], limit: number): string => tx(() => {
          const parent = scope(parentId);
          if (itemIds.length !== 1 || itemIds[0] !== parent.itemId) throw new StoreAuthorityError("Nested scope must retain the parent item");
          const id = randomUUID();
          return executeWorkflow({ kind: "nest", role: "owner", runId: id, workflow: childWorkflow, limit }, {
            transaction: (run) => run(), read: () => view(parentId),
            apply: () => { put("workflowScope", id, workflowScopeSchema.parse({ ...parent, id, parentId, workflow: childWorkflow, limit })); return id; },
          });
        }),
        reserve: (scopeId: string, itemId: string, assignmentKey: string, role?: WorkflowRoleAssignment): string => tx(() => {
          const parent = scope(scopeId);
          if (itemId !== parent.itemId) throw new StoreAuthorityError("Child work is outside the parent item");
          const id = randomUUID();
          return executeWorkflow({ kind: "reserve", role: "owner", itemIds: [itemId], reservationId: id, purpose: "assignment", assignmentKey }, {
            transaction: (run) => run(), read: () => view(scopeId),
            apply: () => { put("workflowChild", id, workflowChildSchema.parse({ id, scopeId, claimId: input.claimId, itemId, assignmentKey, state: "active", ...(role === undefined ? {} : { role }) })); return id; },
          });
        }),
        settle: (scopeId: string, reservationId: string, outcome: "completed" | "failed" | "uncertain"): void => tx(() => {
          scope(scopeId);
          const child = read("workflowChild", reservationId, workflowChildSchema);
          if (child === null || child.scopeId !== scopeId || child.claimId !== input.claimId) throw new StoreAuthorityError("Child reservation is outside the parent scope");
          if (child.role !== undefined && outcome === "completed") throw new StoreAuthorityError("Role assignments require a correlated role proof");
          executeWorkflow({ kind: "settle", role: "owner", reservationId, outcome }, {
            transaction: (run) => run(), read: () => view(scopeId),
            apply: () => { put("workflowChild", reservationId, { ...child, state: outcome }); },
          });
        }),
        settleRole: (scopeId: string, reservationId: string, proof: WorkflowRoleReceipt): void => tx(() => {
          scope(scopeId);
          const child = read("workflowChild", reservationId, workflowChildSchema);
          if (child === null || child.scopeId !== scopeId || child.claimId !== input.claimId || child.itemId !== proof.itemId || child.role?.kind !== proof.role)
            throw new StoreAuthorityError("Role proof is outside its reserved item and role");
          executeWorkflow({ kind: "settle", role: "owner", reservationId, outcome: "completed" }, {
            transaction: (run) => run(), read: () => view(scopeId),
            apply: () => { put("workflowChild", reservationId, workflowChildSchema.parse({ ...child, state: "completed", proof })); },
          });
        }),
        settleRoleWithoutProof: (scopeId: string, reservationId: string, role: { itemId: string; role: WorkflowRoleAssignment["kind"] }): void => tx(() => {
          scope(scopeId);
          const child = read("workflowChild", reservationId, workflowChildSchema);
          if (child === null || child.scopeId !== scopeId || child.claimId !== input.claimId || child.itemId !== role.itemId || child.role?.kind !== role.role)
            throw new StoreAuthorityError("Role completion is outside its reserved item and role");
          executeWorkflow({ kind: "settle", role: "owner", reservationId, outcome: "completed" }, {
            transaction: (run) => run(), read: () => view(scopeId),
            apply: () => { put("workflowChild", reservationId, workflowChildSchema.parse({ ...child, state: "completed", roleEvidence: "invalid" })); },
          });
        }),
      };
    },
    createFactoryAuthority(input: { readonly manager: Binding; readonly itemIds: readonly string[]; readonly limit: number; readonly launchKey: string; readonly assertConnection: () => void }) {
      const root = tx(() => {
        input.assertConnection();
        const leader = manager(input.manager);
        const itemIds = input.itemIds.map((id) => idSchema.parse(id));
        const limit = z.number().int().min(1).max(3).parse(input.limit);
        if (itemIds.length === 0 || new Set(itemIds).size !== itemIds.length) throw new StoreAuthorityError("Factory requires distinct canonical items");
        const launchKey = idSchema.parse(input.launchKey);
        if (read("workflowLaunch", launchKey, workflowLaunchSchema) !== null) throw new StoreConflictError("Workflow launch key was already attempted; reconcile before retrying");
        const assignments: Json[] = [];
        const items = itemIds.map((itemId) => {
          const owner = read("queueOwner", itemId, queueOwnerSchema);
          const execution = read("itemExecution", itemId, itemExecutionSchema);
          const cap = read("workflowLimit", itemId, z.number().int().min(1).max(3));
          if (owner === null || execution === null || owner.eventId !== execution.eventId || cap === null || read("workflowTarget", itemId, z.string().min(1)) === null || limit > cap)
            throw new StoreAuthorityError("Factory items require a current execution and manager-selected inherited cap");
          const worker = employee(execution.employeeId);
          if (worker.generation !== execution.generation || worker.assignment !== execution.teamId)
            throw new StoreFenceError("Factory item worker is no longer assigned");
          const claim = selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status')='active'", [worker.id], claimSchema)
            .find((entry) => entry.messageId === execution.messageId && entry.generation === worker.generation && entry.ownerEpoch === epoch);
          const message = claim === undefined ? null : read("message", claim.messageId, messageSchema);
          if (claim === undefined || message === null || message.status !== "claimed") throw new StoreAuthorityError("Factory requires each item's active authenticated claim");
          assignments.push({ itemId, assignment: message.payload });
          return { itemId, claimId: claim.id, employeeId: worker.id, generation: worker.generation, teamId: execution.teamId, limit: cap };
        });
        const id = randomUUID();
        put("workflowFactoryScope", id, workflowFactoryScopeSchema.parse({ id, parentId: null, managerId: leader.id, generation: leader.generation, ownerEpoch: epoch, workflow: "factory", limit, items }));
        put("workflowLaunch", launchKey, workflowLaunchSchema.parse({ launchKey, scopeId: id, claimId: id, employeeId: leader.id, generation: leader.generation, ownerEpoch: epoch, state: "starting", location: null }));
        for (const item of items) put("workflowRunClaim", `${launchKey}/${item.claimId}`, { launchKey, claimId: item.claimId });
        return { id, assignments };
      });
      const scope = (id: string) => {
        input.assertConnection();
        const leader = manager(input.manager);
        const saved = read("workflowFactoryScope", id, workflowFactoryScopeSchema);
        if (saved === null || saved.managerId !== leader.id || saved.generation !== leader.generation || saved.ownerEpoch !== epoch)
          throw new StoreFenceError("Factory scope no longer belongs to its manager generation");
        for (const item of saved.items) {
          const claim = read("claim", item.claimId, claimSchema);
          const execution = read("itemExecution", item.itemId, itemExecutionSchema);
          const owner = read("queueOwner", item.itemId, queueOwnerSchema);
          const worker = employee(item.employeeId);
          if (claim?.status !== "active" || claim.ownerEpoch !== epoch || claim.employeeId !== item.employeeId || claim.generation !== item.generation ||
              execution?.messageId !== claim.messageId || execution.teamId !== item.teamId || execution.generation !== item.generation ||
              execution.employeeId !== item.employeeId || owner?.eventId !== execution.eventId || worker.generation !== item.generation || worker.assignment !== item.teamId)
            throw new StoreFenceError("Factory item claim or team changed; reconcile the frozen scope");
        }
        return saved;
      };
      const view = (id: string): WorkflowView => {
        const saved = scope(id);
        const children = saved.items.flatMap((item) => selected("SELECT payload FROM records WHERE kind='workflowChild' AND json_extract(payload,'$.claimId')=?", [item.claimId], workflowChildSchema));
        const reviews = saved.items.flatMap((item) => selected("SELECT payload FROM records WHERE kind='workflowReview' AND json_extract(payload,'$.changeId')=?", [item.itemId], workflowReviewSchema));
        const plan = read("workflowPlan", root.id, workflowPlanSchema);
        const rootScope = read("workflowFactoryScope", root.id, workflowFactoryScopeSchema);
        if (rootScope === null) throw new StoreFenceError("Factory root scope is unavailable");
        const dependencyReadyItemIds = rootScope.items.filter((item) => read("workflowReady", `${root.id}/${item.itemId}`, workflowReadySchema) !== null).map((item) => item.itemId);
        return { scope: { kind: "bounded", itemIds: saved.items.map((item) => item.itemId) }, admitted: saved.items.map((item) => item.itemId),
          reservations: children.map((child) => ({ id: child.id, itemIds: [child.itemId], state: child.state, purpose: "assignment" as const, assignmentKey: child.assignmentKey, ...(child.role ? { role: child.role } : {}), ...(child.roleEvidence ? { roleEvidence: child.roleEvidence } : {}) })),
          reviews, completedItemIds: [], dependencyReadyItemIds, graphFrozen: plan?.frozen === true,
          planner: plan === null ? null : { reservationId: plan.reservationId, state: plan.state },
          ...(plan?.frozen ? { dependencies: plan.dependencies } : {}),
          reviewLimit: saved.limit, reviewLimits: Object.fromEntries(saved.items.map((item) => [item.itemId, Math.min(item.limit, saved.limit)])), workflow: saved.workflow };
      };
      return {
        rootId: root.id, assignments: root.assignments,
        reservePlan: (scopeId: string): string => tx(() => {
          if (scopeId !== root.id) throw new StoreAuthorityError("Only the root factory scope may plan");
          scope(root.id);
          const reservationId = randomUUID();
          return executeWorkflow({ kind: "plan", role: "owner", reservationId }, {
            transaction: (run) => run(), read: () => view(root.id),
            apply: () => { put("workflowPlan", root.id, workflowPlanSchema.parse({ reservationId, state: "active", frozen: false, dependencies: {}, targets: {} })); return reservationId; },
          });
        }),
        settlePlan: (scopeId: string, reservationId: string, outcome: "failed" | "uncertain"): void => tx(() => {
          if (scopeId !== root.id) throw new StoreAuthorityError("Only the root factory scope may settle its planner");
          const plan = read("workflowPlan", root.id, workflowPlanSchema);
          if (plan === null || plan.reservationId !== reservationId) throw new StoreFenceError("Planner reservation does not match");
          executeWorkflow({ kind: "plan-settle", role: "owner", reservationId, outcome }, {
            transaction: (run) => run(), read: () => view(root.id),
            apply: () => { put("workflowPlan", root.id, { ...plan, state: outcome }); },
          });
        }),
        completePlan: (scopeId: string, reservationId: string, plan: { readonly dependencies: Readonly<Record<string, readonly string[]>>; readonly targets: Readonly<Record<string, readonly string[]>> }): void => tx(() => {
          if (scopeId !== root.id) throw new StoreAuthorityError("Only the root factory scope may freeze its planner");
          const saved = scope(root.id);
          const prior = read("workflowPlan", root.id, workflowPlanSchema);
          if (prior === null || prior.reservationId !== reservationId) throw new StoreFenceError("Planner reservation does not match");
          for (const item of saved.items) {
            const target = read("workflowTarget", item.itemId, z.string().min(1));
            if (target === null || plan.targets[item.itemId]?.length !== 1 || plan.targets[item.itemId]?.[0] !== target)
              throw new StoreAuthorityError("Planner targets must match each manager-frozen item target");
          }
          executeWorkflow({ kind: "plan-settle", role: "owner", reservationId, outcome: "completed" }, {
            transaction: (run) => run(), read: () => view(root.id),
            apply: () => { put("workflowPlan", root.id, { ...prior, state: "completed" }); },
          });
          executeWorkflow({ kind: "freeze", role: "owner", reservationId, dependencies: plan.dependencies, targets: plan.targets }, {
            transaction: (run) => run(), read: () => view(root.id),
            apply: () => { put("workflowPlan", root.id, workflowPlanSchema.parse({ reservationId, state: "completed", frozen: true, dependencies: plan.dependencies, targets: plan.targets })); },
          });
        }),
        readyItem: (scopeId: string, itemId: string, evidence: { readonly worktree: string; readonly head: string; readonly prNumber: number }): void => tx(() => {
          if (scopeId !== root.id) throw new StoreAuthorityError("Only the root factory scope may mark an item ready");
          const saved = scope(root.id);
          const item = saved.items.find((entry) => entry.itemId === itemId);
          if (!item || read("workflowPlan", root.id, workflowPlanSchema)?.frozen !== true) throw new StoreAuthorityError("Readiness requires a frozen factory item");
          const children = selected("SELECT payload FROM records WHERE kind='workflowChild' AND json_extract(payload,'$.claimId')=?", [item.claimId], workflowChildSchema).filter((child) => {
            let cursor: string | null = child.scopeId;
            while (cursor !== null && cursor !== root.id) cursor = read("workflowFactoryScope", cursor, workflowFactoryScopeSchema)?.parentId ?? null;
            return cursor === root.id;
          });
          const receipt = workflowReadySchema.parse({ itemId, ...evidence });
          requireWorkflowHandoff(children, "factory", receipt);
          executeWorkflow({ kind: "ready-item", role: "owner", itemId }, {
            transaction: (run) => run(), read: () => ({ ...view(root.id), readyableItemIds: [itemId] }),
            apply: () => { put("workflowReady", `${root.id}/${itemId}`, receipt); },
          });
        }),
        finishRun: (scopeId: string, handoff: WorkflowRunHandoff): void => tx(() => {
          if (scopeId !== root.id) throw new StoreAuthorityError("Only the root factory run may hand off");
          const saved = scope(root.id);
          const launch = read("workflowLaunch", input.launchKey, workflowLaunchSchema);
          if (launch === null || launch.scopeId !== root.id || launch.state !== "accepted") throw new StoreFenceError("Factory run is not eligible for handoff");
          if (handoff.items.length !== saved.items.length || new Set(handoff.items.map((entry) => entry.itemId)).size !== saved.items.length || handoff.items.some((entry) => !saved.items.some((item) => item.itemId === entry.itemId)))
            throw new StoreAuthorityError("Factory handoff must cover every frozen item exactly once");
          if (read("workflowPlan", root.id, workflowPlanSchema)?.frozen !== true) throw new StoreAuthorityError("Factory plan is not frozen");
          for (const item of saved.items) {
            const children = selected("SELECT payload FROM records WHERE kind='workflowChild' AND json_extract(payload,'$.claimId')=?", [item.claimId], workflowChildSchema).filter((child) => {
              let cursor: string | null = child.scopeId;
              while (cursor !== null && cursor !== root.id) cursor = read("workflowFactoryScope", cursor, workflowFactoryScopeSchema)?.parentId ?? null;
              return cursor === root.id;
            });
            const proof = handoff.items.find((entry) => entry.itemId === item.itemId);
            if (!proof) throw new StoreAuthorityError("Factory item handoff is missing");
            requireWorkflowHandoff(children, "factory", proof);
            const ready = read("workflowReady", `${root.id}/${item.itemId}`, workflowReadySchema);
            if (ready === null || !sameDocument(ready, proof)) throw new StoreAuthorityError("Factory item handoff must match its verified PR-ready evidence");
          }
          put("workflowLaunch", input.launchKey, workflowLaunchSchema.parse({ ...launch, state: "closed", handoff }));
        }),
        finishTarget: (scopeId: string, itemId: string): string | null => tx(() => {
          const saved = scope(scopeId);
          return saved.items.some((item) => item.itemId === itemId) ? read("workflowTarget", itemId, z.string().min(1)) : null;
        }),
        launchState: (state: "accepted" | "uncertain", location: Json | null): void => tx(() => {
          scope(root.id);
          const launch = read("workflowLaunch", input.launchKey, workflowLaunchSchema);
          if (launch === null || launch.scopeId !== root.id || launch.state !== "starting") throw new StoreFenceError("Factory launch intent is no longer pending");
          put("workflowLaunch", input.launchKey, { ...launch, state, location });
        }),
        view: (id: string): WorkflowView => tx(() => view(id)),
        nest: (parentId: string, workflow: "factory" | "pipeline" | "hotfix", itemIds: readonly string[], limit: number): string => tx(() => {
          const parent = scope(parentId);
          if (itemIds.length === 0 || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !parent.items.some((item) => item.itemId === id)) || (workflow !== "factory" && itemIds.length !== 1))
            throw new StoreAuthorityError("Nested factory scope must be a nonempty subset of its frozen items");
          const id = randomUUID();
          return executeWorkflow({ kind: "nest", role: "owner", runId: id, workflow, limit }, {
            transaction: (run) => run(), read: () => view(parentId),
            apply: () => { put("workflowFactoryScope", id, workflowFactoryScopeSchema.parse({ ...parent, id, parentId, workflow, limit, items: parent.items.filter((item) => itemIds.includes(item.itemId)) })); return id; },
          });
        }),
        reserve: (scopeId: string, itemId: string, assignmentKey: string, role?: WorkflowRoleAssignment): string => tx(() => {
          const saved = scope(scopeId);
          const item = saved.items.find((entry) => entry.itemId === itemId);
          if (!item) throw new StoreAuthorityError("Child work is outside the frozen factory scope");
          const id = randomUUID();
          return executeWorkflow({ kind: "reserve", role: "owner", itemIds: [itemId], reservationId: id, purpose: "assignment", assignmentKey }, {
            transaction: (run) => run(), read: () => view(scopeId),
            apply: () => {
              put("workflowChild", id, workflowChildSchema.parse({ id, scopeId, claimId: item.claimId, itemId, assignmentKey, state: "active", ...(role === undefined ? {} : { role }) }));
              db.query("DELETE FROM records WHERE kind=? AND id=?").run("workflowReady", `${root.id}/${itemId}`);
              return id;
            },
          });
        }),
        settle: (scopeId: string, reservationId: string, outcome: "completed" | "failed" | "uncertain"): void => tx(() => {
          const saved = scope(scopeId);
          const child = read("workflowChild", reservationId, workflowChildSchema);
          if (child === null || child.scopeId !== scopeId || !saved.items.some((item) => item.claimId === child.claimId && item.itemId === child.itemId))
            throw new StoreAuthorityError("Child reservation is outside the frozen factory scope");
          if (child.role !== undefined && outcome === "completed") throw new StoreAuthorityError("Role assignments require a correlated role proof");
          executeWorkflow({ kind: "settle", role: "owner", reservationId, outcome }, {
            transaction: (run) => run(), read: () => view(scopeId),
            apply: () => { put("workflowChild", reservationId, { ...child, state: outcome }); },
          });
        }),
        settleRole: (scopeId: string, reservationId: string, proof: WorkflowRoleReceipt): void => tx(() => {
          const saved = scope(scopeId);
          const child = read("workflowChild", reservationId, workflowChildSchema);
          if (child === null || child.scopeId !== scopeId || child.itemId !== proof.itemId || child.role?.kind !== proof.role ||
              !saved.items.some((item) => item.claimId === child.claimId && item.itemId === child.itemId))
            throw new StoreAuthorityError("Role proof is outside its frozen item and role");
          executeWorkflow({ kind: "settle", role: "owner", reservationId, outcome: "completed" }, {
            transaction: (run) => run(), read: () => view(scopeId),
            apply: () => { put("workflowChild", reservationId, workflowChildSchema.parse({ ...child, state: "completed", proof })); },
          });
        }),
        settleRoleWithoutProof: (scopeId: string, reservationId: string, role: { itemId: string; role: WorkflowRoleAssignment["kind"] }): void => tx(() => {
          const saved = scope(scopeId);
          const child = read("workflowChild", reservationId, workflowChildSchema);
          if (child === null || child.scopeId !== scopeId || child.itemId !== role.itemId || child.role?.kind !== role.role ||
              !saved.items.some((item) => item.claimId === child.claimId && item.itemId === child.itemId))
            throw new StoreAuthorityError("Role completion is outside its frozen item and role");
          executeWorkflow({ kind: "settle", role: "owner", reservationId, outcome: "completed" }, {
            transaction: (run) => run(), read: () => view(scopeId),
            apply: () => { put("workflowChild", reservationId, workflowChildSchema.parse({ ...child, state: "completed", roleEvidence: "invalid" })); },
          });
        }),
      };
    },
    workflowReview(input: {
      readonly employee: Binding;
      readonly request:
        | { readonly action: "reserve"; readonly changeId: string; readonly reservationId: string; readonly head: string; readonly limit: number; readonly reviewerId: string }
        | { readonly action: "settle"; readonly reservationId: string; readonly resultId: string };
    }): z.infer<typeof workflowReviewSchema> {
      return tx(() => {
        const sender = actor(input.employee);
        const request = input.request;
        const reservationId = idSchema.parse(request.reservationId);
        const existing = read("workflowReview", reservationId, workflowReviewSchema);
        if (request.action === "reserve") {
          const changeId = idSchema.parse(request.changeId);
          const head = z.string().trim().min(1).parse(request.head);
          const limit = z.number().int().min(1).max(3).parse(request.limit);
          const reviewerId = idSchema.parse(request.reviewerId);
          const owner = read("queueOwner", changeId, queueOwnerSchema);
          const intake = owner === null ? null : read("intake", owner.eventId, intakeRecordSchema);
          if (intake?.teamId == null) throw new StoreAuthorityError("Review change has no owning team");
          const current = team(intake.teamId);
          if (sender.role !== "manager" && (sender.id !== current.architect || sender.assignment !== current.id))
            throw new StoreAuthorityError("Only the manager or owning architect may reserve a review");
          if (!ready(current) || current.state === "finished" || !members(current).includes(reviewerId) || reviewerId === current.architect)
            throw new StoreAuthorityError("Review requires a ready owning-team reviewer distinct from the architect");
          const execution = read("itemExecution", changeId, itemExecutionSchema);
          if (execution?.employeeId === reviewerId)
            throw new StoreAuthorityError("The item implementer cannot independently review their own change");
          if (existing !== null) {
            if (existing.changeId !== changeId || existing.head !== head || existing.limit !== limit || existing.reviewerId !== reviewerId)
              throw new StoreConflictError("Review reservation replay differs from saved request");
            return existing;
          }
          const prior = selected("SELECT payload FROM records WHERE kind='workflowReview' AND json_extract(payload,'$.changeId')=?", [changeId], workflowReviewSchema);
          const savedLimit = read("workflowLimit", changeId, z.number().int().min(1).max(3));
          if (savedLimit === null && prior.length === 0 && sender.role !== "manager")
            throw new StoreAuthorityError("The manager must select the review limit for this change");
          if ((savedLimit !== null && savedLimit !== limit) || prior.some((entry) => entry.limit !== limit))
            throw new StoreConflictError("The manager-selected review limit is immutable");
          assertNoUnresolvedWork(reviewerId, "Reviewer");
          const messageId = `workflow-review-${reservationId}`;
          return workflow({ kind: "review", role: sender.role, changeId, reservationId, head }, () => {
            if (savedLimit === null) put("workflowLimit", changeId, limit);
            const review = workflowReviewSchema.parse({ changeId, reservationId, head, reviewerId, messageId, limit, state: "active", verdict: null, resultId: null });
            saveCue(sender, { id: messageId, recipient: reviewerId, kind: "assignment", correlation: changeId, payload: { kind: "workflow-review", changeId, reservationId, head, instruction: "Review the exact head. Settle the claim with output {kind:'workflow-review', reservationId, head, verdict} where verdict is approve, changes-requested, or block." } }, current.id);
            put("workflowReview", reservationId, review);
            return review;
          }, limit);
        }
        if (existing === null) throw new StoreConflictError("Review reservation does not exist");
        const owner = read("queueOwner", existing.changeId, queueOwnerSchema);
        const intake = owner === null ? null : read("intake", owner.eventId, intakeRecordSchema);
        if (intake?.teamId == null) throw new StoreAuthorityError("Review change has no owning team");
        const current = team(intake.teamId);
        if (sender.role !== "manager" && (sender.id !== current.architect || sender.assignment !== current.id))
          throw new StoreAuthorityError("Only the manager or owning architect may settle a review");
        const resultId = idSchema.parse(request.resultId);
        if (existing.state === "completed") {
          if (existing.resultId !== resultId) throw new StoreConflictError("Review already settled with another result");
          return existing;
        }
        const saved = read("result", resultId, resultRecordSchema);
        const claim = saved === null ? null : read("claim", saved.claimId, claimSchema);
        if (saved === null || saved.result.kind !== "completed" || claim?.status !== "settled" ||
            claim.messageId !== existing.messageId || claim.employeeId !== existing.reviewerId)
          throw new StoreAuthorityError("Review requires its reviewer's completed, settled assignment result");
        const receipt = workflowReviewReceiptSchema.parse(saved.result.output);
        if (receipt.reservationId !== reservationId || receipt.head !== existing.head)
          throw new StoreConflictError("Review result does not match its reservation and exact head");
        return workflow({ kind: "review-settle", role: sender.role, reservationId, head: receipt.head, verdict: receipt.verdict }, () => {
          const review = { ...existing, state: "completed" as const, verdict: receipt.verdict, resultId };
          put("workflowReview", reservationId, review);
          return review;
        }, existing.limit);
      });
    },
    sendCue(input: { readonly sender: Binding; readonly cue: Cue }): Message {
      return tx((): Message => {
        const sender: Employee = actor(input.sender);
        return saveCue(sender, cueSchema.parse(input.cue), sender.assignment);
      });
    },
    claimNext(input: {
      readonly employee: Binding;
      readonly excludedMessageIds?: readonly string[];
    }): Readonly<{ claim: Claim; message: Message }> | null {
      return tx(() => {
        const current: Employee = actor(input.employee);
        if (current.source === null)
          throw new StoreAuthorityError(
            "Inbox admission requires complete canonical role and loop source receipts",
          );
        if (
          selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status') IN ('active','reconciliation') LIMIT 1", [current.id], claimSchema).length > 0
        )
          throw new StoreConflictError(
            `Employee ${current.id} already has an unresolved claim`,
          );
        if (
          all("occurrence", occurrenceSchema).some(
            (occurrence): boolean =>
              occurrence.employeeId === current.id &&
              occurrence.observedAt === null,
          )
        )
          throw new StoreConflictError(
            "Employee already has an unresolved duty occurrence",
          );
        if (current.assignment !== null && !ready(team(current.assignment)))
          return null;
        const message: Message | undefined = pendingInbox(current).messages.find(
          (cue): boolean => !input.excludedMessageIds?.includes(cue.id),
        );
        if (message === undefined) return null;
        const claim: Claim = claimSchema.parse({
          id: randomUUID(),
          employeeId: current.id,
          messageId: message.id,
          ownerEpoch: epoch,
          generation: current.generation,
          status: "active",
        });
        const claimed: Message = { ...message, status: "claimed" };
        return workflow({ kind: "reserve", purpose: "claim", role: current.role, itemIds: [message.id], reservationId: claim.id }, () => {
          put("claim", claim.id, claim);
          put("message", message.id, claimed);
          return { claim, message: claimed };
        });
      });
    },
    settleClaim(input: {
      readonly employee: Binding;
      readonly claimId?: string;
      readonly result: Result;
    }): Settlement {
      return tx((): Settlement => {
        const current: Employee = actor(input.employee);
        const result: Result = resultSchema.parse(input.result);
        function reject(code: SettlementRecovery["code"], action: string, claimId: string | null): never {
          throw new ClaimSettlementError({ code, retryable: false, action, employeeId: current.id, generation: current.generation, claimId });
        }
        const saved = read("result", result.id, resultRecordSchema);
        const explicit: string | null = input.claimId === undefined || input.claimId === "current" ? null : idSchema.parse(input.claimId);
        const unresolved: readonly Claim[] = explicit !== null || saved !== null ? [] : selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status') IN ('active','reconciliation') ORDER BY rowid", [current.id], claimSchema);
        if (unresolved.length > 1) reject("ambiguous_claim", "Multiple outstanding claims require manager inspection and evidence-based reconciliation. Do not guess a claim or repeat settlement.", null);
        const selectedId: string | null = explicit ?? saved?.claimId ?? unresolved[0]?.id ?? null;
        if (selectedId === null) reject("no_active_claim", "No outstanding claim. Use startup_claim before settling; inspect the saved result if an earlier attempt may have completed.", null);
        const claim: Claim | null = read("claim", selectedId, claimSchema);
        if (claim === null) reject("claim_not_found", 'Claim ID does not exist. Do not retry it. Use startup_settle {result} for your current claim; legacy tools may use claimId="current".', selectedId);
        if (saved !== null && explicit === null && (claim.employeeId !== current.id || claim.generation !== current.generation)) reject("result_replay_conflict", "This result ID is already used outside your current employee generation. Use a unique result ID for genuinely new work; ask the manager to reconcile old work. Do not retry unchanged.", null);
        if (claim.employeeId !== current.id) reject("claim_not_owned", "This claim belongs to another employee. Settle only your own current claim with startup_settle {result}.", selectedId);
        if (claim.generation !== current.generation) reject("claim_generation_stale", "This claim belongs to a prior native generation. Ask the manager to use startup_reconcile with verified evidence. Do not replay work.", claim.id);
        if (saved !== null) {
          if (saved.claimId !== claim.id || !sameDocument(saved.result, result)) reject("result_replay_conflict", "This result ID already names a different claim or payload. Reuse the exact original result to recover its receipt, or use a unique result ID for genuinely new work. Do not retry changed content under the same ID.", claim.id);
          return saved;
        }
        if (claim.ownerEpoch !== epoch || claim.status === "reconciliation") reject("claim_requires_reconciliation", "The saved claim requires explicit manager reconciliation with evidence through startup_reconcile. Do not retry settlement or replay the work.", claim.id);
        if (claim.status === "settled" || all("result", resultRecordSchema).some((entry): boolean => entry.claimId === claim.id)) reject("claim_already_settled", "This claim already has a result. Reuse the original result ID and exact payload to recover its receipt; do not create another result.", claim.id);
        if (result.kind !== "uncertain" && selected("SELECT payload FROM records WHERE kind='workflowChild' AND json_extract(payload,'$.claimId')=?", [claim.id], workflowChildSchema).some((child) => child.state === "active" || child.state === "uncertain"))
          throw new StoreRecoveryError("The parent claim has active or uncertain bounded child effects; reconcile them before settling");
        if (result.kind !== "uncertain" && selected("SELECT payload FROM records WHERE kind='workflowRunClaim' AND json_extract(payload,'$.claimId')=?", [claim.id], workflowRunClaimSchema)
          .some((link) => read("workflowLaunch", link.launchKey, workflowLaunchSchema)?.state !== "closed"))
          throw new StoreRecoveryError("The parent claim has a bounded run without an authenticated completed handoff");
        const incoming: Message | null = read(
          "message",
          claim.messageId,
          messageSchema,
        );
        if (incoming === null)
          throw new StoreRecoveryError("Claim lost its incoming message");
        const execution: ItemExecution | null = current.role === "dev" && incoming.kind === "assignment"
          ? read("itemExecution", incoming.correlation, itemExecutionSchema)
          : null;
        const handoff: readonly Cue[] = execution !== null && execution.messageId === incoming.id && execution.employeeId === current.id && execution.generation === current.generation
          ? [{
              id: `item-result-${incoming.id}`,
              recipient: team(execution.teamId).architect,
              kind: "report",
              correlation: execution.itemId,
              payload: {
                kind: "item-result",
                itemId: execution.itemId,
                attemptId: execution.attemptId,
                resultId: result.id,
                outcome: result.kind,
                output: result.output,
                nextAction: result.kind === "completed"
                  ? "Assigned dev submits startup_item review with this resultId and current revision; architect coordinates QA after REVIEW."
                  : "Architect handles the saved question or uncertainty through Paused execution before another attempt.",
              },
            }]
          : [];
        return workflow({ kind: "settle", purpose: "claim", role: current.role, reservationId: claim.id, outcome: result.kind === "completed" ? "completed" : result.kind === "uncertain" ? "uncertain" : "failed" }, () => {
        const messages: readonly Message[] = [...result.outgoing, ...handoff].map(
          (cue): Message => saveCue(current, cue, current.assignment),
        );
        const settlement: Settlement = { claimId: claim.id, result, messages };
        put("result", result.id, settlement);
        put("claim", claim.id, {
          ...claim,
          status: result.kind === "uncertain" ? "reconciliation" : "settled",
        });
        put("message", incoming.id, { ...incoming, status: "acknowledged" });
        put("employee", current.id, {
          ...current,
          checkpoint: result.checkpoint,
        });
        if (incoming.kind === "assignment")
          put("assignment", incoming.id, {
            id: incoming.id,
            employeeId: current.id,
            state:
              result.kind === "completed" || readinessNotice(incoming)
                ? "complete"
                : result.kind === "question"
                  ? "waiting"
                  : "reconciliation",
          });
        if (current.assignment !== null && result.kind !== "completed")
          put("team", current.assignment, {
            ...team(current.assignment),
            state: result.kind === "question" ? "waiting" : "reconciliation",
          });
        return settlement;
        });
      });
    },
    resolveAssignment(input: {
      readonly manager: Binding;
      readonly assignmentId: string;
      readonly evidence: Json;
    }): void {
      tx((): void => {
        manager(input.manager);
        const saved = read(
          "assignment",
          idSchema.parse(input.assignmentId),
          assignmentSchema,
        );
        if (saved === null) throw new StoreConflictError("Unknown assignment");
        if (saved.state === "reconciliation")
          throw new StoreRecoveryError(
            "Reconcile uncertain claim before resolving its assignment",
          );
        put("assignmentResolution", saved.id, jsonSchema.parse(input.evidence));
        put("assignment", saved.id, { ...saved, state: "complete" });
      });
    },
    reconcileClaim(input: {
      readonly manager: Binding;
      readonly claimId: string;
      readonly evidence: Json;
    }): void {
      tx((): void => {
        manager(input.manager);
        const saved = read("claim", idSchema.parse(input.claimId), claimSchema);
        if (saved === null)
          throw new StoreConflictError("Claim is not awaiting reconciliation");
        const evidence: Json = jsonSchema.parse(input.evidence);
        if (evidence === null)
          throw new StoreRecoveryError("Claim reconciliation requires recorded evidence");
        const prior = read("claimReconciliation", saved.id, jsonSchema);
        if (saved.status === "settled" && prior !== null) {
          assertReplay(prior, evidence, `claim reconciliation ${saved.id}`);
          return;
        } else if (saved.status !== "reconciliation")
          throw new StoreConflictError("Claim is not awaiting reconciliation");
        const message = read("message", saved.messageId, messageSchema);
        if (message === null)
          throw new StoreRecoveryError(
            "Reconciliation claim lost incoming message",
          );
        workflow({ kind: "reconcile", role: "manager", reservationId: saved.id, outcome: "completed", evidence: encode(evidence) }, () => {
        put("claimReconciliation", saved.id, evidence);
        put("claim", saved.id, { ...saved, status: "settled" });
        put("message", message.id, { ...message, status: "acknowledged" });
        const assignment = read("assignment", message.id, assignmentSchema);
        if (assignment !== null && saved.status === "reconciliation" && !readinessNotice(message))
          put("assignment", assignment.id, { ...assignment, state: "waiting" });
        const current: Employee = employee(saved.employeeId);
        if (current.assignment !== null) {
          const assigned: Team = team(current.assignment);
          const ids: readonly string[] = members(assigned);
          if (assigned.state === "reconciliation" && ready(assigned) &&
            !all("claim", claimSchema).some((claim) => ids.includes(claim.employeeId) && claim.status === "reconciliation") &&
            !all("grant", grantSchema).some((grant) => ids.includes(grant.employeeId) && grant.state === "reconciliation"))
            put("team", assigned.id, { ...assigned, state: "waiting" });
        }
        });
      });
    },
    setDuty(input: { readonly manager: Binding; readonly duty: Duty }): Duty {
      return tx((): Duty => {
        manager(input.manager);
        const duty = dutySchema.parse(input.duty);
        employee(duty.employeeId);
        const existing = read("duty", duty.id, dutySchema);
        if (existing !== null) assertReplay(existing, duty, duty.id);
        else put("duty", duty.id, duty);
        return duty;
      });
    },
    endDuty(input: {
      readonly manager: Binding;
      readonly dutyId: string;
      readonly evidence: Json;
    }): void {
      tx((): void => {
        manager(input.manager);
        const duty = read("duty", idSchema.parse(input.dutyId), dutySchema);
        if (duty === null) throw new StoreConflictError("Unknown duty");
        if (
          all("occurrence", occurrenceSchema).some(
            (entry): boolean =>
              entry.dutyId === duty.id && entry.observedAt === null,
          )
        )
          throw new StoreConflictError("Duty has an unresolved occurrence");
        if (input.evidence === null)
          throw new StoreConflictError(
            "Ending a duty requires recorded evidence",
          );
        put("dutyEnd", duty.id, jsonSchema.parse(input.evidence));
      });
    },
    claimDue(input: { readonly employee: Binding }): Occurrence | null {
      return tx((): Occurrence | null => {
        const current = actor(input.employee);
        const timestamp = now();
        if (current.source === null)
          throw new StoreAuthorityError(
            "Duty admission requires complete canonical role and loop source receipts",
          );
        if (
          all("claim", claimSchema).some(
            (claim): boolean =>
              claim.employeeId === current.id && claim.status !== "settled",
          )
        )
          throw new StoreConflictError(
            "Employee already has an unresolved inbox claim",
          );
        const pending = all("occurrence", occurrenceSchema).find(
          (entry): boolean =>
            entry.employeeId === current.id && entry.observedAt === null,
        );
        if (pending !== undefined) {
          const reclaimed: Occurrence = {
            ...pending,
            generation: current.generation,
            ownerEpoch: epoch,
            claimedAt: timestamp,
          };
          const duty = read("duty", pending.dutyId, dutySchema);
          if (duty?.cadenceMs === null || duty === null)
            throw new StoreRecoveryError(
              "Pending occurrence has no configured cadence",
            );
          put("occurrence", pending.id, reclaimed);
          put(
            "dutyNext",
            pending.dutyId,
            timeSchema.parse(timestamp + duty.cadenceMs),
          );
          return reclaimed;
        }
        let duty: Duty | undefined;
        let earliestDue: number | null = null;
        for (const entry of all("duty", dutySchema)) {
          if (
            entry.employeeId !== current.id ||
            entry.target === null ||
            entry.probe === null ||
            entry.acceptance === null ||
            entry.cadenceMs === null ||
            entry.nextDue === null ||
            read("dutyEnd", entry.id, jsonSchema) !== null
          )
            continue;
          const dueAt = read("dutyNext", entry.id, timeSchema) ?? entry.nextDue;
          if (
            dueAt <= timestamp &&
            (earliestDue === null || dueAt < earliestDue)
          ) {
            duty = entry;
            earliestDue = dueAt;
          }
        }
        if (
          duty === undefined ||
          duty.nextDue === null ||
          duty.cadenceMs === null
        )
          return null;
        const scheduledFor: number =
          read("dutyNext", duty.id, timeSchema) ?? duty.nextDue;
        const occurrence: Occurrence = {
          id: `${duty.id}/${scheduledFor}`,
          dutyId: duty.id,
          employeeId: current.id,
          scheduledFor,
          claimedAt: timestamp,
          observation: null,
          observedAt: null,
          generation: current.generation,
          ownerEpoch: epoch,
        };
        put("occurrence", occurrence.id, occurrence);
        put("dutyNext", duty.id, timeSchema.parse(timestamp + duty.cadenceMs));
        return occurrence;
      });
    },
    observeDuty(input: {
      readonly employee: Binding;
      readonly occurrenceId: string;
      readonly observation: Json;
    }): Occurrence {
      return tx((): Occurrence => {
        const current = actor(input.employee);
        const saved = read(
          "occurrence",
          idSchema.parse(input.occurrenceId),
          occurrenceSchema,
        );
        if (
          saved === null ||
          saved.employeeId !== current.id ||
          saved.generation !== current.generation ||
          saved.ownerEpoch !== epoch
        )
          throw new StoreAuthorityError(
            "Duty occurrence belongs to another employee generation or owner epoch",
          );
        const observation: Json = jsonSchema.parse(input.observation);
        if (saved.observedAt !== null) {
          assertReplay(saved.observation, observation, saved.id);
          return saved;
        }
        const observed: Occurrence = {
          ...saved,
          observation,
          observedAt: now(),
        };
        put("occurrence", saved.id, observed);
        return observed;
      });
    },
    authorizeTarget(input: {
      readonly manager: Binding;
      readonly authorization: TargetAuthorization;
    }): void {
      tx((): void => {
        manager(input.manager);
        const authorization = authorizationSchema.parse(input.authorization);
        employee(authorization.employeeId);
        if (authorization.authority === null)
          throw new StoreAuthorityError(
            "Target mutation requires explicit recorded authority",
          );
        const saved = read(
          "authorization",
          authorization.id,
          authorizationSchema,
        );
        if (saved !== null)
          assertReplay(saved, authorization, authorization.id);
        else put("authorization", authorization.id, authorization);
      });
    },
    acquireTarget(input: {
      readonly employee: Binding;
      readonly grantId: string;
      readonly authorizationId: string;
    }): Grant {
      return tx((): Grant => {
        const current = actor(input.employee);
        const id: string = idSchema.parse(input.grantId);
        const authorization = read(
          "authorization",
          idSchema.parse(input.authorizationId),
          authorizationSchema,
        );
        if (authorization === null || authorization.employeeId !== current.id)
          throw new StoreAuthorityError(
            "No manager authorization for this employee and target",
          );
        if (read("resources", "original", resourceDocumentSchema) === null)
          throw new StoreRecoveryError(
            "Import legacy resources before acquiring a target",
          );
        const previous = read("grant", id, grantSchema);
        if (previous !== null) {
          assertReplay(
            {
              authorizationId: previous.authorizationId,
              employeeId: previous.employeeId,
              generation: previous.generation,
              target: previous.target,
              authority: previous.authority,
            },
            {
              authorizationId: authorization.id,
              employeeId: current.id,
              generation: current.generation,
              target: authorization.target,
              authority: authorization.authority,
            },
            id,
          );
          return previous;
        }
        if (
          all("grant", grantSchema).some(
            (grant): boolean => grant.authorizationId === authorization.id,
          )
        )
          throw new StoreConflictError(
            "Mutation authorization already has a grant; reconcile or request new authority",
          );
        if (
          all("legacyLock", legacyLockSchema).some(
            (lock): boolean =>
              lock.target === authorization.target && lock.state === "blocked",
          ) ||
          all("grant", grantSchema).some(
            (grant): boolean =>
              grant.target === authorization.target &&
              grant.state !== "released",
          )
        )
          throw new StoreConflictError(
            `Target ${authorization.target} is held or requires legacy reconciliation`,
          );
        const grant: Grant = {
          id,
          authorizationId: authorization.id,
          employeeId: current.id,
          generation: current.generation,
          target: authorization.target,
          authority: authorization.authority,
          state: "held",
          verification: null,
        };
        put("grant", id, grant);
        return grant;
      });
    },
    markTargetUncertain(input: {
      readonly employee: Binding;
      readonly grantId: string;
      readonly evidence: Json;
    }): Grant {
      return tx((): Grant => {
        const current = actor(input.employee);
        const grant = read("grant", idSchema.parse(input.grantId), grantSchema);
        if (
          !grant ||
          grant.employeeId !== current.id ||
          grant.generation !== current.generation ||
          grant.state === "released"
        )
          throw new StoreAuthorityError(
            "Only the current target owner may record an uncertain action",
          );
        const evidence = jsonSchema.parse(input.evidence);
        if (evidence === null)
          throw new StoreConflictError(
            "Uncertain target requires explicit evidence",
          );
        const uncertain: Grant = {
          ...grant,
          state: "reconciliation",
          verification: evidence,
        };
        put("grant", grant.id, uncertain);
        return uncertain;
      });
    },
    verifyAndReleaseTarget(input: {
      readonly employee: Binding;
      readonly grantId: string;
      readonly verification: Json;
    }): Grant {
      return tx((): Grant => {
        const current = actor(input.employee);
        const grant = read("grant", idSchema.parse(input.grantId), grantSchema);
        if (
          grant === null ||
          (current.role !== "manager" &&
            (grant.employeeId !== current.id ||
              grant.generation !== current.generation)) ||
          (current.role === "manager" && grant.state === "held")
        )
          throw new StoreAuthorityError(
            "Target grant requires its owning employee generation or manager reconciliation",
          );
        const verification = jsonSchema.parse(input.verification);
        if (verification === null)
          throw new StoreConflictError("Post-action verification is required");
        if (grant.state === "released") {
          assertReplay(grant.verification, verification, grant.id);
          return grant;
        }
        const released: Grant = { ...grant, state: "released", verification };
        put("grant", grant.id, released);
        return released;
      });
    },
    importResources(input: {
      readonly manager: Binding;
    }): readonly LegacyLock[] {
      return tx((): readonly LegacyLock[] => {
        manager(input.manager);
        const previous = read("resources", "original", resourceDocumentSchema);
        if (previous !== null) return all("legacyLock", legacyLockSchema);
        const raw: string | null = readFile("resources.json");
        const document: ResourceDocument =
          raw === null ? {} : resourceDocumentSchema.parse(JSON.parse(raw));
        const locks: readonly LegacyLock[] = readLegacyLocks(document);
        put("resources", "original", document);
        for (const lock of locks) put("legacyLock", lock.id, lock);
        return locks;
      });
    },
    reconcileLegacyLock(input: {
      readonly manager: Binding;
      readonly lockId: string;
      readonly evidence: Json;
    }): void {
      tx((): void => {
        manager(input.manager);
        const lock = read(
          "legacyLock",
          idSchema.parse(input.lockId),
          legacyLockSchema,
        );
        if (lock === null) throw new StoreConflictError("Unknown legacy lock");
        const evidence = jsonSchema.parse(input.evidence);
        if (evidence === null)
          throw new StoreRecoveryError(
            "Legacy lock reconciliation requires evidence",
          );
        if (lock.state === "resolved")
          assertReplay(lock.evidence, evidence, lock.id);
        else
          put("legacyLock", lock.id, { ...lock, state: "resolved", evidence });
      });
    },
    projectResources(input: { readonly manager: Binding }): ResourceDocument {
      pendingWrites();
      const id: string = `resources/${randomUUID()}`;
      const projection: ResourceDocument = tx((): ResourceDocument => {
        manager(input.manager);
        const original = read("resources", "original", resourceDocumentSchema);
        if (original === null)
          throw new StoreRecoveryError(
            "Import legacy resources before projecting their lock view",
          );
        const actual: string | null = readFile("resources.json");
        const baseline: Json =
          read("resources", "projection", jsonSchema) ?? original;
        if (
          (actual === null &&
            (read("resources", "projection", jsonSchema) !== null ||
              Object.keys(original).length > 0)) ||
          (actual !== null && !sameDocument(JSON.parse(actual), baseline))
        )
          throw new StoreRecoveryError(
            "resources.json changed outside the runtime; reconcile before projection",
          );
        const projected: ResourceDocument = projectResources({
          original,
          locks: all("legacyLock", legacyLockSchema),
          grants: all("grant", grantSchema),
        });
        put("intent", id, {
          file: "resources.json",
          before: readFile("resources.json"),
          after: JSON.stringify(projected, null, 2) + "\n",
          state: "pending",
          capture: null,
        });
        return projected;
      });
      applyIntent(id);
      return projection;
    },
    retireEmployees(input: {
      readonly manager: Binding;
      readonly employeeIds: readonly string[];
      readonly evidence: Json;
    }): readonly Employee[] {
      return tx((): readonly Employee[] => {
        manager(input.manager);
        jsonSchema.parse(input.evidence);
        const ids: readonly string[] = z
          .array(idSchema)
          .min(1)
          .parse(input.employeeIds);
        const retired: readonly Employee[] = ids.map((id): Employee => {
          const current = employee(id);
          if (
            (current.role !== "devops" && !all("team", teamSchema).some((saved) => saved.state === "finished" && members(saved).includes(id) && saved.generations[id] === current.generation)) ||
            current.role === "manager" || current.role === "pa" ||
            current.assignment !== null ||
            all("runtimeBinding", runtimeBindingSchema).some((runtime) => runtime.employeeId === id && runtime.generation === current.generation && runtime.turnActive) ||
            all("claim", claimSchema).some(
              (claim): boolean =>
                claim.employeeId === id && claim.status !== "settled",
            ) ||
            all("grant", grantSchema).some(
              (grant): boolean =>
                grant.employeeId === id && grant.state !== "released",
            ) ||
            all("assignment", assignmentSchema).some(
              (assignment): boolean =>
                assignment.employeeId === id && assignment.state !== "complete",
            ) ||
            all("message", messageSchema).some(
              (message): boolean =>
                (message.recipient === id || message.sender === id) &&
                message.status !== "acknowledged",
            ) ||
            all("duty", dutySchema).some(
              (duty): boolean =>
                duty.employeeId === id &&
                read("dutyEnd", duty.id, jsonSchema) === null,
            )
          )
            throw new StoreConflictError(
              `Employee ${id} must be idle, detached from a finished crew (or DevOps), and free of unresolved mail, duties, claims and grants; manager and PA cannot retire`,
            );
          return { ...current, employment: "retired" };
        });
        for (const current of retired) {
          put("employee", current.id, current);
          put("retirement", current.id, input.evidence);
        }
        return retired;
      });
    },
    abandonUnadmittedRuntime(input: Readonly<{
      manager: Binding;
      employeeId: string;
      launchId: string;
      evidence: Json;
      verifiedAbsentAt: number;
      connectionDeadlineMs: number;
    }>): number {
      return tx((): number => {
        manager(input.manager);
        const evidence: Json = jsonSchema.parse(input.evidence);
        if (evidence === null) throw new StoreRecoveryError("Runtime abandonment requires explicit manager recovery evidence");
        const previous = read("runtimeAbandonment", input.launchId, runtimeAbandonmentSchema);
        if (previous !== null) {
          assertReplay({ employeeId: previous.employeeId, evidence: previous.evidence }, { employeeId: input.employeeId, evidence }, input.launchId);
          return previous.nextGeneration;
        }
        const current: Employee = employee(input.employeeId);
        const key: string = `${current.id}/${current.generation + 1}`;
        const saved = read("runtimeBinding", key, runtimeBindingSchema);
        if (current.role === "manager" || current.nativeHandle !== null || current.source !== null || saved === null || saved.launchId !== input.launchId || saved.state === "ready" || saved.state === "abandoned")
          throw new StoreAuthorityError("Only a never-admitted pending employee generation may be abandoned");
        const verifiedAbsentAt: number = timeSchema.parse(input.verifiedAbsentAt);
        const connectionDeadlineMs: number = z.number().int().positive().safe().parse(input.connectionDeadlineMs);
        if (verifiedAbsentAt !== now()) throw new StoreRecoveryError("Runtime abandonment requires current absence verification");
        if (verifiedAbsentAt - Math.max(saved.lastPoll, saved.lastSeen) <= connectionDeadlineMs)
          throw new StoreRecoveryError("Runtime is too recent to abandon; wait for the connection deadline and verify absence");
        if (all("claim", claimSchema).some((claim) => claim.employeeId === current.id && claim.status !== "settled") || all("grant", grantSchema).some((grant) => grant.employeeId === current.id && grant.state !== "released"))
          throw new StoreRecoveryError("Reconcile claims and target grants before abandoning a pending runtime");
        const nextGeneration: number = timeSchema.parse(saved.generation + 1);
        const receipt: RuntimeAbandonment = runtimeAbandonmentSchema.parse({ ...input, generation: saved.generation, nextGeneration });
        put("runtimeAbandonment", saved.launchId, receipt);
        put("runtimeBinding", key, { ...saved, state: "abandoned", turnActive: false, error: "Abandoned by explicit manager recovery" });
        put("employee", current.id, { ...current, generation: saved.generation, nativeHandle: null, source: null, error: null });
        put("replacement", `${current.id}/${nextGeneration}`, { kind: "abandoned-runtime", launchId: saved.launchId, evidence });
        if (current.assignment !== null) {
          const assigned: Team = team(current.assignment);
          put("team", assigned.id, { ...assigned, state: "reserved", generations: { ...assigned.generations, [current.id]: nextGeneration } });
        }
        return nextGeneration;
      });
    },
    runtimeAbandonments(): readonly RuntimeAbandonment[] {
      return all("runtimeAbandonment", runtimeAbandonmentSchema);
    },
    observeItemProgress(input: Readonly<{ itemId: string; revision: number; status: string; observedAt: number }>): ItemProgress {
      return tx(() => observeItemProgress(input));
    },
    itemProgress(): readonly ItemProgress[] {
      return all("itemProgress", itemProgressSchema);
    },
    prepareRuntime(input: RuntimeBinding): RuntimeBinding {
      return tx(() => {
        const runtime = runtimeBindingSchema.parse(input);
        const current = employee(runtime.employeeId);
        if (runtime.settings.role !== current.role)
          throw new StoreAuthorityError("Frozen launch settings do not match the reserved employee role");
        const key = `${runtime.employeeId}/${runtime.generation}`;
        const saved = read("runtimeBinding", key, runtimeBindingSchema);
        if (saved !== null) {
          if (saved.state === "abandoned") throw new StoreFenceError("Runtime generation was abandoned by manager recovery");
          if (saved.launchId !== runtime.launchId || saved.credentialDigest !== runtime.credentialDigest || encode(saved.source) !== encode(runtime.source) || !sameDocument(saved.settings, runtime.settings))
            throw new StoreConflictError("Runtime generation already has a different launch reservation");
          return saved;
        }
        const selected: SavedRoleSettings | null = (current.role === "manager" ? read("managerLaunchSettings", scope.managerSession, savedRoleSettingsSchema) : null) ?? read("roleSettings", current.role, savedRoleSettingsSchema);
        if (selected === null || selected.revision !== runtime.settings.revision || !sameDocument(selected, runtime.settings))
          throw new StoreConflictError("Role settings changed while the launch was being prepared; reserve a new launch with the current revision");
        if (runtime.generation !== (current.role === "manager" ? current.generation : current.generation + 1))
          throw new StoreFenceError("Runtime launch must match the next reserved employee generation");
        if (!runtime.source.rolePath.endsWith(`/jp-startup-role-${current.role}/SKILL.md`) || !runtime.source.loopPath.endsWith("/jp-startup-loop/SKILL.md") || (current.canonicalRevision !== null && runtime.source.roleRevision !== current.canonicalRevision))
          throw new StoreAuthorityError("Runtime source does not match the reserved employee role");
        put("runtimeBinding", key, runtime);
        return runtime;
      });
    },
    updateRuntime(input: RuntimeBinding): RuntimeBinding {
      return tx(() => {
        const runtime = runtimeBindingSchema.parse(input);
        const key = `${runtime.employeeId}/${runtime.generation}`;
        const saved = read("runtimeBinding", key, runtimeBindingSchema);
        if (saved === null || saved.launchId !== runtime.launchId || saved.credentialDigest !== runtime.credentialDigest || encode(saved.source) !== encode(runtime.source) || !sameDocument(saved.settings, runtime.settings))
          throw new StoreFenceError("Runtime update does not match its saved launch reservation");
        if (saved.state === "abandoned") {
          if (!sameDocument(saved, runtime)) throw new StoreFenceError("Runtime generation was abandoned by manager recovery");
          return saved;
        }
        if ((saved.nativeSession !== null && saved.nativeSession !== runtime.nativeSession) || runtime.lastProgress < saved.lastProgress || runtime.lastSeen < saved.lastSeen)
          throw new StoreFenceError("Runtime identity or timestamp regressed");
        if (saved.stateSequence !== null && (runtime.stateSequence === null || runtime.stateSequence < saved.stateSequence))
          throw new StoreFenceError("Runtime lifecycle observation checkpoint regressed");
        if (runtime.state === "ready" && (runtime.nativeSession === null || runtime.paneId === null || runtime.terminalId === null))
          throw new StoreAuthorityError("Runtime readiness requires pane, terminal and native session evidence");
        put("runtimeBinding", key, runtime);
        return runtime;
      });
    },
    async dispatchRuntimeAllocation(
      input: RuntimeBinding,
      effect: () => Promise<Readonly<{ tabId: string; paneId: string }>>,
    ): Promise<Readonly<{ tabId: string; paneId: string }>> {
      const key = `${input.employeeId}/${input.generation}`;
      let location: Readonly<{ tabId: string; paneId: string }> | null = null;
      const adapter = {
        transaction: <T>(run: () => T): T => tx(run),
        read: (): WorkflowView => {
          const current = read("runtimeBinding", key, runtimeBindingSchema);
          if (current === null || current.launchId !== input.launchId || current.credentialDigest !== input.credentialDigest ||
              !sameDocument(current.source, input.source) || !sameDocument(current.settings, input.settings))
            throw new StoreFenceError("Launch allocation no longer matches its reserved identity");
          return {
            scope: { kind: "startup" }, admitted: [current.launchId],
            reservations: current.state === "prepared" ? [] : [{
              id: current.launchId, itemIds: [current.launchId],
              state: current.state === "uncertain" || current.state === "abandoned" ? "uncertain" : "active",
            }],
            reviews: [], reviewLimit: 3, workflow: "startup",
          };
        },
        apply: (decision: WorkflowRequest): void => {
          const current = read("runtimeBinding", key, runtimeBindingSchema);
          if (current === null || current.launchId !== input.launchId)
            throw new StoreFenceError("Launch allocation was superseded");
          if (decision.kind === "reserve") {
            if (current.state !== "prepared") throw new StoreFenceError("Launch is no longer prepared");
            put("runtimeBinding", key, runtimeBindingSchema.parse({ ...current, state: "starting", lastSeen: timeSchema.parse(now()) }));
          } else if (decision.kind === "settle" && decision.outcome === "uncertain") {
            if (current.state !== "ready")
              put("runtimeBinding", key, runtimeBindingSchema.parse({ ...current, state: "uncertain", error: "Native allocation outcome requires reconciliation" }));
          } else throw new StoreConflictError("Unsupported launch lifecycle transition");
        },
      };
      await dispatchWorkflow({
        request: { kind: "reserve", role: "manager", itemIds: [input.launchId], reservationId: input.launchId },
        adapter,
        effect: async (reservationId) => {
          location = await effect();
          return { reservationId, status: "accepted" };
        },
      });
      if (location === null) throw new StoreRecoveryError("Native allocation returned no location");
      return location;
    },
    hostAssociations(input: Readonly<{ after: string | null; limit: number; herdrSession: string; connectionDeadlineMs: number }>): HostAssociationPage {
      const query = hostAssociationQuerySchema.parse({ after: input.after, limit: input.limit });
      const herdrSession = idSchema.parse(input.herdrSession);
      const deadline = z.number().int().positive().safe().parse(input.connectionDeadlineMs);
      if (closed) throw new StoreFenceError("Association owner connection is closed");
      return db.transaction(() => {
        const observedAt = timeSchema.parse(now());
        const lease = leaseSchema.parse(db.query("SELECT token,epoch,generation,expires FROM lease WHERE singleton=1").get());
        const employees = all("employee", employeeSchema).toSorted((a, b) => a.id.localeCompare(b.id));
        const start = query.after === null ? 0 : employees.findIndex((entry) => entry.id === query.after) + 1;
        if (query.after !== null && start === 0) throw new StoreAuthorityError(`Unknown association cursor ${query.after}`);
        const rows = employees.slice(start, start + query.limit).map((entry): HostAssociationRow => {
          const base = { employeeId: entry.id, role: entry.role, generation: entry.generation };
          const unavailable = (reason: Extract<HostAssociationRow, { status: "unavailable" }>["reason"]): HostAssociationRow => ({ ...base, status: "unavailable", reason });
          if (lease.token !== token || lease.epoch !== epoch || lease.generation !== owner.managerGeneration || lease.expires <= observedAt) return unavailable("stale-owner");
          if (entry.employment === "retired") return unavailable("retired");
          const runtime = latestRuntime(entry.id, 0);
          if (runtime === null) return unavailable("unprepared");
          if (runtime.generation !== entry.generation) return unavailable("stale-generation");
          if (runtime.state !== "ready") return unavailable("runtime-not-ready");
          if (runtime.error !== null || entry.error !== null) return unavailable("runtime-error");
          if (runtime.terminalId === null) return unavailable("missing-terminal");
          if (runtime.nativeSession === null || runtime.paneId === null || runtime.observedState === "offline" || runtime.observedState === "unknown") return unavailable("unobserved");
          const connection = read("runtimeConnection", runtime.launchId, runtimeConnectionSchema);
          const identity = connection?.identity;
          if (!connection?.connected || identity === undefined || identity.ownerId !== owner.id || identity.ownerEpoch !== epoch || identity.startupRoot !== scope.startupRoot || identity.employeeId !== entry.id || identity.generation !== entry.generation || identity.launchId !== runtime.launchId || identity.harness !== runtime.settings.requested.harness || identity.nativeSession !== runtime.nativeSession) return unavailable("stale-connection");
          if (entry.nativeHandle === null || entry.source === null || encode(entry.source) !== encode(runtime.source)) return unavailable("stale-source");
          if (runtime.lastSeen === 0 || runtime.lastSeen > observedAt || observedAt - runtime.lastSeen > deadline) return unavailable("stale-observation");
          if (runtime.lastPoll === 0 || runtime.lastPoll > observedAt || observedAt - runtime.lastPoll > deadline) return unavailable("stale-poll");
          return { ...base, status: "current", launchId: runtime.launchId, harness: runtime.settings.requested.harness, nativeSession: runtime.nativeSession, terminalId: runtime.terminalId, source: runtime.source, lastSeen: runtime.lastSeen, lastPoll: runtime.lastPoll };
        });
        return hostAssociationPageSchema.parse({ state: "observed", scope, ownerId: owner.id, ownerEpoch: epoch, revision: controlRevision(db), observedAt, herdrSession, freshness: { leaseExpiresAt: lease.expires, connectionDeadlineMs: deadline }, total: employees.length, nextCursor: start + query.limit < employees.length ? rows.at(-1)?.employeeId : null, rows });
      }).deferred();
    },
    runtimeBindings(): readonly RuntimeBinding[] {
      return all("runtimeBinding", runtimeBindingSchema);
    },
    assertRuntimeConnection(launchId: string, connectionEpoch: string): void {
      if (closed) throw new StoreFenceError("Owner connection is closed");
      const lease = leaseSchema.parse(db.query("SELECT token,epoch,generation,expires FROM lease WHERE singleton=1").get());
      if (lease.token !== token || lease.epoch !== epoch || lease.expires <= now()) throw new StoreFenceError("Connection owner lease is stale");
      const current = read("runtimeConnection", launchId, runtimeConnectionSchema);
      if (!current?.connected || current.identity.connectionEpoch !== connectionEpoch) throw new StoreFenceError("Connection epoch is revoked");
    },
    admitRuntimeConnection(value: RuntimeIdentity): void {
      tx(() => {
        const identity = runtimeIdentitySchema.parse(value);
        const runtime = read("runtimeBinding", `${identity.employeeId}/${identity.generation}`, runtimeBindingSchema);
        if (identity.startupRoot !== scope.startupRoot || identity.harness !== runtime?.settings.requested.harness || identity.ownerId !== owner.id || identity.ownerEpoch !== epoch || runtime?.launchId !== identity.launchId || runtime.nativeSession !== identity.nativeSession || runtime.state !== "ready") throw new StoreFenceError("Connection does not match current runtime");
        put("runtimeConnection", identity.launchId, { identity, connected: true });
      });
    },
    revokeRuntimeConnection(launchId: string, connectionEpoch: string): void {
      if (closed) return;
      tx(() => {
        const current = read("runtimeConnection", launchId, runtimeConnectionSchema);
        if (current?.connected && current.identity.connectionEpoch === connectionEpoch) {
          put("runtimeConnection", current.identity.launchId, { ...current, connected: false });
          const key = `${current.identity.employeeId}/${current.identity.generation}`;
          const runtime = read("runtimeBinding", key, runtimeBindingSchema);
          if (runtime?.launchId === launchId) put("runtimeBinding", key, { ...runtime, lastPoll: 0 });
        }
      });
    },
    recordRuntimeSettings(input: Readonly<{ capability: RuntimeCapability; effective: EffectiveRoleSettings }>): Readonly<{ capability: RuntimeCapability; effective: EffectiveRoleSettings }> {
      return tx(() => {
        const capability = runtimeCapabilitySchema.parse(input.capability);
        const effective = effectiveRoleSettingsSchema.parse(input.effective);
        if (capability.session === null || effective.session === null || capability.observedAt === null || effective.observedAt === null ||
          encode(capability.session) !== encode(effective.session) || capability.observedAt !== effective.observedAt)
          throw new StoreAuthorityError("Runtime capability and effective settings require one exact observed native session sample");
        const identity = capability.session;
        const key = `${identity.employeeId}/${identity.generation}`;
        const runtime = read("runtimeBinding", key, runtimeBindingSchema);
        if (identity.startupRoot !== scope.startupRoot || identity.harness !== capability.harness || identity.ownerId !== owner.id || identity.ownerEpoch !== epoch || runtime === null || runtime.state !== "ready" ||
          runtime.launchId !== identity.launchId || runtime.nativeSession !== identity.nativeSession ||
          runtime.settings.requested.harness !== capability.harness || capability.harness !== effective.harness)
          throw new StoreFenceError("Effective settings observation does not match the current owner, launch generation, harness and native session");
        const connection = read("runtimeConnection", identity.launchId, runtimeConnectionSchema);
        if (!connection?.connected || encode(connection.identity) !== encode(identity)) throw new StoreFenceError("Settings report connection is no longer current");
        const priorCapability = read("runtimeCapability", runtime.launchId, runtimeCapabilitySchema);
        const priorEffective = read("effectiveRoleSettings", runtime.launchId, effectiveRoleSettingsSchema);
        if (capability.sampleSequence === null || capability.sampleSequence !== effective.sampleSequence) throw new StoreFenceError("Settings sample sequence is required");
        if (priorEffective?.session?.connectionEpoch === identity.connectionEpoch && capability.sampleSequence <= (priorEffective.sampleSequence ?? 0)) throw new StoreFenceError("Settings sample sequence is not newer than the saved session readback");
        if (encode(priorCapability) !== encode(capability)) put("runtimeCapability", runtime.launchId, capability);
        put("effectiveRoleSettings", runtime.launchId, effective);
        return { capability, effective };
      });
    },
    runtimeCapability(employeeId: string, generation: number): RuntimeCapability | null {
      const runtime = read("runtimeBinding", `${idSchema.parse(employeeId)}/${timeSchema.parse(generation)}`, runtimeBindingSchema);
      return runtime === null ? null : read("runtimeCapability", runtime.launchId, runtimeCapabilitySchema);
    },
    effectiveRoleSettings(employeeId: string, generation: number): EffectiveRoleSettings | null {
      const runtime = read("runtimeBinding", `${idSchema.parse(employeeId)}/${timeSchema.parse(generation)}`, runtimeBindingSchema);
      return runtime === null ? null : read("effectiveRoleSettings", runtime.launchId, effectiveRoleSettingsSchema);
    },
    employeeRuntime(employeeId: string, minimumGeneration: number): RuntimeBinding | null {
      return selected("SELECT payload FROM records WHERE kind='runtimeBinding' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.generation')>=? ORDER BY json_extract(payload,'$.generation') DESC LIMIT 1", [employeeId, minimumGeneration], runtimeBindingSchema)[0] ?? null;
    },
    observeRuntime(input: Readonly<{ employeeId: string; generation: number; nativeSession: string; state: NonNullable<RuntimeBinding["observedState"]>; sequence: number; observedAt: number; ternObservation?: NativeRoot }>): void {
      tx(() => {
        const key = `${input.employeeId}/${input.generation}`;
        const runtime = read("runtimeBinding", key, runtimeBindingSchema);
        if (runtime === null || runtime.nativeSession !== input.nativeSession)
          throw new StoreFenceError("Observation does not match the bound native session");
        if (runtime.state === "abandoned") throw new StoreFenceError("Runtime generation was abandoned by manager recovery");
        const sequence = timeSchema.parse(input.sequence);
        const ternObservation = input.ternObservation === undefined ? undefined : nativeRootSchema.parse(input.ternObservation);
        if (ternObservation !== undefined) {
          if (ternObservation.paneId !== runtime.paneId || ternObservation.sequence !== sequence || ternObservation.phase !== input.state)
            throw new StoreFenceError("Tern lifecycle observation does not match the reserved runtime");
          const checkpoint = runtime.stateSequence ?? 0;
          if (sequence < checkpoint || sequence > checkpoint + 1 ||
              (sequence === checkpoint && (runtime.ternObservation === undefined || encode(runtime.ternObservation) !== encode(ternObservation))))
            throw new StoreFenceError("Tern lifecycle sequence regressed, skipped, or conflicts with its saved observation");
        }
        if (runtime.stateSequence !== null && sequence < runtime.stateSequence)
          throw new StoreFenceError("Lifecycle observation sequence regressed");
        const seenCompletion = ["done", "idle"].includes(runtime.observedState ?? "") && ["done", "idle"].includes(input.state);
        if (runtime.stateSequence === sequence && runtime.observedState !== input.state && !seenCompletion)
          throw new StoreConflictError("Lifecycle sequence conflicts with its saved state");
        const observedAt = timeSchema.parse(input.observedAt);
        if (observedAt < runtime.lastSeen) throw new StoreFenceError("Observation time regressed");
        if (runtime.stateSequence !== sequence && input.state !== "working" && runtime.observedState !== input.state && !seenCompletion) {
          const id = `runtime-${runtime.launchId}-${sequence}-${input.state}`;
          const prior = read("message", id, messageSchema);
          if (prior !== null) {
            const payload = z.object({ kind: z.literal("runtime-observation"), employeeId: z.literal(runtime.employeeId), generation: z.literal(runtime.generation), state: z.literal(input.state), sequence: z.literal(sequence) }).safeParse(prior.payload);
            if (!payload.success || prior.recipient !== "manager" || prior.correlation !== runtime.launchId || prior.kind !== "alert")
              throw new StoreConflictError("Saved runtime observation alert conflicts with its launch identity");
          } else saveCue(employee("manager"), {
            id,
            recipient: "manager", kind: "alert", correlation: runtime.launchId,
            payload: { kind: "runtime-observation", employeeId: runtime.employeeId, generation: runtime.generation, state: input.state, observedAt, previousSequence: runtime.stateSequence, sequence },
          }, null);
          compactObservations(selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')='manager' AND json_extract(payload,'$.status')='pending' AND json_extract(payload,'$.correlation')=? AND json_extract(payload,'$.payload.kind')='runtime-observation' ORDER BY json_extract(payload,'$.sequence') DESC", [runtime.launchId], messageSchema));
        }
        put("runtimeBinding", key, { ...runtime, stateSequence: sequence, observedState: input.state, lastSeen: observedAt, ...(ternObservation === undefined ? {} : { ternObservation }) });
      });
    },
    compactRuntimeObservations(): Readonly<{ acknowledged: number }> {
      return tx(() => {
        const pending = selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')='manager' AND json_extract(payload,'$.status')='pending' AND json_extract(payload,'$.payload.kind')='runtime-observation' ORDER BY json_extract(payload,'$.sequence') DESC", [], messageSchema);
        return compactObservations(pending);
      });
    },
    runtimeAlert(input: Readonly<{ id: string; correlation: string; payload: Json }>): Message {
      return tx(() => saveCue(employee("manager"), { ...input, recipient: "manager", kind: "alert" }, null));
    },
    snapshot(): Snapshot {
      return db
        .transaction(
          (): Snapshot => ({
            ownerEpoch: epoch,
            employees: all("employee", employeeSchema),
            hires: all("hire", hireRecordSchema),
            captures: all("capture", captureRecordSchema),
            queueRevisions: all("queueOwner", queueOwnerSchema),
            authorizations: all("authorization", authorizationSchema),
            teams: all("team", teamSchema),
            itemExecutions: all("itemExecution", itemExecutionSchema),
            itemTransitions: all("itemTransition", itemTransitionSchema),
            messages: all("message", messageSchema),
            claims: all("claim", claimSchema),
            results: all("result", resultRecordSchema),
            duties: all("duty", dutySchema),
            dutySchedules: all("duty", dutySchema).map((duty) => ({
              id: duty.id,
              nextDue:
                read("dutyEnd", duty.id, jsonSchema) === null
                  ? (read("dutyNext", duty.id, timeSchema) ?? duty.nextDue)
                  : null,
            })),
            occurrences: all("occurrence", occurrenceSchema),
            grants: all("grant", grantSchema),
            legacyLocks: all("legacyLock", legacyLockSchema),
            teamRequirements: all("teamRequirement", teamRequirementSchema),
            intakes: all("intake", intakeRecordSchema),
            inputs: all("receivedInput", receivedInputSchema),
            assignments: all("assignment", assignmentSchema),
          }),
        )
        .deferred();
    },
    observeHost,
    hostAdmit,
    hostCancel,
    readHostReceipt(id: string): HostReceipt | null {
      const parsed = idSchema.parse(id);
      return db.transaction((): HostReceipt | null => read("hostReceipt", parsed, hostReceiptSchema)).deferred();
    },
    close(): void {
      if (closed) return;
      db.transaction((): void => {
        db.query(
          "UPDATE lease SET expires=0 WHERE singleton=1 AND token=? AND epoch=?",
        ).run(token, epoch);
      }).immediate();
      db.close();
      closed = true;
    },
  };
}
export type StartupStore = ReturnType<typeof openStore>;


function controlDatabase(scope: Scope, readonly: boolean): Database {
  const parsed = scopeSchema.parse(scope);
  if (realpathSync(parsed.startupRoot) !== parsed.startupRoot) throw new StoreAuthorityError("Control root must be canonical");
  const path = join(parsed.startupRoot, "staff.sqlite");
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) assertStartupPath(parsed.startupRoot, candidate, "file");
  return new Database(path, { readonly, strict: true });
}
function controlRead<T>(db: Database, kind: string, id: string, schema: z.ZodType<T>): T | null {
  const row = z.object({ payload: z.string() }).nullable().parse(db.query("SELECT payload FROM records WHERE kind=? AND id=?").get(kind, id));
  return row === null ? null : schema.parse(JSON.parse(row.payload));
}
function controlRevision(db: Database): number {
  return z.object({ n: timeSchema }).parse(db.query("SELECT COALESCE(MAX(sequence),0) AS n FROM audit").get()).n;
}
function controlPut(db: Database, kind: string, id: string, payload: unknown): void {
  const body = encode(payload);
  db.query("INSERT INTO records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload").run(kind, id, body);
  db.query("INSERT INTO audit(kind,id,payload) VALUES(?,?,?)").run(kind, id, body);
}
function controlScope(db: Database, scope: Scope): void {
  if (encode(controlRead(db, "meta", "scope", scopeSchema)) !== encode(scope)) throw new StoreAuthorityError("Control request scope does not match the selected Startup");
}
export function readOwnerControl(scope: Scope): Readonly<{ ownerEpoch: number; revision: number; leaseExpires: number; archived: boolean; settings: readonly SavedRoleSettings[] }> {
  const db = controlDatabase(scope, true);
  try { return db.transaction(() => {
    controlScope(db, scope);
    const lease = leaseSchema.parse(db.query("SELECT token,epoch,generation,expires FROM lease WHERE singleton=1").get());
    const settings = roleSchema.options.flatMap((role) => { const saved = controlRead(db, "roleSettings", role, savedRoleSettingsSchema); return saved === null ? [] : [saved]; });
    return { ownerEpoch: lease.epoch, revision: controlRevision(db), leaseExpires: lease.expires, archived: controlRead(db, "controlArchive", "startup", jsonSchema) !== null, settings };
  }).deferred(); } finally { db.close(); }
}
export function ownerControlOperationPath(scope: Scope, requestId: string): string {
  const directory = join(scope.startupRoot, "control");
  assertStartupPath(scope.startupRoot, directory, "directory");
  const path = join(directory, createHash("sha256").update(idSchema.parse(requestId)).digest("hex") + ".json");
  assertStartupPath(scope.startupRoot, path, "file");
  return path;
}
export function readOwnerControlFile(scope: Scope, requestId: string): OwnerControlReceipt | null {
  const path = ownerControlOperationPath(scope, requestId);
  if (!existsSync(path)) return null;
  if ((lstatSync(dirname(path)).mode & 0o077) !== 0) throw new StoreAuthorityError("Control operation directory must be private");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new StoreAuthorityError("Control operation must be a private regular file");
  const receipt = ownerControlReceiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (encode(receipt.scope) !== encode(scope) || receipt.requestId !== requestId) throw new StoreAuthorityError("Saved control operation scope differs");
  return receipt;
}
export function withOwnerControlRequest<T>(scope: Scope, requestId: string, action: () => T): T {
  const path = ownerControlOperationPath(scope, requestId) + ".lock";
  assertStartupPath(scope.startupRoot, path, "file");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = openSync(path, "wx", 0o600);
  try { return action(); }
  finally { closeSync(lock); unlinkSync(path); }
}
export function readOwnerControlReceipt(scope: Scope, requestId: string): OwnerControlReceipt | null {
  const db = controlDatabase(scope, true);
  try { controlScope(db, scope); return controlRead(db, "ownerControlReceipt", idSchema.parse(requestId), ownerControlReceiptSchema); } finally { db.close(); }
}
function applyOwnerControl(db: Database, scope: Scope, input: OwnerControlRequest, at: number, epoch: number): OwnerControlReceipt {
  const request = ownerControlRequestSchema.parse(input);
  if (encode(scope) !== encode(request.scope)) throw new StoreAuthorityError("Control request crosses Startup roots");
  controlScope(db, scope);
  const digest = createHash("sha256").update(encode(request)).digest("hex");
  const prior = readOwnerControlFile(scope, request.requestId) ?? controlRead(db, "ownerControlReceipt", request.requestId, ownerControlReceiptSchema);
  if (prior !== null) { if (prior.digest !== digest) throw new StoreConflictError("Control idempotency key has a different payload"); return prior; }
  if (epoch !== request.expectedOwnerEpoch || controlRevision(db) !== request.expectedRevision) throw new StoreFenceError("Control owner epoch or snapshot revision changed");
  if (controlRead(db, "controlArchive", "startup", jsonSchema) !== null) throw new StoreAuthorityError("Startup is archived");
  let result: Json;
  if (request.kind === "settings_apply") {
    const current = controlRead(db, "roleSettings", request.role, savedRoleSettingsSchema);
    if (current === null || current.revision !== request.baseSettingsRevision) throw new StoreConflictError("Role settings base revision changed");
    const validated = validateRoleSettings({ role: request.role, harness: request.harness, model: request.model, effort: request.effort });
    if (validated.status !== "accepted") throw new StoreAuthorityError(validated.reason);
    const saved = savedRoleSettingsSchema.parse({ role: request.role, requested: validated.requested, scope: "future_launch", revision: current.revision + 1, provenance: { kind: "host_request", actor: "host-control", generation: null, updatedAt: at } });
    controlPut(db, "roleSettings", request.role, saved);
    result = jsonSchema.parse(saved);
  } else {
    const unsafe = z.object({ n: timeSchema }).parse(db.query(`SELECT COUNT(*) AS n FROM records WHERE
      (kind='message' AND json_extract(payload,'$.status')!='acknowledged') OR
      (kind='receivedInput' AND json_extract(payload,'$.disposition') IS NULL AND json_extract(payload,'$.hold.kind') IS NOT 'cancelled') OR
      (kind='claim' AND json_extract(payload,'$.status')!='settled') OR
      (kind='grant' AND json_extract(payload,'$.state')!='released') OR
      (kind='assignment' AND json_extract(payload,'$.state')!='complete') OR
      (kind='intent' AND json_extract(payload,'$.state')='pending') OR
      (kind='runtimeBinding' AND json_extract(payload,'$.state') NOT IN ('abandoned','failed'))`).get()).n;
    const lease = leaseSchema.parse(db.query("SELECT token,epoch,generation,expires FROM lease WHERE singleton=1").get());
    if (unsafe > 0 || lease.expires > at) throw new StoreAuthorityError("Archive requires no live lease, active launches, pending input/messages, claims, grants, assignments or uncertain writes");
    result = { archivedAt: at, history: "preserved" };
    controlPut(db, "controlArchive", "startup", result);
  }
  const receipt = ownerControlReceiptSchema.parse({ requestId: request.requestId, digest, scope, kind: request.kind, state: "committed", ownerEpoch: epoch, revision: controlRevision(db) + 1, sideEffects: request.kind === "settings_apply" ? "future_launch_settings" : "history_archived", result });
  controlPut(db, "ownerControlReceipt", request.requestId, receipt);
  return receipt;
}
export function applyOfflineOwnerControl(input: OwnerControlRequest, at: number): OwnerControlReceipt {
  const request = ownerControlRequestSchema.parse(input);
  const lockPath = join(request.scope.startupRoot, "runtime-launch.lock");
  assertStartupPath(request.scope.startupRoot, lockPath, "file");
  const lock = request.kind === "archive" ? openSync(lockPath, "wx", 0o600) : null;
  try {
  if (request.kind === "archive" && existsSync(join(request.scope.startupRoot, "runtime-launch.json"))) throw new StoreAuthorityError("Archive refuses a saved runtime launch intent; reconcile it explicitly first");
  const db = controlDatabase(request.scope, false);
  try { return withOwnerControlRequest(request.scope, request.requestId, () => db.transaction(() => {
    controlScope(db, request.scope);
    const lease = leaseSchema.parse(db.query("SELECT token,epoch,generation,expires FROM lease WHERE singleton=1").get());
    if (lease.expires > at) throw new StoreFenceError("A live owner must handle this control request through its socket");
    return applyOwnerControl(db, request.scope, request, at, lease.epoch);
  }).immediate()); } finally { db.close(); }
  } finally { if (lock !== null) { closeSync(lock); unlinkSync(lockPath); } }
}
