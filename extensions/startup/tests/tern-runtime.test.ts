import { expect, test } from "bun:test";
import { createTernRuntime, ternContext, TernRuntimeError, type TernCommandResult } from "../src/tern-runtime";

function output(value: unknown): TernCommandResult { return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" }; }
function layout(blocks: readonly { id: number; live: boolean }[] = [{ id: 3, live: true }]) {
  return { sessions: [{ id: 1, tabs: [{ id: 2, blocks }] }], detached: [] };
}
function processResult(pid = 100) {
  return { pane: 3, child: { pid, name: "fish", argv: ["fish", "-c", "omp"], cwd: "/repo" }, group: pid, foreground: { pid, name: "fish", argv: ["fish", "-c", "omp"], cwd: "/repo" } };
}
function harness(responses: readonly unknown[], parentPid: (pid: number) => Promise<number | null> = async () => null) {
  const calls: (readonly string[])[] = [];
  const pending = [...responses];
  const run = async (argv: readonly string[]) => {
    calls.push(argv);
    const response = pending.shift();
    if (response === undefined) throw new Error("Unexpected command");
    return output(response);
  };
  return { calls, run, runtime: createTernRuntime({ binary: "/bin/tern", window: "", sessionId: "1", run, parentPid }) };
}

test("resolves exact live block in explicitly selected window", async () => {
  const h = harness([layout()]);
  expect(await ternContext({ binary: "/bin/tern", window: "", blockId: "3", run: h.run })).toEqual({ window: "", sessionId: "1", tabId: "2", blockId: "3" });
  expect(h.calls).toEqual([["/bin/tern", "inspect", "--window", "", "--json"]]);
  await expect(ternContext({ binary: "/bin/tern", window: "", blockId: "3", run: harness([layout([{ id: 3, live: false }])]).run })).rejects.toBeInstanceOf(TernRuntimeError);
});

test("creates an atomic launch in the selected session and verifies its returned layout", async () => {
  const h = harness([layout(), { session: 1, tab: 4, block: 5 }, { sessions: [{ id: 1, tabs: [{ id: 4, blocks: [{ id: 5, live: true }] }] }] }]);
  expect(await h.runtime.createTab({ cwd: "/repo with spaces", argv: ["omp", "--extension", "/file name"] })).toEqual({ sessionId: "1", tabId: "4", blockId: "5" });
  expect(h.calls[1]).toEqual(["/bin/tern", "new", "tab", "1", "--cwd", "/repo with spaces", "--keep-open", "--window", "", "--json", "--", "omp", "--extension", "/file name"]);
});

test("rejects a block in a foreign session and a mismatched create response", async () => {
  const foreign = harness([{ sessions: [{ id: 9, tabs: [{ id: 2, blocks: [{ id: 3, live: true }] }] }] }]);
  await expect(foreign.runtime.process({ blockId: "3" })).rejects.toThrow("selected Tern session");
  expect(foreign.calls).toHaveLength(1);
  const wrong = harness([layout(), { session: 9, tab: 2, block: 4 }]);
  await expect(wrong.runtime.createTab({ cwd: "/repo", argv: ["omp"] })).rejects.toThrow("different session");
});

test("process reports only Tern's real process data", async () => {
  const h = harness([layout(), processResult()]);
  expect(await h.runtime.process({ blockId: "3" })).toEqual({ ...processResult(), pane: "3" });
  expect(h.calls[1]).toEqual(["/bin/tern", "process", "3", "--window", "", "--json"]);
});

test("process ownership requires a live ancestry and stable scoped child", async () => {
  const parents = new Map([[102, 101], [101, 100], [100, 99]]);
  const parentPid = async (pid: number) => parents.get(pid) ?? null;
  const valid = harness([layout(), processResult(), layout(), processResult()], parentPid);
  expect(await valid.runtime.ownsProcess({ blockId: "3", pid: 102 })).toBe(true);
  const unrelated = harness([layout(), processResult()], parentPid);
  expect(await unrelated.runtime.ownsProcess({ blockId: "3", pid: 999 })).toBe(false);
  const replaced = harness([layout(), processResult(), layout(), processResult(200)], parentPid);
  expect(await replaced.runtime.ownsProcess({ blockId: "3", pid: 102 })).toBe(false);
  expect(await valid.runtime.ownsProcess({ blockId: "3", pid: 0 })).toBe(false);
});

test("split checks the source and resulting tab", async () => {
  const h = harness([layout(), { session: 1, tab: 8, block: 4 }, { sessions: [{ id: 1, tabs: [{ id: 8, blocks: [{ id: 4, live: true }] }] }] }]);
  await expect(h.runtime.split({ blockId: "3", cwd: "/repo", argv: ["omp"] })).rejects.toThrow("different tab");
});

test("absence requires an unambiguous selected session and no detached blocks", async () => {
  expect(await harness([layout([])]).runtime.isAbsent({ blockId: "3" })).toBe(true);
  expect(await harness([layout([{ id: 3, live: false }])]).runtime.isAbsent({ blockId: "3" })).toBe(true);
  expect(await harness([layout()]).runtime.isAbsent({ blockId: "3" })).toBe(false);
  await expect(harness([{ sessions: [], detached: [] }]).runtime.isAbsent({ blockId: "3" })).rejects.toThrow("selected session");
  await expect(harness([{ ...layout([]), detached: [{}] }]).runtime.isAbsent({ blockId: "3" })).rejects.toThrow("detached");
  await expect(harness([{ sessions: [{ id: 1, tabs: [] }, { id: 9, tabs: [{ id: 2, blocks: [{ id: 3, live: true }] }] }], detached: [] }]).runtime.isAbsent({ blockId: "3" })).rejects.toThrow("different session");
});

test("PID absence never treats a live or invalid process as absent", async () => {
  const runtime = harness([]).runtime;
  expect(await runtime.isProcessAbsent({ pid: process.pid })).toBe(false);
  await expect(runtime.isProcessAbsent({ pid: 0 })).rejects.toThrow();
});
