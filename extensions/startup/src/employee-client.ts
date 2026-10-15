import { z } from "zod";
import { jsonSchema, sourceSchema, type Json, type Source } from "./contracts";
import type { HostAPI } from "../index";
import type { NativeContext } from "./omp-adapter";

const pollSchema = z.strictObject({
  projection: z.string().min(1),
  pendingMessageIds: z.array(z.string().min(1)).readonly(),
  waitReason: z.string().min(1).nullable(),
}).readonly();
const admissionSchema = z.strictObject({
  socketPath: z.string().startsWith("/"),
  credential: z.string().min(1),
  nativeSession: z.string().min(1),
  paneId: z.string().min(1),
  source: sourceSchema,
});
const connectionSchema = z.strictObject({ connection: z.string().min(1) });
const beforeStartSchema = z.object({ systemPrompt: z.array(z.string()) });
const contextSchema = z.object({ messages: z.array(z.unknown()) });
const toolSchema = z.object({ toolName: z.string(), input: z.unknown() });

export type EmployeePoll = z.infer<typeof pollSchema>;
export type EmployeeClient = Readonly<{
  request: (command: Json) => Promise<Json>;
  poll: () => Promise<EmployeePoll>;
  close: () => void;
}>;
export type EmployeeBridgeHost = Pick<HostAPI, "on" | "sendMessage">;
export class EmployeeClientError extends Error {}

export async function connectEmployee(input: Readonly<{
  socketPath: string;
  credential: string;
  nativeSession: string;
  paneId: string;
  source: Source;
}>): Promise<EmployeeClient> {
  const admitted = admissionSchema.parse(input);
  let connection: string | null = null;
  let closed: boolean = false;
  const shutdown: AbortController = new AbortController();
  function redact(value: string): string {
    let safe: string = value.replaceAll(admitted.credential, "[redacted]");
    if (connection !== null) safe = safe.replaceAll(connection, "[redacted]");
    return safe;
  }
  async function exchange(method: "GET" | "POST", path: string, body: Json): Promise<Json> {
    if (closed) throw new EmployeeClientError("Startup employee connection is closed");
    const headers: Headers = new Headers();
    if (connection !== null) headers.set("Authorization", `Bearer ${connection}`);
    if (method === "POST") headers.set("Content-Type", "application/json");
    let response: Response;
    let text: string;
    try {
      response = await fetch(`http://localhost${path}`, {
        unix: admitted.socketPath,
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(jsonSchema.parse(body)) } : {}),
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10000)]),
      });
      text = await response.text();
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      throw new EmployeeClientError(`Startup ${method} ${path} failed: ${redact(reason)}`);
    }
    if (!response.ok)
      throw new EmployeeClientError(`Startup ${method} ${path} HTTP ${response.status}: ${redact(text)}`);
    try {
      return jsonSchema.parse(JSON.parse(text));
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      throw new EmployeeClientError(`Startup ${method} ${path} HTTP ${response.status} invalid JSON response: ${redact(reason)}; body=${redact(text)}`);
    }
  }
  const receipt: Json = await exchange("POST", "/admit", {
    credential: admitted.credential,
    nativeSession: admitted.nativeSession,
    paneId: admitted.paneId,
    source: admitted.source,
  });
  const parsedConnection = connectionSchema.safeParse(receipt);
  if (!parsedConnection.success)
    throw new EmployeeClientError("Startup POST /admit HTTP 200 returned an invalid connection receipt");
  connection = parsedConnection.data.connection;
  return {
    request: (command: Json): Promise<Json> => exchange("POST", "/command", command),
    async poll(): Promise<EmployeePoll> {
      const body: Json = await exchange("GET", "/poll", null);
      const parsed = pollSchema.safeParse(body);
      if (!parsed.success)
        throw new EmployeeClientError(`Startup GET /poll HTTP 200 returned an invalid employee projection: ${redact(parsed.error.message)}`);
      return parsed.data;
    },
    close(): void {
      closed = true;
      shutdown.abort();
    },
  };
}

export function installEmployeeBridge(host: EmployeeBridgeHost, input: Readonly<{
  client: EmployeeClient;
  ctx: NativeContext;
  intervalMs: number;
}>): Readonly<{ poll: () => Promise<void>; close: () => void }> {
  z.number().int().positive().parse(input.intervalMs);
  if (input.ctx.agent.kind !== "main")
    throw new EmployeeClientError("Only an actual OMP root may install the employee bridge");
  const rootId: string = input.ctx.agent.id;
  const rootSession: string = input.ctx.sessionManager.getSessionId();
  const notified: Set<string> = new Set();
  let current: EmployeePoll | null = null;
  let failure: string | null = null;
  let pending: Promise<void> | null = null;
  let closed: boolean = false;
  function isRoot(ctx: NativeContext): boolean {
    return ctx.agent.kind === "main" && ctx.agent.id === rootId &&
      ctx.sessionManager.getSessionId() === rootSession;
  }
  async function refresh(): Promise<void> {
    try {
      const next: EmployeePoll = await input.client.poll();
      if (closed) return;
      current = next;
      failure = null;
      for (const id of next.pendingMessageIds) {
        if (notified.has(id)) continue;
        host.sendMessage({
          customType: "startup-cue",
          content: `Startup inbox cue ${id} is durable. Claim your own inbox and follow the canonical loop.`,
          display: false,
        }, { triggerTurn: true, deliverAs: "nextTurn" });
        notified.add(id);
      }
    } catch (error: unknown) {
      if (closed) return;
      const reason: string = error instanceof Error ? error.message : String(error);
      if (failure !== reason)
        host.sendMessage({
          customType: "startup-connection-error",
          content: `Startup coordinator unavailable: ${reason}`,
          display: true,
        }, { triggerTurn: false, deliverAs: "nextTurn" });
      failure = reason;
      throw error;
    }
  }
  function poll(): Promise<void> {
    if (closed) return Promise.reject(new EmployeeClientError("Startup employee bridge is closed"));
    if (pending !== null) return pending;
    const operation: Promise<void> = refresh();
    pending = operation;
    void operation.then(() => { pending = null; }, () => { pending = null; });
    return operation;
  }
  function projection(): EmployeePoll {
    if (closed) throw new EmployeeClientError("Startup employee bridge is closed");
    if (failure !== null) throw new EmployeeClientError(failure);
    if (current === null) throw new EmployeeClientError("Startup employee projection is not admitted yet");
    return current;
  }
  const timer: ReturnType<typeof setInterval> = input.ctx.setInterval(() => {
    // refresh() records the failure and emits its visible diagnostic before rejecting.
    void poll().catch(() => undefined);
  }, input.intervalMs);
  function close(): void {
    closed = true;
    input.ctx.clearTimer(timer);
    input.client.close();
  }
  host.on("before_agent_start", async (event, ctx) => {
    if (!isRoot(ctx)) return;
    const parsed = beforeStartSchema.parse(event);
    await poll();
    return { systemPrompt: [...parsed.systemPrompt, projection().projection] };
  });
  host.on("context", async (event, ctx) => {
    if (!isRoot(ctx)) return;
    const parsed = contextSchema.parse(event);
    await poll();
    return { messages: [
      { role: "developer", content: projection().projection, timestamp: Date.now() },
      ...parsed.messages,
    ] };
  });
  host.on("tool_call", (event, ctx) => {
    const parsed = toolSchema.parse(event);
    const taskInput = z.record(z.string(), z.unknown()).safeParse(parsed.input);
    const startupTask: boolean = parsed.toolName === "task" &&
      taskInput.success && Object.hasOwn(taskInput.data, "startup");
    const employeeTool: boolean = parsed.toolName.startsWith("startup_") || startupTask;
    if (!isRoot(ctx))
      return employeeTool ? { block: true, reason: "Native helper has no Startup employee authority" } : undefined;
    if (failure !== null)
      return { block: true, reason: `Startup coordinator unavailable: ${failure}` };
    if (employeeTool && current === null)
      return { block: true, reason: "Startup employee projection is not admitted yet" };
    return;
  });
  host.on("session_stop", async (_event, ctx) => {
    if (!isRoot(ctx)) return;
    if (failure !== null)
      return { continue: true, additionalContext: `Startup coordinator unavailable: ${failure}` };
    await poll();
    const reason: string | null = projection().waitReason;
    return reason === null ? undefined : { continue: true, additionalContext: reason };
  });
  host.on("session_shutdown", (_event, ctx) => { if (isRoot(ctx)) close(); });
  return { poll, close };
}
