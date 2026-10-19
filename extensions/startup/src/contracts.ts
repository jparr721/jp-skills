import { z } from "zod";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.json();
export const idSchema = z.string().min(1).max(512);
export const timeSchema = z.number().int().nonnegative().safe();
export const roleSchema = z.enum([
  "manager",
  "architect",
  "qa",
  "dev",
  "devops",
  "pa",
]);
export const employmentSchema = z.enum(["hired", "retired"]);
export const teamStateSchema = z.enum([
  "reserved",
  "ready",
  "active",
  "waiting",
  "reconciliation",
  "finished",
]);
export const runtimeStateSchema = z.enum([
  "prepared",
  "starting",
  "ready",
  "uncertain",
  "abandoned",
]);
export const observedRuntimeSchema = z.enum([
  "working",
  "idle",
  "done",
  "blocked",
  "unknown",
  "offline",
]);
export const scopeSchema = z
  .strictObject({
    skillsHome: z.string().startsWith("/"),
    startupRoot: z.string().startsWith("/"),
    host: idSchema,
    name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    boundRoot: z.string().startsWith("/"),
    managerSession: idSchema,
  })
  .readonly();
export const ownerSchema = z
  .strictObject({
    id: idSchema,
    managerGeneration: timeSchema,
    leaseMs: z.number().int().positive().safe(),
  })
  .readonly();
export const bindingSchema = z
  .strictObject({
    employeeId: idSchema,
    generation: timeSchema,
    nativeHandle: idSchema,
  })
  .readonly();
export const authoritySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), acceptedEventId: idSchema }),
    z.strictObject({ kind: z.literal("employee"), binding: bindingSchema }),
  ])
  .readonly();
export const sourceSchema = z
  .strictObject({
    rolePath: idSchema,
    roleRevision: idSchema,
    loopPath: idSchema,
    loopRevision: idSchema,
  })
  .readonly();
export const employeeSchema = z
  .strictObject({
    id: idSchema,
    role: roleSchema,
    employment: employmentSchema,
    generation: timeSchema,
    nativeHandle: idSchema.nullable(),
    source: sourceSchema.nullable(),
    assignment: idSchema.nullable(),
    canonicalRevision: idSchema.nullable(),
    checkpoint: jsonSchema,
    error: z.string().nullable(),
  })
  .readonly();
export const hireSchema = z
  .strictObject({
    requestId: idSchema,
    role: roleSchema.exclude(["manager"]),
    additional: z.number().int().positive().safe(),
    revision: idSchema,
  })
  .readonly();
export const intakeSchema = z
  .strictObject({
    eventId: idSchema,
    input: jsonSchema,
    amendItemIds: z.array(idSchema).readonly(),
  })
  .readonly();
export const cueSchema = z
  .strictObject({
    id: idSchema,
    recipient: idSchema,
    kind: z.enum([
      "assignment",
      "report",
      "question",
      "answer",
      "alert",
      "duty",
    ]),
    correlation: idSchema,
    payload: jsonSchema,
  })
  .readonly();
export const messageSchema = cueSchema
  .unwrap()
  .extend({
    sender: idSchema,
    sequence: timeSchema,
    teamId: idSchema.nullable(),
    status: z.enum(["pending", "claimed", "acknowledged"]),
  })
  .readonly();
export const claimSchema = z
  .strictObject({
    id: idSchema,
    employeeId: idSchema,
    messageId: idSchema,
    ownerEpoch: timeSchema,
    generation: timeSchema,
    status: z.enum(["active", "settled", "reconciliation"]),
  })
  .readonly();
export const resultSchema = z
  .strictObject({
    id: idSchema,
    kind: z.enum(["completed", "question", "uncertain"]),
    output: jsonSchema,
    checkpoint: jsonSchema,
    outgoing: z.array(cueSchema).readonly(),
  })
  .readonly();
export const teamSchema = z
  .strictObject({
    id: idSchema,
    eventId: idSchema,
    architect: idSchema,
    qa: idSchema,
    devs: z.array(idSchema).min(1).readonly(),
    generations: z.record(idSchema, timeSchema).readonly(),
    state: teamStateSchema,
    items: z
      .array(z.strictObject({ id: idSchema, revision: timeSchema }).readonly())
      .readonly(),
  })
  .readonly();
export const rowSchema = z
  .object({ id: idSchema })
  .catchall(jsonSchema)
  .readonly();
export const captureSchema = z
  .strictObject({
    captureId: idSchema,
    eventId: idSchema,
    rows: z
      .array(
        z
          .strictObject({
            id: idSchema,
            expectedRevision: timeSchema.nullable(),
            fields: z.record(z.string(), jsonSchema).readonly(),
          })
          .readonly(),
      )
      .readonly(),
    receipt: jsonSchema,
  })
  .readonly();
export const dutySchema = z
  .strictObject({
    id: idSchema,
    employeeId: idSchema,
    assignment: jsonSchema,
    target: idSchema.nullable(),
    probe: idSchema.nullable(),
    acceptance: idSchema.nullable(),
    repairAuthority: jsonSchema,
    cadenceMs: z.number().int().positive().safe().nullable(),
    nextDue: timeSchema.nullable(),
  })
  .readonly();
export const grantSchema = z
  .strictObject({
    id: idSchema,
    authorizationId: idSchema,
    employeeId: idSchema,
    generation: timeSchema,
    target: idSchema,
    authority: jsonSchema,
    state: z.enum(["held", "reconciliation", "released"]),
    verification: jsonSchema,
  })
  .readonly();
export const bindSchema = z
  .strictObject({
    employeeId: idSchema,
    generation: timeSchema,
    nativeHandle: idSchema,
    assignment: idSchema.nullable(),
    source: sourceSchema,
  })
  .readonly();
export const teamRequestSchema = z
  .strictObject({
    eventId: idSchema,
    architect: idSchema,
    qa: idSchema,
    devs: z.array(idSchema).min(1).readonly(),
    cues: z.array(cueSchema).min(3).readonly(),
  })
  .readonly();
export type Scope = z.infer<typeof scopeSchema>;
export type Owner = z.infer<typeof ownerSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type Authority = z.infer<typeof authoritySchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Employee = z.infer<typeof employeeSchema>;
export type Hire = z.infer<typeof hireSchema>;
export type Intake = z.infer<typeof intakeSchema>;
export type Cue = z.infer<typeof cueSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Result = z.infer<typeof resultSchema>;
export type Team = z.infer<typeof teamSchema>;
export type Capture = z.infer<typeof captureSchema>;
export type Duty = z.infer<typeof dutySchema>;
export type Grant = z.infer<typeof grantSchema>;
export type Bind = z.infer<typeof bindSchema>;
export type TeamRequest = z.infer<typeof teamRequestSchema>;
export type QueueRow = z.infer<typeof rowSchema>;

export class StoreConflictError extends Error {}
export class StoreAuthorityError extends Error {}
export class StoreFenceError extends Error {}
export class StoreRecoveryError extends Error {}

export const settlementRecoverySchema = z.strictObject({
  code: z.enum(["claim_not_found", "claim_not_owned", "claim_generation_stale", "claim_requires_reconciliation", "claim_already_settled", "no_active_claim", "ambiguous_claim", "result_replay_conflict", "settlement_conflict", "request_invalid"]),
  retryable: z.literal(false),
  action: z.string().min(1),
  employeeId: idSchema.nullable(),
  generation: timeSchema.nullable(),
  claimId: idSchema.nullable(),
}).readonly();
export type SettlementRecovery = z.infer<typeof settlementRecoverySchema>;
export class ClaimSettlementError extends StoreFenceError {
  readonly recovery: SettlementRecovery;
  constructor(recovery: SettlementRecovery) {
    super(`${recovery.code}: ${recovery.action}; employee=${recovery.employeeId ?? "unknown"}; generation=${recovery.generation ?? "unknown"}; claim=${recovery.claimId ?? "current"}`);
    this.recovery = settlementRecoverySchema.parse(recovery);
  }
}


export const HOST_PAGE_DEFAULT = 32;
export const HOST_PAGE_MAX = 64;
export const HOST_PREVIEW_CHARS = 512;
export const HOST_LINK_CAP = 8;
export const HOST_IMAGE_MAX = 8;
export const HOST_TEXT_MAX = 262144;
export const hostModeSchema = z.enum(["general", "startup", "startup_outcome"]);
export const hostImageSchema = z.strictObject({
  type: z.literal("image"),
  data: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
}).readonly();
export const hostLimitSchema = z.number().int().min(1).max(HOST_PAGE_MAX).default(HOST_PAGE_DEFAULT);
export const hostStatusQuerySchema = z.strictObject({
  limit: hostLimitSchema,
  queueCursor: idSchema.optional(),
  staffCursor: idSchema.optional(),
  teamCursor: idSchema.optional(),
  inputCursor: idSchema.optional(),
}).readonly();
export const hostAdmitRequestSchema = z.strictObject({
  requestId: idSchema,
  mode: hostModeSchema,
  origin: z.string().min(1).max(512),
  text: z.string().max(HOST_TEXT_MAX),
  images: z.array(hostImageSchema).max(HOST_IMAGE_MAX).readonly(),
}).refine((value) => value.text.length > 0 || value.images.length > 0, "Host intake requires text or an image");
export const hostCancelRequestSchema = z.strictObject({
  requestOrItemId: idSchema,
  intentId: idSchema,
}).readonly();
export const setupPhaseSchema = z.enum([
  "unprepared",
  "manager-pending",
  "pa-unhired",
  "pa-conflict",
  "pa-pending",
  "ready",
]);
const hostRuntimeFields = {
  generation: timeSchema,
  launchId: idSchema,
  state: runtimeStateSchema,
  observedState: observedRuntimeSchema.nullable(),
  nativeSession: idSchema.nullable(),
  paneId: idSchema.nullable(),
  lastPoll: timeSchema,
};
export const setupReceiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("scope"), name: idSchema, host: idSchema, boundRoot: idSchema, home: idSchema }).readonly(),
  z.strictObject({ kind: z.literal("manager-runtime"), employeeId: z.literal("manager"), ...hostRuntimeFields }).readonly(),
  z.strictObject({ kind: z.literal("pa-hire"), requestId: idSchema, employeeIds: z.array(idSchema).readonly() }).readonly(),
  z.strictObject({ kind: z.literal("pa-runtime"), employeeId: idSchema, ...hostRuntimeFields }).readonly(),
  z.strictObject({ kind: z.literal("source-load"), employeeId: idSchema, generation: timeSchema, roleRevision: idSchema }).readonly(),
]);
export const hostClaimSlotSchema = z.strictObject({
  role: z.enum(["execution", "qa"]),
  employeeId: idSchema,
  generation: timeSchema,
  messageId: idSchema,
  outcome: z.enum(["settled", "already-settled", "withdrawn-before-claim"]),
}).readonly();
export const hostAdmitReceiptSchema = z.strictObject({
  kind: z.literal("admit"),
  id: idSchema,
  requestId: idSchema,
  inputId: idSchema,
  mode: hostModeSchema,
  origin: z.string().min(1).max(512),
  receivedAt: timeSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  textPreview: z.string().max(HOST_PREVIEW_CHARS),
  textLength: timeSchema,
  attachmentCount: z.number().int().nonnegative().max(HOST_IMAGE_MAX),
}).readonly();
export const hostCancelReceiptSchema = z.strictObject({
  kind: z.literal("cancel"),
  id: idSchema,
  intentId: idSchema,
  requestOrItemId: idSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: timeSchema,
  target: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("request"),
      inputId: idSchema,
      delegated: z.boolean(),
    }).readonly(),
    z.strictObject({
      kind: z.literal("item"),
      itemId: idSchema,
      revision: timeSchema,
      status: z.literal("CANCELLED"),
      slots: z.array(hostClaimSlotSchema).max(2).readonly(),
    }).readonly(),
  ]),
}).readonly();
export const hostReceiptSchema = z.discriminatedUnion("kind", [hostAdmitReceiptSchema, hostCancelReceiptSchema]);
const hostPage = <T extends z.ZodType>(row: T) => z.strictObject({
  total: timeSchema,
  nextCursor: idSchema.nullable(),
  rows: z.array(row).max(HOST_PAGE_MAX).readonly(),
});
export const hostQueueRowSchema = z.strictObject({
  id: idSchema,
  status: z.string(),
  revision: timeSchema.nullable(),
  requestPreview: z.string().max(HOST_PREVIEW_CHARS),
  requestTruncated: z.boolean(),
  progressChangedAt: timeSchema.nullable(),
  captureIds: z.array(idSchema).max(HOST_LINK_CAP).readonly(),
  transitionIds: z.array(idSchema).max(HOST_LINK_CAP).readonly(),
  hostReceiptIds: z.array(idSchema).max(HOST_LINK_CAP).readonly(),
  execution: z.strictObject({
    employeeId: idSchema,
    generation: timeSchema,
    messageId: idSchema,
    qaMessageId: idSchema.nullable(),
    qaGeneration: timeSchema.nullable(),
  }).nullable(),
}).readonly();
export const hostQueuePageSchema = z.discriminatedUnion("kind", [
  hostPage(hostQueueRowSchema).extend({ kind: z.literal("readable") }),
  z.strictObject({ kind: z.literal("ambiguous") }).readonly(),
  z.strictObject({ kind: z.literal("invalid"), message: z.string().max(HOST_PREVIEW_CHARS) }).readonly(),
  z.strictObject({
    kind: z.literal("intent-pending"),
    total: timeSchema,
    intentIds: z.array(idSchema).max(HOST_PAGE_MAX).readonly(),
  }).readonly(),
]);
export const hostTeamRowSchema = z.strictObject({
  id: idSchema,
  eventId: idSchema,
  state: teamStateSchema,
  members: z.array(z.strictObject({ id: idSchema, role: roleSchema, generation: timeSchema }).readonly()).readonly(),
  items: z.array(z.strictObject({ id: idSchema, revision: timeSchema }).readonly()).max(HOST_PAGE_MAX).readonly(),
  itemsTruncated: z.boolean(),
}).readonly();
export const hostStaffRowSchema = z.strictObject({
  id: idSchema,
  role: roleSchema,
  generation: timeSchema,
  employment: employmentSchema,
  lifecycle: z.enum(["retired", "unprepared", "prepared", "starting", "ready", "uncertain", "abandoned", "failed"]),
  assignment: idSchema.nullable(),
  nativeHandle: idSchema.nullable(),
  nativeSession: idSchema.nullable(),
  runtimeState: runtimeStateSchema.nullable(),
  observedState: observedRuntimeSchema.nullable(),
  sourceRevision: idSchema.nullable(),
}).readonly();
export const hostPendingInputSchema = z.strictObject({
  id: idSchema,
  receivedAt: timeSchema,
  source: z.enum(["interactive", "rpc", "host"]),
  mode: hostModeSchema.nullable(),
  origin: z.string().max(512).nullable(),
  textPreview: z.string().max(HOST_PREVIEW_CHARS),
  textLength: timeSchema,
  attachmentCount: z.number().int().nonnegative(),
}).readonly();
export const hostReasonSchema = z.enum([
  "duties-unreadable",
  "duties",
  "pending-intent",
  "ambiguous-queue",
  "invalid-queue",
  "manager-error",
  "manager-runtime-uncertain",
  "manager-runtime-abandoned",
  "reconciliation",
  "manager-runtime-absent",
  "manager-not-ready",
  "manager-poll",
  "manager-observed-offline",
  "pa",
  "supervision-errors",
  "lease",
  "supervision-freshness",
  "item-progress",
  "unclassified-input",
]);
export const hostStateSchema = z.enum(["unsupported", "recovery-required", "missing", "offline", "stale", "live"]);
export const paBlockerSchema = z.enum(["pa-missing", "pa-not-admitted", "pa-offline", "pa-observer-unavailable", "pa-overdue"]);
const hostPictureSchema = z.strictObject({
  binding: z.strictObject({ name: idSchema, boundRoot: scopeSchema.unwrap().shape.boundRoot, home: scopeSchema.unwrap().shape.skillsHome, host: idSchema }).readonly(),
  storeRevision: timeSchema,
  observedAt: timeSchema,
  freshness: z.strictObject({
    leaseExpiresAt: timeSchema,
    managerLastPoll: timeSchema.nullable(),
    supervisionCompletedAt: timeSchema.nullable(),
    supervisionSucceededAt: timeSchema.nullable(),
    connectionDeadlineMs: z.number().int().positive(),
    progressDeadlineMs: z.number().int().positive(),
  }).readonly(),
  reasons: z.array(hostReasonSchema).readonly(),
  duties: z.strictObject({ count: timeSchema, unreadable: z.boolean() }).readonly(),
  setup: z.strictObject({ phase: setupPhaseSchema, receipts: z.array(setupReceiptSchema).readonly() }).readonly(),
  queue: hostQueuePageSchema,
  teams: hostPage(hostTeamRowSchema),
  staff: hostPage(hostStaffRowSchema),
  supervision: z.strictObject({
    blocker: paBlockerSchema.nullable(),
    lastStartedAt: timeSchema.nullable(),
    lastCompletedAt: timeSchema.nullable(),
    lastSuccessAt: timeSchema.nullable(),
    errors: z.array(z.strictObject({
      component: z.enum(["herdr", "observation", "queue"]),
      employeeId: idSchema.nullable(),
      error: z.string().max(256),
    }).readonly()).max(8).readonly(),
  }).readonly(),
  pendingInputs: hostPage(hostPendingInputSchema),
});
export const hostStatusSchema = z.discriminatedUnion("state", [
  hostPictureSchema.extend({ state: z.literal("unsupported") }),
  hostPictureSchema.extend({ state: z.literal("recovery-required") }),
  hostPictureSchema.extend({ state: z.literal("missing") }),
  hostPictureSchema.extend({ state: z.literal("offline") }),
  hostPictureSchema.extend({ state: z.literal("stale") }),
  hostPictureSchema.extend({ state: z.literal("live") }),
]);
export type HostMode = z.infer<typeof hostModeSchema>;
export type HostStatusQuery = z.output<typeof hostStatusQuerySchema>;
export type HostAdmitRequest = z.output<typeof hostAdmitRequestSchema>;
export type HostCancelRequest = z.output<typeof hostCancelRequestSchema>;
export type HostReceipt = z.infer<typeof hostReceiptSchema>;
export type HostStatus = z.infer<typeof hostStatusSchema>;
export type HostReason = z.infer<typeof hostReasonSchema>;
export type HostState = z.infer<typeof hostStateSchema>;
export type SetupReceipt = z.infer<typeof setupReceiptSchema>;

export function encode(value: unknown): string {
  const parsed: Json = jsonSchema.parse(value);
  function sorted(entry: Json): Json {
    if (Array.isArray(entry))
      return entry.map((item: Json): Json => sorted(item));
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]): number => a.localeCompare(b))
          .map(([key, item]): [string, Json] => [key, sorted(item)]),
      );
    }
    return entry;
  }
  return JSON.stringify(sorted(parsed));
}

export const ownerControlRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("settings_apply"), requestId: idSchema, scope: scopeSchema, expectedOwnerEpoch: timeSchema, expectedRevision: timeSchema, role: roleSchema, harness: z.enum(["omp", "claude"]), model: z.string().nullable(), effort: z.string().nullable(), baseSettingsRevision: timeSchema }),
  z.strictObject({ kind: z.literal("archive"), requestId: idSchema, scope: scopeSchema, expectedOwnerEpoch: timeSchema, expectedRevision: timeSchema }),
]);
export type OwnerControlRequest = z.infer<typeof ownerControlRequestSchema>;
export const ownerControlReceiptSchema = z.strictObject({
  requestId: idSchema, digest: idSchema, scope: scopeSchema,
  kind: z.enum(["create", "settings_apply", "archive", "resume", "prepare_manager"]),
  state: z.enum(["committed", "uncertain", "missing_session"]),
  ownerEpoch: timeSchema, revision: timeSchema,
  sideEffects: z.enum(["root_initialized", "future_launch_settings", "history_archived", "owner_resumed", "manager_prepared", "none"]),
  result: jsonSchema,
});
export type OwnerControlReceipt = z.infer<typeof ownerControlReceiptSchema>;
