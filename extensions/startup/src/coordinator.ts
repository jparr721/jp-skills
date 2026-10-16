import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { captureSchema, cueSchema, encode, idSchema, jsonSchema, resultSchema, sourceSchema, StoreAuthorityError, StoreConflictError, StoreFenceError, type Binding, type Employee, type Json, type Source } from "./contracts";
import { inputPage, inputSummary, rawInputSchema, imageSchema } from "./inputs";
import { itemActionSchema, terminalItemStatuses } from "./items";
import { loadProfile, profileText, verifyProfile, type Profile } from "./profiles";
import { runtimePolicySchema, type RuntimeBinding, type RuntimePolicy } from "./runtime-contracts";
import type { StartupStore } from "./store";
import type { HerdrObservation, HerdrRuntime } from "./herdr-runtime";

export type CoordinatorConfig = Readonly<{
  name: string; stateDirectory: string; boundRoot: string; skillsRoot: string;
  socketPath: string; profile: string; herdrIntegration: string;
  managerSession: string; managerFile: string; managerPaneId: string;
  managerCredential: string; policy: RuntimePolicy;
}>;
const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("claim") }),
  z.strictObject({ kind: z.literal("begin_turn") }),
  z.strictObject({ kind: z.literal("end_turn") }),
  z.strictObject({ kind: z.literal("staff") }),
  z.strictObject({ kind: z.literal("settle"), claimId: idSchema, result: resultSchema }),
  z.strictObject({ kind: z.literal("send"), cue: cueSchema }),
  z.strictObject({ kind: z.literal("item"), request: itemActionSchema }),
  z.strictObject({ kind: z.literal("capture"), capture: captureSchema }),
  z.strictObject({ kind: z.literal("hire"), requestId: idSchema, role: z.enum(["architect", "qa", "dev", "devops", "pa"]), additional: z.number().int().positive().safe() }),
  z.strictObject({ kind: z.literal("delegate"), eventId: idSchema, developers: z.number().int().positive().safe() }),
  z.strictObject({ kind: z.literal("activate"), employeeIds: z.array(idSchema).min(1) }),
  z.strictObject({ kind: z.literal("replace"), employeeId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("intake"), eventId: idSchema, input: jsonSchema, amendItemIds: z.array(idSchema) }),
  z.strictObject({ kind: z.literal("route"), inputId: idSchema, disposition: z.enum(["work", "status", "control", "conversation", "decision"]), reason: z.string().min(1), amendItemIds: z.array(idSchema) }),
  z.strictObject({ kind: z.literal("receive"), id: idSchema, source: z.enum(["interactive", "rpc"]), raw: z.strictObject({ text: z.string(), images: z.array(jsonSchema) }) }),
  z.strictObject({ kind: z.literal("input"), inputId: idSchema, offset: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("image"), inputId: idSchema, index: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("reconcile"), claimId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("resolve"), assignmentId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("finish"), teamId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("refresh"), employeeId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("retire"), employeeIds: z.array(idSchema).min(1), evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("block"), key: idSchema, evidence: jsonSchema }),
]);
const admissionSchema = z.strictObject({ credential: idSchema, nativeSession: idSchema, paneId: idSchema, source: sourceSchema });
const launchFailureSchema = z.strictObject({ credential: idSchema, error: z.string().min(1).max(8192) });
type Poll = Readonly<{ toolBlockReason: string | null; projection: string; pendingMessageIds: readonly string[]; waitReason: string | null }>;
type SupervisionFailure = Readonly<{ component: "herdr" | "observation" | "queue"; employeeId: string | null; error: string }>;
type CoordinatorHealth = Readonly<{
  status: "starting" | "running" | "degraded";
  supervision: Readonly<{ lastStartedAt: number | null; lastCompletedAt: number | null; lastSuccessAt: number | null; errors: readonly SupervisionFailure[] }>;
}>;
export type Coordinator = Readonly<{
  start: () => Promise<void>;
  health: () => CoordinatorHealth;
  admit: (input: Readonly<{ credential: string; nativeSession: string; paneId: string; source: Source }>) => Promise<{ connection: string }>;
  launchFailure: (input: z.infer<typeof launchFailureSchema>) => void;
  command: (connection: string, command: Json) => Promise<Json>;
  poll: (connection: string) => Promise<Poll>;
  tick: () => Promise<void>;
}>;
class AdmissionPendingError extends Error {}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): Json { return jsonSchema.parse(JSON.parse(JSON.stringify(value))); }

export function openCoordinator(input: Readonly<{ store: StartupStore; herdr: HerdrRuntime; config: CoordinatorConfig; now: () => number }>): Coordinator {
  const { store, herdr, config, now } = input;
  const policy = runtimePolicySchema.parse(config.policy);
  const connections = new Map<string, Readonly<{ employeeId: string; generation: number; epoch: number }>>();
  let serial: Promise<void> = Promise.resolve();
  let ticking: Promise<void> | null = null;
  const openedAt = now();
  let supervision: CoordinatorHealth["supervision"] = { lastStartedAt: null, lastCompletedAt: null, lastSuccessAt: null, errors: [] };
  let observerAvailable: boolean = true;
  const launchDirectory = join(config.stateDirectory, "launches");
  if (existsSync(launchDirectory) && lstatSync(launchDirectory).isSymbolicLink())
    throw new StoreAuthorityError("Launch directory cannot be a symlink");
  mkdirSync(launchDirectory, { recursive: true, mode: 0o700 });
  function employee(id: string): Employee {
    return store.getEmployee(id);
  }
  function runtime(id: string): RuntimeBinding {
    const current = employee(id);
    const records = store.runtimeBindings().filter((r) => r.employeeId === id && r.generation >= current.generation);
    const found = records.findLast(() => true);
    if (!found) throw new StoreAuthorityError(`Employee ${id} has no prepared runtime`);
    return found;
  }
  function profile(current: Employee, generation: number): Profile {
    return loadProfile({ skillsRoot: config.skillsRoot, role: current.role, employeeId: current.id, generation });
  }
  function launchFiles(current: RuntimeBinding, credential: string): string {
    const path = join(launchDirectory, `${current.launchId}.json`);
    const manifest = encode({ socketPath: config.socketPath, credential, source: current.source, employeeId: current.employeeId, generation: current.generation, profile: config.profile, skillsRoot: config.skillsRoot });
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink() || readFileSync(path, "utf8") !== manifest)
        throw new StoreConflictError("Launch manifest ownership conflicts with its reserved generation");
    } else writeFileSync(path, manifest, { mode: 0o600, flag: "wx" });
    const bootstrap = join(launchDirectory, `${current.launchId}.ts`);
    const content = `import { installLaunchedEmployee } from ${JSON.stringify(join(config.skillsRoot, "extensions/startup/src/employee-entry.ts"))};\nimport type { HostAPI } from ${JSON.stringify(join(config.skillsRoot, "extensions/startup/index.ts"))};\nexport default (host: HostAPI): void => installLaunchedEmployee(host, ${JSON.stringify(path)});\n`;
    if (existsSync(bootstrap)) {
      if (lstatSync(bootstrap).isSymbolicLink() || readFileSync(bootstrap, "utf8") !== content)
        throw new StoreConflictError("Launch bootstrap ownership conflicts with its reserved generation");
    } else writeFileSync(bootstrap, content, { mode: 0o600, flag: "wx" });
    return bootstrap;
  }
  function prepare(id: string, credential: string): RuntimeBinding {
    const current = employee(id);
    const generation = current.role === "manager" ? current.generation : current.generation + 1;
    const existing = store.runtimeBindings().find((r) => r.employeeId === id && r.generation === generation);
    if (existing) {
      const manifestPath = join(launchDirectory, `${existing.launchId}.json`);
      const bootstrapPath = join(launchDirectory, `${existing.launchId}.ts`);
      if (!existsSync(manifestPath) || !existsSync(bootstrapPath)) throw new StoreConflictError("Prepared launch artifacts are missing; reconcile this employee before activation");
      return existing;
    }
    const source = profile(current, generation).source;
    const prepared: RuntimeBinding = { employeeId: id, generation, launchId: randomUUID(), credentialDigest: digest(credential), source, paneId: null, terminalId: null, tabId: null, nativeSession: null, state: "prepared", error: null, lastSeen: now(), lastPoll: 0, lastProgress: now(), turnActive: false, stateSequence: null, observedState: null };
    launchFiles(prepared, credential);
    return store.prepareRuntime(prepared);
  }
  function actor(connection: string): Readonly<{ binding: Binding; employee: Employee; runtime: RuntimeBinding }> {
    const session = connections.get(connection);
    if (!session || session.epoch !== store.ownerEpoch) throw new StoreAuthorityError("Employee connection is not admitted in this coordinator epoch");
    const current = employee(session.employeeId);
    const bound = runtime(current.id);
    if (bound.state !== "ready" || bound.generation !== session.generation || current.generation !== session.generation || current.nativeHandle === null)
      throw new StoreFenceError("Employee connection generation is stale or not ready");
    const source = profile(current, current.generation);
    if (encode(source.source) !== encode(bound.source)) throw new StoreFenceError("Canonical source changed; refresh the idle employee explicitly");
    verifyProfile(source);
    return { binding: { employeeId: current.id, generation: current.generation, nativeHandle: current.nativeHandle }, employee: current, runtime: bound };
  }
  function manager(connection: string): ReturnType<typeof actor> {
    const current = actor(connection);
    if (current.employee.role !== "manager") throw new StoreAuthorityError("Only the manager may perform this operation");
    return current;
  }
  function paState(): string | null {
    const pa = store.snapshot().employees.filter((e) => e.role === "pa" && e.employment === "hired");
    if (pa.length !== 1) return "pa-missing";
    const current = pa[0];
    if (!current || current.source === null || current.error !== null) return "pa-not-admitted";
    const bound = runtime(current.id);
    if (bound.state !== "ready" || bound.error !== null || now() - bound.lastPoll > policy.connectionDeadlineMs) return "pa-offline";
    if (!observerAvailable) return "pa-observer-unavailable";
    const outstanding = store.snapshot().messages.find((m) => m.recipient === current.id && m.id.startsWith("pa-check-") && m.status !== "acknowledged");
    if (outstanding) {
      const payload = z.object({ scheduledAt: z.number() }).parse(outstanding.payload);
      if (now() - payload.scheduledAt > policy.progressDeadlineMs) return "pa-overdue";
    }
    return null;
  }
  function currentRuntimes(): readonly RuntimeBinding[] {
    const records = store.runtimeBindings();
    return store.employees().filter((e) => e.employment === "hired").flatMap((e) => {
      const found = records.findLast((r) => r.employeeId === e.id && r.generation >= e.generation);
      return found ? [found] : [];
    });
  }
  function turnAvailable(current: Employee): boolean {
    if (current.role === "manager" || current.role === "pa") return true;
    if (runtime(current.id).turnActive) return true;
    const active = currentRuntimes().filter((r) => r.turnActive && !["manager", "pa"].includes(employee(r.employeeId).role)).length;
    return active < policy.executionLimit - 2;
  }
  function requirePA(): void {
    const blocker = paState();
    if (blocker !== null) throw new StoreAuthorityError(`Mandatory PA supervision is not ready: ${blocker}`);
  }
  function crewBlock(current: Employee): string | null {
    if (current.assignment === null) return null;
    const team = store.getTeam(current.assignment);
    return team && !["ready", "active", "waiting"].includes(team.state) ? `Assigned crew is ${team.state}; complete admission or manager reconciliation is required` : null;
  }
  async function launch(id: string, location: Readonly<{ tabId: string; paneId: string }>): Promise<void> {
    const saved = runtime(id);
    if (saved.state !== "starting" || saved.paneId !== location.paneId) throw new StoreConflictError("Launch requires the recorded pane allocation intent");
    const current = store.updateRuntime({ ...saved, tabId: location.tabId, paneId: location.paneId, state: "starting" });
    const bootstrap = join(launchDirectory, `${current.launchId}.ts`);
    try {
      await herdr.launch({ paneId: location.paneId, name: `s-${current.launchId.replaceAll("-", "").slice(0, 28)}`, args: ["--profile", config.profile, "--no-extensions", "--extension", config.herdrIntegration, "--extension", bootstrap, "--cwd", config.boundRoot] });
      const latest = runtime(id);
      if (latest.state === "uncertain" && latest.error !== null) throw new StoreConflictError(`Startup employee boot failed: ${latest.error}`);
    } catch (error: unknown) {
      const latest = runtime(id);
      if (latest.state !== "ready") store.updateRuntime({ ...latest, state: "uncertain", error: error instanceof Error ? error.message : String(error) });
      store.runtimeAlert({ id: `launch-uncertain-${current.launchId}`, correlation: current.launchId, payload: { kind: "launch-uncertain", employeeId: id, error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }
  async function allocate(id: string, effect: () => Promise<Readonly<{ tabId: string; paneId: string }>>): Promise<Readonly<{ tabId: string; paneId: string }>> {
    const saved = runtime(id);
    if (saved.state !== "prepared") throw new StoreAuthorityError("Existing launch requires identity reconciliation; never blindly create another pane");
    store.updateRuntime({ ...saved, state: "starting", lastSeen: now() });
    try {
      const location = await effect();
      store.updateRuntime({ ...runtime(id), ...location });
      return location;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      store.updateRuntime({ ...runtime(id), state: "uncertain", error: reason });
      store.runtimeAlert({ id: `layout-uncertain-${saved.launchId}`, correlation: saved.launchId, payload: { kind: "layout-uncertain", employeeId: id, error: reason } });
      throw error;
    }
  }
  async function createEmployeeTab(id: string, label: string): Promise<Readonly<{ tabId: string; paneId: string }>> {
    const saved = runtime(id);
    return allocate(id, async () => {
      const tab = await herdr.createCrew({ label, cwd: config.boundRoot, env: { OMPCODE: "", OMP_PROFILE: config.profile, STARTUP_V7_MANIFEST: join(launchDirectory, `${saved.launchId}.json`) } });
      return { tabId: tab.tabId, paneId: tab.rootPaneId };
    });
  }
  async function start(): Promise<void> {
    await herdr.check();
    const observations = await herdr.observe();
    const root = observations.find((o) => o.paneId === config.managerPaneId && o.nativeSession === config.managerFile);
    if (!root) throw new StoreAuthorityError("Manager pane does not report the actual native manager transcript");
    const currentManager = prepare("manager", config.managerCredential);
    if (currentManager.state === "prepared") store.updateRuntime({ ...currentManager, paneId: root.paneId, tabId: root.tabId, terminalId: root.terminalId, nativeSession: root.nativeSession, state: "starting" });
    const paProfile = loadProfile({ skillsRoot: config.skillsRoot, role: "pa", employeeId: "pending", generation: 1 });
    const receipt = store.reserveHire({ authority: { kind: "employee", binding: store.managerBinding }, request: { requestId: "v7-manager-pa", role: "pa", additional: 1, revision: paProfile.source.roleRevision } });
    const pa = receipt.employees[0];
    if (!pa) throw new StoreConflictError("Mandatory PA reservation is missing");
    const saved = store.runtimeBindings().findLast((r) => r.employeeId === pa.id);
    if (saved) return;
    prepare(pa.id, randomBytes(32).toString("hex"));
    await launch(pa.id, await createEmployeeTab(pa.id, `${config.name} manager PA`));
  }
  async function admit(value: Readonly<{ credential: string; nativeSession: string; paneId: string; source: Source }>): Promise<{ connection: string }> {
    const request = admissionSchema.parse(value);
    const saved = store.runtimeBindings().findLast((r) => r.credentialDigest === digest(request.credential));
    if (saved?.state === "abandoned") throw new StoreFenceError("Launch credential was abandoned by explicit manager recovery");
    if (!saved || encode(saved.source) !== encode(request.source)) throw new StoreAuthorityError("Invalid employee admission credential or canonical source");
    const current = employee(saved.employeeId);
    const latest = runtime(current.id);
    if (latest.launchId !== saved.launchId) throw new StoreFenceError("Launch credential belongs to a superseded generation");
    const canonical = profile(current, saved.generation);
    if (encode(canonical.source) !== encode(saved.source)) throw new StoreFenceError("Canonical source changed before admission");
    const observation = (await herdr.observe()).find((o) => o.paneId === request.paneId && o.nativeSession === request.nativeSession);
    if (saved.paneId !== request.paneId || (saved.nativeSession !== null && saved.nativeSession !== request.nativeSession)) throw new StoreAuthorityError("Admission pane or native session does not match the saved launch");
    if (!observation) throw new AdmissionPendingError("The expected pane has not reported its native OMP session yet; no admission was committed");
    if (saved.terminalId !== null && saved.terminalId !== observation.terminalId) throw new StoreAuthorityError("Admission terminal does not match the saved launch");
    const headers = readFileSync(request.nativeSession, "utf8").split("\n").filter((line) => line.trim()).map((line) => z.object({ type: z.string() }).passthrough().parse(JSON.parse(line))).filter((row) => row.type === "session");
    if (headers.length !== 1 || (current.role === "manager" && headers[0]?.id !== config.managerSession)) throw new StoreAuthorityError("Native transcript identity conflicts with employee admission");
    if (current.nativeHandle === null || current.source === null) store.bindEmployee({ manager: store.managerBinding, binding: { employeeId: current.id, generation: saved.generation, nativeHandle: current.role === "manager" ? config.managerSession : `${request.nativeSession}#${saved.generation}`, source: saved.source, assignment: current.assignment } });
    store.updateRuntime({ ...saved, state: "ready", error: null, nativeSession: request.nativeSession, terminalId: observation.terminalId, lastPoll: now(), lastSeen: now() });
    const connection = randomBytes(32).toString("hex");
    connections.set(connection, { employeeId: current.id, generation: saved.generation, epoch: store.ownerEpoch });
    return { connection };
  }
  function launchFailure(value: z.infer<typeof launchFailureSchema>): void {
    const request = launchFailureSchema.parse(value);
    const saved = store.runtimeBindings().findLast((r) => r.credentialDigest === digest(request.credential));
    if (!saved) throw new StoreAuthorityError("Invalid launch failure credential");
    if (saved.state === "abandoned" || runtime(saved.employeeId).launchId !== saved.launchId)
      throw new StoreFenceError("Launch failure belongs to an abandoned or superseded generation");
    const error = request.error.replaceAll(request.credential, "[redacted]");
    if (saved.state !== "ready") store.updateRuntime({ ...saved, state: "uncertain", error });
    const id = `boot-failed-${saved.launchId}-${digest(error).slice(0, 12)}`;
    if (!store.snapshot().messages.some((message) => message.id === id))
      store.runtimeAlert({ id, correlation: saved.launchId, payload: { kind: "boot-failed", employeeId: saved.employeeId, paneId: saved.paneId, error } });
  }
  function scopedInput(current: Employee, inputId: string): Json {
    const snapshot = store.snapshot();
    const received = snapshot.inputs.find((entry) => entry.id === inputId);
    const intake = snapshot.intakes.find((entry) => entry.request.eventId === inputId);
    const team = snapshot.teams.find((entry) => entry.id === intake?.teamId);
    if (current.role !== "manager" && (!team || !["ready", "active", "waiting", "reconciliation"].includes(team.state) || team.id !== current.assignment || ![team.architect, team.qa, ...team.devs].includes(current.id))) throw new StoreAuthorityError("Saved input belongs to another active crew");
    const raw = received?.raw ?? intake?.request.input;
    if (raw === undefined) throw new StoreAuthorityError("Saved input is unavailable");
    return jsonSchema.parse(raw);
  }
  function progress(id: string): void { const current = runtime(id); store.updateRuntime({ ...current, lastProgress: now() }); }
  async function execute(connection: string, value: Json): Promise<Json> {
    const request = commandSchema.parse(value);
    const current = actor(connection);
    const before = encode(store.snapshot());
    let output: unknown;
    switch (request.kind) {
      case "begin_turn": {
        const blocker = crewBlock(current.employee);
        if (blocker !== null) throw new StoreAuthorityError(blocker);
        if (!turnAvailable(current.employee)) throw new StoreAuthorityError("Root execution capacity is reserved for other employees; manager and PA slots remain available");
        store.updateRuntime({ ...current.runtime, turnActive: true }); output = { admitted: true }; break;
      }
      case "end_turn":
        store.updateRuntime({ ...current.runtime, turnActive: false }); output = { released: true }; break;
      case "claim": output = store.claimNext({ employee: current.binding }); break;
      case "settle":
        if (current.employee.role === "pa" && !request.result.outgoing.some((cue) => cue.recipient === "manager" && cue.kind === "report")) throw new StoreAuthorityError("PA check settlement requires a manager report");
        output = store.settleClaim({ employee: current.binding, claimId: request.claimId, result: request.result }); break;
      case "send": output = store.sendCue({ sender: current.binding, cue: request.cue }); break;
      case "capture": output = store.captureIntake({ architect: current.binding, capture: request.capture }); break;
      case "item":
        if ((request.request.action === "decide" && ["MERGED", "DONE"].includes(request.request.status)) || (request.request.action === "gate" && request.request.verdict === "APPROVE")) requirePA();
        output = store.transitionItem({ employee: current.binding, request: request.request }); break;
      case "receive":
        if (current.employee.role === "manager") output = store.receiveInput({ receivedAt: now(), disposition: null, id: request.id, source: request.source, raw: request.raw });
        else output = store.runtimeAlert({ id: `pane-input-${request.id}`, correlation: current.employee.assignment ?? current.employee.id, payload: { kind: "direct-pane-input", employeeId: current.employee.id, source: request.source, raw: request.raw, receivedAt: now() } });
        break;
      case "input": output = inputPage({ inputId: request.inputId, raw: scopedInput(current.employee, request.inputId), offset: request.offset }); break;
      case "image": {
        const image = rawInputSchema.parse(scopedInput(current.employee, request.inputId)).images[request.index];
        if (image === undefined) throw new StoreAuthorityError("Saved image index is unavailable");
        output = imageSchema.parse(image); break;
      }
      case "staff": {
        manager(connection);
        const snapshot = store.snapshot();
        output = { health: paState() ?? "ready", supervision, manager: { id: "manager", pa: snapshot.employees.filter((e) => e.role === "pa"), crews: snapshot.teams.map((team) => ({ id: team.id, eventId: team.eventId, state: team.state, architect: { id: team.architect, qa: team.qa, devs: team.devs }, items: team.items })) }, employees: snapshot.employees.map((e) => ({ id: e.id, role: e.role, assignment: e.assignment, generation: e.generation, error: e.error })), runtime: store.runtimeBindings().map(({ credentialDigest: _credential, ...rest }) => rest), recovery: { claims: snapshot.claims.filter((c) => c.status !== "settled"), grants: snapshot.grants.filter((g) => g.state !== "released"), assignments: snapshot.assignments.filter((a) => a.state !== "complete") }, inputs: snapshot.inputs.map((i) => ({ id: i.id, disposition: i.disposition })), intakes: snapshot.intakes.map((i) => ({ eventId: i.request.eventId, teamId: i.teamId })) }; break;
      }
      case "intake": manager(connection); output = store.recordIntake({ manager: current.binding, event: { eventId: request.eventId, input: request.input, amendItemIds: request.amendItemIds } }); break;
      case "route": manager(connection); output = store.routeInput({ manager: current.binding, inputId: request.inputId, disposition: { kind: request.disposition, reason: request.reason, amendItemIds: request.amendItemIds } }); break;
      case "hire": {
        manager(connection);
        if (request.role === "pa") throw new StoreAuthorityError("The manager has exactly one permanent PA; retry its existing identity");
        const source = loadProfile({ skillsRoot: config.skillsRoot, role: request.role, employeeId: "pending", generation: 1 }).source;
        const receipt = store.reserveHire({ authority: { kind: "employee", binding: current.binding }, request: { requestId: request.requestId, role: request.role, additional: request.additional, revision: source.roleRevision } });
        for (const e of receipt.employees) prepare(e.id, randomBytes(32).toString("hex"));
        output = receipt; break;
      }
      case "delegate": {
        manager(connection); requirePA();
        const saved = store.snapshot().intakes.find((i) => i.request.eventId === request.eventId);
        if (!saved) throw new StoreConflictError("Persist raw intake before delegating a crew");
        store.recordTeamRequirement({ manager: current.binding, request: { eventId: request.eventId, developers: request.developers } });
        if (saved.teamId !== null) { output = store.snapshot().teams.find((t) => t.id === saved.teamId); break; }
        const snapshot = store.snapshot();
        const observations = await herdr.observe();
        const reusable = snapshot.teams.find((team) => team.state === "finished" && team.devs.length === request.developers && [team.architect, team.qa, ...team.devs].every((id) => {
          const current = employee(id);
          const bound = runtime(id);
          return current.assignment === null && current.error === null && bound.state === "ready" && !bound.turnActive && bound.error === null && observations.some((o) => o.nativeSession === bound.nativeSession && o.terminalId === bound.terminalId && o.interactiveReady && ["idle", "done"].includes(o.state)) && !snapshot.messages.some((m) => m.recipient === id && m.status !== "acknowledged") && !snapshot.claims.some((c) => c.employeeId === id && c.status !== "settled") && !snapshot.grants.some((g) => g.employeeId === id && g.state !== "released");
        }));
        const previous = new Map<string, RuntimeBinding>();
        if (reusable) for (const id of [reusable.architect, reusable.qa, ...reusable.devs]) previous.set(id, runtime(id));
        const ids: { architect: string; qa: string; devs: string[] } = reusable ? { architect: reusable.architect, qa: reusable.qa, devs: [...reusable.devs] } : { architect: "", qa: "", devs: [] };
        if (!reusable) for (const role of ["architect", "qa", "dev"] as const) {
          const source = loadProfile({ skillsRoot: config.skillsRoot, role, employeeId: "pending", generation: 1 }).source;
          const receipt = store.reserveHire({ authority: { kind: "employee", binding: current.binding }, request: { requestId: `crew-${request.eventId}-${role}`, role, additional: role === "dev" ? request.developers : 1, revision: source.roleRevision } });
          if (role === "dev") ids.devs = receipt.employees.map((e) => e.id);
          else ids[role] = receipt.employees[0]!.id;
        }
        const members = [ids.architect, ids.qa, ...ids.devs];
        const team = store.reserveTeam({ manager: current.binding, request: { eventId: request.eventId, ...ids, cues: members.map((recipient) => ({ id: `crew-${request.eventId}-${recipient}`, recipient, kind: "assignment", correlation: request.eventId, payload: { kind: recipient === ids.architect ? "architect-intake" : "crew-ready", eventId: request.eventId, supervisor: recipient === ids.architect ? "manager" : ids.architect, raw: inputSummary(request.eventId, saved.request.input) } })) } });
        for (const id of members) {
          const prior = previous.get(id);
          if (!prior) { prepare(id, randomBytes(32).toString("hex")); continue; }
          const manifest = z.object({ credential: idSchema }).parse(JSON.parse(readFileSync(join(launchDirectory, `${prior.launchId}.json`), "utf8")));
          if (digest(manifest.credential) !== prior.credentialDigest) throw new StoreConflictError("Idle crew launch credential conflicts with its saved identity");
          const prepared = prepare(id, manifest.credential);
          store.updateRuntime({ ...prepared, paneId: prior.paneId, terminalId: prior.terminalId, tabId: prior.tabId, nativeSession: prior.nativeSession, state: "starting" });
        }
        if (reusable) {
          const prior = previous.get(ids.architect);
          if (!prior?.tabId) throw new StoreConflictError("Idle crew tab identity is unavailable");
          await herdr.renameCrew({ tabId: prior.tabId, label: `${config.name} crew ${team.id.slice(0, 8)}` });
          output = store.snapshot().teams.find((t) => t.id === team.id);
          break;
        }
        const first = await createEmployeeTab(ids.architect, `${config.name} crew ${team.id.slice(0, 8)}`);
        for (const [index, id] of members.entries()) {
          const bound = runtime(id);
          const location = index === 0 ? first : await allocate(id, async () => ({ tabId: first.tabId, paneId: await herdr.split({ paneId: first.paneId, cwd: config.boundRoot, env: { OMPCODE: "", OMP_PROFILE: config.profile, STARTUP_V7_MANIFEST: join(launchDirectory, `${bound.launchId}.json`) } }) }));
          await launch(id, location);
        }
        output = store.snapshot().teams.find((t) => t.id === team.id); break;
      }
      case "activate": {
        manager(connection);
        for (const id of request.employeeIds) {
          const saved = runtime(id);
          if (saved.state !== "prepared") throw new StoreAuthorityError("Existing launch requires identity reconciliation; never blindly start it again");
          await launch(id, await createEmployeeTab(id, `${config.name} ${employee(id).role}`));
        }
        output = { activated: request.employeeIds }; break;
      }
      case "replace": {
        manager(connection);
        if (request.evidence === null) throw new StoreAuthorityError("Replacement requires explicit manager recovery evidence");
        const replay = store.runtimeAbandonments().findLast((entry) => entry.employeeId === request.employeeId && encode(entry.evidence) === encode(request.evidence));
        if (replay) {
          const pending = runtime(request.employeeId);
          if (pending.launchId === replay.launchId && pending.state === "abandoned") prepare(request.employeeId, randomBytes(32).toString("hex"));
          output = { generation: replay.nextGeneration }; break;
        }
        const previous = runtime(request.employeeId);
        const launchName = `s-${previous.launchId.replaceAll("-", "").slice(0, 28)}`;
        const observed = (await herdr.observe()).some((o) => (previous.nativeSession !== null && o.nativeSession === previous.nativeSession) || (previous.paneId !== null && o.paneId === previous.paneId) || (previous.terminalId !== null && o.terminalId === previous.terminalId) || o.name === launchName);
        if (observed || now() - Math.max(previous.lastPoll, previous.lastSeen) <= policy.connectionDeadlineMs) throw new StoreAuthorityError("Replacement would duplicate a live or recently connected employee; stop and reconcile the original root first, including any unknown shell allocation");
        const target = employee(request.employeeId);
        if (target.nativeHandle === null && target.source === null && previous.generation === target.generation + 1) {
          output = { generation: store.abandonUnadmittedRuntime({ manager: current.binding, employeeId: target.id, launchId: previous.launchId, evidence: request.evidence, verifiedAbsentAt: now(), connectionDeadlineMs: policy.connectionDeadlineMs }) };
        } else {
          output = { generation: store.reserveReplacement({ manager: current.binding, employeeId: request.employeeId, evidence: request.evidence }) };
          store.updateRuntime({ ...previous, turnActive: false, error: "Superseded by an explicit manager recovery", state: "uncertain" });
        }
        prepare(request.employeeId, randomBytes(32).toString("hex")); break;
      }
      case "refresh": {
        manager(connection);
        const e = employee(request.employeeId);
        output = { generation: store.refreshCanonical({ manager: current.binding, employeeId: e.id, source: profile(e, e.generation + 1).source, evidence: request.evidence }) };
        prepare(e.id, randomBytes(32).toString("hex")); break;
      }
      case "reconcile": manager(connection); store.reconcileClaim({ manager: current.binding, claimId: request.claimId, evidence: request.evidence }); output = { reconciled: request.claimId }; break;
      case "resolve": manager(connection); store.resolveAssignment({ manager: current.binding, assignmentId: request.assignmentId, evidence: request.evidence }); output = { resolved: request.assignmentId }; break;
      case "finish": manager(connection); output = store.finishTeam({ manager: current.binding, teamId: request.teamId, evidence: request.evidence }); break;
      case "retire": manager(connection); output = store.retireEmployees({ manager: current.binding, employeeIds: request.employeeIds, evidence: request.evidence }); break;
      case "block": manager(connection); output = store.runtimeAlert({ id: `block-${request.key}-${digest(encode(request.evidence)).slice(0, 12)}`, correlation: request.key, payload: { kind: "reported-blocker", evidence: request.evidence } }); break;
    }
    if (before !== encode(store.snapshot())) progress(current.employee.id);
    return output === undefined ? null : json(output);
  }
  function waitReason(current: Employee, view: ReturnType<StartupStore["employeeView"]>): string | null {
    if (view.claims.length > 0) return "Settle or explicitly reconcile your outstanding claim before ending.";
    if (view.messages.length > 0 && view.team?.state !== "reserved") return "Claim your pending durable inbox before ending.";
    if (current.role !== "manager") return null;
    const snapshot = store.snapshot();
    if (paState() !== null) return `PA supervision is degraded: ${paState()}. Report and recover the existing PA identity.`;
    if (snapshot.inputs.some((i) => i.disposition === null)) return "Classify saved human inputs before ending.";
    if (snapshot.intakes.some((i) => i.teamId === null)) return "Delegate every saved independent work event before ending.";
    try {
      const ready = store.queueItems().find((row) => ["QUEUED", "READY_TO_LAND"].includes(z.string().parse(row.status)));
      return ready ? `Advance ready item ${ready.id} or record its concrete blocker before ending.` : null;
    } catch (error: unknown) {
      return `Canonical queue unavailable; preserve its contents and repair the reported read error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  async function poll(connection: string): Promise<Poll> {
    const current = actor(connection);
    store.updateRuntime({ ...current.runtime, lastPoll: now() });
    const view = store.employeeView(current.employee.id);
    const available = turnAvailable(current.employee);
    const admitted = (!view.team || !["reserved", "reconciliation", "finished"].includes(view.team.state)) && available;
    return { toolBlockReason: crewBlock(current.employee) ?? (view.claims.some((c) => c.status === "reconciliation") || view.grants.length > 0 ? "Reconcile saved uncertain claims and grants through the manager before technical work." : null), projection: `${profileText(profile(current.employee, current.employee.generation))}\nSTARTUP_CHECKPOINT=${encode(current.employee.checkpoint)}\nSTARTUP_TEAM=${encode(view.team)}`, pendingMessageIds: admitted ? view.messages.map((m) => m.id) : [], waitReason: available ? waitReason(current.employee, view) : null };
  }
  function alertOnce(value: Readonly<{ id: string; correlation: string; payload: Json }>): void {
    if (!store.hasMessage(value.id)) store.runtimeAlert(value);
  }
  async function supervise(): Promise<void> {
    store.renewLease();
    supervision = { ...supervision, lastStartedAt: now() };
    const errors: SupervisionFailure[] = [];
    function failure(component: SupervisionFailure["component"], employeeId: string | null, error: unknown): void {
      const detail = (error instanceof Error ? error.message : String(error)).replaceAll(config.managerCredential, "[redacted]");
      errors.push({ component, employeeId, error: detail });
      alertOnce({ id: `supervision-${component}-${employeeId ?? "all"}-${digest(detail).slice(0, 12)}`, correlation: "manager-supervision", payload: { kind: `${component}-unavailable`, employeeId, error: detail, observedAt: now() } });
    }
    let observations: readonly HerdrObservation[] = [];
    try { observations = await herdr.observe(); }
    catch (error: unknown) {
      failure("herdr", null, error);
    }
    observerAvailable = !errors.some((error) => error.component === "herdr");
    for (const saved of currentRuntimes().filter((r) => observerAvailable && r.state === "ready" && r.employeeId !== "manager")) {
      try {
        const observation = observations.find((o) => o.nativeSession === saved.nativeSession && o.terminalId === saved.terminalId);
        if (!observation) {
          errors.push({ component: "observation", employeeId: saved.employeeId, error: "Herdr session not observed" });
          store.updateRuntime({ ...saved, error: "Herdr session not observed" });
          alertOnce({ id: `offline-${saved.launchId}-${saved.stateSequence}`, correlation: saved.launchId, payload: { kind: "employee-offline", employeeId: saved.employeeId, observedAt: now() } });
          continue;
        }
        if (observation.stateSequence < (saved.stateSequence ?? 0)) {
          errors.push({ component: "observation", employeeId: saved.employeeId, error: "Herdr lifecycle sequence regressed; reconcile session identity" });
          store.updateRuntime({ ...saved, error: "Herdr lifecycle sequence regressed; reconcile session identity" });
          alertOnce({ id: `gap-${saved.launchId}-${saved.stateSequence}`, correlation: saved.launchId, payload: { kind: "observation-gap", employeeId: saved.employeeId, observedAt: now() } });
          continue;
        }
        if (saved.error !== null) store.updateRuntime({ ...saved, error: null });
        store.observeRuntime({ employeeId: saved.employeeId, generation: saved.generation, nativeSession: saved.nativeSession!, state: observation.state, sequence: observation.stateSequence, observedAt: now() });
      } catch (error: unknown) { failure("observation", saved.employeeId, error); }
    }
    const managerRuntime = runtime("manager");
    const managerObserved = observations.some((o) => o.nativeSession === managerRuntime.nativeSession && o.terminalId === managerRuntime.terminalId);
    const managerOffline = !managerObserved || now() - managerRuntime.lastPoll > policy.connectionDeadlineMs;
    const snapshot = store.snapshot();
    const pa = snapshot.employees.find((e) => e.role === "pa" && e.employment === "hired");
    if (pa?.source !== null && pa !== undefined) {
      if (managerOffline) {
        const id = `manager-offline-${managerRuntime.launchId}-${managerRuntime.lastPoll}`;
        alertOnce({ id, correlation: "manager-supervision", payload: { kind: "manager-offline", lastPoll: managerRuntime.lastPoll, observedAt: now() } });
        if (!store.hasMessage(`${id}-pa`)) store.sendCue({ sender: store.managerBinding, cue: { id: `${id}-pa`, recipient: pa.id, kind: "duty", correlation: "manager-supervision", payload: { kind: "manager-offline", lastPoll: managerRuntime.lastPoll, observedAt: now() } } });
      }
      const checks = snapshot.messages.filter((m) => m.recipient === pa.id && m.id.startsWith("pa-check-"));
      const outstanding = checks.some((m) => m.status !== "acknowledged");
      const last = checks.at(-1);
      const lastDue = last ? z.object({ scheduledAt: z.number() }).parse(last.payload).scheduledAt : 0;
      if (!outstanding && now() - lastDue >= policy.paCadenceMs) store.sendCue({ sender: store.managerBinding, cue: { id: `pa-check-${runtime(pa.id).launchId}-${now()}`, recipient: pa.id, kind: "duty", correlation: "manager-supervision", payload: { kind: "pa-check", scheduledAt: now(), managerPresence: managerOffline ? "offline" : "online", unclassifiedInputs: snapshot.inputs.filter((i) => i.disposition === null).length, unresolvedClaims: snapshot.claims.filter((c) => c.status !== "settled").length, pendingMessages: snapshot.messages.filter((m) => m.status === "pending").length, crews: snapshot.teams.map((t) => ({ id: t.id, state: t.state })) } } });
    }
    const health = paState();
    if (health !== null) alertOnce({ id: `pa-health-${health}-${pa ? runtime(pa.id).launchId : "missing"}`, correlation: "manager-supervision", payload: { kind: health, observedAt: now() } });
    for (const saved of snapshot.inputs) {
      if (saved.disposition === null && now() - saved.receivedAt > policy.progressDeadlineMs)
        alertOnce({ id: `stale-input-${saved.id}`, correlation: saved.id, payload: { kind: "stale-input", inputId: saved.id, receivedAt: saved.receivedAt } });
    }
    try {
      for (const row of store.queueItems()) {
        if (typeof row.status !== "string" || terminalItemStatuses.includes(row.status) || ["BLOCKED", "NEEDS_DECISION"].includes(row.status)) continue;
        const owner = snapshot.queueRevisions.find((revision) => revision.id === row.id);
        const team = snapshot.teams.find((t) => t.eventId === owner?.eventId);
        if (!team) continue;
        const execution = snapshot.itemExecutions.find((e) => e.itemId === row.id);
        const responsible = row.status === "READY_TO_LAND" ? "manager" : row.status === "EXECUTING" && execution ? execution.employeeId : team.architect;
        if (!owner) continue;
        const progress = store.observeItemProgress({ itemId: row.id, revision: owner.revision, status: row.status, observedAt: now() });
        if (now() - progress.changedAt > policy.progressDeadlineMs) alertOnce({ id: `stale-item-${row.id}-${progress.revision}-${row.status}`, correlation: row.id, payload: { kind: "stale-item", itemId: row.id, state: row.status, responsible, revision: progress.revision, lastProgress: progress.changedAt } });
      }
    } catch (error: unknown) { failure("queue", null, error); }
    const messages = store.snapshot().messages;
    for (const saved of currentRuntimes()) {
      if (["prepared", "starting", "uncertain"].includes(saved.state) && now() - saved.lastSeen > policy.connectionDeadlineMs)
        alertOnce({ id: `launch-stalled-${saved.launchId}`, correlation: saved.launchId, payload: { kind: "launch-stalled", employeeId: saved.employeeId, state: saved.state, error: saved.error, preparedAt: saved.lastSeen } });
      const outstanding = messages.some((m) => m.recipient === saved.employeeId && m.status !== "acknowledged");
      if (outstanding && now() - saved.lastProgress > policy.progressDeadlineMs) alertOnce({ id: `stale-${saved.launchId}-${saved.lastProgress}`, correlation: saved.launchId, payload: { kind: "stale-progress", employeeId: saved.employeeId, lastProgress: saved.lastProgress } });
    }
    const completedAt = now();
    supervision = { ...supervision, lastCompletedAt: completedAt, lastSuccessAt: errors.length === 0 ? completedAt : supervision.lastSuccessAt, errors };
  }
  return {
    start, admit, poll, launchFailure,
    health: () => ({ status: !store.runtimeBindings().some((r) => r.employeeId === "manager" && r.paneId !== null && r.nativeSession !== null) ? "starting" : supervision.errors.length > 0 || now() - (supervision.lastCompletedAt ?? openedAt) > policy.connectionDeadlineMs ? "degraded" : "running", supervision }),
    command(connection, command) {
      const kind = commandSchema.parse(command).kind;
      if (["claim", "begin_turn", "end_turn", "staff", "settle", "send", "item", "capture", "input", "image", "receive"].includes(kind)) return execute(connection, command);
      const operation = serial.then(() => execute(connection, command));
      serial = operation.then(() => undefined, () => undefined);
      return operation;
    },
    tick() {
      if (ticking !== null) return ticking;
      const operation = supervise(); ticking = operation;
      void operation.then(() => { ticking = null; }, () => { ticking = null; });
      return operation;
    },
  };
}

export function serveCoordinator(input: Readonly<{ coordinator: Coordinator; socketPath: string }>): ReturnType<typeof Bun.serve> {
  if (existsSync(input.socketPath)) throw new StoreConflictError("Coordinator socket already exists; reconcile the existing owner");
  const server = Bun.serve({ unix: input.socketPath, async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && path === "/health") { const health = input.coordinator.health(); return Response.json(health, { status: health.status === "running" ? 200 : 503 }); }
      if (request.method === "POST" && path === "/admit") return Response.json(await input.coordinator.admit(admissionSchema.parse(await request.json())));
      if (request.method === "POST" && path === "/launch-failure") {
        input.coordinator.launchFailure(launchFailureSchema.parse(await request.json()));
        return Response.json({ recorded: true });
      }
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) throw new StoreAuthorityError("Employee connection credential is required");
      const connection = authorization.slice(7);
      if (request.method === "GET" && path === "/poll") return Response.json(await input.coordinator.poll(connection));
      if (request.method === "POST" && path === "/command") return Response.json(await input.coordinator.command(connection, jsonSchema.parse(await request.json())));
      return Response.json({ error: "unknown_endpoint" }, { status: 404 });
    } catch (error: unknown) {
      const status = error instanceof AdmissionPendingError ? 425 : error instanceof z.ZodError ? 400 : error instanceof StoreAuthorityError ? 403 : error instanceof StoreConflictError || error instanceof StoreFenceError ? 409 : 500;
      return Response.json({ error: error instanceof Error ? error.constructor.name : "RuntimeError", message: error instanceof Error ? error.message : String(error) }, { status });
    }
  } });
  chmodSync(input.socketPath, 0o600);
  return server;
}
