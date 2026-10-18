import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { openStore, type StartupStore } from "../src/store";
import { openCoordinator, serveCoordinator, type Coordinator } from "../src/coordinator";
import type { HerdrObservation, HerdrRuntime } from "../src/herdr-runtime";
import { connectEmployee } from "../src/employee-client";
import { hostReceiptSchema, hostStatusSchema, sourceSchema } from "../src/contracts";
import { claudeMcpConfig } from "../src/claude-launch";
import { loadProfile, profileText, validateRoleSettings } from "../src/profiles";

const roots: string[] = [];
const stores: StartupStore[] = [];
const servers: ReturnType<typeof serveCoordinator>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const manifestSchema = z.object({ credential: z.string(), source: sourceSchema });
function fixture(executionLimit: number) {
  return harnessFixture(executionLimit, "omp");
}
function harnessFixture(executionLimit: number, harness: "omp" | "claude") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sv7-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const boundRoot = join(root, "repo");
  mkdirSync(boundRoot);
  const startupRoot = join(root, "config", "ronin", "startups", "test");
  const stateDirectory = startupRoot;
  const managerFile = join(root, "manager.jsonl");
  writeFileSync(managerFile, JSON.stringify({ type: "session", id: "manager-session" }) + "\n");
  let now = 1000;
  const store = openStore({ path: join(stateDirectory, "staff.sqlite"), scope: { skillsHome: home, startupRoot, boundRoot, host: "host", name: "test", managerSession: "manager-session" }, owner: { id: "coordinator", managerGeneration: 1, leaseMs: 60000 }, now: () => now });
  stores.push(store);
  store.initializeRoleSettings(harness);
  const managerNative = harness === "claude" ? "manager-session" : managerFile;
  const observations: HerdrObservation[] = [{ harness, name: "manager", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term1", nativeSession: managerNative, state: "idle", stateSequence: 1, interactiveReady: true }];
  const launches: Readonly<{ harness: "omp" | "claude"; paneId: string; name: string; args: readonly string[] }>[] = [];
  const layouts: Readonly<Record<string, string>>[] = [];
  let next = 2;
  let launchBarrier: Promise<void> | null = null;
  let layoutFailure: Error | null = null;
  let layoutCalls = 0;
  let observationFailure: Error | null = null;
  let observationBarrier: Promise<void> | null = null;
  const herdr: HerdrRuntime = {
    check: async () => {},
    renameCrew: async () => {},
    createCrew: async (input) => {
      layouts.push(input.env);
      layoutCalls += 1;
      if (layoutFailure) throw layoutFailure;
      return { tabId: `w1:t${next}`, rootPaneId: `w1:p${next++}` };
    },
    split: async (input) => { layouts.push(input.env); return `w1:p${next++}`; },
    launch: async (input) => {
      launches.push(input);
      if (launchBarrier) await launchBarrier;
      const nativeSession = input.harness === "claude" ? input.args[input.args.indexOf("--session-id") + 1]! : join(root, `${input.name}.jsonl`);
      if (input.harness === "omp") writeFileSync(nativeSession, JSON.stringify({ type: "session", id: input.name }) + "\n");
      const observation: HerdrObservation = { harness: input.harness, name: input.name, workspaceId: "w1", tabId: "w1:t2", paneId: input.paneId, terminalId: `term-${input.name}`, nativeSession, state: "idle", stateSequence: 1, interactiveReady: true };
      observations.push(observation);
      return observation;
    },
    observe: async () => { if (observationBarrier) await observationBarrier; if (observationFailure) throw observationFailure; return observations; },
  };
  const config = { name: "test", stateDirectory, startupRoot, skillsHome: home, boundRoot, skillsRoot: resolve(import.meta.dir, "../../.."), socketPath: join(stateDirectory, "runtime.sock"), profile: "default", herdrIntegration: "/fixture/herdr.ts", managerSession: "manager-session", managerFile, managerPaneId: "w1:p1", managerCredential: "manager-secret", policy: { tickMs: 10, paCadenceMs: 100, progressDeadlineMs: 200, connectionDeadlineMs: 1000, executionLimit }, ...(harness === "claude" ? { harness } : {}) };
  const coordinator: Coordinator = openCoordinator({ store, herdr, config, now: () => now });
  async function admit(employeeId: string): Promise<string> {
    const runtime = store.runtimeBindings().findLast((r) => r.employeeId === employeeId);
    if (!runtime) throw new Error("Missing runtime");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(stateDirectory, "launches", `${runtime.launchId}.json`), "utf8")));
    const observation = observations.find((o) => o.paneId === runtime.paneId);
    if (!observation?.nativeSession) throw new Error("Missing observation");
    return (await coordinator.admit({ credential: manifest.credential, nativeSession: observation.nativeSession, ...(runtime.settings.requested.harness === "omp" ? { agentSessionId: z.object({ id: z.string() }).parse(JSON.parse(readFileSync(observation.nativeSession, "utf8").split("\n")[0]!)).id } : {}), paneId: observation.paneId, source: manifest.source })).connection;
  }
  async function ready() {
    await coordinator.start();
    const manager = await coordinator.admit({ credential: "manager-secret", nativeSession: managerNative, paneId: "w1:p1", source: store.runtimeBindings().find((r) => r.employeeId === "manager")!.source });
    const pa = store.snapshot().employees.find((e) => e.role === "pa");
    if (!pa) throw new Error("Missing PA");
    const paConnection = await admit(pa.id);
    return { manager: manager.connection, pa: pa.id, paConnection };
  }
  async function delegate(manager: string, eventId: string) {
    await coordinator.command(manager, { kind: "intake", eventId, input: "fix", amendItemIds: [] });
    await coordinator.command(manager, { kind: "delegate", eventId, developers: 1 });
    await coordinator.launching();
    const team = store.snapshot().teams.find((t) => t.eventId === eventId);
    if (!team) throw new Error("Missing team");
    return team;
  }
  function setRoleSettings(role: "manager" | "architect" | "qa" | "dev" | "devops" | "pa", selectedHarness: "omp" | "claude", model: string | null, effort: string | null): void {
    const saved = store.roleSettings(role);
    const validated = validateRoleSettings({ role, harness: selectedHarness, model, effort });
    if (validated.status !== "accepted") throw new Error(validated.reason);
    store.saveRoleSettings({ manager: store.managerBinding, requested: validated.requested, expectedRevision: saved.revision });
  }
  return { coordinator, store, config, observations, launches, layouts, root, home, ready, admit, delegate, setRoleSettings, advance: (time: number) => { now = time; }, delayLaunch: (barrier: Promise<void>) => { launchBarrier = barrier; }, delayObservation: (barrier: Promise<void>) => { observationBarrier = barrier; }, failLayout: (error: Error) => { layoutFailure = error; }, failObservation: (error: Error | null) => { observationFailure = error; }, layoutCalls: () => layoutCalls };
}

test("admission preserves observation progress committed while its Herdr read is pending", async () => {
  const f = fixture(8);
  const { pa } = await f.ready();
  const saved = f.store.runtimeBindings().find((r) => r.employeeId === pa);
  if (!saved?.nativeSession) throw new Error("PA identity missing");
  const barrier = Promise.withResolvers<void>();
  f.delayObservation(barrier.promise);
  const admitting = f.admit(pa);
  f.store.observeRuntime({ employeeId: pa, generation: saved.generation, nativeSession: saved.nativeSession, state: "done", sequence: 10, observedAt: 1000 });
  barrier.resolve();
  await expect(admitting).resolves.toBeString();
  expect(f.store.runtimeBindings().find((r) => r.employeeId === pa)).toMatchObject({ stateSequence: 10, observedState: "done" });
});

test("OMP launches use only the Startup root and the stock default profile", async () => {
  const f = fixture(8);
  await f.ready();
  const saved = f.store.runtimeBindings().find((entry) => entry.employeeId !== "manager");
  if (!saved) throw new Error("Missing PA launch");
  expect(f.layouts[0]).toEqual({
    JP_SKILLS_HOME: f.config.skillsHome,
    STARTUP_ROOT: f.config.startupRoot,
    STARTUP_V7_MANIFEST: join(f.config.startupRoot, "launches", `${saved.launchId}.json`),
    OMPCODE: "",
    OMP_PROFILE: "default",
    PI_PROFILE: "default",
    PI_CODING_AGENT_DIR: f.config.startupRoot,
    STARTUP_HERDR_OMP_EXTENSION: f.config.herdrIntegration,
  });
  expect(existsSync(join(f.config.startupRoot, "staff.sqlite"))).toBe(true);
  expect(existsSync(join(f.config.skillsHome, "startup", f.config.name))).toBe(false);
});

test("one Startup freezes six role settings and launches mixed OMP and interactive Claude processes", async () => {
  const f = fixture(10);
  f.setRoleSettings("manager", "omp", null, null);
  f.setRoleSettings("pa", "claude", "sonnet", "high");
  f.setRoleSettings("architect", "claude", "opus", "max");
  f.setRoleSettings("qa", "omp", "openai/gpt-5.2", "medium");
  f.setRoleSettings("dev", "claude", "sonnet", "xhigh");
  f.setRoleSettings("devops", "omp", "anthropic/claude-sonnet-4-5", "auto");
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "mixed-role-crew");
  const hire = z.object({ employees: z.array(z.object({ id: z.string() })) }).parse(await f.coordinator.command(manager, { kind: "hire", requestId: "mixed-devops", role: "devops", additional: 1 }));
  const devops = hire.employees[0]?.id;
  if (devops === undefined) throw new Error("Missing devops employee");
  await f.coordinator.command(manager, { kind: "activate", employeeIds: [devops] });
  await f.coordinator.launching();
  const idsByRole = new Map(f.store.employees().map((employee) => [employee.role, employee.id]));
  const runtimeByRole = new Map(f.store.runtimeBindings().map((runtime) => [f.store.getEmployee(runtime.employeeId).role, runtime]));
  expect(runtimeByRole.get("manager")?.settings.requested.harness).toBe("omp");
  expect(runtimeByRole.get("pa")?.settings.requested).toMatchObject({ harness: "claude", model: { value: "sonnet", validation: "unverified" }, effort: { value: "high", validation: "unverified" } });
  expect(runtimeByRole.get("qa")?.settings).toMatchObject({ scope: "future_launch", revision: 1, provenance: { kind: "manager_request", actor: "manager" } });
  expect(runtimeByRole.get("architect")?.settings.requested.harness).toBe("claude");
  expect(runtimeByRole.get("qa")?.settings.requested.harness).toBe("omp");
  expect(runtimeByRole.get("dev")?.settings.requested.harness).toBe("claude");
  expect(runtimeByRole.get("devops")?.settings.requested.harness).toBe("omp");
  expect(f.launches.map((launch) => launch.harness)).toEqual(["claude", "claude", "omp", "claude", "omp"]);
  expect(f.launches.find((launch) => launch.name === `s-${runtimeByRole.get("qa")?.launchId.replaceAll("-", "").slice(0, 28)}`)?.args.slice(-4)).toEqual(["--model", "openai/gpt-5.2", "--thinking", "medium"]);
  expect(f.launches.find((launch) => launch.name === `s-${runtimeByRole.get("devops")?.launchId.replaceAll("-", "").slice(0, 28)}`)?.args.slice(-4)).toEqual(["--model", "anthropic/claude-sonnet-4-5", "--thinking", "auto"]);
  expect(f.layouts.filter((env) => env.PI_CODING_AGENT_DIR !== undefined).every((env) => env.PI_CODING_AGENT_DIR === f.config.startupRoot && env.OMP_PROFILE === "default")).toBe(true);
  expect(f.layouts.filter((env) => env.CLAUDE_CONFIG_DIR !== undefined).every((env) => env.CLAUDE_CONFIG_DIR === f.config.startupRoot)).toBe(true);
  const architect = idsByRole.get("architect");
  if (architect === undefined) throw new Error("Missing architect employee");
  expect(team.architect).toBe(architect);
  await f.admit(architect);
  const staff = z.object({ runtime: z.array(z.object({ employeeId: z.string(), capability: z.object({ status: z.string(), reason: z.string().optional() }), effectiveSettings: z.object({ status: z.string(), reason: z.string().optional() }) })) }).passthrough().parse(await f.coordinator.command(manager, { kind: "staff" }));
  const claudeRuntime = staff.runtime.find((runtime) => runtime.employeeId === team.architect);
  expect(claudeRuntime).toMatchObject({ capability: { status: "unavailable", reason: "claude_cli_catalog_unavailable" }, effectiveSettings: { status: "unavailable", reason: "claude_cli_readback_unavailable" } });
});

test("OMP session reports persist actual catalog and state only for the authenticated native launch", async () => {
  const f = fixture(8);
  const { manager, pa } = await f.ready();
  const runtime = f.store.runtimeBindings().findLast((entry) => entry.employeeId === pa);
  if (!runtime?.nativeSession || runtime.paneId === null) throw new Error("Missing admitted OMP native session");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.config.stateDirectory, "launches", `${runtime.launchId}.json`), "utf8")));
  servers.push(serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath }));
  const client = await connectEmployee({ socketPath: f.config.socketPath, credential: manifest.credential, nativeSession: runtime.nativeSession, agentSessionId: `s-${runtime.launchId.replaceAll("-", "").slice(0, 28)}`, paneId: runtime.paneId, source: manifest.source });
  const report = { status: "available" as const, nativeSession: runtime.nativeSession, agentSessionId: `s-${runtime.launchId.replaceAll("-", "").slice(0, 28)}`, observedAt: 2000, model: { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" }, availableModels: [{ provider: "openai", id: "gpt-5.2", name: "GPT-5.2" }], configuredEffort: "high", effectiveEffort: "high", availableEfforts: ["low", "high"] };
  await client.poll(report);
  expect(f.store.runtimeCapability(pa, runtime.generation)).toMatchObject({ status: "available", availableModels: [{ id: "gpt-5.2" }], availableEfforts: ["low", "high"] });
  expect(f.store.effectiveRoleSettings(pa, runtime.generation)).toMatchObject({ status: "available", model: { id: "gpt-5.2" }, configuredEffort: "high", effectiveEffort: "high", session: { ownerId: "coordinator", employeeId: pa, generation: runtime.generation, launchId: runtime.launchId, nativeSession: runtime.nativeSession, agentSessionId: `s-${runtime.launchId.replaceAll("-", "").slice(0, 28)}` } });
  await expect(client.poll({ ...report, agentSessionId: "another-omp-session", observedAt: 2001 })).rejects.toThrow("authenticated native session");
  await client.poll({ ...report, observedAt: 1999 });
  expect(f.store.effectiveRoleSettings(pa, runtime.generation)?.observedAt).toBe(1000);
  const unavailable = { status: "unavailable" as const, reason: "omp_session_api_unavailable" as const, nativeSession: runtime.nativeSession, agentSessionId: `s-${runtime.launchId.replaceAll("-", "").slice(0, 28)}`, observedAt: 2002 };
  await client.poll(unavailable);
  expect(f.store.runtimeCapability(pa, runtime.generation)).toMatchObject({ status: "unavailable", reason: "omp_session_api_unavailable" });
  expect(f.store.effectiveRoleSettings(pa, runtime.generation)).toMatchObject({ status: "unavailable", reason: "omp_session_api_unavailable" });
  const uncertain = f.store.runtimeBindings().findLast((entry) => entry.employeeId === pa);
  if (!uncertain) throw new Error("Missing OMP runtime after settings observation");
  f.store.updateRuntime({ ...uncertain, state: "uncertain", error: "native session disconnected" });
  const staff = z.object({ runtime: z.array(z.object({ employeeId: z.string(), capability: z.object({ status: z.string(), reason: z.string().optional() }), effectiveSettings: z.object({ status: z.string(), reason: z.string().optional() }) })) }).passthrough().parse(await f.coordinator.command(manager, { kind: "staff" }));
  expect(staff.runtime.find((entry) => entry.employeeId === pa)).toMatchObject({ capability: { status: "unavailable", reason: "session_not_observed" }, effectiveSettings: { status: "unavailable", reason: "session_not_observed" } });
  client.close();
});

test("a failed unadmitted boot immediately persists a redacted manager alert and can later admit", async () => {
  const f = fixture(8);
  await f.coordinator.start();
  const saved = f.store.runtimeBindings().find((r) => r.employeeId !== "manager");
  if (!saved) throw new Error("Missing PA launch");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.config.stateDirectory, "launches", `${saved.launchId}.json`), "utf8")));
  const server = serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath }); servers.push(server);
  const report = (credential: string): Promise<Response> => fetch("http://localhost/launch-failure", { unix: f.config.socketPath, method: "POST", body: JSON.stringify({ credential, error: `Cannot resolve pane ${manifest.credential}` }) });
  expect((await report("forged")).status).toBe(403);
  expect((await report(manifest.credential)).status).toBe(200);
  expect((await report(manifest.credential)).status).toBe(200);
  expect(f.store.runtimeBindings().find((r) => r.launchId === saved.launchId)).toMatchObject({ state: "uncertain", error: "Cannot resolve pane [redacted]" });
  const alerts = f.store.snapshot().messages.filter((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"boot-failed"'));
  expect(alerts).toHaveLength(1);
  expect(JSON.stringify(alerts)).not.toContain(manifest.credential);
  await f.admit(saved.employeeId);
  expect((await report(manifest.credential)).status).toBe(200);
  expect(f.store.runtimeBindings().find((r) => r.launchId === saved.launchId)?.state).toBe("ready");
});

test("Herdr interactive readiness cannot hide a reported boot failure during launch", async () => {
  const f = fixture(8);
  const barrier = Promise.withResolvers<void>();
  f.delayLaunch(barrier.promise);
  const starting = f.coordinator.start();
  try {
    const deadline = Date.now() + 1000;
    while (!f.store.runtimeBindings().some((r) => r.employeeId !== "manager" && r.paneId !== null) && Date.now() < deadline) await Bun.sleep(1);
    const saved = f.store.runtimeBindings().find((r) => r.employeeId !== "manager");
    if (!saved) throw new Error("Missing PA launch");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.config.stateDirectory, "launches", `${saved.launchId}.json`), "utf8")));
    f.coordinator.launchFailure({ credential: manifest.credential, error: "source unavailable" });
    barrier.resolve();
    await expect(starting).rejects.toThrow("Startup employee boot failed: source unavailable");
    expect(f.store.runtimeBindings().find((r) => r.launchId === saved.launchId)?.state).toBe("uncertain");
  } finally { barrier.resolve(); await starting.catch(() => undefined); }
});

test("lost Herdr supervision degrades fresh PA connections and persists a manager blocker", async () => {
  const f = fixture(8);
  const { manager, paConnection } = await f.ready();
  f.failObservation(new Error("observer connection unavailable"));
  await expect(f.coordinator.tick()).resolves.toBeUndefined();
  await f.coordinator.poll(paConnection);
  expect(JSON.stringify(await f.coordinator.command(manager, { kind: "staff" }))).toContain("pa-observer-unavailable");
  expect(f.store.snapshot().messages.some((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"herdr-unavailable"'))).toBe(true);
  await f.coordinator.command(manager, { kind: "intake", eventId: "event", input: "work", amendItemIds: [] });
  await expect(f.coordinator.command(manager, { kind: "delegate", eventId: "event", developers: 1 })).rejects.toThrow("PA");
  f.failObservation(null);
  await f.coordinator.tick();
  expect(JSON.stringify(await f.coordinator.command(manager, { kind: "staff" }))).toContain('"health":"ready"');
});

test("supervision does not treat the same native identity as observed under another harness", async () => {
  const f = fixture(8);
  const { pa } = await f.ready();
  const runtime = f.store.runtimeBindings().findLast((entry) => entry.employeeId === pa);
  if (runtime?.paneId === null || runtime === undefined) throw new Error("Missing PA runtime binding");
  const index = f.observations.findIndex((observation) => observation.paneId === runtime.paneId);
  const observation = f.observations[index];
  if (observation === undefined) throw new Error("Missing PA Herdr observation");
  f.observations[index] = { ...observation, harness: "claude" };
  await f.coordinator.tick();
  expect(f.store.runtimeBindings().findLast((entry) => entry.employeeId === pa)).toMatchObject({ error: "Herdr session not observed" });
});

test("one conflicting employee observation cannot prevent other observations or PA scheduling", async () => {
  const f = fixture(8);
  const { manager, pa } = await f.ready();
  const team = await f.delegate(manager, "observation-fault");
  await f.admit(team.architect);
  const saved = f.store.runtimeBindings().find((r) => r.employeeId === team.architect);
  if (!saved?.nativeSession) throw new Error("Missing architect runtime");
  f.store.observeRuntime({ employeeId: saved.employeeId, generation: saved.generation, nativeSession: saved.nativeSession, state: "working", sequence: 1, observedAt: 1000 });
  await expect(f.coordinator.tick()).resolves.toBeUndefined();
  expect(f.store.snapshot().messages.some((m) => m.recipient === pa && m.id.startsWith("pa-check-"))).toBe(true);
  expect(f.store.runtimeBindings().find((r) => r.employeeId === pa)?.stateSequence).toBe(1);
  expect(f.coordinator.health().status).toBe("degraded");
});

test("a malformed queue cannot starve PA scheduling, and health recovers after a valid rows document is restored", async () => {
  const f = fixture(8);
  const { pa } = await f.ready();
  const queue = join(f.config.stateDirectory, "queue.json");
  writeFileSync(queue, '{"rows":');
  await expect(f.coordinator.tick()).resolves.toBeUndefined();
  expect(f.store.snapshot().messages.some((m) => m.recipient === pa && m.id.startsWith("pa-check-"))).toBe(true);
  expect(f.coordinator.health().status).toBe("degraded");
  const server = serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath }); servers.push(server);
  expect((await fetch("http://localhost/health", { unix: f.config.socketPath })).status).toBe(503);
  writeFileSync(queue, JSON.stringify({ format: "aspen", rows: [], retained: "metadata" }));
  await f.coordinator.tick();
  expect(f.coordinator.health().status).toBe("running");
  expect((await fetch("http://localhost/health", { unix: f.config.socketPath })).status).toBe(200);
});

test("failed observation collection still schedules a PA check and marks health degraded", async () => {
  const f = fixture(8);
  const { pa } = await f.ready();
  f.failObservation(new Error("controlled observation outage"));
  await expect(f.coordinator.tick()).resolves.toBeUndefined();
  expect(f.store.snapshot().messages.some((m) => m.recipient === pa && m.id.startsWith("pa-check-"))).toBe(true);
  expect(f.coordinator.health().status).toBe("degraded");
  f.failObservation(null);
  await f.coordinator.tick();
  expect(f.coordinator.health().status).toBe("running");
});

test("lost observations mean unknown manager presence and do not flood the PA with false offline duties", async () => {
  const f = fixture(8);
  const { manager, pa } = await f.ready();
  f.failObservation(new Error("controlled missing snapshot"));
  await f.coordinator.tick();
  await f.coordinator.poll(manager);
  f.advance(1050);
  await f.coordinator.tick();
  const messages = f.store.snapshot().messages;
  expect(messages.filter((m) => m.recipient === pa)).toHaveLength(1);
  expect(messages.find((m) => m.recipient === pa)?.payload).toMatchObject({ kind: "pa-check", managerPresence: "unknown" });
  expect(messages.some((m) => JSON.stringify(m.payload).includes('"kind":"manager-offline"'))).toBe(false);
});

test("PA control polling does not depend on loading unrelated global history", async () => {
  const f = fixture(8);
  const { paConnection } = await f.ready();
  const snapshot = f.store.snapshot;
  f.store.snapshot = () => { throw new Error("unrelated global history unavailable"); };
  try { await expect(f.coordinator.poll(paConnection)).resolves.toMatchObject({ toolBlockReason: null, waitReason: null }); }
  finally { f.store.snapshot = snapshot; }
});

test("health reports stale supervision even when the native manager still exists", async () => {
  const f = fixture(8);
  await f.ready();
  await f.coordinator.tick();
  expect(f.coordinator.health()).toMatchObject({ status: "running", supervision: { lastCompletedAt: 1000, lastSuccessAt: 1000, errors: [] } });
  f.advance(2500);
  expect(f.coordinator.health().status).toBe("degraded");
  await f.coordinator.tick();
  expect(f.coordinator.health()).toMatchObject({ status: "degraded", readyForAdmission: true, manager: { connected: false }, supervision: { lastCompletedAt: 2500 } });
  await f.coordinator.poll((await f.ready()).manager);
  expect(f.coordinator.health()).toMatchObject({ status: "running", manager: { connected: true } });
});

test("unclassified human input receives its own stale alert despite other manager activity", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  await f.coordinator.command(manager, { kind: "receive", id: "waiting-input", source: "interactive", raw: { text: "work", images: [] } });
  f.advance(1300);
  await f.coordinator.command(manager, { kind: "receive", id: "new-input", source: "interactive", raw: { text: "other", images: [] } });
  await f.coordinator.tick();
  expect(f.store.snapshot().messages.some((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"stale-input"') && m.correlation === "waiting-input")).toBe(true);
});

test("an existing crew can report while a new crew waits for native readiness", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const first = await f.delegate(manager, "first");
  const architect = await f.admit(first.architect);
  await f.admit(first.qa);
  await f.admit(first.devs[0]!);
  await f.coordinator.command(manager, { kind: "intake", eventId: "second", input: "work", amendItemIds: [] });
  const barrier = Promise.withResolvers<void>();
  f.delayLaunch(barrier.promise);
  const launching = f.coordinator.command(manager, { kind: "delegate", eventId: "second", developers: 1 });
  try {
    const reported = await Promise.race([
      f.coordinator.command(architect, { kind: "send", cue: { id: "progress-during-launch", recipient: "manager", kind: "report", correlation: "first", payload: "progress" } }).then(() => true),
      Bun.sleep(50).then(() => false),
    ]);
    expect(reported).toBe(true);
  } finally { barrier.resolve(); await launching; await f.coordinator.launching(); }
});

test("uncertain pane creation is fenced before a manager retries activation", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const receipt = z.object({ employees: z.array(z.object({ id: z.string() })) }).parse(await f.coordinator.command(manager, { kind: "hire", requestId: "hire-ops", role: "devops", additional: 1 }));
  const id = receipt.employees[0]!.id;
  f.failLayout(new Error("ambiguous create response"));
  await f.coordinator.command(manager, { kind: "activate", employeeIds: [id] });
  await f.coordinator.launching();
  expect(f.store.snapshot().messages.some((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"layout-uncertain"') && JSON.stringify(m.payload).includes("ambiguous"))).toBe(true);
  const calls = f.layoutCalls();
  await expect(f.coordinator.command(manager, { kind: "activate", employeeIds: [id] })).rejects.toThrow("reconciliation");
  expect(f.layoutCalls()).toBe(calls);
  expect(f.store.runtimeBindings().findLast((r) => r.employeeId === id)?.state).toBe("uncertain");
});

test("boot requires a source-bound PA and reserves one permanent PA on retries", async () => {
  const f = fixture(8);
  await f.coordinator.start();
  await f.coordinator.start();
  expect(f.store.snapshot().employees.filter((e) => e.role === "pa")).toHaveLength(1);
  const manager = await f.admit("manager");
  await f.coordinator.command(manager, { kind: "intake", eventId: "event", input: "work", amendItemIds: [] });
  await expect(f.coordinator.command(manager, { kind: "delegate", eventId: "event", developers: 1 })).rejects.toThrow("PA");
  expect(f.store.snapshot().teams).toHaveLength(0);
});

test("generated employee bootstrap imports without native OMP package aliases", async () => {
  const f = fixture(8);
  await f.ready();
  const pa = f.store.runtimeBindings().find((entry) => entry.employeeId !== "manager");
  if (!pa) throw new Error("Missing PA launch");
  const path = join(f.config.stateDirectory, "launches", `${pa.launchId}.ts`);
  const child = Bun.spawn([process.execPath, "-e", "await import(process.argv[1]);", path], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  expect({ exitCode: await child.exited, error }).toEqual({ exitCode: 0, error: "" });
});

test("a crew is atomic membership and cannot claim before every member binds", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "event");
  expect(f.store.snapshot().teams[0]?.state).toBe("reserved");
  const architect = await f.admit(team.architect);
  expect(await f.coordinator.command(architect, { kind: "claim" })).toBeNull();
  await expect(f.coordinator.command(architect, { kind: "begin_turn" })).rejects.toThrow("crew");
  expect((await f.coordinator.poll(architect)).toolBlockReason).toContain("crew");
  await f.admit(team.qa);
  const dev = await f.admit(team.devs[0]!);
  expect(f.store.snapshot().teams[0]?.state).toBe("ready");
  expect(await f.coordinator.command(architect, { kind: "claim" })).toHaveProperty("message");
  await expect(f.coordinator.command(dev, { kind: "send", cue: { id: "wrong-route", recipient: "manager", kind: "report", correlation: "event", payload: "skip architect" } })).rejects.toThrow("architect");
  await expect(f.coordinator.command(dev, { kind: "delegate", eventId: "event", developers: 1 })).rejects.toThrow("manager");
  await f.coordinator.command(manager, { kind: "delegate", eventId: "event", developers: 1 });
  expect(f.store.snapshot().teams).toHaveLength(1);
});

test("idle/done alerts reach manager and never settle a worker claim", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "event");
  const architect = await f.admit(team.architect);
  await f.admit(team.qa);
  await f.admit(team.devs[0]!);
  await f.coordinator.command(architect, { kind: "claim" });
  const runtime = f.store.runtimeBindings().find((r) => r.employeeId === team.architect)!;
  const index = f.observations.findIndex((o) => o.paneId === runtime.paneId);
  f.observations[index] = { ...f.observations[index]!, state: "done", stateSequence: 2 };
  await f.coordinator.tick();
  expect(f.store.snapshot().messages.some((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"state":"done"'))).toBe(true);
  expect(f.store.snapshot().claims.find((c) => c.employeeId === team.architect)?.status).toBe("active");
  expect(f.store.snapshot().results).toHaveLength(0);
});

test("global lifecycle counter jumps are valid while sequence regression degrades supervision", async () => {
  const f = fixture(8);
  const { manager, pa } = await f.ready();
  await f.coordinator.tick();
  const runtime = f.store.runtimeBindings().find((r) => r.employeeId === pa)!;
  const index = f.observations.findIndex((o) => o.paneId === runtime.paneId);
  f.observations[index] = { ...f.observations[index]!, state: "done", stateSequence: 4 };
  await f.coordinator.tick();
  expect(f.store.snapshot().messages.some((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"observation-gap"'))).toBe(false);
  f.observations[index] = { ...f.observations[index]!, stateSequence: 2 };
  await f.coordinator.tick();
  expect(f.store.snapshot().messages.some((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"observation-gap"'))).toBe(true);
  expect(JSON.stringify(await f.coordinator.command(manager, { kind: "staff" }))).toContain("pa-offline");
});

test("an unadmitted launch that misses its deadline becomes a manager blocker", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "event");
  f.advance(2200);
  await f.coordinator.tick();
  expect(f.store.snapshot().messages.some((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"launch-stalled"') && JSON.stringify(m.payload).includes(team.architect))).toBe(true);
});

test("heartbeats cannot disguise stale work and an overdue PA blocks new crews", async () => {
  const f = fixture(8);
  const { manager, paConnection } = await f.ready();
  await f.coordinator.tick();
  f.advance(1300);
  await f.coordinator.poll(manager);
  await f.coordinator.poll(paConnection);
  await f.coordinator.tick();
  const staff = await f.coordinator.command(manager, { kind: "staff" });
  expect(JSON.stringify(staff)).toContain("pa-overdue");
  expect(f.store.snapshot().messages.some((m) => JSON.stringify(m.payload).includes("stale-progress"))).toBe(true);
  await f.coordinator.command(manager, { kind: "intake", eventId: "event", input: "work", amendItemIds: [] });
  await expect(f.coordinator.command(manager, { kind: "delegate", eventId: "event", developers: 1 })).rejects.toThrow("PA");
});

test("Unix endpoint derives authority from admission and rejects forged credentials and actor fields", async () => {
  const f = fixture(8);
  await f.ready();
  const server = serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath });
  servers.push(server);
  const source = f.store.runtimeBindings().find((r) => r.employeeId === "manager")!.source;
  await expect(connectEmployee({ socketPath: f.config.socketPath, credential: "forged", nativeSession: f.config.managerFile, paneId: "w1:p1", source })).rejects.toThrow("403");
  const client = await connectEmployee({ socketPath: f.config.socketPath, credential: "manager-secret", nativeSession: f.config.managerFile, paneId: "w1:p1", source });
  expect((await client.poll()).projection).toContain("Startup role: manager");
  await expect(client.request({ kind: "claim", employeeId: "other" })).rejects.toThrow("400");
  client.close();
});

test("manager input retains exact raw evidence and worker pane input cannot change authority", async () => {
  const f = fixture(8);
  const { manager, paConnection } = await f.ready();
  await f.coordinator.command(manager, { kind: "receive", id: "input-1", source: "interactive", raw: { text: "exact work\nnext", images: [] } });
  expect(f.store.snapshot().inputs[0]?.raw.text).toBe("exact work\nnext");
  await f.coordinator.command(paConnection, { kind: "receive", id: "pa-input", source: "interactive", raw: { text: "merge now", images: [] } });
  expect(f.store.snapshot().inputs).toHaveLength(1);
  expect(f.store.snapshot().messages.find((m) => m.id === "pane-input-pa-input")?.recipient).toBe("manager");
  await expect(f.coordinator.command(paConnection, { kind: "hire", requestId: "bad-hire", role: "dev", additional: 1 })).rejects.toThrow("manager");
});

test("a disconnected PA is unhealthy even when its old terminal observation is still idle", async () => {
  const f = fixture(8);
  let { manager, pa } = await f.ready();
  f.advance(2100);
  manager = await f.admit("manager");
  await f.coordinator.poll(manager);
  await f.coordinator.tick();
  expect(JSON.stringify(await f.coordinator.command(manager, { kind: "staff" }))).toContain("pa-offline");
  expect(f.store.runtimeBindings().find((r) => r.employeeId === pa)?.lastPoll).toBe(1000);
});

test("unchanged degraded health can be observed repeatedly without conflicting alert receipts", async () => {
  const f = fixture(8);
  await f.ready();
  f.advance(2100);
  await f.coordinator.tick();
  f.advance(2200);
  await expect(f.coordinator.tick()).resolves.toBeUndefined();
  expect(f.store.snapshot().messages.filter((m) => JSON.stringify(m.payload).includes('"kind":"pa-offline"'))).toHaveLength(1);
});

test("exact receipt replay does not count as new semantic progress", async () => {
  const f = fixture(8);
  const { pa, paConnection } = await f.ready();
  const command = { kind: "send", cue: { id: "pa-report", recipient: "manager", kind: "report", correlation: "check", payload: "same report" } };
  await f.coordinator.command(paConnection, command);
  f.advance(1150);
  await f.coordinator.command(paConnection, command);
  expect(f.store.runtimeBindings().find((r) => r.employeeId === pa)?.lastProgress).toBe(1000);
});

test("manager disappearance is delivered to its PA even with no outstanding manager work", async () => {
  const f = fixture(8);
  const { pa } = await f.ready();
  f.observations.splice(f.observations.findIndex((o) => o.paneId === "w1:p1"), 1);
  await f.coordinator.tick();
  expect(f.store.snapshot().messages.some((m) => m.recipient === pa && JSON.stringify(m.payload).includes("manager-offline"))).toBe(true);
});

test("a queued item remains monitored after the architect acknowledges its intake", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "event");
  const architect = await f.admit(team.architect);
  await f.admit(team.qa);
  await f.admit(team.devs[0]!);
  const claimed = z.object({ claim: z.object({ id: z.string() }) }).parse(await f.coordinator.command(architect, { kind: "claim" }));
  await f.coordinator.command(architect, { kind: "capture", capture: { captureId: "capture", eventId: "event", rows: [{ id: "ITEM-1", expectedRevision: null, fields: { status: "QUEUED", request: "fix", acceptance: "works", blocked_on: null } }], receipt: "all captured" } });
  await f.coordinator.command(architect, { kind: "settle", claimId: claimed.claim.id, result: { id: "intake-done", kind: "completed", output: "captured", checkpoint: null, outgoing: [] } });
  f.advance(1300);
  await f.coordinator.tick();
  expect(f.store.snapshot().messages.some((m) => JSON.stringify(m.payload).includes('"kind":"stale-item"') && JSON.stringify(m.payload).includes("ITEM-1"))).toBe(true);
});

test("unrelated reports and another item revision cannot hide a stalled queue item", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "event");
  const architect = await f.admit(team.architect);
  await f.admit(team.qa);
  await f.admit(team.devs[0]!);
  const fields = { status: "QUEUED", request: "fix", acceptance: "works", blocked_on: null };
  await f.coordinator.command(architect, { kind: "capture", capture: { captureId: "capture-two", eventId: "event", rows: [{ id: "STALLED", expectedRevision: null, fields }, { id: "MOVING", expectedRevision: null, fields }], receipt: "both captured" } });
  f.advance(1150);
  await f.coordinator.command(architect, { kind: "capture", capture: { captureId: "amend-moving", eventId: "event", rows: [{ id: "MOVING", expectedRevision: 1, fields: { ...fields, request: "fix with clarified behavior" } }], receipt: "moving updated" } });
  f.advance(1190);
  await f.coordinator.command(architect, { kind: "send", cue: { id: "unrelated-report", recipient: "manager", kind: "report", correlation: "event", payload: "Other coordination continues" } });
  f.advance(1300);
  await f.coordinator.tick();
  const alerts = f.store.snapshot().messages.filter((message) => z.object({ kind: z.string() }).passthrough().safeParse(message.payload).data?.kind === "stale-item");
  expect(alerts.map((message) => z.object({ itemId: z.string() }).parse(message.payload).itemId)).toEqual(["STALLED"]);
});


test("root turn admission reserves manager and PA capacity and releases no work receipts", async () => {
  const f = fixture(3);
  const { manager, paConnection } = await f.ready();
  const team = await f.delegate(manager, "event");
  const architect = await f.admit(team.architect);
  const qa = await f.admit(team.qa);
  await f.admit(team.devs[0]!);
  await f.coordinator.command(architect, { kind: "begin_turn" });
  await f.coordinator.command(manager, { kind: "begin_turn" });
  await f.coordinator.command(paConnection, { kind: "begin_turn" });
  await expect(f.coordinator.command(qa, { kind: "begin_turn" })).rejects.toThrow("capacity");
  expect((await f.coordinator.poll(qa)).pendingMessageIds).toEqual([]);
  await f.coordinator.command(architect, { kind: "end_turn" });
  await f.coordinator.command(qa, { kind: "begin_turn" });
  expect(f.store.snapshot().results).toHaveLength(0);
});

test("a finished crew reuses its existing employee panes with fresh fenced assignment generations", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const first = await f.delegate(manager, "first");
  const architect = await f.admit(first.architect);
  const qa = await f.admit(first.qa);
  const dev = await f.admit(first.devs[0]!);
  for (const [connection, id] of [[architect, first.architect], [qa, first.qa], [dev, first.devs[0]!]]) {
    const claimed = z.object({ claim: z.object({ id: z.string() }) }).parse(await f.coordinator.command(connection!, { kind: "claim" }));
    if (id === first.architect) await f.coordinator.command(architect, { kind: "capture", capture: { captureId: "empty-capture", eventId: "first", rows: [], receipt: "no tasks" } });
    await f.coordinator.command(connection!, { kind: "settle", claimId: claimed.claim.id, result: { id: `done-${id}`, kind: "completed", output: "done", checkpoint: null, outgoing: [] } });
  }
  await f.coordinator.command(manager, { kind: "finish", teamId: first.id, evidence: "all work resolved" });
  const second = await f.delegate(manager, "second");
  expect(second.id).not.toBe(first.id);
  expect(second.architect).toBe(first.architect);
  expect(second.qa).toBe(first.qa);
  expect(second.devs).toEqual(first.devs);
  expect(f.store.snapshot().employees).toHaveLength(5);
  expect(f.observations).toHaveLength(5);
  await expect(f.coordinator.command(dev, { kind: "claim" })).rejects.toThrow("generation");
  await f.admit(second.architect);
  await f.admit(second.qa);
  await f.admit(second.devs[0]!);
  expect(f.store.snapshot().teams.find((t) => t.id === second.id)?.state).toBe("ready");
});

test("manager replacement cannot duplicate a live source-bound employee", async () => {
  const f = fixture(8);
  const { manager, pa } = await f.ready();
  await expect(f.coordinator.command(manager, { kind: "replace", employeeId: pa, evidence: "replace it" })).rejects.toThrow("live");
  expect(f.store.runtimeBindings().filter((r) => r.employeeId === pa)).toHaveLength(1);
});

test("explicit intake retains complete paged text and native attachments for its own crew", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const text = "x".repeat(5000);
  const image = { type: "image", data: "YQ==", mimeType: "image/png" };
  await f.coordinator.command(manager, { kind: "intake", eventId: "long", input: { text, images: [image] }, amendItemIds: [] });
  await f.coordinator.command(manager, { kind: "delegate", eventId: "long", developers: 1 });
  await f.coordinator.launching();
  const team = f.store.snapshot().teams[0]!;
  const architect = await f.admit(team.architect);
  await f.admit(team.qa);
  await f.admit(team.devs[0]!);
  const first = z.object({ text: z.string(), nextOffset: z.number(), attachmentCount: z.number() }).parse(await f.coordinator.command(architect, { kind: "input", inputId: "long", offset: 0 }));
  expect(first.text.length).toBe(4096);
  expect(first.nextOffset).toBe(4096);
  expect(first.attachmentCount).toBe(1);
  expect(await f.coordinator.command(architect, { kind: "input", inputId: "long", offset: 4096 })).toMatchObject({ text: "x".repeat(904), nextOffset: null });
  expect(await f.coordinator.command(architect, { kind: "image", inputId: "long", index: 0 })).toEqual(image);
  await expect(f.coordinator.command(architect, { kind: "input", inputId: "long", offset: 5001 })).rejects.toThrow("offset");
});

test("manager recovery fences a stranded unadmitted crew generation and admits a fresh root", async () => {
  const f = fixture(8);
  let { manager } = await f.ready();
  const team = await f.delegate(manager, "stranded-event");
  const id = team.devs[0];
  if (!id) throw new Error("Missing dev");
  const old = f.store.runtimeBindings().findLast((r) => r.employeeId === id);
  if (!old) throw new Error("Missing pending runtime");
  const oldManifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.config.stateDirectory, "launches", `${old.launchId}.json`), "utf8")));
  f.store.updateRuntime({ ...old, state: "uncertain", error: "Startup outcome uncertain" });
  const index = f.observations.findIndex((o) => o.paneId === old.paneId);
  const [oldObservation] = f.observations.splice(index, 1);
  if (!oldObservation?.nativeSession) throw new Error("Missing original root evidence");
  await expect(f.coordinator.command(manager, { kind: "replace", employeeId: id, evidence: "Stopped original launch and verified absence" })).rejects.toThrow("recent");
  f.advance(2500);
  manager = await f.admit("manager");
  expect(await f.coordinator.command(manager, { kind: "replace", employeeId: id, evidence: "Stopped original launch and verified absence" })).toEqual({ generation: 2 });
  const next = f.store.runtimeBindings().findLast((r) => r.employeeId === id);
  expect(next).toMatchObject({ generation: 2, state: "prepared", paneId: null, nativeSession: null });
  expect(next?.launchId).not.toBe(old.launchId);
  expect(f.store.runtimeBindings().find((r) => r.launchId === old.launchId)?.state).toBe("abandoned");
  expect(f.store.snapshot().teams.find((t) => t.id === team.id)?.generations[id]).toBe(2);
  expect(f.store.runtimeAbandonments()[0]).toMatchObject({ launchId: old.launchId, generation: 1, nextGeneration: 2 });
  await expect(f.coordinator.admit({ credential: oldManifest.credential, nativeSession: oldObservation.nativeSession, paneId: oldObservation.paneId, source: oldManifest.source })).rejects.toThrow("abandoned");
  expect(await f.coordinator.command(manager, { kind: "replace", employeeId: id, evidence: "Stopped original launch and verified absence" })).toEqual({ generation: 2 });
  expect(f.store.runtimeBindings().filter((r) => r.employeeId === id)).toHaveLength(2);
  await f.coordinator.command(manager, { kind: "activate", employeeIds: [id] });
  await f.coordinator.launching();
  const dev = await f.admit(id);
  expect(f.store.snapshot().employees.find((e) => e.id === id)?.generation).toBe(2);
  expect(await f.coordinator.command(dev, { kind: "claim" })).toBeNull();
});

test("prepared recovery checks live launch alias and rejects the abandoned credential before successor preparation", async () => {
  const f = fixture(8);
  let { manager } = await f.ready();
  const hire = z.object({ employees: z.array(z.object({ id: z.string() })) }).parse(await f.coordinator.command(manager, { kind: "hire", requestId: "prepared-recovery", role: "dev", additional: 1 }));
  const id = hire.employees[0]?.id;
  if (!id) throw new Error("Missing hired dev");
  const old = f.store.runtimeBindings().findLast((r) => r.employeeId === id);
  if (!old) throw new Error("Missing prepared launch");
  const oldManifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.config.stateDirectory, "launches", `${old.launchId}.json`), "utf8")));
  f.advance(2500);
  manager = await f.admit("manager");
  f.observations.push({ harness: "omp", name: `s-${old.launchId.replaceAll("-", "").slice(0, 28)}`, workspaceId: "w1", tabId: "w1:t99", paneId: "w1:p99", terminalId: "term99", nativeSession: "/stranded.jsonl", state: "working", stateSequence: 1, interactiveReady: false });
  await expect(f.coordinator.command(manager, { kind: "replace", employeeId: id, evidence: "Verified unknown shell stopped" })).rejects.toThrow("live");
  f.observations.pop();
  f.store.abandonUnadmittedRuntime({ manager: f.store.managerBinding, employeeId: id, launchId: old.launchId, evidence: "Verified unknown shell stopped", verifiedAbsentAt: 2500, connectionDeadlineMs: 1000 });
  await expect(f.coordinator.admit({ credential: oldManifest.credential, nativeSession: "/stranded.jsonl", paneId: "w1:p99", source: oldManifest.source })).rejects.toThrow("abandoned");
  expect(await f.coordinator.command(manager, { kind: "replace", employeeId: id, evidence: "Verified unknown shell stopped" })).toEqual({ generation: 2 });
  expect(f.store.runtimeBindings().findLast((r) => r.employeeId === id)).toMatchObject({ generation: 2, state: "prepared" });
});

test("manager reconciliation restores crew inbox delivery without replaying uncertain work", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "recover-crew");
  const architect = await f.admit(team.architect);
  await f.admit(team.qa);
  await f.admit(team.devs[0]!);
  const claimed = z.object({ claim: z.object({ id: z.string() }) }).parse(await f.coordinator.command(architect, { kind: "claim" }));
  await f.coordinator.command(architect, { kind: "settle", claimId: claimed.claim.id, result: { id: "uncertain-intake", kind: "uncertain", output: "Interrupted metadata operation", checkpoint: null, outgoing: [] } });
  await f.coordinator.command(manager, { kind: "send", cue: { id: "resume-cue", recipient: team.architect, kind: "answer", correlation: team.eventId, payload: "Preserved receipts verified; continue next work" } });
  expect((await f.coordinator.poll(architect)).pendingMessageIds).toEqual([]);
  await f.coordinator.command(manager, { kind: "reconcile", claimId: claimed.claim.id, evidence: "Verified saved receipts; no mutation replay" });
  expect(f.store.snapshot().teams[0]?.state).toBe("waiting");
  expect((await f.coordinator.poll(architect)).pendingMessageIds).toEqual(["resume-cue"]);
  expect(f.store.snapshot().results).toHaveLength(1);
  await f.coordinator.command(manager, { kind: "reconcile", claimId: claimed.claim.id, evidence: "Verified saved receipts; no mutation replay" });
  await expect(f.coordinator.command(manager, { kind: "reconcile", claimId: claimed.claim.id, evidence: "Conflicting evidence" })).rejects.toThrow("conflicts");
});


test("manager and PA polling do not load full history or unrelated runtime bindings", async () => {
  const f = fixture(8);
  const { manager, paConnection } = await f.ready();
  const snapshot = f.store.snapshot;
  const runtimes = f.store.runtimeBindings;
  f.store.snapshot = () => { throw new Error("Global history must not be on the polling path"); };
  f.store.runtimeBindings = () => { throw new Error("Global runtime scan must not be on the manager/PA polling path"); };
  try {
    expect((await f.coordinator.poll(manager)).projection).toContain("STARTUP_BINDING");
    expect((await f.coordinator.poll(paConnection)).projection).toContain("STARTUP_BINDING");
  } finally { f.store.snapshot = snapshot; f.store.runtimeBindings = runtimes; }
});

test("supervision does not load completed result or claim history", async () => {
  const f = fixture(8);
  await f.ready();
  const snapshot = f.store.snapshot;
  f.store.snapshot = () => { throw new Error("Completed history must not be on the supervision path"); };
  try { await f.coordinator.tick(); expect(f.coordinator.health().supervision.errors).toEqual([]); }
  finally { f.store.snapshot = snapshot; }
});

test("root capacity polling reconciliation never loads semantic work history", async () => {
  const f = fixture(8);
  const { manager, paConnection } = await f.ready();
  const snapshot = f.store.snapshot;
  f.store.snapshot = () => { throw new Error("Capacity reconciliation must not load semantic work history"); };
  try {
    for (const connection of [manager, paConnection]) {
      expect(await f.coordinator.command(connection, { kind: "begin_turn" })).toEqual({ admitted: true });
      expect(await f.coordinator.command(connection, { kind: "end_turn" })).toEqual({ released: true });
    }
  } finally { f.store.snapshot = snapshot; }
});

test("settlement binds the current own claim and replays its result after the next claim", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  f.store.sendCue({ sender: f.store.managerBinding, cue: { id: "first-report", recipient: "manager", kind: "report", correlation: "test", payload: null } });
  const first = await f.coordinator.command(manager, { kind: "claim" });
  const result = { id: "first-result", kind: "completed", output: "observed", checkpoint: null, outgoing: [] };
  const settled = await f.coordinator.command(manager, { kind: "settle", result });
  expect(settled).toMatchObject({ claimId: z.object({ claim: z.object({ id: z.string() }) }).parse(first).claim.id, result });
  f.store.sendCue({ sender: f.store.managerBinding, cue: { id: "second-report", recipient: "manager", kind: "report", correlation: "test", payload: null } });
  const second = z.object({ claim: z.object({ id: z.string() }) }).parse(await f.coordinator.command(manager, { kind: "claim" }));
  expect(await f.coordinator.command(manager, { kind: "settle", result })).toEqual(settled);
  expect(f.store.snapshot().claims.find((c) => c.id === second.claim.id)?.status).toBe("active");
  await expect(f.coordinator.command(manager, { kind: "settle", result: { ...result, output: "changed" } })).rejects.toMatchObject({ recovery: { code: "result_replay_conflict", retryable: false } });
});

test("a mistyped legacy claim has an actionable nonretryable error and one manager alert", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  f.store.sendCue({ sender: f.store.managerBinding, cue: { id: "report", recipient: "manager", kind: "report", correlation: "test", payload: null } });
  const claimed = z.object({ claim: z.object({ id: z.string() }) }).parse(await f.coordinator.command(manager, { kind: "claim" }));
  const command = { kind: "settle", claimId: "mistyped", result: { id: "result", kind: "completed", output: "done", checkpoint: null, outgoing: [] } };
  for (let attempt = 0; attempt < 3; attempt += 1)
    await expect(f.coordinator.command(manager, command)).rejects.toMatchObject({ recovery: { code: "claim_not_found", retryable: false, employeeId: "manager", generation: 1, action: expect.stringContaining("result") } });
  expect(f.store.snapshot().messages.filter((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"settlement-blocked"'))).toHaveLength(1);
  expect(f.store.snapshot().claims.find((c) => c.id === claimed.claim.id)?.status).toBe("active");
  await expect(f.coordinator.command(manager, { kind: "settle", result: command.result })).resolves.toMatchObject({ claimId: claimed.claim.id });
});

test("settlement recovery metadata crosses the real authenticated Unix transport", async () => {
  const f = fixture(8);
  await f.ready();
  servers.push(serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath }));
  const runtime = f.store.employeeRuntime("manager", 1);
  if (!runtime) throw new Error("Missing manager runtime");
  const client = await connectEmployee({ socketPath: f.config.socketPath, credential: f.config.managerCredential, nativeSession: f.config.managerFile, paneId: f.config.managerPaneId, source: runtime.source });
  try {
    const command = { kind: "settle", claimId: "mistyped", result: { id: "result", kind: "completed", output: "done", checkpoint: null, outgoing: [] } };
    await expect(client.request(command)).rejects.toMatchObject({ recovery: { code: "claim_not_found", retryable: false, action: expect.stringContaining("startup_settle {result}") }, repeated: false });
    await expect(client.request(command)).rejects.toMatchObject({ repeated: true });
    expect(f.store.snapshot().messages.filter((m) => JSON.stringify(m.payload).includes('"kind":"settlement-blocked"'))).toHaveLength(1);
  } finally { client.close(); }
});

test("new ready work releases a no-claim retry latch without releasing an active rejected claim", async () => {
  const f = fixture(8);
  await f.ready();
  servers.push(serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath }));
  const runtime = f.store.employeeRuntime("manager", 1);
  if (!runtime) throw new Error("Missing manager runtime");
  const client = await connectEmployee({ socketPath: f.config.socketPath, credential: f.config.managerCredential, nativeSession: f.config.managerFile, paneId: f.config.managerPaneId, source: runtime.source });
  try {
    await client.poll();
    const command = { kind: "settle", result: { id: "no-claim", kind: "completed", output: "done", checkpoint: null, outgoing: [] } };
    await expect(client.request(command)).rejects.toMatchObject({ recovery: { code: "no_active_claim" } });
    await expect(client.request(command)).rejects.toMatchObject({ repeated: true });
    f.store.sendCue({ sender: f.store.managerBinding, cue: { id: "new-work", recipient: "manager", kind: "report", correlation: "test", payload: null } });
    await client.poll();
    expect(client.settlementBlock()).toBeNull();
    await client.request({ kind: "claim" });
    await client.poll();
    const wrong = { ...command, claimId: "mistyped" };
    await expect(client.request(wrong)).rejects.toMatchObject({ recovery: { code: "claim_not_found" } });
    await expect(client.request(wrong)).rejects.toMatchObject({ repeated: true });
    f.store.sendCue({ sender: f.store.managerBinding, cue: { id: "unrelated-mail", recipient: "manager", kind: "report", correlation: "test", payload: null } });
    await client.poll();
    expect(client.settlementBlock()).not.toBeNull();
  } finally { client.close(); }
});

test("a completed item dev receives its exact pending review continuation until review or explicit block", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "review-continuation");
  const architect = await f.admit(team.architect);
  await f.admit(team.qa);
  const dev = await f.admit(team.devs[0]!);
  await f.coordinator.command(architect, { kind: "capture", capture: {
    captureId: "capture-continuation", eventId: "review-continuation", rows: [{ id: "REWORK", expectedRevision: null,
      fields: { status: "QUEUED", procedure: "code-review", request: "review original head", acceptance: "proof", blocked_on: [] } }], receipt: "captured",
  } });
  let index = 0;
  for (const connection of [architect, dev]) {
    while (await f.coordinator.command(connection, { kind: "claim" }) !== null) {
      await f.coordinator.command(connection, { kind: "settle", result: { id: `drain-${index++}`, kind: "completed", output: {}, checkpoint: null, outgoing: [] } });
    }
  }
  await f.coordinator.command(architect, { kind: "item", request: { action: "assign", requestId: "assign-rework", itemId: "REWORK", expectedRevision: 1, employeeId: team.devs[0]!, evidence: "Implement rework" } });
  await f.coordinator.command(dev, { kind: "claim" });
  await f.coordinator.command(dev, { kind: "settle", result: { id: "rework-code-result", kind: "completed", output: { commit: "new-head" }, checkpoint: null, outgoing: [] } });
  const pending = await f.coordinator.poll(dev);
  expect(pending.waitReason).toContain("startup_item review");
  expect(pending.projection).toContain('"resultId":"rework-code-result"');
  expect(pending.projection).toContain('"revision":2');
  await f.coordinator.command(manager, { kind: "item", request: { action: "decide", requestId: "block-rework", itemId: "REWORK", expectedRevision: 2, status: "BLOCKED", evidence: "Explicit scope decision" } });
  expect((await f.coordinator.poll(dev)).waitReason).toBeNull();
});


test("manager projection names the exact next prioritized claim and clears it while claimed", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  let index = 0;
  while (f.store.claimNext({ employee: f.store.managerBinding }) !== null) f.store.settleClaim({ employee: f.store.managerBinding, result: { id: `drain-next-${index++}`, kind: "completed", output: {}, checkpoint: null, outgoing: [] } });
  const team = await f.delegate(manager, "next-proof");
  const architect = await f.admit(team.architect);
  f.store.runtimeAlert({ id: "old-pane-notice", correlation: "next-proof", payload: { kind: "direct-pane-input", employeeId: team.architect } });
  await f.coordinator.command(architect, { kind: "send", cue: { id: "next-technical-proof", recipient: "manager", kind: "report", correlation: "next-proof", payload: "Current technical proof" } });
  const poll = await f.coordinator.poll(manager);
  const line = poll.projection.split("\n").find((entry) => entry.startsWith("STARTUP_INBOX="));
  if (line === undefined) throw new Error("Missing inbox projection");
  expect(JSON.parse(line.slice("STARTUP_INBOX=".length))).toMatchObject({ selection: "priority", nextClaim: { tool: "startup_claim", arguments: {}, messageId: "next-technical-proof", kind: "report", sender: team.architect } });
  expect(poll.projection).toContain("no older administrative message must be consumed first");
  expect(await f.coordinator.command(manager, { kind: "claim" })).toHaveProperty("message.id", "next-technical-proof");
  expect((await f.coordinator.poll(manager)).projection).toContain('"nextClaim":null');
});

test("historical lifecycle admin stays visible without waking or continuing the manager", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  let index = 0;
  while (f.store.claimNext({ employee: f.store.managerBinding }) !== null) f.store.settleClaim({ employee: f.store.managerBinding, result: { id: `drain-admin-${index++}`, kind: "completed", output: {}, checkpoint: null, outgoing: [] } });
  f.store.runtimeAlert({ id: "retained-admin-only", correlation: "old-runtime", payload: { kind: "runtime-observation", employeeId: "manager", state: "idle", sequence: 1, observedAt: 1 } });
  const poll = await f.coordinator.poll(manager);
  expect(poll.pendingMessageIds).toEqual([]);
  expect(poll.waitReason).toBeNull();
  expect(poll.projection).toContain('"deferredMessageCount":1');
  expect(f.store.snapshot().messages.find((m) => m.id === "retained-admin-only")?.status).toBe("pending");
});


test("recovered presence is deferred while current failures and unknown alerts still wake the manager", async () => {
  const f = fixture(8);
  const { manager, pa } = await f.ready();
  let index = 0;
  while (f.store.claimNext({ employee: f.store.managerBinding }) !== null) f.store.settleClaim({ employee: f.store.managerBinding, result: { id: `drain-presence-${index++}`, kind: "completed", output: {}, checkpoint: null, outgoing: [] } });
  f.store.runtimeAlert({ id: "old-manager-offline", correlation: "manager-supervision", payload: { kind: "manager-offline", observedAt: 900 } });
  f.store.runtimeAlert({ id: "old-pa-offline", correlation: "pa", payload: { kind: "employee-offline", employeeId: pa, observedAt: 900 } });
  f.store.runtimeAlert({ id: "old-pa-boot", correlation: "pa", payload: { kind: "boot-failed", employeeId: pa } });
  f.store.runtimeAlert({ id: "unknown-alert", correlation: "unknown", payload: "legacy actionable report" });
  f.advance(1500);
  f.store.runtimeAlert({ id: "current-pa-offline", correlation: "pa", payload: { kind: "employee-offline", employeeId: pa, observedAt: 1400 } });
  const poll = await f.coordinator.poll(manager);
  expect(poll.pendingMessageIds).toEqual(["current-pa-offline", "unknown-alert"]);
  expect(poll.waitReason).toContain("pending durable inbox");
  expect(poll.projection).toContain('"deferredMessageCount":3');
});


test("120 routine PA reports preserve supervision history without manager inference eligibility", async () => {
  const f = fixture(8);
  const { manager, pa } = await f.ready();
  const employee = f.store.getEmployee(pa);
  if (employee.nativeHandle === null) throw new Error("PA admission missing");
  const binding = { employeeId: pa, generation: employee.generation, nativeHandle: employee.nativeHandle };
  for (let check = 0; check < 120; check += 1) {
    f.store.sendCue({ sender: binding, cue: { id: `routine-pa-check-${check}`, recipient: "manager", kind: "report", correlation: "manager-supervision", payload: { check, managerPresence: "online" } } });
    const poll = await f.coordinator.poll(manager);
    expect(poll.pendingMessageIds).toEqual([]);
    expect(poll.waitReason).toBeNull();
  }
  expect(f.store.employeeView("manager").latestPaReport?.payload).toEqual({ check: 119, managerPresence: "online" });
  expect(f.store.snapshot().messages.filter((message) => message.id.startsWith("routine-pa-check-") && message.status === "pending")).toHaveLength(120);
});


test("a recovered manager disconnect creates a fresh alert episode without a Herdr state change", async () => {
  const f = fixture(8);
  let { manager, pa, paConnection } = await f.ready();
  f.advance(2200);
  paConnection = await f.admit(pa);
  await f.coordinator.poll(paConnection);
  await f.coordinator.tick();
  f.advance(2300);
  manager = await f.admit("manager");
  await f.coordinator.poll(manager);
  expect(f.store.employeeView("manager").messages.some((message) => JSON.stringify(message.payload).includes('"kind":"manager-offline"'))).toBe(false);
  f.advance(3500);
  paConnection = await f.admit(pa);
  await f.coordinator.poll(paConnection);
  await f.coordinator.tick();
  const episodes = f.store.snapshot().messages.filter((message) => message.recipient === "manager" && JSON.stringify(message.payload).includes('"kind":"manager-offline"'));
  expect(episodes).toHaveLength(2);
  expect(f.store.employeeView("manager").messages.some((message) => message.id === episodes[1]?.id)).toBe(true);
});


test("fresh control polling does not hide a missing worker Herdr session", async () => {
  const f = fixture(8);
  const { manager, pa, paConnection } = await f.ready();
  f.observations.splice(f.observations.findIndex((observation) => observation.paneId === f.store.employeeRuntime(pa, 1)?.paneId), 1);
  f.advance(1200);
  await f.coordinator.tick();
  f.advance(1300);
  await f.coordinator.poll(paConnection);
  const poll = await f.coordinator.poll(manager);
  expect(poll.pendingMessageIds.some((id) => id.startsWith("offline-"))).toBe(true);
});

test("manager Herdr presence loss stays actionable until observation recovers", async () => {
  const f = fixture(8);
  const { manager, paConnection } = await f.ready();
  const observation = f.observations.shift();
  if (observation === undefined) throw new Error("Manager fixture missing");
  f.advance(1200);
  await f.coordinator.poll(manager);
  await f.coordinator.poll(paConnection);
  await f.coordinator.tick();
  f.advance(1300);
  expect((await f.coordinator.poll(manager)).pendingMessageIds.some((id) => id.startsWith("manager-offline-"))).toBe(true);
  f.observations.unshift(observation);
  f.advance(1400);
  await f.coordinator.tick();
  expect((await f.coordinator.poll(manager)).pendingMessageIds.some((id) => id.startsWith("manager-offline-"))).toBe(false);
});

function storeProof(path: string): { revision: number; expires: number; inputs: readonly { id: string; payload: string }[] } {
  const db = new Database(path, { readonly: true });
  try {
    const revision = z.object({ n: z.number() }).parse(db.query("SELECT COALESCE(MAX(sequence), 0) AS n FROM audit").get());
    const lease = z.object({ expires: z.number() }).parse(db.query("SELECT expires FROM lease WHERE singleton = 1").get());
    const inputs = z.array(z.object({ id: z.string(), payload: z.string() })).parse(db.query("SELECT id, payload FROM records WHERE kind = 'receivedInput' ORDER BY id").all());
    return { revision: revision.n, expires: lease.expires, inputs };
  } finally { db.close(); }
}

test("host status is read-only and distinguishes startup states", async () => {
  const f = fixture(8);
  servers.push(serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath }));
  expect(statSync(f.config.socketPath).mode & 0o777).toBe(0o600);
  const database = join(f.config.stateDirectory, "staff.sqlite");
  const missing = hostStatusSchema.parse(await (await fetch("http://localhost/status", { unix: f.config.socketPath })).json());
  expect(missing.state).toBe("missing");
  expect(missing.binding).toEqual({ name: "test", boundRoot: f.config.boundRoot, home: f.home, host: "host" });
  expect(missing.reasons).toContain("manager-runtime-absent");
  let { manager, pa, paConnection } = await f.ready();
  await f.coordinator.command(manager, { kind: "receive", id: "native-history", source: "interactive", raw: { text: "keep this", images: [] } });
  const before = storeProof(database);
  const live = hostStatusSchema.parse(await (await fetch("http://localhost/status", { unix: f.config.socketPath })).json());
  expect(live.state).toBe("live");
  expect(live.storeRevision).toBe(before.revision);
  expect(live.setup.phase).toBe("ready");
  expect(live.setup.receipts.map((receipt) => receipt.kind)).toEqual(["scope", "manager-runtime", "pa-hire", "pa-runtime", "source-load", "source-load"]);
  expect(live.pendingInputs.rows).toEqual([expect.objectContaining({ id: "native-history", source: "interactive", mode: null })]);
  expect(live.staff.rows.find((row) => row.id === "manager")).toMatchObject({ role: "manager", lifecycle: "ready", nativeSession: f.config.managerFile });
  expect(live.staff.rows.find((row) => row.id === pa)?.lifecycle).toBe("ready");
  expect(JSON.stringify(live)).not.toContain("credentialDigest");
  expect(storeProof(database)).toEqual(before);
  f.advance(2100);
  const offline = hostStatusSchema.parse(f.coordinator.hostStatus({}));
  expect(offline.state).toBe("offline");
  expect(offline.reasons).toContain("manager-poll");
  manager = await f.admit("manager");
  paConnection = await f.admit(pa);
  await f.coordinator.poll(manager);
  await f.coordinator.poll(paConnection);
  await f.coordinator.tick();
  const paClaim = await f.coordinator.command(paConnection, { kind: "claim" });
  if (paClaim !== null) await f.coordinator.command(paConnection, { kind: "settle", result: { id: "pa-fresh", kind: "completed", output: "checked", checkpoint: null, outgoing: [{ id: "pa-fresh-report", recipient: "manager", kind: "report", correlation: "manager-supervision", payload: { ok: true } }] } });
  f.advance(4000);
  manager = await f.admit("manager");
  paConnection = await f.admit(pa);
  await f.coordinator.poll(manager);
  await f.coordinator.poll(paConnection);
  const stale = hostStatusSchema.parse(f.coordinator.hostStatus({}));
  expect(stale.state).toBe("stale");
  expect(stale.reasons).toContain("supervision-freshness");
  f.store.recordBindingFailure({ manager: f.store.managerBinding, employeeId: "manager", error: "native binding lost" });
  expect(hostStatusSchema.parse(f.coordinator.hostStatus({})).state).toBe("recovery-required");
});

test("host status reports configured duties as unsupported", () => {
  const f = fixture(8);
  f.store.setDuty({ manager: f.store.managerBinding, duty: { id: "legacy-duty", employeeId: "manager", assignment: null, target: null, probe: null, acceptance: null, repairAuthority: null, cadenceMs: null, nextDue: null } });
  const status = hostStatusSchema.parse(f.coordinator.hostStatus({}));
  expect(status.state).toBe("unsupported");
  expect(status.reasons).toContain("duties");
  expect(status.duties.count).toBe(1);
});

test("host admit retries are idempotent and a changed payload is refused", async () => {
  const f = fixture(8);
  servers.push(serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath }));
  const body = { requestId: "ronin-1", mode: "startup", origin: "ronin", text: "ship the queue", images: [{ type: "image", data: "abcd", mimeType: "image/png" }] };
  const first = hostReceiptSchema.parse(await (await fetch("http://localhost/host/admit", { unix: f.config.socketPath, method: "POST", body: JSON.stringify(body) })).json());
  const second = hostReceiptSchema.parse(await (await fetch("http://localhost/host/admit", { unix: f.config.socketPath, method: "POST", body: JSON.stringify(body) })).json());
  expect(second).toEqual(first);
  expect(first).toMatchObject({ kind: "admit", requestId: "ronin-1", mode: "startup", origin: "ronin", inputId: "ronin-1" });
  const changed = await fetch("http://localhost/host/admit", { unix: f.config.socketPath, method: "POST", body: JSON.stringify({ ...body, mode: "general" }) });
  expect(changed.status).toBe(409);
  const stored = f.store.snapshot().inputs.find((input) => input.id === "ronin-1");
  expect(stored).toMatchObject({ kind: "host", mode: "startup", origin: "ronin", source: "host", disposition: null });
  expect(f.store.snapshot().intakes).toHaveLength(0);
  const status = hostStatusSchema.parse(f.coordinator.hostStatus({ limit: 1 }));
  expect(status.pendingInputs).toMatchObject({ total: 1, rows: [{ id: "ronin-1", mode: "startup", origin: "ronin" }] });
  const again = await fetch("http://localhost/host/admit", { unix: f.config.socketPath, method: "POST", body: JSON.stringify({ ...body, text: "different" }) });
  expect(again.status).toBe(409);
  expect(f.store.snapshot().inputs).toHaveLength(1);
  const lookup = hostReceiptSchema.parse(await (await fetch(`http://localhost/host/receipt/${encodeURIComponent(first.id)}`, { unix: f.config.socketPath })).json());
  expect(lookup).toEqual(first);
  expect((await fetch("http://localhost/host/receipt/missing", { unix: f.config.socketPath })).status).toBe(403);
});

test("host cancel withdraws one request and settles only that item's worker generation", async () => {
  const f = fixture(8);
  servers.push(serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath }));
  const { manager } = await f.ready();
  const managerRuntime = f.store.employeeRuntime("manager", 1);
  if (!managerRuntime) throw new Error("manager runtime missing");
  const admitted = hostReceiptSchema.parse(await f.coordinator.hostAdmit({ requestId: "early", mode: "startup_outcome", origin: "ronin", text: "outcome", images: [] }));
  if (admitted.kind !== "admit") throw new Error("expected admit receipt");
  const cancelled = hostReceiptSchema.parse(await f.coordinator.hostCancel({ requestOrItemId: "early", intentId: "cancel-early" }));
  if (cancelled.kind !== "cancel") throw new Error("expected cancel receipt");
  expect(cancelled.target).toMatchObject({ kind: "request", inputId: "early", delegated: false });
  expect(hostReceiptSchema.parse(await f.coordinator.hostCancel({ requestOrItemId: "early", intentId: "cancel-early" }))).toEqual(cancelled);
  await expect(f.coordinator.hostCancel({ requestOrItemId: "early", intentId: "cancel-other" })).rejects.toThrow("already cancelled");
  await expect(f.coordinator.command(manager, { kind: "route", inputId: "early", disposition: "work", reason: "too late", amendItemIds: [] })).rejects.toThrow("cancelled");
  expect(hostReceiptSchema.parse(await (await fetch(`http://localhost/host/receipt/${encodeURIComponent(cancelled.id)}`, { unix: f.config.socketPath })).json())).toEqual(cancelled);
  const team = await f.delegate(manager, "event");
  const architect = await f.admit(team.architect);
  await f.admit(team.qa);
  const dev = await f.admit(team.devs[0]!);
  const devReady = z.object({ claim: z.object({ id: z.string() }) }).parse(await f.coordinator.command(dev, { kind: "claim" }));
  await f.coordinator.command(dev, { kind: "settle", claimId: devReady.claim.id, result: { id: "dev-ready", kind: "completed", output: "ready", checkpoint: null, outgoing: [] } });
  await f.coordinator.command(architect, { kind: "capture", capture: { captureId: "capture", eventId: "event", rows: [{ id: "ITEM-1", expectedRevision: null, fields: { status: "QUEUED", request: "fix the host gate", acceptance: "works", blocked_on: null } }], receipt: "captured" } });
  const devId = team.devs[0];
  if (devId === undefined) throw new Error("missing dev");
  await f.coordinator.command(architect, { kind: "item", request: { action: "assign", requestId: "assign-1", itemId: "ITEM-1", expectedRevision: 1, employeeId: devId, evidence: { go: true } } });
  const execution = f.store.snapshot().itemExecutions.find((entry) => entry.itemId === "ITEM-1");
  if (!execution) throw new Error("missing execution");
  const claimed = z.object({ claim: z.object({ id: z.string(), generation: z.number() }) }).parse(await f.coordinator.command(dev, { kind: "claim" }));
  const foreign = new Database(join(f.config.stateDirectory, "staff.sqlite"));
  foreign.query("INSERT INTO records(kind, id, payload) VALUES('claim', 'foreign-claim', ?)").run(JSON.stringify({ id: "foreign-claim", employeeId: team.devs[0], messageId: execution.messageId, ownerEpoch: f.store.ownerEpoch, generation: execution.generation + 1, status: "active" }));
  foreign.close();
  await expect(f.coordinator.hostCancel({ requestOrItemId: "ITEM-1", intentId: "cancel-item" })).rejects.toThrow("outside the cancelled generation");
  expect(f.store.queueItems().find((row) => row.id === "ITEM-1")?.status).toBe("EXECUTING");
  expect(f.store.snapshot().claims.find((claim) => claim.id === claimed.claim.id)?.status).toBe("active");
  const removed = new Database(join(f.config.stateDirectory, "staff.sqlite"));
  removed.query("DELETE FROM records WHERE kind='claim' AND id='foreign-claim'").run();
  removed.close();
  const itemReceipt = hostReceiptSchema.parse(await f.coordinator.hostCancel({ requestOrItemId: "ITEM-1", intentId: "cancel-item" }));
  if (itemReceipt.kind !== "cancel") throw new Error("expected cancel receipt");
  expect(itemReceipt.target).toMatchObject({ kind: "item", itemId: "ITEM-1", status: "CANCELLED", slots: [{ role: "execution", employeeId: devId, generation: execution.generation, messageId: execution.messageId, outcome: "settled" }] });
  expect(JSON.stringify(itemReceipt)).not.toContain(`"employeeId":"manager"`);
  expect(f.store.snapshot().claims.find((claim) => claim.id === claimed.claim.id)?.status).toBe("settled");
  expect(f.store.queueItems().find((row) => row.id === "ITEM-1")?.status).toBe("CANCELLED");
  const pictured = hostStatusSchema.parse(f.coordinator.hostStatus({}));
  expect(pictured.queue.kind === "readable" ? pictured.queue.rows.find((row) => row.id === "ITEM-1") : null).toMatchObject({ captureIds: ["capture"], hostReceiptIds: [itemReceipt.id], status: "CANCELLED" });
  expect(f.store.getEmployee("manager").employment).toBe("hired");
  expect(f.store.employeeRuntime("manager", 1)).toMatchObject({ launchId: managerRuntime.launchId, state: "ready" });
  expect(hostReceiptSchema.parse(await f.coordinator.hostCancel({ requestOrItemId: "ITEM-1", intentId: "cancel-item" }))).toEqual(itemReceipt);
  expect(admitted.mode).toBe("startup_outcome");
});

test("Claude employees launch with an assigned session, prompt suffix and shared hook files only", async () => {
  const f = harnessFixture(8, "claude");
  const { pa } = await f.ready();
  const saved = f.store.runtimeBindings().find((r) => r.employeeId === pa);
  if (!saved?.paneId) throw new Error("Missing PA launch");
  const launches = join(f.config.stateDirectory, "launches");
  const promptFile = join(launches, `${saved.launchId}.prompt.md`);
  const shared = join(f.config.startupRoot, "startup", "claude");
  const name = `s-${saved.launchId.replaceAll("-", "").slice(0, 28)}`;
  expect(f.launches).toEqual([{ harness: "claude", paneId: saved.paneId, name, args: ["--session-id", saved.launchId, "--append-system-prompt-file", promptFile, "--settings", join(shared, "settings.json"), "--mcp-config", join(shared, "mcp.json"), "-n", name] }]);
  expect(f.layouts).toEqual([{ JP_SKILLS_HOME: f.config.skillsHome, STARTUP_ROOT: f.config.startupRoot, STARTUP_V7_MANIFEST: join(launches, `${saved.launchId}.json`), CLAUDE_CONFIG_DIR: f.config.startupRoot }]);
  expect(readFileSync(promptFile, "utf8")).toBe(profileText(loadProfile({ skillsRoot: f.config.skillsRoot, role: "pa", employeeId: pa, generation: saved.generation })));
  expect(statSync(promptFile).mode & 0o777).toBe(0o600);
  expect(existsSync(join(launches, `${saved.launchId}.ts`))).toBe(false);
  expect(readFileSync(join(shared, "mcp.json"), "utf8")).toBe(JSON.stringify(claudeMcpConfig({ bun: process.execPath, skillsRoot: f.config.skillsRoot })));
  expect(saved).toMatchObject({ state: "ready", nativeSession: saved.launchId });
  expect(existsSync(saved.launchId)).toBe(false);
});

test("Claude crew panes carry only the manifest and admit by assigned session without a transcript", async () => {
  const f = harnessFixture(8, "claude");
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "claude-work");
  for (const id of [team.architect, team.qa, ...team.devs]) {
    const launched = f.store.runtimeBindings().findLast((r) => r.employeeId === id);
    expect(launched?.nativeSession).toBe(launched?.launchId);
    await f.admit(id);
  }
  expect(f.layouts.slice(1).every((env) => env.STARTUP_ROOT === f.config.startupRoot && env.CLAUDE_CONFIG_DIR === f.config.startupRoot && env.JP_SKILLS_HOME === f.config.skillsHome)).toBe(true);
  expect(f.layouts).toHaveLength(4);
  expect(f.launches.every((launch) => launch.args[0] === "--session-id" && launch.args[1] !== undefined && f.store.runtimeBindings().some((r) => r.launchId === launch.args[1] && r.state === "ready"))).toBe(true);
});

test("Claude admission waits for the assigned session and refuses a mismatched one", async () => {
  const f = harnessFixture(8, "claude");
  await f.coordinator.start();
  await f.coordinator.admit({ credential: "manager-secret", nativeSession: "manager-session", paneId: "w1:p1", source: f.store.runtimeBindings().find((r) => r.employeeId === "manager")!.source });
  const saved = f.store.runtimeBindings().find((r) => r.employeeId !== "manager");
  if (!saved?.paneId) throw new Error("Missing PA launch");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.config.stateDirectory, "launches", `${saved.launchId}.json`), "utf8")));
  const observation = f.observations.find((o) => o.paneId === saved.paneId)!;
  f.observations.splice(f.observations.indexOf(observation), 1, { ...observation, nativeSession: "stale-session" });
  const request = { credential: manifest.credential, paneId: saved.paneId, source: manifest.source };
  await expect(f.coordinator.admit({ ...request, nativeSession: saved.launchId })).rejects.toThrow("has not reported its native Claude session yet");
  await expect(f.coordinator.admit({ ...request, nativeSession: "stale-session" })).rejects.toThrow("does not match the saved launch");
  expect(f.store.runtimeBindings().find((r) => r.launchId === saved.launchId)?.state).toBe("starting");
  f.observations.splice(f.observations.indexOf(f.observations.find((o) => o.paneId === saved.paneId)!), 1, observation);
  await expect(f.coordinator.admit({ ...request, nativeSession: saved.launchId })).resolves.toHaveProperty("connection");
  await expect(f.coordinator.admit({ credential: "manager-secret", nativeSession: "other-manager", paneId: "w1:p1", source: manifest.source })).rejects.toThrow();
});

test("Claude manager start matches its saved session rather than its transcript path", async () => {
  const f = harnessFixture(8, "claude");
  const reported = f.observations[0]!;
  f.observations.splice(0, 1, { ...reported, nativeSession: f.config.managerFile });
  await expect(f.coordinator.start()).rejects.toThrow("Manager pane");
  expect(f.launches).toHaveLength(0);
  f.observations.splice(0, 1, reported);
  const manager = await f.ready();
  expect(manager.manager).toBeString();
});

test("Claude crew reuse keeps each prior process session", async () => {
  const f = harnessFixture(8, "claude");
  const { manager } = await f.ready();
  const first = await f.delegate(manager, "first");
  const connections = new Map<string, string>();
  for (const id of [first.architect, first.qa, ...first.devs]) connections.set(id, await f.admit(id));
  const sessions = new Map(f.store.runtimeBindings().filter((r) => connections.has(r.employeeId)).map((r) => [r.employeeId, r.nativeSession]));
  for (const [id, connection] of connections) {
    const claimed = z.object({ claim: z.object({ id: z.string() }) }).parse(await f.coordinator.command(connection, { kind: "claim" }));
    if (id === first.architect) await f.coordinator.command(connection, { kind: "capture", capture: { captureId: "empty-capture", eventId: "first", rows: [], receipt: "no tasks" } });
    await f.coordinator.command(connection, { kind: "settle", claimId: claimed.claim.id, result: { id: `done-${id}`, kind: "completed", output: "done", checkpoint: null, outgoing: [] } });
  }
  await f.coordinator.command(manager, { kind: "finish", teamId: first.id, evidence: "all work resolved" });
  const launched = f.launches.length;
  const second = await f.delegate(manager, "second");
  expect(second.architect).toBe(first.architect);
  expect(f.launches).toHaveLength(launched);
  for (const id of connections.keys()) {
    const reused = f.store.runtimeBindings().findLast((r) => r.employeeId === id);
    expect(reused?.nativeSession).toBe(sessions.get(id)!);
    expect(reused?.launchId).not.toBe(sessions.get(id)!);
    await f.admit(id);
  }
});

for (const kind of ["question", "uncertain"] as const) test(`a crew-ready notice settled as ${kind} never blocks the member's later item assignment`, async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const team = await f.delegate(manager, `crew-notice-${kind}`);
  const architect = await f.admit(team.architect);
  const qa = await f.admit(team.qa);
  const dev = await f.admit(team.devs[0]!);
  for (const [id, connection] of [[team.qa, qa], [team.devs[0]!, dev]] as const) {
    const claimed = z.object({ claim: z.object({ id: z.string() }), message: z.object({ payload: z.object({ kind: z.literal("crew-ready") }) }) }).parse(await f.coordinator.command(connection, { kind: "claim" }));
    await f.coordinator.command(connection, { kind: "settle", claimId: claimed.claim.id, result: { id: `notice-${kind}-${id}`, kind, output: "No item yet", checkpoint: null, outgoing: kind === "question" ? [{ id: `notice-question-${id}`, recipient: team.architect, kind: "question", correlation: `crew-notice-${kind}`, payload: "Which item?" }] : [] } });
    if (kind === "uncertain") await f.coordinator.command(manager, { kind: "reconcile", claimId: claimed.claim.id, evidence: "Readiness notice had no side effects" });
  }
  expect(f.store.snapshot().assignments.filter((a) => [team.qa, team.devs[0]!].includes(a.employeeId)).map((a) => a.state)).toEqual(["complete", "complete"]);
  await f.coordinator.command(architect, { kind: "capture", capture: { captureId: `capture-${kind}`, eventId: `crew-notice-${kind}`, rows: [{ id: `ITEM-${kind}`, expectedRevision: null, fields: { status: "QUEUED", procedure: "code-review", request: "work", acceptance: "proof", blocked_on: [] } }], receipt: "captured" } });
  await expect(f.coordinator.command(architect, { kind: "item", request: { action: "assign", requestId: `assign-${kind}`, itemId: `ITEM-${kind}`, expectedRevision: 1, employeeId: team.devs[0]!, evidence: "Execute" } })).resolves.toMatchObject({ status: "EXECUTING" });
});

test("an item assignment blocked by unresolved work names the assignment and its recovery", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const team = await f.delegate(manager, "blocked-assign");
  const architect = await f.admit(team.architect);
  await f.admit(team.qa);
  const dev = await f.admit(team.devs[0]!);
  const notice = f.store.snapshot().assignments.find((a) => a.employeeId === team.devs[0]!);
  if (!notice) throw new Error("Missing crew assignment");
  const rows = ["ITEM-A", "ITEM-B"].map((id) => ({ id, expectedRevision: null, fields: { status: "QUEUED", procedure: "code-review", request: "work", acceptance: "proof", blocked_on: [] } }));
  await f.coordinator.command(architect, { kind: "capture", capture: { captureId: "capture-blocked", eventId: "blocked-assign", rows, receipt: "captured" } });
  const assign = (itemId: string) => f.coordinator.command(architect, { kind: "item", request: { action: "assign", requestId: `assign-${itemId}`, itemId, expectedRevision: 1, employeeId: team.devs[0]!, evidence: "Execute" } });
  await expect(assign("ITEM-A")).rejects.toThrow(`Item dev has unresolved work: assignment ${notice.id} is pending; its recipient must claim and settle it first`);
  await f.coordinator.command(dev, { kind: "claim" });
  await f.coordinator.command(dev, { kind: "settle", result: { id: "notice-done", kind: "completed", output: "ready", checkpoint: null, outgoing: [] } });
  await assign("ITEM-A");
  const claimed = z.object({ message: z.object({ id: z.string() }) }).parse(await f.coordinator.command(dev, { kind: "claim" }));
  await f.coordinator.command(dev, { kind: "settle", result: { id: "item-question", kind: "question", output: "Which file?", checkpoint: null, outgoing: [{ id: "item-question-cue", recipient: team.architect, kind: "question", correlation: "ITEM-A", payload: "Which file?" }] } });
  await expect(assign("ITEM-B")).rejects.toThrow(`Item dev has unresolved work: assignment ${claimed.message.id} is waiting; the manager must startup_resolve it with evidence`);
  await f.coordinator.command(manager, { kind: "resolve", assignmentId: claimed.message.id, evidence: "Architect answered" });
  await expect(assign("ITEM-B")).resolves.toMatchObject({ status: "EXECUTING" });
});

test("delegate and activate return durable receipts without waiting for pane launches", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  await f.coordinator.command(manager, { kind: "intake", eventId: "slow-crew", input: "work", amendItemIds: [] });
  const barrier = Promise.withResolvers<void>();
  f.delayLaunch(barrier.promise);
  try {
    const launched = f.launches.length;
    const delegated = await Promise.race([f.coordinator.command(manager, { kind: "delegate", eventId: "slow-crew", developers: 1 }), Bun.sleep(100).then(() => "blocked" as const)]);
    expect(delegated).toMatchObject({ eventId: "slow-crew", state: "reserved" });
    const hire = z.object({ employees: z.array(z.object({ id: z.string() })) }).parse(await f.coordinator.command(manager, { kind: "hire", requestId: "slow-ops", role: "devops", additional: 1 }));
    const id = hire.employees[0]!.id;
    expect(await Promise.race([f.coordinator.command(manager, { kind: "activate", employeeIds: [id] }), Bun.sleep(100).then(() => "blocked" as const)])).toEqual({ activated: [id] });
    await expect(f.coordinator.command(manager, { kind: "activate", employeeIds: [id] })).rejects.toThrow("already launching");
    expect(f.launches.length).toBe(launched + 1);
  } finally { barrier.resolve(); }
  await f.coordinator.launching();
  const team = f.store.snapshot().teams.find((t) => t.eventId === "slow-crew")!;
  for (const id of [team.architect, team.qa, ...team.devs]) await f.admit(id);
  expect(f.store.snapshot().teams.find((t) => t.id === team.id)?.state).toBe("ready");
});

test("a background crew launch failure is saved as manager alerts and leaves unlaunched members prepared", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  await f.coordinator.command(manager, { kind: "intake", eventId: "broken-crew", input: "work", amendItemIds: [] });
  f.failLayout(new Error("ambiguous create response"));
  const team = z.object({ id: z.string(), architect: z.string(), qa: z.string(), devs: z.array(z.string()) }).parse(await f.coordinator.command(manager, { kind: "delegate", eventId: "broken-crew", developers: 1 }));
  await f.coordinator.launching();
  const runtime = (id: string) => f.store.runtimeBindings().findLast((r) => r.employeeId === id);
  expect(runtime(team.architect)?.state).toBe("uncertain");
  expect([team.qa, ...team.devs].map((id) => runtime(id)?.state)).toEqual(["prepared", "prepared"]);
  const alerts = f.store.snapshot().messages.filter((m) => m.recipient === "manager").map((m) => JSON.stringify(m.payload));
  expect(alerts.some((payload) => payload.includes('"kind":"layout-uncertain"'))).toBe(true);
  const interrupted = alerts.find((payload) => payload.includes('"kind":"launch-interrupted"'));
  expect(interrupted).toContain(team.qa);
  expect(interrupted).toContain("ambiguous create response");
});

test("re-admission revokes the prior launch connection before another command or report", async () => {
  const f = fixture(8);
  const { pa, paConnection } = await f.ready();
  const next = await f.admit(pa);
  await expect(f.coordinator.poll(next)).resolves.toHaveProperty("projection");
  await expect(f.coordinator.command(paConnection, { kind: "claim" })).rejects.toThrow("connection");
  const runtime = f.store.runtimeBindings().findLast((entry) => entry.employeeId === pa)!;
  await expect(f.coordinator.poll(paConnection, { status: "unavailable", reason: "omp_session_api_unavailable", nativeSession: runtime.nativeSession!, agentSessionId: `s-${runtime.launchId.replaceAll("-", "").slice(0, 28)}`, observedAt: 900000 })).rejects.toThrow("connection");
});

test("an older delayed admission cannot supersede a newer admission", async () => {
  const f = fixture(8);
  const { pa } = await f.ready();
  const barrier = Promise.withResolvers<void>();
  f.delayObservation(barrier.promise);
  const old = f.admit(pa);
  f.delayObservation(Promise.resolve());
  const latest = await f.admit(pa);
  barrier.resolve();
  await expect(old).rejects.toThrow("admission");
  await expect(f.coordinator.poll(latest)).resolves.toHaveProperty("projection");
});

test("a replaced connection cannot commit delegation after an awaited observation", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  await f.coordinator.command(manager, { kind: "intake", eventId: "stale-delegate", input: "work", amendItemIds: [] });
  const barrier = Promise.withResolvers<void>();
  f.delayObservation(barrier.promise);
  const pending = f.coordinator.command(manager, { kind: "delegate", eventId: "stale-delegate", developers: 1 });
  await Bun.sleep(1);
  f.delayObservation(Promise.resolve());
  await f.admit("manager");
  barrier.resolve();
  await expect(pending).rejects.toThrow("connection");
  expect(f.store.snapshot().teams).toHaveLength(0);
});

test("closing the admission HTTP channel revokes the bearer and current settings", async () => {
  const f = fixture(8);
  const { manager, pa } = await f.ready();
  const saved = f.store.runtimeBindings().findLast((r) => r.employeeId === pa)!;
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.config.startupRoot, "launches", `${saved.launchId}.json`), "utf8")));
  servers.push(serveCoordinator({ coordinator: f.coordinator, socketPath: f.config.socketPath }));
  const channel = new WebSocket(`ws+unix://${f.config.socketPath}:/admit`);
  const receipt = await new Promise<{ connection: string }>((resolve) => {
    channel.onopen = (): void => { channel.send(JSON.stringify({ credential: manifest.credential, nativeSession: saved.nativeSession, paneId: saved.paneId, source: manifest.source, agentSessionId: `s-${saved.launchId.replaceAll("-", "").slice(0, 28)}` })); };
    channel.onmessage = (event): void => { resolve(z.object({ connection: z.string() }).parse(JSON.parse(String(event.data)))); };
  });
  await f.coordinator.poll(receipt.connection, { status: "unavailable", reason: "omp_session_api_unavailable", nativeSession: saved.nativeSession!, agentSessionId: `s-${saved.launchId.replaceAll("-", "").slice(0, 28)}`, observedAt: 1000 }, 1);
  channel.close();
  await Bun.sleep(30);
  await expect(f.coordinator.command(receipt.connection, { kind: "claim" })).rejects.toThrow("connection");
  const staff = z.object({ runtime: z.array(z.object({ employeeId: z.string(), effectiveSettings: z.object({ reason: z.string() }) })) }).parse(await f.coordinator.command(manager, { kind: "staff" }));
  expect(staff.runtime.find((entry) => entry.employeeId === pa)?.effectiveSettings.reason).toBe("session_not_observed");
});

test("settings sequences fence conflicts and old epochs regardless of future client clocks", async () => {
  const f = fixture(8);
  const { manager, pa, paConnection } = await f.ready();
  const saved = f.store.runtimeBindings().findLast((entry) => entry.employeeId === pa)!;
  const report = { status: "available" as const, nativeSession: saved.nativeSession!, agentSessionId: `s-${saved.launchId.replaceAll("-", "").slice(0, 28)}`, observedAt: 999999999, model: { provider: "p", id: "m", name: "M" }, availableModels: [{ provider: "p", id: "m", name: "M" }], configuredEffort: "high", effectiveEffort: "high", availableEfforts: ["high"] };
  await f.coordinator.poll(paConnection, report, 1);
  expect(f.store.effectiveRoleSettings(pa, saved.generation)?.observedAt).toBe(1000);
  await expect(f.coordinator.poll(paConnection, { ...report, effectiveEffort: "low" }, 1)).rejects.toThrow("sequence");
  const latest = await f.admit(pa);
  const status = await f.coordinator.command(manager, { kind: "staff" });
  const rows = z.object({ runtime: z.array(z.object({ employeeId: z.string(), effectiveSettings: z.object({ status: z.string() }) })) }).parse(status).runtime;
  expect(rows.find((entry) => entry.employeeId === pa)?.effectiveSettings.status).toBe("unavailable");
  await expect(f.coordinator.poll(paConnection, report, 999)).rejects.toThrow("connection");
  await f.coordinator.poll(latest, { ...report, observedAt: 1 }, 1);
  expect(f.store.effectiveRoleSettings(pa, saved.generation)).toMatchObject({ status: "available", sampleSequence: 1, observedAt: 1000 });
  f.coordinator.revoke(latest);
  await expect(f.coordinator.poll(latest, report, 2)).rejects.toThrow("connection");
});

test("cancelled admission during native observation cannot install authority or refresh presence", async () => {
  const f = fixture(8);
  const { pa } = await f.ready();
  const saved = f.store.runtimeBindings().findLast((entry) => entry.employeeId === pa)!;
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.config.startupRoot, "launches", `${saved.launchId}.json`), "utf8")));
  const barrier = Promise.withResolvers<void>();
  f.delayObservation(barrier.promise);
  const abort = new AbortController();
  const pending = f.coordinator.admit({ credential: manifest.credential, nativeSession: saved.nativeSession!, paneId: saved.paneId!, source: manifest.source }, abort.signal);
  abort.abort();
  barrier.resolve();
  await expect(pending).rejects.toThrow("disconnected before commit");
  expect(f.store.runtimeBindings().findLast((entry) => entry.employeeId === pa)).toEqual(saved);
});
