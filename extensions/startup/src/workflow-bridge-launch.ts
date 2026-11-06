import { basename, isAbsolute } from "node:path";
import type { HerdrRuntime } from "./herdr-runtime";
import type { TernRuntime } from "./tern-runtime";
import { observeWorkflowBinding, type WorkflowNativeBinding } from "./workflow-bridge-native";
import type { WorkflowBridge } from "./workflow-bridge";
type Common = Readonly<{ launchKey: string; scopeId: string; cwd: string; env?: Readonly<Record<string, string>> }>;
export type WorkflowLaunchRequest = Common & (
  | Readonly<{ kind: "tern"; runtime: Pick<TernRuntime, "split" | "process" | "ownsProcess">; parentBlockId: string; argv: readonly string[] }>
  | Readonly<{ kind: "herdr"; runtime: Pick<HerdrRuntime, "split" | "launch" | "observe">; parentPaneId: string; name: string; harness: "omp" | "claude"; args: readonly string[] }>
);
export type WorkflowLaunchReceipt =
  | Readonly<{ kind: "tern"; launchKey: string; scopeId: string; sessionId: string; tabId: string; blockId: string; pid: number }>
  | Readonly<{ kind: "herdr"; launchKey: string; scopeId: string; workspaceId: string; tabId: string; paneId: string; terminalId: string; nativeSession: string }>;

/** An attempted native effect must be reconciled by the owner; never retry it blindly. */
export class WorkflowLaunchUncertainError extends Error {
  constructor(readonly launchKey: string, readonly location: Readonly<Record<string, string>> | null, cause: unknown) {
    super(`Workflow launch ${launchKey} may have started; reconcile before retrying: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WorkflowLaunchUncertainError";
  }
}

async function beforeIdentityDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("Launched Tern process identity is unavailable");
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error("Launched Tern process identity is unavailable")), remaining);
  try {
    return await Promise.race([operation(), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owner-only. launchKey is permanently consumed before the first backend effect. */
export function createWorkflowBridgeLauncher(input: Readonly<{ bridge: Pick<WorkflowBridge, "prepareRunManifest">; identityTimeoutMs?: number }>): Readonly<{ launch(request: WorkflowLaunchRequest): Promise<WorkflowLaunchReceipt> }> {
  const attempted = new Set<string>();
  if (!Number.isFinite(input.identityTimeoutMs ?? 10000) || (input.identityTimeoutMs ?? 10000) <= 0) throw new Error("Invalid Tern identity timeout");
  return { launch: async (request) => {
    if (!request.launchKey.trim() || !request.scopeId.trim() || !isAbsolute(request.cwd)) throw new Error("Invalid workflow launch request");
    if (attempted.has(request.launchKey)) throw new Error("Workflow launch key already attempted; reconcile before retrying");
    if (request.kind === "tern" && (!request.argv.length || !request.argv[0] || request.argv.some((arg) => arg.includes("\0")))) throw new Error("Invalid Tern launch command");
    const environment = Object.entries(request.env ?? {});
    if (environment.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === "JP_WORKFLOW_INHERITED_MANIFEST" || value.includes("\0"))) throw new Error("Invalid workflow launch environment");
    const prepared = input.bridge.prepareRunManifest({ scopeId: request.scopeId });
    attempted.add(request.launchKey);
    let location: Readonly<Record<string, string>> | null = null;
    try {
      if (request.kind === "tern") {
        const created = await request.runtime.split({ blockId: request.parentBlockId, cwd: request.cwd, argv: ["exec", "/usr/bin/env", `JP_WORKFLOW_INHERITED_MANIFEST=${prepared.path}`, ...environment.map(([key, value]) => `${key}=${value}`), ...request.argv] });
        location = { sessionId: created.sessionId, tabId: created.tabId, blockId: created.blockId };
        const expected = basename(request.argv[0] ?? "");
        const deadline = performance.now() + (input.identityTimeoutMs ?? 10000);
        let pid: number | null = null;
        while (pid === null) {
          const process = await beforeIdentityDeadline(() => request.runtime.process({ blockId: created.blockId }), deadline);
          const candidates = [process.foreground, process.child].filter((entry) => entry !== null).filter((entry) => basename(entry.name) === expected || basename(entry.argv[0] ?? "") === expected);
          const pids = new Set(candidates.map((entry) => entry.pid));
          if (pids.size > 1) throw new Error("Launched Tern process identity is ambiguous");
          const candidate = candidates[0];
          if (candidate) { pid = candidate.pid; break; }
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new Error("Launched Tern process identity is unavailable");
          await Bun.sleep(Math.min(50, remaining));
        }
        const binding: WorkflowNativeBinding = { kind: "tern", runtime: request.runtime, blockId: created.blockId, pid };
        if (!await beforeIdentityDeadline(() => observeWorkflowBinding(binding), deadline)) throw new Error("Tern process does not belong to the newly created block");
        prepared.publish(binding);
        return { kind: "tern", launchKey: request.launchKey, scopeId: request.scopeId, ...created, pid };
      }
      const paneId = await request.runtime.split({ paneId: request.parentPaneId, cwd: request.cwd, env: { ...request.env, JP_WORKFLOW_INHERITED_MANIFEST: prepared.path } });
      location = { paneId };
      const started = await request.runtime.launch({ paneId, harness: request.harness, name: request.name, args: request.args });
      location = { workspaceId: started.workspaceId, tabId: started.tabId, paneId: started.paneId, terminalId: started.terminalId };
      if (!started.nativeSession || started.paneId !== paneId || started.harness !== request.harness) throw new Error("Herdr launch lacks a pinned native session");
      const binding: WorkflowNativeBinding = { kind: "herdr", runtime: request.runtime, workspaceId: started.workspaceId, tabId: started.tabId, paneId, terminalId: started.terminalId, nativeSession: started.nativeSession, harness: request.harness };
      if (!await observeWorkflowBinding(binding)) throw new Error("Herdr session does not match the newly created pane");
      prepared.publish(binding);
      return { kind: "herdr", launchKey: request.launchKey, scopeId: request.scopeId, workspaceId: started.workspaceId, tabId: started.tabId, paneId, terminalId: started.terminalId, nativeSession: started.nativeSession };
    } catch (error: unknown) { throw new WorkflowLaunchUncertainError(request.launchKey, location, error); }
  } };
}
