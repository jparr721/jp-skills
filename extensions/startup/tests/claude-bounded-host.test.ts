import { expect, test } from "bun:test";
import { ClaudeBoundedHost, type ClaudeBoundedAuthority } from "../src/claude-bounded-host";

function fixture(limit = 2) {
  const events: unknown[] = [];
  let sequence = 0;
  const authority: ClaudeBoundedAuthority = {
    reserve: (scope, item, key) => { const id = `reservation-${++sequence}`; events.push(["reserve", scope, item, key, id]); return id; },
    settle: (scope, id, outcome) => { events.push(["settle", scope, id, outcome]); },
    settleRole: (scope, id, receipt) => { events.push(["role", scope, id, receipt]); },
  };
  return { events, host: new ClaudeBoundedHost({ sessionId: "session", authority, limit, validateRole: ({ head }) => head === "a".repeat(40) }) };
}
const pre = (marker: string, id = "tool-1") => ({ hook_event_name: "PreToolUse", session_id: "session", tool_name: "Agent", tool_use_id: id, tool_input: { prompt: `Do the assignment ${marker}` } });
const post = (id: string, agentId: string, text: string, status = "completed") => ({ hook_event_name: "PostToolUse", session_id: "session", tool_name: "Agent", tool_use_id: id, tool_response: { status, agentId, content: [{ type: "text", text }] } });

test("a foreground native Agent result settles the matching reserved role", () => {
  const { host, events } = fixture();
  const assignment = host.prepare({ scopeId: "scope", itemId: "item", assignmentKey: "dev", role: "dev", worktree: "/repo" });
  expect(host.hook(pre(assignment.marker))).toEqual({});
  host.hook(post("tool-1", "agent-1", JSON.stringify({ role: "dev", itemId: "item", head: "a".repeat(40), verdict: "pass", evidence: { implementation: "done", artifact: "commit" } })));
  expect(events[1]).toEqual(["role", "scope", assignment.reservationId, { role: "dev", itemId: "item", agentId: "session:agent-1", head: "a".repeat(40), evidence: { implementation: "done", artifact: "commit" } }]);
  expect(host.result("scope", assignment.reservationId)?.agentId).toBe("agent-1");
  expect(host.result("wrong-scope", assignment.reservationId)).toBeNull();
});

test("rejects unreserved, foreign, reused and background calls", () => {
  const { host } = fixture();
  const assignment = host.prepare({ scopeId: "scope", itemId: "item", assignmentKey: "dev" });
  expect(host.hook(pre("unknown"))).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
  expect(host.hook({ ...pre(assignment.marker), session_id: "other" })).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
  expect(host.hook({ ...pre(assignment.marker), tool_input: { prompt: assignment.marker, run_in_background: true } })).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
  expect(host.hook(pre(assignment.marker))).toEqual({});
  expect(host.hook(pre(assignment.marker, "tool-2"))).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
});

test("missing or asynchronous results remain uncertain and consume budget until closed", () => {
  const { host, events } = fixture(1);
  const assignment = host.prepare({ scopeId: "scope", itemId: "item", assignmentKey: "work" });
  expect(() => host.prepare({ scopeId: "scope", itemId: "other", assignmentKey: "work" })).toThrow("budget");
  host.hook(pre(assignment.marker));
  host.hook(post("tool-1", "agent-1", "", "async_launched"));
  expect(events[1]).toEqual(["settle", "scope", assignment.reservationId, "uncertain"]);
  expect(() => host.prepare({ scopeId: "scope", itemId: "other", assignmentKey: "work" })).toThrow("budget");
  host.hook(post("tool-1", "agent-1", "late"));
  expect(events).toHaveLength(2);
});

test("mismatched proof cannot satisfy an independent role gate", () => {
  const { host, events } = fixture();
  const assignment = host.prepare({ scopeId: "scope", itemId: "item", assignmentKey: "qa", role: "qa", worktree: "/repo" });
  host.hook(pre(assignment.marker));
  host.hook(post("tool-1", "agent-1", JSON.stringify({ role: "qa", itemId: "other", head: "a".repeat(40), verdict: "pass", evidence: { method: "test", result: "ok", artifact: "log" } })));
  expect(events[1]).toEqual(["settle", "scope", assignment.reservationId, "uncertain"]);
});

test("shutdown marks undispatched and in-flight assignments uncertain", () => {
  const { host, events } = fixture();
  const one = host.prepare({ scopeId: "scope", itemId: "one", assignmentKey: "work" });
  const two = host.prepare({ scopeId: "scope", itemId: "two", assignmentKey: "work" });
  host.hook(pre(two.marker));
  host.close();
  expect(events.slice(2)).toEqual([["settle", "scope", one.reservationId, "uncertain"], ["settle", "scope", two.reservationId, "uncertain"]]);
});
