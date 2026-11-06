import { expect, test } from "bun:test";
import { z } from "zod";
import boundedEntry from "../bounded-entry";
import { startWorkflowBridge } from "../src/workflow-bridge";
import { BoundedWorkflowHost } from "../src/workflow-host";

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
