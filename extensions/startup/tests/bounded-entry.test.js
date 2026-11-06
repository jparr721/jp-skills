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
