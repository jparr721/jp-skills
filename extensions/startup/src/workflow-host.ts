import { randomUUID } from "node:crypto";
import { dispatchWorkflow, executeWorkflow, type WorkflowDecision, type WorkflowEffectReceipt, type WorkflowKind, type WorkflowRequest, type WorkflowTransaction, type WorkflowView } from "./workflow-engine";

type BoundedKind = Exclude<WorkflowKind, "startup">;
type Reservation = { id: string; itemIds: readonly string[]; state: "active" | "completed" | "failed" | "uncertain"; purpose?: "claim" | "assignment"; assignmentKey?: string };
type Review = { changeId: string; reservationId: string; head: string; state: "active" | "completed" | "uncertain"; verdict: null | "approve" | "changes-requested" | "block" };
type Scope = { id: string; workflow: BoundedKind; itemIds: readonly string[]; reviewLimit: number };
type RoleReceipt = { itemId: string; role: "architect" | "dev" | "qa"; agentId: string; head: string; reservationId: string; evidence: Readonly<Record<string, string>> };

/** Session-local authority: all nested scopes share the same reservations and reviews. */
export class BoundedWorkflowHost {
  private readonly scopes = new Map<string, Scope>();
  private readonly reservations: Reservation[] = [];
  private readonly reservationScopes = new Map<string, string>();
  private readonly completedItems: string[] = [];
  private readonly reviews: Review[] = [];
  private readonly reviewScopes = new Map<string, string>();
  private readonly reviewLimits = new Map<string, number>();
  private readonly roleReceipts: RoleReceipt[] = [];
  private readonly reviewActors = new Map<string, string>();
  private readonly landingHeads = new Map<string, string>();
  private readonly dependencyReadyItems: string[] = [];
  private readonly readinessHeads = new Map<string, string>();
  private dependencies: Readonly<Record<string, readonly string[]>>;
  private graphFrozen: boolean;
  private planner: { reservationId: string; state: "active" | "completed" | "failed" | "uncertain" } | null = null;
  private targets: Readonly<Record<string, readonly string[]>> = {};
  readonly rootId: string;

  constructor(workflow: BoundedKind, itemIds: readonly string[], reviewLimit: number, dependencies?: Readonly<Record<string, readonly string[]>>) {
    const cap = workflow === "factory" ? 3 : workflow === "pipeline" ? 2 : 1;
    if (!itemIds.length || itemIds.some((id) => !id.trim()) || new Set(itemIds).size !== itemIds.length || (workflow !== "factory" && itemIds.length !== 1)) throw new Error("Invalid frozen workflow scope");
    if (!Number.isSafeInteger(reviewLimit) || reviewLimit < 1 || reviewLimit > cap) throw new Error("Invalid workflow review limit");
    const items = new Set(itemIds);
    for (const [item, prerequisites] of Object.entries(dependencies ?? {})) {
      if (!items.has(item) || new Set(prerequisites).size !== prerequisites.length || prerequisites.some((id) => !items.has(id))) throw new Error("Dependency references an unknown or duplicate item");
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (item: string): void => {
      if (visiting.has(item)) throw new Error("Dependency cycle");
      if (visited.has(item)) return;
      visiting.add(item);
      for (const dependency of dependencies?.[item] ?? []) visit(dependency);
      visiting.delete(item); visited.add(item);
    };
    for (const item of itemIds) visit(item);
    this.dependencies = Object.fromEntries(Object.entries(dependencies ?? {}).map(([item, prerequisites]) => [item, [...prerequisites]]));
    this.graphFrozen = workflow !== "factory" || dependencies !== undefined;
    this.rootId = randomUUID();
    this.scopes.set(this.rootId, { id: this.rootId, workflow, itemIds: [...itemIds], reviewLimit });
  }

  private scope(id: string): Scope {
    const scope = this.scopes.get(id);
    if (!scope) throw new Error("Unknown workflow scope");
    return scope;
  }

  view(id: string): WorkflowView {
    const scope = this.scope(id);
    return { scope: { kind: "bounded", itemIds: scope.itemIds }, admitted: scope.itemIds, reservations: this.reservations.filter((entry) => entry.itemIds.every((item) => scope.itemIds.includes(item))), completedItemIds: this.completedItems, dependencyReadyItemIds: this.dependencyReadyItems, readyableItemIds: scope.itemIds.filter((item) => this.readyable(item, scope.workflow)), completableItemIds: scope.itemIds.filter((item) => this.completable(item, scope.workflow)), dependencies: this.dependencies, reviews: this.reviews.filter((entry) => scope.itemIds.includes(entry.changeId)), reviewLimit: scope.reviewLimit, reviewLimits: Object.fromEntries(scope.itemIds.map((item) => [item, Math.min(scope.reviewLimit, this.reviewLimits.get(item) ?? scope.reviewLimit)])), workflow: scope.workflow, planner: this.planner, graphFrozen: this.graphFrozen };
  }

  private adapter(id: string): WorkflowTransaction<void> {
    return {
      transaction: (run) => run(),
      read: () => this.view(id),
      apply: (decision: WorkflowDecision) => {
        switch (decision.kind) {
          case "plan": this.planner = { reservationId: decision.reservationId, state: "active" }; break;
          case "plan-settle":
            if (!this.planner || this.planner.reservationId !== decision.reservationId) throw new Error("Missing planner reservation");
            this.planner.state = decision.outcome;
            break;
          case "freeze":
            this.dependencies = Object.fromEntries(Object.entries(decision.dependencies).map(([item, prerequisites]) => [item, [...prerequisites]]));
            this.targets = Object.fromEntries(Object.entries(decision.targets).map(([item, targets]) => [item, [...targets]]));
            this.graphFrozen = true;
            break;
          case "reserve": this.reservations.push({ id: decision.reservationId, itemIds: [...decision.itemIds], state: "active", ...(decision.purpose === undefined ? {} : { purpose: decision.purpose }), ...(decision.assignmentKey === undefined ? {} : { assignmentKey: decision.assignmentKey }) }); this.reservationScopes.set(decision.reservationId, id); break;
          case "settle": {
            const entry = this.reservations.find((value) => value.id === decision.reservationId);
            if (!entry) throw new Error("Missing reservation");
            entry.state = decision.outcome;
            break;
          }
          case "review": this.reviews.push({ changeId: decision.changeId, reservationId: decision.reservationId, head: decision.head, state: "active", verdict: null }); break;
          case "review-settle": {
            const entry = this.reviews.find((value) => value.reservationId === decision.reservationId);
            if (!entry) throw new Error("Missing review");
            entry.state = decision.verdict === "uncertain" ? "uncertain" : "completed";
            entry.verdict = decision.verdict === "uncertain" ? null : decision.verdict;
            break;
          }
          case "review-batch":
            for (const change of decision.changes) this.reviews.push({ ...change, reservationId: decision.reservationId, state: "active", verdict: null });
            break;
          case "review-batch-settle":
            for (const entry of this.reviews.filter((value) => value.reservationId === decision.reservationId)) {
              entry.state = decision.verdict === "uncertain" ? "uncertain" : "completed";
              entry.verdict = decision.verdict === "uncertain" ? null : decision.verdict;
            }
            break;
          case "complete-item": this.completedItems.push(decision.itemId); break;
          case "ready-item": this.dependencyReadyItems.push(decision.itemId); break;
          case "reconcile": {
            const entry = this.reservations.find((value) => value.id === decision.reservationId);
            if (!entry) throw new Error("Missing reservation");
            entry.state = decision.outcome;
            break;
          }
          case "nest": break;
          case "admit": throw new Error("Frozen scopes cannot admit work");
        }
      },
    };
  }

  private transition(id: string, request: WorkflowRequest): void {
    executeWorkflow(request, this.adapter(id));
  }

  nest(parentId: string, workflow: BoundedKind, itemIds: readonly string[], limit: number): string {
    const parent = this.scope(parentId);
    if (!itemIds.length || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !parent.itemIds.includes(id)) || (workflow !== "factory" && itemIds.length !== 1)) throw new Error("Nested scope must be a nonempty subset of its parent");
    const id = randomUUID();
    this.transition(parentId, { kind: "nest", role: "owner", runId: id, workflow, limit });
    this.scopes.set(id, { id, workflow, itemIds: [...itemIds], reviewLimit: limit });
    for (const item of itemIds) this.reviewLimits.set(item, Math.min(limit, this.reviewLimits.get(item) ?? limit));
    return id;
  }

  reserve(scopeId: string, itemId: string, assignmentKey?: string): string {
    const id = randomUUID();
    this.transition(scopeId, { kind: "reserve", role: "owner", itemIds: [itemId], reservationId: id, ...(assignmentKey === undefined ? {} : { purpose: "assignment", assignmentKey }) });
    return id;
  }

  async dispatch(scopeId: string, itemId: string, assignmentKey: string, effect: (reservationId: string) => Promise<WorkflowEffectReceipt>): Promise<WorkflowEffectReceipt> {
    const reservationId = randomUUID();
    return dispatchWorkflow({ request: { kind: "reserve", role: "owner", itemIds: [itemId], reservationId, purpose: "assignment", assignmentKey }, adapter: this.adapter(scopeId), effect });
  }

  async plan(scopeId: string, effect: (reservationId: string) => Promise<WorkflowEffectReceipt>): Promise<WorkflowEffectReceipt> {
    if (scopeId !== this.rootId || this.scope(scopeId).workflow !== "factory") throw new Error("Planning requires the factory root");
    return dispatchWorkflow({ request: { kind: "plan", role: "owner", reservationId: randomUUID() }, adapter: this.adapter(scopeId), effect });
  }

  reservePlan(scopeId: string): string {
    if (scopeId !== this.rootId || this.scope(scopeId).workflow !== "factory") throw new Error("Planning requires the factory root");
    const reservationId = randomUUID();
    this.transition(scopeId, { kind: "plan", role: "owner", reservationId });
    return reservationId;
  }

  settlePlan(scopeId: string, reservationId: string, outcome: "completed" | "failed" | "uncertain"): void {
    if (scopeId !== this.rootId) throw new Error("Planner belongs to the factory root");
    this.transition(scopeId, { kind: "plan-settle", role: "owner", reservationId, outcome });
  }

  freeze(scopeId: string, reservationId: string, dependencies: Readonly<Record<string, readonly string[]>>, targets: Readonly<Record<string, readonly string[]>>): void {
    if (scopeId !== this.rootId) throw new Error("Planner belongs to the factory root");
    this.transition(scopeId, { kind: "freeze", role: "owner", reservationId, dependencies, targets });
  }

  completePlan(scopeId: string, reservationId: string, plan: Readonly<{ dependencies: Readonly<Record<string, readonly string[]>>; targets: Readonly<Record<string, readonly string[]>> }>): void {
    if (scopeId !== this.rootId || this.planner?.reservationId !== reservationId || this.planner.state !== "active") throw new Error("Planner reservation is not active");
    const adapter = this.adapter(scopeId);
    const freeze: WorkflowRequest = { kind: "freeze", role: "owner", reservationId, ...plan };
    executeWorkflow(freeze, { ...adapter, read: () => ({ ...this.view(scopeId), planner: { reservationId, state: "completed" } }), apply: () => undefined });
    this.settlePlan(scopeId, reservationId, "completed");
    this.freeze(scopeId, reservationId, plan.dependencies, plan.targets);
  }

  plannedTargets(scopeId: string): Readonly<Record<string, readonly string[]>> {
    if (scopeId !== this.rootId || !this.graphFrozen) throw new Error("Factory graph is not frozen");
    return this.targets;
  }

  reserveReview(scopeId: string, changes: readonly { changeId: string; head: string }[]): string {
    const scope = this.scope(scopeId);
    if (changes.some((change) => !scope.itemIds.includes(change.changeId))) throw new Error("Review change is outside the frozen scope");
    const reservationId = randomUUID();
    this.transition(scopeId, { kind: "review-batch", role: "owner", reservationId, changes });
    this.reviewScopes.set(reservationId, scopeId);
    return reservationId;
  }

  settleReview(scopeId: string, reservationId: string, changes: readonly { changeId: string; head: string }[], verdict: "approve" | "changes-requested" | "block" | "uncertain"): void {
    if (this.reviewScopes.get(reservationId) !== scopeId) throw new Error("Review belongs to a different scope");
    this.transition(scopeId, { kind: "review-batch-settle", role: "owner", reservationId, changes, verdict });
  }

  settle(scopeId: string, reservationId: string, outcome: "completed" | "failed" | "uncertain"): void {
    if (this.reservationScopes.get(reservationId) !== scopeId) throw new Error("Reservation belongs to a different scope");
    this.transition(scopeId, { kind: "settle", role: "owner", reservationId, outcome });
  }

  reconcile(scopeId: string, reservationId: string, outcome: "completed" | "failed", evidence: string): void {
    if (this.reservationScopes.get(reservationId) !== scopeId) throw new Error("Reservation belongs to a different scope");
    this.transition(scopeId, { kind: "reconcile", role: "owner", reservationId, outcome, evidence });
  }

  recordRole(scopeId: string, receipt: RoleReceipt): void {
    if (this.reservationScopes.get(receipt.reservationId) !== scopeId || !this.reservations.some((entry) => entry.id === receipt.reservationId && entry.itemIds.includes(receipt.itemId) && entry.state === "completed")) throw new Error("Role receipt has no completed scoped assignment");
    this.roleReceipts.push(receipt);
  }

  settleRole(scopeId: string, reservationId: string, receipt: Omit<RoleReceipt, "reservationId">): void {
    if (this.reservationScopes.get(reservationId) !== scopeId || !this.reservations.some((entry) => entry.id === reservationId && entry.itemIds.includes(receipt.itemId) && entry.state === "active")) throw new Error("Role receipt has no active scoped assignment");
    const adapter = this.adapter(scopeId);
    executeWorkflow({ kind: "settle", role: "owner", reservationId, outcome: "completed" }, {
      ...adapter,
      apply: (decision) => {
        adapter.apply(decision);
        this.roleReceipts.push({ ...receipt, reservationId });
      },
    });
  }

  recordReviewActor(scopeId: string, reservationId: string, agentId: string): void {
    if (this.reviewScopes.get(reservationId) !== scopeId || !agentId) throw new Error("Review actor is not scoped");
    this.reviewActors.set(reservationId, agentId);
  }

  private readyable(itemId: string, workflow: BoundedKind): boolean {
    const head = this.readinessHeads.get(itemId);
    if (!head) return false;
    const dev = this.roleReceipts.find((entry) => entry.itemId === itemId && entry.role === "dev" && entry.head === head);
    const architect = this.roleReceipts.find((entry) => entry.itemId === itemId && entry.role === "architect");
    const qa = this.roleReceipts.find((entry) => entry.itemId === itemId && entry.role === "qa" && entry.head === head && entry.agentId !== dev?.agentId);
    return workflow === "hotfix" ? Boolean(dev) : Boolean(dev && architect && qa && architect.agentId !== dev.agentId && architect.agentId !== qa.agentId);
  }

  private validateReady(scopeId: string, itemId: string): void {
    const adapter = this.adapter(scopeId);
    executeWorkflow({ kind: "ready-item", role: "owner", itemId }, {
      ...adapter,
      read: () => {
        const view = adapter.read();
        return { ...view, dependencyReadyItemIds: view.dependencyReadyItemIds?.filter((id) => id !== itemId) ?? [] };
      },
      apply: () => undefined,
    });
  }

  ready(scopeId: string, itemId: string, verifiedHead: string): void {
    this.scope(scopeId);
    this.readinessHeads.set(itemId, verifiedHead);
    try {
      this.validateReady(scopeId, itemId);
      if (!this.dependencyReadyItems.includes(itemId)) this.transition(scopeId, { kind: "ready-item", role: "owner", itemId });
    }
    finally { this.readinessHeads.delete(itemId); }
  }

  readyItem(scopeId: string, itemId: string, evidence: Readonly<{ worktree: string; head: string; prNumber: number }>): void {
    this.ready(scopeId, itemId, evidence.head);
  }

  finishRun(scopeId: string, handoff: Readonly<{ items: readonly Readonly<{ itemId: string; worktree: string; head: string; prNumber: number }>[] }>): void {
    const scope = this.scope(scopeId);
    if (handoff.items.length !== scope.itemIds.length || new Set(handoff.items.map((item) => item.itemId)).size !== scope.itemIds.length || handoff.items.some((item) => !scope.itemIds.includes(item.itemId))) throw new Error("Handoff must cover the exact scope");
    for (const item of handoff.items) this.readinessHeads.set(item.itemId, item.head);
    try {
      for (const item of handoff.items) this.validateReady(scopeId, item.itemId);
      for (const item of handoff.items) {
        if (!this.dependencyReadyItems.includes(item.itemId)) this.transition(scopeId, { kind: "ready-item", role: "owner", itemId: item.itemId });
      }
    } finally {
      for (const item of handoff.items) this.readinessHeads.delete(item.itemId);
    }
  }

  private completable(itemId: string, workflow: BoundedKind): boolean {
    const head = this.landingHeads.get(itemId);
    if (!head) return false;
    const dev = this.roleReceipts.find((entry) => entry.itemId === itemId && entry.role === "dev" && entry.head === head);
    const architect = this.roleReceipts.find((entry) => entry.itemId === itemId && entry.role === "architect");
    const qa = this.roleReceipts.find((entry) => entry.itemId === itemId && entry.role === "qa" && entry.head === head && entry.agentId !== dev?.agentId);
    const approved = this.reviews.find((entry) => entry.changeId === itemId && entry.head === head && entry.state === "completed" && entry.verdict === "approve" && this.reviewActors.get(entry.reservationId) !== undefined && this.reviewActors.get(entry.reservationId) !== dev?.agentId);
    return Boolean(dev && approved && (workflow === "hotfix" || (architect && qa && architect.agentId !== dev.agentId && architect.agentId !== qa.agentId)));
  }

  complete(scopeId: string, itemId: string, landedHead: string): void {
    this.scope(scopeId);
    this.landingHeads.set(itemId, landedHead);
    try { this.transition(scopeId, { kind: "complete-item", role: "owner", itemId }); }
    finally { this.landingHeads.delete(itemId); }
  }
}
