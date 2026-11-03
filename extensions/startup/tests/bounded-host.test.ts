import { describe, expect, test } from "bun:test";
import { BoundedWorkflowHost } from "../src/workflow-host";

describe("bounded workflow host", () => {
  test("freezes work and rejects duplicate active or completed dispatch", () => {
    const host = new BoundedWorkflowHost("factory", ["one", "two"], 3, {});
    expect(() => host.reserve(host.rootId, "other")).toThrow();
    const reservation = host.reserve(host.rootId, "one");
    expect(() => host.reserve(host.rootId, "one")).toThrow();
    host.settle(host.rootId, reservation, "completed");
    expect(() => host.reserve(host.rootId, "one")).toThrow();
  });
  test("uncertain dispatch cannot be repeated", () => {
    const host = new BoundedWorkflowHost("pipeline", ["one"], 2);
    const reservation = host.reserve(host.rootId, "one");
    host.settle(host.rootId, reservation, "uncertain");
    expect(() => host.reserve(host.rootId, "one")).toThrow();
    expect(() => host.settle(host.rootId, reservation, "completed")).toThrow();
  });
  test("nested scopes inherit restrictions and share reservations", () => {
    const host = new BoundedWorkflowHost("factory", ["one", "two"], 3, {});
    expect(() => host.nest(host.rootId, "pipeline", ["one"], 3)).toThrow();
    expect(() => host.nest(host.rootId, "pipeline", ["outside"], 2)).toThrow();
    const child = host.nest(host.rootId, "pipeline", ["one"], 2);
    host.reserve(child, "one");
    expect(() => host.reserve(host.rootId, "one")).toThrow();
    expect(() => host.reserve(child, "two")).toThrow();
  });
  test("distinct assignments may run in parallel without duplicating an uncertain key", () => {
    const host = new BoundedWorkflowHost("pipeline", ["one"], 2);
    const dev = host.reserve(host.rootId, "one", "dev");
    const qa = host.reserve(host.rootId, "one", "qa");
    host.settle(host.rootId, dev, "completed");
    host.settle(host.rootId, qa, "uncertain");
    expect(() => host.reserve(host.rootId, "one", "dev")).toThrow();
    expect(() => host.reserve(host.rootId, "one", "qa")).toThrow();
    expect(host.view(host.rootId).completedItemIds).toEqual([]);
  });
  test("a lost native effect becomes uncertain and cannot be sent twice", async () => {
    const host = new BoundedWorkflowHost("pipeline", ["one"], 2);
    let calls = 0;
    await expect(host.dispatch(host.rootId, "one", "dev", async () => { calls += 1; throw new Error("lost receipt"); })).rejects.toThrow("lost receipt");
    await expect(host.dispatch(host.rootId, "one", "dev", async (reservationId) => ({ reservationId, status: "accepted" }))).rejects.toThrow();
    expect(calls).toBe(1);
    expect(host.view(host.rootId).reservations[0]?.state).toBe("uncertain");
  });
  test("review batches share inherited budgets and reject partial receipts", () => {
    const host = new BoundedWorkflowHost("factory", ["one", "two"], 3, {});
    const child = host.nest(host.rootId, "pipeline", ["one"], 2);
    const changes = [{ changeId: "one", head: "a" }, { changeId: "two", head: "a" }];
    const review = host.reserveReview(host.rootId, changes);
    expect(() => host.settleReview(host.rootId, review, changes.slice(0, 1), "approve")).toThrow();
    expect(() => host.settleReview(child, review, changes, "approve")).toThrow();
    host.settleReview(host.rootId, review, changes, "changes-requested");
    const second = host.reserveReview(child, [{ changeId: "one", head: "b" }]);
    host.settleReview(child, second, [{ changeId: "one", head: "b" }], "changes-requested");
    expect(() => host.reserveReview(host.rootId, [{ changeId: "one", head: "c" }])).toThrow();
  });
  test("completion requires correlated independent role and approved review receipts", () => {
    const host = new BoundedWorkflowHost("pipeline", ["one"], 2);
    const dev = host.reserve(host.rootId, "one", "dev");
    const arch = host.reserve(host.rootId, "one", "architect");
    const qa = host.reserve(host.rootId, "one", "qa");
    for (const id of [dev, arch, qa]) host.settle(host.rootId, id, "completed");
    host.recordRole(host.rootId, { itemId: "one", role: "dev", agentId: "dev", head: "abc", reservationId: dev, evidence: { implementation: "done", artifact: "commit" } });
    host.recordRole(host.rootId, { itemId: "one", role: "architect", agentId: "arch", head: "old", reservationId: arch, evidence: { findings: "reviewed", decision: "approved" } });
    expect(() => host.complete(host.rootId, "one", "abc")).toThrow();
    host.recordRole(host.rootId, { itemId: "one", role: "qa", agentId: "qa", head: "abc", reservationId: qa, evidence: { method: "test", result: "pass", artifact: "log" } });
    const review = host.reserveReview(host.rootId, [{ changeId: "one", head: "abc" }]);
    host.recordReviewActor(host.rootId, review, "reviewer");
    host.settleReview(host.rootId, review, [{ changeId: "one", head: "abc" }], "approve");
    host.complete(host.rootId, "one", "abc");
    expect(host.view(host.rootId).completedItemIds).toContain("one");
  });
  test("frozen dependency graph unblocks on verified prerequisite readiness before final review", () => {
    expect(() => new BoundedWorkflowHost("factory", ["a", "b"], 3, { a: ["b"], b: ["a"] })).toThrow();
    expect(() => new BoundedWorkflowHost("factory", ["a"], 3, { a: ["missing"] })).toThrow();
    const host = new BoundedWorkflowHost("factory", ["a", "b"], 3, { b: ["a"] });
    const nested = host.nest(host.rootId, "pipeline", ["b"], 2);
    expect(() => host.reserve(nested, "b", "dev")).toThrow();
    const dev = host.reserve(host.rootId, "a", "dev");
    const arch = host.reserve(host.rootId, "a", "architect");
    const qa = host.reserve(host.rootId, "a", "qa");
    for (const id of [dev, arch, qa]) host.settle(host.rootId, id, "completed");
    host.recordRole(host.rootId, { itemId: "a", role: "dev", agentId: "dev", head: "h", reservationId: dev, evidence: { implementation: "done", artifact: "commit" } });
    host.recordRole(host.rootId, { itemId: "a", role: "architect", agentId: "arch", head: "h", reservationId: arch, evidence: { findings: "reviewed", decision: "approved" } });
    host.recordRole(host.rootId, { itemId: "a", role: "qa", agentId: "qa", head: "h", reservationId: qa, evidence: { method: "test", result: "pass", artifact: "log" } });
    host.ready(host.rootId, "a", "h");
    expect(() => host.ready(host.rootId, "a", "new-head")).toThrow();
    const updatedDev = host.reserve(host.rootId, "a", "updated-dev");
    const updatedQa = host.reserve(host.rootId, "a", "updated-qa");
    host.settle(host.rootId, updatedDev, "completed");
    host.settle(host.rootId, updatedQa, "completed");
    host.recordRole(host.rootId, { itemId: "a", role: "dev", agentId: "dev", head: "new-head", reservationId: updatedDev, evidence: { implementation: "fixed", artifact: "commit" } });
    host.recordRole(host.rootId, { itemId: "a", role: "qa", agentId: "qa", head: "new-head", reservationId: updatedQa, evidence: { method: "test", result: "pass", artifact: "log" } });
    host.ready(host.rootId, "a", "new-head");
    expect(host.view(host.rootId).completedItemIds).not.toContain("a");
    expect(host.reserve(nested, "b", "dev")).toBeTruthy();
  });
  test("factory freezes only a correlated complete valid planner result", async () => {
    const host = new BoundedWorkflowHost("factory", ["a", "b"], 3);
    expect(() => host.reserve(host.rootId, "a")).toThrow();
    const receipt = await host.plan(host.rootId, async (reservationId) => ({ reservationId, status: "accepted" }));
    expect(() => host.completePlan(host.rootId, receipt.reservationId, { dependencies: { a: ["b"], b: ["a"] }, targets: { a: ["main"], b: ["main"] } })).toThrow();
    expect(host.view(host.rootId).planner?.state).toBe("active");
    host.completePlan(host.rootId, receipt.reservationId, { dependencies: { a: [], b: ["a"] }, targets: { a: ["main"], b: ["feature/a"] } });
    expect(host.view(host.rootId).graphFrozen).toBe(true);
    expect(() => host.reserve(host.rootId, "b", "dev")).toThrow();
    expect(host.reserve(host.rootId, "a", "dev")).toBeTruthy();
    expect(() => host.freeze(host.rootId, receipt.reservationId, { a: [], b: [] }, { a: ["main"], b: ["main"] })).toThrow();
  });
  test("hotfix needs a developer and independent review but not a full crew", () => {
    const host = new BoundedWorkflowHost("hotfix", ["one"], 1);
    const dev = host.reserve(host.rootId, "one", "dev");
    host.settle(host.rootId, dev, "completed");
    host.recordRole(host.rootId, { itemId: "one", role: "dev", agentId: "dev", head: "h", reservationId: dev, evidence: { implementation: "done", artifact: "commit" } });
    const review = host.reserveReview(host.rootId, [{ changeId: "one", head: "h" }]);
    host.recordReviewActor(host.rootId, review, "dev");
    host.settleReview(host.rootId, review, [{ changeId: "one", head: "h" }], "approve");
    expect(() => host.complete(host.rootId, "one", "h")).toThrow();
  });
  test("single-task scopes and caps are enforced at creation", () => {
    expect(() => new BoundedWorkflowHost("pipeline", ["one", "two"], 2)).toThrow();
    expect(() => new BoundedWorkflowHost("hotfix", ["one"], 2)).toThrow();
    expect(() => new BoundedWorkflowHost("factory", ["same", "same"], 3)).toThrow();
  });
});
