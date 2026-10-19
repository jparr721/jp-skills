import { z } from "zod";
import { encode, idSchema, jsonSchema, sourceSchema, settlementRecoverySchema, type SettlementRecovery, type Json, type Source } from "./contracts";
import type { HostAPI } from "../index";
import type { NativeContext } from "./omp-adapter";
import { ompSessionSettingsReportSchema, type OmpSessionSettingsReport } from "./runtime-contracts";

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
  agentSessionId: z.string().min(1).optional(),
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
  poll: (settingsReport?: OmpSessionSettingsReport) => Promise<EmployeePoll>;
  close: () => void;
  disconnect: () => Promise<void>;
  settlementBlock: () => string | null;
  isClosed: () => boolean;
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
export type TransportDiagnostic = Readonly<{
  method: "GET" | "POST";
  path: string;
  socketPath: string;
  code: string;
  causeCode: string | null;
  elapsedMs: number;
  timeoutMs: number;
  reason: string;
}>;
export class EmployeeTransportError extends EmployeeClientError {
  readonly diagnostic: TransportDiagnostic;
  constructor(diagnostic: TransportDiagnostic) {
    super(`Startup ${diagnostic.method} ${diagnostic.path} failed: ${diagnostic.reason}; socket=${diagnostic.socketPath}; code=${diagnostic.code}; causeCode=${diagnostic.causeCode ?? "unknown"}; elapsedMs=${diagnostic.elapsedMs}; timeoutMs=${diagnostic.timeoutMs}`);
    this.diagnostic = diagnostic;
  }
}
class EmployeeHttpError extends EmployeeClientError {
  readonly status: number;
  readonly recovery: SettlementRecovery | null;
  constructor(status: number, message: string, recovery: SettlementRecovery | null) { super(message); this.status = status; this.recovery = recovery; }
}
export class EmployeeSettlementError extends EmployeeClientError {
  readonly recovery: SettlementRecovery;
  readonly repeated: boolean;
  constructor(message: string, recovery: SettlementRecovery, repeated: boolean) {
    super(`${message}; action=${recovery.action}; retryable=false${repeated ? "; duplicate settlement suppressed locally; native turn will park" : ""}`);
    this.recovery = recovery;
    this.repeated = repeated;
  }
}
export class EmployeeCommandError extends EmployeeClientError {
  readonly repeated: boolean;
  readonly kind: string;
  constructor(message: string, kind: string, repeated: boolean) {
    super(`${message}; retryable=false; action=Inspect current claim and command arguments, settle or reconcile existing work, or correct the request. Do not repeat unchanged arguments.${repeated ? " duplicate command suppressed locally; native turn will park" : ""}`);
    this.kind = kind;
    this.repeated = repeated;
  }
}

export async function reportLaunchFailure(input: Readonly<{ socketPath: string; credential: string; error: string }>): Promise<void> {
  const redact = (value: string): string => value.replaceAll(input.credential, "[redacted]");
  try {
    const response = await fetch("http://localhost/launch-failure", {
      unix: input.socketPath, method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: input.credential, error: redact(input.error).slice(0, 8192) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new EmployeeClientError(`Startup POST /launch-failure HTTP ${response.status}: ${redact(await response.text())}`);
  } catch (error: unknown) {
    throw new EmployeeClientError(`Startup boot failure reporting failed: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
}

export async function connectEmployee(input: Readonly<{
  socketPath: string;
  credential: string;
  nativeSession: string;
  agentSessionId?: string;
  paneId: string;
  source: Source;
}>): Promise<EmployeeClient> {
  const admitted = admissionSchema.parse(input);
  let connection: string | null = null;
  let closed: boolean = false;
  let lifetime: WebSocket | null = null;
  let previousReport: OmpSessionSettingsReport | undefined;
  let sampleSequence: number = 0;
  let claimState: string | null = null;
  let settlementBlocked: EmployeeSettlementError | null = null;
  let commandBlocked: EmployeeCommandError | null = null;
  const rejectedSettlements = new Map<string, EmployeeSettlementError>();
  const rejectedCommands = new Map<string, EmployeeCommandError>();
  const shutdown: AbortController = new AbortController();
  function redact(value: string): string {
    let safe: string = value.replaceAll(admitted.credential, "[redacted]");
    if (connection !== null) safe = safe.replaceAll(connection, "[redacted]");
    return safe;
  }
  async function exchange(method: "GET" | "POST", path: string, body: Json): Promise<Json> {
    if (closed) throw new EmployeeClientError("Startup employee connection is closed");
    const capturedConnection = connection;
    const headers: Headers = new Headers();
    if (connection !== null) headers.set("Authorization", `Bearer ${connection}`);
    if (method === "POST") headers.set("Content-Type", "application/json");
    let response: Response;
    let text: string;
    const startedAt: number = Date.now();
    const timeoutMs: number = 10000;
    const signal: AbortSignal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      response = await fetch(`http://localhost${path}`, {
        unix: admitted.socketPath,
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(jsonSchema.parse(body)) } : {}),
        signal,
      });
      text = await response.text();
    } catch (error: unknown) {
      const fields = z.object({ code: z.union([z.string(), z.number()]).optional(), cause: z.unknown().optional(), name: z.string().optional() }).safeParse(error);
      const cause = z.object({ code: z.union([z.string(), z.number()]).optional() }).safeParse(fields.success ? fields.data.cause : undefined);
      throw new EmployeeTransportError({
        method, path, socketPath: redact(admitted.socketPath),
        code: redact(String(fields.success && fields.data.code !== undefined ? fields.data.code : signal.aborted && signal.reason instanceof Error ? signal.reason.name : fields.success ? fields.data.name ?? "UNKNOWN" : "UNKNOWN")),
        causeCode: cause.success && cause.data.code !== undefined ? redact(String(cause.data.code)) : null,
        elapsedMs: Date.now() - startedAt, timeoutMs,
        reason: redact(error instanceof Error ? error.message : String(error)),
      });
    }
    if (closed || capturedConnection !== connection) throw new EmployeeClientError("Startup connection changed while request was in flight; outcome is uncertain, do not replay");
    if (!response.ok) {
      let recovery: SettlementRecovery | null = null;
      try {
        const body: unknown = JSON.parse(redact(text));
        if (z.object({ admission: z.literal("revoked") }).safeParse(body).success) { closed = true; shutdown.abort(); lifetime?.close(); }
        const parsed = z.object({ recovery: settlementRecoverySchema }).safeParse(body);
        if (parsed.success) recovery = parsed.data.recovery;
      } catch (error: unknown) { if (!(error instanceof SyntaxError)) throw error; }
      throw new EmployeeHttpError(response.status, `Startup ${method} ${path} HTTP ${response.status}: ${redact(text)}`, recovery);
    }
    try {
      return jsonSchema.parse(JSON.parse(text));
    } catch (error: unknown) {
      const reason: string = error instanceof Error ? error.message : String(error);
      throw new EmployeeClientError(`Startup ${method} ${path} HTTP ${response.status} invalid JSON response: ${redact(reason)}; body=${redact(text)}`);
    }
  }
  async function admitConnection(): Promise<void> {
    const admissionStartedAt = Date.now();
    const socket = new WebSocket(`ws+unix://${admitted.socketPath}:/admit`);
    lifetime = socket;
    const receipt = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new EmployeeClientError("Admission channel timed out")); socket.close(); }, 10000);
      socket.onopen = (): void => { socket.send(JSON.stringify({ credential: admitted.credential, nativeSession: admitted.nativeSession,
        ...(admitted.agentSessionId === undefined ? {} : { agentSessionId: admitted.agentSessionId }), paneId: admitted.paneId, source: admitted.source })); };
      socket.onmessage = (event): void => {
        clearTimeout(timeout);
        try {
          const value: unknown = JSON.parse(String(event.data));
          const failure = z.object({ status: z.number(), error: z.string() }).safeParse(value);
          if (failure.success) { reject(new EmployeeHttpError(failure.data.status, `Admission /admit ${failure.data.status}: ${redact(failure.data.error)}`, null)); return; }
          resolve(connectionSchema.parse(value).connection);
        } catch (error: unknown) { reject(new EmployeeClientError(`Invalid /admit receipt: ${redact(error instanceof Error ? error.message : String(error))}`)); socket.close(); }
      };
      socket.onerror = (): void => { clearTimeout(timeout); reject(new EmployeeTransportError({ method: "GET", path: "/admit", socketPath: admitted.socketPath, code: "CHANNEL_CONNECT_FAILED", causeCode: null, elapsedMs: Date.now() - admissionStartedAt, timeoutMs: 10000, reason: "Unix WebSocket admission connection failed" })); };
      socket.onclose = (): void => { clearTimeout(timeout); reject(new EmployeeClientError("Admission channel closed before receipt")); };
    });
    if (closed || socket.readyState !== WebSocket.OPEN) { socket.close(); throw new EmployeeClientError("Admission channel closed before activation"); }
    connection = receipt;
    socket.onclose = (): void => { closed = true; shutdown.abort(); };
    socket.onerror = (): void => { closed = true; shutdown.abort(); socket.close(); };
    rejectedCommands.clear();
    commandBlocked = null;
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
    async request(command: Json): Promise<Json> {
      const settle = z.object({ kind: z.literal("settle"), result: z.record(z.string(), jsonSchema) }).passthrough().safeParse(command);
      const fingerprint: string | null = settle.success ? encode({ ...settle.data, result: { ...settle.data.result, id: null } }) : null;
      const exactFingerprint: string = encode(command);
      const rejectedCommand = rejectedCommands.get(exactFingerprint);
      if (rejectedCommand !== undefined) {
        commandBlocked = rejectedCommand;
        throw new EmployeeCommandError(rejectedCommand.message, rejectedCommand.kind, true);
      }
      const kind = z.object({ kind: z.string() }).safeParse(command);
      const rejected = rejectedSettlements.get(exactFingerprint) ?? (fingerprint === null ? undefined : rejectedSettlements.get(fingerprint));
      if (rejected !== undefined) {
        settlementBlocked = rejected;
        throw new EmployeeSettlementError(rejected.message, rejected.recovery, true);
      }
      try {
        const receipt = await exchange("POST", "/command", command);
        if (kind.success) {
          for (const [key, rejected] of rejectedCommands) if (rejected.kind === kind.data.kind) rejectedCommands.delete(key);
          if (commandBlocked?.kind === kind.data.kind) commandBlocked = null;
        }
        const settled = settle.success ? z.object({ claimId: idSchema }).safeParse(receipt) : null;
        if (settled?.success) {
          for (const [key, failure] of rejectedSettlements) if (failure.recovery.claimId === settled.data.claimId) rejectedSettlements.delete(key);
          if (settlementBlocked?.recovery.claimId === settled.data.claimId) settlementBlocked = null;
        }
        return receipt;
      } catch (error: unknown) {
        if (fingerprint === null && kind.success && !["begin_turn", "end_turn"].includes(kind.data.kind) && error instanceof EmployeeHttpError && [400, 403, 409].includes(error.status)) {
          const failure = new EmployeeCommandError(error.message, kind.data.kind, false);
          rejectedCommands.set(exactFingerprint, failure);
          throw failure;
        }
        if (fingerprint === null || !(error instanceof EmployeeHttpError) || ![400, 409].includes(error.status)) throw error;
        const recovery: SettlementRecovery = error.recovery ?? { code: "request_invalid", retryable: false, action: "Inspect this command error and correct the settlement request or ask the manager to reconcile its saved claim. Do not repeat unchanged arguments.", employeeId: null, generation: null, claimId: null };
        const failure = new EmployeeSettlementError(error.message, recovery, false);
        rejectedSettlements.set(recovery.code === "result_replay_conflict" ? exactFingerprint : fingerprint, failure);
        throw failure;
      }
    },
    isClosed: () => closed,
    settlementBlock: () => settlementBlocked?.message ?? commandBlocked?.message ?? null,
    async poll(settingsReport?: OmpSessionSettingsReport): Promise<EmployeePoll> {
      const unchanged = settingsReport !== undefined && previousReport !== undefined && settingsReport.nativeSession === previousReport.nativeSession && settingsReport.agentSessionId === previousReport.agentSessionId && (
        settingsReport.status === "unavailable" && previousReport.status === "unavailable" && settingsReport.reason === previousReport.reason ||
        settingsReport.status === "available" && previousReport.status === "available" && settingsReport.availableModels === previousReport.availableModels && settingsReport.availableEfforts === previousReport.availableEfforts && encode(settingsReport.model) === encode(previousReport.model) && settingsReport.configuredEffort === previousReport.configuredEffort && settingsReport.effectiveEffort === previousReport.effectiveEffort);
      const report: Json | null = settingsReport === undefined || unchanged ? null : jsonSchema.parse(ompSessionSettingsReportSchema.parse(settingsReport));
      const pollRequest = (): Promise<Json> => report === null ? exchange("GET", "/poll", null) : exchange("POST", "/poll", { sequence: ++sampleSequence, report });
      const body: Json = await pollRequest();
      previousReport = settingsReport;
      const parsed = pollSchema.safeParse(body);
      if (!parsed.success)
        throw new EmployeeClientError(`Startup GET /poll HTTP 200 returned an invalid employee projection: ${redact(parsed.error.message)}`);
      const nextClaimState: string | null = /^STARTUP_CLAIMS=(.+)$/m.exec(parsed.data.projection)?.[1] ?? null;
      if (nextClaimState !== null && claimState !== null && nextClaimState !== claimState) { rejectedSettlements.clear(); settlementBlocked = null; rejectedCommands.clear(); commandBlocked = null; }
      claimState = nextClaimState;
      return parsed.data;
    },
    close(): void {
      closed = true;
      shutdown.abort();
      lifetime?.close();
    },
    async disconnect(): Promise<void> {
      const capturedConnection = connection;
      closed = true;
      shutdown.abort();
      try {
        if (capturedConnection === null) throw new EmployeeClientError("Admission already lost; owner revocation acknowledgement is unavailable");
        const response = await fetch("http://localhost/disconnect", { unix: admitted.socketPath, method: "POST", headers: { Authorization: `Bearer ${capturedConnection}` }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new EmployeeClientError(`Startup disconnect HTTP ${response.status}: ${redact(await response.text())}`);
        z.strictObject({ revoked: z.literal(true) }).parse(await response.json());
      } finally { lifetime?.close(); }
    },
  };
}

export function installEmployeeBridge(host: EmployeeBridgeHost, input: Readonly<{
  client: EmployeeClient;
  ctx: NativeContext;
  intervalMs: number;
  instructions: string;
  settingsReport?: () => OmpSessionSettingsReport;
  lastAssistant?: unknown;
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
  const notified: Set<string> = new Set();
  let wakeQueued: boolean = false;
  let inferencePaused: boolean = false;
  let current: EmployeePoll | null = null;
  let failure: string | null = null;
  let failureStartedAt: number | null = null;
  let failureIdentity: string | null = null;
  let pending: Promise<void> | null = null;
  let closed: boolean = false;
  let continuedReason: string | null = null;
  let releasePending: boolean = false;
  let turnHeld: boolean = true;
  let turnBlocked: string | null = null;
  const rootFile = input.ctx.sessionManager.getSessionFile();
  function isRoot(ctx: NativeContext): boolean {
    return ctx.agent.kind === "main" && ctx.agent.id === rootId && ctx.sessionManager.getSessionFile() === rootFile &&
      ctx.sessionManager.getSessionId() === rootSession;
  }
  function observeAssistant(message: unknown): void {
    const parsed = z.object({ role: z.literal("assistant"), stopReason: z.literal("error") }).safeParse(message);
    if (!parsed.success || inferencePaused) return;
    inferencePaused = true;
    host.sendMessage({ customType: "startup-inference-paused", content: "Startup inference paused after a provider error. Authenticated polling remains active; inbox, claims and crew state are retained. Inspect the native provider error, correct its cause, then submit interactive/RPC input in this pane to resume. Automatic cues and stop continuations cannot retry it.", display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
  }
  observeAssistant(input.lastAssistant);
  async function refresh(): Promise<void> {
    try {
      if (!isRoot(input.ctx)) { close(); throw new EmployeeClientError("Native session changed before heartbeat"); }
      const next: EmployeePoll = await input.client.poll(input.settingsReport?.());
      if (!isRoot(input.ctx)) { close(); throw new EmployeeClientError("Native session changed during heartbeat"); }
      if (turnHeld && nativeIdle() && !nativePending()) releasePending = true;
      if (releasePending) { await input.client.request({ kind: "end_turn" }); releasePending = false; turnHeld = false; }
      if (closed) return;
      current = next;
      if (failure !== null) {
        const outageMs: number = Date.now() - (failureStartedAt ?? Date.now());
        const resumeWork: boolean = !inferencePaused && !wakeQueued && input.client.settlementBlock() === null && next.waitReason !== null && nativeIdle() && !nativePending();
        host.sendMessage({ customType: "startup-connection-restored", content: `Startup coordinator connection restored; authenticated polling resumed. outageMs=${outageMs}`, display: true }, { triggerTurn: resumeWork, deliverAs: "nextTurn" });
        if (resumeWork) wakeQueued = true;
        process.stderr.write(JSON.stringify({ level: "info", component: "startup-connection", state: "restored", outageMs, observedAt: Date.now() }) + "\n");
      }
      failure = null;
      failureStartedAt = null;
      failureIdentity = null;
      for (const id of notified.keys()) if (!next.pendingMessageIds.includes(id)) notified.delete(id);
      const due: boolean = next.pendingMessageIds.some((id) => !notified.has(id));
      if (due && !inferencePaused && !wakeQueued && input.client.settlementBlock() === null && nativeIdle()) {
        host.sendMessage({
          customType: "startup-cue",
          content: `Startup inbox has ${next.pendingMessageIds.length} durable message(s). Claim your own inbox and follow the canonical loop.`,
          display: false,
        }, { triggerTurn: true, deliverAs: "nextTurn" });
        wakeQueued = true;
        for (const id of next.pendingMessageIds) notified.add(id);
      }
    } catch (error: unknown) {
      if (closed) return;
      const reason: string = error instanceof Error ? error.message : String(error);
      const identity: string = error instanceof EmployeeTransportError
        ? JSON.stringify({ ...error.diagnostic, elapsedMs: 0 }) : reason;
      if (failureStartedAt === null) failureStartedAt = Date.now();
      if (failureIdentity !== identity) {
        host.sendMessage({
          customType: "startup-connection-error",
          content: `Startup coordinator unavailable: ${reason}`,
          display: true,
        }, { triggerTurn: false, deliverAs: "nextTurn" });
        process.stderr.write(JSON.stringify({ level: "warn", component: "startup-connection", state: "unavailable", error: reason, ...(error instanceof EmployeeTransportError ? { transport: error.diagnostic } : {}), observedAt: Date.now() }) + "\n");
      }
      failure = reason;
      failureIdentity = identity;
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
    if (inferencePaused) { abortTurn(); return; }
    try { await poll(); await input.client.request({ kind: "begin_turn" }); turnHeld = true; turnBlocked = null; }
    catch (error: unknown) {
      turnBlocked = error instanceof Error ? error.message : String(error);
      abortTurn();
      host.sendMessage({ customType: "startup-turn-blocked", content: `Startup turn blocked: ${turnBlocked}`, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
    }
  }
  function projectedState(): string {
    const projection: string = current?.projection ?? "Startup employee is blocked until its canonical source and coordinator connection are admitted.";
    return projection.startsWith(input.instructions) ? projection.slice(input.instructions.length).trimStart() : projection;
  }
  host.on("before_agent_start", async (event, ctx) => {
    if (closed || !isRoot(ctx)) return;
    const parsed = beforeStartSchema.parse(event);
    wakeQueued = true;
    try { await admitTurn(); } finally { wakeQueued = false; }
    return { systemPrompt: [...parsed.systemPrompt, input.instructions] };
  });
  host.on("context", async (event, ctx) => {
    if (closed || !isRoot(ctx)) return;
    const parsed = contextSchema.parse(event);
    wakeQueued = true;
    try { await admitTurn(); } finally { wakeQueued = false; }
    const state: string = projectedState();
    return { messages: state.length === 0 ? parsed.messages : [
      ...parsed.messages,
      { role: "user", content: state, timestamp: Date.now() },
    ] };
  });
  host.on("tool_call", (event, ctx) => {
    if (closed) return;
    const employeeTool: boolean = isEmployeeTool(event);
    if (!isRoot(ctx))
      return employeeTool ? { block: true, reason: "Native helper has no Startup employee authority" } : undefined;
    if (inferencePaused) return { block: true, reason: "Startup inference is paused after a provider error; explicit root input is required to resume" };
    if (turnBlocked !== null) return { block: true, reason: turnBlocked };
    if (failure !== null)
      return { block: true, reason: `Startup coordinator unavailable: ${failure}` };
    if (!employeeTool && input.client.settlementBlock() !== null)
      return { block: true, reason: input.client.settlementBlock() ?? "Settlement requires correction" };
    if (!employeeTool && current?.toolBlockReason !== null && current?.toolBlockReason !== undefined)
      return { block: true, reason: current.toolBlockReason };
    if (employeeTool && current === null)
      return { block: true, reason: "Startup employee projection is not admitted yet" };
    return;
  });
  host.on("message_end", (event, ctx) => {
    if (closed || !isRoot(ctx)) return;
    const parsed = z.object({ message: z.unknown() }).safeParse(event);
    if (parsed.success) observeAssistant(parsed.data.message);
  });
  function resumeInput(event: unknown, ctx: NativeContext): void {
    if (closed || !isRoot(ctx)) return;
    const parsed = z.object({ source: z.enum(["interactive", "rpc"]) }).safeParse(event);
    if (!parsed.success) return;
    inferencePaused = false;
    wakeQueued = false;
    continuedReason = null;
  }
  host.on("input", resumeInput);
  host.on("input_submitted", resumeInput);
  host.on("agent_end", async (event, ctx) => {
    if (closed || !isRoot(ctx)) return;
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
    if (closed || !isRoot(ctx)) return;
    const stopped = z.object({ last_assistant_message: z.unknown() }).safeParse(_event);
    if (stopped.success) observeAssistant(stopped.data.last_assistant_message);
    if (inferencePaused) return;
    const failureReason = failure === null ? null : `Startup coordinator unavailable: ${failure}`;
    if (failureReason !== null) {
      if (continuedReason === failureReason) return;
      continuedReason = failureReason;
      return { continue: true, additionalContext: failureReason };
    }
    await poll();
    if (input.client.settlementBlock() !== null) return;
    const reason: string | null = projection().waitReason;
    if (reason === null) { continuedReason = null; return; }
    if (continuedReason === reason) return;
    continuedReason = reason;
    return { continue: true, additionalContext: reason };
  });
  host.on("session_start", (_event, ctx) => { if (ctx.agent.kind === "main" && !isRoot(ctx)) close(); });
  host.on("session_shutdown", (_event, ctx) => { if (ctx.agent.kind === "main") close(); });
  return { poll, close };
}
