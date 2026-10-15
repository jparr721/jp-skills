import { expect, test } from "bun:test";
import { createHerdrCommandRunner, createHerdrRuntime, HerdrRuntimeError, runHerdrCommand } from "../src/herdr-runtime";
type ProcessResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
function output(value: unknown): ProcessResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}
function response(result: unknown): ProcessResult {
  return output({ id: "cli-1", result });
}
function agent() {
  return { agent: "omp", name: "crew-dev", agent_status: "done", interactive_ready: true,
    workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p3", terminal_id: "term-3",
    focused: false, revision: 18, state_change_seq: 42, completion_seq: 42,
    agent_session: { source: "herdr:omp", agent: "omp", kind: "path", value: "/sessions/dev.jsonl" } };
}
function schemaFixture(): ProcessResult {
  return output({ protocol: 22, schema_version: 1, schemas: { success_response: { $defs: {
    AgentInfo: { properties: { state_change_seq: { type: "integer" }, interactive_ready: { type: "boolean" }, agent_session: {} } },
    ResponseResult: { oneOf: ["tab_created", "tab_info", "pane_info", "agent_started", "agent_list"].map((type) => ({ properties: { type: { const: type } } })) },
  } } } });
}
function serverFixture(patch: Readonly<Record<string, unknown>>): ProcessResult {
  return output({ status: "running", running: true, version: "0.9.5", protocol: 22,
    compatible: true, endpoint_compatible: true, socket: "/test/herdr.sock", session: null,
    restart_needed: false, server_binary_stale: false, ...patch });
}
function harness(results: readonly ProcessResult[]) {
  const calls: (readonly string[])[] = [];
  const pending: ProcessResult[] = results.slice();
  const runtime = createHerdrRuntime({ session: "startup-test", workspaceId: "w1", binary: "/bin/herdr", run: async (argv) => {
    calls.push(argv);
    const next = pending.shift();
    if (!next) throw new Error("Unexpected connector command");
    return next;
  } });
  return { runtime, calls };
}
test("checks actual status envelope and bundled schema in the named session", async () => {
  const h = harness([serverFixture({}), schemaFixture()]);
  await h.runtime.check();
  expect(h.calls).toEqual([
    ["/bin/herdr", "--session", "startup-test", "status", "server", "--json"],
    ["/bin/herdr", "--session", "startup-test", "api", "schema", "--json"],
  ]);
});
test("rejects incompatible, stopped and unsupported servers before further commands", async () => {
  for (const patch of [{ compatible: false }, { endpoint_compatible: false }, { running: false }, { protocol: 21 }, { version: "0.9.4" }]) {
    const h = harness([serverFixture(patch)]);
    await expect(h.runtime.check()).rejects.toBeInstanceOf(HerdrRuntimeError);
    expect(h.calls).toHaveLength(1);
  }
  await expect(harness([serverFixture({}), output({ protocol: 22, schemas: {} })]).runtime.check()).rejects.toThrow("dependency_unavailable");
});
test("creates crew layout without focus and preserves explicit per-employee environment", async () => {
  const pane = agent();
  const h = harness([
    response({ type: "tab_created", tab: { tab_id: "w1:t2", workspace_id: "w1" }, root_pane: pane }),
    response({ type: "pane_info", pane: { ...pane, pane_id: "w1:p4" } }),
  ]);
  expect(await h.runtime.createCrew({ label: "crew a", cwd: "/repo with spaces", env: { OMP_PROFILE: "startup", STARTUP_V7_MANIFEST: "/a b/manifest.json" } })).toEqual({ tabId: "w1:t2", rootPaneId: "w1:p3" });
  expect(await h.runtime.split({ paneId: "w1:p3", cwd: "/repo with spaces", env: { STARTUP_V7_MANIFEST: "/qa/manifest.json" } })).toBe("w1:p4");
  expect(h.calls).toEqual([
    ["/bin/herdr", "--session", "startup-test", "tab", "create", "--workspace", "w1", "--cwd", "/repo with spaces", "--label", "crew a", "--no-focus", "--env", "OMP_PROFILE=startup", "--env", "STARTUP_V7_MANIFEST=/a b/manifest.json"],
    ["/bin/herdr", "--session", "startup-test", "pane", "split", "w1:p3", "--direction", "right", "--cwd", "/repo with spaces", "--no-focus", "--env", "STARTUP_V7_MANIFEST=/qa/manifest.json"],
  ]);
});
test("launches standalone OMP with literal argv and actual lifecycle normalization", async () => {
  const h = harness([response({ type: "agent_started", agent: agent(), argv: ["omp"] })]);
  expect(await h.runtime.launch({ paneId: "w1:p3", name: "crew-dev", args: ["--extension", "/a b/bootstrap.ts"] })).toEqual({ name: "crew-dev", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p3", terminalId: "term-3", nativeSession: "/sessions/dev.jsonl", state: "done", stateSequence: 42, interactiveReady: true });
  expect(h.calls).toEqual([["/bin/herdr", "--session", "startup-test", "agent", "start", "crew-dev", "--kind", "omp", "--pane", "w1:p3", "--", "--extension", "/a b/bootstrap.ts"]]);
});
test("observes selected workspace OMP roots and retains missing session evidence", async () => {
  const h = harness([response({ type: "agent_list", agents: [agent(), { ...agent(), name: null, agent_status: "unknown", agent_session: null }, { ...agent(), workspace_id: "w2" }, { ...agent(), agent: "codex" }] })]);
  const observed = await h.runtime.observe();
  expect(observed).toHaveLength(2);
  expect(observed[1]).toMatchObject({ name: null, nativeSession: null, state: "unknown" });
  expect(h.calls).toEqual([["/bin/herdr", "--session", "startup-test", "agent", "list"]]);
});
test("malformed JSON, missing sequence and wrong result kind retain actionable diagnostics", async () => {
  for (const stdout of ["not json", JSON.stringify({ id: "x", result: { type: "agent_list", agents: [{ ...agent(), state_change_seq: undefined }] } }), JSON.stringify({ id: "x", result: { type: "pane_list", panes: [] } })]) {
    const h = harness([{ exitCode: 0, stdout, stderr: "diagnostic" }]);
    try {
      await h.runtime.observe();
      throw new Error("Expected protocol rejection");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HerdrRuntimeError);
      if (!(error instanceof HerdrRuntimeError)) throw error;
      expect(error.command).toContain("startup-test");
      expect(error.stdout).toBe(stdout);
      expect(error.stderr).toBe("diagnostic");
      expect(error.exitCode).toBe(0);
    }
  }
});
test("launch-pending agents without session fields do not break observation of ready roots", async () => {
  const h = harness([response({ type: "agent_list", agents: [agent(), {
    workspace_id: "w1", tab_id: "w1:t3", pane_id: "w1:p4", terminal_id: "term-4",
    name: "s-pending", launch_pending: true, agent_status: "unknown", state_change_seq: 0,
  }] })]);
  expect(await h.runtime.observe()).toEqual([
    expect.objectContaining({ name: "crew-dev", nativeSession: "/sessions/dev.jsonl" }),
    expect.objectContaining({ name: "s-pending", nativeSession: null, state: "unknown", interactiveReady: false }),
  ]);
});
test("an exited named occupant with omitted agent fields does not block live observations", async () => {
  const h = harness([response({ type: "agent_list", agents: [agent(), {
    workspace_id: "w1", tab_id: "w1:t3", pane_id: "w1:p4", terminal_id: "term-4",
    name: "exited-root", agent_status: "idle", state_change_seq: 3, interactive_ready: true,
  }] })]);
  expect(await h.runtime.observe()).toEqual([expect.objectContaining({ name: "crew-dev" })]);
});
test("native session reporting before interactive readiness remains explicit pending evidence", async () => {
  const h = harness([response({ type: "agent_list", agents: [{ ...agent(), interactive_ready: undefined }] })]);
  expect(await h.runtime.observe()).toEqual([expect.objectContaining({ nativeSession: "/sessions/dev.jsonl", interactiveReady: false })]);
});
test("rejects cross-workspace layout and unexpected launched identity", async () => {
  await expect(harness([response({ type: "tab_created", tab: { tab_id: "w2:t2", workspace_id: "w2" }, root_pane: { ...agent(), workspace_id: "w2" } })]).runtime.createCrew({ label: "x", cwd: "/repo", env: {} })).rejects.toThrow("binding_mismatch");
  for (const patch of [{ pane_id: "w1:p9" }, { name: "wrong" }, { agent: "codex" }, { interactive_ready: false }]) {
    await expect(harness([response({ type: "agent_started", agent: { ...agent(), ...patch }, argv: ["omp"] })]).runtime.launch({ paneId: "w1:p3", name: "crew-dev", args: [] })).rejects.toBeInstanceOf(HerdrRuntimeError);
  }
});
test("ambiguous writes are not retried and preserve status and response body", async () => {
  const failure = { exitCode: 1, stdout: "", stderr: '{"id":"start","error":{"code":"timeout","message":"readiness timed out"}}' };
  const h = harness([failure]);
  try {
    await h.runtime.launch({ paneId: "w1:p3", name: "crew-dev", args: [] });
    throw new Error("Expected failed launch");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HerdrRuntimeError);
    if (!(error instanceof HerdrRuntimeError)) throw error;
    expect(error.exitCode).toBe(1);
    expect(error.stderr).toBe(failure.stderr);
    expect(error.message).toContain("command_failed");
  }
  expect(h.calls).toHaveLength(1);
});
test("invalid environment and command inputs fail before subprocess admission", async () => {
  const h = harness([]);
  await expect(h.runtime.split({ paneId: "w1:p3", cwd: "/repo", env: { "BAD=NAME": "x" } })).rejects.toThrow();
  await expect(h.runtime.launch({ paneId: "w1:p3", name: "UPPER", args: [] })).rejects.toThrow();
  expect(h.calls).toHaveLength(0);
});
test("real subprocess passes shell metacharacters literally and captures both streams", async () => {
  const literal = "$(echo SHOULD_NOT_EXECUTE); > /unused";
  expect(await runHerdrCommand([process.execPath, "-e", "console.log(JSON.stringify(process.argv.at(-1))); console.error('stderr-body'); process.exitCode=7", literal])).toEqual({ exitCode: 7, stdout: `${JSON.stringify(literal)}\n`, stderr: "stderr-body\n" });
});
test("preserves each supported lifecycle and native ID session without conflating completion", async () => {
  for (const state of ["working", "idle", "done", "blocked", "unknown"]) {
    const h = harness([response({ type: "agent_list", agents: [{ ...agent(), agent_status: state, agent_session: { source: "herdr:omp", agent: "omp", kind: "id", value: "native-id" } }] })]);
    expect((await h.runtime.observe())[0]).toMatchObject({ state, nativeSession: "native-id", stateSequence: 42 });
  }
  for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(harness([response({ type: "agent_list", agents: [{ ...agent(), state_change_seq: sequence }] })]).runtime.observe()).rejects.toThrow("invalid_response");
  }
});
test("spawn failure and invalid argv retain actionable command context", async () => {
  await expect(runHerdrCommand([])).rejects.toThrow("invalid_request");
  await expect(runHerdrCommand(["/missing/startup-herdr-test-binary"])).rejects.toThrow("spawn_failed");
  const runtime = createHerdrRuntime({ session: "named", workspaceId: "w1", binary: "/herdr", run: async () => { throw new Error("transport lost"); } });
  await expect(runtime.split({ paneId: "w1:p1", cwd: "/repo", env: {} })).rejects.toThrow("transport lost");
});
test("renames a finished crew tab in the selected session without changing focus", async () => {
  const h = harness([response({ type: "tab_info", tab: { tab_id: "w1:t2", workspace_id: "w1", label: "crew next" } })]);
  expect(await h.runtime.renameCrew({ tabId: "w1:t2", label: "crew next" })).toBeUndefined();
  expect(h.calls).toEqual([["/bin/herdr", "--session", "startup-test", "tab", "rename", "w1:t2", "crew next"]]);
});
test("rename rejects wrong workspace, tab, label and response variant", async () => {
  for (const tab of [
    { tab_id: "w1:t2", workspace_id: "w2", label: "crew next" },
    { tab_id: "w1:t3", workspace_id: "w1", label: "crew next" },
    { tab_id: "w1:t2", workspace_id: "w1", label: "old crew" },
  ]) {
    const h = harness([response({ type: "tab_info", tab })]);
    await expect(h.runtime.renameCrew({ tabId: "w1:t2", label: "crew next" })).rejects.toThrow("binding_mismatch");
    expect(h.calls).toHaveLength(1);
  }
  const h = harness([response({ type: "tab_created", tab: { tab_id: "w1:t2", workspace_id: "w1", label: "crew next" } })]);
  await expect(h.runtime.renameCrew({ tabId: "w1:t2", label: "crew next" })).rejects.toThrow("invalid_response");
});
test("rename does not retry ambiguous writes or admit invalid positional arguments", async () => {
  const failure = { exitCode: 1, stdout: "", stderr: '{"id":"rename","error":{"code":"timeout","message":"unknown result"}}' };
  const h = harness([failure]);
  await expect(h.runtime.renameCrew({ tabId: "w1:t2", label: "crew next" })).rejects.toThrow("command_failed");
  expect(h.calls).toHaveLength(1);
  const invalid = harness([]);
  await expect(invalid.runtime.renameCrew({ tabId: "--current", label: "crew next" })).rejects.toThrow("invalid_request");
  await expect(invalid.runtime.renameCrew({ tabId: "w1:t2", label: "--focus" })).rejects.toThrow("invalid_request");
  expect(invalid.calls).toHaveLength(0);
});
test("bounded runner kills its hung subprocess and reports the timeout without retrying", async () => {
  const run = createHerdrCommandRunner({ timeoutMs: 100 });
  const started = performance.now();
  try {
    await run([process.execPath, "-e", "console.log(process.pid); console.error('before-timeout'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"]);
    throw new Error("Expected timeout");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HerdrRuntimeError);
    if (!(error instanceof HerdrRuntimeError)) throw error;
    expect(error.code).toBe("command_timeout");
    expect(error.detail).toContain("100ms");
    expect(error.detail).toContain("reconcile");
    expect(error.stderr).toContain("before-timeout");
    const pid = Number(error.stdout.trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(performance.now() - started).toBeLessThan(1500);
  }
  expect(await run([process.execPath, "-e", "console.log('next-command')"])).toEqual({ exitCode: 0, stdout: "next-command\n", stderr: "" });
});
test("timeout also bounds pipe reads when an owned descendant inherits the CLI output", async () => {
  const run = createHerdrCommandRunner({ timeoutMs: 100 });
  const started = performance.now();
  let descendant: number | null = null;
  try {
    await run([process.execPath, "-e", "const child=Bun.spawn([process.execPath,'-e','setTimeout(()=>process.exit(0),2000)'],{stdin:'ignore',stdout:'inherit',stderr:'inherit'}); console.log(child.pid); setInterval(()=>{},1000)"]);
    throw new Error("Expected timeout");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HerdrRuntimeError);
    if (!(error instanceof HerdrRuntimeError)) throw error;
    const pid: number = Number(error.stdout.trim());
    if (Number.isSafeInteger(pid) && pid > 0) descendant = pid;
    expect(descendant).not.toBeNull();
    expect(error.code).toBe("command_timeout");
    expect(performance.now() - started).toBeLessThan(1000);
  } finally {
    if (descendant !== null) {
      try { process.kill(descendant, "SIGKILL"); }
      catch (error: unknown) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
  }
});
