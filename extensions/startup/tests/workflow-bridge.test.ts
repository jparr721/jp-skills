import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { BoundedWorkflowHost } from "../src/workflow-host";
import { connectWorkflowBridge, readRunManifest, startWorkflowBridge, type WorkflowReceiptVerifier } from "../src/workflow-bridge";
import { observeWorkflowBinding } from "../src/workflow-bridge-native";
const handoffItem = { itemId: "A", worktree: "/repo", head: "a".repeat(40), prNumber: 123 };
const handoff = { items: [handoffItem] };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(verifyTerminal: WorkflowReceiptVerifier = async () => null) {
  const host = new BoundedWorkflowHost("factory", ["A", "B"], 2, {});
  const bridge = await startWorkflowBridge(host, { verifyTerminal });
  cleanup.push(bridge.close);
  const connect = async (token: string) => {
    const client = await connectWorkflowBridge({ socket: bridge.socket, token });
    cleanup.push(client.close);
    return client;
  };
  return { host, bridge, connect };
}

test("private bridge authenticates and scopes operations to owner-provisioned capabilities", async () => {
  const { host, bridge, connect } = await fixture();
  expect(statSync(dirname(bridge.socket)).mode & 0o777).toBe(0o700);
  expect(statSync(bridge.socket).mode & 0o777).toBe(0o600);
  const invalid = await connect("forged");
  await expect(invalid.view()).rejects.toThrow("Unauthorized");
  const owner = await connect(bridge.ownerToken);
  await expect(owner.reserve()).rejects.toThrow("Unauthorized");
  const child = await owner.nest("pipeline", ["A"], 2);
  const controller = await connect(child.token);
  await expect(controller.nest("hotfix", ["B"], 1)).rejects.toThrow();
  expect(() => bridge.assign({ scopeId: child.scopeId, itemId: "B", assignmentKey: "dev", launchId: "outside" })).toThrow();
  const token = bridge.assign({ scopeId: child.scopeId, itemId: "A", assignmentKey: "dev", launchId: "job-A" });
  expect(() => bridge.assign({ scopeId: child.scopeId, itemId: "A", assignmentKey: "dev", launchId: "job-A" })).toThrow();
  const assignment = await connect(token);
  await expect(assignment.view()).rejects.toThrow("Unauthorized");
  await expect(assignment.nest("hotfix", ["A"], 1)).rejects.toThrow("Unauthorized");
  const reservation = await assignment.reserve();
  expect(host.view(child.scopeId).reservations).toContainEqual(expect.objectContaining({ id: reservation, itemIds: ["A"], state: "active" }));
  await expect(assignment.reserve()).rejects.toThrow();
  const stolen = await connect(token);
  await expect(stolen.submit({ status: "completed" })).rejects.toThrow("Unauthorized");
  await expect(assignment.submit({ status: "completed", launchId: "job-A" })).resolves.toBe("uncertain");
  expect(host.view(child.scopeId).reservations).toContainEqual(expect.objectContaining({ id: reservation, state: "uncertain" }));
});

test("only the root verifier can establish a receipt correlated to its assignment", async () => {
  const seen: unknown[] = [];
  const { host, bridge, connect } = await fixture(async (input) => {
    seen.push(input);
    return input.launchId === "trusted-native-job" && input.evidence === "trigger-observation" ? "completed" : null;
  });
  const owner = await connect(bridge.ownerToken);
  const child = await owner.nest("pipeline", ["A"], 2);
  const assignment = await connect(bridge.assign({ scopeId: child.scopeId, itemId: "A", assignmentKey: "dev", launchId: "trusted-native-job" }));
  const reservationId = await assignment.reserve();
  await expect(assignment.submit("trigger-observation")).resolves.toBe("completed");
  expect(seen).toEqual([{ scopeId: child.scopeId, itemId: "A", assignmentKey: "dev", reservationId, launchId: "trusted-native-job", evidence: "trigger-observation" }]);
  await expect(assignment.submit("trigger-observation")).rejects.toThrow();
  expect(host.view(child.scopeId).reservations).toContainEqual(expect.objectContaining({ id: reservationId, state: "completed" }));
});

test("concurrent requests cannot duplicate one assignment or reserve work outside the frozen queue", async () => {
  const { host, bridge, connect } = await fixture();
  const owner = await connect(bridge.ownerToken);
  const [a, b] = await Promise.all([owner.nest("pipeline", ["A"], 2), owner.nest("pipeline", ["B"], 2)]);
  const ca = await connect(bridge.assign({ scopeId: a.scopeId, itemId: "A", assignmentKey: "dev-A", launchId: "launch-A" }));
  const cb = await connect(bridge.assign({ scopeId: b.scopeId, itemId: "B", assignmentKey: "dev-B", launchId: "launch-B" }));
  const [first, duplicate, other] = await Promise.allSettled([ca.reserve(), ca.reserve(), cb.reserve()]);
  expect(first.status).toBe("fulfilled");
  expect(duplicate.status).toBe("rejected");
  expect(other.status).toBe("fulfilled");
  expect(host.view(host.rootId).reservations).toHaveLength(2);
});

test("shutdown with in-flight verification leaves the assignment uncertain and removes the socket", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<"completed">();
  const verified = Promise.withResolvers<void>();
  const { host, bridge, connect } = await fixture(async () => {
    entered.resolve();
    const verdict = await release.promise;
    verified.resolve();
    return verdict;
  });
  const assignment = await connect(bridge.assign({ scopeId: host.rootId, itemId: "A", assignmentKey: "dev", launchId: "job" }));
  const reservation = await assignment.reserve();
  const result = assignment.submit({ claimed: "completed" }).then(
    () => "fulfilled",
    () => "rejected",
  );
  await entered.promise;
  try {
    await bridge.close();
    expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ id: reservation, state: "uncertain" }));
  } finally {
    release.resolve("completed");
  }
  expect(await result).toBe("rejected");
  await verified.promise;
  await Promise.resolve();
  expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ id: reservation, state: "uncertain" }));
  expect(existsSync(bridge.socket)).toBe(false);
  expect(existsSync(dirname(bridge.socket))).toBe(false);
  await expect(connectWorkflowBridge({ socket: bridge.socket, token: bridge.ownerToken })).rejects.toThrow();
});

test("verifier failures never convert caller claims into terminal receipts", async () => {
  const { host, bridge, connect } = await fixture(async () => { throw new Error("backend offline"); });
  const client = await connect(bridge.assign({ scopeId: host.rootId, itemId: "A", assignmentKey: "dev", launchId: "offline-job" }));
  const reservation = await client.reserve();
  await expect(client.submit({ status: "completed" })).resolves.toBe("uncertain");
  expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ id: reservation, state: "uncertain" }));
  const replacement = await connect(bridge.assign({ scopeId: host.rootId, itemId: "A", assignmentKey: "dev", launchId: "replacement" }));
  await expect(replacement.reserve()).rejects.toThrow();
});

test("disconnect leaves a reserved assignment uncertain", async () => {
  const { host, bridge, connect } = await fixture();
  const client = await connect(bridge.assign({ scopeId: host.rootId, itemId: "A", assignmentKey: "dev", launchId: "disconnect-job" }));
  const reservation = await client.reserve();
  await client.close();
  await bridge.close();
  expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ id: reservation, state: "uncertain" }));
});

test("run tokens attach only to an owner-pinned backend and correlate multiple receipts", async () => {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  let owns = true;
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => owns } };
  const bridge = await startWorkflowBridge(host, { acceptBoundHostReceipts: true });
  cleanup.push(bridge.close);
  const token = bridge.issueRun({ scopeId: host.rootId, binding });
  const client = await connectWorkflowBridge({ socket: bridge.socket, token });
  cleanup.push(client.close);
  const [dev, qa] = await Promise.all([client.reserveAssignment({ itemId: "A", assignmentKey: "dev" }), client.reserveAssignment({ itemId: "A", assignmentKey: "qa" })]);
  const base = { scopeId: host.rootId, itemId: "A", nativeJobId: "native-task", status: "completed" };
  expect(await client.submitAssignment({ reservationId: dev.reservationId, evidence: { ...base, assignmentKey: "dev", ...dev } })).toBe("completed");
  expect(await client.submitAssignment({ reservationId: qa.reservationId, evidence: { ...base, assignmentKey: "qa", ...qa, launchId: dev.launchId } })).toBe("uncertain");
  const attacker = await connectWorkflowBridge({ socket: bridge.socket, token });
  cleanup.push(attacker.close);
  await expect(attacker.view()).rejects.toThrow("Unauthorized");
  owns = false;
  const another = bridge.issueRun({ scopeId: host.rootId, binding });
  const unbound = await connectWorkflowBridge({ socket: bridge.socket, token: another });
  cleanup.push(unbound.close);
  await expect(unbound.view()).rejects.toThrow();
});

test("Herdr binding requires one exact owner-pinned session and pane", async () => {
  const observation = { workspaceId: "w", tabId: "t", paneId: "p", terminalId: "term", nativeSession: "session", harness: "omp" as const, name: "worker", state: "done" as const, stateSequence: 1, interactiveReady: true };
  let rows = [observation];
  const binding = { kind: "herdr" as const, runtime: { observe: async () => rows }, workspaceId: "w", tabId: "t", paneId: "p", terminalId: "term", nativeSession: "session", harness: "omp" as const };
  expect(await observeWorkflowBinding(binding)).toBe(true);
  rows = [observation, observation];
  expect(await observeWorkflowBinding(binding)).toBe(false);
  rows = [{ ...observation, nativeSession: "foreign" }];
  expect(await observeWorkflowBinding(binding)).toBe(false);
});

test("run manifest is private, scoped and single-use", async () => {
  const { host, bridge } = await fixture();
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const prepared = bridge.prepareRunManifest({ scopeId: host.rootId });
  const path = prepared.path;
  expect(existsSync(path)).toBe(false);
  expect(() => readRunManifest(path)).toThrow();
  prepared.publish(binding);
  expect(() => prepared.publish(binding)).toThrow();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const manifest = readRunManifest(path);
  expect(manifest).toMatchObject({ socket: bridge.socket, scopeId: host.rootId });
  expect(existsSync(path)).toBe(false);
  expect(() => readRunManifest(path)).toThrow();
  const client = await connectWorkflowBridge(manifest);
  cleanup.push(client.close);
  expect(await client.view()).toMatchObject({ workflow: "factory" });
});

test("transport delegates to a structural authority and propagates revoked authority", async () => {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  let active = true;
  const authority = {
    rootId: host.rootId,
    view: (scopeId: string) => { if (!active) throw new Error("Claim revoked"); return host.view(scopeId); },
    nest: host.nest.bind(host),
    reserve: host.reserve.bind(host),
    settle: host.settle.bind(host),
  };
  const bridge = await startWorkflowBridge(authority, { verifyTerminal: async () => null });
  cleanup.push(bridge.close);
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.ownerToken });
  cleanup.push(client.close);
  expect(await client.view()).toMatchObject({ workflow: "pipeline" });
  active = false;
  await expect(client.view()).rejects.toThrow("Claim revoked");
});

test("role proof is bound to the reservation and independently validated before atomic completion", async () => {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const observed: string[] = [];
  const bridge = await startWorkflowBridge(host, {
    acceptBoundHostReceipts: true,
    validateRoleAssignment: async ({ role }) => role.worktree === "/repo",
    validateRole: async ({ proof, nativeJobId }) => { observed.push(nativeJobId); return proof.evidence.implementation === "implemented"; },
  });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(client.close);
  await expect(client.reserveAssignment({ itemId: "A", assignmentKey: "invalid", role: { kind: "dev", worktree: "/outside" } })).rejects.toThrow("not authorized");
  const dev = await client.reserveAssignment({ itemId: "A", assignmentKey: "dev", role: { kind: "dev", worktree: "/repo" } });
  const proof = { role: "dev", itemId: "A", verdict: "pass", worktree: "/repo", agentId: "native-agent", head: "a".repeat(40), evidence: { implementation: "implemented", artifact: "commit" } };
  const evidence = { scopeId: host.rootId, itemId: "A", assignmentKey: "dev", ...dev, nativeJobId: "native-job", status: "completed", roleProof: proof };
  expect(await client.submitAssignment({ reservationId: dev.reservationId, evidence })).toBe("completed");
  expect(observed).toEqual(["native-job"]);
  const qa = await client.reserveAssignment({ itemId: "A", assignmentKey: "qa", role: { kind: "qa", worktree: "/repo" } });
  expect(await client.submitAssignment({ reservationId: qa.reservationId, evidence: { ...evidence, assignmentKey: "qa", ...qa } })).toBe("uncertain");
  expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ id: qa.reservationId, state: "uncertain" }));
});

test("role proof never downgrades to ordinary completion without authority support", async () => {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const authority = { rootId: host.rootId, view: host.view.bind(host), nest: host.nest.bind(host), reserve: host.reserve.bind(host), settle: host.settle.bind(host) };
  const bridge = await startWorkflowBridge(authority, { acceptBoundHostReceipts: true, validateRoleAssignment: async () => true, validateRole: async () => true });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(client.close);
  const reservation = await client.reserveAssignment({ itemId: "A", assignmentKey: "dev", role: { kind: "dev", worktree: "/repo" } });
  const evidence = { scopeId: host.rootId, itemId: "A", assignmentKey: "dev", ...reservation, nativeJobId: "job", status: "completed", roleProof: { role: "dev", itemId: "A", verdict: "pass", worktree: "/repo", agentId: "a", head: "a".repeat(40), evidence: { implementation: "x" } } };
  expect(await client.submitAssignment({ reservationId: reservation.reservationId, evidence })).toBe("uncertain");
});

test("verified invalid role evidence settles the original assignment without granting readiness", async () => {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const bridge = await startWorkflowBridge(host, { acceptBoundHostReceipts: true, validateRoleAssignment: async () => true, validateReady: async () => true });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(client.close);
  const role = { kind: "architect" as const, worktree: "/repo" };
  const reservation = await client.reserveAssignment({ itemId: "A", assignmentKey: "architect", role });
  const evidence = { scopeId: host.rootId, itemId: "A", assignmentKey: "architect", ...reservation, nativeJobId: "job", status: "completed", roleEvidence: "invalid" };
  expect(await client.submitAssignment({ reservationId: reservation.reservationId, evidence })).toBe("completed_without_role");
  expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ id: reservation.reservationId, state: "completed" }));
  await expect(client.submitAssignment({ reservationId: reservation.reservationId, evidence })).rejects.toThrow();
  await expect(client.reserveAssignment({ itemId: "A", assignmentKey: "architect", role })).rejects.toThrow();
  await expect(client.readyItem(handoffItem)).rejects.toThrow();
});

test("invalid evidence markers never bypass correlation, role identity, verification or authority", async () => {
  const cases = ["extra", "marker", "proof", "failed", "non-role", "scope", "item", "key", "reservation", "launch", "job", "verifier", "verifier-failed", "verifier-throws", "authority", "authority-claim", "authority-throws", "binding"] as const;
  for (const scenario of cases) {
    const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
    const authority = {
      rootId: host.rootId, view: host.view.bind(host), nest: host.nest.bind(host), reserve: host.reserve.bind(host), settle: host.settle.bind(host),
      ...(scenario === "authority" ? {} : { settleRoleWithoutProof: (scopeId: string, reservationId: string, role: { itemId: string; role: "architect" | "dev" | "qa" }) => {
        if (scenario === "authority-claim") return host.settleRoleWithoutProof(scopeId, reservationId, { ...role, role: "qa" });
        if (scenario === "authority-throws") throw new Error("Authority unavailable");
        host.settleRoleWithoutProof(scopeId, reservationId, role);
      } }),
    };
    let bindingChecks = 0;
    const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => ++bindingChecks < (scenario === "binding" ? 2 : Infinity) } };
    const bridge = await startWorkflowBridge(authority, { verifyTerminal: async () => {
      if (scenario === "verifier-throws") throw new Error("Verifier unavailable");
      return scenario === "verifier" ? null : scenario === "verifier-failed" ? "failed" : "completed";
    }, validateRoleAssignment: async () => true });
    cleanup.push(bridge.close);
    const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
    cleanup.push(client.close);
    const reservation = await client.reserveAssignment({ itemId: "A", assignmentKey: "architect", ...(scenario === "non-role" ? {} : { role: { kind: "architect", worktree: "/repo" } }) });
    const evidence = {
      scopeId: scenario === "scope" ? "wrong" : host.rootId,
      itemId: scenario === "item" ? "B" : "A",
      assignmentKey: scenario === "key" ? "wrong" : "architect",
      ...reservation,
      ...(scenario === "reservation" ? { reservationId: randomUUID() } : {}),
      ...(scenario === "launch" ? { launchId: randomUUID() } : {}),
      nativeJobId: scenario === "job" ? "" : "job",
      status: scenario === "failed" ? "failed" : "completed",
      roleEvidence: scenario === "marker" ? "valid" : "invalid",
      ...(scenario === "proof" ? { roleProof: { role: "architect", itemId: "A", verdict: "pass", worktree: "/repo", agentId: "a", head: "a".repeat(40), evidence: { artifact: "x" } } } : {}),
      ...(scenario === "extra" ? { unexpected: true } : {}),
    };
    expect(await client.submitAssignment({ reservationId: reservation.reservationId, evidence })).toBe("uncertain");
    expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ id: reservation.reservationId, state: "uncertain" }));
  }
});

test("disconnect during invalid role evidence verification cannot complete the assignment", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<"completed">();
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const bridge = await startWorkflowBridge(host, { verifyTerminal: async () => { entered.resolve(); return release.promise; }, validateRoleAssignment: async () => true });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(client.close);
  const reservation = await client.reserveAssignment({ itemId: "A", assignmentKey: "architect", role: { kind: "architect", worktree: "/repo" } });
  const submission = client.submitAssignment({ reservationId: reservation.reservationId, evidence: { scopeId: host.rootId, itemId: "A", assignmentKey: "architect", ...reservation, nativeJobId: "job", status: "completed", roleEvidence: "invalid" } });
  const result = submission.then(() => "fulfilled", () => "rejected");
  await entered.promise;
  await bridge.close();
  release.resolve("completed");
  expect(await result).toBe("rejected");
  expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ id: reservation.reservationId, state: "uncertain" }));
});

test("a lost completion response leaves the missing role evidence visible to the owner", async () => {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  let disconnect: () => void = () => {};
  const authority = {
    rootId: host.rootId, view: host.view.bind(host), nest: host.nest.bind(host), reserve: host.reserve.bind(host), settle: host.settle.bind(host),
    settleRoleWithoutProof: (scopeId: string, reservationId: string, role: { itemId: string; role: "architect" | "dev" | "qa" }) => {
      host.settleRoleWithoutProof(scopeId, reservationId, role);
      disconnect();
    },
  };
  const bridge = await startWorkflowBridge(authority, { acceptBoundHostReceipts: true, validateRoleAssignment: async () => true });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(client.close);
  const reservation = await client.reserveAssignment({ itemId: "A", assignmentKey: "architect", role: { kind: "architect", worktree: "/repo" } });
  disconnect = () => { void client.close(); };
  await expect(client.submitAssignment({ reservationId: reservation.reservationId, evidence: {
    scopeId: host.rootId, itemId: "A", assignmentKey: "architect", ...reservation,
    nativeJobId: "job", status: "completed", roleEvidence: "invalid",
  } })).rejects.toThrow();
  const owner = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.ownerToken });
  cleanup.push(owner.close);
  expect(await owner.view()).toMatchObject({ reservations: [expect.objectContaining({
    id: reservation.reservationId, state: "completed", role: { kind: "architect", worktree: "/repo" }, roleEvidence: "invalid",
  })] });
});

test("nested target is enforced by the owner policy, never silently ignored", async () => {
  const host = new BoundedWorkflowHost("factory", ["A"], 2, {});
  const bridge = await startWorkflowBridge(host, {
    verifyTerminal: async () => null,
    nestScope: (parent, workflow, items, limit, target) => {
      if (target !== "approved") throw new Error("Nested target is not allowed");
      return host.nest(parent, workflow, items, limit);
    },
  });
  cleanup.push(bridge.close);
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.ownerToken });
  cleanup.push(client.close);
  await expect(client.nest("pipeline", ["A"], 2, "foreign")).rejects.toThrow("not allowed");
  expect((await client.nest("pipeline", ["A"], 2, "approved")).scopeId).toBeTruthy();

  const other = await startWorkflowBridge(new BoundedWorkflowHost("factory", ["B"], 2, {}), { verifyTerminal: async () => null });
  cleanup.push(other.close);
  const withoutPolicy = await connectWorkflowBridge({ socket: other.socket, token: other.ownerToken });
  cleanup.push(withoutPolicy.close);
  await expect(withoutPolicy.nest("pipeline", ["B"], 2, "approved")).rejects.toThrow("not authorized");
});

test("root handoff requires terminal assignments and revokes every descendant capability", async () => {
  const host = new BoundedWorkflowHost("factory", ["A"], 2, {});
  const finished: Array<{ scopeId: string; handoff: typeof handoff }> = [];
  const authority = { rootId: host.rootId, view: host.view.bind(host), nest: host.nest.bind(host), reserve: host.reserve.bind(host), settle: host.settle.bind(host), finishRun: (scopeId: string, evidence: typeof handoff) => { finished.push({ scopeId, handoff: evidence }); } };
  const bridge = await startWorkflowBridge(authority, { acceptBoundHostReceipts: true, validateFinish: async () => true });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const token = bridge.issueRun({ scopeId: host.rootId, binding });
  const root = await connectWorkflowBridge({ socket: bridge.socket, token });
  cleanup.push(root.close);
  await expect(root.finishRun(handoff)).rejects.toThrow("no child assignments");
  const nested = await root.nest("pipeline", ["A"], 2);
  const task = await root.reserveAssignment({ itemId: "A", assignmentKey: "dev" });
  await expect(root.finishRun(handoff)).rejects.toThrow("active or uncertain");
  const evidence = { scopeId: host.rootId, itemId: "A", assignmentKey: "dev", ...task, nativeJobId: "native-job", status: "completed" };
  expect(await root.submitAssignment({ reservationId: task.reservationId, evidence })).toBe("completed");
  await root.finishRun(handoff);
  expect(finished).toEqual([{ scopeId: host.rootId, handoff }]);
  await expect(root.view()).rejects.toThrow("Unauthorized");
  const descendant = await connectWorkflowBridge({ socket: bridge.socket, token: nested.token });
  cleanup.push(descendant.close);
  await expect(descendant.view()).rejects.toThrow("Unauthorized");
});

test("failed canonical handoff revokes the run rather than permitting duplicate effects", async () => {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const authority = { rootId: host.rootId, view: host.view.bind(host), nest: host.nest.bind(host), reserve: host.reserve.bind(host), settle: host.settle.bind(host), finishRun: () => { throw new Error("Claim changed"); } };
  const bridge = await startWorkflowBridge(authority, { acceptBoundHostReceipts: true, validateFinish: async () => true });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(client.close);
  const task = await client.reserveAssignment({ itemId: "A", assignmentKey: "dev" });
  await client.submitAssignment({ reservationId: task.reservationId, evidence: { scopeId: host.rootId, itemId: "A", assignmentKey: "dev", ...task, nativeJobId: "native-job", status: "completed" } });
  await expect(client.finishRun(handoff)).rejects.toThrow("Claim changed");
  await expect(client.reserveAssignment({ itemId: "A", assignmentKey: "next" })).rejects.toThrow("Unauthorized");
});

test("handoff rejects while a descendant host connection is still active", async () => {
  const host = new BoundedWorkflowHost("factory", ["A"], 2, {});
  const authority = { rootId: host.rootId, view: host.view.bind(host), nest: host.nest.bind(host), reserve: host.reserve.bind(host), settle: host.settle.bind(host), finishRun: () => { throw new Error("must not be called"); } };
  const bridge = await startWorkflowBridge(authority, { acceptBoundHostReceipts: true, validateFinish: async () => true });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const root = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(root.close);
  const nested = await root.nest("pipeline", ["A"], 2);
  const child = await connectWorkflowBridge({ socket: bridge.socket, token: nested.token });
  cleanup.push(child.close);
  await child.view();
  const task = await root.reserveAssignment({ itemId: "A", assignmentKey: "dev" });
  await root.submitAssignment({ reservationId: task.reservationId, evidence: { scopeId: host.rootId, itemId: "A", assignmentKey: "dev", ...task, nativeJobId: "job", status: "completed" } });
  await expect(root.finishRun(handoff)).rejects.toThrow("active connections");
});

test("bound-host mode does not accept unbound individual assignment claims", async () => {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const bridge = await startWorkflowBridge(host, { acceptBoundHostReceipts: true });
  cleanup.push(bridge.close);
  const token = bridge.assign({ scopeId: host.rootId, itemId: "A", assignmentKey: "dev", launchId: "launch" });
  const client = await connectWorkflowBridge({ socket: bridge.socket, token });
  cleanup.push(client.close);
  const reservation = await client.reserve();
  await expect(client.submit({ status: "completed" })).resolves.toBe("uncertain");
  expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ id: reservation, state: "uncertain" }));
});

test("planner RPC reserves before accepting a correlated, owner-validated frozen graph", async () => {
  const host = new BoundedWorkflowHost("factory", ["A", "B"], 2);
  let frozen = false;
  const outcomes: string[] = [];
  const authority = {
    rootId: host.rootId,
    view: (scopeId: string) => ({ ...host.view(scopeId), graphFrozen: frozen }),
    nest: host.nest.bind(host),
    reserve: host.reserve.bind(host),
    settle: host.settle.bind(host),
    reservePlan: () => randomUUID(),
    settlePlan: (_scope: string, _id: string, outcome: "failed" | "uncertain") => { outcomes.push(outcome); },
    completePlan: (_scope: string, _id: string, plan: { dependencies: Record<string, string[]>; targets: Record<string, string[]> }) => { frozen = true; outcomes.push(plan.targets.A?.[0] ?? "missing"); },
  };
  const bridge = await startWorkflowBridge(authority, { acceptBoundHostReceipts: true, validatePlan: async ({ plan }) => plan.targets.A?.[0] === "main" });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(client.close);
  await expect(client.reserveAssignment({ itemId: "A", assignmentKey: "dev" })).rejects.toThrow("graph is not frozen");
  const planner = await client.reservePlan();
  const plan = { dependencies: { A: [], B: ["A"] }, targets: { A: ["main"], B: ["feature"] } };
  await expect(client.submitPlan({ reservationId: planner.reservationId, evidence: { scopeId: host.rootId, ...planner, nativeJobId: "job", nativeAgentId: "agent", status: "completed", plan } })).resolves.toBe("completed");
  expect(outcomes).toEqual(["main"]);
  expect(frozen).toBe(true);
  await expect(client.reservePlan()).rejects.toThrow("already attempted");
});

test("planner correlation mismatch is uncertain and cannot freeze or relaunch", async () => {
  const host = new BoundedWorkflowHost("factory", ["A"], 2);
  const outcomes: string[] = [];
  const authority = { rootId: host.rootId, view: host.view.bind(host), nest: host.nest.bind(host), reserve: host.reserve.bind(host), settle: host.settle.bind(host), reservePlan: () => randomUUID(), settlePlan: (_scope: string, _id: string, outcome: "failed" | "uncertain") => { outcomes.push(outcome); }, completePlan: () => { throw new Error("must not freeze"); } };
  const bridge = await startWorkflowBridge(authority, { acceptBoundHostReceipts: true, validatePlan: async () => true });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(client.close);
  const planner = await client.reservePlan();
  await expect(client.submitPlan({ reservationId: planner.reservationId, evidence: { scopeId: host.rootId, reservationId: planner.reservationId, launchId: randomUUID(), nativeJobId: "job", nativeAgentId: "agent", status: "completed", plan: { dependencies: { A: [] }, targets: { A: ["main"] } } } })).resolves.toBe("uncertain");
  expect(outcomes).toEqual(["uncertain"]);
  await expect(client.reservePlan()).rejects.toThrow("already attempted");
});

test("readiness requires independent owner verification before canonical mutation", async () => {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const ready: string[] = [];
  const authority = { rootId: host.rootId, view: host.view.bind(host), nest: host.nest.bind(host), reserve: host.reserve.bind(host), settle: host.settle.bind(host), readyItem: (_scope: string, itemId: string) => { ready.push(itemId); } };
  const bridge = await startWorkflowBridge(authority, { acceptBoundHostReceipts: true, validateReady: async (_scope, item) => item.prNumber === 123 });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const client = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(client.close);
  const item = { itemId: "A", worktree: "/repo", head: "a".repeat(40), prNumber: 123 };
  await expect(client.readyItem({ ...item, prNumber: 999 })).rejects.toThrow("not verified");
  await client.readyItem(item);
  expect(ready).toEqual(["A"]);
});

test("factory handoff must exactly cover its frozen queue and forwards distinct PRs", async () => {
  const host = new BoundedWorkflowHost("factory", ["A", "B"], 2, {});
  const received: unknown[] = [];
  const authority = { rootId: host.rootId, view: host.view.bind(host), nest: host.nest.bind(host), reserve: host.reserve.bind(host), settle: host.settle.bind(host), finishRun: (_scopeId: string, evidence: unknown) => { received.push(evidence); } };
  const bridge = await startWorkflowBridge(authority, { acceptBoundHostReceipts: true, validateFinish: async () => true });
  cleanup.push(bridge.close);
  const binding = { kind: "tern" as const, blockId: "4", pid: 123, runtime: { ownsProcess: async () => true } };
  const root = await connectWorkflowBridge({ socket: bridge.socket, token: bridge.issueRun({ scopeId: host.rootId, binding }) });
  cleanup.push(root.close);
  const task = await root.reserveAssignment({ itemId: "A", assignmentKey: "dev" });
  await root.submitAssignment({ reservationId: task.reservationId, evidence: { scopeId: host.rootId, itemId: "A", assignmentKey: "dev", ...task, nativeJobId: "job", status: "completed" } });
  await expect(root.finishRun(handoff)).rejects.toThrow("cover the frozen scope");
  const complete = { items: [...handoff.items, { itemId: "B", worktree: "/other", head: "b".repeat(40), prNumber: 456 }] };
  await root.finishRun(complete);
  expect(received).toEqual([complete]);
});
