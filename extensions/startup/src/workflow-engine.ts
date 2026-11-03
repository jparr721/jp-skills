// Host-neutral lifecycle decisions. The adapter reads and applies canonical state in
// the same synchronous transaction; external effects happen only after it commits.
export type WorkflowRole = "owner" | "manager" | "architect" | "dev" | "qa" | "devops" | "pa";
export type WorkflowKind = "startup" | "factory" | "pipeline" | "hotfix";
export type WorkflowOutcome = "completed" | "failed" | "uncertain";
export type WorkflowRequest =
  | { kind: "admit"; role: WorkflowRole; itemIds: readonly string[] }
  | { kind: "plan"; role: WorkflowRole; reservationId: string }
  | { kind: "plan-settle"; role: WorkflowRole; reservationId: string; outcome: WorkflowOutcome }
  | { kind: "freeze"; role: WorkflowRole; reservationId: string; dependencies: Readonly<Record<string, readonly string[]>>; targets: Readonly<Record<string, readonly string[]>> }
  | { kind: "reserve"; role: WorkflowRole; itemIds: readonly string[]; reservationId: string; purpose?: "claim" | "assignment"; assignmentKey?: string }
  | { kind: "settle"; role: WorkflowRole; reservationId: string; outcome: WorkflowOutcome; purpose?: "claim" | "assignment" }
  | { kind: "ready-item"; role: WorkflowRole; itemId: string }
  | { kind: "complete-item"; role: WorkflowRole; itemId: string }
  | { kind: "review"; role: WorkflowRole; changeId: string; reservationId: string; head: string }
  | { kind: "review-settle"; role: WorkflowRole; reservationId: string; head: string; verdict: "approve" | "changes-requested" | "block" | "uncertain" }
  | { kind: "review-batch"; role: WorkflowRole; reservationId: string; changes: readonly Readonly<{ changeId: string; head: string }>[] }
  | { kind: "review-batch-settle"; role: WorkflowRole; reservationId: string; changes: readonly Readonly<{ changeId: string; head: string }>[]; verdict: "approve" | "changes-requested" | "block" | "uncertain" }
  | { kind: "reconcile"; role: WorkflowRole; reservationId: string; outcome: "completed" | "failed"; evidence: string }
  | { kind: "nest"; role: WorkflowRole; runId: string; workflow: Exclude<WorkflowKind, "startup">; limit: number };
export type WorkflowDecision = WorkflowRequest;
export type WorkflowView = Readonly<{
  scope: { kind: "startup" } | { kind: "bounded"; itemIds: readonly string[] };
  admitted: readonly string[];
  reservations: readonly Readonly<{ id: string; itemIds: readonly string[]; state: "active" | WorkflowOutcome; purpose?: "claim" | "assignment"; assignmentKey?: string }>[];
  completedItemIds?: readonly string[];
  completableItemIds?: readonly string[];
  dependencyReadyItemIds?: readonly string[];
  readyableItemIds?: readonly string[];
  reviews: readonly Readonly<{ changeId: string; reservationId: string; head: string; state: "active" | "completed" | "uncertain"; verdict: null | "approve" | "changes-requested" | "block" }>[];
  reviewLimit: number;
  reviewLimits?: Readonly<Record<string, number>>;
  workflow: WorkflowKind;
  dependencies?: Readonly<Record<string, readonly string[]>>;
  planner?: Readonly<{ reservationId: string; state: "active" | WorkflowOutcome }> | null;
  graphFrozen?: boolean;
}>;
export type WorkflowTransaction<T> = Readonly<{
  transaction: (run: () => T) => T;
  read: () => WorkflowView;
  apply: (decision: WorkflowDecision) => T;
}>;
export class WorkflowError extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowError"; }
}
function requireValue(condition: boolean, message: string): void {
  if (!condition) throw new WorkflowError(message);
}
function nonempty(value: string): boolean { return value.trim().length > 0; }
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
const caps: Readonly<Record<WorkflowKind, number>> = { startup: 3, factory: 3, pipeline: 2, hotfix: 1 };

/** Execute a transition against the host's authoritative state, atomically. */
export function executeWorkflow<T>(request: WorkflowRequest, adapter: WorkflowTransaction<T>): T {
  return adapter.transaction(() => {
    const view = adapter.read();
    requireValue(Number.isSafeInteger(view.reviewLimit) && view.reviewLimit >= 1 && view.reviewLimit <= caps[view.workflow], "Invalid inherited review limit");
    const manager = request.role === "owner" || request.role === "manager";
    switch (request.kind) {
      case "admit": {
        requireValue(manager, "Only the owner or manager can admit work");
        requireValue(request.itemIds.length > 0 && request.itemIds.every(nonempty) && unique(request.itemIds), "Admission requires distinct item identities");
        requireValue(view.scope.kind === "startup", "A bounded queue is frozen and cannot admit work");
        requireValue(request.itemIds.every((id) => !view.admitted.includes(id)), "Work is already admitted");
        break;
      }
      case "plan": {
        requireValue(manager && view.scope.kind === "bounded" && view.graphFrozen === false, "Planning requires a manager and an unfrozen bounded scope");
        requireValue(nonempty(request.reservationId) && (view.planner == null || (view.planner.state === "failed" && view.planner.reservationId !== request.reservationId)), "Planner is already reserved, reused or requires reconciliation");
        break;
      }
      case "plan-settle": {
        requireValue(manager && view.graphFrozen === false && view.planner?.reservationId === request.reservationId && view.planner.state === "active", "Planner receipt does not match the active reservation");
        break;
      }
      case "freeze": {
        requireValue(manager && view.scope.kind === "bounded" && view.graphFrozen === false && view.planner?.reservationId === request.reservationId && view.planner.state === "completed", "Freeze requires the correlated completed planner");
        if (view.scope.kind !== "bounded") throw new WorkflowError("Freeze requires a bounded scope");
        const ids = view.scope.itemIds;
        const graph = request.dependencies;
        requireValue(ids.length > 0 && unique(ids) && ids.every(nonempty), "Frozen queue must contain distinct items");
        requireValue(Object.keys(request.dependencies).length === ids.length && Object.keys(request.targets).length === ids.length && ids.every((id) => Object.hasOwn(request.dependencies, id) && Object.hasOwn(request.targets, id)), "Planner must describe every frozen item and no others");
        for (const id of ids) {
          const dependencies = request.dependencies[id];
          const targets = request.targets[id];
          requireValue(dependencies !== undefined && unique(dependencies) && dependencies.every((dependency) => dependency !== id && ids.includes(dependency)), "Invalid dependency graph");
          requireValue(targets !== undefined && targets.length > 0 && unique(targets) && targets.every(nonempty), "Every item requires explicit distinct targets");
        }
        const visiting = new Set<string>();
        const visited = new Set<string>();
        function visit(id: string): void {
          requireValue(!visiting.has(id), "Dependency graph contains a cycle");
          if (visited.has(id)) return;
          visiting.add(id);
          for (const dependency of graph[id] ?? []) visit(dependency);
          visiting.delete(id);
          visited.add(id);
        }
        for (const id of ids) visit(id);
        break;
      }
      case "reserve": {
        requireValue(view.graphFrozen !== false, "Planning must finish and freeze before dispatch");
        requireValue(request.purpose === "claim" || manager || request.role === "architect", "Only the owner, manager or architect can reserve work");
        requireValue(nonempty(request.reservationId) && request.itemIds.length > 0 && unique(request.itemIds), "Reservation requires distinct work and an identity");
        requireValue(!view.reservations.some((entry) => entry.id === request.reservationId), "Reservation identity already exists");
        if (request.purpose === "assignment") requireValue(request.itemIds.length === 1 && request.assignmentKey !== undefined && nonempty(request.assignmentKey) && view.completedItemIds !== undefined, "Assignment requires one item, a key and canonical item completion state");
        for (const id of request.itemIds) {
          requireValue(view.admitted.includes(id), "Work was not admitted");
          requireValue(view.scope.kind === "startup" || view.scope.itemIds.includes(id), "Work is outside the frozen queue");
          if (request.purpose === "assignment") {
            requireValue(!view.completedItemIds?.includes(id), "Work is already complete");
            requireValue(!view.reservations.some((entry) => entry.purpose === "assignment" && entry.itemIds.includes(id) && entry.assignmentKey === request.assignmentKey && entry.state !== "failed"), "Assignment already reserved, completed or uncertain");
          } else {
            requireValue(!view.reservations.some((entry) => entry.itemIds.includes(id) && (entry.state === "active" || entry.state === "uncertain" || entry.state === "completed")), "Work is already reserved, uncertain or completed");
          }
          for (const dependency of view.dependencies?.[id] ?? []) requireValue(view.completedItemIds !== undefined ? view.completedItemIds.includes(dependency) || view.dependencyReadyItemIds?.includes(dependency) === true : view.reservations.some((entry) => entry.itemIds.includes(dependency) && entry.state === "completed"), "Work has an incomplete dependency");
        }
        break;
      }
      case "ready-item": {
        requireValue(manager, "Only the owner or manager can mark work ready");
        requireValue(view.admitted.includes(request.itemId) && (view.scope.kind === "startup" || view.scope.itemIds.includes(request.itemId)), "Work is outside the admitted scope");
        requireValue(view.dependencyReadyItemIds !== undefined && !view.dependencyReadyItemIds.includes(request.itemId) && !view.completedItemIds?.includes(request.itemId) && view.readyableItemIds?.includes(request.itemId) === true, "Canonical readiness gates are not satisfied");
        const assignments = view.reservations.filter((entry) => entry.purpose === "assignment" && entry.itemIds.includes(request.itemId));
        requireValue(assignments.some((entry) => entry.state === "completed") && !assignments.some((entry) => entry.state === "active" || entry.state === "uncertain"), "Assignments are incomplete or uncertain");
        break;
      }
      case "complete-item": {
        requireValue(manager, "Only the owner or manager can complete work");
        requireValue(view.admitted.includes(request.itemId) && (view.scope.kind === "startup" || view.scope.itemIds.includes(request.itemId)), "Work is outside the admitted scope");
        requireValue(view.completedItemIds !== undefined && !view.completedItemIds.includes(request.itemId) && view.completableItemIds?.includes(request.itemId) === true, "Canonical completion gates are not satisfied");
        const assignments = view.reservations.filter((entry) => entry.purpose === "assignment" && entry.itemIds.includes(request.itemId));
        requireValue(assignments.some((entry) => entry.state === "completed") && !assignments.some((entry) => entry.state === "active" || entry.state === "uncertain"), "Assignments are incomplete or uncertain");
        break;
      }
      case "settle": {
        requireValue(request.purpose === "claim" || request.role !== "pa", "PA cannot settle work");
        const reservation = view.reservations.find((entry) => entry.id === request.reservationId);
        requireValue(reservation !== undefined && reservation.state === "active", "Reservation is not active; uncertain work requires reconciliation");
        break;
      }
      case "reconcile": {
        requireValue(manager && nonempty(request.evidence), "Only an owner or manager can reconcile with evidence");
        const reservation = view.reservations.find((entry) => entry.id === request.reservationId);
        requireValue(reservation !== undefined && reservation.state === "uncertain", "Only uncertain reservations can be reconciled");
        break;
      }
      case "review":
      case "review-batch": {
        requireValue(manager || request.role === "architect" || request.role === "qa", "Role cannot reserve a review");
        const changes = request.kind === "review" ? [{ changeId: request.changeId, head: request.head }] : request.changes;
        requireValue(nonempty(request.reservationId) && changes.length > 0 && changes.every((entry) => nonempty(entry.changeId) && nonempty(entry.head)) && unique(changes.map((entry) => entry.changeId)), "Review requires distinct change identities and heads");
        requireValue(!view.reviews.some((entry) => entry.reservationId === request.reservationId), "Review reservation already exists");
        for (const change of changes) {
          const limit = view.reviewLimits?.[change.changeId] ?? view.reviewLimit;
          requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= view.reviewLimit, "Invalid inherited change review limit");
          const reviews = view.reviews.filter((entry) => entry.changeId === change.changeId);
          requireValue(!reviews.some((entry) => entry.state === "completed" && entry.verdict === "approve"), "Approved change cannot be reviewed again");
          requireValue(!reviews.some((entry) => entry.state === "active" || entry.state === "uncertain"), "Review already active or uncertain");
          requireValue(reviews.filter((entry) => entry.state === "completed").length < limit, "Review budget exhausted");
        }
        break;
      }
      case "review-settle":
      case "review-batch-settle": {
        requireValue(request.role !== "pa", "PA cannot settle a review");
        const reviews = view.reviews.filter((entry) => entry.reservationId === request.reservationId);
        requireValue(reviews.length > 0 && reviews.every((entry) => entry.state === "active"), "Review reservation is not active");
        if (request.kind === "review-settle") {
          requireValue(reviews.length === 1 && reviews[0]?.head === request.head, "Review receipt does not match its active reservation and head");
        } else {
          requireValue(request.changes.length === reviews.length && unique(request.changes.map((entry) => entry.changeId)) && request.changes.every((change) => reviews.some((entry) => entry.changeId === change.changeId && entry.head === change.head)), "Review receipt does not match the complete reservation and heads");
        }
        break;
      }
      case "nest": {
        requireValue(manager, "Only the owner or manager can nest workflows");
        requireValue(nonempty(request.runId) && Number.isSafeInteger(request.limit) && request.limit > 0 && request.limit <= view.reviewLimit && request.limit <= caps[request.workflow], "Nested review limit exceeds inherited or workflow limit");
        requireValue(view.workflow === "startup" || (view.workflow === "factory" && (request.workflow === "pipeline" || request.workflow === "hotfix")) || (view.workflow === "pipeline" && request.workflow === "hotfix"), "Workflow cannot nest this scope");
        break;
      }
    }
    return adapter.apply(request);
  });
}
export type WorkflowEffectReceipt =
  | Readonly<{ reservationId: string; status: "accepted" }>
  | Readonly<{ reservationId: string; status: "completed" | "failed" }>;

/** Commit a reservation before invoking a real host effect; never retry an uncertain effect. */
export async function dispatchWorkflow<T>(input: Readonly<{
  request: Extract<WorkflowRequest, { kind: "reserve" | "plan" }>;
  adapter: WorkflowTransaction<T>;
  effect: (reservationId: string) => Promise<WorkflowEffectReceipt>;
}>): Promise<WorkflowEffectReceipt> {
  executeWorkflow(input.request, input.adapter);
  let receipt: WorkflowEffectReceipt;
  try {
    receipt = await input.effect(input.request.reservationId);
    if (receipt.reservationId !== input.request.reservationId) throw new WorkflowError("Host receipt has the wrong reservation identity");
    if (receipt.status !== "accepted" && receipt.status !== "completed" && receipt.status !== "failed") throw new WorkflowError("Unknown host receipt status");
  } catch (error: unknown) {
    executeWorkflow(input.request.kind === "plan"
      ? { kind: "plan-settle", role: input.request.role, reservationId: input.request.reservationId, outcome: "uncertain" }
      : { kind: "settle", role: input.request.role, reservationId: input.request.reservationId, outcome: "uncertain", ...(input.request.purpose === undefined ? {} : { purpose: input.request.purpose }) }, input.adapter);
    throw error;
  }
  if (receipt.status !== "accepted") executeWorkflow(input.request.kind === "plan"
    ? { kind: "plan-settle", role: input.request.role, reservationId: receipt.reservationId, outcome: receipt.status }
    : { kind: "settle", role: input.request.role, reservationId: receipt.reservationId, outcome: receipt.status, ...(input.request.purpose === undefined ? {} : { purpose: input.request.purpose }) }, input.adapter);
  return receipt;
}

export function dispatchPlanner<T>(input: Readonly<{
  request: Extract<WorkflowRequest, { kind: "plan" }>;
  adapter: WorkflowTransaction<T>;
  effect: (reservationId: string) => Promise<WorkflowEffectReceipt>;
}>): Promise<WorkflowEffectReceipt> {
  return dispatchWorkflow(input);
}
