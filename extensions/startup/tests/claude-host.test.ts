import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Json } from "../src/contracts";
import { claudeRoot, createClaudeHost, jsonSchemaBuilder, type ClaudeHost, type ClaudeHookReply, type WaiterHandle } from "../src/claude-host";
import { installLaunchedEmployeeWith } from "../src/employee-entry";
import { loadProfile, profileText } from "../src/profiles";
import type { RuntimeHostConfig } from "../src/v7-launch";
const setting = { get: () => 6 };
mock.module("@oh-my-pi/pi-coding-agent/task/settings", () => ({ cfgTaskBatch: setting, cfgTaskEnableEffort: setting, cfgTaskIsolationEnabled: setting, cfgTaskMaxConcurrency: setting }));
const { installStartupV7 } = await import("../v7");

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sessionId: string = "0f8fad5b-d9cb-469f-a165-70867728950e";
type Waiter = Readonly<{ handle: WaiterHandle; fired: string[]; superseded: () => number }>;
function waiter(): Waiter {
  const fired: string[] = [];
  let superseded: number = 0;
  return { handle: { fire: (text: string) => { fired.push(text); }, supersede: () => { superseded += 1; } }, fired, superseded: () => superseded };
}
async function until(predicate: () => boolean, ms: number): Promise<void> {
  const deadline: number = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${ms}ms`);
    await Bun.sleep(20);
  }
}
function useEnvironment(values: Readonly<Record<string, string>>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) { previous.set(key, process.env[key]); process.env[key] = value; }
  cleanup.push(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function coordinatorFixture() {
  const root: string = realpathSync(mkdtempSync(join(tmpdir(), "claude-host-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const skillsRoot: string = join(root, "skills-repo");
  const skillsHome: string = join(root, "jp-skills");
  const startupRoot: string = join(root, "startup-state");
  const configHome: string = join(root, "xdg");
  mkdirSync(skillsHome, { mode: 0o700 });
  mkdirSync(startupRoot, { mode: 0o700 });
  mkdirSync(configHome, { mode: 0o700 });
  for (const role of ["manager", "dev", "pa"]) {
    mkdirSync(join(skillsRoot, "skills", `startup-role-${role}`), { recursive: true });
    writeFileSync(join(skillsRoot, "skills", `startup-role-${role}`, "SKILL.md"), `Complete canonical ${role} persona`);
  }
  mkdirSync(join(skillsRoot, "skills", "startup-loop"));
  writeFileSync(join(skillsRoot, "skills", "startup-loop", "SKILL.md"), "Complete canonical shared loop");
  const socketPath: string = join(startupRoot, "coordinator.sock");
  const commands: Json[] = [];
  const admissions: Json[] = [];
  const responses = new Map<string, Response>();
  let poll: Readonly<{ projection: string; pendingMessageIds: readonly string[]; toolBlockReason: string | null; waitReason: string | null }> = { projection: "LIVE STATE A", pendingMessageIds: [], toolBlockReason: null, waitReason: null };
  const server = Bun.serve({ unix: socketPath, websocket: { message(socket, message): void { admissions.push(z.json().parse(JSON.parse(String(message)))); socket.send(JSON.stringify({ connection: "private-connection" })); } }, async fetch(request: Request, server): Promise<Response | undefined> {
    if (new URL(request.url).pathname === "/admit" && server.upgrade(request)) return;
    const path: string = new URL(request.url).pathname;
    if (path === "/admit") { admissions.push(z.json().parse(await request.json())); return Response.json({ connection: "private-connection" }); }
    if (path === "/poll") return Response.json(poll);
    if (path === "/launch-failure") return Response.json({ recorded: true });
    const command: Json = z.json().parse(await request.json());
    commands.push(command);
    const kind: string = z.object({ kind: z.string() }).parse(command).kind;
    if (kind === "image") return Response.json({ type: "image", data: "fixture-image", mimeType: "image/png" });
    return responses.get(kind)?.clone() ?? Response.json({ accepted: true });
  } });
  cleanup.push(() => { server.stop(true); });
  return {
    root, skillsRoot, skillsHome, startupRoot, configHome, socketPath, commands, admissions,
    kinds: (): readonly string[] => commands.map((command) => z.object({ kind: z.string() }).parse(command).kind),
    setPoll(value: Partial<typeof poll>): void { poll = { ...poll, ...value }; },
    respond(kind: string, response: Response): void { responses.set(kind, response); },
  };
}
async function employeeFixture(options: Readonly<{ instructions: string | null; formatGuardMs: number; waiters: readonly Waiter[] }>) {
  const f = coordinatorFixture();
  const profile = loadProfile({ skillsRoot: f.skillsRoot, role: "dev", employeeId: "dev-1", generation: 1 });
  const text: string = profileText(profile);
  f.setPoll({ projection: `${text}\nLIVE STATE A` });
  mkdirSync(join(f.startupRoot, "launches"), { mode: 0o700 });
  const manifest: string = join(f.startupRoot, "launches", `${sessionId}.json`);
  writeFileSync(manifest, JSON.stringify({ socketPath: f.socketPath, credential: "private-credential", source: profile.source, employeeId: "dev-1", generation: 1, profile: "default", harness: "claude", skillsHome: f.skillsHome, startupRoot: f.startupRoot, skillsRoot: f.skillsRoot }), { mode: 0o600 });
  useEnvironment({ HERDR_PANE_ID: "w1:p2", JP_SKILLS_HOME: f.skillsHome, STARTUP_ROOT: f.startupRoot, CLAUDE_CONFIG_DIR: f.startupRoot });
  const transcript: string = join(f.root, `${sessionId}.jsonl`);
  const shim: ClaudeHost = createClaudeHost({ sessionId, cwd: f.root, instructions: options.instructions === null ? text : options.instructions, transcript: () => transcript, formatGuardMs: options.formatGuardMs });
  cleanup.push(() => shim.shutdown());
  installLaunchedEmployeeWith(shim.host, manifest, claudeRoot({ sessionId, transcript: () => transcript }));
  for (const armed of options.waiters) shim.armWaiter(armed.handle);
  await shim.start();
  return { ...f, shim, text };
}
const defaults = { instructions: null, formatGuardMs: 10000, waiters: [] } as const;
const ups = (prompt: string, promptId: string) => ({ event: "UserPromptSubmit", prompt, promptId, transcript: "/fixture/transcript.jsonl" }) as const;
const pre = (tool: string, query: string, agentId: string) => ({ event: "PreToolUse", tool, query, agentId }) as const;
const context = (reply: ClaudeHookReply): string | null => z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) }).safeParse(reply).data?.hookSpecificOutput.additionalContext ?? null;

test("an idle UserPromptSubmit admits the turn, injects live state and verifies the launch prompt suffix", async () => {
  const f = await employeeFixture(defaults);
  expect(f.admissions).toEqual([{ credential: "private-credential", nativeSession: sessionId, paneId: "w1:p2", source: loadProfile({ skillsRoot: f.skillsRoot, role: "dev", employeeId: "dev-1", generation: 1 }).source }]);
  const before: number = f.commands.length;
  const reply: ClaudeHookReply = await f.shim.hook(ups("do the work", "p1"));
  expect(reply).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "LIVE STATE A" } });
  expect(f.kinds().slice(before)).toEqual(["begin_turn", "begin_turn"]);
  const mismatch = await employeeFixture({ ...defaults, instructions: "A DIFFERENT LAUNCH PROMPT" });
  const refused: ClaudeHookReply = await mismatch.shim.hook(ups("do the work", "p1"));
  expect(refused).toMatchObject({ decision: "block" });
  expect(String(refused.reason)).toContain("--append-system-prompt-file");
});

test("a prompt folded into a running turn starts no second turn", async () => {
  const f = await employeeFixture(defaults);
  const starts: unknown[] = [];
  f.shim.host.on("before_agent_start", (event) => { starts.push(event); return undefined; });
  await f.shim.hook(ups("first", "p1"));
  const before: number = f.commands.length;
  const folded: ClaudeHookReply = await f.shim.hook(ups("also this", "p1"));
  expect(starts).toHaveLength(1);
  expect(f.kinds().slice(before)).toEqual(["begin_turn"]);
  expect(folded).toEqual({});
});

test("a refused begin_turn blocks the prompt with the coordinator reason", async () => {
  const f = await employeeFixture(defaults);
  f.respond("begin_turn", Response.json({ error: "No execution slot is available" }, { status: 403 }));
  const reply: ClaudeHookReply = await f.shim.hook(ups("<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>", "p1"));
  expect(reply).toMatchObject({ decision: "block" });
  expect(String(reply.reason)).toContain("Startup turn blocked");
  expect(String(reply.reason)).toContain("No execution slot is available");
  expect(f.shim.context().isIdle?.()).toBe(true);
});

test("a refused turn asks the coordinator once and releases the slot it may hold", async () => {
  const refused = await employeeFixture(defaults);
  refused.respond("begin_turn", Response.json({ error: "No execution slot is available" }, { status: 403 }));
  const before: number = refused.commands.length;
  const reply: ClaudeHookReply = await refused.shim.hook(ups("go", "p1"));
  expect(String(reply.reason).split("No execution slot is available")).toHaveLength(2);
  expect(refused.kinds().slice(before)).toEqual(["begin_turn", "end_turn"]);
  const mismatch = await employeeFixture({ ...defaults, instructions: "A DIFFERENT LAUNCH PROMPT" });
  const start: number = mismatch.commands.length;
  expect(await mismatch.shim.hook(ups("go", "p1"))).toMatchObject({ decision: "block" });
  expect(mismatch.kinds().slice(start)).toEqual(["begin_turn", "end_turn"]);
  expect(mismatch.shim.context().isIdle?.()).toBe(true);
});

test("live state is injected only when it changes and again after compaction", async () => {
  const f = await employeeFixture(defaults);
  expect(context(await f.shim.hook(ups("go", "p1")))).toBe("LIVE STATE A");
  const post = { event: "PostToolUse", tool: "Bash", agentId: "" } as const;
  expect(await f.shim.hook(post)).toEqual({});
  f.setPoll({ projection: `${f.text}\nLIVE STATE B` });
  expect(context(await f.shim.hook(post))).toBe("LIVE STATE B");
  expect(await f.shim.hook(post)).toEqual({});
  await f.shim.ledger({ kind: "compact" });
  expect(context(await f.shim.hook(post))).toBe("LIVE STATE B");
  expect(await f.shim.hook({ event: "PostToolUse", tool: "Bash", agentId: "helper-1" })).toEqual({});
});

test("PreToolUse maps helper, blocked, paused and deferred Startup tool searches to permission decisions", async () => {
  const f = await employeeFixture(defaults);
  await f.shim.hook(ups("go", "p1"));
  const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  expect(await f.shim.hook(pre("mcp__startup__startup_claim", "", "a61c2e8981c9b0f07"))).toEqual(deny("Native helper has no Startup employee authority"));
  expect(await f.shim.hook(pre("ToolSearch", "select:mcp__startup__startup_claim", "a61c2e8981c9b0f07"))).toEqual(deny("Native helper has no Startup employee authority"));
  expect(await f.shim.hook(pre("mcp__startup__startup_claim", "", ""))).toEqual({});
  f.setPoll({ toolBlockReason: "Claim your inbox first" });
  await f.shim.hook({ event: "PostToolUse", tool: "Bash", agentId: "" });
  expect(await f.shim.hook(pre("Bash", "", ""))).toEqual(deny("Claim your inbox first"));
  expect(await f.shim.hook(pre("ToolSearch", "select:mcp__startup__startup_claim,mcp__startup__startup_settle", ""))).toEqual({});
  expect(await f.shim.hook(pre("ToolSearch", "select:mcp__startup__startup_claim,Bash", ""))).toEqual(deny("Claim your inbox first"));
  expect(await f.shim.hook(pre("ToolSearch", "startup claim", ""))).toEqual(deny("Claim your inbox first"));
  await f.shim.hook({ event: "StopFailure", error: "rate_limit" });
  expect(await f.shim.hook(pre("mcp__startup__startup_claim", "", ""))).toEqual(deny("Startup inference is paused after a provider error; explicit root input is required to resume"));
});

test("Stop continues once per wait reason and then allows the stop", async () => {
  const f = await employeeFixture(defaults);
  f.setPoll({ waitReason: "Settle your active claim before waiting" });
  await f.shim.hook(ups("go", "p1"));
  expect(await f.shim.hook({ event: "Stop", active: "false" })).toEqual({ decision: "block", reason: "Settle your active claim before waiting" });
  expect(await f.shim.hook({ event: "Stop", active: "true" })).toEqual({});
});

test("a transcript end marker releases the turn unless queued input will continue it", async () => {
  const f = await employeeFixture(defaults);
  await f.shim.hook(ups("go", "p1"));
  let before: number = f.commands.length;
  await f.shim.ledger({ kind: "end", marker: "turn_duration" });
  expect(f.kinds().slice(before)).toEqual(["end_turn"]);
  expect(f.shim.context().isIdle?.()).toBe(true);
  await f.shim.ledger({ kind: "end", marker: "interrupted" });
  expect(f.kinds().slice(before)).toEqual(["end_turn"]);
  await f.shim.hook(ups("go again", "p2"));
  await f.shim.ledger({ kind: "queue", delta: 1 });
  before = f.commands.length;
  await f.shim.ledger({ kind: "end", marker: "interrupted" });
  expect(f.kinds().slice(before)).toEqual([]);
  expect(f.shim.context().hasPendingMessages?.()).toBe(true);
  await f.shim.ledger({ kind: "queue", delta: -1 });
  expect(f.shim.context().hasPendingMessages?.()).toBe(false);
});

test("an inbox cue fires only the newest armed waiter, only when idle and never twice", async () => {
  const older: Waiter = waiter();
  const newer: Waiter = waiter();
  const f = await employeeFixture({ ...defaults, waiters: [older, newer] });
  expect(older.superseded()).toBe(1);
  f.setPoll({ pendingMessageIds: ["m1"] });
  await f.shim.hook(ups("busy", "p1"));
  await Bun.sleep(1300);
  expect(newer.fired).toEqual([]);
  await f.shim.ledger({ kind: "end", marker: "turn_duration" });
  await until(() => newer.fired.length === 1, 3000);
  expect(newer.fired[0]).toContain("Startup inbox has 1 durable message(s)");
  expect(f.shim.context().isIdle?.()).toBe(false);
  f.setPoll({ pendingMessageIds: ["m1", "m2"] });
  const third: Waiter = waiter();
  f.shim.armWaiter(third.handle);
  await Bun.sleep(1300);
  expect(newer.fired).toHaveLength(1);
  expect(third.fired).toEqual([]);
  expect(older.fired).toEqual([]);
  await f.shim.hook(ups("<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>", "p2"));
  expect(f.shim.context().isIdle?.()).toBe(false);
});

test("a cue raised before any waiter is armed fires when the first waiter arrives", async () => {
  // Live: the bridge admits and polls inside session_start, before the SessionStart waiter is armed.
  const f = coordinatorFixture();
  f.setPoll({ pendingMessageIds: ["m1"] });
  const profile = loadProfile({ skillsRoot: f.skillsRoot, role: "dev", employeeId: "dev-1", generation: 1 });
  f.setPoll({ projection: `${profileText(profile)}\nLIVE STATE A` });
  mkdirSync(join(f.startupRoot, "launches"), { mode: 0o700 });
  const manifest: string = join(f.startupRoot, "launches", `${sessionId}.json`);
  writeFileSync(manifest, JSON.stringify({ socketPath: f.socketPath, credential: "private-credential", source: profile.source, employeeId: "dev-1", generation: 1, profile: "default", harness: "claude", skillsHome: f.skillsHome, startupRoot: f.startupRoot, skillsRoot: f.skillsRoot }), { mode: 0o600 });
  useEnvironment({ HERDR_PANE_ID: "w1:p2", JP_SKILLS_HOME: f.skillsHome, STARTUP_ROOT: f.startupRoot, CLAUDE_CONFIG_DIR: f.startupRoot });
  const transcript: string = join(f.root, `${sessionId}.jsonl`);
  const shim: ClaudeHost = createClaudeHost({ sessionId, cwd: f.root, instructions: profileText(profile), transcript: () => transcript, formatGuardMs: 10000 });
  cleanup.push(() => shim.shutdown());
  installLaunchedEmployeeWith(shim.host, manifest, claudeRoot({ sessionId, transcript: () => transcript }));
  await shim.start();
  await Bun.sleep(1300);
  const late: Waiter = waiter();
  shim.armWaiter(late.handle);
  expect(late.fired).toHaveLength(1);
  expect(late.fired[0]).toContain("Startup inbox has 1 durable message(s)");
  const reply: ClaudeHookReply = await shim.hook(ups("<task-notification>\n<summary>wake</summary>\n</task-notification>", "p1"));
  expect(context(reply)).not.toContain("Startup inbox has");
});

test("a cue raised while a hook is in flight fires once that hook finishes", async () => {
  const armed: Waiter = waiter();
  const f = await employeeFixture({ ...defaults, waiters: [armed] });
  let release: (() => void) | null = null;
  f.shim.host.on("session_stop", () => new Promise<void>((resolve) => { release = resolve; }));
  const stopping: Promise<ClaudeHookReply> = f.shim.hook({ event: "Stop", active: "false" });
  await until(() => release !== null, 3000);
  f.shim.host.sendMessage({ customType: "startup-cue", content: "WAKE NOW", display: false }, { triggerTurn: true, deliverAs: "nextTurn" });
  expect(armed.fired).toEqual([]);
  release!();
  await stopping;
  expect(armed.fired).toEqual(["WAKE NOW"]);
});

test("an abort is consumed by the next hook according to its kind and is a no-op while idle", async () => {
  const f = await employeeFixture(defaults);
  await f.shim.hook(ups("go", "p1"));
  const abort = f.shim.context().abort;
  if (abort === undefined) throw new Error("Shim context has no abort");
  abort();
  expect(await f.shim.hook(pre("Bash", "", ""))).toEqual({ continue: false, stopReason: "Startup aborted this turn" });
  abort();
  expect(await f.shim.hook({ event: "PostToolUse", tool: "Bash", agentId: "" })).toEqual({ continue: false, stopReason: "Startup aborted this turn" });
  abort();
  expect(await f.shim.hook({ event: "Stop", active: "false" })).toEqual({});
  await f.shim.ledger({ kind: "end", marker: "turn_duration" });
  abort();
  expect(await f.shim.hook(ups("next", "p2"))).not.toHaveProperty("decision");
});

test("a queued prompt that starts before the previous end marker is read is still its own turn", async () => {
  const f = await employeeFixture(defaults);
  const starts: unknown[] = [];
  f.shim.host.on("before_agent_start", (event) => { starts.push(event); return undefined; });
  await f.shim.hook(ups("first", "p1"));
  await f.shim.ledger({ kind: "queue", delta: 1 });
  await f.shim.hook(ups("queued", "p2"));
  expect(starts).toHaveLength(2);
  const before: number = f.commands.length;
  await f.shim.ledger({ kind: "end", marker: "turn_duration" });
  await f.shim.ledger({ kind: "queue", delta: -1 });
  expect(f.kinds().slice(before)).toEqual([]);
  expect(f.shim.context().isIdle?.()).toBe(false);
  await f.shim.ledger({ kind: "end", marker: "turn_duration" });
  expect(f.kinds().slice(before)).toEqual(["end_turn"]);
  expect(f.shim.context().isIdle?.()).toBe(true);
});

test("a ledger failure revokes adapter authority and refuses later turns", async () => {
  const f = await employeeFixture(defaults);
  await f.shim.hook(ups("go", "p1"));
  const before: number = f.commands.length;
  f.shim.fail(new Error("Unknown Claude transcript queue operation: rewind"));
  await Bun.sleep(10);
  expect(f.shim.context().isIdle?.()).toBe(true);
  const next: ClaudeHookReply = await f.shim.hook(ups("again", "p2"));
  expect(next).toMatchObject({ decision: "block" });
  expect(String(next.reason)).toContain("Unknown Claude transcript queue operation: rewind");
  expect(f.kinds().slice(before)).toEqual([]);
  expect(f.shim.context().isIdle?.()).toBe(true);
});

test("every ledger failure is logged and the first one stays the blocking reason", async () => {
  const f = await employeeFixture(defaults);
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => { written.push(String(chunk)); return true; };
  try {
    f.shim.fail(new Error("first failure"));
    f.shim.fail(new Error("second failure"));
  } finally { process.stderr.write = write; }
  expect(written.filter((line) => line.includes("first failure"))).toHaveLength(1);
  expect(written.filter((line) => line.includes("second failure"))).toHaveLength(1);
  expect(JSON.stringify(await f.shim.hook(pre("Bash", "", "")))).toContain("Startup transcript ledger failed: first failure");
});

test("a dequeue without a matching enqueue fails the ledger instead of clamping", async () => {
  const f = await employeeFixture(defaults);
  await f.shim.ledger({ kind: "queue", delta: 1 });
  await f.shim.ledger({ kind: "queue", delta: -1 });
  expect(await f.shim.hook(pre("Bash", "", ""))).toEqual({});
  await f.shim.ledger({ kind: "queue", delta: -1 });
  expect(JSON.stringify(await f.shim.hook(pre("Bash", "", "")))).toContain("queue removal without a matching enqueue (queued 0)");
});

test("a throwing tool_call handler denies the tool as OMP does", async () => {
  const f = await employeeFixture(defaults);
  f.shim.host.on("tool_call", () => { throw new Error("boom"); });
  expect(await f.shim.hook(pre("Bash", "", ""))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Startup tool_call handler failed: boom" } });
});

test("a /startup line folded into a running turn is receipted once", async () => {
  const f = await employeeFixture(defaults);
  await f.shim.hook(ups("go", "p1"));
  await f.shim.ledger({ kind: "human", id: "row-1", promptId: "p1", text: "go", images: [] });
  await f.shim.hook(ups("/startup -- also this", "p1"));
  await f.shim.ledger({ kind: "human", id: "queued-1", promptId: null, text: "/startup -- also this", images: [] });
  expect(f.commands.filter((command) => z.object({ kind: z.literal("receive") }).safeParse(command).success).map((command) => z.object({ raw: z.object({ text: z.string() }) }).parse(command).raw.text)).toEqual(["go", "/startup -- also this"]);
  await f.shim.ledger({ kind: "human", id: "queued-2", promptId: null, text: "/startup -- also this", images: [] });
  expect(f.kinds().filter((kind) => kind === "receive")).toHaveLength(3);
});

test("human transcript rows are receipted with images and human prompts clear a provider pause before admission", async () => {
  const f = await employeeFixture(defaults);
  const image: Json = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  await f.shim.ledger({ kind: "human", id: "row-1", promptId: "p7", text: "look at this", images: [image] });
  expect(f.commands.at(-1)).toMatchObject({ kind: "receive", id: "row-1", source: "interactive", raw: { text: "look at this", images: [image] } });
  await f.shim.hook(ups("go", "p1"));
  await f.shim.hook({ event: "StopFailure", error: "overloaded" });
  const wake: ClaudeHookReply = await f.shim.hook(ups("<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>", "p2"));
  expect(wake).toMatchObject({ decision: "block" });
  const before: number = f.commands.length;
  const human: ClaudeHookReply = await f.shim.hook(ups("the provider is fixed, continue", "p3"));
  expect(human).not.toHaveProperty("decision");
  expect(f.kinds().slice(before)).toContain("begin_turn");
});

test("display messages reach the pane as systemMessage and every message reaches the model", async () => {
  const f = await employeeFixture(defaults);
  f.shim.host.sendMessage({ customType: "startup-visible", content: "VISIBLE NOTE", display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
  f.shim.host.sendMessage({ customType: "startup-hidden", content: "HIDDEN NOTE", display: false }, { triggerTurn: true, deliverAs: "nextTurn" });
  const reply: ClaudeHookReply = await f.shim.hook(ups("go", "p1"));
  expect(reply.systemMessage).toBe("VISIBLE NOTE");
  expect(context(reply)).toBe("LIVE STATE A\n\nVISIBLE NOTE\n\nHIDDEN NOTE");
  expect(context(await f.shim.hook({ event: "PostToolUse", tool: "Bash", agentId: "" }))).toBeNull();
});

test("StopFailure pauses inference and ends the open turn", async () => {
  const f = await employeeFixture(defaults);
  await f.shim.hook(ups("go", "p1"));
  const before: number = f.commands.length;
  expect(await f.shim.hook({ event: "StopFailure", error: "server_error" })).toEqual({});
  expect(f.kinds().slice(before)).toEqual(["end_turn"]);
  expect(f.shim.context().isIdle?.()).toBe(true);
  const wake: ClaudeHookReply = await f.shim.hook(ups("<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>", "p2"));
  expect(String(wake.reason)).toContain("Startup inference paused after a provider error");
});

test("the format guard blocks tools when a started turn writes no transcript row", async () => {
  const f = await employeeFixture({ ...defaults, formatGuardMs: 60 });
  await f.shim.hook(ups("go", "p1"));
  await f.shim.ledger({ kind: "turn_row", promptId: "p1" });
  await f.shim.ledger({ kind: "end", marker: "turn_duration" });
  await f.shim.hook(ups("again", "p2"));
  await f.shim.ledger({ kind: "human", id: "row-2", promptId: "p2", text: "again", images: [] });
  await f.shim.ledger({ kind: "end", marker: "turn_duration" });
  await Bun.sleep(120);
  expect(await f.shim.hook(pre("Bash", "", ""))).toEqual({});
  await f.shim.hook(ups("drifted", "p3"));
  await Bun.sleep(120);
  const blocked: ClaudeHookReply = await f.shim.hook(pre("Bash", "", ""));
  expect(blocked).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(JSON.stringify(blocked)).toContain("wrote no row for prompt p3 within 60ms");
  expect(String((await f.shim.hook({ event: "PostToolUse", tool: "Bash", agentId: "" })).systemMessage)).toContain("Startup transcript ledger failed");
});

test("manager /startup new boots inside UserPromptSubmit through the unchanged V7 entry", async () => {
  const f = coordinatorFixture();
  const cwd: string = join(f.root, "repo");
  mkdirSync(cwd);
  const transcript: string = join(f.root, "manager.jsonl");
  const environment: Readonly<Record<string, string>> = { HERDR_ENV: "1", HERDR_SESSION: "fixture", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", STARTUP_EXECUTION_LIMIT: "4", JP_SKILLS_HOME: f.skillsHome, STARTUP_ROOT: f.startupRoot, CLAUDE_CONFIG_DIR: f.startupRoot };
  const shim: ClaudeHost = createClaudeHost({ sessionId, cwd, instructions: null, transcript: () => transcript, formatGuardMs: 10000 });
  cleanup.push(() => shim.shutdown());
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(shim.host, {
    skillsHome: f.skillsHome, startupRoot: null, configHome: f.configHome, skillsRoot: f.skillsRoot, environment, harness: "claude", root: claudeRoot({ sessionId, transcript: () => transcript }),
    integration: () => "/fixture/claude/hooks/herdr-agent-state.sh",
    nativeLimit: () => { throw new Error("Claude has no native limit"); },
    launch: async (config) => { launched.push(config); return { ...config, socketPath: f.socketPath }; },
  });
  await shim.start();
  expect(launched).toHaveLength(0);
  const reply: ClaudeHookReply = await shim.hook(ups("/startup new claudeco", "p1"));
  expect(reply).not.toHaveProperty("decision");
  expect(launched[0]).toMatchObject({ harness: "claude", name: "claudeco", managerSession: sessionId, managerFile: transcript, managerPaneId: "w1:p1" });
  expect(launched[0]?.policy.executionLimit).toBe(4);
  expect(f.admissions[0]).toMatchObject({ nativeSession: sessionId, paneId: "w1:p1" });
  expect(f.kinds()).toEqual(["receive", "route", "staff", "begin_turn", "begin_turn"]);
  expect(f.commands[0]).toMatchObject({ source: "interactive", raw: { text: "/startup new claudeco", images: [] } });
  expect(reply.systemMessage).toBe(JSON.stringify({ accepted: true }));
  expect(existsSync(join(realpathSync(cwd), "CLAUDE.md"))).toBe(false);
  expect(existsSync(join(f.startupRoot, "binding.json"))).toBe(true);
  await shim.ledger({ kind: "human", id: "row-1", promptId: "p1", text: "/startup new claudeco", images: [] });
  expect(f.kinds().filter((kind) => kind === "receive")).toHaveLength(1);
  await shim.ledger({ kind: "end", marker: "turn_duration" });
  const failed: ClaudeHookReply = await shim.hook(ups("/startup select missing", "p2"));
  expect(failed).toMatchObject({ decision: "block" });
  expect(String(failed.reason)).toContain("Startup V7 boot blocked");
  expect(existsSync(transcript)).toBe(false);
});

test("the JSON Schema builder emits strict objects and anyOf unions", () => {
  const b = jsonSchemaBuilder();
  const item = b.object({ action: b.literal("assign"), ids: b.array(b.string()) }).or(b.object({ action: b.enum(["qa", "gate"]), count: b.number(), evidence: b.unknown() }));
  expect(item.toJsonSchema()).toEqual({ anyOf: [
    { type: "object", properties: { action: { type: "string", const: "assign" }, ids: { type: "array", items: { type: "string" } } }, required: ["action", "ids"], additionalProperties: false },
    { type: "object", properties: { action: { type: "string", enum: ["qa", "gate"] }, count: { type: "number" }, evidence: {} }, required: ["action", "count", "evidence"], additionalProperties: false },
  ] });
  expect(() => b.array({ type: "string" })).toThrow("Claude JSON Schema builder");
});
