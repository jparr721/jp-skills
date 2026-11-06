import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ClaudeBoundedController } from "../src/claude-bounded-controller";

const result = z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ text: z.string() })) }) });
async function invoke(controller: ClaudeBoundedController, name: string, args: unknown): Promise<unknown> {
  const response = result.parse(await controller.request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
  if (response.result.isError) throw new Error(response.result.content[0]?.text);
  return JSON.parse(response.result.content[0]?.text ?? "null");
}
const prepare = z.object({ marker: z.string(), reservationId: z.string() });
const begin = z.object({ scopeId: z.string() });
const view = z.object({ graphFrozen: z.boolean(), planner: z.object({ state: z.string() }).nullable(), reservations: z.array(z.object({ id: z.string(), state: z.string() })) });
const hook = (event: string, id: string, extra: object) => ({ hook_event_name: event, session_id: "session", tool_name: "Agent", tool_use_id: id, ...extra });

test.each(["merged", "ready-pr"])("hotfix accepts %s landing", async (landing) => {
  const controller = new ClaudeBoundedController("session", process.cwd());
  const scope = begin.parse(await invoke(controller, "bounded_begin", {
    workflow: "hotfix", itemIds: ["one"], reviewLimit: 1, runtimeLimit: 1,
    target: "main", landing, allowedChildTargets: [],
  }));
  expect(scope.scopeId).toBeTruthy();
  controller.close();
});

test.each(["merged", "ready-pr"])("nested hotfix inherits %s and needs no human go", async (landing) => {
  const directory = mkdtempSync(join(tmpdir(), "hotfix-landing-"));
  const previousPath = process.env.PATH;
  const cwd = realpathSync(process.cwd());
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const pr = JSON.stringify({ headRefOid: head, baseRefName: "main", state: "OPEN", isDraft: false, url: "https://example.test/pr/1", mergeCommit: null });
  writeFileSync(join(directory, "gh"), `#!/bin/sh\nprintf '%s\\n' '${pr}'\n`);
  chmodSync(join(directory, "gh"), 0o755);
  process.env.PATH = `${directory}:${previousPath}`;
  const controller = new ClaudeBoundedController("session", cwd);
  try {
    const parent = begin.parse(await invoke(controller, "bounded_begin", { workflow: "pipeline", itemIds: ["one"], reviewLimit: 2, runtimeLimit: 1, target: "main", landing, allowedChildTargets: [] }));
    const child = begin.parse(await invoke(controller, "bounded_nest", { parentId: parent.scopeId, workflow: "hotfix", itemIds: ["one"], reviewLimit: 1, target: "main" }));
    await expect(invoke(controller, "bounded_complete", { scopeId: child.scopeId, itemId: "one", worktree: cwd, head, prNumber: 1 })).rejects.toThrow(
      landing === "merged" ? "PR has not merged" : "Canonical completion gates are not satisfied",
    );
  } finally {
    controller.close();
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("factory planner and native Agent result share one authority and fixed queue", async () => {
  const controller = new ClaudeBoundedController("session", process.cwd());
  const root = begin.parse(await invoke(controller, "bounded_begin", { workflow: "factory", itemIds: ["one", "two"], reviewLimit: 2, runtimeLimit: 2, target: "main", landing: "ready-pr", allowedChildTargets: [] }));
  await expect(invoke(controller, "bounded_prepare", { scopeId: root.scopeId, itemId: "one", assignmentKey: "dev" })).rejects.toThrow();
  const planner = prepare.parse(await invoke(controller, "bounded_plan", { scopeId: root.scopeId }));
  expect(controller.hook(hook("PreToolUse", "plan-call", { tool_input: { prompt: planner.marker } }))).toEqual({});
  controller.hook(hook("PostToolUse", "plan-call", { tool_response: { status: "completed", agentId: "planner", content: [{ type: "text", text: JSON.stringify({ dependencies: { one: [], two: ["one"] }, targets: { one: ["main"], two: ["main"] } }) }] } }));
  const frozen = view.parse(await invoke(controller, "bounded_status", { scopeId: root.scopeId }));
  expect(frozen.graphFrozen).toBe(true);
  expect(frozen.planner?.state).toBe("completed");
  await expect(invoke(controller, "bounded_prepare", { scopeId: root.scopeId, itemId: "outside", assignmentKey: "dev" })).rejects.toThrow();
  const work = prepare.parse(await invoke(controller, "bounded_prepare", { scopeId: root.scopeId, itemId: "one", assignmentKey: "work" }));
  controller.hook(hook("PreToolUse", "work-call", { tool_input: { prompt: work.marker } }));
  controller.hook(hook("PostToolUse", "work-call", { tool_response: { status: "completed", agentId: "worker", content: [{ type: "text", text: JSON.stringify({ status: "completed", result: "actual worker output" }) }] } }));
  expect(view.parse(await invoke(controller, "bounded_status", { scopeId: root.scopeId })).reservations.find((entry) => entry.id === work.reservationId)?.state).toBe("completed");
  expect(await invoke(controller, "bounded_result", { scopeId: root.scopeId, reservationId: work.reservationId })).toEqual({ agentId: "worker", content: [{ type: "text", text: JSON.stringify({ status: "completed", result: "actual worker output" }) }] });
  controller.close();
});

test("subagents cannot call bounded MCP controls and unreserved native calls are denied", () => {
  const controller = new ClaudeBoundedController("session", process.cwd());
  expect(controller.hook({ hook_event_name: "PreToolUse", session_id: "session", agent_id: "child", tool_name: "mcp__bounded__bounded_begin" })).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
  expect(controller.hook(hook("PreToolUse", "call", { tool_input: { prompt: "unreserved" } }))).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
});
