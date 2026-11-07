import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";

const reviewSchema = z.strictObject({ scopeId: z.string().min(1), itemId: z.string().min(1), assignmentKey: z.string().min(1), reviewId: z.string().min(1), reviewerId: z.string().min(1), head: z.string().min(1), worktree: z.string().min(1) });
const dispatchSchema = z.object({ type: z.literal("tool_execution_start"), toolName: z.literal("task"), toolCallId: z.string().min(1), args: z.object({ scopeId: z.string(), itemId: z.string(), assignmentKey: z.string(), tasks: z.array(z.object({ name: z.string(), agent: z.literal("reviewer") })).length(1), review: z.array(z.object({ changeId: z.string(), head: z.string(), worktree: z.string() })).length(1) }) });
const progressSchema = z.object({ type: z.literal("subagent_progress"), payload: z.object({ agent: z.enum(["reviewer", "security-reviewer"]), parentToolCallId: z.string().min(1), sessionFile: z.string().min(1), assignment: z.string(), progress: z.object({ id: z.string().min(1) }) }) });
const lifecycleSchema = z.object({ type: z.literal("subagent_lifecycle"), payload: z.object({ id: z.string(), agent: z.enum(["reviewer", "security-reviewer"]), status: z.enum(["started", "completed", "failed", "cancelled"]), parentToolCallId: z.string().min(1), sessionFile: z.string().min(1) }) });
const transcriptSchema = z.object({ sessionFile: z.string().min(1), messages: z.array(z.object({ role: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })) });
const resultSchema = z.strictObject({ changes: z.array(z.strictObject({ changeId: z.string(), head: z.string(), worktree: z.string() })).length(1), verdict: z.enum(["approve", "changes-requested", "block"]) });
export class OmpRpcStartupError extends Error {}
export class OmpReviewRejectedError extends Error {}
export type ExpectedReview = z.infer<typeof reviewSchema>;
const completionSchema = z.strictObject({ itemId: z.string().min(1), reviewId: z.string().min(1), head: z.string().min(1), worktree: z.string().min(1), prNumber: z.number().int().positive() });
export type CompletionHint = z.infer<typeof completionSchema>;
const reportSchema = z.strictObject({ eventId: z.string().min(1), kind: z.enum(["question", "progress"]), text: z.string().min(1).max(16384) });
export type RunReport = z.infer<typeof reportSchema>;

export function createReviewObservation(input: Readonly<{ review: ExpectedReview; token: string; events: readonly unknown[]; transcript: unknown }>): Readonly<{ reviewId: string; reviewerId: string; invocationId: string; head: string; verdict: "approve" | "changes-requested" | "block" | "invalid"; sessionFile: string }> {
  const review = reviewSchema.parse(input.review);
  if (!input.token) throw new Error("Review reservation token is missing");
  const progress = input.events.flatMap((event) => { const parsed = progressSchema.safeParse(event); return parsed.success && parsed.data.payload.assignment.includes(`review-token:${input.token}`) ? [parsed.data.payload] : []; });
  const observed = progress[0];
  if (!observed || !observed.assignment.includes(JSON.stringify([{ changeId: review.itemId, head: review.head, worktree: review.worktree }])) || observed.progress.id !== review.reviewerId || progress.some((entry) => entry.progress.id !== observed.progress.id || entry.parentToolCallId !== observed.parentToolCallId || entry.sessionFile !== observed.sessionFile || entry.agent !== observed.agent)) throw new Error("Original native review assignment is unavailable or ambiguous");
  const lifecycle = input.events.flatMap((event) => { const parsed = lifecycleSchema.safeParse(event); return parsed.success && parsed.data.payload.id === review.reviewerId ? [parsed.data.payload] : []; });
  const started = lifecycle.filter((entry) => entry.status === "started");
  const terminal = lifecycle.filter((entry) => entry.status !== "started");
  const first = started[0];
  const last = terminal[0];
  if (started.length !== 1 || terminal.length !== 1 || !first || !last || first.agent !== observed.agent || last.agent !== observed.agent || first.parentToolCallId !== observed.parentToolCallId || last.parentToolCallId !== observed.parentToolCallId || first.sessionFile !== observed.sessionFile || last.sessionFile !== observed.sessionFile) throw new Error("Native reviewer lifecycle is unavailable or mismatched");
  if (last.status === "failed" || last.status === "cancelled") return { reviewId: review.reviewId, reviewerId: review.reviewerId, invocationId: observed.parentToolCallId, head: review.head, verdict: "invalid", sessionFile: first.sessionFile };
  const transcript = transcriptSchema.parse(input.transcript);
  if (transcript.sessionFile !== first.sessionFile) throw new Error("Native reviewer transcript does not match lifecycle");
  const message = [...transcript.messages].reverse().find((entry) => entry.role === "assistant");
  const blocks = message?.content?.filter((block) => block.type === "text") ?? [];
  let verdict: "approve" | "changes-requested" | "block" | "invalid" = "invalid";
  if (blocks.length === 1 && blocks[0]?.text) {
    try {
      const result = resultSchema.safeParse(JSON.parse(blocks[0].text));
      if (result.success && result.data.changes[0]?.changeId === review.itemId && result.data.changes[0]?.head === review.head && result.data.changes[0]?.worktree === review.worktree) verdict = result.data.verdict;
    } catch { verdict = "invalid"; }
  }
  return { reviewId: review.reviewId, reviewerId: review.reviewerId, invocationId: observed.parentToolCallId, head: review.head, verdict, sessionFile: first.sessionFile };
}

const responseSchema = z.object({ id: z.string(), type: z.literal("response"), command: z.string(), success: z.boolean(), error: z.string().optional(), data: z.unknown().optional() });
const nativeEventSchema = z.union([dispatchSchema, lifecycleSchema, progressSchema]);

export async function startOwnedOmpRpc(input: Readonly<{ binary: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; journalPath: string; timeoutMs: number; reserveReview?: (review: ExpectedReview) => Promise<void>; completeRun?: (hint: CompletionHint) => Promise<void>; reportRun?: (report: RunReport) => Promise<void>; onNativeEvent?: (event: unknown) => void; onCompletedTurn?: () => void; onExit?: () => void }>): Promise<Readonly<{
  pid: number;
  call(command: Readonly<Record<string, unknown>>): Promise<unknown>;
  observeReview(review: ExpectedReview): Promise<ReturnType<typeof createReviewObservation>>;
  close(): Promise<void>;
}>> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error("RPC timeout must be a positive integer");
  const journal = openSync(input.journalPath, "wx", 0o600);
  const write = (value: unknown): void => { writeSync(journal, JSON.stringify(value) + "\n"); fsyncSync(journal); };
  let child: ChildProcessWithoutNullStreams;
  try { child = spawn(input.binary, [...input.args], { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error: unknown) { closeSync(journal); throw new OmpRpcStartupError("OMP RPC process did not start", { cause: error }); }
  if (!child.pid) {
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    closeSync(journal);
    throw new OmpRpcStartupError("OMP RPC process did not start", { cause: error });
  }
  const pid = child.pid;
  const events: unknown[] = [];
  const tokens = new Map<string, string>();
  const reservations = new Map<string, { review: ExpectedReview; token: string; promise: Promise<void> | null; accepted: boolean }>();
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let stopped = false;
  let verifiedCompletion = false;
  let failure: Error | undefined;
  write({ kind: "start", pid, at: new Date().toISOString() });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { failure = new Error("OMP RPC returned invalid JSON"); child.kill(); return; }
    const hostCall = z.object({ type: z.literal("host_tool_call"), id: z.string(), toolName: z.literal("startup_review_reserve"), arguments: reviewSchema }).safeParse(raw);
    if (hostCall.success) {
      const reply = async (): Promise<void> => {
        try {
          if (!input.reserveReview) throw new Error("Coordinator review reservation is unavailable");
          const review = hostCall.data.arguments;
          let reservation = reservations.get(review.reviewId);
          if (reservation && JSON.stringify(reservation.review) !== JSON.stringify(review)) throw new Error("Review reservation identity changed");
          if (!reservation) { reservation = { review, token: randomUUID(), promise: null, accepted: false }; reservations.set(review.reviewId, reservation); }
          if (!reservation.accepted) {
            const current = reservation;
            current.promise ??= input.reserveReview(review);
            try { await current.promise; current.accepted = true; }
            finally { current.promise = null; }
          }
          const token = reservation.token;
          tokens.set(review.reviewId, token);
          child.stdin.write(JSON.stringify({ type: "host_tool_result", id: hostCall.data.id, result: { content: [{ type: "text", text: token }] } }) + "\n");
        } catch (error: unknown) {
          if (error instanceof OmpReviewRejectedError) {
            child.stdin.write(JSON.stringify({ type: "host_tool_result", id: hostCall.data.id, result: { content: [{ type: "text", text: `rejected:${error.message}` }] } }) + "\n");
          } else child.stdin.write(JSON.stringify({ type: "host_tool_result", id: hostCall.data.id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Review reservation failed" }] }, isError: true }) + "\n");
        }
      };
      void reply();
      return;
    }
    const report = z.object({ type: z.literal("host_tool_call"), id: z.string(), toolName: z.literal("startup_run_report"), arguments: reportSchema }).safeParse(raw);
    if (report.success) {
      const reply = async (): Promise<void> => {
        try {
          if (!input.reportRun) throw new Error("Startup reporting is unavailable");
          await input.reportRun(report.data.arguments);
          child.stdin.write(JSON.stringify({ type: "host_tool_result", id: report.data.id, result: { content: [{ type: "text", text: "recorded" }] } }) + "\n");
        } catch (error: unknown) {
          child.stdin.write(JSON.stringify({ type: "host_tool_result", id: report.data.id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Report failed" }] }, isError: true }) + "\n");
        }
      };
      void reply();
      return;
    }
    const completion = z.object({ type: z.literal("host_tool_call"), id: z.string(), toolName: z.literal("startup_run_complete"), arguments: completionSchema }).safeParse(raw);
    if (completion.success) {
      const reply = async (): Promise<void> => {
        try {
          if (!input.completeRun) throw new Error("Coordinator completion verification is unavailable");
          await input.completeRun(completion.data.arguments);
          verifiedCompletion = true;
          child.stdin.write(JSON.stringify({ type: "host_tool_result", id: completion.data.id, result: { content: [{ type: "text", text: "verified" }] } }) + "\n");
        } catch (error: unknown) {
          child.stdin.write(JSON.stringify({ type: "host_tool_result", id: completion.data.id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Completion verification failed" }] }, isError: true }) + "\n");
        }
      };
      void reply();
      return;
    }
    if (verifiedCompletion && typeof raw === "object" && raw !== null && "type" in raw && raw.type === "agent_end") input.onCompletedTurn?.();
    const response = responseSchema.safeParse(raw);
    if (response.success) {
      const request = pending.get(response.data.id);
      if (!request) return;
      pending.delete(response.data.id);
      clearTimeout(request.timer);
      if (response.data.success) request.resolve(response.data); else request.reject(new Error(`OMP RPC ${response.data.command} failed: ${response.data.error ?? "unknown error"}`));
      return;
    }
    const event = nativeEventSchema.safeParse(raw);
    if (event.success) {
      events.push(event.data);
      if (event.data.type !== "subagent_progress") write({ kind: "native-event", event: event.data });
      try { input.onNativeEvent?.(event.data); }
      catch (error: unknown) { failure = error instanceof Error ? error : new Error("Native event handling failed"); child.kill(); }
    }
  });
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      stopped = true;
      input.onExit?.();
      failure ??= new Error(`OMP RPC exited: code=${code} signal=${signal}`);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure); }
      pending.clear();
      write({ kind: "exit", code, signal, at: new Date().toISOString() });
      closeSync(journal);
      resolve();
    });
  });
  const call = (command: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (stopped || failure) return Promise.reject(failure ?? new Error("OMP RPC is closed"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`OMP RPC request timed out: ${String(command.type)}`)); }, input.timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...command, id }) + "\n", (error) => {
        if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    });
  };
  try {
    await call({ type: "set_subagent_subscription", level: "events" });
    const hostedTools: unknown[] = [];
    if (input.reserveReview) hostedTools.push({ name: "startup_review_reserve", description: "Reserve a bounded native review with the Startup owner.", parameters: { type: "object", properties: Object.fromEntries(["scopeId", "itemId", "assignmentKey", "reviewId", "reviewerId", "head", "worktree"].map((key) => [key, { type: "string" }])), required: ["scopeId", "itemId", "assignmentKey", "reviewId", "reviewerId", "head", "worktree"], additionalProperties: false } });
    if (input.completeRun) hostedTools.push({ name: "startup_run_complete", description: "Verify the bounded run with the Startup owner.", parameters: { type: "object", properties: { itemId: { type: "string" }, reviewId: { type: "string" }, head: { type: "string" }, worktree: { type: "string" }, prNumber: { type: "integer" } }, required: ["itemId", "reviewId", "head", "worktree", "prNumber"], additionalProperties: false } });
    if (input.reportRun) hostedTools.push({ name: "startup_run_report", description: "Send a question or progress update to the Startup manager. Use a stable unique eventId for retries.", parameters: { type: "object", properties: { eventId: { type: "string" }, kind: { type: "string", enum: ["question", "progress"] }, text: { type: "string" } }, required: ["eventId", "kind", "text"], additionalProperties: false } });
    if (hostedTools.length) await call({ type: "set_host_tools", tools: hostedTools });
  } catch (error: unknown) { child.kill(); await exited; throw new OmpRpcStartupError("OMP RPC startup failed before any prompt", { cause: error }); }
  return {
    pid,
    call,
    observeReview: async (review) => {
      const terminal = events.flatMap((event) => { const parsed = lifecycleSchema.safeParse(event); return parsed.success && parsed.data.payload.id === review.reviewerId && parsed.data.payload.status !== "started" ? [parsed.data.payload.status] : []; });
      const response = terminal.length === 1 && (terminal[0] === "failed" || terminal[0] === "cancelled") ? undefined : responseSchema.parse(await call({ type: "get_subagent_messages", subagentId: review.reviewerId })).data;
      const token = tokens.get(review.reviewId);
      if (!token) throw new Error("Review reservation token is unavailable");
      const observation = createReviewObservation({ review, token, events, transcript: response });
      write({ kind: "review-observation", observation, at: new Date().toISOString() });
      return observation;
    },
    close: async () => { if (!stopped) child.kill(); await exited; },
  };
}
