import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";
import type { EntryConfig } from "./v7";
import { executionOmpConfigRoot, executionSkillsHome, assertStartupPath, bootSelection, StartupBootError } from "./src/boot";
import { claudeHookInputSchema, claudeRoot, createClaudeHost, type ClaudeHost, type WaiterHandle } from "./src/claude-host";
import { priorEventCount, splitLines, TranscriptTail } from "./src/claude-ledger";
import { bridgeRequestSchema, startupRoot as selectedStartupRoot, waiterSocketPath } from "./src/claude-waiter";
import { jsonSchema, type Json } from "./src/contracts";
import { assertNativeTranscript, installLaunchedEmployeeWith, type Environment } from "./src/employee-entry";
import { integrationPath, launchRuntimeHost, readPrivateJson } from "./src/v7-launch";

const requestSchema = z.looseObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.unknown().optional() });
const initializeSchema = z.looseObject({ protocolVersion: z.string().min(1) });
const callSchema = z.looseObject({ name: z.string().min(1), arguments: z.record(z.string(), jsonSchema).optional() });
type SocketState = { buffer: string; waiter: WaiterHandle | null };

export function claudeEntryConfig(environment: Environment, sessionId: string, transcript: () => string | null): EntryConfig {
  return {
    skillsHome: executionSkillsHome(environment),
    startupRoot: environment.STARTUP_ROOT ?? null,
    skillsRoot: resolve(environment.STARTUP_SKILLS_ROOT ?? join(import.meta.dir, "../..")),
    environment, launch: launchRuntimeHost,
    harness: "claude", root: claudeRoot({ sessionId, transcript }), integration: integrationPath,
    nativeLimit: () => { throw new StartupBootError("Claude Code has no native root concurrency setting; set STARTUP_EXECUTION_LIMIT explicitly and retry Startup"); },
  };
}
export function bridgeInstructions(tools: readonly string[]): string {
  return `Startup V7 employee tools are deferred MCP tools on server startup. Before calling any of them, load them all with ToolSearch query "select:${tools.map((name) => `mcp__startup__${name}`).join(",")}". Use them only from the main session, never from subagents.`;
}
function listenDirectory(root: string, path: string): void {
  assertStartupPath(root, path, "directory");
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
    throw new StartupBootError(`Claude Startup waiter directory must be an owner-only directory, not a symlink: ${path}`);
}
function log(record: Readonly<Record<string, Json>>): void {
  process.stderr.write(JSON.stringify({ component: "startup-claude-bridge", ...record }) + "\n");
}
function write(message: Json): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}
async function answer(shim: ClaudeHost, sessionId: string, version: string, attach: (transcript: string) => Promise<void>, line: string): Promise<void> {
  let id: string | number | null = null;
  try {
    const request = requestSchema.parse(JSON.parse(line));
    if (request.id === undefined) return;
    id = request.id;
    if (request.method === "server/discover" || request.method === "ping") { write({ jsonrpc: "2.0", id, result: {} }); return; }
    if (request.method === "initialize") {
      const params = initializeSchema.parse(request.params);
      write({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "startup", version }, instructions: bridgeInstructions(shim.tools().map((tool) => tool.name)) } });
      return;
    }
    if (request.method === "tools/list") { write({ jsonrpc: "2.0", id, result: { tools: [...shim.tools()] } }); return; }
    if (request.method !== "tools/call") { write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } }); return; }
    const call = callSchema.parse(request.params);
    const args: Json = call.arguments ?? {};
    if (call.name === "hook") {
      const identity = z.looseObject({ sessionId: z.literal(sessionId) }).safeParse(args);
      if (!identity.success) {
        const error = new StartupBootError("Claude hook is missing the current native session identity; admission revoked");
        shim.fail(error);
        await shim.shutdown();
        throw error;
      }
      const { sessionId: _sessionId, ...payload } = identity.data;
      const lifecycle = z.strictObject({ event: z.literal("SessionStart"), transcript: z.string().min(1) }).safeParse(payload);
      if (lifecycle.success) { await attach(lifecycle.data.transcript); write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{}" }] } }); return; }
      if (z.strictObject({ event: z.literal("SessionEnd") }).safeParse(payload).success) {
        await shim.shutdown();
        write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{}" }] } });
        return;
      }
      const input = claudeHookInputSchema.parse(payload);
      if (input.event === "UserPromptSubmit") await attach(input.transcript);
      write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(await shim.hook(input)) }] } });
      return;
    }
    try {
      const result = await shim.callTool(call.name, args);
      write({ jsonrpc: "2.0", id, result: { content: [...result.content], isError: result.isError } });
    } catch (error: unknown) {
      write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true } });
    }
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    log({ level: "error", state: "request-failed", id, error: message });
    write({ jsonrpc: "2.0", id, error: { code: id === null ? -32700 : -32603, message } });
  }
}
async function serve(): Promise<void> {
  const environment: Environment = process.env;
  const sessionId: string = z.string().uuid().parse(environment.CLAUDE_CODE_SESSION_ID);
  const startupRoot: string = selectedStartupRoot(environment);
  const skillsHome: string = executionSkillsHome(environment);
  const manifest: string | undefined = environment.STARTUP_V7_MANIFEST;
  if (manifest !== undefined && !manifest.endsWith(".json")) throw new StartupBootError(`STARTUP_V7_MANIFEST must name a launch .json manifest: ${manifest}`);
  if (manifest !== undefined) {
    assertStartupPath(startupRoot, manifest, "file");
    const saved = z.object({ skillsHome: z.string().startsWith("/"), startupRoot: z.string().startsWith("/") }).parse(readPrivateJson(manifest));
    if (saved.skillsHome !== skillsHome || saved.startupRoot !== startupRoot)
      throw new StartupBootError("Claude employee manifest does not match JP_SKILLS_HOME and STARTUP_ROOT");
  } else {
    const selection = bootSelection({
      cwd: process.cwd(), skillsHome, startupRoot,
      skillsRoot: resolve(environment.STARTUP_SKILLS_ROOT ?? join(import.meta.dir, "../..")), host: hostname(),
      managerSession: sessionId, command: null, explicitName: environment.STARTUP_NAME ?? null, executionLimit: null,
    });
    if (selection === null || selection.startupRoot !== startupRoot)
      throw new StartupBootError("Claude manager bridge requires a selected persisted Startup root before opening its waiter socket");
  }
  const socketPath: string = waiterSocketPath({ startupRoot, sessionId });
  const socketDirectory: string = dirname(socketPath);
  for (const path of [join(startupRoot, "startup"), join(startupRoot, "startup", "claude"), socketDirectory]) {
    assertStartupPath(startupRoot, path, "directory");
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
        throw new StartupBootError(`Claude Startup waiter directory must be owner-only: ${path}`);
    }
  }
  const version: string = z.object({ version: z.string().min(1) }).parse(JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"))).version;
  let transcript: string | null = null;
  let tail: TranscriptTail | null = null;
  let started: Promise<void> | null = null;
  const shim: ClaudeHost = createClaudeHost({
    sessionId, cwd: process.cwd(), formatGuardMs: 10000, transcript: () => transcript,
    instructions: manifest === undefined ? null : readFileSync(manifest.replace(/\.json$/, ".prompt.md"), "utf8"),
  });
  if (manifest !== undefined) installLaunchedEmployeeWith(shim.host, manifest, claudeRoot({ sessionId, transcript: () => transcript }));
  else {
    Bun.plugin({ name: "startup-claude-omp-settings", setup(build): void {
      build.module("@oh-my-pi/pi-coding-agent/task/settings", () => ({ loader: "object", exports: { cfgTaskMaxConcurrency: { get: (): never => { throw new StartupBootError("OMP task settings are unavailable in Claude Code"); } } } }));
    } });
    const { installStartupV7 } = await import("./v7");
    installStartupV7(shim.host, claudeEntryConfig(environment, sessionId, () => transcript));
  }
  function attach(path: string): Promise<void> {
    if (transcript !== null) {
      if (transcript !== path) { shim.fail(new Error(`Claude transcript path changed from ${transcript} to ${path}; the Startup bridge serves one session`)); return shim.shutdown(); }
      return started ?? Promise.resolve();
    }
    assertNativeTranscript({ harness: "claude", startupRoot, ompConfigRoot: executionOmpConfigRoot(environment), sessionId, file: path });
    transcript = path;
    let skip: number;
    try { skip = priorEventCount(path); }
    catch (error: unknown) {
      // The shim now refuses every turn and tool with this cause; a hook error here would let the prompt through.
      shim.fail(error instanceof Error ? error : new Error(String(error)));
      started = Promise.resolve();
      return started;
    }
    tail = new TranscriptTail({ path, pollMs: 100, onError: shim.fail, onEvent: async (event) => {
      if (skip > 0) { skip -= 1; return; }
      await shim.ledger(event);
    } });
    started = shim.start();
    return started;
  }
  async function received(socket: Bun.Socket<SocketState>, line: string): Promise<void> {
    const request = bridgeRequestSchema.parse(JSON.parse(line));
    if (request.sessionId !== sessionId) { const error = new StartupBootError(`Claude hook session ${request.sessionId} does not belong to bridge session ${sessionId}`); shim.fail(error); await shim.shutdown(); throw error; }
    if ("event" in request) {
      await shim.hook({ event: "StopFailure", error: request.error });
      socket.end(JSON.stringify({ received: true }) + "\n");
      return;
    }
    if ("hook" in request) {
      socket.end(JSON.stringify({ reply: await shim.hook(request.hook) }) + "\n");
      return;
    }
    await attach(request.transcript);
    const handle: WaiterHandle = {
      fire: (text: string) => { socket.end(JSON.stringify({ fire: text }) + "\n"); },
      supersede: () => { socket.end(JSON.stringify({ superseded: true }) + "\n"); },
    };
    socket.data.waiter = handle;
    shim.armWaiter(handle);
    log({ level: "info", state: "waiter-armed" });
  }
  listenDirectory(startupRoot, socketDirectory);
  if (existsSync(socketPath)) throw new StartupBootError(`Claude Startup waiter socket already exists; reconcile its owner before retrying: ${socketPath}`);
  const listener = Bun.listen<SocketState>({ unix: socketPath, socket: {
    open(socket): void { socket.data = { buffer: "", waiter: null }; },
    data(socket, data: Buffer): void {
      socket.data.buffer += data.toString("utf8");
      const { lines, rest } = splitLines(socket.data.buffer);
      socket.data.buffer = rest;
      for (const line of lines) void received(socket, line).catch((error: unknown) => {
        const message: string = error instanceof Error ? error.message : String(error);
        log({ level: "error", state: "socket-request-failed", error: message });
        socket.end(JSON.stringify({ error: message }) + "\n");
      });
    },
    close(socket): void { if (socket.data.waiter !== null) shim.disarmWaiter(socket.data.waiter); },
  } });
  chmodSync(socketPath, 0o600);
  const socketOwner = lstatSync(socketPath);
  let closing: boolean = false;
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    tail?.close();
    await shim.shutdown();
    listener.stop(true);
    if (existsSync(socketPath)) {
      const current = lstatSync(socketPath);
      if (!current.isSocket() || current.dev !== socketOwner.dev || current.ino !== socketOwner.ino)
        throw new StartupBootError(`Claude Startup waiter socket ownership changed while running: ${socketPath}`);
      rmSync(socketPath);
    }
    process.exit(0);
  }
  process.on("SIGTERM", () => { void shutdown(); });
  let buffer: string = "";
  const decoder: TextDecoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    const { lines, rest } = splitLines(buffer + decoder.decode(chunk, { stream: true }));
    buffer = rest;
    for (const line of lines) {
      if (line.trim() === "") continue;
      void answer(shim, sessionId, version, attach, line);
    }
  }
  await shutdown();
}
if (import.meta.main) await serve().catch((error: unknown) => {
  log({ level: "error", state: "bridge-failed", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
