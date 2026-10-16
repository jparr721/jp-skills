import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  connectEmployee,
  installEmployeeBridge,
  installEmployeeToolGuard,
  EmployeeTransportError,
  type EmployeeClient,
  type EmployeeBridgeHost,
} from "../src/employee-client";
import type { Json, Source } from "../src/contracts";
import type { NativeContext } from "../src/omp-adapter";

const cleanup: (() => void)[] = [];
const instructions: string = "COMPLETE CANONICAL ROLE AND LOOP";
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const source: Source = {
  rolePath: "/fixture/role.md",
  roleRevision: "role-hash",
  loopPath: "/fixture/loop.md",
  loopRevision: "loop-hash",
};
type RequestRecord = Readonly<{ path: string; auth: string | null; body: Json }>;
function serverFixture() {
  const directory: string = mkdtempSync(join(tmpdir(), "startup-employee-"));
  const socketPath: string = join(directory, "coordinator.sock");
  const requests: RequestRecord[] = [];
  let pollValue: Json = {
    projection: "COMPLETE CANONICAL ROLE AND LOOP",
    pendingMessageIds: ["own-cue-1"],
    toolBlockReason: null,
    waitReason: "Settle your active claim before waiting",
  };
  let commandResponse: Response | null = null;
  let admitResponse: Response | null = null;
  let pollResponse: Response | null = null;
  let pollPending: Promise<Response> | null = null;
  let rejectPollOnce = false;
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request: Request): Promise<Response> {
      const path: string = new URL(request.url).pathname;
      const body: Json = request.method === "POST"
        ? z.json().parse(await request.json())
        : null;
      requests.push({ path, auth: request.headers.get("authorization"), body });
      if (path === "/admit")
        return admitResponse ?? Response.json({ connection: "private-connection" });
      if (path === "/command")
        return commandResponse ?? Response.json({ accepted: true, messageStatus: "pending" });
      if (path === "/poll" && rejectPollOnce) { rejectPollOnce = false; return Response.json({ error: "old coordinator epoch" }, { status: 403 }); }
      if (path === "/poll") return pollPending ?? pollResponse?.clone() ?? Response.json(pollValue);
      return new Response("unknown route", { status: 404 });
    },
  });
  cleanup.push(() => {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    socketPath,
    requests,
    disconnect(): void { server.stop(true); },
    loseEpoch(): void { rejectPollOnce = true; },
    setPoll(value: Json): void { pollValue = value; },
    commandError(value: Response): void { commandResponse = value; },
    admitError(value: Response): void { admitResponse = value; },
    pollError(value: Response): void { pollResponse = value; },
    delayPoll(value: Promise<Response>): void { pollPending = value; },
  };
}
async function connect(fixture: ReturnType<typeof serverFixture>): Promise<EmployeeClient> {
  const client: EmployeeClient = await connectEmployee({
    socketPath: fixture.socketPath,
    credential: "private-credential",
    nativeSession: "employee-session",
    paneId: "pane-1",
    source,
  });
  cleanup.push(client.close);
  return client;
}
function nativeFixture() {
  const handlers = new Map<string, (event: unknown, ctx: NativeContext) => unknown>();
  const messages: Readonly<{ content: string; triggerTurn: boolean; deliverAs: string }>[] = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  let idle: boolean = false;
  let pendingMessages: boolean = false;
  const ctx: NativeContext = {
    agent: { id: "root-1", kind: "main" },
    cwd: "/fixture/repo",
    sessionManager: {
      getSessionId: () => "employee-session",
      getSessionFile: () => "/fixture/session.jsonl",
    },
    getSystemPrompt: () => ["base prompt"],
    abort: () => {},
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    setInterval(callback, ms) {
      const timer: ReturnType<typeof setInterval> = setInterval(callback, ms);
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) { clearInterval(timer); timers.delete(timer); },
  };
  const host: EmployeeBridgeHost = {
    on(name, handler) { handlers.set(name, handler); },
    sendMessage(message, options) {
      messages.push({ content: message.content, triggerTurn: options.triggerTurn, deliverAs: options.deliverAs });
    },
  };
  cleanup.push(() => { for (const timer of timers) clearInterval(timer); });
  async function emit(name: string, event: unknown, context: NativeContext): Promise<unknown> {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`Missing bridge handler ${name}`);
    return handler(event, context);
  }
  return { host, ctx, messages, timers, emit, setRunState: (nextIdle: boolean, nextPendingMessages: boolean): void => { idle = nextIdle; pendingMessages = nextPendingMessages; } };
}

test("native idle reconciliation releases capacity held by a context-only side request", async () => {
  const fixture = serverFixture();
  fixture.setPoll({ projection: "canonical", pendingMessageIds: [], waitReason: null, toolBlockReason: null });
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await native.emit("context", { messages: [] }, native.ctx);
  native.setRunState(true, true);
  await bridge.poll();
  expect(fixture.requests.filter((r) => r.path === "/command")).toHaveLength(1);
  native.setRunState(true, false);
  await bridge.poll();
  await bridge.poll();
  expect(fixture.requests.filter((r) => r.path === "/command").map((r) => r.body)).toEqual([{ kind: "begin_turn" }, { kind: "end_turn" }]);
});

test("an idle reattached native root reconciles a reservation from its prior process", async () => {
  const fixture = serverFixture();
  fixture.setPoll({ projection: "canonical", pendingMessageIds: [], waitReason: null, toolBlockReason: null });
  const client = await connect(fixture);
  const native = nativeFixture();
  native.setRunState(true, false);
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  await bridge.poll();
  expect(fixture.requests.filter((r) => r.path === "/command").map((r) => r.body)).toEqual([{ kind: "end_turn" }]);
});

test("a fresh helper extension denies employee tools before any client attachment", async () => {
  const native = nativeFixture();
  installEmployeeToolGuard(native.host);
  const helper: NativeContext = { ...native.ctx, agent: { id: "helper-1", kind: "task" } };
  for (const event of [
    { toolName: "startup_claim", input: {} },
    { toolName: "task", input: { startup: { role: "manager" } } },
    { toolName: "write", input: { path: "xd://startup_claim", content: "{}" } },
  ]) expect(await native.emit("tool_call", event, helper)).toEqual({ block: true, reason: "Native helper has no Startup employee authority" });
  expect(await native.emit("tool_call", { toolName: "read", input: {} }, helper)).toBeUndefined();
  expect(await native.emit("tool_call", { toolName: "startup_claim", input: {} }, native.ctx)).toBeUndefined();
});

test("admission binds actual session and source then uses connection token without completing pending work", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  expect(await client.request({ kind: "claim" })).toEqual({ accepted: true, messageStatus: "pending" });
  expect(await client.poll()).toEqual({
    projection: "COMPLETE CANONICAL ROLE AND LOOP",
    pendingMessageIds: ["own-cue-1"],
    toolBlockReason: null,
    waitReason: "Settle your active claim before waiting",
  });
  expect(fixture.requests).toEqual([
    { path: "/admit", auth: null, body: { credential: "private-credential", nativeSession: "employee-session", paneId: "pane-1", source } },
    { path: "/command", auth: "Bearer private-connection", body: { kind: "claim" } },
    { path: "/poll", auth: "Bearer private-connection", body: null },
  ]);
  client.close();
  await expect(client.request({ kind: "claim" })).rejects.toThrow("closed");
  await expect(client.poll()).rejects.toThrow("closed");
});

test("command errors include endpoint status and body without retrying or exposing credentials", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  fixture.commandError(new Response('{"error":"stale private-connection private-credential"}', { status: 409 }));
  let error: unknown = null;
  try { await client.request({ kind: "settle", resultId: "result-1" }); } catch (caught: unknown) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  const message: string = error instanceof Error ? error.message : "missing error";
  expect(message).toContain("POST /command");
  expect(message).toContain("409");
  expect(message).toContain("stale");
  expect(message).not.toContain("private-credential");
  expect(message).not.toContain("private-connection");
  expect(fixture.requests.filter((entry) => entry.path === "/command")).toHaveLength(1);
});

test("repeated rejected claim commands are suppressed until canonical claim state changes", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  fixture.setPoll({ projection: "STARTUP_CLAIMS=active-claim", pendingMessageIds: [], toolBlockReason: null, waitReason: null });
  await client.poll();
  fixture.commandError(new Response("Employee already has an unresolved claim", { status: 409 }));
  await expect(client.request({ kind: "claim" })).rejects.toThrow("unresolved claim");
  await expect(client.request({ kind: "claim" })).rejects.toThrow("duplicate command suppressed");
  expect(fixture.requests.filter((request) => request.path === "/command")).toHaveLength(1);
  expect(client.settlementBlock()).not.toBeNull();
  await client.poll();
  await expect(client.request({ kind: "claim" })).rejects.toThrow("duplicate command suppressed");
  expect(fixture.requests.filter((request) => request.path === "/command")).toHaveLength(1);
  fixture.setPoll({ projection: "STARTUP_CLAIMS=reconciled-claim", pendingMessageIds: [], toolBlockReason: null, waitReason: null });
  await client.poll();
  fixture.commandError(Response.json({ claim: null }));
  expect(await client.request({ kind: "claim" })).toEqual({ claim: null });
});

test("command suppression accepts corrected requests and never caches service failures or capacity denial", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  for (const status of [400, 403, 409]) {
    fixture.commandError(new Response("Correct the request", { status }));
    const command: Json = { kind: "item", request: { expectedRevision: status } };
    await expect(client.request(command)).rejects.toThrow("retryable=false");
    const count = fixture.requests.length;
    await expect(client.request(command)).rejects.toThrow("suppressed");
    expect(fixture.requests).toHaveLength(count);
    fixture.commandError(Response.json({ accepted: true }));
    await client.request({ kind: "item", request: { expectedRevision: status + 1 } });
    expect(client.settlementBlock()).toBeNull();
  }
  for (const command of [{ kind: "begin_turn" }, { kind: "end_turn" }, { kind: "claim" }]) {
    fixture.commandError(new Response("Service unavailable", { status: 503 }));
    const count = fixture.requests.length;
    await expect(client.request(command)).rejects.toThrow("503");
    fixture.commandError(new Response("Service unavailable", { status: 503 }));
    await expect(client.request(command)).rejects.toThrow("503");
    expect(fixture.requests).toHaveLength(count + 2);
  }
});

test("invalid admission receipt and malformed poll response fail at the boundary", async () => {
  const fixture = serverFixture();
  fixture.admitError(Response.json({ connection: "" }));
  await expect(connect(fixture)).rejects.toThrow("/admit");
  fixture.admitError(Response.json({ connection: "private-connection" }));
  const client = await connect(fixture);
  fixture.pollError(Response.json({ projection: "", pendingMessageIds: [7], toolBlockReason: null, waitReason: null }));
  await expect(client.poll()).rejects.toThrow("/poll");
  fixture.pollError(new Response("not JSON", { status: 200 }));
  await expect(client.poll()).rejects.toThrow("JSON");
});

test("an idle native session recovers a stranded queued wake without queuing turns while busy", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  expect(native.messages).toHaveLength(0);
  native.setRunState(true, true);
  await bridge.poll();
  expect(native.messages).toHaveLength(1);
  expect(native.messages[0]?.triggerTurn).toBe(true);
});

test("a thousand durable messages produce one native wake and wait behind an already queued wake", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  native.setRunState(true, false);
  const pending = Array.from({ length: 1000 }, (_, i) => `cue-${i}`);
  fixture.setPoll({ projection: "canonical", pendingMessageIds: pending, toolBlockReason: null, waitReason: "Drain inbox" });
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  expect(native.messages).toHaveLength(1);
  expect(native.messages[0]?.content).toContain("1000");
  native.setRunState(false, true);
  await native.emit("before_agent_start", { systemPrompt: [] }, native.ctx);
  fixture.setPoll({ projection: "canonical", pendingMessageIds: [...pending, "later-cue"], toolBlockReason: null, waitReason: "Drain inbox" });
  await bridge.poll();
  expect(native.messages).toHaveLength(1);
  native.setRunState(true, false);
  await bridge.poll();
  expect(native.messages).toHaveLength(2);
});

test("unchanged durable work does not buy another model turn just because time passed", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(100000);
  cleanup.push(() => clock.mockRestore());
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  native.setRunState(true, false);
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  native.setRunState(false, false);
  await native.emit("before_agent_start", { systemPrompt: [] }, native.ctx);
  await native.emit("agent_end", { willContinue: false }, native.ctx);
  native.setRunState(true, false);
  for (let minute = 1; minute <= 60; minute += 1) {
    clock.mockReturnValue(100000 + minute * 60000);
    await bridge.poll();
  }
  expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(1);
  fixture.setPoll({ projection: "canonical", pendingMessageIds: ["own-cue-1", "new-assignment"], toolBlockReason: null, waitReason: "Drain inbox" });
  await bridge.poll();
  expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(2);
});

test("new inbox messages coalesce behind one scheduled native wake", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  native.setRunState(true, true);
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  fixture.setPoll({ projection: "canonical", pendingMessageIds: ["own-cue-1", "new-cue"], toolBlockReason: null, waitReason: "Drain inbox" });
  await bridge.poll();
  expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(1);
});

test("context-only native continuation consumes its queued wake and admits the next scheduled duty", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  native.setRunState(true, false);
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  for (let check = 0; check < 5; check += 1) {
    fixture.setPoll({ projection: `check-${check}`, pendingMessageIds: [`duty-${check}`], toolBlockReason: null, waitReason: "Drain duty" });
    await bridge.poll();
    expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(check + 1);
    native.setRunState(false, false);
    await native.emit("context", { messages: [] }, native.ctx);
    await native.emit("agent_end", { willContinue: false }, native.ctx);
    native.setRunState(true, false);
    await bridge.poll();
    expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(check + 1);
  }
});

test("provider failure parks inference while polling continues, until explicit root input", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  native.setRunState(true, false);
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await native.emit("message_end", { message: { role: "assistant", stopReason: "error", errorStatus: 403, errorMessage: "Weekly budget exhausted" } }, native.ctx);
  await native.emit("message_end", { message: { role: "assistant", stopReason: "error", errorStatus: 403 } }, native.ctx);
  for (let i = 0; i < 50; i += 1) {
    fixture.setPoll({ projection: "canonical", pendingMessageIds: [`cue-${i}`], toolBlockReason: null, waitReason: "Drain inbox" });
    await bridge.poll();
  }
  expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(0);
  expect(native.messages.filter((message) => message.content.includes("inference paused"))).toHaveLength(1);
  expect(await native.emit("session_stop", {}, native.ctx)).toBeUndefined();
  const admissionCount = fixture.requests.filter((request) => z.object({ kind: z.literal("begin_turn") }).safeParse(request.body).success).length;
  await native.emit("context", { messages: [] }, native.ctx);
  expect(fixture.requests.filter((request) => z.object({ kind: z.literal("begin_turn") }).safeParse(request.body).success)).toHaveLength(admissionCount);
  await native.emit("input", { source: "extension", text: "synthetic reminder" }, native.ctx);
  await bridge.poll();
  expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(0);
  await native.emit("input", { source: "interactive", text: "Provider fixed, resume" }, native.ctx);
  await native.emit("before_agent_start", { systemPrompt: [] }, native.ctx);
  await native.emit("context", { messages: [] }, native.ctx);
  expect(fixture.requests.filter((request) => z.object({ kind: z.literal("begin_turn") }).safeParse(request.body).success).length).toBeGreaterThan(admissionCount);
});

test("restored provider failure stays parked across reattachment and connection recovery", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  native.setRunState(true, false);
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000, lastAssistant: { role: "assistant", stopReason: "error" } });
  cleanup.push(bridge.close);
  await bridge.poll();
  fixture.pollError(new Response("offline", { status: 503 }));
  await expect(bridge.poll()).rejects.toThrow("503");
  fixture.pollError(Response.json({ projection: "canonical", pendingMessageIds: ["new-duty"], toolBlockReason: null, waitReason: "Drain inbox" }));
  await bridge.poll();
  expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(0);
  await native.emit("input", { source: "rpc", text: "Provider repaired" }, { ...native.ctx, agent: { id: "helper", kind: "task" } });
  await bridge.poll();
  expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(0);
  await native.emit("input", { source: "rpc", text: "Provider repaired" }, native.ctx);
  await bridge.poll();
  expect(native.messages.filter((message) => message.triggerTurn)).toHaveLength(1);
});

test("bridge injects canonical projection only into the bound root and deduplicates own inbox wakes", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  native.setRunState(true, false);
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  await bridge.poll();
  expect(native.messages).toEqual([
    { content: "Startup inbox has 1 durable message(s). Claim your own inbox and follow the canonical loop.", triggerTurn: true, deliverAs: "nextTurn" },
  ]);
  native.setRunState(false, false);
  expect(await native.emit("before_agent_start", { systemPrompt: ["native"] }, native.ctx)).toEqual({ systemPrompt: ["native", "COMPLETE CANONICAL ROLE AND LOOP"] });
  const result = await native.emit("context", { messages: [{ role: "user", content: "hello" }] }, native.ctx);
  const context = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()) }).parse(result);
  expect(context.messages).toEqual([{ role: "user", content: "hello" }]);
  const helper: NativeContext = { ...native.ctx, agent: { id: "helper-1", kind: "task", parentId: "root-1" } };
  expect(await native.emit("context", { messages: [] }, helper)).toBeUndefined();
  expect(await native.emit("before_agent_start", { systemPrompt: [] }, helper)).toBeUndefined();
  expect(await native.emit("tool_call", { toolName: "startup_settle", input: {} }, helper)).toEqual({ block: true, reason: expect.stringContaining("helper") });
  expect(await native.emit("tool_call", { toolName: "read", input: {} }, helper)).toBeUndefined();
  expect(await native.emit("tool_call", { toolName: "startup_claim", input: {} }, native.ctx)).toBeUndefined();
  expect(await native.emit("session_stop", {}, native.ctx)).toEqual({ continue: true, additionalContext: "Settle your active claim before waiting" });
  fixture.setPoll({ projection: "UPDATED", pendingMessageIds: ["own-cue-1", "own-cue-2"], toolBlockReason: null, waitReason: null });
  native.setRunState(true, false);
  await bridge.poll();
  expect(native.messages).toHaveLength(2);
  expect(await native.emit("session_stop", {}, native.ctx)).toBeUndefined();
  expect(fixture.requests.filter((entry) => entry.path === "/command" && z.object({ kind: z.literal("begin_turn") }).safeParse(entry.body).success).map((r) => r.body)).toEqual([{ kind: "begin_turn" }, { kind: "begin_turn" }]);
  expect(JSON.stringify(native.messages)).not.toContain("private-");
  bridge.close();
  expect(native.timers.size).toBe(0);
});

test("changing Startup state preserves the system prompt and the complete conversation prefix", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const instructions: string = "COMPLETE CANONICAL ROLE AND LOOP";
  const input = { client, ctx: native.ctx, intervalMs: 60000, instructions };
  const bridge = installEmployeeBridge(native.host, input);
  cleanup.push(bridge.close);
  const history = [
    { role: "user", content: "Review the assigned change", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "app.ts" } }], timestamp: 2 },
    { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "source" }], timestamp: 3 },
  ];
  const prompts: unknown[] = [];
  const contexts: Readonly<{ messages: readonly unknown[] }>[] = [];
  for (const checkpoint of ["before-claim", "active-claim", "settled-claim"]) {
    fixture.setPoll({ projection: `${instructions}\nSTARTUP_CHECKPOINT=${checkpoint}\nSTARTUP_CLAIMS=${checkpoint}`, pendingMessageIds: [], toolBlockReason: null, waitReason: null });
    prompts.push(await native.emit("before_agent_start", { systemPrompt: ["native"] }, native.ctx));
    contexts.push(z.object({ messages: z.array(z.unknown()) }).parse(await native.emit("context", { messages: history }, native.ctx)));
  }
  for (const prompt of prompts) expect(prompt).toEqual({ systemPrompt: ["native", instructions] });
  for (const context of contexts) {
    expect(context.messages.slice(0, history.length)).toEqual(history);
    const state = z.object({ role: z.literal("user"), content: z.string() }).parse(context.messages.at(-1));
    expect(state.content).not.toContain(instructions);
    expect(state.content).toContain("STARTUP_CHECKPOINT=");
    expect(context.messages).toHaveLength(history.length + 1);
  }
  expect(JSON.stringify(contexts[0]?.messages.at(-1))).toContain("before-claim");
  expect(JSON.stringify(contexts[2]?.messages.at(-1))).toContain("settled-claim");
});

test("bridge polling failure blocks stale employee actions and visibly reports coordinator unavailability", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  fixture.pollError(new Response("coordinator unavailable", { status: 503 }));
  await expect(bridge.poll()).rejects.toThrow("503");
  expect(native.messages.at(-1)?.content).toContain("503");
  const stopped = z.object({ continue: z.literal(true), additionalContext: z.string() }).parse(await native.emit("session_stop", {}, native.ctx));
  expect(stopped.additionalContext).toContain("503");
  expect(await native.emit("tool_call", { toolName: "startup_settle", input: {} }, native.ctx)).toEqual({ block: true, reason: expect.stringContaining("503") });
  await native.emit("context", { messages: [] }, native.ctx);
  expect(await native.emit("tool_call", { toolName: "bash", input: {} }, native.ctx)).toHaveProperty("block", true);
});


test("native timer coalesces in-flight polls and session mismatch cannot inherit employee authority", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  let resume: (value: Response) => void = () => { throw new Error("Poll is not waiting"); };
  fixture.delayPoll(new Promise<Response>((resolve) => { resume = resolve; }));
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 5 });
  cleanup.push(bridge.close);
  const first: Promise<void> = bridge.poll();
  const second: Promise<void> = bridge.poll();
  expect(first).toBe(second);
  await Bun.sleep(25);
  expect(fixture.requests.filter((entry) => entry.path === "/poll")).toHaveLength(1);
  resume(Response.json({ projection: "canonical source", pendingMessageIds: [], toolBlockReason: null, waitReason: null }));
  await first;
  const foreign: NativeContext = {
    ...native.ctx,
    sessionManager: { getSessionId: () => "foreign-session", getSessionFile: () => "/foreign.jsonl" },
  };
  expect(await native.emit("context", { messages: [] }, foreign)).toBeUndefined();
  expect(await native.emit("tool_call", { toolName: "startup_claim", input: {} }, foreign)).toEqual({ block: true, reason: expect.stringContaining("helper") });
  expect(await native.emit("tool_call", { toolName: "task", input: { startup: "hire" } }, foreign)).toEqual({ block: true, reason: expect.stringContaining("helper") });
  expect(await native.emit("tool_call", { toolName: "task", input: { task: "bounded helper" } }, foreign)).toBeUndefined();
  expect(await native.emit("session_stop", {}, foreign)).toBeUndefined();
  await native.emit("session_shutdown", {}, native.ctx);
  expect(native.timers.size).toBe(0);
  await expect(client.poll()).rejects.toThrow("closed");
});

test("closing client aborts an outstanding poll without resubmission", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  let resume: (value: Response) => void = () => { throw new Error("Poll is not waiting"); };
  fixture.delayPoll(new Promise<Response>((resolve) => { resume = resolve; }));
  const pending: Promise<unknown> = client.poll().catch((error: unknown) => error);
  await Bun.sleep(10);
  client.close();
  const error: unknown = await pending;
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : "").toContain("/poll");
  expect(fixture.requests.filter((entry) => entry.path === "/poll")).toHaveLength(1);
  resume(Response.json({ projection: "unused", pendingMessageIds: [], toolBlockReason: null, waitReason: null }));
});

test("native root turns acquire and release capacity without producing completion receipts", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await native.emit("before_agent_start", { systemPrompt: ["base"] }, native.ctx);
  await native.emit("agent_end", { willContinue: true }, native.ctx);
  await native.emit("agent_end", { willContinue: false }, native.ctx);
  expect(fixture.requests.filter((r) => r.path === "/command").map((r) => r.body)).toEqual([{ kind: "begin_turn" }, { kind: "end_turn" }]);
});

test("a persistent blocked stop reason gets one continuation and then parks", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  expect(await native.emit("session_stop", {}, native.ctx)).toHaveProperty("continue", true);
  expect(await native.emit("session_stop", {}, native.ctx)).toBeUndefined();
});

test("synthetic context cannot reach a provider when root capacity admission is denied", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  fixture.commandError(Response.json({ error: "capacity" }, { status: 403 }));
  await native.emit("context", { messages: [] }, native.ctx);
  expect(await native.emit("tool_call", { toolName: "bash", input: {} }, native.ctx)).toEqual({ block: true, reason: expect.stringContaining("capacity") });
});


test("read-only polling re-admits the same session after coordinator epoch loss without replaying work", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  await client.request({ kind: "settle", resultId: "saved" });
  fixture.loseEpoch();
  expect((await client.poll()).pendingMessageIds).toEqual(["own-cue-1"]);
  expect(fixture.requests.filter((r) => r.path === "/admit")).toHaveLength(2);
  expect(fixture.requests.filter((r) => r.path === "/command")).toHaveLength(1);
});

test("reconciliation blocks technical mutations while retaining typed reporting tools", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  fixture.setPoll({ projection: "canonical", pendingMessageIds: [], waitReason: "Recover claim", toolBlockReason: "Claim requires reconciliation" });
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  expect(await native.emit("tool_call", { toolName: "bash", input: { command: "write" } }, native.ctx)).toEqual({ block: true, reason: "Claim requires reconciliation" });
  expect(await native.emit("tool_call", { toolName: "startup_send", input: {} }, native.ctx)).toBeUndefined();
  expect(await native.emit("tool_call", { toolName: "write", input: { path: "xd://startup_reconcile", content: "{}" } }, native.ctx)).toBeUndefined();
  expect(await native.emit("tool_call", { toolName: "read", input: { path: "xd://startup_reconcile" } }, native.ctx)).toBeUndefined();
});

test("a missed native capacity release is retried after read-only connection recovery", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await native.emit("before_agent_start", { systemPrompt: [] }, native.ctx);
  fixture.commandError(new Response("temporarily offline", { status: 503 }));
  await expect(native.emit("agent_end", { willContinue: false }, native.ctx)).rejects.toThrow("503");
  fixture.commandError(Response.json({ released: true }));
  await bridge.poll();
  expect(fixture.requests.filter((r) => r.path === "/command").map((r) => r.body)).toEqual([{ kind: "begin_turn" }, { kind: "end_turn" }, { kind: "end_turn" }]);
});


test("transport errors retain socket, error code and timing without exposing credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "startup-missing-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "missing.sock");
  let caught: unknown = null;
  try { await connectEmployee({ socketPath, credential: "private-credential", nativeSession: "session", paneId: "pane", source }); }
  catch (error: unknown) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const detail = caught instanceof Error ? caught.message : "missing error";
  expect(detail).toContain("POST /admit");
  expect(detail).toContain(socketPath);
  expect(detail).toMatch(/code=[A-Za-z_]+/);
  expect(detail).toMatch(/elapsedMs=\d+/);
  expect(detail).toContain("timeoutMs=10000");
  expect(detail).not.toContain("private-credential");
});

test("bridge emits one recovery notice per failed connection episode and no initial success notice", async () => {
  const fixture = serverFixture();
  fixture.setPoll({ projection: "canonical", pendingMessageIds: [], toolBlockReason: null, waitReason: null });
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  expect(native.messages).toHaveLength(0);
  for (let episode = 1; episode <= 2; episode += 1) {
    fixture.pollError(new Response("brief outage", { status: 503 }));
    await expect(bridge.poll()).rejects.toThrow("503");
    await expect(bridge.poll()).rejects.toThrow("503");
    expect(native.messages.filter((m) => m.content.includes("unavailable"))).toHaveLength(episode);
    fixture.pollError(Response.json({ projection: "canonical", pendingMessageIds: [], toolBlockReason: null, waitReason: null }));
    await bridge.poll();
    await bridge.poll();
    const recovered = native.messages.filter((m) => m.content.includes("restored"));
    expect(recovered).toHaveLength(episode);
    expect(recovered.at(-1)).toMatchObject({ triggerTurn: false, deliverAs: "nextTurn" });
    expect(recovered.at(-1)?.content).toContain("polling");
    expect(await native.emit("tool_call", { toolName: "startup_send", input: {} }, native.ctx)).toBeUndefined();
  }
});

test("repeated transport failures with different elapsed times emit one unavailable notice", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  fixture.disconnect();
  let transport: unknown = null;
  try { await client.poll(); } catch (error: unknown) { transport = error; }
  if (!(transport instanceof EmployeeTransportError)) throw new Error("Expected the real Unix transport error");
  const diagnostic = transport.diagnostic;
  let elapsedMs = 1;
  const bridge = installEmployeeBridge(native.host, { instructions, client: { ...client, poll: async () => { throw new EmployeeTransportError({ ...diagnostic, elapsedMs: elapsedMs++ }); } }, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await expect(bridge.poll()).rejects.toThrow("/poll");
  await expect(bridge.poll()).rejects.toThrow("/poll");
  expect(native.messages.filter((m) => m.content.includes("unavailable"))).toHaveLength(1);
});

test("recovery wakes an idle root to settle its stranded claim without waking a clean idle root", async () => {
  const fixture = serverFixture();
  fixture.setPoll({ projection: "canonical", pendingMessageIds: [], toolBlockReason: null, waitReason: "Settle or explicitly reconcile your outstanding claim before ending." });
  const client = await connect(fixture);
  const native = nativeFixture(); native.setRunState(true, false);
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 }); cleanup.push(bridge.close);
  await bridge.poll();
  fixture.pollError(new Response("outage", { status: 503 }));
  await expect(bridge.poll()).rejects.toThrow("503");
  fixture.pollError(Response.json({ projection: "canonical", pendingMessageIds: [], toolBlockReason: null, waitReason: "Settle or explicitly reconcile your outstanding claim before ending." }));
  await bridge.poll();
  expect(native.messages.at(-1)).toMatchObject({ triggerTurn: true, deliverAs: "nextTurn" });
});

test("deterministic settlement retries are suppressed across healthy polling and park the native loop", async () => {
  const fixture = serverFixture();
  fixture.setPoll({ projection: 'canonical\nSTARTUP_CLAIMS={"generation":1,"claims":[{"id":"one","status":"active"}]}', pendingMessageIds: ["new-mail"], toolBlockReason: null, waitReason: "Settle your outstanding claim" });
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { instructions, client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  fixture.commandError(Response.json({ error: "ClaimSettlementError", message: "Inspect the existing cue", recovery: { code: "settlement_conflict", retryable: false, action: "Correct result.outgoing; do not repeat the unchanged request", employeeId: "dev-1", generation: 1, claimId: "one" } }, { status: 409 }));
  const command = { kind: "settle", result: { id: "result", kind: "completed", output: "done", checkpoint: null, outgoing: [] } };
  await expect(client.request(command)).rejects.toThrow("Correct result.outgoing");
  await bridge.poll();
  await expect(client.request({ ...command, result: { ...command.result, id: "different-id" } })).rejects.toMatchObject({ repeated: true });
  expect(fixture.requests.filter((r) => r.path === "/command")).toHaveLength(1);
  expect(await native.emit("session_stop", {}, native.ctx)).toBeUndefined();
  const notices = native.messages.length;
  await bridge.poll();
  expect(native.messages).toHaveLength(notices);
  fixture.setPoll({ projection: 'canonical\nSTARTUP_CLAIMS={"generation":1,"claims":[]}', pendingMessageIds: [], toolBlockReason: null, waitReason: null });
  await bridge.poll();
  fixture.commandError(Response.json({ accepted: true }));
  await expect(client.request(command)).resolves.toEqual({ accepted: true });
});

test("corrected settlement payload and corrected result-ID collision can proceed without restarting", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const command = { kind: "settle", result: { id: "collision", kind: "completed", output: "new work", checkpoint: null, outgoing: [] } };
  fixture.commandError(Response.json({ recovery: { code: "result_replay_conflict", retryable: false, action: "Inspect the receipt and correct the result ID", employeeId: "dev-1", generation: 1, claimId: "claim" } }, { status: 409 }));
  await expect(client.request(command)).rejects.toMatchObject({ repeated: false });
  fixture.commandError(Response.json({ accepted: true, claimId: "claim" }));
  await expect(client.request({ ...command, result: { ...command.result, id: "corrected" } })).resolves.toEqual({ accepted: true, claimId: "claim" });
  expect(client.settlementBlock()).toBeNull();
  fixture.commandError(Response.json({ recovery: { code: "settlement_conflict", retryable: false, action: "Correct outgoing cue payload", employeeId: "dev-1", generation: 1, claimId: "claim" } }, { status: 409 }));
  await expect(client.request(command)).rejects.toMatchObject({ repeated: false });
  await expect(client.request(command)).rejects.toMatchObject({ repeated: true });
  fixture.commandError(Response.json({ accepted: true, claimId: "claim" }));
  await expect(client.request({ ...command, result: { ...command.result, output: "corrected output" } })).resolves.toEqual({ accepted: true, claimId: "claim" });
  expect(client.settlementBlock()).toBeNull();
});

test("settlement connection authorization and transport failures are not cached as deterministic rejection", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const command = { kind: "settle", result: { id: "result", kind: "completed", output: "done", checkpoint: null, outgoing: [] } };
  for (const status of [401, 403, 500, 503]) {
    fixture.commandError(new Response("Connection admission unavailable", { status }));
    await expect(client.request(command)).rejects.toThrow(`HTTP ${status}`);
    fixture.commandError(Response.json({ accepted: true }));
    await expect(client.request(command)).resolves.toEqual({ accepted: true });
  }
});

test("replaying claim A does not release a rejected settlement for claim B", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const blocked = { kind: "settle", result: { id: "b", kind: "completed", output: "B", checkpoint: null, outgoing: [] } };
  fixture.commandError(Response.json({ recovery: { code: "settlement_conflict", retryable: false, action: "Correct B", employeeId: "manager", generation: 1, claimId: "claim-b" } }, { status: 409 }));
  await expect(client.request(blocked)).rejects.toMatchObject({ repeated: false });
  await expect(client.request(blocked)).rejects.toMatchObject({ repeated: true });
  fixture.commandError(Response.json({ claimId: "claim-a", result: { id: "a" } }));
  await client.request({ kind: "settle", result: { ...blocked.result, id: "a", output: "A" } });
  expect(client.settlementBlock()).not.toBeNull();
  await expect(client.request(blocked)).rejects.toMatchObject({ repeated: true });
  expect(fixture.requests.filter((r) => r.path === "/command")).toHaveLength(2);
});
