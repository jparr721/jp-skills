import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { BoundedWorkflowHost } from "./workflow-host";
import { ClaudeBoundedHost } from "./claude-bounded-host";

const text = z.string().trim().min(1);
const role = z.enum(["architect", "dev", "qa"]);
const tools = {
  bounded_begin: { description: "Create one session-local fixed factory, pipeline or hotfix scope. Factory planning must run through bounded_plan before assignments.", schema: z.strictObject({ workflow: z.enum(["factory", "pipeline", "hotfix"]), itemIds: z.array(text).min(1), reviewLimit: z.number().int(), runtimeLimit: z.number().int().min(1), target: text, landing: z.enum(["merged", "ready-pr"]), allowedChildTargets: z.array(text) }) },
  bounded_plan: { description: "Reserve the native factory planner; include the returned marker in one foreground Agent prompt and request a single JSON object with dependencies and targets keyed by every item.", schema: z.strictObject({ scopeId: text }) },
  bounded_prepare: { description: "Reserve an assignment before calling foreground Agent with the marker. For a non-role assignment request a single JSON object {status:'completed',result:'...'}. For roles request JSON with role,itemId,head,verdict=pass,evidence; evidence keys: architect findings/decision, dev implementation/artifact, qa method/result/artifact.", schema: z.strictObject({ scopeId: text, itemId: text, assignmentKey: text, role: role.optional(), worktree: text.optional() }) },
  bounded_review: { description: "Reserve an independent foreground reviewer. Include the marker and request a JSON object with exactly changes and verdict (approve, changes-requested, block).", schema: z.strictObject({ scopeId: text, changes: z.array(z.strictObject({ changeId: text, head: text, worktree: text })).min(1) }) },
  bounded_ready: { description: "Mark prerequisite ready after role gates and a verified open pull request.", schema: z.strictObject({ scopeId: text, itemId: text, worktree: text, head: text, prNumber: z.number().int().positive() }) },
  bounded_complete: { description: "Complete only after role and independent-review gates and verified PR landing.", schema: z.strictObject({ scopeId: text, itemId: text, worktree: text, head: text, prNumber: z.number().int().positive() }) },
  bounded_status: { description: "Read the shared authority's scoped state.", schema: z.strictObject({ scopeId: text }) },
  bounded_result: { description: "Read a correlated foreground Agent result, if observed.", schema: z.strictObject({ scopeId: text, reservationId: text }) },
  bounded_nest: { description: "Create a nested scope within the fixed parent queue and inherited review limit.", schema: z.strictObject({ parentId: text, workflow: z.enum(["pipeline", "hotfix"]), itemIds: z.array(text).min(1), reviewLimit: z.number().int(), target: text }) },
};
const rpc = z.looseObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: text, params: z.unknown().optional() });
const call = z.looseObject({ name: text, arguments: z.unknown().optional() });
const hookIdentity = z.looseObject({ hook_event_name: z.literal("PreToolUse"), session_id: text, tool_name: text, agent_id: z.string().optional() });

export class ClaudeBoundedController {
  private authority: BoundedWorkflowHost | undefined;
  private native: ClaudeBoundedHost | undefined;
  private readonly targets = new Map<string, { target: string; allowed: readonly string[]; landing: "merged" | "ready-pr" }>();
  constructor(private readonly sessionId: string, private readonly cwd: string) {}
  hook(raw: unknown): Record<string, unknown> {
    const parsed = hookIdentity.safeParse(raw);
    if (parsed.success && parsed.data.tool_name.startsWith("mcp__bounded__")) {
      if (parsed.data.session_id !== this.sessionId || parsed.data.agent_id) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Only the root session may control the bounded authority" } };
      return {};
    }
    if (!this.native && parsed.success) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Create a bounded scope before dispatching Agent" } };
    return this.native?.hook(raw) ?? {};
  }
  close(): void { this.native?.close(); }
  private git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
  private verifyWorktree(worktree: string, head?: string): boolean {
    try {
      const cwd = realpathSync(worktree);
      return cwd === worktree && realpathSync(this.git(cwd, "rev-parse", "--show-toplevel")) === cwd && realpathSync(resolve(cwd, this.git(cwd, "rev-parse", "--git-common-dir"))) === realpathSync(resolve(this.cwd, this.git(this.cwd, "rev-parse", "--git-common-dir"))) && (head === undefined || this.git(cwd, "rev-parse", "HEAD") === head);
    } catch { return false; }
  }
  async request(raw: unknown): Promise<unknown> {
    const request = rpc.parse(raw);
    if (request.id === undefined) return {};
    const id = request.id;
    try {
      if (request.method === "initialize") {
        const version = z.looseObject({ protocolVersion: text }).parse(request.params).protocolVersion;
        return { jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "bounded", version: "1.0.0" }, instructions: "Use bounded_begin first. Reserve each Agent call with bounded_plan or bounded_prepare; use the marker in its foreground prompt. Background or missing receipts remain uncertain. Only the root controls this authority." } };
      }
      if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: Object.entries(tools).map(([name, spec]) => ({ name, description: spec.description, inputSchema: z.toJSONSchema(spec.schema) })) } };
      if (request.method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
      const input = call.parse(request.params);
      const value = await this.execute(input.name, input.arguments ?? {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } };
    } catch (error: unknown) {
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } };
    }
  }
  private async execute(name: string, args: unknown): Promise<unknown> {
    if (name === "bounded_begin") {
      if (this.authority) throw new Error("This session already has a bounded authority");
      const input = tools.bounded_begin.schema.parse(args);
      for (const target of [input.target, ...input.allowedChildTargets]) this.git(this.cwd, "check-ref-format", `refs/heads/${target}`);
      const authority = new BoundedWorkflowHost(input.workflow, input.itemIds, input.reviewLimit);
      const allowed = [input.target, ...input.allowedChildTargets];
      this.native = new ClaudeBoundedHost({ sessionId: this.sessionId, authority, limit: input.runtimeLimit, validateRole: ({ worktree, head }) => this.verifyWorktree(worktree, head), validatePlan: (targets) => Object.values(targets).every((entries) => entries.every((entry) => allowed.includes(entry))) });
      this.authority = authority;
      this.targets.set(authority.rootId, { target: input.target, allowed, landing: input.landing });
      return { scopeId: authority.rootId, view: authority.view(authority.rootId), durable: false };
    }
    const authority = this.authority;
    const native = this.native;
    if (!authority || !native) throw new Error("Create a bounded scope first");
    if (name === "bounded_plan") {
      const input = tools.bounded_plan.schema.parse(args);
      return native.preparePlanner(input.scopeId);
    }
    if (name === "bounded_prepare") {
      const input = tools.bounded_prepare.schema.parse(args);
      if (input.role && input.worktree && !this.verifyWorktree(input.worktree)) throw new Error("Role worktree must be a canonical worktree of this repository");
      if (authority.view(input.scopeId).workflow === "hotfix" && input.role && input.role !== "dev") throw new Error("Hotfix permits only the dev role");
      return native.prepare({ scopeId: input.scopeId, itemId: input.itemId, assignmentKey: input.assignmentKey, ...(input.role === undefined ? {} : { role: input.role }), ...(input.worktree === undefined ? {} : { worktree: input.worktree }) });
    }
    if (name === "bounded_review") {
      const input = tools.bounded_review.schema.parse(args);
      return native.prepareReview(input.scopeId, input.changes);
    }
    if (name === "bounded_ready" || name === "bounded_complete") {
      const input = tools.bounded_complete.schema.parse(args);
      const policy = this.targets.get(input.scopeId);
      if (!policy || !this.verifyWorktree(input.worktree, input.head) || this.git(input.worktree, "status", "--porcelain") !== "") throw new Error("Scoped worktree and head must be clean and current");
      const pr = z.object({ headRefOid: text, baseRefName: text, state: text, isDraft: z.boolean(), url: text, mergeCommit: z.object({ oid: text }).nullable() }).parse(JSON.parse(execFileSync("gh", ["pr", "view", String(input.prNumber), "--json", "headRefOid,baseRefName,state,isDraft,url,mergeCommit"], { cwd: input.worktree, encoding: "utf8" })));
      if (pr.headRefOid !== input.head || pr.baseRefName !== policy.target) throw new Error("PR does not match scoped head and target");
      if (name === "bounded_ready") {
        if (pr.state !== "OPEN") throw new Error("Prerequisite PR is not open");
        authority.ready(input.scopeId, input.itemId, input.head);
      } else {
        if (policy.landing === "merged") {
          if (pr.state !== "MERGED" || !pr.mergeCommit) throw new Error("PR has not merged");
          this.git(input.worktree, "merge-base", "--is-ancestor", pr.mergeCommit.oid, `refs/remotes/origin/${policy.target}`);
        } else if (pr.state !== "OPEN" || pr.isDraft) throw new Error("PR is not open and ready");
        authority.complete(input.scopeId, input.itemId, input.head);
      }
      return { itemId: input.itemId, head: input.head, pr: pr.url, outcome: name === "bounded_ready" ? "ready" : "completed" };
    }
    if (name === "bounded_status") {
      const input = tools.bounded_status.schema.parse(args);
      return authority.view(input.scopeId);
    }
    if (name === "bounded_result") {
      const input = tools.bounded_result.schema.parse(args);
      return native.result(input.scopeId, input.reservationId);
    }
    if (name === "bounded_nest") {
      const input = tools.bounded_nest.schema.parse(args);
      const parent = this.targets.get(input.parentId);
      if (!parent || !parent.allowed.includes(input.target)) throw new Error("Target is outside the parent policy");
      if (authority.view(input.parentId).workflow === "factory") {
        const planned = authority.plannedTargets(input.parentId);
        if (input.itemIds.some((item) => !planned[item]?.includes(input.target))) throw new Error("Target is outside the frozen item plan");
      }
      const scopeId = authority.nest(input.parentId, input.workflow, input.itemIds, input.reviewLimit);
      this.targets.set(scopeId, { target: input.target, allowed: parent.allowed, landing: parent.landing });
      return { scopeId, view: authority.view(scopeId) };
    }
    throw new Error("Unknown bounded tool");
  }
}
