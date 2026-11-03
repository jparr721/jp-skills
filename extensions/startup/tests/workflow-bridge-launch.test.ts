import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { BoundedWorkflowHost } from "../src/workflow-host";
import { readRunManifest, startWorkflowBridge } from "../src/workflow-bridge";
import { createWorkflowBridgeLauncher, WorkflowLaunchUncertainError } from "../src/workflow-bridge-launch";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const bridge = await startWorkflowBridge(host, { verifyTerminal: async () => null });
  cleanup.push(bridge.close);
  return { host, bridge, launcher: createWorkflowBridgeLauncher({ bridge }) };
}

test("Tern gets a fixed private manifest only after its new process is pinned", async () => {
  const { host, bridge, launcher } = await fixture();
  let manifest = "";
  const runtime = {
    split: async (input: { argv: readonly string[] }) => {
      manifest = (input.argv.find((arg) => arg.startsWith("JP_WORKFLOW_INHERITED_MANIFEST=")) ?? "").split("=")[1] ?? "";
      expect(input.argv).toContain("HOME=/home/worker");
      expect(existsSync(manifest)).toBe(false);
      return { sessionId: "1", tabId: "2", blockId: "3" };
    },
    process: async () => ({ pane: "3", child: { pid: 123, name: "omp", argv: ["omp"], cwd: "/repo" }, foreground: null, group: 123 }),
    ownsProcess: async ({ blockId, pid }: { blockId: string; pid: number }) => blockId === "3" && pid === 123,
  };
  const result = await launcher.launch({ kind: "tern", runtime, launchKey: "launch-1", scopeId: host.rootId, cwd: "/repo", env: { HOME: "/home/worker" }, parentBlockId: "2", argv: ["omp", "--extension=/extension.ts"] });
  expect(result).toEqual({ kind: "tern", launchKey: "launch-1", scopeId: host.rootId, sessionId: "1", tabId: "2", blockId: "3", pid: 123 });
  expect(readRunManifest(manifest)).toMatchObject({ socket: bridge.socket, scopeId: host.rootId });
  await expect(launcher.launch({ kind: "tern", runtime, launchKey: "launch-1", scopeId: host.rootId, cwd: "/repo", parentBlockId: "2", argv: ["omp"] })).rejects.toThrow("already attempted");
});

test("Herdr pins the newly allocated pane and exact observed native session", async () => {
  const { host, launcher } = await fixture();
  let manifest = "";
  const observation = { workspaceId: "w", tabId: "t", paneId: "p", terminalId: "term", nativeSession: "session", harness: "omp" as const, name: "worker", state: "idle" as const, stateSequence: 1, interactiveReady: true };
  const runtime = {
    split: async (input: { env: Readonly<Record<string, string>> }) => { manifest = input.env.JP_WORKFLOW_INHERITED_MANIFEST ?? ""; expect(input.env.HOME).toBe("/home/worker"); expect(existsSync(manifest)).toBe(false); return "p"; },
    launch: async () => observation,
    observe: async () => [observation],
  };
  const result = await launcher.launch({ kind: "herdr", runtime, launchKey: "launch-2", scopeId: host.rootId, cwd: "/repo", env: { HOME: "/home/worker" }, parentPaneId: "parent", name: "worker", harness: "omp", args: ["--extension=/extension.ts"] });
  expect(result).toMatchObject({ kind: "herdr", paneId: "p", nativeSession: "session" });
  expect(readRunManifest(manifest).scopeId).toBe(host.rootId);
});

test("uncertain launch is never repeated and no manifest is published", async () => {
  const { host, launcher } = await fixture();
  let manifest = "";
  let effects = 0;
  const runtime = {
    split: async (input: { argv: readonly string[] }) => { effects += 1; manifest = (input.argv[1] ?? "").split("=")[1] ?? ""; return { sessionId: "1", tabId: "2", blockId: "3" }; },
    process: async () => ({ pane: "3", child: null, foreground: null, group: null }),
    ownsProcess: async () => false,
  };
  const request = { kind: "tern" as const, runtime, launchKey: "uncertain", scopeId: host.rootId, cwd: "/repo", parentBlockId: "2", argv: ["omp"] };
  await expect(launcher.launch({ ...request, env: { JP_WORKFLOW_INHERITED_MANIFEST: "/forged" } })).rejects.toThrow("Invalid workflow launch environment");
  expect(effects).toBe(0);
  await expect(launcher.launch(request)).rejects.toBeInstanceOf(WorkflowLaunchUncertainError);
  expect(existsSync(manifest)).toBe(false);
  await expect(launcher.launch(request)).rejects.toThrow("already attempted");
  expect(effects).toBe(1);
});
