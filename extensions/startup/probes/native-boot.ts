import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing boot fixture ${name}`);
  return value;
}
function record(value: unknown): void {
  appendFileSync(env("STARTUP_BOOT_EVENTS"), JSON.stringify(value) + "\n");
}
export default function bootProof(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    record({
      kind: "start",
      version: pi.pi.VERSION,
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(),
      onDisk: existsSync(ctx.sessionManager.getSessionFile() ?? ""),
    });
    if (process.env.STARTUP_BOOT_FAILURE === "1" && ctx.agent.kind === "main") {
      const runner = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session
        ?.extensionRunner;
      if (!runner)
        throw new Error("Native extension runner missing for failure proof");
      const input = await runner.emitInput(
        "ordinary work must be handled",
        [],
        "rpc",
      );
      const tool = await runner.emitToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "boot-denied",
        input: { path: "never-read" },
      });
      const stop = await runner.emitSessionStop({
        messages: [],
        turn_id: 0,
        session_id: ctx.sessionManager.getSessionId(),
        stop_hook_active: false,
        signal: new AbortController().signal,
      });
      record({ kind: "failure-guards", input, tool, stop });
    }
  });
  pi.on("before_subagent_spawn", () => ({ model: "startup-boot/offline" }));
  pi.on("tool_result", (event, ctx) =>
    record({
      kind: "tool",
      actor: ctx.agent.id,
      name: event.toolName,
      error: event.isError,
      details: event.details,
      content: event.content,
    }),
  );
  pi.on("session_stop", (_event, ctx) =>
    record({ kind: "stop", actor: ctx.agent.id }),
  );
  pi.registerCommand("startup-boot-inspect", {
    description: "Isolated boot evidence",
    handler: async (_args, ctx) => {
      const root = pi.pi.AgentRegistry.global().get(ctx.agent.id);
      const staff = root?.session?.getToolByName("startup_staff");
      record({
        kind: "inspect",
        cwd: ctx.cwd,
        version: pi.pi.VERSION,
        sessionId: ctx.sessionManager.getSessionId(),
        file: ctx.sessionManager.getSessionFile(),
        onDisk: existsSync(ctx.sessionManager.getSessionFile() ?? ""),
        tools: pi.getAllTools().map((tool) => tool.name),
        staff: staff ? await staff.execute("boot-inspect", {}) : null,
      });
    },
  });
  pi.registerProvider("startup-boot", {
    api: "startup-boot-offline",
    apiKey: "fixture",
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id: "offline",
        name: "Offline boot proof",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 8192,
      },
    ],
    streamSimple: (model, context) => {
      const projection = context.messages.findLast(
        (message) =>
          message.role === "developer" &&
          typeof message.content === "string" &&
          message.content.startsWith("STARTUP_BINDING="),
      );
      const text =
        projection && typeof projection.content === "string"
          ? projection.content
          : context.systemPrompt.join("\n");
      const line = (prefix: string) => {
        const value = text.split("\n").find((part) => part.startsWith(prefix));
        return value ? JSON.parse(value.slice(prefix.length)) : null;
      };
      const binding = line("STARTUP_BINDING=");
      const cue = line("STARTUP_CUE=");
      const role =
        binding?.employeeId === "manager"
          ? "manager"
          : context.systemPrompt
              .join("\n")
              .match(/name: startup-role-([a-z]+)/)?.[1];
      record({
        kind: "provider",
        binding,
        role,
        roleComplete: role
          ? text.includes(
              readFileSync(
                join(
                  env("STARTUP_BOOT_SOURCES"),
                  "skills",
                  `startup-role-${role}`,
                  "SKILL.md",
                ),
                "utf8",
              ),
            )
          : false,
        loopComplete: text.includes(
          readFileSync(
            join(env("STARTUP_BOOT_SOURCES"), "skills/startup-loop/SKILL.md"),
            "utf8",
          ),
        ),
        guidance: existsSync(join(env("STARTUP_BOOT_BOUND"), "AGENTS.md")),
        sourceText: projection ? null : context.systemPrompt,
      });
      const results = context.messages.filter(
        (message) => message.role === "toolResult" && !message.isError,
      );
      const result = (name: string) =>
        results.findLast((message) => message.toolName === name);
      const parsed = (name: string) => {
        const message = result(name);
        const content = message?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        return content ? JSON.parse(content) : null;
      };
      const sequence = context.messages.length;
      if (sequence > 100)
        throw new Error("Bounded native boot fixture exceeded 100 messages");
      let call: ToolCall | null = null;
      const invoke = (
        name: string,
        args: Record<string, unknown>,
      ): ToolCall => ({
        type: "toolCall",
        id: `boot-${sequence}-${name}`,
        name,
        arguments: args,
      });
      if (cue) {
        const claim = parsed("startup_claim");
        if (!claim || claim.claim.messageId !== cue.id)
          call = invoke("startup_claim", {});
        else if (cue.payload.kind === "architect-intake") {
          const page = parsed("startup_input");
          if (
            !page ||
            page.inputId !== cue.correlation ||
            page.nextOffset !== null
          )
            call = invoke("startup_input", {
              inputId: cue.correlation,
              offset: page?.inputId === cue.correlation ? page.nextOffset : 0,
            });
          else if (page.attachmentCount > 0 && !result("startup_image"))
            call = invoke("startup_image", {
              inputId: cue.correlation,
              index: 0,
            });
          else if (!parsed("startup_capture"))
            call = invoke("startup_capture", {
              captureId: `boot-capture-${cue.correlation}`,
              eventId: cue.correlation,
              rows: [],
              receipt: { fullInput: true, image: true },
            });
          else
            call = invoke("startup_settle", {
              claimId: claim.claim.id,
              result: {
                id: `boot-result-${claim.claim.id}`,
                kind: "completed",
                output: { proof: true },
                checkpoint: { done: true },
                outgoing: [],
              },
            });
        } else
          call = invoke("startup_settle", {
            claimId: claim.claim.id,
            result: {
              id: `boot-result-${claim.claim.id}`,
              kind: "completed",
              output: { proof: true },
              checkpoint: { done: true },
              outgoing: [],
            },
          });
      } else if (binding?.employeeId === "manager") {
        const event = /Saved Startup work event ([a-zA-Z0-9_-]+)/.exec(
          JSON.stringify(context.messages),
        )?.[1];
        if (
          event &&
          !results.some(
            (message) =>
              message.toolName === "task" &&
              JSON.stringify(message.content).includes(event),
          )
        )
          call = invoke("task", {
            startup: "delegate",
            eventId: event,
            developers: 1,
          });
        else {
          const pending = Array.from(
            JSON.stringify(context.messages).matchAll(
              /Dispatch ready independent inbox ([a-zA-Z0-9_-]+)/g,
            ),
          ).at(-1)?.[1];
          if (
            pending &&
            !results.some(
              (message) =>
                message.toolName === "startup_dispatch" &&
                JSON.stringify(message.content).includes(pending),
            )
          )
            call = invoke("startup_dispatch", { messageIds: [pending] });
        }
      } else call = invoke("yield", { data: { status: "NO_ACTION" } });
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: call ? [call] : [{ type: "text", text: "Boot proof idle" }],
        stopReason: call ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      if (call) {
        stream.push({
          type: "toolcall_start",
          contentIndex: 0,
          partial: message,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: call,
          partial: message,
        });
      }
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
}
