import { writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import boundedEntry from "../bounded-entry";

// Isolated offline probe: load this extension explicitly, invoke /bounded-native-smoke,
// and provide BOUNDED_SMOKE_REPORT. Never points at or modifies a Startup root.
export default function boundedNativeSmoke(pi: ExtensionAPI): void {
  boundedEntry(pi);
  pi.registerProvider("bounded-smoke", {
    api: "bounded-smoke", apiKey: "offline-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "offline", name: "Bounded offline smoke", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 4096 }],
    streamSimple: (model, context) => {
      const planner = JSON.stringify(context.messages).includes("Frozen items:");
      const output = planner ? JSON.stringify({ dependencies: { "smoke-item": [] }, targets: { "smoke-item": ["main"] } }) : "Bounded native smoke assignment completed.";
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: output }], stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
  pi.on("before_subagent_spawn", () => ({ model: "bounded-smoke/offline" }));
  pi.registerCommand("bounded-native-smoke", { description: "Exercise bounded entry with an offline native task", handler: async (_args, ctx) => {
    const report = process.env.BOUNDED_SMOKE_REPORT;
    if (!report) throw new Error("BOUNDED_SMOKE_REPORT is required");
    const events: unknown[] = [];
    try {
      const root = pi.pi.AgentRegistry.global().get(ctx.agent.id);
      if (!root?.session) throw new Error("Native root session unavailable");
      const call = async (name: string, params: unknown) => {
        const tool = root.session?.getToolByName(name);
        if (!tool) throw new Error(`Missing ${name}`);
        const response = await tool.execute(`bounded-smoke-${name}-${Date.now()}`, params);
        events.push({ name, response });
        if (response.isError) throw new Error(`${name} failed: ${JSON.stringify(response)}`);
        return response;
      };
      const text = pi.zod.object({ content: pi.zod.array(pi.zod.object({ type: pi.zod.literal("text"), text: pi.zod.string() }).passthrough()) }).passthrough();
      const getPayload = (response: unknown) => JSON.parse(text.parse(response).content[0]?.text ?? "null");
      const begin = getPayload(await call("bounded_begin", { workflow: "factory", itemIds: ["smoke-item"], reviewLimit: 3, landing: { mode: "ready-pr", target: "main" } }));
      await call("task", { scopeId: begin.scopeId, itemId: "smoke-item", assignmentKey: "planner", planner: true, context: "Offline factory planning", tasks: [{ name: "bounded-smoke-planner", agent: "task", task: "Plan the frozen queue.", solutionSpace: "One independent fixture." }] });
      const plannerDeadline = Date.now() + 30000;
      while (true) {
        const state = getPayload(await call("bounded_status", { scopeId: begin.scopeId }));
        if (state.graphFrozen === true) {
          if (state.planner?.state !== "completed" || JSON.stringify(state.dependencies) !== JSON.stringify({ "smoke-item": [] }) || JSON.stringify(state.targets) !== JSON.stringify({ "smoke-item": ["main"] })) throw new Error("Frozen planner graph or targets do not match native output");
          break;
        }
        if (state.planner?.state === "failed" || state.planner?.state === "uncertain") throw new Error(`Planner ended ${state.planner.state}`);
        if (Date.now() >= plannerDeadline) throw new Error("Planner did not freeze the graph");
        const pause = Promise.withResolvers<void>();
        ctx.setTimeout(pause.resolve, 20);
        await pause.promise;
      }
      const nested = getPayload(await call("bounded_nest", { parentId: begin.scopeId, workflow: "pipeline", itemIds: ["smoke-item"], reviewLimit: 2 }));
      await call("task", { scopeId: nested.scopeId, itemId: "smoke-item", assignmentKey: "smoke-dev", context: "Offline isolated bounded smoke", tasks: [{ name: "bounded-smoke-dev", agent: "task", task: "Return an offline smoke result.", solutionSpace: "No repository changes." }] });
      const deadline = Date.now() + 30000;
      let state: unknown;
      while (true) {
        state = getPayload(await call("bounded_status", { scopeId: nested.scopeId }));
        const parsed = pi.zod.object({ reservations: pi.zod.array(pi.zod.object({ assignmentKey: pi.zod.string().optional(), state: pi.zod.string() }).passthrough()) }).parse(state);
        const assignment = parsed.reservations.find((entry) => entry.assignmentKey === "smoke-dev");
        if (assignment && assignment.state !== "active") {
          if (assignment.state !== "completed") throw new Error(`Native assignment ended ${assignment.state}`);
          break;
        }
        if (Date.now() >= deadline) throw new Error("Native task did not settle");
        await new Promise<void>((resolve) => ctx.setTimeout(resolve, 20));
      }
      const jobs = root.session.asyncJobManager.getAllJobs({ ownerId: ctx.agent.id });
      const nativeJobs = ["bounded-smoke-planner", "bounded-smoke-dev"].map((id) => {
        const matches = jobs.filter((job) => job.id === id && job.ownerId === ctx.agent.id && job.agentId === id && job.type === "task");
        const job = matches[0];
        if (matches.length !== 1 || !job || job.status !== "completed" || pi.pi.AgentRegistry.global().get(id)?.parentId !== ctx.agent.id) throw new Error(`Native terminal job ${id} lacks correlated ancestry`);
        return { id: job.id, ownerId: job.ownerId, agentId: job.agentId, status: job.status, childParentId: pi.pi.AgentRegistry.global().get(id)?.parentId };
      });
      writeFileSync(report, JSON.stringify({ ok: true, state, nativeJobs, events }));
    } catch (error: unknown) {
      const root = pi.pi.AgentRegistry.global().get(ctx.agent.id);
      const jobs = root?.session?.asyncJobManager.getAllJobs({ ownerId: ctx.agent.id }) ?? [];
      events.push({ name: "native-jobs-on-error", jobs: jobs.map((job) => ({ id: job.id, ownerId: job.ownerId, agentId: job.agentId, type: job.type, status: job.status, latestDetails: job.latestDetails })) });
      writeFileSync(report, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), events }));
    } finally { ctx.shutdown(); }
  } });
}
