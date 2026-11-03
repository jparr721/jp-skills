import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { ClaudeBoundedHost } from "../src/claude-bounded-host";
import { claudeBoundedHookSettings, serveClaudeBoundedHooks } from "../src/claude-bounded-transport";

test("command hook transport forwards real framed events to the authority", async () => {
  const transitions: string[] = [];
  const host = new ClaudeBoundedHost({ sessionId: "s", limit: 1, validateRole: () => false, authority: {
    reserve: () => "r", settle: (_scope, _id, outcome) => transitions.push(outcome), settleRole: () => { throw new Error("unexpected role"); },
  } });
  const transport = await serveClaudeBoundedHooks(host);
  try {
    const assignment = host.prepare({ scopeId: "scope", itemId: "item", assignmentKey: "key" });
    const exchange = async (event: unknown) => {
      const result = Promise.withResolvers<unknown>();
      const socket = createConnection(transport.socket);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(JSON.stringify(event) + "\n"));
      socket.on("data", (part: string) => { buffer += part; if (buffer.includes("\n")) result.resolve(JSON.parse(buffer)); });
      socket.on("error", result.reject);
      return result.promise;
    };
    expect(await exchange({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Agent", tool_use_id: "t", tool_input: { prompt: assignment.marker } })).toEqual({});
    expect(await exchange({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Agent", tool_use_id: "t", tool_response: { status: "completed", agentId: "native", content: [{ type: "text", text: JSON.stringify({ status: "completed", result: "done" }) }] } })).toEqual({});
    expect(transitions).toEqual(["completed"]);
  } finally { await transport.close(); }
});

test("session settings gate Agent and bounded MCP calls without editing profiles", () => {
  const settings = claudeBoundedHookSettings("/path with space/bun", "/repo/hook.ts");
  expect(JSON.stringify(settings)).toContain("'/path with space/bun' '/repo/hook.ts'");
  expect(JSON.stringify(settings)).toContain('"matcher":"Agent"');
  expect(JSON.stringify(settings)).toContain('"matcher":"Agent|^mcp__bounded__.*"');
  expect(JSON.stringify(settings)).toContain('"onFailure":"block"');
});
