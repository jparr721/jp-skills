import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkflowOutcome } from "./workflow-engine";

/** Minimal interface implemented by the session's shared workflow authority. */
export type ClaudeBoundedAuthority = Readonly<{
  reserve(scopeId: string, itemId: string, assignmentKey: string): string;
  settle(scopeId: string, reservationId: string, outcome: WorkflowOutcome): void;
  settleRole(scopeId: string, reservationId: string, receipt: { itemId: string; role: "architect" | "dev" | "qa"; agentId: string; head: string; evidence: Record<string, string> }): void;
  plan?(scopeId: string, effect: (reservationId: string) => Promise<{ reservationId: string; status: "accepted" }>): Promise<unknown>;
  settlePlan?(scopeId: string, reservationId: string, outcome: WorkflowOutcome): void;
  completePlan?(scopeId: string, reservationId: string, plan: { dependencies: Record<string, string[]>; targets: Record<string, string[]> }): void;
  reserveReview?(scopeId: string, changes: readonly { changeId: string; head: string }[]): string;
  settleReview?(scopeId: string, reservationId: string, changes: readonly { changeId: string; head: string }[], verdict: "approve" | "changes-requested" | "block" | "uncertain"): void;
  recordReviewActor?(scopeId: string, reservationId: string, agentId: string): void;
}>;
type Role = "architect" | "dev" | "qa";
type Assignment = { scopeId: string; itemId: string; reservationId: string; marker: string; role?: Role; worktree?: string; planner?: boolean; review?: readonly { changeId: string; head: string; worktree: string }[]; toolId: string | null; terminal: boolean; uncertain: boolean };
const common = { session_id: z.string().min(1), tool_name: z.literal("Agent"), tool_use_id: z.string().min(1), agent_id: z.string().optional() };
const pre = z.looseObject({ ...common, hook_event_name: z.literal("PreToolUse"), tool_input: z.looseObject({ prompt: z.string(), run_in_background: z.boolean().optional(), resume: z.unknown().optional() }) });
const post = z.looseObject({ ...common, hook_event_name: z.literal("PostToolUse"), tool_response: z.looseObject({ status: z.string(), agentId: z.string().min(1), content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional() }) });
const failure = z.looseObject({ ...common, hook_event_name: z.literal("PostToolUseFailure") });
const proof = z.strictObject({ role: z.enum(["architect", "dev", "qa"]), itemId: z.string().min(1), head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), verdict: z.literal("pass"), evidence: z.record(z.string().min(1), z.string().min(1)) });
const planProof = z.strictObject({ dependencies: z.record(z.string().min(1), z.array(z.string().min(1))), targets: z.record(z.string().min(1), z.array(z.string().min(1))) });
const reviewProof = z.strictObject({ changes: z.array(z.strictObject({ changeId: z.string().min(1), head: z.string().min(1), worktree: z.string().min(1) })).min(1), verdict: z.enum(["approve", "changes-requested", "block"]) });
const genericProof = z.strictObject({ status: z.literal("completed"), result: z.string().min(1) });
const required: Record<Role, readonly string[]> = { architect: ["findings", "decision"], dev: ["implementation", "artifact"], qa: ["method", "result", "artifact"] };
const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/**
 * Claude's documented foreground Agent PreToolUse/PostToolUse surfaces share
 * tool_use_id. This adapter accepts hook events only from its enclosing transport;
 * the transport must not expose hook delivery as an ordinary model-callable tool.
 * Hook events and same-user local processes are not cryptographically authenticated.
 */
export class ClaudeBoundedHost {
  private readonly assignments = new Map<string, Assignment>();
  private readonly calls = new Map<string, Assignment>();
  private readonly agents = new Set<string>();
  private readonly results = new Map<string, { agentId: string; content: readonly { type: string; text?: string | undefined }[] }>();
  constructor(private readonly input: Readonly<{
    sessionId: string;
    authority: ClaudeBoundedAuthority;
    limit: number;
    validateRole: (input: { worktree: string; head: string }) => boolean;
    validatePlan?: (targets: Record<string, string[]>) => boolean;
  }>) {
    if (!input.sessionId || !Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error("A session and positive runtime budget are required");
  }

  prepare(input: { scopeId: string; itemId: string; assignmentKey: string; role?: Role; worktree?: string }): { reservationId: string; marker: string } {
    if ([...this.assignments.values()].filter((entry) => !entry.terminal || entry.uncertain).length >= this.input.limit) throw new Error("Runtime budget exhausted");
    if ((input.role === undefined) !== (input.worktree === undefined)) throw new Error("Role and worktree must be supplied together");
    const reservationId = this.input.authority.reserve(input.scopeId, input.itemId, input.assignmentKey);
    const marker = `JP_WORKFLOW_ASSIGNMENT:${randomUUID()}`;
    this.assignments.set(marker, { ...input, reservationId, marker, toolId: null, terminal: false, uncertain: false });
    return { reservationId, marker };
  }
  async preparePlanner(scopeId: string): Promise<{ reservationId: string; marker: string }> {
    if ([...this.assignments.values()].some((entry) => !entry.terminal || entry.uncertain)) throw new Error("Planner requires an idle runtime budget");
    if (!this.input.authority.plan || !this.input.authority.completePlan || !this.input.authority.settlePlan) throw new Error("Shared planner authority unavailable");
    let prepared: { reservationId: string; marker: string } | undefined;
    await this.input.authority.plan(scopeId, async (reservationId) => {
      const marker = `JP_WORKFLOW_ASSIGNMENT:${randomUUID()}`;
      this.assignments.set(marker, { scopeId, itemId: "", planner: true, reservationId, marker, toolId: null, terminal: false, uncertain: false });
      prepared = { reservationId, marker };
      return { reservationId, status: "accepted" };
    });
    if (!prepared) throw new Error("Planner reservation was not committed");
    return prepared;
  }
  prepareReview(scopeId: string, changes: readonly { changeId: string; head: string; worktree: string }[]): { reservationId: string; marker: string } {
    if ([...this.assignments.values()].filter((entry) => !entry.terminal || entry.uncertain).length >= this.input.limit) throw new Error("Runtime budget exhausted");
    if (!this.input.authority.reserveReview || !this.input.authority.settleReview || !this.input.authority.recordReviewActor || changes.some((change) => !this.input.validateRole({ worktree: change.worktree, head: change.head }))) throw new Error("Review authority or current worktree unavailable");
    const reservationId = this.input.authority.reserveReview(scopeId, changes);
    const marker = `JP_WORKFLOW_ASSIGNMENT:${randomUUID()}`;
    this.assignments.set(marker, { scopeId, itemId: "", reservationId, marker, review: changes.map((change) => ({ ...change })), toolId: null, terminal: false, uncertain: false });
    return { reservationId, marker };
  }


  result(scopeId: string, reservationId: string): { agentId: string; content: readonly { type: string; text?: string | undefined }[] } | null {
    const entry = [...this.assignments.values()].find((value) => value.scopeId === scopeId && value.reservationId === reservationId);
    return entry ? this.results.get(reservationId) ?? null : null;
  }


  hook(raw: unknown): Record<string, unknown> {
    const before = pre.safeParse(raw);
    if (before.success) {
      const event = before.data;
      if (event.session_id !== this.input.sessionId || event.agent_id) return deny("Only the bounded root session can dispatch an assignment");
      const matches = [...this.assignments.values()].filter((entry) => event.tool_input.prompt.includes(entry.marker));
      const entry = matches[0];
      if (matches.length !== 1 || !entry || entry.terminal || entry.toolId !== null || this.calls.has(event.tool_use_id)) return deny("Agent call lacks a unique pending bounded assignment");
      if (event.tool_input.run_in_background || event.tool_input.resume !== undefined) return deny("Bounded Agent calls must start a fresh foreground agent");
      entry.toolId = event.tool_use_id;
      this.calls.set(event.tool_use_id, entry);
      return {};
    }
    if (z.object({ hook_event_name: z.literal("PreToolUse") }).safeParse(raw).success) return deny("Malformed bounded Agent hook input");
    const after = post.safeParse(raw);
    if (after.success) {
      const event = after.data;
      const entry = this.calls.get(event.tool_use_id);
      if (!entry || entry.terminal || event.session_id !== this.input.sessionId || event.agent_id) return {};
      if (event.tool_response.status !== "completed" || !event.tool_response.content || this.agents.has(event.tool_response.agentId)) { this.uncertain(entry); return {}; }
      this.agents.add(event.tool_response.agentId);
      this.results.set(entry.reservationId, { agentId: event.tool_response.agentId, content: event.tool_response.content });
      if (entry.planner) {
        try {
          const blocks = event.tool_response.content?.filter((block) => block.type === "text") ?? [];
          if (blocks.length !== 1 || !blocks[0]?.text || !this.input.authority.completePlan) throw new Error("Missing planner result");
          const result = planProof.parse(JSON.parse(blocks[0].text));
          if (this.input.validatePlan && !this.input.validatePlan(result.targets)) throw new Error("Planner targets exceed frozen landing policy");
          this.input.authority.completePlan(entry.scopeId, entry.reservationId, result);
          entry.terminal = true;
        } catch { this.uncertain(entry); }
        return {};
      }
      if (entry.review) {
        try {
          const blocks = event.tool_response.content?.filter((block) => block.type === "text") ?? [];
          if (blocks.length !== 1 || !blocks[0]?.text || !this.input.authority.settleReview || !this.input.authority.recordReviewActor) throw new Error("Missing review result");
          const result = reviewProof.parse(JSON.parse(blocks[0].text));
          if (result.changes.length !== entry.review.length || entry.review.some((change) => !result.changes.some((item) => item.changeId === change.changeId && item.head === change.head && item.worktree === change.worktree) || !this.input.validateRole({ worktree: change.worktree, head: change.head }))) throw new Error("Review does not match the reserved heads");
          this.input.authority.recordReviewActor(entry.scopeId, entry.reservationId, `${this.input.sessionId}:${event.tool_response.agentId}`);
          this.input.authority.settleReview(entry.scopeId, entry.reservationId, entry.review, result.verdict);
          entry.terminal = true;
        } catch { this.uncertain(entry); }
        return {};
      }
      if (!entry.role) {
        try {
          const blocks = event.tool_response.content.filter((block) => block.type === "text");
          if (blocks.length !== 1 || !blocks[0]?.text) throw new Error("Missing assignment result");
          genericProof.parse(JSON.parse(blocks[0].text));
          this.input.authority.settle(entry.scopeId, entry.reservationId, "completed");
          entry.terminal = true;
        } catch { this.uncertain(entry); }
        return {};
      }
      try {
        const blocks = event.tool_response.content?.filter((block) => block.type === "text") ?? [];
        if (blocks.length !== 1 || !blocks[0]?.text || !entry.worktree) throw new Error("Missing role result");
        const result = proof.parse(JSON.parse(blocks[0].text));
        if (result.itemId !== entry.itemId || result.role !== entry.role || required[entry.role].some((key) => !result.evidence[key]) || !this.input.validateRole({ worktree: entry.worktree, head: result.head })) throw new Error("Role result mismatch");
        this.input.authority.settleRole(entry.scopeId, entry.reservationId, { itemId: result.itemId, role: result.role, agentId: `${this.input.sessionId}:${event.tool_response.agentId}`, head: result.head, evidence: result.evidence });
        entry.terminal = true;
      } catch { this.uncertain(entry); }
      return {};
    }
    const failed = failure.safeParse(raw);
    if (failed.success && failed.data.session_id === this.input.sessionId && !failed.data.agent_id) {
      const entry = this.calls.get(failed.data.tool_use_id);
      if (entry && !entry.terminal) this.uncertain(entry);
    }
    return {};
  }

  close(): void { for (const entry of this.assignments.values()) if (!entry.terminal) this.uncertain(entry); }
  private uncertain(entry: Assignment): void {
    if (entry.planner) {
      if (!this.input.authority.settlePlan) throw new Error("Planner authority unavailable");
      this.input.authority.settlePlan(entry.scopeId, entry.reservationId, "uncertain");
    } else if (entry.review) {
      if (!this.input.authority.settleReview) throw new Error("Review authority unavailable");
      this.input.authority.settleReview(entry.scopeId, entry.reservationId, entry.review, "uncertain");
    } else this.input.authority.settle(entry.scopeId, entry.reservationId, "uncertain");
    entry.terminal = true;
    entry.uncertain = true;
  }
}
