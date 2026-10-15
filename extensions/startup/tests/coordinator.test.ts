import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { openStore, type StartupStore } from "../src/store";
import { openCoordinator, serveCoordinator, type Coordinator } from "../src/coordinator";
import type { HerdrObservation, HerdrRuntime } from "../src/herdr-runtime";
import { connectEmployee } from "../src/employee-client";
import { sourceSchema } from "../src/contracts";

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
  const root = mkdtempSync(join(tmpdir(), "sv7-"));
  roots.push(root);
  const home = join(root, "home");
  const boundRoot = join(root, "repo");
  mkdirSync(boundRoot);
  const stateDirectory = join(home, "startup", "test");
  const managerFile = join(root, "manager.jsonl");
  writeFileSync(managerFile, JSON.stringify({ type: "session", id: "manager-session" }) + "\n");
  let now = 1000;
  const store = openStore({ path: join(stateDirectory, "staff.sqlite"), scope: { home, boundRoot, host: "host", name: "test", managerSession: "manager-session" }, owner: { id: "coordinator", managerGeneration: 1, leaseMs: 60000 }, now: () => now });
  stores.push(store);
  const observations: HerdrObservation[] = [{ name: "manager", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term1", nativeSession: managerFile, state: "idle", stateSequence: 1, interactiveReady: true }];
  let next = 2;
  let launchBarrier: Promise<void> | null = null;
  let layoutFailure: Error | null = null;
  let layoutCalls = 0;
  let observationFailure: Error | null = null;
  const herdr: HerdrRuntime = {
    check: async () => {},
    renameCrew: async () => {},
    createCrew: async () => {
      layoutCalls += 1;
      if (layoutFailure) throw layoutFailure;
      return { tabId: `w1:t${next}`, rootPaneId: `w1:p${next++}` };
    },
    split: async () => `w1:p${next++}`,
    launch: async (input) => {
      if (launchBarrier) await launchBarrier;
      const nativeSession = join(root, `${input.name}.jsonl`);
      writeFileSync(nativeSession, JSON.stringify({ type: "session", id: input.name }) + "\n");
      const observation: HerdrObservation = { name: input.name, workspaceId: "w1", tabId: "w1:t2", paneId: input.paneId, terminalId: `term-${input.name}`, nativeSession, state: "idle", stateSequence: 1, interactiveReady: true };
      observations.push(observation);
      return observation;
    },
    observe: async () => { if (observationFailure) throw observationFailure; return observations; },
  };
  const config = { name: "test", stateDirectory, boundRoot, skillsRoot: resolve(import.meta.dir, "../../.."), socketPath: join(root, "c.sock"), profile: "test", herdrIntegration: "/fixture/herdr.ts", managerSession: "manager-session", managerFile, managerPaneId: "w1:p1", managerCredential: "manager-secret", policy: { tickMs: 10, paCadenceMs: 100, progressDeadlineMs: 200, connectionDeadlineMs: 1000, executionLimit } };
  const coordinator: Coordinator = openCoordinator({ store, herdr, config, now: () => now });
  async function admit(employeeId: string): Promise<string> {
    const runtime = store.runtimeBindings().findLast((r) => r.employeeId === employeeId);
    if (!runtime) throw new Error("Missing runtime");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(stateDirectory, "launches", `${runtime.launchId}.json`), "utf8")));
    const observation = observations.find((o) => o.paneId === runtime.paneId);
    if (!observation?.nativeSession) throw new Error("Missing observation");
    return (await coordinator.admit({ credential: manifest.credential, nativeSession: observation.nativeSession, paneId: observation.paneId, source: manifest.source })).connection;
  }
  async function ready() {
    await coordinator.start();
    const manager = await coordinator.admit({ credential: "manager-secret", nativeSession: managerFile, paneId: "w1:p1", source: store.runtimeBindings().find((r) => r.employeeId === "manager")!.source });
    const pa = store.snapshot().employees.find((e) => e.role === "pa");
    if (!pa) throw new Error("Missing PA");
    const paConnection = await admit(pa.id);
    return { manager: manager.connection, pa: pa.id, paConnection };
  }
  async function delegate(manager: string, eventId: string) {
    await coordinator.command(manager, { kind: "intake", eventId, input: "fix", amendItemIds: [] });
    await coordinator.command(manager, { kind: "delegate", eventId, developers: 1 });
    const team = store.snapshot().teams.find((t) => t.eventId === eventId);
    if (!team) throw new Error("Missing team");
    return team;
  }
  return { coordinator, store, config, observations, ready, admit, delegate, advance: (time: number) => { now = time; }, delayLaunch: (barrier: Promise<void>) => { launchBarrier = barrier; }, failLayout: (error: Error) => { layoutFailure = error; }, failObservation: (error: Error | null) => { observationFailure = error; }, layoutCalls: () => layoutCalls };
}

test("lost Herdr supervision degrades fresh PA connections and persists a manager blocker", async () => {
  const f = fixture(8);
  const { manager, paConnection } = await f.ready();
  f.failObservation(new Error("observer connection unavailable"));
  await expect(f.coordinator.tick()).rejects.toThrow("observer connection unavailable");
  await f.coordinator.poll(paConnection);
  expect(JSON.stringify(await f.coordinator.command(manager, { kind: "staff" }))).toContain("pa-offline");
  expect(f.store.snapshot().messages.some((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"observer-unavailable"'))).toBe(true);
  await f.coordinator.command(manager, { kind: "intake", eventId: "event", input: "work", amendItemIds: [] });
  await expect(f.coordinator.command(manager, { kind: "delegate", eventId: "event", developers: 1 })).rejects.toThrow("PA");
  f.failObservation(null);
  await f.coordinator.tick();
  expect(JSON.stringify(await f.coordinator.command(manager, { kind: "staff" }))).toContain('"health":"ready"');
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
  } finally { barrier.resolve(); await launching; }
});

test("uncertain pane creation is fenced before a manager retries activation", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const receipt = z.object({ employees: z.array(z.object({ id: z.string() })) }).parse(await f.coordinator.command(manager, { kind: "hire", requestId: "hire-ops", role: "devops", additional: 1 }));
  const id = receipt.employees[0]!.id;
  f.failLayout(new Error("ambiguous create response"));
  await expect(f.coordinator.command(manager, { kind: "activate", employeeIds: [id] })).rejects.toThrow("ambiguous");
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

test("a skipped lifecycle sequence alerts the manager without inventing missing events", async () => {
  const f = fixture(8);
  const { manager, pa } = await f.ready();
  await f.coordinator.tick();
  const runtime = f.store.runtimeBindings().find((r) => r.employeeId === pa)!;
  const index = f.observations.findIndex((o) => o.paneId === runtime.paneId);
  f.observations[index] = { ...f.observations[index]!, state: "done", stateSequence: 4 };
  await f.coordinator.tick();
  expect(f.store.snapshot().messages.some((m) => m.recipient === "manager" && JSON.stringify(m.payload).includes('"kind":"observation-gap"'))).toBe(true);
  f.observations[index] = { ...f.observations[index]!, stateSequence: 2 };
  await f.coordinator.tick();
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
  const { manager, pa } = await f.ready();
  f.advance(2100);
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
  const { manager } = await f.ready();
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
  const dev = await f.admit(id);
  expect(f.store.snapshot().employees.find((e) => e.id === id)?.generation).toBe(2);
  expect(await f.coordinator.command(dev, { kind: "claim" })).toBeNull();
});

test("prepared recovery checks live launch alias and rejects the abandoned credential before successor preparation", async () => {
  const f = fixture(8);
  const { manager } = await f.ready();
  const hire = z.object({ employees: z.array(z.object({ id: z.string() })) }).parse(await f.coordinator.command(manager, { kind: "hire", requestId: "prepared-recovery", role: "dev", additional: 1 }));
  const id = hire.employees[0]?.id;
  if (!id) throw new Error("Missing hired dev");
  const old = f.store.runtimeBindings().findLast((r) => r.employeeId === id);
  if (!old) throw new Error("Missing prepared launch");
  const oldManifest = manifestSchema.parse(JSON.parse(readFileSync(join(f.config.stateDirectory, "launches", `${old.launchId}.json`), "utf8")));
  f.advance(2500);
  f.observations.push({ name: `s-${old.launchId.replaceAll("-", "").slice(0, 28)}`, workspaceId: "w1", tabId: "w1:t99", paneId: "w1:p99", terminalId: "term99", nativeSession: "/stranded.jsonl", state: "working", stateSequence: 1, interactiveReady: false });
  await expect(f.coordinator.command(manager, { kind: "replace", employeeId: id, evidence: "Verified unknown shell stopped" })).rejects.toThrow("live");
  f.observations.pop();
  f.store.abandonUnadmittedRuntime({ manager: f.store.managerBinding, employeeId: id, launchId: old.launchId, evidence: "Verified unknown shell stopped", verifiedAbsentAt: 2500, connectionDeadlineMs: 1000 });
  await expect(f.coordinator.admit({ credential: oldManifest.credential, nativeSession: "/stranded.jsonl", paneId: "w1:p99", source: oldManifest.source })).rejects.toThrow("abandoned");
  expect(await f.coordinator.command(manager, { kind: "replace", employeeId: id, evidence: "Verified unknown shell stopped" })).toEqual({ generation: 2 });
  expect(f.store.runtimeBindings().findLast((r) => r.employeeId === id)).toMatchObject({ generation: 2, state: "prepared" });
});
