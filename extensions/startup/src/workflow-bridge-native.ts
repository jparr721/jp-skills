import type { HerdrObservation, HerdrRuntime } from "./herdr-runtime";
import type { TernRuntime } from "./tern-runtime";

/** These identities must come from the owner's own backend launch, never the remote caller. */
export type WorkflowNativeBinding =
  | Readonly<{ kind: "tern"; runtime: Pick<TernRuntime, "ownsProcess">; blockId: string; pid: number }>
  | Readonly<{ kind: "herdr"; runtime: Pick<HerdrRuntime, "observe">; workspaceId: string; tabId: string; paneId: string; terminalId: string; nativeSession: string; harness: "omp" | "claude" }>;

/** Identity observation only: neither a live process nor Herdr's `done` proves a job result. */
export async function observeWorkflowBinding(binding: WorkflowNativeBinding): Promise<boolean> {
  try {
    if (binding.kind === "tern") return await binding.runtime.ownsProcess({ blockId: binding.blockId, pid: binding.pid });
    const observations = await binding.runtime.observe();
    const samePane = observations.filter((entry: HerdrObservation) => entry.workspaceId === binding.workspaceId && entry.paneId === binding.paneId);
    if (samePane.length !== 1) return false;
    const actual = samePane[0];
    return actual !== undefined && actual.tabId === binding.tabId && actual.terminalId === binding.terminalId && actual.nativeSession === binding.nativeSession && actual.harness === binding.harness;
  } catch { return false; }
}
