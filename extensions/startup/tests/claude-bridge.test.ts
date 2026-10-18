import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { bridgeInstructions, claudeEntryConfig } from "../claude-bridge";
import { managerLaunch } from "../claude-manager";
import { bootSelection, parseBootCommand, persistBinding, StartupBootError } from "../src/boot";
import { claudeSettings } from "../src/claude-launch";
import { ClaudeBridgeSocketError, ClaudeWaiterPathTooLongError, exchangeBridge, startupRoot, waiterSocketPath } from "../src/claude-waiter";
import { jsonSchema, type Json } from "../src/contracts";
import { loadProfile, profileText } from "../src/profiles";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sessionId: string = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
const bridgePath: string = resolve(import.meta.dir, "../claude-bridge.ts");
const waiterPath: string = resolve(import.meta.dir, "../src/claude-waiter.ts");
const eventPath: string = resolve(import.meta.dir, "../src/claude-event.ts");
const pretoolPath: string = resolve(import.meta.dir, "../src/claude-pretool.ts");
async function until(predicate: () => boolean, ms: number): Promise<void> {
  const deadline: number = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${ms}ms`);
    await Bun.sleep(20);
  }
}
function shortRoot(): string {
  const root: string = realpathSync(mkdtempSync("/tmp/cb-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function skills(root: string): string {
  const skillsRoot: string = join(root, "s");
  for (const role of ["manager", "dev"]) {
    mkdirSync(join(skillsRoot, "skills", `startup-role-${role}`), { recursive: true });
    writeFileSync(join(skillsRoot, "skills", `startup-role-${role}`, "SKILL.md"), `Complete canonical ${role} persona`);
  }
  mkdirSync(join(skillsRoot, "skills", "startup-loop"));
  writeFileSync(join(skillsRoot, "skills", "startup-loop", "SKILL.md"), "Complete canonical shared loop");
  return skillsRoot;
}
async function lines(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const decoder: TextDecoder = new TextDecoder();
  let buffer: string = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts: string[] = buffer.split("\n");
    buffer = parts.pop() ?? "";
    sink.push(...parts.filter((line) => line !== ""));
  }
}
function bridgeFixture(mode: "employee" | "manager") {
  const root: string = shortRoot();
  const skillsRoot: string = skills(root);
  const home: string = join(root, "jp-skills");
  mkdirSync(home, { mode: 0o700 });
  const startupRootPath: string = join(root, "state");
  mkdirSync(startupRootPath, { mode: 0o700 });
  const configHome: string = join(root, "xdg");
  mkdirSync(configHome, { mode: 0o700 });
  const repo: string = join(root, "repo");
  mkdirSync(repo, { mode: 0o700 });
  const socketPath: string = join(startupRootPath, "runtime.sock");
  const commands: Json[] = [];
  const admissions: Json[] = [];
  let pending: readonly string[] = [];
  const profile = loadProfile({ skillsRoot, role: "dev", employeeId: "dev-1", generation: 1 });
  const text: string = profileText(profile);
  const server = Bun.serve({ unix: socketPath, async fetch(request: Request): Promise<Response> {
    const path: string = new URL(request.url).pathname;
    if (path === "/admit") { admissions.push(z.json().parse(await request.json())); return Response.json({ connection: "private-connection" }); }
    if (path === "/poll") return Response.json({ projection: `${text}\nBRIDGE STATE`, pendingMessageIds: pending, toolBlockReason: null, waitReason: null });
    const command: Json = z.json().parse(await request.json());
    commands.push(command);
    if (z.object({ kind: z.literal("image") }).safeParse(command).success) return Response.json({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
    return Response.json({ accepted: true });
  } });
  cleanup.push(() => { server.stop(true); });
  mkdirSync(join(startupRootPath, "launches"), { mode: 0o700 });
  const manifest: string = join(startupRootPath, "launches", `${sessionId}.json`);
  writeFileSync(manifest, JSON.stringify({ socketPath, credential: "private-credential", source: profile.source, employeeId: "dev-1", generation: 1, profile: "default", harness: "claude", skillsHome: home, startupRoot: startupRootPath, skillsRoot }), { mode: 0o600 });
  writeFileSync(join(startupRootPath, "launches", `${sessionId}.prompt.md`), text, { mode: 0o600 });
  if (mode === "manager") {
    const selection = bootSelection({ cwd: repo, skillsHome: home, startupRoot: startupRootPath, configHome, skillsRoot, host: hostname(), managerSession: sessionId, command: parseBootCommand("new acme"), explicitName: null, executionLimit: null });
    if (selection === null) throw new Error("Missing manager Startup selection");
    persistBinding(selection);
  }
  const environment: Record<string, string> = { ...z.record(z.string(), z.string()).parse(JSON.parse(JSON.stringify(process.env))), CLAUDE_CODE_SESSION_ID: sessionId, JP_SKILLS_HOME: home, STARTUP_ROOT: startupRootPath, CLAUDE_CONFIG_DIR: startupRootPath, STARTUP_NAME: "acme", XDG_CONFIG_HOME: configHome, HERDR_PANE_ID: "w1:p3", STARTUP_SKILLS_ROOT: skillsRoot, ...(mode === "employee" ? { STARTUP_V7_MANIFEST: manifest } : {}) };
  if (mode === "manager") delete environment.STARTUP_V7_MANIFEST;
  const child = Bun.spawn([process.execPath, bridgePath], { cwd: repo, env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cleanup.push(() => { child.kill(); });
  const output: string[] = [];
  const errors: string[] = [];
  void lines(child.stdout, output);
  void lines(child.stderr, errors);
  async function rpc(message: Readonly<{ id: number | string; method: string; params: Json }>): Promise<Json> {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    child.stdin.flush();
    let found: Json | undefined;
    await until(() => {
      found = output.map((line) => jsonSchema.parse(JSON.parse(line))).find((reply) => z.object({ id: z.literal(message.id) }).safeParse(reply).success);
      return found !== undefined;
    }, 10000);
    return z.object({ jsonrpc: z.literal("2.0"), result: jsonSchema }).parse(found).result;
  }
  function spawnHook(path: string, input: Json) {
    const process = Bun.spawn([globalThis.process.execPath, path], { env: environment, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
    cleanup.push(() => { process.kill(); });
    return process;
  }
  return { root, home, startupRoot: startupRootPath, child, commands, admissions, errors, rpc, spawnHook, transcript: join(root, "t.jsonl"), setPending(value: readonly string[]): void { pending = value; } };
}
const hookText = (result: Json): Json => jsonSchema.parse(JSON.parse(z.object({ content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]) }).parse(result).content[0].text));

test("the stdio bridge completes the Claude Code 2.1.302 handshake and serves Startup tools and hooks", async () => {
  const f = bridgeFixture("employee");
  expect(await f.rpc({ id: "server-discover-probe-1", method: "server/discover", params: { _meta: {} } })).toEqual({});
  const initialized = z.object({ protocolVersion: z.string(), capabilities: jsonSchema, serverInfo: jsonSchema, instructions: z.string() }).parse(await f.rpc({ id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.302" } } }));
  expect(initialized.protocolVersion).toBe("2025-11-25");
  expect(initialized.capabilities).toEqual({ tools: {} });
  expect(initialized.serverInfo).toMatchObject({ name: "startup" });
  expect(initialized.instructions).toContain("select:mcp__startup__startup_claim,mcp__startup__startup_settle");
  f.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = z.object({ tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), jsonSchema) })) }).parse(await f.rpc({ id: 1, method: "tools/list", params: {} }));
  expect(listed.tools.map((tool) => tool.name)).toEqual(["startup_claim", "startup_settle", "startup_send", "startup_item", "startup_capture", "startup_staff", "startup_hire", "startup_delegate", "startup_activate", "startup_replace", "startup_intake", "startup_route", "startup_input", "startup_image", "startup_reconcile", "startup_resolve", "startup_finish_team", "startup_refresh", "startup_block", "startup_retire"]);
  for (const tool of listed.tools) expect(tool.inputSchema.type).toBe("object");
  expect(z.array(jsonSchema).length(6).safeParse(listed.tools.find((tool) => tool.name === "startup_item")?.inputSchema.anyOf).success).toBe(true);
  expect(listed.tools.find((tool) => tool.name === "startup_image")?.inputSchema).toEqual({ type: "object", properties: { inputId: { type: "string" }, index: { type: "number" } }, required: ["inputId", "index"], additionalProperties: false });
  const prompt = await f.rpc({ id: 2, method: "tools/call", params: { name: "hook", arguments: { event: "UserPromptSubmit", prompt: "inspect the screenshot", promptId: "p1", transcript: f.transcript } } });
  expect(f.admissions).toEqual([expect.objectContaining({ nativeSession: sessionId, paneId: "w1:p3" })]);
  expect(hookText(prompt)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "BRIDGE STATE" } });
  expect(await f.rpc({ id: 3, method: "tools/call", params: { name: "startup_image", arguments: { inputId: "input-1", index: 0 } } })).toEqual({ content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], isError: false });
  const wrong = z.object({ isError: z.literal(true), content: z.tuple([z.object({ text: z.string() })]) }).parse(await f.rpc({ id: 4, method: "tools/call", params: { name: "startup_image", arguments: { inputId: "input-1" } } }));
  expect(wrong.content[0].text).toContain("index");
  expect(hookText(await f.rpc({ id: 5, method: "tools/call", params: { name: "hook", arguments: { event: "PreToolUse", tool: "mcp__startup__startup_claim", query: "", agentId: "a61c2e8981c9b0f07" } } }))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Native helper has no Startup employee authority" } });
  f.child.stdin.end();
  expect(await f.child.exited).toBe(0);
  expect(existsSync(waiterSocketPath({ startupRoot: f.startupRoot, sessionId }))).toBe(false);
});

test("waiters supersede older waiters, fire the cue after the transcript ends the turn and StopFailure reaches the bridge", async () => {
  const f = bridgeFixture("employee");
  await f.rpc({ id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  const hookInput: Json = { session_id: sessionId, transcript_path: f.transcript, hook_event_name: "SessionStart" };
  const first = f.spawnHook(waiterPath, hookInput);
  await until(() => f.errors.filter((line) => line.includes("waiter-armed")).length === 1, 10000);
  expect(f.admissions).toHaveLength(1);
  expect(statSync(waiterSocketPath({ startupRoot: f.startupRoot, sessionId })).mode & 0o777).toBe(0o600);
  await f.rpc({ id: 1, method: "tools/call", params: { name: "hook", arguments: { event: "UserPromptSubmit", prompt: "go", promptId: "p1", transcript: f.transcript } } });
  const second = f.spawnHook(waiterPath, hookInput);
  expect(await first.exited).toBe(0);
  f.setPending(["m1"]);
  await Bun.sleep(1200);
  appendFileSync(f.transcript, JSON.stringify({ type: "user", promptId: "p1", uuid: "row-1", origin: { kind: "human" }, message: { role: "user", content: "go" } }) + "\n");
  appendFileSync(f.transcript, JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 10 }) + "\n");
  expect(await second.exited).toBe(2);
  expect(await new Response(second.stderr).text()).toContain("Startup inbox has 1 durable message(s)");
  expect(f.commands).toContainEqual(expect.objectContaining({ kind: "receive", source: "interactive", raw: { text: "go", images: [] } }));
  const event = f.spawnHook(eventPath, { session_id: sessionId, hook_event_name: "StopFailure", error: "rate_limit" });
  expect(await event.exited).toBe(0);
  const paused = hookText(await f.rpc({ id: 2, method: "tools/call", params: { name: "hook", arguments: { event: "UserPromptSubmit", prompt: "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>", promptId: "p2", transcript: f.transcript } } }));
  expect(JSON.stringify(paused)).toContain("Startup inference paused after a provider error");
  const stray = f.spawnHook(eventPath, { session_id: "7a1e04b8-6a0c-4bd1-9a64-2c3d2b1f0e11", error: "x" });
  expect(await stray.exited).toBe(1);
});

test("the PreToolUse command hook takes its decision from the bridge and the bridge answers rejected requests with an error", async () => {
  const f = bridgeFixture("employee");
  await f.rpc({ id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  await f.rpc({ id: 1, method: "tools/call", params: { name: "hook", arguments: { event: "UserPromptSubmit", prompt: "go", promptId: "p1", transcript: f.transcript } } });
  const helper = f.spawnHook(pretoolPath, { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "mcp__startup__startup_claim", tool_input: {}, agent_id: "a61c2e8981c9b0f07", agent_type: "general-purpose" });
  expect(await helper.exited).toBe(0);
  expect(JSON.parse(await new Response(helper.stdout).text())).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Native helper has no Startup employee authority" } });
  const search = f.spawnHook(pretoolPath, { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "ToolSearch", tool_input: { query: "select:mcp__startup__startup_claim", max_results: 1 } });
  expect(await search.exited).toBe(0);
  expect(JSON.parse(await new Response(search.stdout).text())).toEqual({});
  const stranger = await exchangeBridge({ path: waiterSocketPath({ startupRoot: f.startupRoot, sessionId }), request: { sessionId: "7a1e04b8-6a0c-4bd1-9a64-2c3d2b1f0e11", event: "StopFailure", error: "x" }, connectDeadlineMs: 0 });
  expect(stranger).toEqual({ error: `Claude hook session 7a1e04b8-6a0c-4bd1-9a64-2c3d2b1f0e11 does not belong to bridge session ${sessionId}` });
});

function fakeBridge(reply: string | null) {
  const root: string = shortRoot();
  const startupRoot: string = join(root, "state");
  mkdirSync(startupRoot, { mode: 0o700 });
  const path: string = waiterSocketPath({ startupRoot, sessionId });
  mkdirSync(join(startupRoot, "startup", "claude", "w"), { recursive: true, mode: 0o700 });
  const listener = Bun.listen<undefined>({ unix: path, socket: { data(socket): void { if (reply === null) socket.end(); else socket.end(reply + "\n"); } } });
  cleanup.push(() => { listener.stop(true); });
  return (script: string, input: Json) => {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, JP_SKILLS_HOME: "/skills", STARTUP_ROOT: startupRoot, CLAUDE_CONFIG_DIR: startupRoot }, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
    cleanup.push(() => { child.kill(); });
    return child;
  };
}
test.each([
  ["closes without a reply", null],
  ["answers with an error", JSON.stringify({ error: "Claude Startup host is shut down" })],
] as const)("hook shims fail when the bridge %s", async (_name: string, reply: string | null) => {
  const spawn = fakeBridge(reply);
  expect(await spawn(pretoolPath, { session_id: sessionId, tool_name: "Bash", tool_input: { command: "ls" } }).exited).toBe(1);
  expect(await spawn(eventPath, { session_id: sessionId, error: "rate_limit" }).exited).toBe(1);
});
test("the waiter fails on a bridge error reply and exits cleanly when the bridge closes", async () => {
  expect(await fakeBridge(JSON.stringify({ error: "Claude hook session mismatch" }))(waiterPath, { session_id: sessionId, transcript_path: "/fixture/t.jsonl" }).exited).toBe(1);
  expect(await fakeBridge(null)(waiterPath, { session_id: sessionId, transcript_path: "/fixture/t.jsonl" }).exited).toBe(0);
});

test("an unreadable existing transcript keeps the bridge failed with its real cause", async () => {
  const f = bridgeFixture("employee");
  writeFileSync(f.transcript, "{not json\n");
  await f.rpc({ id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  for (const id of [1, 2]) {
    const reply = hookText(await f.rpc({ id, method: "tools/call", params: { name: "hook", arguments: { event: "UserPromptSubmit", prompt: "go", promptId: `p${id}`, transcript: f.transcript } } }));
    expect(reply).toMatchObject({ decision: "block" });
    expect(JSON.stringify(reply)).toContain(`Claude transcript line is not JSON in ${f.transcript}`);
  }
  expect(f.admissions).toEqual([]);
  expect(f.errors.some((line) => line.includes("transcript-ledger-failed"))).toBe(true);
});

test("the manager bridge loads the unchanged V7 entry outside OMP and waits for /startup", async () => {
  const f = bridgeFixture("manager");
  const listed = z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(await f.rpc({ id: 1, method: "tools/list", params: {} }));
  expect(listed.tools).toHaveLength(20);
  const prompt = hookText(await f.rpc({ id: 2, method: "tools/call", params: { name: "hook", arguments: { event: "UserPromptSubmit", prompt: "hello", promptId: "p1", transcript: f.transcript } } }));
  expect(prompt).toEqual({});
  expect(f.admissions).toEqual([]);
  f.child.stdin.end();
  expect(await f.child.exited).toBe(0);
});

test("the waiter socket path uses the selected root and returns a typed error over 103 bytes", () => {
  const root = shortRoot();
  expect(startupRoot({ STARTUP_ROOT: root, CLAUDE_CONFIG_DIR: root, JP_SKILLS_HOME: "/skills" })).toBe(root);
  expect(() => startupRoot({ JP_SKILLS_HOME: "/tmp/legacy" })).toThrow("requires the selected STARTUP_ROOT");
  expect(waiterSocketPath({ startupRoot: root, sessionId })).toBe(join(root, "startup", "claude", "w", `${sessionId}.sock`));
  const longRoot: string = join(root, "x".repeat(48));
  mkdirSync(longRoot, { mode: 0o700 });
  let caught: unknown = null;
  try { waiterSocketPath({ startupRoot: longRoot, sessionId }); } catch (error: unknown) { caught = error; }
  expect(caught).toBeInstanceOf(ClaudeWaiterPathTooLongError);
  expect(caught).toBeInstanceOf(ClaudeBridgeSocketError);
  expect(caught).toMatchObject({ code: "STARTUP_CLAUDE_SOCKET_PATH_TOO_LONG" });
  expect(caught instanceof Error ? caught.message : "").toContain("exceeds 103 bytes");
});

test("the Claude entry config refuses an implicit execution limit and names every tool in its load instruction", () => {
  const root = shortRoot();
  const config = claudeEntryConfig({ JP_SKILLS_HOME: "/h", XDG_CONFIG_HOME: "/cfg", STARTUP_ROOT: root, CLAUDE_CONFIG_DIR: root, STARTUP_SKILLS_ROOT: "/s" }, sessionId, () => null);
  expect(config).toMatchObject({ skillsHome: "/h", startupRoot: root, configHome: "/cfg", skillsRoot: "/s", harness: "claude" });
  expect(() => config.nativeLimit({ agent: { id: sessionId, kind: "main" }, cwd: "/", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined }, getSystemPrompt: () => [], setInterval: setInterval, clearTimer: clearInterval })).toThrow("STARTUP_EXECUTION_LIMIT");
  expect(bridgeInstructions(["startup_claim", "startup_retire"])).toContain("ToolSearch query \"select:mcp__startup__startup_claim,mcp__startup__startup_retire\"");
});

function managerFixture() {
  const root: string = shortRoot();
  const skillsRoot: string = skills(root);
  const home: string = join(root, "jp-skills");
  mkdirSync(home, { mode: 0o700 });
  const configHome: string = join(root, "xdg");
  mkdirSync(configHome, { mode: 0o700 });
  const startupRoot: string = join(root, "state");
  mkdirSync(startupRoot, { mode: 0o700 });
  const repo: string = join(root, "repo");
  mkdirSync(repo);
  const claudeJson: string = join(startupRoot, ".claude.json");
  writeFileSync(claudeJson, JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
  chmodSync(claudeJson, 0o600);
  const hookDirectory = join(startupRoot, "hooks");
  mkdirSync(hookDirectory, { mode: 0o700 });
  const hook = join(hookDirectory, "herdr-agent-state.sh");
  writeFileSync(hook, "#!/bin/sh\n# HERDR_INTEGRATION_ID=claude\n# HERDR_INTEGRATION_VERSION=11\nset -eu\n", { mode: 0o600 });
  const hookSettings = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook }] }] } };
  writeFileSync(join(startupRoot, "settings.json"), JSON.stringify(hookSettings), { mode: 0o600 });
  const selection = bootSelection({ cwd: repo, skillsHome: home, startupRoot, configHome, skillsRoot, host: hostname(), managerSession: sessionId, command: parseBootCommand("new acme"), explicitName: null, executionLimit: null });
  if (selection === null) throw new Error("Missing fixture Startup selection");
  persistBinding(selection);
  const environment: Record<string, string> = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", STARTUP_NAME: "acme", STARTUP_ROOT: startupRoot, JP_SKILLS_HOME: home, CLAUDE_CONFIG_DIR: startupRoot, XDG_CONFIG_HOME: configHome };
  const config = {
    name: "acme", skillsHome: home, startupRoot, stateDirectory: startupRoot, boundRoot: repo, skillsRoot, socketPath: join(startupRoot, "runtime.sock"), profile: "default",
    managerSession: sessionId, managerFile: join(root, "manager.jsonl"), managerPaneId: "w1:p1", managerCredential: "private-credential",
    herdrSession: "fixture", workspaceId: "w1", herdrBinary: "herdr", herdrIntegration: "/fixture/herdr-agent-state.sh", ownerGeneration: 1,
    policy: { tickMs: 1000, paCadenceMs: 60000, progressDeadlineMs: 300000, connectionDeadlineMs: 30000, executionLimit: 4 },
  };
  const save = (value: Json): void => { writeFileSync(join(startupRoot, "runtime-config.json"), JSON.stringify(value), { mode: 0o600 }); };
  const input = { environment, cwd: repo, skillsHome: home, configHome, startupRoot, skillsRoot, bun: "/opt/bun" };
  return { root, home, startupRoot, repo, skillsRoot, claudeJson, config, save, input };
}

test("startup-claude starts a new manager session with the shared hooks, bridge and manager prompt", () => {
  const f = managerFixture();
  const args: readonly string[] = managerLaunch(f.input);
  const shared: string = join(f.startupRoot, "startup", "claude");
  expect(args[0]).toBe("--session-id");
  expect(args[1]).toBe(sessionId);
  expect(args.slice(2)).toEqual(["--append-system-prompt-file", join(shared, "manager.prompt.md"), "--settings", join(shared, "settings.json"), "--mcp-config", join(shared, "mcp.json"), "-n", "startup-manager"]);
  expect(readFileSync(join(shared, "manager.prompt.md"), "utf8")).toBe(profileText(loadProfile({ skillsRoot: f.skillsRoot, role: "manager", employeeId: "manager", generation: 1 })));
  expect(statSync(join(shared, "manager.prompt.md")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(shared, "settings.json"), "utf8")).toBe(JSON.stringify(claudeSettings({ bun: "/opt/bun", skillsRoot: f.skillsRoot })));
  expect(managerLaunch(f.input)[1]).toBe(args[1]);
  writeFileSync(join(shared, "manager.prompt.md"), "edited");
  chmodSync(join(shared, "manager.prompt.md"), 0o600);
  expect(() => managerLaunch(f.input)).toThrow("manager prompt differs");
});

test("startup-claude resumes only a saved Claude manager in its own pane", () => {
  const f = managerFixture();
  f.save({ ...f.config, harness: "claude" });
  expect(managerLaunch(f.input).slice(0, 2)).toEqual(["--resume", sessionId]);
  expect(() => managerLaunch({ ...f.input, environment: { ...f.input.environment, HERDR_PANE_ID: "w1:p9" } })).toThrow("belongs to Herdr pane w1:p1");
  f.save(f.config);
  expect(() => managerLaunch(f.input)).toThrow("is bound to OMP");
});

test.each([
  ["outside Herdr", { HERDR_ENV: "0" }, "inside a Herdr pane"],
  ["untrusted root", {}, "has not accepted workspace trust"],
] as const)("startup-claude refuses to launch %s", (_name, environment, message) => {
  const f = managerFixture();
  if (message.includes("trust")) writeFileSync(f.claudeJson, JSON.stringify({ projects: { "/elsewhere": { hasTrustDialogAccepted: true } } }));
  expect(() => managerLaunch({ ...f.input, environment: { ...f.input.environment, ...environment } })).toThrow(StartupBootError);
  expect(() => managerLaunch({ ...f.input, environment: { ...f.input.environment, ...environment } })).toThrow(message);
  expect(existsSync(join(f.startupRoot, "startup", "claude"))).toBe(false);
});
