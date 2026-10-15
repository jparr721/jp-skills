import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { installEmployeeToolGuard, type EmployeeClient, type EmployeePoll } from "../src/employee-client";
import type { Json } from "../src/contracts";

function env(name: string): string {
  const value: string | undefined = process.env[name];
  if (!value) throw new Error(`Missing V7 guard fixture environment: ${name}`);
  return value;
}
function record(value: unknown): void {
  appendFileSync(env("STARTUP_GUARD_EVENTS"), JSON.stringify(value) + "\n");
}

export default function guardProbe(pi: ExtensionAPI): void {
  installEmployeeToolGuard(pi);
  const stage: string = env("STARTUP_GUARD_STAGE");
  const role: string = readFileSync(env("STARTUP_GUARD_ROLE"), "utf8");
  const loop: string = readFileSync(env("STARTUP_GUARD_LOOP"), "utf8");
  let beginCount: number = 0;
  let providerCount: number = 0;
  let rootProviderCount: number = 0;
  const projection: string = `STARTUP_NATIVE_V7_GUARD\n${role}\n${loop}`;
  const client: EmployeeClient = {
    async request(command: Json): Promise<Json> {
      record({ kind: "client_request", command });
      if (command !== null && typeof command === "object" && !Array.isArray(command) && command.kind === "begin_turn") {
        beginCount += 1;
        if (stage === "denied" || stage === "negative" || stage === "synthetic-denied" && beginCount >= 2)
          throw new Error(`Fixture begin_turn denied at ${beginCount}`);
      }
      return { accepted: true };
    },
    async poll(): Promise<EmployeePoll> {
      record({ kind: "client_poll" });
      if (stage === "disconnected") throw new Error("Fixture coordinator connection failed");
      return { projection, pendingMessageIds: [], toolBlockReason: null, waitReason: null };
    },
    close(): void { record({ kind: "client_close" }); },
  };
  pi.on("before_subagent_spawn", () => ({ model: "startup-v7-guard/offline" }));
  pi.on("tool_result", (event, ctx) => record({ kind: "tool_result", actor: ctx.agent, name: event.toolName, error: event.isError, content: event.content }));
  pi.registerTool({
    name: "startup_guard_probe", label: "Startup guard sentinel", description: "Isolated native guard sentinel",
    parameters: pi.zod.object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      record({ kind: "sentinel_executed", actor: ctx.agent });
      return { content: [{ type: "text", text: "sentinel executed" }] };
    },
  });
  pi.registerProvider("startup-v7-guard", {
    api: "startup-v7-guard-offline", apiKey: "fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "offline", name: "Offline V7 guard fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 4096 }],
    streamSimple: (model, context) => {
      providerCount += 1;
      const helper: boolean = context.systemPrompt.join("\n").includes("HELPER_NATIVE_GUARD");
      if (!helper) rootProviderCount += 1;
      const text: string = context.systemPrompt.join("\n") + "\n" + context.messages.filter(message => message.role === "developer").map(message => message.content).join("\n");
      record({ kind: "provider", stage, helper, providerCount, rootProviderCount,
        roleComplete: text.includes(role), loopComplete: text.includes(loop),
        developerProjection: context.messages.some(message => message.role === "developer" && typeof message.content === "string" && message.content.includes(projection)),
        tools: context.tools?.map(tool => tool.name), projection: helper ? null : text,
        priorToolResults: context.messages.filter(message => message.role === "toolResult") });
      if (providerCount > 12) throw new Error("Bounded V7 guard provider exceeded 12 requests");
      let call: ToolCall | null = null;
      if (helper) {
        const hasResult: boolean = context.messages.some(message => message.role === "toolResult" && message.toolName === "startup_guard_probe");
        call = hasResult
          ? { type: "toolCall", id: `yield-${providerCount}`, name: "yield", arguments: { data: { complete: true } } }
          : { type: "toolCall", id: `sentinel-${providerCount}`, name: "startup_guard_probe", arguments: {} };
      } else if (stage === "admitted" && !context.messages.some(message => message.role === "toolResult" && message.toolName === "task")) {
        call = { type: "toolCall", id: "native-helper", name: "task", arguments: {
          context: "Isolated native helper guard check",
          tasks: [{ name: "guard-helper", agent: "v7-guard-helper", task: "Call startup_guard_probe once, then yield.", solutionSpace: "No employee authority." }],
        } };
      }
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [call] : [{ type: "text", text: "Guard fixture settled" }], stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
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
  pi.registerCommand("startup-v7-guards", {
    description: "Isolated compiled OMP V7 guard acceptance probe",
    handler: async (_args, ctx) => {
      let bridge: ReturnType<typeof import("../src/employee-client")["installEmployeeBridge"]> | null = null;
      try {
        const root = pi.pi.AgentRegistry.global().get(ctx.agent.id);
        if (!root?.session?.extensionRunner) throw new Error("Native root runner unavailable");
        record({ kind: "root", version: pi.pi.VERSION, actor: ctx.agent, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), abortAvailable: typeof ctx.abort === "function" });
        const module: typeof import("../src/employee-client") = await import(env("STARTUP_GUARD_MODULE"));
        bridge = module.installEmployeeBridge(pi, { client, ctx, intervalMs: 60000 });
        try { await root.session.prompt("Run the isolated V7 guard fixture."); }
        catch (error: unknown) { record({ kind: "prompt_error", error: error instanceof Error ? error.message : String(error) }); }
        record({ kind: "prompt_settled", beginCount, providerCount, rootProviderCount });
        if (stage === "admitted") {
          const deadline: number = Date.now() + 15000;
          while (true) {
            const children = pi.pi.AgentRegistry.global().list().filter(ref => ref.parentId === root.id);
            if (children.length === 1 && children.every(ref => ref.status === "idle")) {
              record({ kind: "helper_settled", children: children.map(ref => ({ id: ref.id, status: ref.status, sessionId: ref.session?.sessionManager.getSessionId() })) });
              break;
            }
            if (Date.now() >= deadline) throw new Error("Native helper failed to settle");
            await new Promise<void>(resolve => { ctx.setTimeout(resolve, 20); });
          }
        } else {
          for (const operation of [
            { name: "write", args: { path: env("STARTUP_GUARD_WRITE"), content: "unauthorized fixture mutation" } },
            { name: "bash", args: { command: `printf denied > '${env("STARTUP_GUARD_BASH")}'` } },
          ]) {
            const tool = root.session.getToolByName(operation.name);
            if (!tool) throw new Error(`Native ${operation.name} tool missing`);
            try { record({ kind: "mutation_result", name: operation.name, result: await tool.execute(`direct-${operation.name}`, operation.args) }); }
            catch (error: unknown) { record({ kind: "mutation_denied", name: operation.name, error: error instanceof Error ? error.message : String(error) }); }
          }
        }
        writeFileSync(env("STARTUP_GUARD_REPORT"), JSON.stringify({ status: "COMPLETE", stage, beginCount, providerCount, rootProviderCount }));
      } catch (error: unknown) {
        writeFileSync(env("STARTUP_GUARD_REPORT"), JSON.stringify({ status: "FAIL", stage, error: error instanceof Error ? error.message : String(error) }));
      } finally { bridge?.close(); ctx.shutdown(); }
    },
  });
}
