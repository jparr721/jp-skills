import { expect, test } from "bun:test";
import { dispatchWorkflow, executeWorkflow, WorkflowError, type WorkflowDecision, type WorkflowTransaction, type WorkflowView } from "../src/workflow-engine";

function fixture(items = false, planning = false) {
  let view: WorkflowView = { scope: { kind: "bounded", itemIds: ["a", "b"] }, admitted: ["a", "b"], reservations: [], reviews: [], reviewLimit: 3, workflow: "factory", dependencies: { b: ["a"] }, ...(items ? { completedItemIds: [], completableItemIds: ["a"], dependencyReadyItemIds: [], readyableItemIds: ["a"] } : {}), ...(planning ? { planner: null, graphFrozen: false } : {}) };
  const adapter: WorkflowTransaction<void> = {
    transaction: (run) => run(),
    read: () => view,
    apply: (decision: WorkflowDecision) => {
      switch (decision.kind) {
        case "plan": view = { ...view, planner: { reservationId: decision.reservationId, state: "active" } }; break;
        case "plan-settle": view = { ...view, planner: { reservationId: decision.reservationId, state: decision.outcome } }; break;
        case "freeze": view = { ...view, graphFrozen: true, dependencies: decision.dependencies }; break;
        case "reserve": view = { ...view, reservations: [...view.reservations, { id: decision.reservationId, itemIds: decision.itemIds, state: "active", ...(decision.purpose === undefined ? {} : { purpose: decision.purpose }), ...(decision.assignmentKey === undefined ? {} : { assignmentKey: decision.assignmentKey }) }] }; break;
        case "settle": case "reconcile": view = { ...view, reservations: view.reservations.map((r) => r.id === decision.reservationId ? { ...r, state: decision.outcome } : r) }; break;
        case "review": view = { ...view, reviews: [...view.reviews, { changeId: decision.changeId, reservationId: decision.reservationId, head: decision.head, state: "active", verdict: null }] }; break;
        case "review-batch": view = { ...view, reviews: [...view.reviews, ...decision.changes.map((change) => ({ ...change, reservationId: decision.reservationId, state: "active" as const, verdict: null }))] }; break;
        case "ready-item": view = { ...view, dependencyReadyItemIds: [...(view.dependencyReadyItemIds ?? []), decision.itemId] }; break;
        case "complete-item": view = { ...view, completedItemIds: [...(view.completedItemIds ?? []), decision.itemId] }; break;
        case "review-settle": case "review-batch-settle": view = { ...view, reviews: view.reviews.map((r) => r.reservationId === decision.reservationId ? { ...r, state: decision.verdict === "uncertain" ? "uncertain" : "completed", verdict: decision.verdict === "uncertain" ? null : decision.verdict } : r) }; break;
        case "admit": view = { ...view, admitted: [...view.admitted, ...decision.itemIds] }; break;
        case "nest": break;
      }
    },
  };
  return { adapter, read: () => view };
}

test("frozen work waits for completed dependencies and cannot be extended", () => {
  const { adapter } = fixture();
  expect(() => executeWorkflow({ kind: "admit", role: "owner", itemIds: ["c"] }, adapter)).toThrow(WorkflowError);
  expect(() => executeWorkflow({ kind: "reserve", role: "owner", itemIds: ["b"], reservationId: "b1" }, adapter)).toThrow(WorkflowError);
  executeWorkflow({ kind: "reserve", role: "owner", itemIds: ["a"], reservationId: "a1" }, adapter);
  executeWorkflow({ kind: "settle", role: "owner", reservationId: "a1", outcome: "completed" }, adapter);
  executeWorkflow({ kind: "reserve", role: "owner", itemIds: ["b"], reservationId: "b1" }, adapter);
});

test("dispatch persists reservation first and uncertain effects cannot be replayed", async () => {
  const { adapter, read } = fixture();
  await expect(dispatchWorkflow({ request: { kind: "reserve", role: "owner", itemIds: ["a"], reservationId: "run-1" }, adapter, effect: async () => {
    expect(read().reservations[0]?.state).toBe("active");
    throw new Error("connection lost");
  } })).rejects.toThrow("connection lost");
  expect(read().reservations[0]?.state).toBe("uncertain");
  expect(() => executeWorkflow({ kind: "reserve", role: "owner", itemIds: ["a"], reservationId: "run-2" }, adapter)).toThrow(WorkflowError);
  executeWorkflow({ kind: "reconcile", role: "manager", reservationId: "run-1", outcome: "failed", evidence: "host confirms no task" }, adapter);
  executeWorkflow({ kind: "reserve", role: "owner", itemIds: ["a"], reservationId: "run-2" }, adapter);
});

test("reviews require matching head, count verdicts and stop after approval", () => {
  const { adapter } = fixture();
  executeWorkflow({ kind: "review", role: "manager", changeId: "change", reservationId: "r1", head: "h1" }, adapter);
  expect(() => executeWorkflow({ kind: "review-settle", role: "manager", reservationId: "r1", head: "wrong", verdict: "approve" }, adapter)).toThrow(WorkflowError);
  executeWorkflow({ kind: "review-settle", role: "manager", reservationId: "r1", head: "h1", verdict: "approve" }, adapter);
  expect(() => executeWorkflow({ kind: "review", role: "manager", changeId: "change", reservationId: "r2", head: "h2" }, adapter)).toThrow(WorkflowError);
});

test("accepted native receipt stays active until a matching terminal result", async () => {
  const { adapter, read } = fixture();
  const receipt = await dispatchWorkflow({ request: { kind: "reserve", role: "owner", itemIds: ["a"], reservationId: "job-1" }, adapter, effect: async (reservationId) => ({ reservationId, status: "accepted" }) });
  expect(receipt.status).toBe("accepted");
  expect(read().reservations[0]?.state).toBe("active");
  expect(() => executeWorkflow({ kind: "settle", role: "owner", reservationId: "other", outcome: "completed" }, adapter)).toThrow(WorkflowError);
  executeWorkflow({ kind: "settle", role: "owner", reservationId: "job-1", outcome: "completed" }, adapter);
  expect(read().reservations[0]?.state).toBe("completed");
});

test("uncertain review does not become a verdict or permit another round", () => {
  const { adapter, read } = fixture();
  executeWorkflow({ kind: "review", role: "manager", changeId: "change", reservationId: "r1", head: "h1" }, adapter);
  executeWorkflow({ kind: "review-settle", role: "manager", reservationId: "r1", head: "h1", verdict: "uncertain" }, adapter);
  expect(read().reviews[0]).toMatchObject({ state: "uncertain", verdict: null });
  expect(() => executeWorkflow({ kind: "review", role: "manager", changeId: "change", reservationId: "r2", head: "h1" }, adapter)).toThrow(WorkflowError);
});

test("batch review checks all budgets before reserving and settles only the entire matching set", () => {
  const { adapter, read } = fixture();
  executeWorkflow({ kind: "review", role: "manager", changeId: "a", reservationId: "prior", head: "old" }, adapter);
  executeWorkflow({ kind: "review-settle", role: "manager", reservationId: "prior", head: "old", verdict: "approve" }, adapter);
  expect(() => executeWorkflow({ kind: "review-batch", role: "manager", reservationId: "rejected", changes: [{ changeId: "b", head: "h2" }, { changeId: "a", head: "h1" }] }, adapter)).toThrow(WorkflowError);
  expect(read().reviews).toHaveLength(1);
  const changes = [{ changeId: "b", head: "h2" }, { changeId: "c", head: "h3" }];
  executeWorkflow({ kind: "review-batch", role: "manager", reservationId: "batch", changes }, adapter);
  expect(() => executeWorkflow({ kind: "review-settle", role: "manager", reservationId: "batch", head: "h2", verdict: "approve" }, adapter)).toThrow(WorkflowError);
  expect(() => executeWorkflow({ kind: "review-batch-settle", role: "manager", reservationId: "batch", changes: [{ changeId: "b", head: "h2" }], verdict: "approve" }, adapter)).toThrow(WorkflowError);
  executeWorkflow({ kind: "review-batch-settle", role: "manager", reservationId: "batch", changes: [...changes].reverse(), verdict: "changes-requested" }, adapter);
  expect(read().reviews.filter((entry) => entry.reservationId === "batch").map((entry) => entry.verdict)).toEqual(["changes-requested", "changes-requested"]);
});

test("batch respects each change's inherited cap without partially reserving", () => {
  const { adapter, read } = fixture();
  const limited: WorkflowTransaction<void> = { ...adapter, read: () => ({ ...read(), reviewLimits: { a: 1, b: 3 } }) };
  executeWorkflow({ kind: "review", role: "manager", changeId: "a", reservationId: "first", head: "old" }, limited);
  executeWorkflow({ kind: "review-settle", role: "manager", reservationId: "first", head: "old", verdict: "changes-requested" }, limited);
  expect(() => executeWorkflow({ kind: "review-batch", role: "manager", reservationId: "batch", changes: [{ changeId: "b", head: "h2" }, { changeId: "a", head: "h1" }] }, limited)).toThrow(WorkflowError);
  expect(read().reviews).toHaveLength(1);
});

test("parallel assignments do not complete the item or unlock dependencies", () => {
  const { adapter, read } = fixture(true);
  executeWorkflow({ kind: "reserve", role: "owner", purpose: "assignment", assignmentKey: "architect", itemIds: ["a"], reservationId: "arch" }, adapter);
  executeWorkflow({ kind: "reserve", role: "owner", purpose: "assignment", assignmentKey: "developer", itemIds: ["a"], reservationId: "dev" }, adapter);
  executeWorkflow({ kind: "settle", role: "owner", purpose: "assignment", reservationId: "arch", outcome: "completed" }, adapter);
  expect(() => executeWorkflow({ kind: "complete-item", role: "owner", itemId: "a" }, adapter)).toThrow(WorkflowError);
  expect(() => executeWorkflow({ kind: "reserve", role: "owner", purpose: "assignment", assignmentKey: "developer", itemIds: ["b"], reservationId: "b" }, adapter)).toThrow(WorkflowError);
  executeWorkflow({ kind: "settle", role: "owner", purpose: "assignment", reservationId: "dev", outcome: "completed" }, adapter);
  executeWorkflow({ kind: "complete-item", role: "owner", itemId: "a" }, adapter);
  expect(read().completedItemIds).toEqual(["a"]);
  executeWorkflow({ kind: "reserve", role: "owner", purpose: "assignment", assignmentKey: "developer", itemIds: ["b"], reservationId: "b" }, adapter);
});

test("dependency readiness unlocks stacked work without final completion", () => {
  const { adapter, read } = fixture(true);
  executeWorkflow({ kind: "reserve", role: "owner", purpose: "assignment", assignmentKey: "dev", itemIds: ["a"], reservationId: "dev-a" }, adapter);
  expect(() => executeWorkflow({ kind: "ready-item", role: "owner", itemId: "a" }, adapter)).toThrow(WorkflowError);
  executeWorkflow({ kind: "settle", role: "owner", reservationId: "dev-a", outcome: "completed", purpose: "assignment" }, adapter);
  executeWorkflow({ kind: "ready-item", role: "owner", itemId: "a" }, adapter);
  expect(read().completedItemIds).toEqual([]);
  executeWorkflow({ kind: "reserve", role: "owner", purpose: "assignment", assignmentKey: "dev", itemIds: ["b"], reservationId: "dev-b" }, adapter);
});

test("planner receipt precedes atomic DAG freeze and dispatch", async () => {
  const { adapter, read } = fixture(false, true);
  const request = { kind: "reserve", role: "owner", itemIds: ["a"], reservationId: "a1" } as const;
  expect(() => executeWorkflow(request, adapter)).toThrow(WorkflowError);
  await dispatchWorkflow({ request: { kind: "plan", role: "owner", reservationId: "planner" }, adapter, effect: async (reservationId) => ({ reservationId, status: "accepted" }) });
  const graph = { kind: "freeze", role: "owner", reservationId: "planner", dependencies: { a: [] as string[], b: ["a"] }, targets: { a: ["src/a"], b: ["src/b"] } } as const;
  expect(() => executeWorkflow(graph, adapter)).toThrow(WorkflowError);
  executeWorkflow({ kind: "plan-settle", role: "owner", reservationId: "planner", outcome: "completed" }, adapter);
  expect(() => executeWorkflow({ ...graph, dependencies: { a: ["b"], b: ["a"] } }, adapter)).toThrow(WorkflowError);
  expect(read().graphFrozen).toBe(false);
  executeWorkflow(graph, adapter);
  executeWorkflow(request, adapter);
});
