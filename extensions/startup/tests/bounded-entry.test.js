import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import boundedEntry from "../bounded-entry";
import { startWorkflowBridge } from "../src/workflow-bridge";
import { BoundedWorkflowHost } from "../src/workflow-host";

test.each(["merged", "ready-pr"])("hotfix accepts %s landing", async (mode) => {
  const tools = new Map();
  const sessionManager = { getSessionId: () => "session" };
  const root = { id: "root", session: { sessionManager } };
  const pi = {
    zod: z,
    pi: { AgentRegistry: { global: () => ({ get: () => root }) } },
    registerTool: (tool) => { tools.set(tool.name, tool); },
    on: () => {},
  };
  boundedEntry(pi);
  const result = await tools.get("bounded_begin").execute("test", {
    workflow: "hotfix", itemIds: ["one"], reviewLimit: 1,
    landing: { mode, target: "main" },
  }, undefined, undefined, { agent: { id: "root", kind: "main" }, sessionManager, cwd: process.cwd() });
  expect(JSON.parse(result.content[0].text).landing.mode).toBe(mode);
});

test.each(["merged", "ready-pr"])("nested hotfix inherits %s and needs no human go", async (mode) => {
  const directory = mkdtempSync(join(tmpdir(), "hotfix-landing-"));
  const previousPath = process.env.PATH;
  const cwd = realpathSync(process.cwd());
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const pr = JSON.stringify({ headRefOid: head, baseRefName: "main", state: "OPEN", isDraft: false, url: "https://example.test/pr/1", mergeCommit: null });
  writeFileSync(join(directory, "gh"), `#!/bin/sh\nprintf '%s\\n' '${pr}'\n`);
  chmodSync(join(directory, "gh"), 0o755);
  process.env.PATH = `${directory}:${previousPath}`;
  try {
    if (!process.env.JP_HOTFIX_TEST_CHILD) {
      execFileSync(process.execPath, ["test", import.meta.path, "-t", `nested hotfix inherits ${mode} and needs no human go`], {
        cwd, env: { ...process.env, JP_HOTFIX_TEST_CHILD: "1" }, stdio: "pipe",
      });
      return;
    }
    const tools = new Map();
    const sessionManager = { getSessionId: () => "session" };
    const root = { id: "root", session: { sessionManager } };
    boundedEntry({ zod: z, pi: { AgentRegistry: { global: () => ({ get: () => root }) } }, registerTool: (tool) => tools.set(tool.name, tool), on: () => {} });
    const context = { agent: { id: "root", kind: "main" }, sessionManager, cwd };
    const call = async (name, args) => tools.get(name).execute("test", args, undefined, undefined, context);
    const rootResult = await call("bounded_begin", { workflow: "pipeline", itemIds: ["one"], reviewLimit: 2, landing: { mode, target: "main" } });
    const parentId = JSON.parse(rootResult.content[0].text).scopeId;
    const childResult = await call("bounded_nest", { parentId, workflow: "hotfix", itemIds: ["one"], reviewLimit: 1 });
    const scopeId = JSON.parse(childResult.content[0].text).scopeId;
    await expect(call("bounded_complete", { scopeId, itemId: "one", worktree: cwd, head, prNumber: 1 })).rejects.toThrow(
      mode === "merged" ? "PR has not been merged" : "Canonical completion gates are not satisfied",
    );
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  { label: "pipeline follows mixed async receipt", workflow: "pipeline", dispatchError: false, terminalAgent: "task", rejected: false },
  { label: "planner follows mixed async receipt", workflow: "factory", dispatchError: false, terminalAgent: "task", rejected: false },
  { label: "planner refuses error-marked mixed receipt", workflow: "factory", dispatchError: true, terminalAgent: "task", rejected: true },
  { label: "planner refuses a different terminal agent", workflow: "factory", dispatchError: false, terminalAgent: "other", rejected: true },
])("inherited $label", async ({ workflow, dispatchError, terminalAgent, rejected }) => {
  const host = new BoundedWorkflowHost(workflow, ["A"], 2);
  const bridge = await startWorkflowBridge(host, { acceptBoundHostReceipts: true, validatePlan: async () => true });
  const prepared = bridge.prepareRunManifest({ scopeId: host.rootId });
  prepared.publish({ kind: "tern", runtime: { ownsProcess: async () => true }, blockId: "1", pid: 123 });
  const jobs = [];
  const tools = new Map();
  const hooks = new Map();
  const sessionManager = { getSessionId: () => "parent-session" };
  const child = {
    id: "child", parentId: "parent",
    session: { messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ dependencies: { A: [] }, targets: { A: ["main"] } }) }] }] },
  };
  const parent = { id: "parent", session: { sessionManager, asyncJobManager: { getAllJobs: () => jobs } } };
  const registry = { get: (id) => id === "parent" ? parent : id === "child" ? child : undefined };
  const pi = {
    zod: z,
    pi: { AgentRegistry: { global: () => registry } },
    registerTool: (tool) => { tools.set(tool.name, tool); },
    on: (name, handler) => { hooks.set(name, handler); },
  };
  const previousManifest = process.env.JP_WORKFLOW_INHERITED_MANIFEST;
  process.env.JP_WORKFLOW_INHERITED_MANIFEST = prepared.path;
  try { boundedEntry(pi); }
  finally {
    if (previousManifest === undefined) delete process.env.JP_WORKFLOW_INHERITED_MANIFEST;
    else process.env.JP_WORKFLOW_INHERITED_MANIFEST = previousManifest;
  }
  const context = {
    agent: { id: "parent", kind: "main" }, sessionManager,
    invokeTool: async () => {
      jobs.push({
        id: "job", ownerId: "parent", agentId: "child", type: "task", status: "completed", promise: Promise.resolve(),
        latestDetails: { progress: [{ index: 0, id: "child", agent: terminalAgent, status: "completed" }] },
      });
      return { isError: dispatchError, details: { results: [], progress: [{ index: 0, id: "child", agent: "task", status: "running" }] } };
    },
  };
  const call = async (name, params) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing ${name} tool`);
    return await tool.execute("test", params, undefined, undefined, context);
  };
  try {
    await call("bounded_attach", {});
    const dispatch = call("task", {
      scopeId: host.rootId, itemId: "A", assignmentKey: "native", context: "test",
      tasks: [{ task: "Do the work", solutionSpace: "One task" }],
      ...(workflow === "factory" ? { planner: true } : {}),
    });
    if (rejected) {
      await expect(dispatch).rejects.toThrow();
      expect(host.view(host.rootId).planner?.state).toBe("uncertain");
      expect(host.view(host.rootId).graphFrozen).toBe(false);
    } else if (workflow === "factory") {
      await dispatch;
      expect(host.view(host.rootId).planner?.state).toBe("completed");
      expect(host.view(host.rootId).graphFrozen).toBe(true);
    } else {
      await dispatch;
      expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ assignmentKey: "native", state: "completed" }));
    }
  } finally {
    await hooks.get("session_shutdown")?.({}, context);
    await bridge.close();
  }
});

test.each([
  { label: "malformed architect evidence", payload: "original" },
  { label: "malformed JSON", payload: "json" },
  { label: "extra evidence key", payload: "extra" },
  { label: "extra top-level key", payload: "top" },
  { label: "blank evidence", payload: "blank" },
  { label: "wrong role", payload: "role" },
  { label: "wrong item", payload: "item" },
  { label: "wrong head", payload: "head" },
  { label: "malformed output with a wrong item", payload: "extraWrong" },
  { label: "missing output", payload: "missing" },
  { label: "valid architect evidence", payload: "valid" },
  { label: "mismatched terminal identity", payload: "original", correlation: "terminal" },
  { label: "mismatched child ancestry", payload: "original", correlation: "ancestry" },
  { label: "failed native job", payload: "original", correlation: "failed" },
])("$label preserves native and role boundaries", async ({ payload, correlation }) => {
  const cwd = realpathSync(process.cwd());
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const valid = { role: "architect", itemId: "A", head, verdict: "pass", evidence: { findings: "inspected", decision: "approved" } };
  const outputs = {
    original: JSON.stringify({ ...valid, evidence: { findings: ["a"], decision: "b", risks: "extra" } }),
    json: "{", extra: JSON.stringify({ ...valid, evidence: { ...valid.evidence, risks: "extra" } }),
    top: JSON.stringify({ ...valid, extra: "unexpected" }),
    blank: JSON.stringify({ ...valid, evidence: { ...valid.evidence, findings: "  " } }),
    role: JSON.stringify({ ...valid, role: "dev", evidence: { implementation: "done", artifact: "commit" } }),
    item: JSON.stringify({ ...valid, itemId: "B" }),
    head: JSON.stringify({ ...valid, head: "0".repeat(40) }),
    extraWrong: JSON.stringify({ ...valid, itemId: "B", extra: "unexpected" }),
    missing: null, valid: JSON.stringify(valid),
  };
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const bridge = await startWorkflowBridge(host, {
    acceptBoundHostReceipts: true,
    validateRoleAssignment: async () => true,
    validateRole: async () => true,
  });
  const prepared = bridge.prepareRunManifest({ scopeId: host.rootId });
  prepared.publish({ kind: "tern", runtime: { ownsProcess: async () => true }, blockId: "1", pid: 123 });
  const jobs = [];
  const tools = new Map();
  const hooks = new Map();
  const sessionManager = { getSessionId: () => "parent-session" };
  const child = {
    id: "child", parentId: correlation === "ancestry" ? "other" : "parent",
    session: { messages: outputs[payload] === null ? [] : [{ role: "assistant", content: [{ type: "text", text: outputs[payload] }] }] },
  };
  const parent = { id: "parent", session: { sessionManager, asyncJobManager: { getAllJobs: () => jobs } } };
  const registry = { get: (id) => id === "parent" ? parent : id === "child" ? child : undefined };
  const pi = {
    zod: z, pi: { AgentRegistry: { global: () => registry } },
    registerTool: (tool) => { tools.set(tool.name, tool); },
    on: (name, handler) => { hooks.set(name, handler); },
  };
  const previousManifest = process.env.JP_WORKFLOW_INHERITED_MANIFEST;
  process.env.JP_WORKFLOW_INHERITED_MANIFEST = prepared.path;
  try { boundedEntry(pi); }
  finally {
    if (previousManifest === undefined) delete process.env.JP_WORKFLOW_INHERITED_MANIFEST;
    else process.env.JP_WORKFLOW_INHERITED_MANIFEST = previousManifest;
  }
  const context = {
    agent: { id: "parent", kind: "main" }, sessionManager,
    invokeTool: async () => {
      jobs.push({
        id: "job", ownerId: "parent", agentId: "child", type: "task", status: correlation === "failed" ? "failed" : "completed", promise: Promise.resolve(),
        latestDetails: { progress: [{ index: 0, id: "child", agent: correlation === "terminal" ? "other" : "task", status: correlation === "failed" ? "failed" : "completed" }] },
      });
      return { details: { results: [], progress: [{ index: 0, id: "child", agent: "task", status: "running" }] } };
    },
  };
  const call = async (name, params) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing ${name} tool`);
    return await tool.execute("test", params, undefined, undefined, context);
  };
  const task = {
    scopeId: host.rootId, itemId: "A", assignmentKey: "architect", context: "test",
    role: { kind: "architect", worktree: cwd },
    tasks: [{ task: "Inspect the work", solutionSpace: "One task" }],
  };
  try {
    await call("bounded_attach", {});
    if (correlation === "terminal" || correlation === "ancestry" || ["role", "item", "head", "extraWrong"].includes(payload)) {
      await expect(call("task", task)).rejects.toThrow();
      expect(host.view(host.rootId).reservations).not.toContainEqual(expect.objectContaining({ assignmentKey: "architect", state: "completed" }));
      expect(jobs).toHaveLength(1);
      return;
    }
    const result = JSON.parse((await call("task", task)).content[0].text);
    const expected = correlation === "failed" ? "failed" : payload === "valid" ? "completed" : "completed_without_role";
    expect(result.parentOutcome).toBe(expected);
    expect(host.view(host.rootId).reservations).toContainEqual(expect.objectContaining({ assignmentKey: "architect", state: correlation === "failed" ? "failed" : "completed" }));
    if (expected === "completed_without_role") {
      expect(result.native.roleEvidence).toBe("invalid");
      expect(result.native.roleProof).toBeUndefined();
      expect(result.warning).toMatch(/do not replay/i);
    } else if (expected === "completed") {
      expect(result.native.roleProof.evidence).toEqual(valid.evidence);
      expect(result.native.roleEvidence).toBeUndefined();
    } else {
      expect(result.native.roleEvidence).toBeUndefined();
      expect(result.native.roleProof).toBeUndefined();
    }
    for (const role of ["dev", "qa"]) {
      const reservationId = host.reserve(host.rootId, "A", role);
      host.settle(host.rootId, reservationId, "completed");
      host.recordRole(host.rootId, { itemId: "A", role, agentId: role, head, reservationId, evidence: { result: "verified" } });
    }
    if (expected === "completed") {
      host.ready(host.rootId, "A", head);
      expect(host.view(host.rootId).dependencyReadyItemIds).toContain("A");
    } else {
      expect(() => host.ready(host.rootId, "A", head)).toThrow();
    }
    expect(await call("bounded_status", { scopeId: host.rootId })).toBeTruthy();
    if (expected !== "failed") await expect(call("task", task)).rejects.toThrow();
    expect(jobs).toHaveLength(1);
    if (expected === "completed") return;
    const corrected = host.reserve(host.rootId, "A", "architect-corrected");
    host.settle(host.rootId, corrected, "completed");
    host.recordRole(host.rootId, { itemId: "A", role: "architect", agentId: "architect", head, reservationId: corrected, evidence: { findings: "inspected", decision: "approved" } });
    host.ready(host.rootId, "A", head);
    expect(host.view(host.rootId).dependencyReadyItemIds).toContain("A");
  } finally {
    await hooks.get("session_shutdown")?.({}, context);
    await bridge.close();
  }
});

test("native preflight errors remain visible and uncertain assignments cannot be replayed", async () => {
  const tools = new Map();
  const sessionManager = { getSessionId: () => "session" };
  const jobs = [];
  const root = { id: "root", session: { sessionManager, asyncJobManager: { getAllJobs: () => jobs } } };
  boundedEntry({ zod: z, pi: { AgentRegistry: { global: () => ({ get: () => root }) } }, registerTool: (tool) => tools.set(tool.name, tool), on: () => {} });
  const taskTool = tools.get("task");
  const schema = z.toJSONSchema(taskTool.parameters);
  expect(taskTool.strict).toBe(false);
  expect(schema.required).not.toContain("role");
  expect(schema.required).not.toContain("review");
  let calls = 0;
  const context = { agent: { id: "root", kind: "main" }, sessionManager, cwd: process.cwd(), invokeTool: async () => {
    calls++;
    return { isError: true, content: [{ type: "text", text: 'Unknown agent "general"' }], details: { results: [] } };
  } };
  const call = (name, args) => tools.get(name).execute("test", args, undefined, undefined, context);
  const begin = JSON.parse((await call("bounded_begin", { workflow: "pipeline", itemIds: ["A"], reviewLimit: 2, landing: { mode: "ready-pr", target: "main" } })).content[0].text);
  const args = { scopeId: begin.scopeId, itemId: "A", assignmentKey: "architect", context: "test", role: { kind: "architect", worktree: process.cwd() }, tasks: [{ agent: "general", task: "Plan", solutionSpace: "Read only" }] };
  await expect(call("task", args)).rejects.toThrow('Unknown agent "general"');
  const status = JSON.parse((await call("bounded_status", { scopeId: begin.scopeId })).content[0].text);
  expect(status.reservations[0].state).toBe("uncertain");
  await expect(call("bounded_reconcile", { scopeId: begin.scopeId, reservationId: status.reservations[0].id })).rejects.toThrow("do not redispatch");
  await expect(call("task", args)).rejects.toThrow();
  expect(calls).toBe(1);
});

test("a terminal review with invalid output can be retried without inventing a verdict", async () => {
  const tools = new Map();
  const jobs = [];
  const children = new Map();
  const sessionManager = { getSessionId: () => "session" };
  const root = { id: "root", session: { sessionManager, asyncJobManager: { getAllJobs: () => jobs } } };
  const registry = { get: (id) => id === "root" ? root : children.get(id) };
  boundedEntry({ zod: z, pi: { AgentRegistry: { global: () => registry } }, registerTool: (tool) => tools.set(tool.name, tool), on: () => {} });
  const cwd = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const changes = [{ changeId: "A", head, worktree: cwd }];
  let count = 0;
  const context = { agent: { id: "root", kind: "main" }, sessionManager, cwd, invokeTool: async () => {
    count++;
    const id = `child-${count}`;
    const output = count === 1 ? "Review in prose" : JSON.stringify({ changes, verdict: "approve" });
    children.set(id, { id, parentId: "root", session: { messages: [{ role: "assistant", content: [{ type: "text", text: output }] }] } });
    jobs.push({ id, ownerId: "root", agentId: id, type: "task", status: "completed", promise: Promise.resolve(), latestDetails: { progress: [{ index: 0, id, agent: "reviewer", status: "completed" }] } });
    return { content: [], details: { progress: [{ index: 0, id, agent: "reviewer", status: "running" }] } };
  } };
  const call = (name, args) => tools.get(name).execute("test", args, undefined, undefined, context);
  const begin = JSON.parse((await call("bounded_begin", { workflow: "pipeline", itemIds: ["A"], reviewLimit: 1, landing: { mode: "ready-pr", target: "main" } })).content[0].text);
  const args = { scopeId: begin.scopeId, itemId: "A", assignmentKey: "review-1", context: "test", tasks: [{ agent: "reviewer", task: "Review", solutionSpace: "Read only" }], review: changes };
  await call("task", args);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const first = JSON.parse((await call("bounded_status", { scopeId: begin.scopeId })).content[0].text);
  expect(first.reviews[0]).toMatchObject({ state: "failed", verdict: null });
  await expect(call("task", args)).rejects.toThrow();
  await call("task", { ...args, assignmentKey: "review-2" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = JSON.parse((await call("bounded_status", { scopeId: begin.scopeId })).content[0].text);
  expect(second.reviews[1]).toMatchObject({ state: "completed", verdict: "approve" });
  expect(count).toBe(2);
});
