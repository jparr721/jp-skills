import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
function env(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing isolated adapter fixture variable ${name}`);
  return value;
}
function record(value: unknown): void {
  appendFileSync(env("STARTUP_ADAPTER_EVENTS"), JSON.stringify(value) + "\n");
}
function pause(ctx: ExtensionContext): Promise<void> {
  return new Promise((resolve) => {
    ctx.setTimeout(resolve, 20);
  });
}
export default function nativeAdapter(pi: ExtensionAPI): void {
  const registry = pi.pi.AgentRegistry.global();
  pi.on("before_subagent_spawn", () => ({ model: "startup-adapter/offline" }));
  pi.on("input", (event, ctx) =>
    record({
      kind: "native-input",
      source: event.source,
      text: event.text,
      id: ctx.agent.id,
    }),
  );
  pi.on("session_stop", (_event, ctx) => {
    if (ctx.agent.kind === "main") record({ kind: "native-root-stop" });
  });
  pi.on("tool_result", (event, ctx) =>
    record({
      kind: "tool",
      id: ctx.agent.id,
      name: event.toolName,
      error: event.isError,
      details: event.details,
      content: event.content,
    }),
  );
  pi.registerProvider("startup-adapter", {
    api: "startup-adapter-offline",
    apiKey: "isolated-offline-fixture",
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id: "offline",
        name: "Startup adapter offline fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 8192,
      },
    ],
    streamSimple: (model, context) => {
      record({
        kind: "provider",
        context: {
          systemPrompt: context.systemPrompt,
          messages: context.messages,
          tools: context.tools?.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      });
      const projection = context.messages.findLast(
        (message) =>
          message.role === "developer" &&
          typeof message.content === "string" &&
          message.content.startsWith("STARTUP_BINDING="),
      );
      const marker =
        projection && typeof projection.content === "string"
          ? JSON.parse(
              projection.content
                .split("\n")[0]
                .slice("STARTUP_BINDING=".length),
            )
          : null;
      const count =
        context.messages.filter(
          (message) =>
            message.role === "assistant" &&
            message.provider === "startup-adapter",
        ).length + 1;
      const text: string =
        projection && typeof projection.content === "string"
          ? projection.content
          : "";
      const cueLine: string | undefined = text
        .split("\n")
        .find((line) => line.startsWith("STARTUP_CUE="));
      const cue = cueLine
        ? JSON.parse(cueLine.slice("STARTUP_CUE=".length))
        : null;
      const results = context.messages
        .filter((message) => message.role === "toolResult" && !message.isError)
        .map((message) => ({
          name: message.toolName,
          text: message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        }));
      const claimed = results.findLast(
        (entry) => entry.name === "startup_claim" && entry.text !== "null",
      );
      const claim = claimed ? JSON.parse(claimed.text) : null;
      const captured = results.some(
        (entry) =>
          entry.name === "startup_capture" &&
          cue &&
          entry.text.includes(cue.correlation),
      );
      let call: ToolCall | null =
        marker?.employeeId === "manager"
          ? null
          : {
              type: "toolCall",
              id: `fixture-yield-${count}`,
              name: "yield",
              arguments: {
                data: { status: "NO_ACTION", checkpoint: `fixture-${count}` },
              },
            };
      if (cue) {
        if (!claim || claim.claim.messageId !== cue.id)
          call = {
            type: "toolCall",
            id: `fixture-claim-${count}`,
            name: "startup_claim",
            arguments: {},
          };
        else if (cue.payload.kind === "architect-intake" && !captured)
          call = {
            type: "toolCall",
            id: `fixture-capture-${count}`,
            name: "startup_capture",
            arguments: {
              captureId: `capture-${cue.correlation}`,
              eventId: cue.correlation,
              rows: [
                {
                  id: `item-${cue.correlation}`,
                  expectedRevision: null,
                  fields: {
                    request:
                      typeof cue.payload.raw === "string"
                        ? cue.payload.raw
                        : cue.payload.raw.text,
                    acceptance: ["fixture complete"],
                    blocked_on: [],
                    status: "QUEUED",
                  },
                },
              ],
              receipt: { fixture: true },
            },
          };
        else {
          const target =
            cue.payload.kind === "team-assignment"
              ? cue.payload.architect
              : marker?.employeeId === "manager" || cue.kind === "report"
                ? null
                : "manager";
          call = {
            type: "toolCall",
            id: `fixture-settle-${count}`,
            name: "startup_settle",
            arguments: {
              claimId: claim.claim.id,
              result: {
                id: `result-${claim.claim.id}`,
                kind: "completed",
                output: { fixture: true },
                checkpoint: { assignment: cue.id },
                outgoing:
                  target === null
                    ? []
                    : [
                        {
                          id: `report-${cue.id}`,
                          recipient: target,
                          kind: "report",
                          correlation: cue.correlation,
                          payload: { fixture: true },
                        },
                      ],
              },
            },
          };
        }
      }
      const teamLine: string | undefined = text
        .split("\n")
        .find((line) => line.startsWith("STARTUP_TEAM="));
      const scope = teamLine
        ? JSON.parse(teamLine.slice("STARTUP_TEAM=".length))
        : null;
      const received = scope?.receivedInputs?.[0];
      if (marker?.employeeId === "manager" && received) {
        const previousAttempt = context.messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === `fixture-input-read-${received.id}`,
        );
        const finalAttempt = context.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some(
              (part) =>
                part.type === "text" &&
                part.text === `INPUT_UNROUTED_FINAL_${received.id}`,
            ),
        );
        if (!finalAttempt) call = null;
        else if (!previousAttempt)
          call = {
            type: "toolCall",
            id: `fixture-input-read-${received.id}`,
            name: "read",
            arguments: { path: "fixture-input-lookup.txt" },
          };
        else
          call = {
            type: "toolCall",
            id: `fixture-input-route-${received.id}`,
            name: "startup_route",
            arguments: {
              inputId: received.id,
              disposition: received.raw.text.includes("also")
                ? "work"
                : "status",
              reason: "Fixture high-level user disposition",
              amendItemIds: [],
            },
          };
        if (!finalAttempt) {
          const message: AssistantMessage = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [
              { type: "text", text: `INPUT_UNROUTED_FINAL_${received.id}` },
            ],
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
          return stream;
        }
      } else if (marker?.employeeId === "manager") {
        const routed = results.findLast(
          (entry) => entry.name === "startup_route",
        );
        const receipt = routed ? JSON.parse(routed.text) : null;
        const delegated =
          receipt &&
          context.messages.some(
            (message) =>
              message.role === "toolResult" &&
              !message.isError &&
              message.toolName === "task" &&
              JSON.stringify(message.content).includes(receipt.id),
          );
        if (receipt?.disposition.kind === "work" && !delegated)
          call = {
            type: "toolCall",
            id: `fixture-input-delegate-${receipt.id}`,
            name: "task",
            arguments: {
              startup: "delegate",
              eventId: receipt.id,
              developers: 1,
            },
          };
      }
      const nativeDefaultParent: boolean = context.systemPrompt.some((prompt) =>
        prompt.includes("NATIVE_DEFAULT_AGENT_PROBE"),
      );
      if (nativeDefaultParent && count === 1)
        call = {
          type: "toolCall",
          id: "fixture-parent-default-task",
          name: "task",
          arguments: {
            context: "Ordinary bounded review default-agent fixture",
            tasks: [
              {
                name: "default-scout",
                task: "Return a read-only fixture checkpoint",
                solutionSpace: "Fixture only",
              },
            ],
          },
        };
      const stale: boolean =
        context.systemPrompt.some((prompt) =>
          /(?:^|\n)STARTUP_BINDING=/.test(prompt),
        ) && JSON.stringify(context.messages).includes("FIXTURE_STALE_PROBE");
      if (
        stale &&
        !context.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some(
              (part) =>
                part.type === "toolCall" &&
                part.id.startsWith("fixture-stale-write"),
            ),
        )
      )
        call = {
          type: "toolCall",
          id: `fixture-stale-write-${count}`,
          name: "write",
          arguments: {
            path: env("STARTUP_ADAPTER_DENIED_PATH"),
            content: "Unauthorized stale source action",
          },
        };
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: call ? [call] : [{ type: "text", text: "Fixture root idle." }],
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
  pi.registerCommand("startup-input-proof-report", {
    description: "Finish actual human input proof",
    handler: async (_args, ctx) => {
      try {
        const root = registry.get(ctx.agent.id);
        const staff = root?.session?.getToolByName("startup_staff");
        if (!root?.session || !staff)
          throw new Error("Input proof root missing");
        const initial = (await staff.execute("input-proof-staff", {})).details;
        pi.sendMessage(
          {
            customType: "fixture-internal",
            content: "Fixture internal wake exclusion",
            display: false,
          },
          { triggerTurn: true, deliverAs: "nextTurn" },
        );
        const wakeDeadline: number = Date.now() + 10000;
        while (
          !readFileSync(env("STARTUP_ADAPTER_EVENTS"), "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
            .some(
              (event) =>
                event.kind === "provider" &&
                JSON.stringify(event.context.messages).includes(
                  "Fixture internal wake exclusion",
                ),
            )
        ) {
          if (Date.now() > wakeDeadline)
            throw new Error(
              "Internal manager wake did not reach actual provider",
            );
          await pause(ctx);
        }
        const after = (await staff.execute("input-proof-after", {})).details;
        record({ kind: "native-input-proof", initial, after });
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({ status: "COMPLETE", version: pi.pi.VERSION }),
        );
        process.exit(0);
      } catch (error: unknown) {
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({
            status: "FAIL",
            error: error instanceof Error ? error.stack : String(error),
          }),
        );
        process.exit(1);
      }
    },
  });
  pi.registerCommand("startup-adapter-refresh-proof", {
    description: "Run isolated canonical refresh and stale native fencing",
    handler: async (_args, ctx) => {
      try {
        const root = registry.get(ctx.agent.id);
        if (!root?.session) throw new Error("Missing native root");
        const task = root.session.getToolByName("task");
        const staff = root.session.getToolByName("startup_staff");
        const send = root.session.getToolByName("startup_send");
        const refresh = root.session.getToolByName("startup_refresh");
        const write = root.session.getToolByName("write");
        if (!task || !staff || !send || !refresh || !write)
          throw new Error("Missing source refresh tools");
        await task.execute("refresh-hire", {
          startup: "hire",
          requestId: "refresh-proof",
          role: "pa",
          additional: 1,
        });
        const idle = async (count: number): Promise<void> => {
          const deadline = Date.now() + 30000;
          while (
            registry.list().filter((ref) => ref.parentId === root.id).length <
              count ||
            registry
              .list()
              .some(
                (ref) => ref.parentId === root.id && ref.status === "running",
              )
          ) {
            if (Date.now() > deadline)
              throw new Error("Refresh native turn did not idle");
            await pause(ctx);
          }
        };
        await idle(1);
        const original = (
          await staff.execute("refresh-before", {})
        ).details.employees.find((employee) => employee.role === "pa");
        if (!original?.source)
          throw new Error("Initial PA source binding missing");
        const handle = JSON.parse(original.nativeHandle);
        const oldText: string = readFileSync(original.source.rolePath, "utf8");
        const newText: string =
          oldText +
          "\nNew full canonical source revision accepted at the safe boundary.\n";
        writeFileSync(original.source.rolePath, newText);
        await send.execute("refresh-saved-mail", {
          id: "refresh-saved-mail",
          recipient: original.id,
          kind: "assignment",
          correlation: "refresh-proof",
          payload: { readOnly: true },
        });
        await idle(1);
        record({
          kind: "refresh-reserved",
          result: await refresh.execute("refresh-source", {
            employeeId: original.id,
            evidence: {
              approved: true,
              reason: "new canonical source revision",
            },
          }),
        });
        await task.execute("refresh-activate", {
          startup: "activate",
          employeeIds: [original.id],
        });
        const deadline: number = Date.now() + 30000;
        let current;
        while (true) {
          current = (
            await staff.execute("refresh-ready", {})
          ).details.employees.find((employee) => employee.id === original.id);
          if (
            current?.generation === 2 &&
            current.checkpoint?.assignment === "refresh-saved-mail"
          )
            break;
          if (Date.now() > deadline)
            throw new Error(
              "New actual native generation did not process preserved mail",
            );
          await pause(ctx);
        }
        await idle(2);
        await write.execute("stale-native-wake", {
          path: `agent://${handle.id}`,
          content:
            "FIXTURE_STALE_PROBE: Attempt the isolated stale write; then yield.",
        });
        const staleDeadline: number = Date.now() + 10000;
        while (
          !readFileSync(env("STARTUP_ADAPTER_EVENTS"), "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
            .some(
              (event) =>
                event.kind === "provider" &&
                event.context.messages.some(
                  (message) =>
                    message.role === "toolResult" &&
                    message.toolName === "write" &&
                    message.isError &&
                    message.toolCallId.startsWith("fixture-stale-write"),
                ),
            )
        ) {
          if (Date.now() > staleDeadline)
            throw new Error(
              "Old native context did not attempt its isolated stale write",
            );
          await pause(ctx);
        }
        await idle(2);
        record({
          kind: "native-refresh",
          original,
          current,
          oldText,
          newText,
          staleNativeId: handle.id,
        });
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({
            status: "COMPLETE",
            scenario: "refresh",
            version: pi.pi.VERSION,
          }),
        );
      } catch (error: unknown) {
        record({
          kind: "failure",
          error: error instanceof Error ? error.stack : String(error),
        });
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({
            status: "FAIL",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        ctx.shutdown();
      }
    },
  });
  pi.registerCommand("startup-adapter-proof", {
    description: "Run isolated native adapter acceptance",
    handler: async (_args, ctx) => {
      try {
        const root = registry.get(ctx.agent.id);
        if (!root?.session) throw new Error("Missing native root");
        record({
          kind: "root",
          id: root.id,
          sessionId: ctx.sessionManager.getSessionId(),
          file: root.sessionFile,
        });
        const task = root.session.getToolByName("task");
        const staff = root.session.getToolByName("startup_staff");
        const intake = root.session.getToolByName("startup_intake");
        if (!task || !staff || !intake) throw new Error("Adapter tools absent");
        const wait = async (count: number): Promise<void> => {
          const deadline = Date.now() + 30000;
          while (
            registry.list().filter((ref) => ref.parentId === root.id).length <
              count ||
            registry
              .list()
              .some(
                (ref) => ref.parentId === root.id && ref.status === "running",
              )
          ) {
            if (Date.now() > deadline)
              throw new Error("Native adapter activation timeout");
            await pause(ctx);
          }
        };
        record({
          kind: "catalog",
          tools: pi
            .getAllTools()
            .filter((tool) => ["task", "startup_settle"].includes(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              schema: tool.parameters.toJsonSchema(),
            })),
        });
        record({
          kind: "existing",
          result: await task.execute("adapter-existing", {
            startup: "hire",
            requestId: "existing",
            role: "devops",
            additional: 1,
          }),
        });
        await wait(1);
        record({
          kind: "six",
          result: await task.execute("adapter-six", {
            startup: "hire",
            requestId: "six",
            role: "devops",
            additional: 6,
          }),
        });
        await wait(7);
        record({
          kind: "replay",
          result: await task.execute("adapter-replay", {
            startup: "hire",
            requestId: "six",
            role: "devops",
            additional: 6,
          }),
        });
        record({
          kind: "staff",
          result: await staff.execute("adapter-staff", {}),
        });
        const child = registry.list().find((ref) => ref.parentId === root.id);
        if (!child) throw new Error("No actual employee");
        await AgentLifecycleManager.global().park(child.id);
        const send = root.session.getToolByName("startup_send");
        if (!send) throw new Error("Missing durable cue sender");
        const staffData = (await staff.execute("adapter-staff-wake", {}))
          .details;
        const employee = staffData.employees.find(
          (entry) =>
            entry.id !== "manager" &&
            entry.nativeHandle !== null &&
            JSON.parse(entry.nativeHandle).id === child.id,
        );
        if (!employee)
          throw new Error(
            "Missing source-bound employee for parked native child",
          );
        record({
          kind: "wake",
          result: await send.execute("adapter-wake", {
            id: "later-assignment",
            recipient: employee.id,
            kind: "assignment",
            correlation: "later",
            payload: { only: "own second assignment" },
          }),
        });
        await wait(7);
        await intake.execute("adapter-raw-first", {
          eventId: "first-event",
          input: "same raw request",
          amendItemIds: [],
        });
        await intake.execute("adapter-raw-second", {
          eventId: "second-event",
          input: "same raw request",
          amendItemIds: [],
        });
        record({
          kind: "team-first",
          result: await task.execute("adapter-team-first", {
            startup: "delegate",
            eventId: "first-event",
            developers: 1,
          }),
        });
        await wait(10);
        record({
          kind: "team-second",
          result: await task.execute("adapter-team-second", {
            startup: "delegate",
            eventId: "second-event",
            developers: 1,
          }),
        });
        await wait(13);
        const completeDeadline: number = Date.now() + 30000;
        while (true) {
          const snapshot = (await staff.execute("adapter-team-readiness", {}))
            .details;
          if (
            snapshot.teams.every((team) => team.state === "active") &&
            snapshot.employees
              .filter((employee) => employee.assignment !== null)
              .every((employee) => employee.checkpoint !== null)
          )
            break;
          if (Date.now() > completeDeadline)
            throw new Error(
              "Architect intake and settled team checkpoints did not complete",
            );
          await pause(ctx);
        }
        record({
          kind: "team-replay",
          result: await task.execute("adapter-team-replay", {
            startup: "delegate",
            eventId: "first-event",
            developers: 1,
          }),
        });
        record({
          kind: "final-staff",
          result: await staff.execute("adapter-final-staff", {}),
        });
        record({
          kind: "ordinary",
          result: await task.execute("adapter-ordinary", {
            context: "Ordinary native compatibility",
            tasks: [
              {
                name: "ordinary-optional",
                agent: "task",
                task: "Return a checkpoint",
                solutionSpace: "Fixture only",
                outputSchema: { type: "object" },
                schemaMode: "permissive",
                isolated: false,
                effort: "lo",
                tools: [],
              },
            ],
          }),
        });
        await wait(14);
        writeFileSync(
          `${ctx.cwd}/.omp/agents/fixture-default-parent.md`,
          "---\nname: fixture-default-parent\ndescription: Native parent-specific spawn-policy fixture\nspawns: [scout]\nblocking: false\n---\nNATIVE_DEFAULT_AGENT_PROBE\n",
        );
        record({
          kind: "ordinary-default-parent",
          result: await task.execute("adapter-parent-default", {
            context: "Bounded native parent spawn restriction",
            tasks: [
              {
                name: "default-parent",
                agent: "fixture-default-parent",
                task: "NATIVE_DEFAULT_AGENT_PROBE",
                solutionSpace: "Fixture only",
                isolated: false,
              },
            ],
          }),
        });
        await wait(15);
        const nestedDeadline: number = Date.now() + 30000;
        while (
          !registry
            .list()
            .some(
              (ref) =>
                ref.parentId === "default-parent" && ref.status === "idle",
            )
        ) {
          if (Date.now() > nestedDeadline)
            throw new Error(
              "Native parent default did not dispatch its allowed scout child",
            );
          await pause(ctx);
        }
        record({
          kind: "ordinary-parent-default",
          refs: registry
            .list()
            .filter((ref) => ref.parentId === "default-parent")
            .map((ref) => ({
              id: ref.id,
              parentId: ref.parentId,
              status: ref.status,
            })),
        });
        record({
          kind: "ordinary-rejected",
          result: await task.execute("adapter-bad", {
            context: "invalid",
            tasks: [
              {
                agent: "does-not-exist",
                task: "Rejected",
                solutionSpace: "Fixture only",
              },
            ],
          }),
        });
        const rootIdleDeadline: number = Date.now() + 10000;
        while (
          root.session.agent.state.isStreaming ||
          root.session.agent.hasQueuedMessages() ||
          (
            await staff.execute("root-idle-before-abort", {})
          ).details.managerClaims.some((claim) => claim.status === "active")
        ) {
          if (Date.now() > rootIdleDeadline)
            throw new Error(
              "Manager did not idle before aborted-child notification proof",
            );
          await pause(ctx);
        }
        record({
          kind: "manager-idle-before-abort",
          status: registry.get(root.id)?.status,
          providerStreaming: root.session.agent.state.isStreaming,
          queuedMessages: root.session.agent.hasQueuedMessages(),
        });
        await AgentLifecycleManager.global().release(child.id, child, {
          tombstone: true,
        });
        if (
          registry.get(child.id)?.status !== "aborted" ||
          registry.get(child.id)?.session !== null
        )
          throw new Error(
            "Native abort did not retain a detached terminal actor",
          );
        const alertId: string = `native-alert-${child.id}-${employee.generation}`;
        const managerDeadline: number = Date.now() + 10000;
        while (true) {
          const snapshot = (await staff.execute("adapter-abort-wake", {}))
            .details;
          const manager = snapshot.employees.find(
            (entry) => entry.id === "manager",
          );
          if (
            manager?.checkpoint?.assignment === alertId &&
            snapshot.deliveries[alertId] &&
            readFileSync(env("STARTUP_ADAPTER_EVENTS"), "utf8")
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line))
              .some(
                (event) =>
                  event.kind === "provider" &&
                  JSON.stringify(event.context.messages).includes(
                    `Durable Startup manager inbox cue ${alertId}`,
                  ),
              )
          ) {
            record({
              kind: "aborted-manager-wake",
              nativeId: child.id,
              sessionNull: registry.get(child.id)?.session === null,
              alertId,
              managerCheckpoint: manager.checkpoint,
              delivery: snapshot.deliveries[alertId],
            });
            break;
          }
          if (Date.now() > managerDeadline)
            throw new Error(
              "Aborted actor durable alert did not wake the actual manager provider",
            );
          await pause(ctx);
        }
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({
            status: "COMPLETE",
            children: registry
              .list()
              .filter((ref) => ref.parentId === root.id)
              .map((ref) => ({
                id: ref.id,
                file: ref.sessionFile,
                status: ref.status,
              })),
            version: pi.pi.VERSION,
          }),
        );
      } catch (error: unknown) {
        record({
          kind: "failure",
          error: error instanceof Error ? error.stack : String(error),
        });
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({
            status: "FAIL",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        ctx.shutdown();
      }
    },
  });
}
