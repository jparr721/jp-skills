import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Context, ToolCall } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";

const loop: string = [
  "You are a hired Startup employee running the canonical loop.",
  "At each wake, read your own assigned inbox cue and saved checkpoint.",
  "Perform the next action authorized by the manager under your canonical role.",
  "Send questions, concerns and required decisions to the manager inbox.",
  "Return the required result and checkpoint through the inbox completion contract.",
  "After an assignment or monitoring cycle finishes, return to the loop's waiting state.",
  "Use native wait when a real wake source exists; otherwise checkpoint and yield",
  "so OMP can idle or park this turn and the runtime can wake the next one.",
  "Continue employment until explicit retirement or Startup shutdown.",
].join("\n");

function requiredEnv(name: string): string {
  const value: string | undefined = process.env[name];
  if (!value) throw new Error(`Missing isolated probe environment variable: ${name}`);
  return value;
}

function record(value: unknown): void {
  appendFileSync(requiredEnv("STARTUP_PROBE_EVENTS"), `${JSON.stringify(value)}\n`);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pause(ctx: ExtensionContext, ms: number): Promise<void> {
  return new Promise<void>(resolve => { ctx.setTimeout(resolve, ms); });
}

function contextText(context: Context): string {
  return `${JSON.stringify(context.systemPrompt)}\n${JSON.stringify(context.messages)}`;
}

export default function nativeFeasibility(pi: ExtensionAPI): void {
  const role: string = readFileSync(requiredEnv("STARTUP_PROBE_ROLE"), "utf8");
  const registry: ReturnType<typeof pi.pi.AgentRegistry.global> = pi.pi.AgentRegistry.global();
  const lifecycle: AgentLifecycleManager = AgentLifecycleManager.global();
  const z: ExtensionAPI["zod"] = pi.zod;
  const nativeBatch = z.object({
    context: z.string(),
    tasks: z.array(z.object({
      name: z.string().optional(), agent: z.string().optional(), task: z.string(),
      solutionSpace: z.string(), outputSchema: z.unknown().optional(),
      schemaMode: z.enum(["permissive", "strict"]).optional(),
      tools: z.array(z.string()).optional(), isolated: z.boolean().optional(),
      effort: z.enum(["lo", "med", "hi"]).optional(),
    })),
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind === "sub") await pi.setActiveTools(["read", "yield"]);
    record({ kind: "tool_policy", actor: ctx.agent, activeTools: pi.getActiveTools() });
  });
  pi.on("before_agent_start", (_event, ctx) => {
    record({ kind: "before_agent_start", actor: ctx.agent, sessionId: ctx.sessionManager.getSessionId() });
  });
  pi.on("before_subagent_spawn", (event, ctx) => {
    record({ kind: "before_subagent_spawn", event, actor: ctx.agent, sessionId: ctx.sessionManager.getSessionId() });
    return { model: "startup-probe/offline" };
  });
  pi.on("context", (event, ctx) => {
    const marker: string = `STARTUP_NATIVE_ACTOR=${ctx.agent.id}\n`;
    record({ kind: "context_hook", actor: ctx.agent, sessionId: ctx.sessionManager.getSessionId() });
    if (ctx.agent.kind === "main") return;
    return { messages: [{ role: "developer", content: `${marker}${role}\n${loop}`, timestamp: Date.now() }, ...event.messages] };
  });
  pi.on("tool_result", (event, ctx) => {
    record({ kind: "tool_result", actor: ctx.agent, toolName: event.toolName, isError: event.isError, content: event.content, details: event.details });
  });

  pi.registerProvider("startup-probe", {
    api: "startup-offline", apiKey: "offline-fixture-not-a-secret", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "offline", name: "Startup deterministic native gate", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 8192 }],
    streamSimple: (model, context) => {
      const text: string = contextText(context);
      const matched: RegExpMatchArray | null = text.match(/STARTUP_NATIVE_ACTOR=([^\\\n"]+)/);
      const id: string = matched ? matched[1] : "Main";
      const count: number = context.messages.filter(message => message.role === "assistant" && message.provider === "startup-probe").length + 1;
      record({ kind: "provider_context", id, count, model: `${model.provider}/${model.id}`,
        rolePresent: text.includes(JSON.stringify(role).slice(1, -1)), loopPresent: text.includes(JSON.stringify(loop).slice(1, -1)),
        roleHash: hash(role), loopHash: hash(loop), systemRolePresent: (context.systemPrompt ?? []).join("\n").includes(role.trim()), context });
      let call: ToolCall | undefined;
      let output: string = "Native probe root settled.";
      if (id === "Main" && !text.includes('"toolName":"task"')) {
        call = { type: "toolCall", id: `probe-task-${count}`, name: "task", arguments: {
          context: "Isolated offline acceptance fixture. Read health.json; mutations are unauthorized.",
          tasks: Array.from({ length: 6 }, (_, index) => ({ name: `gate-${index + 1}`, agent: "startup-probe-devops",
            task: "PROBE_ASSIGNMENT_INITIAL: check the assigned health fixture and return a checkpoint.", solutionSpace: "Read the local fixture only." })),
        } };
      } else if (id !== "Main") {
        if (count === 1) output = "Checkpoint ready. Intentionally omit yield to exercise the native synthetic reminder.";
        else if (count === 3) call = { type: "toolCall", id: `probe-write-${id}-${count}`, name: "write",
          arguments: { path: requiredEnv("STARTUP_PROBE_DENIED_PATH"), content: "unauthorized mutation" } };
        else if (count === 4) call = { type: "toolCall", id: `probe-task-denied-${id}-${count}`, name: "task",
          arguments: { context: "Forbidden delegation", tasks: [{ agent: "task", task: "Write denied-mutation.txt", solutionSpace: "Denied" }] } };
        else if (count === 2 || count >= 6 && count % 2 === 0) call = {
          type: "toolCall", id: `probe-read-${id}-${count}`, name: "read", arguments: { path: requiredEnv("STARTUP_PROBE_HEALTH") },
        };
        else call = { type: "toolCall", id: `probe-yield-${id}-${count}`, name: "yield", arguments: { data: { status: "NO_ACTION", checkpoint: `fixture-${count}`, target: "local-health", healthy: true } } };
      }
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [call] : [{ type: "text", text: output }], stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream: ReturnType<typeof createAssistantMessageEventStream> = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      if (call) {
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
      }
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });

  pi.registerTool({ name: "task", label: "Native feasibility task wrapper", description: "Preserve ordinary native task input.",
    parameters: nativeBatch,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (ctx.agent.kind !== "main") throw new Error("Only the native root may dispatch this probe batch");
      if (!ctx.invokeTool) throw new Error("Native task delegate is unavailable");
      record({ kind: "task_wrapper", actor: ctx.agent, params });
      const result = await ctx.invokeTool(params);
      record({ kind: "task_delegate_result", result });
      return result;
    },
  });

  pi.registerCommand("startup-native-probe", { description: "Run isolated offline native acceptance checks", handler: async (_args, ctx) => {
    const reportPath: string = requiredEnv("STARTUP_PROBE_REPORT");
    try {
      const root = registry.get(ctx.agent.id);
      if (!root?.session) throw new Error("Native root session missing");
      record({ kind: "root", actor: ctx.agent, sessionId: ctx.sessionManager.getSessionId(),
        registrySessionId: root.session.sessionManager.getSessionId(), sessionFile: root.session.sessionManager.getSessionFile(), version: pi.pi.VERSION,
        singleton: lifecycle.manages(registry) });
      const unsubscribe = registry.onChange(event => {
        record({ kind: "registry_event", type: event.type, id: event.ref.id, parentId: event.ref.parentId,
          status: event.ref.status, sessionId: event.ref.session?.sessionManager.getSessionId() ?? null,
          sessionFile: event.ref.sessionFile, lifecycle: event.ref.lifecycle });
      });
      const db: Database = new Database(":memory:");
      const sqlite = db.query("select 1 as value").get();
      db.close();
      let intervalTicks: number = 0;
      const timer = ctx.setInterval(() => { intervalTicks += 1; }, 10);
      await pause(ctx, 35);
      ctx.clearTimer(timer);
      record({ kind: "managed_timers", intervalTicks, sqlite });
      await root.session.prompt("PROBE_BOOTSTRAP: dispatch the ordinary six-item native batch.");
      const deadline: number = Date.now() + 45000;
      while (true) {
        const children = registry.list().filter(ref => ref.parentId === root.id);
        if (children.length === 6 && children.every(ref => ref.status === "idle")) break;
        if (Date.now() >= deadline) throw new Error(`Native batch did not settle: ${JSON.stringify(children.map(ref => ({ id: ref.id, status: ref.status })))}`);
        await pause(ctx, 20);
      }
      const children = registry.list().filter(ref => ref.parentId === root.id);
      const child = children[0];
      if (!child?.session || !child.sessionFile) throw new Error("Native child binding or transcript missing");
      const originalSession = child.session;
      const originalSessionId: string = originalSession.sessionManager.getSessionId();
      const nativeId: string = child.id;
      record({ kind: "batch_settled", children: children.map(ref => ({ id: ref.id, parentId: ref.parentId,
        sessionId: ref.session?.sessionManager.getSessionId(), sessionFile: ref.sessionFile, lifecycle: ref.lifecycle })) });
      await lifecycle.park(nativeId);
      if (registry.get(nativeId) !== child || child.status !== "parked" || child.session !== null) throw new Error("Native park did not retain the detached child ref");
      record({ kind: "parked", id: nativeId, originalSessionId, sessionFile: child.sessionFile });
      const write = root.session.getToolByName("write");
      if (!write) throw new Error("Native write wake tool unavailable");
      const wake = await write.execute("probe-wake-revived", { path: `agent://${nativeId}`, content: "PROBE_ASSIGNMENT_REVIVED: check health again and yield your checkpoint." });
      record({ kind: "wake_result", stage: "revived", id: nativeId, result: wake });
      const waitForSettlement = async (minimumCalls: number): Promise<void> => {
        const end: number = Date.now() + 30000;
        while ((registry.get(nativeId)?.session?.messages.filter(message => message.role === "assistant" && message.provider === "startup-probe").length ?? 0) < minimumCalls || registry.get(nativeId)?.status !== "idle") {
          if (Date.now() >= end) throw new Error(`Native wake did not settle for ${nativeId}: status=${registry.get(nativeId)?.status}`);
          await pause(ctx, 20);
        }
      };
      await waitForSettlement(7);
      const revived = registry.get(nativeId);
      if (revived !== child || !revived.session) throw new Error("Revival replaced the native child ref");
      record({ kind: "revived_settled", id: nativeId, originalSessionId, sessionId: revived.session.sessionManager.getSessionId(),
        sessionFile: revived.sessionFile, lifecycle: revived.lifecycle, changedSessionInstance: revived.session !== originalSession });
      const next = await write.execute("probe-wake-second", { path: `agent://${nativeId}`, content: "PROBE_ASSIGNMENT_SECOND: another assignment to the same employee. Read health and yield." });
      record({ kind: "wake_result", stage: "second", id: nativeId, result: next });
      await waitForSettlement(9);
      record({ kind: "second_assignment_settled", id: nativeId, sessionId: child.session?.sessionManager.getSessionId(), lifecycle: child.lifecycle });
      unsubscribe();
      writeFileSync(reportPath, JSON.stringify({ status: "COMPLETE", nativeId, children: children.map(ref => ref.id) }));
    } catch (error: unknown) {
      record({ kind: "probe_failure", error: error instanceof Error ? error.message : String(error) });
      writeFileSync(reportPath, JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error) }));
    } finally {
      ctx.shutdown();
    }
  } });
}
