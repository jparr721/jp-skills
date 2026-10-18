import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HostAPI, SchemaBuilder } from "../index";
import type { NativeSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { StartupBootError } from "./boot";
import type { LedgerEvent } from "./claude-ledger";
import { jsonSchema, type Json } from "./contracts";
import type { NativeRoot, NativeRootFn } from "./employee-entry";
import type { NativeContext, NativeResult } from "./omp-adapter";

export type ClaudeHookInput =
  | Readonly<{ event: "UserPromptSubmit"; prompt: string; promptId: string; transcript: string }>
  | Readonly<{ event: "PreToolUse"; tool: string; query: string; agentId: string }>
  | Readonly<{ event: "PostToolUse"; tool: string; agentId: string }>
  | Readonly<{ event: "Stop"; active: string }>
  | Readonly<{ event: "StopFailure"; error: string }>;
export const claudeHookInputSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("UserPromptSubmit"), prompt: z.string(), promptId: z.string().min(1), transcript: z.string().startsWith("/") }),
  z.strictObject({ event: z.literal("PreToolUse"), tool: z.string().min(1), query: z.string(), agentId: z.string() }),
  z.strictObject({ event: z.literal("PostToolUse"), tool: z.string().min(1), agentId: z.string() }),
  z.strictObject({ event: z.literal("Stop"), active: z.string() }),
  z.strictObject({ event: z.literal("StopFailure"), error: z.string() }),
]);
export type ClaudeHookReply = Readonly<Record<string, Json>>;
export type WaiterHandle = Readonly<{ fire: (text: string) => void; supersede: () => void }>;
export type McpToolSpec = Readonly<{ name: string; description: string; inputSchema: Json }>;
export type McpCallResult = Readonly<{ content: readonly Json[]; isError: boolean }>;
export type ClaudeHost = Readonly<{
  host: HostAPI;
  context: () => NativeContext;
  hook: (input: ClaudeHookInput) => Promise<ClaudeHookReply>;
  ledger: (event: LedgerEvent) => Promise<void>;
  armWaiter: (waiter: WaiterHandle) => void;
  disarmWaiter: (waiter: WaiterHandle) => void;
  fail: (error: Error) => void;
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
  tools: () => readonly McpToolSpec[];
  callTool: (name: string, args: Json) => Promise<McpCallResult>;
}>;
export class ClaudeHostError extends Error {}
export class ClaudeTranscriptFormatError extends Error {}
type Handler = (event: unknown, ctx: NativeContext) => unknown;
type Tool = Parameters<HostAPI["registerTool"]>[0];
type Command = Parameters<HostAPI["registerCommand"]>[1];
type Outgoing = Readonly<{ content: string; display: boolean }>;
type Outcome = Readonly<{ value: unknown }> | Readonly<{ error: string }>;

const schemas: WeakMap<object, Json> = new WeakMap();
function jsonOf(schema: unknown): Json {
  const value: Json | undefined = typeof schema === "object" && schema !== null ? schemas.get(schema) : undefined;
  if (value === undefined) throw new ClaudeHostError("Startup tool parameter was not built by the Claude JSON Schema builder");
  return value;
}
function node(value: Json): NativeSchema {
  const created: NativeSchema = {
    or: (other: unknown) => node({ anyOf: [...z.object({ anyOf: z.array(jsonSchema) }).safeParse(value).data?.anyOf ?? [value], jsonOf(other)] }),
    and: (other: unknown) => node({ allOf: [value, jsonOf(other)] }),
    toJsonSchema: () => value,
  };
  schemas.set(created, value);
  return created;
}
export function jsonSchemaBuilder(): SchemaBuilder {
  return {
    object: (shape: Record<string, unknown>) => node({ type: "object", properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, jsonOf(value)])), required: Object.keys(shape), additionalProperties: false }),
    string: () => node({ type: "string" }),
    number: () => node({ type: "number" }),
    unknown: () => node({}),
    array: (schema: unknown) => node({ type: "array", items: jsonOf(schema) }),
    literal: (value: string) => node({ type: "string", const: value }),
    enum: (values: readonly string[]) => node({ type: "string", enum: [...values] }),
  };
}
export function claudeRoot(input: Readonly<{ sessionId: string; transcript: () => string | null }>): NativeRootFn {
  return async (_host: HostAPI, ctx: NativeContext): Promise<NativeRoot> => {
    if (typeof ctx.abort !== "function") throw new StartupBootError("Startup V7 requires the actual native abort capability before admission");
    if (ctx.agent.kind !== "main" || ctx.agent.id !== input.sessionId || ctx.sessionManager.getSessionId() !== input.sessionId)
      throw new StartupBootError("Startup admission requires the actual Claude Code root session named by CLAUDE_CODE_SESSION_ID");
    const file: string | null = input.transcript();
    if (file === null) throw new StartupBootError("Claude Code has not reported this session's transcript path to the Startup bridge yet");
    return { nativeSession: input.sessionId, file, lastAssistant: undefined };
  };
}
function unavailable(name: string): never {
  throw new ClaudeHostError(`The Claude Startup host does not provide ${name}`);
}
const stopReason: string = "Startup aborted this turn";
const taskNotification: RegExp = /^<task-notification>/;
const startupCommand: RegExp = /^\/startup(?: (.*))?$/s;

export function createClaudeHost(input: Readonly<{
  sessionId: string;
  cwd: string;
  instructions: string | null;
  transcript: () => string | null;
  formatGuardMs: number;
}>): ClaudeHost {
  const handlers: Map<string, Handler[]> = new Map();
  const tools: Map<string, Tool> = new Map();
  const commands: Map<string, Command> = new Map();
  const timers: Set<ReturnType<typeof setInterval>> = new Set();
  const guards: Map<string, ReturnType<typeof setTimeout>> = new Map();
  const consumed: Set<string> = new Set();
  const folded: string[] = [];
  let outbox: Outgoing[] = [];
  let waiter: WaiterHandle | null = null;
  // A triggerTurn message that found no armed waiter or a busy root; it fires once both allow it.
  let deferredWake: Outgoing | null = null;
  let turnOpen: boolean = false;
  let openPrompt: string | null = null;
  let staleEnds: number = 0;
  let inFlight: number = 0;
  let queued: number = 0;
  let wakeInFlight: boolean = false;
  let abortPending: boolean = false;
  let injected: string | null = null;
  let formatFailure: string | null = null;
  let stopped: boolean = false;
  function isIdle(): boolean {
    return !turnOpen && inFlight === 0 && !wakeInFlight;
  }
  function contextFor(agentId: string): NativeContext {
    return {
      agent: agentId === "" ? { id: input.sessionId, kind: "main" } : { id: agentId, kind: "subagent", parentId: input.sessionId },
      cwd: input.cwd,
      sessionManager: { getSessionId: () => input.sessionId, getSessionFile: () => input.transcript() ?? undefined },
      getSystemPrompt: () => [],
      abort: () => { if (!isIdle()) abortPending = true; },
      isIdle,
      hasPendingMessages: () => queued > 0 || wakeInFlight,
      setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> {
        const timer: ReturnType<typeof setInterval> = setInterval(callback, ms);
        timers.add(timer);
        return timer;
      },
      clearTimer(timer: ReturnType<typeof setInterval>): void { clearInterval(timer); timers.delete(timer); },
    };
  }
  const root: NativeContext = contextFor("");
  function log(record: Readonly<Record<string, Json>>): void {
    process.stderr.write(JSON.stringify({ component: "startup-claude-host", ...record }) + "\n");
  }
  async function outcomes(name: string, event: unknown, ctx: NativeContext): Promise<readonly Outcome[]> {
    const results: Outcome[] = [];
    for (const handler of handlers.get(name) ?? []) {
      try { results.push({ value: await handler(event, ctx) }); }
      catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        log({ level: "error", event: name, error: message });
        results.push({ error: message });
      }
    }
    return results;
  }
  async function emit(name: string, event: unknown, ctx: NativeContext): Promise<unknown[]> {
    return (await outcomes(name, event, ctx)).flatMap((outcome) => "value" in outcome ? [outcome.value] : []);
  }
  async function chain(name: string, key: "systemPrompt" | "messages", initial: readonly unknown[], ctx: NativeContext): Promise<readonly unknown[]> {
    let current: readonly unknown[] = initial;
    for (const handler of handlers.get(name) ?? []) {
      try {
        const parsed = z.object({ [key]: z.array(z.unknown()) }).safeParse(await handler({ [key]: current }, ctx));
        if (parsed.success) current = z.array(z.unknown()).parse(parsed.data[key]);
      } catch (error: unknown) { log({ level: "error", event: name, error: error instanceof Error ? error.message : String(error) }); }
    }
    return current;
  }
  async function liveState(ctx: NativeContext): Promise<string | null> {
    const messages: readonly unknown[] = await chain("context", "messages", [], ctx);
    const text: string = messages.flatMap((message) => {
      const parsed = z.object({ content: z.string() }).safeParse(message);
      return parsed.success ? [parsed.data.content] : [];
    }).join("\n");
    if (text.length === 0) return null;
    const hash: string = createHash("sha256").update(text).digest("hex");
    if (hash === injected) return null;
    injected = hash;
    return text;
  }
  function drain(keepHidden: boolean): readonly Outgoing[] {
    const drained: readonly Outgoing[] = keepHidden ? outbox.filter((message) => message.display) : outbox;
    outbox = keepHidden ? outbox.filter((message) => !message.display) : [];
    if (deferredWake !== null && !outbox.includes(deferredWake)) deferredWake = null;
    return drained;
  }
  function injection(event: "UserPromptSubmit" | "PostToolUse", state: string | null, messages: readonly Outgoing[]): ClaudeHookReply {
    const context: readonly string[] = [...(state === null ? [] : [state]), ...messages.map((message) => message.content)];
    const shown: readonly string[] = messages.filter((message) => message.display).map((message) => message.content);
    return {
      ...(context.length === 0 ? {} : { hookSpecificOutput: { hookEventName: event, additionalContext: context.join("\n\n") } }),
      ...(shown.length === 0 ? {} : { systemMessage: shown.join("\n\n") }),
    };
  }
  function wake(): void {
    if (deferredWake === null || waiter === null || !isIdle() || formatFailure !== null || stopped) return;
    const message: Outgoing = deferredWake;
    const current: WaiterHandle = waiter;
    deferredWake = null;
    waiter = null;
    outbox = outbox.filter((queued) => queued !== message);
    wakeInFlight = true;
    current.fire(message.content);
  }
  async function end(willContinue: boolean): Promise<void> {
    if (!turnOpen) return;
    turnOpen = false;
    await emit("agent_end", { willContinue }, root);
    wake();
  }
  function fail(error: Error): void {
    log({ level: "error", state: "transcript-ledger-failed", error: error.message });
    if (formatFailure !== null) return;
    formatFailure = error.message;
    void emit("session_shutdown", {}, root).catch((cause: unknown) => log({ level: "error", state: "authority-revocation-failed", error: String(cause) }));
    outbox.push({ content: `Startup transcript ledger failed; tools are blocked until this pane is relaunched: ${error.message}`, display: true });
    // Without a ledger no end marker can arrive, so the held execution slot is released now.
    void end(false);
  }
  function guard(promptId: string): void {
    guards.set(promptId, setTimeout(() => {
      guards.delete(promptId);
      fail(new ClaudeTranscriptFormatError(`Claude transcript wrote no row for prompt ${promptId} within ${input.formatGuardMs}ms; the transcript format is unsupported`));
    }, input.formatGuardMs));
  }
  function settle(promptId: string | null): void {
    if (promptId === null) return;
    const timer = guards.get(promptId);
    if (timer !== undefined) clearTimeout(timer);
    guards.delete(promptId);
  }
  function normalize(tool: string, query: string): string {
    if (tool.startsWith("mcp__startup__")) return tool.slice("mcp__startup__".length);
    const selected: readonly string[] = /^select:(.+)$/.exec(query)?.[1]?.split(",").map((name) => name.trim()) ?? [];
    if (tool === "ToolSearch" && selected.length > 0 && selected.every((name) => /^mcp__startup__startup_[a-z_]+$/.test(name))) return "startup_tool_search";
    return tool;
  }
  async function userPromptSubmit(prompt: string, promptId: string): Promise<ClaudeHookReply> {
    wakeInFlight = false;
    if (formatFailure !== null) return { decision: "block", reason: `Startup transcript ledger failed; relaunch this pane: ${formatFailure}` };
    // A folded prompt reuses the running promptId; a new promptId means the previous turn ended before its end marker was read.
    const opened: boolean = !turnOpen || promptId !== openPrompt;
    if (turnOpen && opened) staleEnds += 1;
    // A deferred wake reaches the model through this turn's context instead.
    deferredWake = null;
    turnOpen = true;
    openPrompt = promptId;
    const command = startupCommand.exec(prompt);
    let handled: boolean = false;
    if (command !== null) {
      if (opened) consumed.add(promptId);
      else folded.push(prompt);
      const results: unknown[] = await emit("input", { text: prompt, source: "interactive", images: [] }, root);
      handled = results.some((result) => z.object({ handled: z.literal(true) }).safeParse(result).success);
      const startup: Command | undefined = commands.get("startup");
      if (!handled && startup !== undefined) await startup.handler(command[1] ?? "", root);
    } else if (!taskNotification.test(prompt)) await emit("input_submitted", { text: prompt, source: "interactive" }, root);
    if (opened && !abortPending && !handled) {
      const systemPrompt: readonly unknown[] = await chain("before_agent_start", "systemPrompt", [], root);
      if (input.instructions !== null && !abortPending && (systemPrompt.length !== 1 || systemPrompt[0] !== input.instructions)) {
        outbox.push({ content: "Startup refused this turn: the Startup role prompt differs from this pane's --append-system-prompt-file launch prompt. Relaunch the employee.", display: true });
        abortPending = true;
      }
    }
    const state: string | null = abortPending || handled ? null : await liveState(root);
    if (abortPending || handled) {
      abortPending = false;
      injected = null;
      if (opened) await end(false);
      const shown: readonly Outgoing[] = drain(true);
      return { decision: "block", reason: shown.length === 0 ? stopReason : shown.map((message) => message.content).join("\n\n") };
    }
    if (opened) guard(promptId);
    return injection("UserPromptSubmit", state, drain(false));
  }
  async function preToolUse(tool: string, query: string, agentId: string): Promise<ClaudeHookReply> {
    const ctx: NativeContext = agentId === "" ? root : contextFor(agentId);
    const results: readonly unknown[] = (await outcomes("tool_call", { toolName: normalize(tool, query), input: {} }, ctx))
      .map((outcome) => "value" in outcome ? outcome.value : { block: true, reason: `Startup tool_call handler failed: ${outcome.error}` });
    const blocked = results.map((result) => z.object({ block: z.literal(true), reason: z.string() }).safeParse(result)).find((result) => result.success)?.data;
    const reason: string | null = blocked?.reason ?? (formatFailure === null ? null : `Startup transcript ledger failed: ${formatFailure}`);
    const stop: boolean = agentId === "" && abortPending;
    if (stop) abortPending = false;
    return {
      ...(reason === null ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
      ...(stop ? { continue: false, stopReason } : {}),
    };
  }
  async function postToolUse(agentId: string): Promise<ClaudeHookReply> {
    if (agentId !== "") return {};
    const state: string | null = await liveState(root);
    if (abortPending) { abortPending = false; return { continue: false, stopReason }; }
    return injection("PostToolUse", state, drain(false));
  }
  async function stop(): Promise<ClaudeHookReply> {
    if (abortPending) { abortPending = false; return {}; }
    const results: unknown[] = await emit("session_stop", { last_assistant_message: null }, root);
    const reasons: readonly string[] = results.flatMap((result) => {
      const parsed = z.object({ continue: z.literal(true), additionalContext: z.string() }).safeParse(result);
      return parsed.success ? [parsed.data.additionalContext] : [];
    });
    return reasons.length === 0 ? {} : { decision: "block", reason: reasons.join("\n") };
  }
  async function hook(event: ClaudeHookInput): Promise<ClaudeHookReply> {
    if (stopped) throw new ClaudeHostError("Claude Startup host is shut down");
    inFlight += 1;
    try {
      if (event.event === "UserPromptSubmit") return await userPromptSubmit(event.prompt, event.promptId);
      if (event.event === "PreToolUse") return await preToolUse(event.tool, event.query, event.agentId);
      if (event.event === "PostToolUse") return await postToolUse(event.agentId);
      if (event.event === "Stop") return await stop();
      await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: event.error } }, root);
      return {};
    } finally {
      inFlight -= 1;
      if (event.event === "StopFailure") await end(queued > 0);
      wake();
    }
  }
  async function ledger(event: LedgerEvent): Promise<void> {
    if (stopped) return;
    if (event.kind === "end") {
      if (staleEnds > 0) { staleEnds -= 1; return; }
      await end(queued > 0);
      return;
    }
    if (event.kind === "queue") {
      if (queued + event.delta < 0) { fail(new ClaudeTranscriptFormatError(`Claude transcript recorded a queue removal without a matching enqueue (queued ${queued})`)); return; }
      queued += event.delta;
      return;
    }
    if (event.kind === "compact") { injected = null; return; }
    if (event.kind === "turn_row") { settle(event.promptId); return; }
    settle(event.promptId);
    if (event.promptId !== null && consumed.delete(event.promptId)) return;
    const foldedIndex: number = event.promptId === null ? folded.indexOf(event.text) : -1;
    if (foldedIndex !== -1) { folded.splice(foldedIndex, 1); return; }
    await emit("input", { id: event.id, text: event.text, source: "interactive", images: event.images }, root);
  }
  const host: HostAPI = {
    get pi(): never { return unavailable("OMP pi internals"); },
    zod: jsonSchemaBuilder(),
    sendMessage(message, options): void {
      const outgoing: Outgoing = { content: message.content, display: message.display };
      outbox.push(outgoing);
      if (!options.triggerTurn) return;
      deferredWake = outgoing;
      wake();
    },
    get events(): never { return unavailable("OMP event channels"); },
    arktype: () => unavailable("arktype schemas"),
    on(name: string, handler: Handler): void {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: Tool): void {
      if (tools.has(tool.name)) throw new ClaudeHostError(`Startup tool ${tool.name} is already registered`);
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: Command): void {
      if (commands.has(name)) throw new ClaudeHostError(`Startup command ${name} is already registered`);
      commands.set(name, command);
    },
    getCommands: () => [...commands.keys()].map((name) => ({ name })),
    getAllTools: () => unavailable("native tool listing"),
  };
  return {
    host,
    context: () => root,
    hook,
    ledger,
    armWaiter(next: WaiterHandle): void {
      const previous: WaiterHandle | null = waiter;
      waiter = next;
      previous?.supersede();
      wake();
    },
    disarmWaiter(current: WaiterHandle): void {
      if (waiter === current) waiter = null;
    },
    fail,
    async start(): Promise<void> {
      await emit("session_start", {}, root);
    },
    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await emit("session_shutdown", {}, root);
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      for (const timer of guards.values()) clearTimeout(timer);
      guards.clear();
      waiter?.supersede();
      waiter = null;
    },
    tools(): readonly McpToolSpec[] {
      return [...tools.values()].map((tool) => {
        const schema: Json = jsonOf(tool.parameters);
        const object = z.object({ type: z.literal("object") }).safeParse(schema);
        return { name: tool.name, description: tool.description, inputSchema: object.success ? schema : { type: "object", ...z.record(z.string(), jsonSchema).parse(schema) } };
      });
    },
    async callTool(name: string, args: Json): Promise<McpCallResult> {
      if (stopped || formatFailure !== null) throw new ClaudeHostError(formatFailure ?? "Claude adapter is stopped");
      const tool: Tool | undefined = tools.get(name);
      if (tool === undefined) throw new ClaudeHostError(`Unknown Startup tool ${name}`);
      const result: NativeResult = await tool.execute(randomUUID(), args, undefined, undefined, root);
      if (stopped || formatFailure !== null) throw new ClaudeHostError("Claude lifecycle changed during tool invocation; outcome requires reconciliation");
      return { content: result.content.map((block) => jsonSchema.parse(block)), isError: result.isError ?? false };
    },
  };
}
