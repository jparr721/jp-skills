import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  connectEmployee,
  installEmployeeBridge,
  installEmployeeToolGuard,
  type EmployeeClient,
  type EmployeeBridgeHost,
} from "../src/employee-client";
import type { Json, Source } from "../src/contracts";
import type { NativeContext } from "../src/omp-adapter";

const cleanup: (() => void)[] = [];
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
      if (path === "/poll") return pollPending ?? pollResponse ?? Response.json(pollValue);
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
  const ctx: NativeContext = {
    agent: { id: "root-1", kind: "main" },
    cwd: "/fixture/repo",
    sessionManager: {
      getSessionId: () => "employee-session",
      getSessionFile: () => "/fixture/session.jsonl",
    },
    getSystemPrompt: () => ["base prompt"],
    abort: () => {},
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
  return { host, ctx, messages, timers, emit };
}

test("a fresh helper extension denies employee tools before any client attachment", async () => {
  const native = nativeFixture();
  installEmployeeToolGuard(native.host);
  const helper: NativeContext = { ...native.ctx, agent: { id: "helper-1", kind: "task" } };
  for (const event of [
    { toolName: "startup_claim", input: {} },
    { toolName: "task", input: { startup: { role: "manager" } } },
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

test("bridge injects canonical projection only into the bound root and deduplicates own inbox wakes", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  await bridge.poll();
  expect(native.messages).toEqual([
    { content: "Startup inbox cue own-cue-1 is durable. Claim your own inbox and follow the canonical loop.", triggerTurn: true, deliverAs: "nextTurn" },
  ]);
  expect(await native.emit("before_agent_start", { systemPrompt: ["native"] }, native.ctx)).toEqual({ systemPrompt: ["native", "COMPLETE CANONICAL ROLE AND LOOP"] });
  const result = await native.emit("context", { messages: [{ role: "user", content: "hello" }] }, native.ctx);
  const context = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()) }).parse(result);
  expect(context.messages[0]?.content).toBe("COMPLETE CANONICAL ROLE AND LOOP");
  expect(context.messages[1]).toEqual({ role: "user", content: "hello" });
  const helper: NativeContext = { ...native.ctx, agent: { id: "helper-1", kind: "task", parentId: "root-1" } };
  expect(await native.emit("context", { messages: [] }, helper)).toBeUndefined();
  expect(await native.emit("before_agent_start", { systemPrompt: [] }, helper)).toBeUndefined();
  expect(await native.emit("tool_call", { toolName: "startup_settle", input: {} }, helper)).toEqual({ block: true, reason: expect.stringContaining("helper") });
  expect(await native.emit("tool_call", { toolName: "read", input: {} }, helper)).toBeUndefined();
  expect(await native.emit("tool_call", { toolName: "startup_claim", input: {} }, native.ctx)).toBeUndefined();
  expect(await native.emit("session_stop", {}, native.ctx)).toEqual({ continue: true, additionalContext: "Settle your active claim before waiting" });
  fixture.setPoll({ projection: "UPDATED", pendingMessageIds: ["own-cue-1", "own-cue-2"], toolBlockReason: null, waitReason: null });
  await bridge.poll();
  expect(native.messages).toHaveLength(2);
  expect(await native.emit("session_stop", {}, native.ctx)).toBeUndefined();
  expect(fixture.requests.filter((entry) => entry.path === "/command").map((r) => r.body)).toEqual([{ kind: "begin_turn" }, { kind: "begin_turn" }]);
  expect(JSON.stringify(native.messages)).not.toContain("private-");
  bridge.close();
  expect(native.timers.size).toBe(0);
});

test("bridge polling failure blocks stale employee actions and visibly reports coordinator unavailability", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { client, ctx: native.ctx, intervalMs: 60000 });
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
  const bridge = installEmployeeBridge(native.host, { client, ctx: native.ctx, intervalMs: 5 });
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
  const bridge = installEmployeeBridge(native.host, { client, ctx: native.ctx, intervalMs: 60000 });
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
  const bridge = installEmployeeBridge(native.host, { client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  expect(await native.emit("session_stop", {}, native.ctx)).toHaveProperty("continue", true);
  expect(await native.emit("session_stop", {}, native.ctx)).toBeUndefined();
});

test("synthetic context cannot reach a provider when root capacity admission is denied", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { client, ctx: native.ctx, intervalMs: 60000 });
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
  const bridge = installEmployeeBridge(native.host, { client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await bridge.poll();
  expect(await native.emit("tool_call", { toolName: "bash", input: { command: "write" } }, native.ctx)).toEqual({ block: true, reason: "Claim requires reconciliation" });
  expect(await native.emit("tool_call", { toolName: "startup_send", input: {} }, native.ctx)).toBeUndefined();
});

test("a missed native capacity release is retried after read-only connection recovery", async () => {
  const fixture = serverFixture();
  const client = await connect(fixture);
  const native = nativeFixture();
  const bridge = installEmployeeBridge(native.host, { client, ctx: native.ctx, intervalMs: 60000 });
  cleanup.push(bridge.close);
  await native.emit("before_agent_start", { systemPrompt: [] }, native.ctx);
  fixture.commandError(new Response("temporarily offline", { status: 503 }));
  await expect(native.emit("agent_end", { willContinue: false }, native.ctx)).rejects.toThrow("503");
  fixture.commandError(Response.json({ released: true }));
  await bridge.poll();
  expect(fixture.requests.filter((r) => r.path === "/command").map((r) => r.body)).toEqual([{ kind: "begin_turn" }, { kind: "end_turn" }, { kind: "end_turn" }]);
});
