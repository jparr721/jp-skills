import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { BoundedWorkflowHost } from "../src/workflow-host";
import { readRunManifest, startWorkflowBridge } from "../src/workflow-bridge";
import { createWorkflowBridgeLauncher, WorkflowLaunchUncertainError } from "../src/workflow-bridge-launch";
import type { TernProcess } from "../src/tern-runtime";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(identityTimeoutMs = 1000) {
  const host = new BoundedWorkflowHost("pipeline", ["A"], 2);
  const bridge = await startWorkflowBridge(host, { verifyTerminal: async () => null });
  cleanup.push(bridge.close);
  return { host, bridge, launcher: createWorkflowBridgeLauncher({ bridge, identityTimeoutMs }) };
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

test("Tern waits for the launched process before publishing its manifest", async () => {
  const { host, bridge, launcher } = await fixture();
  let manifest = "";
  let observations = 0;
  const runtime = {
    split: async (input: { argv: readonly string[] }) => {
      manifest = (input.argv.find((arg) => arg.startsWith("JP_WORKFLOW_INHERITED_MANIFEST=")) ?? "").split("=")[1] ?? "";
      return { sessionId: "1", tabId: "2", blockId: "3" };
    },
    process: async () => {
      expect(existsSync(manifest)).toBe(false);
      observations += 1;
      const child = observations === 1
        ? { pid: 123, name: "fish", argv: ["fish"], cwd: "/repo" }
        : { pid: 123, name: "omp", argv: ["omp"], cwd: "/repo" };
      return { pane: "3", child, foreground: child, group: 123 };
    },
    ownsProcess: async ({ pid }: { pid: number }) => pid === 123,
  };
  const receipt = await launcher.launch({ kind: "tern", runtime, launchKey: "delayed", scopeId: host.rootId, cwd: "/repo", parentBlockId: "2", argv: ["omp"] });
  expect(receipt).toMatchObject({ kind: "tern", pid: 123 });
  expect(observations).toBe(2);
  expect(readRunManifest(manifest)).toMatchObject({ socket: bridge.socket, scopeId: host.rootId });
});

test("Tern times out a stalled identity read without publishing authority", async () => {
  const { host, launcher } = await fixture(30);
  const pending = Promise.withResolvers<TernProcess>();
  let manifest = "";
  const runtime = {
    split: async (input: { argv: readonly string[] }) => {
      manifest = (input.argv.find((arg) => arg.startsWith("JP_WORKFLOW_INHERITED_MANIFEST=")) ?? "").split("=")[1] ?? "";
      return { sessionId: "1", tabId: "2", blockId: "3" };
    },
    process: () => pending.promise,
    ownsProcess: async () => true,
  };
  const request = { kind: "tern" as const, runtime, launchKey: "stalled", scopeId: host.rootId, cwd: "/repo", parentBlockId: "2", argv: ["omp"] };
  await expect(launcher.launch(request)).rejects.toBeInstanceOf(WorkflowLaunchUncertainError);
  expect(existsSync(manifest)).toBe(false);
  await expect(launcher.launch(request)).rejects.toThrow("already attempted");
});

test("Tern refuses ambiguous matching process identities", async () => {
  const { host, launcher } = await fixture();
  let manifest = "";
  const runtime = {
    split: async (input: { argv: readonly string[] }) => {
      manifest = (input.argv.find((arg) => arg.startsWith("JP_WORKFLOW_INHERITED_MANIFEST=")) ?? "").split("=")[1] ?? "";
      return { sessionId: "1", tabId: "2", blockId: "3" };
    },
    process: async () => ({
      pane: "3",
      child: { pid: 123, name: "omp", argv: ["omp"], cwd: "/repo" },
      foreground: { pid: 456, name: "omp", argv: ["omp"], cwd: "/repo" },
      group: 123,
    }),
    ownsProcess: async () => true,
  };
  await expect(launcher.launch({ kind: "tern", runtime, launchKey: "ambiguous", scopeId: host.rootId, cwd: "/repo", parentBlockId: "2", argv: ["omp"] })).rejects.toThrow("identity is ambiguous");
  expect(existsSync(manifest)).toBe(false);
});

test("Tern publication failure keeps the launch uncertain and consumes its key", async () => {
  const { host, bridge } = await fixture();
  let manifest = "";
  let splits = 0;
  const launcher = createWorkflowBridgeLauncher({
    bridge: {
      prepareRunManifest: (input) => {
        const prepared = bridge.prepareRunManifest(input);
        return { path: prepared.path, publish: () => { throw new Error("disk write failed"); } };
      },
    },
  });
  const runtime = {
    split: async (input: { argv: readonly string[] }) => {
      splits += 1;
      manifest = (input.argv.find((arg) => arg.startsWith("JP_WORKFLOW_INHERITED_MANIFEST=")) ?? "").split("=")[1] ?? "";
      return { sessionId: "1", tabId: "2", blockId: "3" };
    },
    process: async () => ({ pane: "3", child: { pid: 123, name: "omp", argv: ["omp"], cwd: "/repo" }, foreground: null, group: 123 }),
    ownsProcess: async () => true,
  };
  const request = { kind: "tern" as const, runtime, launchKey: "publish-failed", scopeId: host.rootId, cwd: "/repo", parentBlockId: "2", argv: ["omp"] };
  const attempt = launcher.launch(request);
  await expect(attempt).rejects.toBeInstanceOf(WorkflowLaunchUncertainError);
  await expect(attempt).rejects.toThrow("disk write failed");
  expect(existsSync(manifest)).toBe(false);
  await expect(launcher.launch(request)).rejects.toThrow("already attempted");
  expect(splits).toBe(1);
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
    split: async (input: { argv: readonly string[] }) => { effects += 1; manifest = (input.argv.find((arg) => arg.startsWith("JP_WORKFLOW_INHERITED_MANIFEST=")) ?? "").split("=")[1] ?? ""; return { sessionId: "1", tabId: "2", blockId: "3" }; },
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
