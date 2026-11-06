import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { BoundedWorkflowHost } from "./src/workflow-host";
import { connectWorkflowBridge, readRunManifest, startWorkflowBridge, type WorkflowBridge, type WorkflowBridgeClient } from "./src/workflow-bridge";
import { createWorkflowBridgeLauncher, type WorkflowLaunchReceipt, type WorkflowLaunchRequest } from "./src/workflow-bridge-launch";
import { createTernCommandRunner, createTernRuntime, ternContext, ternParentPid } from "./src/tern-runtime";
import { createHerdrRuntime, herdrContext, runHerdrCommand } from "./src/herdr-runtime";

/** Load explicitly with `omp --extension=/absolute/path/to/bounded-entry.ts`.
 * State is session-local: a restart or another host is not an inherited run. */
export default function boundedEntry(pi: ExtensionAPI): void {
  const z = pi.zod;
  const text = z.string().trim().min(1);
  const kind = z.enum(["factory", "pipeline", "hotfix"]);
  const taskItem = z.object({ name: z.string().optional(), agent: z.string().optional(), task: text, solutionSpace: text, tools: z.array(z.string()).optional(), isolated: z.boolean().optional() });
  const progress = z.object({ progress: z.array(z.object({ index: z.number().int(), id: text, agent: text, status: text }).passthrough()) }).passthrough();
  const synchronous = z.object({ results: z.array(z.object({ index: z.number().int(), id: text, exitCode: z.number().int(), aborted: z.boolean().optional() }).passthrough()).min(1) }).passthrough();
  const jobSchema = z.object({ id: text, ownerId: text, agentId: text, type: z.literal("task"), status: z.enum(["running", "completed", "failed", "cancelled"]), promise: z.unknown().refine((value): value is Promise<unknown> => value instanceof Promise), latestDetails: z.unknown() }).passthrough();
  const reviewResult = z.object({ changes: z.array(z.object({ changeId: text, head: text, worktree: text }).strict()), verdict: z.enum(["approve", "changes-requested", "block"]) }).strict();
  const plannerResult = z.object({ dependencies: z.record(z.string(), z.array(text)), targets: z.record(z.string(), z.array(text).min(1)) }).passthrough();
  const roleText = z.string().refine((value) => value.trim().length > 0);
  const roleResult = z.union([
    z.object({ role: z.literal("architect"), itemId: roleText, head: roleText, verdict: z.literal("pass"), evidence: z.object({ findings: roleText, decision: roleText }).strict() }).strict(),
    z.object({ role: z.literal("dev"), itemId: roleText, head: roleText, verdict: z.literal("pass"), evidence: z.object({ implementation: roleText, artifact: roleText }).strict() }).strict(),
    z.object({ role: z.literal("qa"), itemId: roleText, head: roleText, verdict: z.literal("pass"), evidence: z.object({ method: roleText, result: roleText, artifact: roleText }).strict() }).strict(),
  ]);
  const rolePrompt = (kind: "architect" | "dev" | "qa", itemId: string, worktree: string) =>
    `You are assigned the ${kind} role for item ${itemId}. Worktree: ${worktree}. Only return pass if the assigned work is complete. Your final response must be exactly one JSON object, with no prose or additional keys: top-level role (exactly "${kind}"), itemId (exactly ${JSON.stringify(itemId)}), head (the full current Git HEAD commit), verdict (exactly "pass"), and evidence. Evidence must be an object containing exactly ${kind === "architect" ? "findings and decision" : kind === "dev" ? "implementation and artifact" : "method, result, and artifact"}; every evidence value must be a nonblank string.`;
  const registry = pi.pi.AgentRegistry.global();
  let host: BoundedWorkflowHost | undefined;
  let owner: string | undefined;
  let ownerSession: string | undefined;
  const landingScopes = new Map<string, { mode: "merged" | "ready-pr"; target: string; allowedChildTargets: readonly string[] }>();
  let bridge: WorkflowBridge | undefined;
  let launcher: { launch(request: WorkflowLaunchRequest): Promise<WorkflowLaunchReceipt> } | undefined;
  const childScopes = new Map<string, Set<string>>();
  const childItems = new Map<string, string>();
  const observedJobs = new Map<string, { raw: unknown; scopeId: string; jobId: string; ownerId: string; nativeId: string; agent: string }>();
  const inheritedManifest = process.env.JP_WORKFLOW_INHERITED_MANIFEST;
  let inheritedSocket: string | undefined;
  const inheritedClients = new Map<string, WorkflowBridgeClient>();
  let inheritedOwner: string | undefined;
  let inheritedRoot: string | undefined;
  let inheritedOwnerSession: string | undefined;
  function authority(ctx: { agent: { id: string; kind: string }; sessionManager: { getSessionId(): string } }, scopeId: string): BoundedWorkflowHost {
    const ref = registry.get(ctx.agent.id);
    if (!host || !owner || !ownerSession || ref?.session?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("Bounded caller lacks a live native session binding");
    let ancestor = ref;
    const seen = new Set<string>();
    while (ancestor.parentId) {
      if (seen.has(ancestor.id)) throw new Error("Native ancestry cycle");
      seen.add(ancestor.id);
      const parent = registry.get(ancestor.parentId);
      if (!parent) throw new Error("Native ancestry is unavailable");
      ancestor = parent;
    }
    if (ancestor.id !== owner || ancestor.session?.sessionManager.getSessionId() !== ownerSession) throw new Error("Native caller belongs to another root");
    if (ctx.agent.id !== owner && !childScopes.get(ctx.agent.id)?.has(scopeId)) throw new Error("Native child has no capability for this scope");
    return host;
  }
  function inheritedAuthority(ctx: { agent: { id: string }; sessionManager: { getSessionId(): string } }, scopeId: string): WorkflowBridgeClient {
    const client = inheritedClients.get(scopeId);
    const ref = registry.get(ctx.agent.id);
    if (!client || !inheritedOwner || !inheritedOwnerSession || ref?.session?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("Inherited caller lacks an attached native session");
    let ancestor = ref;
    const seen = new Set<string>();
    while (ancestor.parentId) {
      if (seen.has(ancestor.id)) throw new Error("Native ancestry cycle");
      seen.add(ancestor.id);
      const parent = registry.get(ancestor.parentId);
      if (!parent) throw new Error("Native ancestry is unavailable");
      ancestor = parent;
    }
    if (ancestor.id !== inheritedOwner || ancestor.session?.sessionManager.getSessionId() !== inheritedOwnerSession) throw new Error("Inherited caller belongs to another root");
    if (ctx.agent.id !== inheritedOwner && !childScopes.get(ctx.agent.id)?.has(scopeId)) throw new Error("Native child has no capability for this inherited scope");
    return client;
  }
  const rejectNativeError = (native: { isError?: boolean; content: readonly { type: string; text?: string }[] }) => {
    if (native.isError) throw new Error(`Native task failed: ${native.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")}`);
  };
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  function verifyReadyPr(scopeId: string, handoff: Readonly<{ itemId: string; worktree: string; head: string; prNumber: number }>, rootCwd: string): { url: string; target: string } {
    const policy = landingScopes.get(scopeId);
    if (!policy) throw new Error("Scoped target is unavailable");
    const cwd = realpathSync(handoff.worktree);
    const git = (directory: string, ...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    if (realpathSync(git(cwd, "rev-parse", "--show-toplevel")) !== cwd || realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir"))) !== realpathSync(resolve(rootCwd, git(rootCwd, "rev-parse", "--git-common-dir"))) || git(cwd, "rev-parse", "HEAD") !== handoff.head || git(cwd, "status", "--porcelain") !== "") throw new Error("Prerequisite worktree or head is not clean and current");
    const pr = z.object({ headRefOid: text, baseRefName: text, state: z.string(), isDraft: z.boolean(), url: text }).parse(JSON.parse(execFileSync("gh", ["pr", "view", String(handoff.prNumber), "--json", "headRefOid,baseRefName,state,isDraft,url"], { cwd, encoding: "utf8" })));
    const scope = host?.view(scopeId);
    if (!scope || scope.scope.kind !== "bounded" || !scope.scope.itemIds.includes(handoff.itemId)) throw new Error("PR item is outside the assigned scope");
    const planned = scope.workflow === "factory" ? host?.plannedTargets(scopeId)[handoff.itemId] : undefined;
    if (pr.headRefOid !== handoff.head || !(planned?.length ? planned.includes(pr.baseRefName) : pr.baseRefName === policy.target) || pr.state !== "OPEN" || pr.isDraft) throw new Error("Prerequisite PR does not match the assigned head and target");
    return { url: pr.url, target: pr.baseRefName };
  }
  pi.registerTool({ name: "bounded_begin", label: "Begin bounded workflow", description: "Freeze the queue, dependency graph, target and landing mode for this OMP session.", parameters: z.object({ workflow: kind, itemIds: z.array(text).min(1), dependencies: z.record(z.string(), z.array(text)).optional(), reviewLimit: z.number().int(), landing: z.object({ mode: z.enum(["merged", "ready-pr"]), target: text, allowedChildTargets: z.array(text).optional() }).strict() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (inheritedManifest) throw new Error("Inherited execution must attach to its parent; standalone begin is forbidden");
      if (ctx.agent.kind !== "main" || host) throw new Error("A bounded owner already exists or caller is not main");
      const ref = registry.get(ctx.agent.id);
      if (ref?.session?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("Bounded owner is not bound to its native session");
      const allowedChildTargets = params.landing.allowedChildTargets ?? [];
      for (const target of [params.landing.target, ...allowedChildTargets]) execFileSync("git", ["check-ref-format", `refs/heads/${target}`], { cwd: ctx.cwd });
      host = new BoundedWorkflowHost(params.workflow, params.itemIds, params.reviewLimit, params.dependencies); owner = ctx.agent.id; ownerSession = ctx.sessionManager.getSessionId();
      const landing = { mode: params.landing.mode, target: params.landing.target, allowedChildTargets };
      landingScopes.set(host.rootId, landing);
      return result({ scopeId: host.rootId, view: host.view(host.rootId), landing, durable: false });
    },
  });
  pi.registerTool({ name: "bounded_nest", label: "Nest bounded workflow", description: "Create a nested scope in the same session, inheriting its review budget.", parameters: z.object({ parentId: text, workflow: kind, itemIds: z.array(text).min(1), reviewLimit: z.number().int(), target: text.optional() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (inheritedManifest) {
        if (!inheritedSocket) throw new Error("Inherited owner is not attached");
        const parent = inheritedAuthority(ctx, params.parentId);
        if (ctx.agent.id !== inheritedOwner && params.itemIds.some((item) => item !== childItems.get(ctx.agent.id))) throw new Error("Nested scope exceeds the native child's assigned item");
        const nested = await parent.nest(params.workflow, params.itemIds, params.reviewLimit, params.target);
        const client = await connectWorkflowBridge({ socket: inheritedSocket, token: nested.token });
        inheritedClients.set(nested.scopeId, client);
        if (ctx.agent.id !== inheritedOwner) childScopes.get(ctx.agent.id)?.add(nested.scopeId);
        return result({ scopeId: nested.scopeId, view: await client.view() });
      }
      const current = authority(ctx, params.parentId);
      if (ctx.agent.id !== owner && params.itemIds.some((item) => item !== childItems.get(ctx.agent.id))) throw new Error("Nested scope exceeds the native child's assigned item");
      const parentLanding = landingScopes.get(params.parentId);
      if (!parentLanding) throw new Error("Parent landing configuration is unavailable");
      const target = params.target ?? parentLanding.target;
      if (target !== parentLanding.target && !parentLanding.allowedChildTargets.includes(target)) throw new Error("Nested target is outside the frozen parent policy");
      const planned = current.view(params.parentId).workflow === "factory" ? current.plannedTargets(params.parentId) : {};
      if (Object.keys(planned).length && params.itemIds.some((item) => !planned[item]?.includes(target))) throw new Error("Nested target is outside the frozen item plan");
      const scopeId = current.nest(params.parentId, params.workflow, params.itemIds, params.reviewLimit);
      if (ctx.agent.id !== owner) childScopes.get(ctx.agent.id)?.add(scopeId);
      landingScopes.set(scopeId, { ...parentLanding, target });
      return result({ scopeId, view: current.view(scopeId) });
    },
  });
  pi.registerTool({ name: "bounded_status", label: "Bounded workflow status", description: "Read authoritative session-local reservations and review budget.", parameters: z.object({ scopeId: text }),
    async execute(_id, params, _signal, _update, ctx) {
      if (inheritedManifest) {
        const client = inheritedAuthority(ctx, params.scopeId);
        return result(await client.view());
      }
      const current = authority(ctx, params.scopeId);
      const view = current.view(params.scopeId);
      const item = childItems.get(ctx.agent.id);
      if (ctx.agent.id === owner) return result({ ...view, ...(view.workflow === "factory" && view.graphFrozen ? { targets: current.plannedTargets(params.scopeId) } : {}) });
      if (!item) throw new Error("Native child assignment is unavailable");
      return result({ ...view, scope: { kind: "bounded", itemIds: [item] }, admitted: view.admitted.filter((id) => id === item), reservations: view.reservations.filter((entry) => entry.itemIds.every((id) => id === item)), reviews: view.reviews.filter((entry) => entry.changeId === item) });
    },
  });
  pi.registerTool({ name: "bounded_ready", label: "Mark prerequisite ready", description: "Publish a verified parent PR/head as ready for dependent work without claiming final review or merge.", parameters: z.object({ scopeId: text, itemId: text, worktree: text, head: text, prNumber: z.number().int().positive() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (inheritedManifest) {
        const client = inheritedAuthority(ctx, params.scopeId);
        if (ctx.agent.id !== inheritedOwner && params.itemId !== childItems.get(ctx.agent.id)) throw new Error("Readiness exceeds the native child's assigned item");
        await client.readyItem({ itemId: params.itemId, worktree: realpathSync(params.worktree), head: params.head, prNumber: params.prNumber });
        return result({ itemId: params.itemId, head: params.head, readyForDependent: true });
      }
      const current = authority(ctx, params.scopeId);
      if (ctx.agent.id !== owner) throw new Error("Only the root owner can mark dependency readiness");
      const pr = verifyReadyPr(params.scopeId, params, ctx.cwd);
      current.ready(params.scopeId, params.itemId, params.head);
      return result({ itemId: params.itemId, head: params.head, pr: pr.url, target: pr.target, readyForDependent: true });
    },
  });
  pi.registerTool({ name: "bounded_complete", label: "Complete bounded work", description: "Close work only after correlated role/review receipts and independently checked landing evidence.", parameters: z.object({ scopeId: text, itemId: text, worktree: text, head: text, prNumber: z.number().int().positive().optional() }),
    async execute(_id, params, _signal, _update, ctx) {
      const current = authority(ctx, params.scopeId);
      if (ctx.agent.id !== owner) throw new Error("Only the root owner can close work");
      const cwd = realpathSync(params.worktree);
      const git = (directory: string, ...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
      if (realpathSync(git(cwd, "rev-parse", "--show-toplevel")) !== cwd || realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir"))) !== realpathSync(resolve(ctx.cwd, git(ctx.cwd, "rev-parse", "--git-common-dir"))) || git(cwd, "rev-parse", "HEAD") !== params.head || git(cwd, "status", "--porcelain") !== "") throw new Error("Worktree or reviewed head is not clean and current");
      const landing = landingScopes.get(params.scopeId);
      if (!landing) throw new Error("Immutable landing configuration is unavailable");
      if (!params.prNumber) throw new Error("Completion requires a pull request number for verified landing or handoff");
      const pr = z.object({ headRefOid: text, baseRefName: text, state: z.string(), isDraft: z.boolean(), url: text, mergeCommit: z.object({ oid: text }).nullable() }).parse(JSON.parse(execFileSync("gh", ["pr", "view", String(params.prNumber), "--json", "headRefOid,baseRefName,state,isDraft,url,mergeCommit"], { cwd, encoding: "utf8" })));
      if (pr.headRefOid !== params.head || pr.baseRefName !== landing.target) throw new Error("PR does not match the reviewed head and selected target");
      if (landing.mode === "merged") {
        if (pr.state !== "MERGED" || !pr.mergeCommit) throw new Error("PR has not been merged");
        const landingRef = `refs/remotes/origin/${landing.target}`;
        execFileSync("git", ["merge-base", "--is-ancestor", pr.mergeCommit.oid, landingRef], { cwd });
      } else if (pr.state !== "OPEN" || pr.isDraft) throw new Error("PR is not open and ready");
      const artifact = { prNumber: params.prNumber, url: pr.url, target: pr.baseRefName, state: pr.state, mergeCommit: pr.mergeCommit?.oid ?? null };
      current.complete(params.scopeId, params.itemId, params.head);
      return result({ itemId: params.itemId, head: params.head, outcome: "completed", landing: artifact });
    },
  });
  pi.registerTool({ name: "bounded_reconcile", label: "Reconcile native assignment", description: "Resolve uncertainty only from the original correlated terminal job retained by this host.", parameters: z.object({ scopeId: text, reservationId: text }),
    async execute(_id, params, _signal, _update, ctx) {
      const current = authority(ctx, params.scopeId);
      if (ctx.agent.id !== owner) throw new Error("Only the root owner can reconcile");
      const observation = observedJobs.get(params.reservationId);
      if (!observation || observation.scopeId !== params.scopeId) throw new Error("Original correlated job is unavailable; do not redispatch");
      const job = jobSchema.parse(observation.raw);
      const receipt = progress.parse(job.latestDetails).progress.find((entry) => entry.id === observation.nativeId && entry.agent === observation.agent);
      if (job.id !== observation.jobId || job.ownerId !== observation.ownerId || job.agentId !== observation.nativeId || registry.get(observation.nativeId)?.parentId !== observation.ownerId || !receipt || job.status === "running" || (job.status === "completed" ? receipt.status !== "completed" : !["failed", "aborted"].includes(receipt.status))) throw new Error("Terminal job evidence is unavailable or mismatched");
      const outcome = job.status === "completed" ? "completed" : "failed";
      current.reconcile(params.scopeId, params.reservationId, outcome, `native-job:${job.id}:${job.agentId}:${job.status}`);
      return result({ reservationId: params.reservationId, outcome, nativeJobId: job.id });
    },
  });
  pi.registerTool({ name: "bounded_launch", label: "Launch inherited bounded host", description: "Allocate one Tern or Herdr pane with a private inherited manifest. Never retry an uncertain launch with another key.", parameters: z.object({ scopeId: text, launchKey: text, backend: z.enum(["tern", "herdr"]), cwd: text, directive: z.string().trim().min(1).max(16000), name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional() }),
    async execute(_id, params, _signal, _update, ctx) {
      const current = authority(ctx, params.scopeId);
      if (ctx.agent.id !== owner) throw new Error("Only the root owner can allocate bounded hosts");
      const scope = current.view(params.scopeId);
      if (scope.workflow === "factory" || scope.scope.kind !== "bounded" || scope.scope.itemIds.length !== 1 || !landingScopes.has(params.scopeId)) throw new Error("Parent must create a single-item pipeline or hotfix scope before launching");
      const cwd = realpathSync(params.cwd);
      const git = (directory: string) => execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: directory, encoding: "utf8" }).trim();
      if (realpathSync(resolve(cwd, git(cwd))) !== realpathSync(resolve(ctx.cwd, git(ctx.cwd)))) throw new Error("Launch worktree is outside the current repository");
      bridge ??= await startWorkflowBridge(current, {
        acceptBoundHostReceipts: true,
        validateRoleAssignment: async ({ scopeId, itemId, role }) => {
          const view = current.view(scopeId);
          if (view.scope.kind !== "bounded" || !view.scope.itemIds.includes(itemId) || (view.workflow === "hotfix" && role.kind !== "dev")) return false;
          const path = realpathSync(role.worktree);
          return path === role.worktree && realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8" }).trim()) === path && realpathSync(resolve(path, git(path))) === realpathSync(resolve(ctx.cwd, git(ctx.cwd)));
        },
        validateRole: async ({ itemId, proof }) => {
          const parsed = roleResult.safeParse({ role: proof.role, itemId, head: proof.head, verdict: "pass", evidence: proof.evidence });
          if (!parsed.success) return false;
          const path = realpathSync(proof.worktree);
          return path === proof.worktree && realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8" }).trim()) === path && realpathSync(resolve(path, git(path))) === realpathSync(resolve(ctx.cwd, git(ctx.cwd))) && execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim() === proof.head;
        },
        validateFinish: async (scopeId, handoff) => {
          try { for (const item of handoff.items) verifyReadyPr(scopeId, item, ctx.cwd); return true; }
          catch { return false; }
        },
        validateReady: async (scopeId, item) => {
          try { verifyReadyPr(scopeId, item, ctx.cwd); return true; }
          catch { return false; }
        },
        nestScope: (parentId, workflow, itemIds, limit, requestedTarget) => {
          const policy = landingScopes.get(parentId);
          if (!policy) throw new Error("Parent landing policy is unavailable");
          const target = requestedTarget ?? policy.target;
          if (target !== policy.target && !policy.allowedChildTargets.includes(target)) throw new Error("Nested target is outside the frozen parent policy");
          const scopeId = current.nest(parentId, workflow, itemIds, limit);
          landingScopes.set(scopeId, { ...policy, target });
          return scopeId;
        },
      });
      launcher ??= createWorkflowBridgeLauncher({ bridge });
      const executable = Bun.which("omp");
      if (!executable) throw new Error("No OMP executable is available for the child");
      const omp = realpathSync(executable);
      const model = ctx.models.current();
      if (!model) throw new Error("The current OMP model is unavailable");
      const extension = fileURLToPath(import.meta.url);
      const args = ["--no-extensions", "--extension", extension, "--model", `${model.provider}/${model.id}`, ...(process.env.OMP_PROFILE ? ["--profile", process.env.OMP_PROFILE] : [])];
      const environment: Record<string, string> = {};
      for (const key of ["HOME", "PATH", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE"]) {
        const value = process.env[key];
        if (value !== undefined) environment[key] = value;
      }
      const directive = `Call bounded_attach first. Your inherited scope and review deferral are enforced by the host. Perform this owner assignment and report the actual result: ${params.directive}`;
      if (params.backend === "tern") {
        const pane = process.env.TERN_PANE;
        const socket = process.env.TERN_PANE_SOCKET || process.env.TERN_DAEMON_SOCKET;
        if (!pane || !socket || (process.env.TERN_PANE_SOCKET && process.env.TERN_DAEMON_SOCKET && process.env.TERN_PANE_SOCKET !== process.env.TERN_DAEMON_SOCKET)) throw new Error("Current Tern pane and consistent daemon socket are required");
        const binary = process.env.TERN_BIN_PATH || process.env.TERN_EXE || "tern";
        const window = process.env.TERN_WINDOW_KEY ?? "";
        const run = createTernCommandRunner({ socket, timeoutMs: 35000 });
        const location = await ternContext({ binary, window, blockId: pane, run });
        const runtime = createTernRuntime({ binary, window, sessionId: location.sessionId, run, parentPid: ternParentPid });
        await runtime.check();
        return result(await launcher.launch({ kind: "tern", runtime, parentBlockId: pane, scopeId: params.scopeId, launchKey: params.launchKey, cwd, env: environment, argv: [omp, ...args, directive] }));
      }
      if (process.env.HERDR_ENV !== "1") throw new Error("Herdr launch requires the current Herdr pane");
      const binary = process.env.HERDR_BIN_PATH || "herdr";
      const status = execFileSync(binary, ["integration", "status"], { encoding: "utf8" });
      const integrationMatch = /^omp: current \(v[1-9][0-9]*\) \((.+)\)$/m.exec(status);
      if (!integrationMatch?.[1]) throw new Error("Herdr's managed OMP integration is not installed and current");
      const integration = realpathSync(integrationMatch[1]);
      const source = readFileSync(integration, "utf8");
      if (!/^\/\/ HERDR_INTEGRATION_ID=omp$/m.test(source) || !/^\/\/ HERDR_INTEGRATION_VERSION=[1-9][0-9]*$/m.test(source)) throw new Error("Herdr OMP integration has invalid headers");
      const location = await herdrContext({ binary, session: process.env.HERDR_SESSION || null });
      const runtime = createHerdrRuntime({ binary, session: location.session, workspaceId: location.workspaceId, run: runHerdrCommand });
      await runtime.check();
      return result(await launcher.launch({ kind: "herdr", runtime, parentPaneId: location.paneId, scopeId: params.scopeId, launchKey: params.launchKey, cwd, env: environment, name: params.name ?? "bounded-worker", harness: "omp", args: [...args, "--extension", integration, directive] }));
    },
  });
  pi.registerTool({ name: "bounded_attach", label: "Attach inherited assignment", description: "Attach the owner-issued environment capability; inherited review is deferred to the parent.", parameters: z.object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      if (!inheritedManifest || inheritedClients.size || ctx.agent.kind !== "main") throw new Error("A unique inherited manifest and main caller are required");
      const ref = registry.get(ctx.agent.id);
      if (ref?.session?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("Inherited caller lacks native session binding");
      const deadline = Date.now() + 30000;
      while (!existsSync(inheritedManifest)) {
        if (Date.now() >= deadline) throw new Error("Owner did not publish an inherited manifest; do not start a standalone run");
        const pause = Promise.withResolvers<void>();
        ctx.setTimeout(pause.resolve, 50);
        await pause.promise;
      }
      const binding = readRunManifest(inheritedManifest);
      inheritedSocket = binding.socket;
      const client = await connectWorkflowBridge({ socket: binding.socket, token: binding.token });
      let view: unknown;
      try { view = await client.view(); } catch (error) { await client.close(); throw error; }
      inheritedClients.set(binding.scopeId, client); inheritedOwner = ctx.agent.id; inheritedOwnerSession = ctx.sessionManager.getSessionId(); inheritedRoot = binding.scopeId;
      return result({ scopeId: binding.scopeId, view, mode: "review-deferred", terminalVerification: "parent-dependent" });
    },
  });
  pi.registerTool({ name: "bounded_finish", label: "Hand off inherited workflow", description: "Hand verified ready PRs to the parent coordinator; reviews remain with the parent.", parameters: z.object({ scopeId: text, items: z.array(z.object({ itemId: text, worktree: text, head: text, prNumber: z.number().int().positive() }).strict()).min(1) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!inheritedManifest || ctx.agent.id !== inheritedOwner || params.scopeId !== inheritedRoot) throw new Error("Only the attached inherited root can hand off");
      const root = inheritedClients.get(params.scopeId);
      if (!root) throw new Error("Inherited root connection is unavailable");
      for (const [scopeId, client] of inheritedClients) {
        if (scopeId === params.scopeId) continue;
        await client.close();
        inheritedClients.delete(scopeId);
      }
      await root.finishRun({ items: params.items });
      await root.close();
      inheritedClients.delete(params.scopeId);
      return result({ scopeId: params.scopeId, readyForParent: true, items: params.items });
    },
  });
  pi.on("session_shutdown", async (_event, ctx) => { if (ctx.agent.kind === "main") { await Promise.all([...inheritedClients.values()].map((client) => client.close())); await bridge?.close(); } });
  // The host supplies invokeTool only for an override of the actual native task tool.
  pi.registerTool({ name: "task", label: "Bounded native task", strict: false, description: "Dispatch one assignment through the real native task tool. Set planner for the factory's initial graph. Omit role and review when unused; never supply both. Reviews require independently dispatched reviewers and verified worktree heads.", parameters: z.object({ scopeId: text, itemId: text, assignmentKey: text, context: z.string(), tasks: z.array(taskItem).min(1).max(1), planner: z.boolean().optional(), role: z.object({ kind: z.enum(["architect", "dev", "qa"]), worktree: text }).strict().optional(), review: z.array(z.object({ changeId: text, head: text, worktree: text }).strict()).min(1).optional() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (inheritedManifest) {
        const inherited = inheritedAuthority(ctx, params.scopeId);
        if (!ctx.invokeTool || (ctx.agent.id !== inheritedOwner && params.itemId !== childItems.get(ctx.agent.id))) throw new Error("Inherited assignment is unavailable or outside the native child's scope");
        if (params.review) throw new Error("Inherited review authority is deferred to the parent");
        const ref = registry.get(ctx.agent.id);
        const jobs = ref?.session?.asyncJobManager;
        if (!jobs || ref?.session?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("Inherited native observation is unavailable");
        const previous = new Set(jobs.getAllJobs({ ownerId: ctx.agent.id }).map((entry) => entry.id));
        if (params.planner) {
          if (ctx.agent.id !== inheritedOwner || params.role) throw new Error("Only the inherited factory owner can dispatch the planner");
          const scope = z.object({ workflow: z.literal("factory"), scope: z.object({ kind: z.literal("bounded"), itemIds: z.array(text).min(1) }) }).passthrough().parse(await inherited.view());
          if (!scope.scope.itemIds.includes(params.itemId)) throw new Error("Planner anchor is outside the inherited queue");
          const task = params.tasks[0];
          if (!task) throw new Error("One native planner is required");
          const { reservationId, launchId } = await inherited.reservePlan();
          try {
            const native = await ctx.invokeTool({ context: params.context, tasks: [{ ...task, task: `${task.task}\nReturn one JSON object containing dependencies and targets maps keyed by every frozen item. Dependencies name only frozen items; targets are allowed Git branch names. Frozen items: ${JSON.stringify(scope.scope.itemIds)}` }] });
            rejectNativeError(native);
            const done = synchronous.safeParse(native.details);
            const running = done.success ? null : progress.parse(native.details).progress;
            const spawned = done.success ? done.data.results : running ?? [];
            if (spawned.length !== 1 || spawned[0]?.index !== 0) throw new Error("Inherited planner dispatch lacks one correlated task");
            const childId = spawned[0].id;
            const matches = jobs.getAllJobs({ ownerId: ctx.agent.id }).filter((entry) => !previous.has(entry.id)).map((raw) => ({ raw, parsed: jobSchema.safeParse(raw) })).filter((entry) => entry.parsed.success && entry.parsed.data.agentId === childId && entry.parsed.data.ownerId === ctx.agent.id);
            const match = matches[0];
            if (matches.length !== 1 || !match || !match.parsed.success) throw new Error("Inherited planner job cannot be uniquely correlated");
            const existingChild = registry.get(childId);
            if (existingChild && existingChild.parentId !== ctx.agent.id) throw new Error("Inherited planner child ancestry does not match dispatch");
            await match.parsed.data.promise;
            const terminal = jobSchema.parse(match.raw);
            const receipt = progress.parse(terminal.latestDetails).progress.find((entry) => entry.id === childId && (running === null || entry.agent === running[0]?.agent));
            if (terminal.id !== match.parsed.data.id || terminal.ownerId !== ctx.agent.id || terminal.agentId !== childId || registry.get(childId)?.parentId !== ctx.agent.id || !receipt || terminal.status === "running") throw new Error("Inherited planner terminal receipt does not match its job");
            let plan: { dependencies: Record<string, string[]>; targets: Record<string, string[]> } | undefined;
            if (terminal.status === "completed" && receipt.status === "completed") {
              const child = registry.get(childId);
              const message = child?.session?.messages.findLast((entry) => entry.role === "assistant");
              if (!message || message.role !== "assistant") throw new Error("Inherited planner result is unavailable");
              const blocks = message.content.filter((block) => block.type === "text").map((block) => block.text);
              if (blocks.length !== 1) throw new Error("Inherited planner result is not structured");
              const parsed = plannerResult.parse(JSON.parse(blocks[0] ?? ""));
              plan = { dependencies: parsed.dependencies, targets: parsed.targets };
            } else if (!["failed", "cancelled"].includes(terminal.status) || !["failed", "aborted"].includes(receipt.status)) throw new Error("Inherited planner terminal state is uncertain");
            const outcome = await inherited.submitPlan({ reservationId, evidence: { scopeId: params.scopeId, reservationId, launchId, nativeJobId: terminal.id, nativeAgentId: childId, status: plan ? "completed" : "failed", ...(plan ? { plan } : {}) } });
            return result({ reservationId, outcome });
          } catch (error: unknown) {
            await inherited.close();
            throw error;
          }
        }
        const role = params.role ? { kind: params.role.kind, worktree: realpathSync(params.role.worktree) } : undefined;
        const task = params.tasks[0];
        if (!task) throw new Error("One native task is required");
        const { reservationId, launchId } = await inherited.reserveAssignment({ itemId: params.itemId, assignmentKey: params.assignmentKey, ...(role ? { role } : {}) });
        const nativeTasks = role ? [{ ...task, task: `${task.task}\n${rolePrompt(role.kind, params.itemId, role.worktree)}` }] : params.tasks;
        try {
          const native = await ctx.invokeTool({ context: params.context, tasks: nativeTasks });
          const done = synchronous.safeParse(native.details);
          if (!done.success) rejectNativeError(native);
          let evidence: unknown = native;
          if (!done.success) {
            const spawned = progress.parse(native.details).progress;
            if (native.isError || spawned.length !== 1 || spawned[0]?.index !== 0) throw new Error("Uncorrelated native dispatch");
            const child = spawned[0];
            const matches = jobs.getAllJobs({ ownerId: ctx.agent.id }).filter((entry) => !previous.has(entry.id)).map((raw) => ({ raw, parsed: jobSchema.safeParse(raw) })).filter((entry) => entry.parsed.success && entry.parsed.data.agentId === child.id && entry.parsed.data.ownerId === ctx.agent.id);
            const match = matches[0];
            if (matches.length !== 1 || !match || !match.parsed.success) throw new Error("Uncorrelated native job");
            const existingChild = registry.get(child.id);
            if (existingChild && existingChild.parentId !== ctx.agent.id) throw new Error("Native child ancestry does not match dispatch");
            childScopes.set(child.id, new Set([params.scopeId]));
            childItems.set(child.id, params.itemId);
            try { await match.parsed.data.promise; }
            finally { childScopes.delete(child.id); childItems.delete(child.id); }
            const terminal = jobSchema.parse(match.raw);
            const receipt = progress.parse(terminal.latestDetails).progress.find((entry) => entry.id === child.id && entry.agent === child.agent);
            if (terminal.id !== match.parsed.data.id || terminal.ownerId !== ctx.agent.id || terminal.agentId !== child.id || registry.get(child.id)?.parentId !== ctx.agent.id || !receipt || terminal.status === "running" || (terminal.status === "completed" ? receipt.status !== "completed" : !["failed", "aborted"].includes(receipt.status))) throw new Error("Uncorrelated terminal native receipt");
            let roleProof: unknown;
            let roleEvidence: "invalid" | undefined;
            if (role && terminal.status === "completed") {
              const childRef = registry.get(child.id);
              if (childRef?.parentId !== ctx.agent.id || !childRef.session) throw new Error("Correlated role session is unavailable");
              const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: role.worktree, encoding: "utf8" }).trim();
              const message = [...childRef.session.messages].reverse().find((entry) => entry.role === "assistant");
              const blocks = message?.role === "assistant" ? message.content.filter((block) => block.type === "text").map((block) => block.text) : [];
              let output: unknown;
              if (blocks.length === 1) {
                try { output = JSON.parse(blocks[0] ?? ""); } catch { /* Invalid role output is not proof. */ }
              }
              if (typeof output === "object" && output !== null && (
                ("role" in output && typeof output.role === "string" && output.role !== role.kind) ||
                ("itemId" in output && typeof output.itemId === "string" && output.itemId !== params.itemId) ||
                ("head" in output && typeof output.head === "string" && output.head !== actualHead)
              )) throw new Error("Role output identity or head does not match the assignment");
              const parsed = roleResult.safeParse(output);
              if (!parsed.success) {
                roleEvidence = "invalid";
              } else {
                const proof = parsed.data;
                roleProof = { role: proof.role, itemId: proof.itemId, verdict: proof.verdict, worktree: role.worktree, agentId: `${ctx.sessionManager.getSessionId()}:${child.id}`, head: proof.head, evidence: proof.evidence };
              }
            }
            evidence = { scopeId: params.scopeId, itemId: params.itemId, assignmentKey: params.assignmentKey, reservationId, launchId, nativeJobId: terminal.id, status: terminal.status === "completed" ? "completed" : "failed", ...(roleProof ? { roleProof } : {}), ...(roleEvidence ? { roleEvidence } : {}) };
          } else if (done.data.results.length !== 1 || done.data.results[0]?.index !== 0) throw new Error("Uncorrelated native result");
          const outcome = await inherited.submitAssignment({ reservationId, evidence });
          return result({ native: evidence, parentOutcome: outcome, ...(outcome === "completed_without_role" ? { warning: "The task ran and may have had effects. Role evidence was invalid; do not replay this task." } : {}) });
        } catch (error: unknown) {
          await inherited.close();
          throw error;
        }
      }
      const current = authority(ctx, params.scopeId);
      if (ctx.agent.id !== owner && (params.itemId !== childItems.get(ctx.agent.id) || params.review?.some((change) => change.changeId !== childItems.get(ctx.agent.id)))) throw new Error("Native child cannot access work outside its assignment");
      if (!ctx.invokeTool) throw new Error("Native task delegation is unavailable");
      const root = registry.get(ctx.agent.id);
      const jobs = root?.session?.asyncJobManager;
      if (!root?.session || !jobs) throw new Error("Native task job observation is unavailable; nothing was dispatched");
      const before = new Set(jobs.getAllJobs({ ownerId: ctx.agent.id }).map((entry) => entry.id));
      const invoke = ctx.invokeTool;
      const changes = params.review;
      const task = params.tasks[0];
      if (!task) throw new Error("One native task is required");
      if (params.planner) {
        if (ctx.agent.id !== owner || params.role || params.review || current.view(params.scopeId).workflow !== "factory") throw new Error("Only the factory owner can dispatch the planner");
        const frozen = current.view(params.scopeId).scope;
        if (frozen.kind !== "bounded" || !frozen.itemIds.includes(params.itemId)) throw new Error("Planner anchor is outside the factory queue");
        const settle = (reservationId: string, childId: string, completed: boolean): void => {
          if (!completed) { current.settlePlan(params.scopeId, reservationId, "failed"); return; }
          try {
            const child = registry.get(childId);
            if (!child?.session || child.parentId !== ctx.agent.id) throw new Error("Planner session is unavailable");
            const message = [...child.session.messages].reverse().find((entry) => entry.role === "assistant");
            if (!message || message.role !== "assistant") throw new Error("Planner output is unavailable");
            const blocks = message.content.filter((block) => block.type === "text").map((block) => block.text);
            if (blocks.length !== 1) throw new Error("Planner output is not structured");
            const plan = plannerResult.parse(JSON.parse(blocks[0] ?? ""));
            for (const targets of Object.values(plan.targets)) for (const target of targets) execFileSync("git", ["check-ref-format", `refs/heads/${target}`], { cwd: ctx.cwd });
            const landing = landingScopes.get(params.scopeId);
            if (!landing) throw new Error("Factory landing policy is unavailable");
            current.completePlan(params.scopeId, reservationId, plan);
            landingScopes.set(params.scopeId, { ...landing, allowedChildTargets: [...new Set([...landing.allowedChildTargets, ...Object.values(plan.targets).flat()])] });
          } catch {
            if (current.view(params.scopeId).planner?.state === "active") current.settlePlan(params.scopeId, reservationId, "failed");
          }
        };
        const dispatch = await current.plan(params.scopeId, async (reservationId) => {
          const native = await invoke({ context: params.context, tasks: [{ ...task, task: `${task.task}\nReturn one JSON object containing dependencies and targets maps keyed by every frozen item. Dependencies name only frozen items; targets are allowed Git branch names. Frozen items: ${JSON.stringify(frozen.itemIds)}` }] });
          const done = synchronous.safeParse(native.details);
          if (!done.success) rejectNativeError(native);
          if (done.success && done.data.results.length === 1 && done.data.results[0]?.index === 0) {
            const terminal = done.data.results[0];
            if (registry.get(terminal.id)?.parentId !== ctx.agent.id) throw new Error("Planner result ancestry does not match dispatch");
            settle(reservationId, terminal.id, !native.isError && !terminal.aborted && terminal.exitCode === 0);
            return { reservationId, status: "accepted" };
          }
          const spawned = progress.parse(native.details).progress;
          if (native.isError || spawned.length !== 1 || spawned[0]?.index !== 0) throw new Error("Planner dispatch receipt lacks one correlated task");
          const child = spawned[0];
          const matches = jobs.getAllJobs({ ownerId: ctx.agent.id }).filter((entry) => !before.has(entry.id)).map((raw) => ({ raw, parsed: jobSchema.safeParse(raw) })).filter((entry) => entry.parsed.success && entry.parsed.data.agentId === child.id && entry.parsed.data.ownerId === ctx.agent.id);
          const match = matches[0];
          if (matches.length !== 1 || !match || !match.parsed.success) throw new Error("Planner job cannot be uniquely correlated");
          const existingChild = registry.get(child.id);
          if (existingChild && existingChild.parentId !== ctx.agent.id) throw new Error("Planner child ancestry does not match dispatch");
          const job = match.parsed.data;
          void job.promise.then(() => {
            try {
              const terminal = jobSchema.parse(match.raw);
              const receipt = progress.parse(terminal.latestDetails).progress.find((entry) => entry.id === child.id && entry.agent === child.agent);
              if (terminal.id !== job.id || terminal.ownerId !== ctx.agent.id || terminal.agentId !== child.id || registry.get(child.id)?.parentId !== ctx.agent.id || !receipt || terminal.status === "running" || (terminal.status === "completed" ? receipt.status !== "completed" : !["failed", "aborted"].includes(receipt.status))) throw new Error("Planner terminal receipt does not match its job");
              settle(reservationId, child.id, terminal.status === "completed");
            } catch {
              if (current.view(params.scopeId).planner?.state === "active") current.settlePlan(params.scopeId, reservationId, "uncertain");
            }
          }, () => current.settlePlan(params.scopeId, reservationId, "uncertain"));
          return { reservationId, status: "accepted" };
        });
        return result({ reservationId: dispatch.reservationId, planner: current.view(params.scopeId).planner, graphFrozen: current.view(params.scopeId).graphFrozen });
      }
      if (changes && params.role) throw new Error("Review and work roles require separate assignments");
      if (params.role && current.view(params.scopeId).workflow === "hotfix" && params.role.kind !== "dev") throw new Error("Hotfix does not staff an architect or QA crew");
      if (changes && !["reviewer", "security-reviewer"].includes(task.agent ?? "")) throw new Error("Review requires a native reviewer agent");
      const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      const verifyWorktrees = () => {
        const common = realpathSync(resolve(ctx.cwd, git(ctx.cwd, "rev-parse", "--git-common-dir")));
        for (const change of changes ?? []) {
          const cwd = realpathSync(change.worktree);
          if (realpathSync(git(cwd, "rev-parse", "--show-toplevel")) !== cwd || realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir"))) !== common || git(cwd, "rev-parse", "HEAD") !== change.head) throw new Error("Review worktree, repository or head changed");
        }
      };
      if (changes) {
        verifyWorktrees();
        if (current.view(params.scopeId).reservations.some((entry) => entry.purpose === "assignment" && entry.itemIds.includes(params.itemId) && entry.assignmentKey === params.assignmentKey && entry.state !== "failed")) throw new Error("Assignment already reserved, completed or uncertain");
      }
      const reviewId = changes ? current.reserveReview(params.scopeId, changes.map(({ changeId, head }) => ({ changeId, head }))) : undefined;
      let reviewFinished = false;
      const finishReview = (childId: string | null, completed: boolean) => {
        if (!changes || !reviewId || reviewFinished) return;
        let verdict: "approve" | "changes-requested" | "block" | "uncertain" = "uncertain";
        try {
          const child = childId ? registry.get(childId) : undefined;
          if (!completed || !child?.session || child.parentId !== ctx.agent.id) throw new Error("Reviewer session is unavailable");
          verifyWorktrees();
          const message = [...child.session.messages].reverse().find((entry) => entry.role === "assistant");
          if (!message || message.role !== "assistant") throw new Error("Reviewer output unavailable");
          const blocks = message.content.filter((block) => block.type === "text").map((block) => block.text);
          if (blocks.length !== 1) throw new Error("Reviewer output is not a single structured result");
          const parsed = reviewResult.parse(JSON.parse(blocks[0] ?? ""));
          if (childId) current.recordReviewActor(params.scopeId, reviewId, childId);
          if (parsed.changes.length !== changes.length || changes.some((change) => !parsed.changes.some((entry) => entry.changeId === change.changeId && entry.head === change.head && entry.worktree === change.worktree))) throw new Error("Reviewer output does not cover the reserved worktrees and heads");
          verdict = parsed.verdict;
        } catch {
          if (childId) { current.failReview(params.scopeId, reviewId); reviewFinished = true; return; }
          verdict = "uncertain";
        }
        current.settleReview(params.scopeId, reviewId, changes, verdict);
        reviewFinished = true;
      };
      const nativeTasks = changes ? [{ ...task, task: `${task.task}\nReview the exact changes and heads below. Your final response must be one JSON object with exactly changes and verdict (approve, changes-requested, or block): ${JSON.stringify(changes)}` }] : params.role ? [{ ...task, task: `${task.task}\n${rolePrompt(params.role.kind, params.itemId, params.role.worktree)}` }] : params.tasks;
      const finishRole = (childId: string, reservationId: string) => {
        if (!params.role) return;
        try {
          const child = registry.get(childId);
          if (!child?.session || child.parentId !== ctx.agent.id) throw new Error("Role session unavailable");
          const message = [...child.session.messages].reverse().find((entry) => entry.role === "assistant");
          if (!message || message.role !== "assistant") throw new Error("Role result unavailable");
          const blocks = message.content.filter((block) => block.type === "text").map((block) => block.text);
          if (blocks.length !== 1) throw new Error("Role result is not structured");
          const proof = roleResult.parse(JSON.parse(blocks[0] ?? ""));
          const cwd = realpathSync(params.role.worktree);
          const common = realpathSync(resolve(ctx.cwd, git(ctx.cwd, "rev-parse", "--git-common-dir")));
          if (proof.role !== params.role.kind || proof.itemId !== params.itemId || realpathSync(git(cwd, "rev-parse", "--show-toplevel")) !== cwd || realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir"))) !== common || git(cwd, "rev-parse", "HEAD") !== proof.head) throw new Error("Role proof does not match its assignment or worktree");
          current.recordRole(params.scopeId, { role: proof.role, itemId: proof.itemId, head: proof.head, agentId: childId, reservationId, evidence: proof.evidence });
        } catch { /* Missing or mismatched native proof cannot satisfy a completion gate. */ }
      };
      const syncRoles: { childId: string; reservationId: string }[] = [];
      let nativeResult: unknown;
      try {
      await current.dispatch(params.scopeId, params.itemId, params.assignmentKey, async (reservationId) => {
        const native = await invoke({ context: params.context, tasks: nativeTasks });
        nativeResult = native;
        const done = synchronous.safeParse(native.details);
        if (!done.success) rejectNativeError(native);
        if (done.success && done.data.results.length === 1 && done.data.results[0]?.index === 0) {
          const terminal = done.data.results[0];
          if (registry.get(terminal.id)?.parentId !== ctx.agent.id) throw new Error("Native result ancestry does not match dispatch");
          finishReview(terminal.id, !native.isError && !terminal.aborted && terminal.exitCode === 0);
          if (!native.isError && !terminal.aborted && terminal.exitCode === 0) syncRoles.push({ childId: terminal.id, reservationId });
          return { reservationId, status: !native.isError && !terminal.aborted && terminal.exitCode === 0 ? "completed" : "failed" };
        }
        const spawned = progress.parse(native.details).progress;
        if (native.isError || spawned.length !== 1 || spawned[0]?.index !== 0) throw new Error("Native dispatch receipt lacks one correlated task");
        const child = spawned[0];
        const matches = jobs.getAllJobs({ ownerId: ctx.agent.id }).filter((entry) => !before.has(entry.id)).map((raw) => ({ raw, parsed: jobSchema.safeParse(raw) })).filter((entry) => entry.parsed.success && entry.parsed.data.agentId === child.id && entry.parsed.data.ownerId === ctx.agent.id);
        const match = matches[0];
        if (matches.length !== 1 || !match || !match.parsed.success) throw new Error("Native task job cannot be uniquely correlated");
        const childRef = registry.get(child.id);
        if (childRef && childRef.parentId !== ctx.agent.id) throw new Error("Native child ancestry does not match dispatch");
        childScopes.set(child.id, new Set([params.scopeId]));
        childItems.set(child.id, params.itemId);
        const job = match.parsed.data;
        observedJobs.set(reservationId, { raw: match.raw, scopeId: params.scopeId, jobId: job.id, ownerId: ctx.agent.id, nativeId: child.id, agent: child.agent });
        void job.promise.then(() => {
          try {
            const terminal = jobSchema.parse(match.raw);
            if (terminal.id !== job.id || terminal.agentId !== child.id || terminal.ownerId !== ctx.agent.id || registry.get(child.id)?.parentId !== ctx.agent.id) throw new Error("Native job identity changed");
            const receipt = progress.parse(terminal.latestDetails).progress.find((entry) => entry.id === child.id && entry.agent === child.agent);
            if (!receipt || terminal.status === "running" || (terminal.status === "completed" ? receipt.status !== "completed" : !["failed", "aborted"].includes(receipt.status))) throw new Error("Native terminal receipt does not match job");
            current.settle(params.scopeId, reservationId, terminal.status === "completed" ? "completed" : "failed");
          } catch {
            current.settle(params.scopeId, reservationId, "uncertain");
            finishReview(null, false);
            return;
          }
          finishReview(child.id, jobSchema.parse(match.raw).status === "completed");
          if (jobSchema.parse(match.raw).status === "completed") finishRole(child.id, reservationId);
        }, () => {
          current.settle(params.scopeId, reservationId, "uncertain");
          finishReview(null, false);
        }).finally(() => { childScopes.delete(child.id); childItems.delete(child.id); });
        return { reservationId, status: "accepted" };
      });
      const syncRole = syncRoles[0];
      if (syncRole) finishRole(syncRole.childId, syncRole.reservationId);
      } catch (error: unknown) {
        finishReview(null, false);
        throw error;
      }
      return result({ native: nativeResult });
    },
  });
}
