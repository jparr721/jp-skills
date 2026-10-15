import { z } from "zod";
import { jsonSchema, sourceSchema, type Json, type Source } from "./contracts";
import type { HostAPI } from "../index";
import type { NativeContext } from "./omp-adapter";

const pollSchema = z.strictObject({
  projection: z.string().min(1),
  pendingMessageIds: z.array(z.string().min(1)).readonly(),
  toolBlockReason: z.string().min(1).nullable(),
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
function isEmployeeTool(event: unknown): boolean {
  const parsed = toolSchema.parse(event);
  const taskInput = z.record(z.string(), z.unknown()).safeParse(parsed.input);
  const uriInput = z.object({ path: z.string() }).safeParse(parsed.input);
  const employeeUri = ["read", "write"].includes(parsed.toolName) && uriInput.success && /^xd:\/\/startup_[a-z0-9_]+(?:[/?#]|$)/.test(uriInput.data.path);
  return employeeUri || parsed.toolName.startsWith("startup_") || (parsed.toolName === "task" && taskInput.success && Object.hasOwn(taskInput.data, "startup"));
}
export function installEmployeeToolGuard(host: EmployeeBridgeHost): void {
  host.on("tool_call", (event, ctx) => {
    if (ctx.agent.kind !== "main" && isEmployeeTool(event))
      return { block: true, reason: "Native helper has no Startup employee authority" };
    return;
  });
}
export class EmployeeClientError extends Error {}
class EmployeeHttpError extends EmployeeClientError {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

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
      throw new EmployeeHttpError(response.status, `Startup ${method} ${path} HTTP ${response.status}: ${redact(text)}`);
    try {
      return jsonSchema.parse(JSON.parse(text));
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      throw new EmployeeClientError(`Startup ${method} ${path} HTTP ${response.status} invalid JSON response: ${redact(reason)}; body=${redact(text)}`);
    }
  }
  async function admitConnection(): Promise<void> {
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
  }
  async function awaitAdmission(): Promise<void> {
    const deadline = Date.now() + 10000;
    let warned = false;
    while (true) {
      try { await admitConnection(); return; }
      catch (error: unknown) {
        if (!(error instanceof EmployeeHttpError) || error.status !== 425 || Date.now() >= deadline) throw error;
        if (!warned) { process.stderr.write(JSON.stringify({ level: "warn", component: "startup-admission", reason: "native-session-report-pending" }) + "\n"); warned = true; }
        await Bun.sleep(100);
      }
    }
  }
  await awaitAdmission();
  return {
    request: (command: Json): Promise<Json> => exchange("POST", "/command", command),
    async poll(): Promise<EmployeePoll> {
      let body: Json;
      try { body = await exchange("GET", "/poll", null); }
      catch (error: unknown) {
        if (!(error instanceof EmployeeHttpError) || ![401, 403, 409].includes(error.status)) throw error;
        connection = null;
        await awaitAdmission();
        body = await exchange("GET", "/poll", null);
      }
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
  const abort = input.ctx.abort;
  if (typeof abort !== "function") throw new EmployeeClientError("V7 requires the native abort capability before employee admission");
  const isIdle = input.ctx.isIdle;
  const hasPendingMessages = input.ctx.hasPendingMessages;
  if (typeof isIdle !== "function" || typeof hasPendingMessages !== "function") throw new EmployeeClientError("V7 requires native run-state callbacks before employee admission");
  const nativeIdle: () => boolean = isIdle;
  const nativePending: () => boolean = hasPendingMessages;
  const abortTurn: () => void = abort;
  const rootId: string = input.ctx.agent.id;
  const rootSession: string = input.ctx.sessionManager.getSessionId();
  const notified: Map<string, number> = new Map();
  let current: EmployeePoll | null = null;
  let failure: string | null = null;
  let pending: Promise<void> | null = null;
  let closed: boolean = false;
  let continuedReason: string | null = null;
  let releasePending: boolean = false;
  let turnHeld: boolean = false;
  let turnBlocked: string | null = null;
  function isRoot(ctx: NativeContext): boolean {
    return ctx.agent.kind === "main" && ctx.agent.id === rootId &&
      ctx.sessionManager.getSessionId() === rootSession;
  }
  async function refresh(): Promise<void> {
    try {
      const next: EmployeePoll = await input.client.poll();
      if (turnHeld && nativeIdle() && !nativePending()) releasePending = true;
      if (releasePending) { await input.client.request({ kind: "end_turn" }); releasePending = false; turnHeld = false; }
      if (closed) return;
      current = next;
      failure = null;
      for (const id of notified.keys()) if (!next.pendingMessageIds.includes(id)) notified.delete(id);
      for (const id of next.pendingMessageIds) {
        const notifiedAt = notified.get(id);
        if (notifiedAt !== undefined && Date.now() - notifiedAt < 30000) continue;
        host.sendMessage({
          customType: "startup-cue",
          content: `Startup inbox cue ${id} is durable. Claim your own inbox and follow the canonical loop.`,
          display: false,
        }, { triggerTurn: true, deliverAs: "nextTurn" });
        notified.set(id, Date.now());
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
  async function admitTurn(): Promise<void> {
    try { await poll(); await input.client.request({ kind: "begin_turn" }); turnHeld = true; turnBlocked = null; }
    catch (error: unknown) {
      turnBlocked = error instanceof Error ? error.message : String(error);
      abortTurn();
      host.sendMessage({ customType: "startup-turn-blocked", content: `Startup turn blocked: ${turnBlocked}`, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
    }
  }
  function projectedText(): string {
    return current?.projection ?? "Startup employee is blocked until its canonical source and coordinator connection are admitted.";
  }
  host.on("before_agent_start", async (event, ctx) => {
    if (!isRoot(ctx)) return;
    const parsed = beforeStartSchema.parse(event);
    await admitTurn();
    return { systemPrompt: [...parsed.systemPrompt, projectedText()] };
  });
  host.on("context", async (event, ctx) => {
    if (!isRoot(ctx)) return;
    const parsed = contextSchema.parse(event);
    await admitTurn();
    return { messages: [
      { role: "developer", content: projectedText(), timestamp: Date.now() },
      ...parsed.messages,
    ] };
  });
  host.on("tool_call", (event, ctx) => {
    const employeeTool: boolean = isEmployeeTool(event);
    if (!isRoot(ctx))
      return employeeTool ? { block: true, reason: "Native helper has no Startup employee authority" } : undefined;
    if (turnBlocked !== null) return { block: true, reason: turnBlocked };
    if (failure !== null)
      return { block: true, reason: `Startup coordinator unavailable: ${failure}` };
    if (!employeeTool && current?.toolBlockReason !== null && current?.toolBlockReason !== undefined)
      return { block: true, reason: current.toolBlockReason };
    if (employeeTool && current === null)
      return { block: true, reason: "Startup employee projection is not admitted yet" };
    return;
  });
  host.on("agent_end", async (event, ctx) => {
    if (!isRoot(ctx)) return;
    const parsed = z.object({ willContinue: z.boolean().optional() }).passthrough().parse(event);
    if (parsed.willContinue !== true) {
      releasePending = true;
      try { await input.client.request({ kind: "end_turn" }); releasePending = false; turnHeld = false; }
      catch (error: unknown) {
        host.sendMessage({ customType: "startup-capacity-release", content: "Startup capacity release is pending; the control connection will reconcile it on recovery.", display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
        throw error;
      }
    }
  });
  host.on("session_stop", async (_event, ctx) => {
    if (!isRoot(ctx)) return;
    const failureReason = failure === null ? null : `Startup coordinator unavailable: ${failure}`;
    if (failureReason !== null) {
      if (continuedReason === failureReason) return;
      continuedReason = failureReason;
      return { continue: true, additionalContext: failureReason };
    }
    await poll();
    const reason: string | null = projection().waitReason;
    if (reason === null) { continuedReason = null; return; }
    if (continuedReason === reason) return;
    continuedReason = reason;
    return { continue: true, additionalContext: reason };
  });
  host.on("session_shutdown", (_event, ctx) => { if (isRoot(ctx)) close(); });
  return { poll, close };
}
