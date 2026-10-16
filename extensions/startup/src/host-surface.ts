import { z } from "zod";
import {
  employmentSchema,
  hostAdmitRequestSchema,
  hostCancelRequestSchema,
  hostQueuePageSchema,
  hostReceiptSchema,
  hostStatusQuerySchema,
  hostStatusSchema,
  idSchema,
  observedRuntimeSchema,
  paBlockerSchema,
  roleSchema,
  runtimeStateSchema,
  setupPhaseSchema,
  setupReceiptSchema,
  teamStateSchema,
  timeSchema,
  type HostAdmitRequest,
  type HostCancelRequest,
  type HostReason,
  type HostReceipt,
  type HostState,
  type HostStatus,
  StoreAuthorityError,
  type HostStatusQuery,
  type SetupReceipt,
} from "./contracts";

const hostRuntimeSchema = z.strictObject({
  employeeId: idSchema,
  generation: timeSchema,
  launchId: idSchema,
  state: runtimeStateSchema,
  observedState: observedRuntimeSchema.nullable(),
  nativeSession: idSchema.nullable(),
  paneId: idSchema.nullable(),
  lastPoll: timeSchema,
}).readonly();
const hostObservationSchema = z.strictObject({
  binding: z.strictObject({ name: idSchema, boundRoot: idSchema, home: idSchema, host: idSchema }).readonly(),
  storeRevision: timeSchema,
  ownerEpoch: timeSchema,
  leaseExpires: timeSchema,
  observedAt: timeSchema,
  duties: z.strictObject({ count: timeSchema, unreadable: z.boolean() }).readonly(),
  pendingIntentCount: timeSchema,
  queue: hostQueuePageSchema,
  reconciliation: z.strictObject({ claims: timeSchema, grants: timeSchema, assignments: timeSchema }).readonly(),
  manager: z.strictObject({
    error: z.string().nullable(),
    generation: timeSchema,
    sourceRevision: idSchema.nullable(),
    runtime: hostRuntimeSchema.nullable(),
  }).readonly(),
  paCount: timeSchema,
  pa: z.strictObject({
    id: idSchema,
    generation: timeSchema,
    sourceRevision: idSchema.nullable(),
    runtime: hostRuntimeSchema.nullable(),
  }).nullable(),
  paHire: z.strictObject({ requestId: idSchema, employeeIds: z.array(idSchema).readonly() }).nullable(),
  teams: z.strictObject({
    total: timeSchema,
    nextCursor: idSchema.nullable(),
    rows: z.array(z.strictObject({
      id: idSchema,
      eventId: idSchema,
      state: teamStateSchema,
      members: z.array(z.strictObject({ id: idSchema, role: roleSchema, generation: timeSchema }).readonly()).readonly(),
      items: z.array(z.strictObject({ id: idSchema, revision: timeSchema }).readonly()).readonly(),
      itemsTruncated: z.boolean(),
    }).readonly()).readonly(),
  }).readonly(),
  staff: z.strictObject({
    total: timeSchema,
    nextCursor: idSchema.nullable(),
    rows: z.array(z.strictObject({
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
    }).readonly()).readonly(),
  }).readonly(),
  pendingInputs: z.strictObject({
    total: timeSchema,
    nextCursor: idSchema.nullable(),
    rows: z.array(z.strictObject({
      id: idSchema,
      receivedAt: timeSchema,
      source: z.enum(["interactive", "rpc", "host"]),
      mode: z.enum(["general", "startup", "startup_outcome"]).nullable(),
      origin: z.string().max(512).nullable(),
      textPreview: z.string(),
      textLength: timeSchema,
      attachmentCount: timeSchema,
    }).readonly()).readonly(),
  }).readonly(),
  watched: z.strictObject({
    oldestProgressAt: timeSchema.nullable(),
    oldestUnclassifiedAt: timeSchema.nullable(),
  }).readonly(),
}).readonly();
type HostObservation = z.infer<typeof hostObservationSchema>;
const reasonState = {
  "duties-unreadable": "unsupported",
  duties: "unsupported",
  "pending-intent": "recovery-required",
  "ambiguous-queue": "recovery-required",
  "invalid-queue": "recovery-required",
  "manager-error": "recovery-required",
  "manager-runtime-uncertain": "recovery-required",
  "manager-runtime-abandoned": "recovery-required",
  reconciliation: "recovery-required",
  "manager-runtime-absent": "missing",
  "manager-not-ready": "offline",
  "manager-poll": "offline",
  "manager-observed-offline": "offline",
  pa: "offline",
  "supervision-errors": "offline",
  lease: "stale",
  "supervision-freshness": "stale",
  "item-progress": "stale",
  "unclassified-input": "stale",
} as const satisfies Record<HostReason, HostState>;
type HostStore = {
  observeHost(input: { readonly observedAt: number; readonly query: HostStatusQuery }): unknown;
  hostAdmit(request: HostAdmitRequest): unknown;
  hostCancel(request: HostCancelRequest): unknown;
  readHostReceipt(id: string): unknown;
};
export type HostSurface = {
  status(query: unknown): HostStatus;
  admit(request: unknown): HostReceipt;
  cancel(request: unknown): HostReceipt;
  receipt(id: unknown): HostReceipt;
};
export type HostSupervision = {
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastSuccessAt: number | null;
  errors: readonly { component: "herdr" | "observation" | "queue"; employeeId: string | null; error: string }[];
};
function setup(observation: HostObservation): { phase: z.infer<typeof setupPhaseSchema>; receipts: SetupReceipt[] } {
  const receipts: SetupReceipt[] = [{ kind: "scope", ...observation.binding }];
  const runtime = observation.manager.runtime;
  if (runtime !== null) receipts.push({ kind: "manager-runtime", employeeId: "manager", generation: runtime.generation, launchId: runtime.launchId, state: runtime.state, observedState: runtime.observedState, nativeSession: runtime.nativeSession, paneId: runtime.paneId, lastPoll: runtime.lastPoll });
  if (observation.paHire !== null) receipts.push({ kind: "pa-hire", ...observation.paHire });
  if (observation.pa?.runtime) {
    const paRuntime = observation.pa.runtime;
    receipts.push({ kind: "pa-runtime", employeeId: observation.pa.id, generation: paRuntime.generation, launchId: paRuntime.launchId, state: paRuntime.state, observedState: paRuntime.observedState, nativeSession: paRuntime.nativeSession, paneId: paRuntime.paneId, lastPoll: paRuntime.lastPoll });
  }
  if (observation.manager.sourceRevision !== null) receipts.push({ kind: "source-load", employeeId: "manager", generation: observation.manager.generation, roleRevision: observation.manager.sourceRevision });
  if (observation.pa?.sourceRevision) receipts.push({ kind: "source-load", employeeId: observation.pa.id, generation: observation.pa.generation, roleRevision: observation.pa.sourceRevision });
  const phase = runtime === null ? "unprepared"
    : runtime.state !== "ready" ? "manager-pending"
      : observation.paCount === 0 ? "pa-unhired"
        : observation.paCount > 1 ? "pa-conflict"
          : observation.pa?.runtime?.state !== "ready" || observation.pa.sourceRevision === null ? "pa-pending"
            : "ready";
  return { phase: setupPhaseSchema.parse(phase), receipts: receipts.map((receipt) => setupReceiptSchema.parse(receipt)) };
}
function reasonsFor(observation: HostObservation, pa: string | null, supervision: HostSupervision, deadlines: { connectionDeadlineMs: number; progressDeadlineMs: number }): HostReason[] {
  const reasons: HostReason[] = [];
  const at = observation.observedAt;
  const runtime = observation.manager.runtime;
  if (observation.duties.unreadable) reasons.push("duties-unreadable");
  if (observation.duties.count > 0) reasons.push("duties");
  if (observation.pendingIntentCount > 0) reasons.push("pending-intent");
  if (observation.queue.kind === "ambiguous") reasons.push("ambiguous-queue");
  if (observation.queue.kind === "invalid") reasons.push("invalid-queue");
  if (observation.manager.error !== null) reasons.push("manager-error");
  if (runtime?.state === "uncertain") reasons.push("manager-runtime-uncertain");
  if (runtime?.state === "abandoned") reasons.push("manager-runtime-abandoned");
  if (observation.reconciliation.claims > 0 || observation.reconciliation.grants > 0 || observation.reconciliation.assignments > 0) reasons.push("reconciliation");
  if (runtime === null) reasons.push("manager-runtime-absent");
  if (runtime !== null && (runtime.state === "prepared" || runtime.state === "starting")) reasons.push("manager-not-ready");
  if (runtime !== null && (runtime.lastPoll === 0 || at - runtime.lastPoll > deadlines.connectionDeadlineMs)) reasons.push("manager-poll");
  if (runtime?.observedState === "offline") reasons.push("manager-observed-offline");
  if (pa !== null) reasons.push("pa");
  if (supervision.errors.length > 0) reasons.push("supervision-errors");
  if (observation.leaseExpires <= at) reasons.push("lease");
  if (supervision.lastCompletedAt !== null && at - supervision.lastCompletedAt > deadlines.connectionDeadlineMs) reasons.push("supervision-freshness");
  if (observation.watched.oldestProgressAt !== null && at - observation.watched.oldestProgressAt > deadlines.progressDeadlineMs) reasons.push("item-progress");
  if (observation.watched.oldestUnclassifiedAt !== null && at - observation.watched.oldestUnclassifiedAt > deadlines.progressDeadlineMs) reasons.push("unclassified-input");
  return reasons;
}
function picture(observation: HostObservation, pa: string | null, supervision: HostSupervision, deadlines: { connectionDeadlineMs: number; progressDeadlineMs: number }, reasons: readonly HostReason[]): HostStatus {
  const state: HostState = reasons[0] === undefined ? "live" : reasonState[reasons[0]];
  return hostStatusSchema.parse({
    state,
    binding: observation.binding,
    storeRevision: observation.storeRevision,
    observedAt: observation.observedAt,
    freshness: {
      leaseExpiresAt: observation.leaseExpires,
      managerLastPoll: observation.manager.runtime?.lastPoll ?? null,
      supervisionCompletedAt: supervision.lastCompletedAt,
      supervisionSucceededAt: supervision.lastSuccessAt,
      connectionDeadlineMs: deadlines.connectionDeadlineMs,
      progressDeadlineMs: deadlines.progressDeadlineMs,
    },
    reasons,
    duties: observation.duties,
    setup: setup(observation),
    queue: observation.queue,
    teams: observation.teams,
    staff: observation.staff,
    supervision: {
      blocker: pa === null ? null : paBlockerSchema.parse(pa),
      lastStartedAt: supervision.lastStartedAt,
      lastCompletedAt: supervision.lastCompletedAt,
      lastSuccessAt: supervision.lastSuccessAt,
      errors: supervision.errors.slice(0, 8).map((error) => ({ ...error, error: error.error.slice(0, 256) })),
    },
    pendingInputs: observation.pendingInputs,
  });
}
export function openHostSurface(input: {
  readonly store: HostStore;
  readonly now: () => number;
  readonly deadlines: { readonly connectionDeadlineMs: number; readonly progressDeadlineMs: number };
  readonly readPa: () => string | null;
  readonly readSupervision: () => HostSupervision;
}): HostSurface {
  return {
    status(query: unknown): HostStatus {
      const parsed = hostStatusQuerySchema.parse(query);
      const observedAt = timeSchema.parse(input.now());
      const observation = hostObservationSchema.parse(input.store.observeHost({ observedAt, query: parsed }));
      const pa = input.readPa();
      const supervision = input.readSupervision();
      return picture(observation, pa, supervision, input.deadlines, reasonsFor(observation, pa, supervision, input.deadlines));
    },
    admit(request: unknown): HostReceipt {
      return hostReceiptSchema.parse(input.store.hostAdmit(hostAdmitRequestSchema.parse(request)));
    },
    cancel(request: unknown): HostReceipt {
      return hostReceiptSchema.parse(input.store.hostCancel(hostCancelRequestSchema.parse(request)));
    },
    receipt(id: unknown): HostReceipt {
      const parsed = idSchema.parse(id);
      const found = input.store.readHostReceipt(parsed);
      if (found === null) throw new StoreAuthorityError(`Host receipt ${parsed} does not exist`);
      return hostReceiptSchema.parse(found);
    },
  };
}
