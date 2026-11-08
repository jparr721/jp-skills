import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { assertStartupPath, ensureStartupRoot, StartupBootError } from "./boot";
import { captureSchema, cueSchema, encode, idSchema, jsonSchema, resultSchema, sourceSchema, StoreAuthorityError, StoreConflictError, StoreFenceError, ClaimSettlementError, type Binding, type Employee, type HostReceipt, type HostStatus, ownerControlRequestSchema, type OwnerControlRequest, type OwnerControlReceipt, type Json, type Source } from "./contracts";
import { openHostSurface } from "./host-surface";
import { inputPage, inputSummary, rawInputSchema, imageSchema } from "./inputs";
import { itemActionSchema, terminalItemStatuses } from "./items";
import { ompModelArgs } from "./model-roles";
import { loadProfile, ompSettingsArgs, profileText, verifyProfile, type Profile } from "./profiles";
import { hostAssociationQuerySchema, type HostAssociationPage, effectiveRoleSettingsSchema, coordinatorPollSchema, nativeRootSchema, ompSessionSettingsReportSchema, runtimeCapabilitySchema, runtimeHarnessSchema, runtimePolicySchema, type NativeRoot, type SavedRoleSettings, type EffectiveRoleSettings, type OmpSessionSettingsReport, type RuntimeBinding, type RuntimeCapability, type RuntimePolicy } from "./runtime-contracts";
import type { StartupStore } from "./store";
import type { HerdrObservation, HerdrRuntime } from "./herdr-runtime";
import type { TernRuntime } from "./tern-runtime";
import { readPreparedManagerSettings } from "./v7-launch";
import { claudeEmployeeArgs, claudeIntegrationPath, requireClaudeTrust, writeClaudeFiles } from "./claude-launch";
import { startWorkflowBridge, type WorkflowBridge } from "./workflow-bridge";
import { createWorkflowBridgeLauncher, WorkflowLaunchUncertainError } from "./workflow-bridge-launch";
import { migrateLegacyStartup, transferCancelledLegacyItem } from "./legacy-migration";
import { requestLegacyHandover } from "./legacy-handover";
import { scanWorktreeWriters } from "./worktree-writers";
import { inspectRepository } from "./repository-identity";
import { OmpReviewRejectedError, OmpRpcStartupError, startOwnedOmpRpc, type ExpectedReview } from "./omp-rpc-supervisor";

type CommonCoordinatorConfig = Readonly<{
  name: string; stateDirectory: string; startupRoot: string; skillsHome: string; boundRoot: string; skillsRoot: string;
  socketPath: string; profile: string;
  managerSession: string; managerFile: string; managerPaneId: string;
  managerCredential: string; policy: RuntimePolicy;
}>;
export type OmpCoordinatorConfig = CommonCoordinatorConfig & Readonly<{ herdrIntegration: string; herdrSession: string }>;
export type ClaudeCoordinatorConfig = (OmpCoordinatorConfig | TernCoordinatorConfig) & Readonly<{ harness: "claude" }>;
export type TernCoordinatorConfig = CommonCoordinatorConfig & Readonly<{ backend: "tern"; ternSession: string; ternBinary: string; ternSocket: string; ternWindow: string; managerPid: number }>;
export type CoordinatorConfig = OmpCoordinatorConfig | TernCoordinatorConfig | ClaudeCoordinatorConfig;
export function isClaudeConfig(config: CoordinatorConfig): config is ClaudeCoordinatorConfig {
  return "harness" in config && config.harness === "claude";
}
const commandSchema = z.union([
  z.strictObject({ kind: z.literal("claim") }),
  z.strictObject({ kind: z.literal("ensure_pa") }),
  z.strictObject({ kind: z.literal("manager_migrate"), migrationId: idSchema }),
  z.strictObject({ kind: z.literal("manager_import_legacy"), migrationId: idSchema, sourceRoot: z.string().startsWith("/") }),
  z.strictObject({ kind: z.literal("manager_transfer_legacy"), migrationId: idSchema, sourceRoot: z.string().startsWith("/"), itemId: idSchema, intentId: idSchema }),
  z.strictObject({ kind: z.literal("manager_request_handover"), migrationId: idSchema, sourceRoot: z.string().startsWith("/"), itemId: idSchema, intentId: idSchema }),
  z.strictObject({ kind: z.literal("manager_run_start"), itemId: idSchema, workflow: z.enum(["pipeline", "hotfix"]), limit: z.number().int().min(1).max(2), target: idSchema, launchKey: idSchema, worktree: z.string().startsWith("/") }),
  z.strictObject({ kind: z.literal("manager_run_list") }),
  z.strictObject({ kind: z.literal("manager_run_inputs"), launchKey: idSchema }),
  z.strictObject({ kind: z.literal("manager_run_send"), launchKey: idSchema, messageId: idSchema, text: z.string().trim().min(1).max(16384) }),
  z.strictObject({ kind: z.literal("manager_run_report"), launchKey: idSchema, state: z.enum(["reported", "failed", "uncertain"]), outcome: jsonSchema }),
  z.strictObject({ kind: z.literal("workflow_context"), itemId: idSchema }),
  z.strictObject({ kind: z.literal("workflow_limit"), itemId: idSchema, limit: z.number().int().min(1).max(3), target: z.string().min(1).max(512) }),
  z.strictObject({ kind: z.literal("workflow_start"), itemId: idSchema, workflow: z.enum(["pipeline", "hotfix"]), limit: z.number().int().min(1).max(3), launchKey: idSchema }),
  z.strictObject({ kind: z.literal("workflow_factory_start"), itemIds: z.array(idSchema).min(1), limit: z.number().int().min(1).max(3), launchKey: idSchema }),
  z.strictObject({ kind: z.literal("begin_turn") }),
  z.strictObject({ kind: z.literal("end_turn") }),
  z.strictObject({ kind: z.literal("staff") }),
  z.strictObject({ kind: z.literal("settle"), claimId: idSchema.optional(), result: resultSchema }),
  z.strictObject({ kind: z.literal("send"), cue: cueSchema }),
  z.strictObject({ kind: z.literal("item"), request: itemActionSchema }),
  z.strictObject({ kind: z.literal("capture"), capture: captureSchema }),
  z.strictObject({ kind: z.literal("hire"), requestId: idSchema, role: z.enum(["architect", "qa", "dev", "devops", "pa"]), additional: z.number().int().positive().safe() }),
  z.strictObject({ kind: z.literal("delegate"), eventId: idSchema, developers: z.number().int().positive().safe() }),
  z.strictObject({ kind: z.literal("activate"), employeeIds: z.array(idSchema).min(1) }),
  z.strictObject({ kind: z.literal("replace"), employeeId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("intake"), eventId: idSchema, input: jsonSchema, amendItemIds: z.array(idSchema) }),
  z.strictObject({ kind: z.literal("route"), inputId: idSchema, disposition: z.enum(["work", "status", "control", "conversation", "decision"]), reason: z.string().min(1), amendItemIds: z.array(idSchema) }),
  z.strictObject({ kind: z.literal("receive_status"), id: idSchema }),
  z.strictObject({ kind: z.literal("receive"), id: idSchema, source: z.enum(["interactive", "rpc"]), raw: z.strictObject({ text: z.string(), images: z.array(jsonSchema) }) }),
  z.strictObject({ kind: z.literal("input"), inputId: idSchema, offset: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("image"), inputId: idSchema, index: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("reconcile"), claimId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("resolve"), assignmentId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("finish"), teamId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("workflow_review"), action: z.literal("reserve"), changeId: idSchema, reservationId: idSchema, head: z.string().trim().min(1), limit: z.number().int().min(1).max(3), reviewerId: idSchema }),
  z.strictObject({ kind: z.literal("workflow_review"), action: z.literal("settle"), reservationId: idSchema, resultId: idSchema }),
  z.strictObject({ kind: z.literal("refresh"), employeeId: idSchema, evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("retire"), employeeIds: z.array(idSchema).min(1), evidence: jsonSchema }),
  z.strictObject({ kind: z.literal("block"), key: idSchema, evidence: jsonSchema }),
]);
const admissionSchema = z.strictObject({ credential: idSchema, nativeSession: idSchema, agentSessionId: idSchema.optional(), paneId: idSchema, pid: z.number().int().positive().safe().optional(), source: sourceSchema });
const launchFailureSchema = z.strictObject({ credential: idSchema, error: z.string().min(1).max(8192) });
type Poll = Readonly<{ toolBlockReason: string | null; projection: string; pendingMessageIds: readonly string[]; waitReason: string | null }>;
type SupervisionFailure = Readonly<{ component: "herdr" | "tern" | "observation" | "queue"; employeeId: string | null; error: string }>;
type CoordinatorHealth = Readonly<{
  status: "starting" | "running" | "degraded";
  readyForAdmission: boolean;
  manager: Readonly<{ connected: boolean; lastPoll: number | null }>;
  supervision: Readonly<{ lastStartedAt: number | null; lastCompletedAt: number | null; lastSuccessAt: number | null; errors: readonly SupervisionFailure[] }>;
}>;
export type Coordinator = Readonly<{
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
  health: () => CoordinatorHealth;
  admit: (input: Readonly<{ credential: string; nativeSession: string; agentSessionId?: string; paneId: string; pid?: number; source: Source }>, signal?: AbortSignal) => Promise<{ connection: string; lifecycleSequence?: number }>;
  revoke: (connection: string) => void;
  launchFailure: (input: z.infer<typeof launchFailureSchema>) => void;
  command: (connection: string, command: Json) => Promise<Json>;
  poll: (connection: string, settingsReport?: OmpSessionSettingsReport, sampleSequence?: number, nativeRoot?: NativeRoot) => Promise<Poll>;
  tick: () => Promise<void>;
  launching: () => Promise<void>;
  hostControl: (request: OwnerControlRequest) => Promise<OwnerControlReceipt>;
  hostSettings: (query: Readonly<{ after: string | null; limit: number }>) => Json;
  hostStatus: (query: unknown) => HostStatus;
  hostAssociations: (query: unknown) => HostAssociationPage;
  hostAdmit: (request: unknown) => Promise<HostReceipt>;
  hostCancel: (request: unknown) => Promise<HostReceipt>;
  hostReceipt: (id: string) => HostReceipt;
}>;
class AdmissionPendingError extends Error {}
class AdmissionRevokedError extends StoreFenceError {}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): Json { return jsonSchema.parse(JSON.parse(JSON.stringify(value))); }

export function openCoordinator(input: Readonly<{ store: StartupStore; config: CoordinatorConfig; now: () => number; managerRpc?: typeof startOwnedOmpRpc; writerScan?: typeof scanWorktreeWriters } & ({ herdr: HerdrRuntime; tern?: never } | { tern: TernRuntime; herdr?: never })>): Coordinator {
  const { store, config, now } = input;
  const herdr = input.herdr;
  const tern = input.tern;
  if (("backend" in config) !== (tern !== undefined)) throw new StartupBootError("Runtime backend does not match coordinator configuration");
  if (tern !== undefined && isClaudeConfig(config)) throw new StartupBootError("Tern requires the native OMP lifecycle bridge");
  const root: string = ensureStartupRoot(config.startupRoot);
  if (root !== config.startupRoot || config.stateDirectory !== root)
    throw new StartupBootError("Coordinator requires the canonical Startup root");
  assertStartupPath(root, config.socketPath, "socket");
  const claude: ClaudeCoordinatorConfig | null = isClaudeConfig(config) ? config : null;
  const managerHarness: "omp" | "claude" = claude === null ? "omp" : "claude";
  let claudeFiles: ReturnType<typeof writeClaudeFiles> | null = null;
  const policy = runtimePolicySchema.parse(config.policy);
  const connections = new Map<string, Readonly<{ employeeId: string; generation: number; epoch: number; launchId: string; nativeSession: string; connectionEpoch: string; agentSessionId: string | null; pid: number | null; paneId: string }>>();
  const workflowBridges = new Map<string, Set<WorkflowBridge>>();
  const managerProcesses = new Map<string, Awaited<ReturnType<typeof startOwnedOmpRpc>>>();
  const managerExits = new Set<Promise<unknown>>();
  const scanningWorktrees = new Set<string>();
  const nextWorktreeScan = new Map<string, number>();
  function reconcileExitedRun(launchKey: string, location: Json): void {
    if (scanningWorktrees.has(launchKey) || (nextWorktreeScan.get(launchKey) ?? 0) > now()) return;
    scanningWorktrees.add(launchKey);
    nextWorktreeScan.set(launchKey, now() + 5000);
    const operation = (async () => {
      const run = store.managerRuns().find((entry) => entry.launchKey === launchKey);
      if (!run || run.termination || !["uncertain", "failed", "completed"].includes(run.state) || encode(run.location) !== encode(location)) return;
      const scan = await (input.writerScan ?? scanWorktreeWriters)(run.worktree);
      if (scan.status === "observed" && scan.writers.length) {
        const alertId = `worktree-writers-${digest(launchKey)}`;
        if (!store.hasMessage(alertId)) store.runtimeAlert({ id: alertId, correlation: launchKey, payload: json({ kind: "worktree-writers", itemId: run.itemId, worktree: run.worktree, writers: scan.writers }) });
        return;
      }
      if (scan.status === "unavailable") {
        process.stderr.write(JSON.stringify({ level: "warn", component: "worktree-writer-scan", launchKey, itemId: run.itemId, worktree: run.worktree, reason: scan.reason }) + "\n");
      }
      await store.releaseManagerRun({ manager: store.managerBinding, launchKey, verify: async (original) => {
        if (encode(original.location) !== encode(location)) throw new StoreFenceError("Original OMP process location changed");
        return { launchKey: original.launchKey, itemId: original.itemId, location, status: "terminated", evidence: scan.status === "observed" ? "Original OMP process exited and no open worktree write handles were observed" : "Original OMP process exited; worktree writer scan was unavailable" };
      } });
      nextWorktreeScan.delete(launchKey);
    })();
    managerExits.add(operation);
    void operation.catch((error: unknown) => process.stderr.write(JSON.stringify({ level: "warn", component: "manager-process-reconcile", launchKey, error: error instanceof Error ? error.message : String(error) }) + "\n")).finally(() => { managerExits.delete(operation); scanningWorktrees.delete(launchKey); });
  }
  const admissionAttempts = new Map<string, string>();
  function revoke(connection: string): void {
    const current = connections.get(connection);
    connections.delete(connection);
    const bridges = workflowBridges.get(connection);
    workflowBridges.delete(connection);
    if (bridges) for (const bridge of bridges) void bridge.close();
    if (current !== undefined) {
      try {
        store.invalidateWorkflowEmployee({ employeeId: current.employeeId, generation: current.generation });
        store.revokeRuntimeConnection(current.launchId, current.connectionEpoch);
      }
      catch (error: unknown) {
        if (!(error instanceof StoreFenceError)) throw error;
        process.stderr.write(JSON.stringify({ level: "warn", component: "startup-connection-revocation", reason: "owner-already-fenced", error: error.message }) + "\n");
      }
    }
  }
  let serial: Promise<void> = Promise.resolve();
  let ticking: Promise<void> | null = null;
  let launches: Promise<void> = Promise.resolve();
  const launchingIds = new Set<string>();
  const openedAt = now();
  let supervision: CoordinatorHealth["supervision"] = { lastStartedAt: null, lastCompletedAt: null, lastSuccessAt: null, errors: [] };
  let observerAvailable: boolean = true;
  const launchDirectory = join(root, "launches");
  assertStartupPath(root, launchDirectory, "directory");
  if (existsSync(launchDirectory) && (lstatSync(launchDirectory).isSymbolicLink() || !lstatSync(launchDirectory).isDirectory() || (lstatSync(launchDirectory).mode & 0o077) !== 0))
    throw new StoreAuthorityError("Launch directory must be a private Startup-owned directory");
  mkdirSync(launchDirectory, { recursive: true, mode: 0o700 });
  assertStartupPath(root, launchDirectory, "directory");
  function employee(id: string): Employee {
    return store.getEmployee(id);
  }
  function runtime(id: string): RuntimeBinding {
    const current = employee(id);
    const found = store.employeeRuntime(id, current.generation);
    if (!found) throw new StoreAuthorityError(`Employee ${id} has no prepared runtime`);
    return found;
  }
  function profile(current: Employee, generation: number): Profile {
    return loadProfile({ skillsRoot: config.skillsRoot, role: current.role, employeeId: current.id, generation });
  }
  function launchArtifact(current: RuntimeBinding): string {
    return join(launchDirectory, `${current.launchId}${current.settings.requested.harness === "omp" ? ".ts" : ".prompt.md"}`);
  }
  function launchFiles(current: RuntimeBinding, credential: string): void {
    const harness = runtimeHarnessSchema.parse(current.settings.requested.harness);
    const path = join(launchDirectory, `${current.launchId}.json`);
    assertStartupPath(root, path, "file");
    const manifest = encode({ socketPath: config.socketPath, credential, source: current.source, employeeId: current.employeeId, generation: current.generation, profile: config.profile, harness, skillsHome: config.skillsHome, startupRoot: config.startupRoot, skillsRoot: config.skillsRoot, ...(tern === undefined ? {} : { backend: "tern" }) });
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink() || readFileSync(path, "utf8") !== manifest)
        throw new StoreConflictError("Launch manifest ownership conflicts with its reserved generation");
    } else writeFileSync(path, manifest, { mode: 0o600, flag: "wx" });
    const bootstrap = launchArtifact(current);
    assertStartupPath(root, bootstrap, "file");
    const content = harness === "claude" ? profileText(profile(employee(current.employeeId), current.generation)) : `import { installLaunchedEmployee } from ${JSON.stringify(join(config.skillsRoot, "extensions/startup/src/employee-entry.ts"))};\nimport type { HostAPI } from ${JSON.stringify(join(config.skillsRoot, "extensions/startup/index.ts"))};\nexport default (host: HostAPI): void => installLaunchedEmployee(host, ${JSON.stringify(path)});\n`;
    if (existsSync(bootstrap)) {
      if (lstatSync(bootstrap).isSymbolicLink() || readFileSync(bootstrap, "utf8") !== content)
        throw new StoreConflictError("Launch bootstrap ownership conflicts with its reserved generation");
    } else writeFileSync(bootstrap, content, { mode: 0o600, flag: "wx" });
  }
  function claudeRuntimeFiles(): ReturnType<typeof writeClaudeFiles> {
    if (claudeFiles === null) claudeFiles = writeClaudeFiles({ startupRoot: config.startupRoot, skillsRoot: config.skillsRoot, bun: process.execPath });
    return claudeFiles;
  }
  function assertLaunchReadiness(settings: SavedRoleSettings): void {
    if (tern !== undefined && settings.requested.harness !== "omp") throw new StoreAuthorityError("Tern requires the native OMP lifecycle bridge");
    if (settings.requested.harness !== "claude") return;
    requireClaudeTrust({ startupRoot: config.startupRoot, boundRoot: config.boundRoot, claudeJson: join(config.startupRoot, ".claude.json") });
    claudeIntegrationPath({ CLAUDE_CONFIG_DIR: config.startupRoot });
  }
  function prepare(id: string, credential: string): RuntimeBinding {
    const current = employee(id);
    const generation = current.role === "manager" ? current.generation : current.generation + 1;
    const existing = store.runtimeBindings().find((r) => r.employeeId === id && r.generation === generation);
    if (existing) {
      if (encode(profile(current, generation).source) !== encode(existing.source))
        throw new StoreFenceError("Saved launch source differs from the current canonical source; preserve the existing Startup and reconcile the native generation before reuse. No source receipt was rewritten.");
      const manifestPath = join(launchDirectory, `${existing.launchId}.json`);
      const bootstrapPath = launchArtifact(existing);
      if (!existsSync(manifestPath) || !existsSync(bootstrapPath)) throw new StoreConflictError("Prepared launch artifacts are missing; reconcile this employee before activation");
      return existing;
    }
    const source = profile(current, generation).source;
    const selected = store.roleSettings(current.role);
    const frozen = current.role === "manager" ? readPreparedManagerSettings(store.scope) : null;
    if (current.role === "manager" && frozen === null && (selected.revision !== 0 || selected.requested.model.value !== null || selected.requested.effort.value !== null)) throw new StoreConflictError("Manager settings require prepareManagerLaunch before a genuinely new native process; existing sessions cannot adopt saved settings");
    const prepared: RuntimeBinding = { employeeId: id, generation, launchId: randomUUID(), credentialDigest: digest(credential), source, settings: frozen ?? selected, paneId: null, terminalId: null, tabId: null, nativeSession: null, state: "prepared", error: null, lastSeen: now(), lastPoll: 0, lastProgress: now(), turnActive: false, stateSequence: null, observedState: null };
    launchFiles(prepared, credential);
    return store.prepareRuntime(prepared);
  }
  function actor(connection: string): Readonly<{ binding: Binding; employee: Employee; runtime: RuntimeBinding }> {
    const session = connections.get(connection);
    if (!session || session.epoch !== store.ownerEpoch) throw new AdmissionRevokedError("Employee connection is not admitted in this coordinator epoch");
    try { store.assertRuntimeConnection(session.launchId, session.connectionEpoch); }
    catch (error: unknown) { if (error instanceof StoreFenceError) throw new AdmissionRevokedError(error.message); throw error; }
    const current = employee(session.employeeId);
    if (current.employment !== "hired") throw new StoreAuthorityError("Employee is retired; its native root must stop and cannot resume technical work");
    const bound = runtime(current.id);
    if (now() - bound.lastPoll > policy.connectionDeadlineMs) { revoke(connection); throw new AdmissionRevokedError("Employee connection expired; explicit re-admission required"); }
    if (bound.launchId !== session.launchId || bound.nativeSession !== session.nativeSession || bound.state !== "ready" || bound.generation !== session.generation || current.generation !== session.generation || current.nativeHandle === null)
      throw new StoreFenceError("Employee connection generation is stale or not ready");
    const source = profile(current, current.generation);
    if (encode(source.source) !== encode(bound.source)) throw new StoreFenceError("Canonical source changed; refresh the idle employee explicitly");
    verifyProfile(source);
    return { binding: { employeeId: current.id, generation: current.generation, nativeHandle: current.nativeHandle }, employee: current, runtime: bound };
  }
  async function verifiedActor(connection: string): Promise<Readonly<{ binding: Binding; employee: Employee; runtime: RuntimeBinding }>> {
    const current = actor(connection);
    if (tern === undefined) return current;
    const admitted = connections.get(connection);
    if (!admitted || admitted.pid === null || current.runtime.paneId !== admitted.paneId ||
        !await tern.ownsProcess({ blockId: admitted.paneId, pid: admitted.pid })) {
      revoke(connection);
      throw new AdmissionRevokedError("Tern native process is no longer owned by its reserved pane");
    }
    return actor(connection);
  }
  function manager(connection: string): ReturnType<typeof actor> {
    const current = actor(connection);
    if (current.employee.role !== "manager") throw new StoreAuthorityError("Only the manager may perform this operation");
    return current;
  }
  function paState(): string | null {
    const pa = store.employees().filter((e) => e.role === "pa" && e.employment === "hired");
    if (pa.length === 0) return null;
    if (pa.length !== 1) return "pa-missing";
    const current = pa[0];
    if (!current || current.source === null || current.error !== null) return "pa-not-admitted";
    const bound = runtime(current.id);
    if (bound.state !== "ready" || bound.error !== null || now() - bound.lastPoll > policy.connectionDeadlineMs) return "pa-offline";
    if (!observerAvailable) return "pa-observer-unavailable";
    const outstanding = store.outstandingMessages(current.id).find((m) => m.id.startsWith("pa-check-"));
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
    return active < policy.executionLimit - 1;
  }
  function crewBlock(current: Employee): string | null {
    if (current.assignment === null) return null;
    const team = store.getTeam(current.assignment);
    return team && !["ready", "active", "waiting"].includes(team.state) ? `Assigned crew is ${team.state}; complete admission or manager reconciliation is required` : null;
  }
  async function launch(id: string, location: Readonly<{ tabId: string; paneId: string }>): Promise<void> {
    const saved = runtime(id);
    if (tern !== undefined && saved.paneId === location.paneId && (saved.state === "starting" || saved.state === "ready")) return;
    if (saved.state !== "starting" || saved.paneId !== location.paneId) throw new StoreConflictError("Launch requires the recorded pane allocation intent");
    assertLaunchReadiness(saved.settings);
    const harness = saved.settings.requested.harness;
    const current = store.updateRuntime({ ...saved, tabId: location.tabId, paneId: location.paneId, state: "starting", ...(harness === "claude" ? { nativeSession: saved.launchId } : {}) });
    const bootstrap = launchArtifact(current);
    const name = `s-${current.launchId.replaceAll("-", "").slice(0, 28)}`;
    try {
      const selected = current.settings.requested;
      const args = harness === "omp"
        ? ["--no-extensions", "--extension", ("herdrIntegration" in config ? config.herdrIntegration : ""), "--extension", bootstrap, "--cwd", config.boundRoot, ...(selected.model.value === null && selected.role !== "pa" ? ompModelArgs(selected.role) : []), ...ompSettingsArgs(current.settings)]
        : (() => {
          const files = claudeRuntimeFiles();
          return claudeEmployeeArgs({ sessionId: current.launchId, promptFile: bootstrap, settingsFile: files.settingsFile, mcpFile: files.mcpFile, name, model: selected.model.value, effort: selected.effort.value });
        })();
      await herdr!.launch({ harness, paneId: location.paneId, name, args });
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
    assertLaunchReadiness(saved.settings);
    try {
      return await store.dispatchRuntimeAllocation(saved, async () => {
        const location = await effect();
        store.updateRuntime({ ...runtime(id), ...location });
        return location;
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      store.updateRuntime({ ...runtime(id), state: "uncertain", error: reason });
      store.runtimeAlert({ id: `layout-uncertain-${saved.launchId}`, correlation: saved.launchId, payload: { kind: "layout-uncertain", employeeId: id, error: reason } });
      throw error;
    }
  }
  function assertNotLaunching(ids: readonly string[]): void {
    const busy = ids.filter((id) => launchingIds.has(id));
    if (busy.length > 0) throw new StoreConflictError(`Employees ${busy.join(", ")} are already launching; follow progress through startup_staff and launch alerts`);
  }
  // Pane launches wait for native readiness, so they run after the durable receipt returns, one at a time per coordinator.
  function launchInBackground(ids: readonly string[], step: (id: string) => Promise<void>): void {
    assertNotLaunching(ids);
    for (const id of ids) assertLaunchReadiness(runtime(id).settings);
    for (const id of ids) launchingIds.add(id);
    launches = launches.then(async () => {
      let index = 0;
      try {
        for (; index < ids.length; index += 1) await step(ids[index]!);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        alertOnce({ id: `launch-interrupted-${digest(encode({ ids, index, reason })).slice(0, 32)}`, correlation: ids[index]!, payload: { kind: "launch-interrupted", failedEmployeeId: ids[index]!, unlaunchedEmployeeIds: ids.slice(index + 1), error: reason, observedAt: now() } });
      } finally {
        for (const id of ids) launchingIds.delete(id);
      }
    });
  }
  function paneEnvironment(current: RuntimeBinding): Readonly<Record<string, string>> {
    const manifest = join(launchDirectory, `${current.launchId}.json`);
    assertStartupPath(root, manifest, "file");
    const base: Readonly<Record<string, string>> = { JP_SKILLS_HOME: config.skillsHome, STARTUP_ROOT: config.startupRoot, STARTUP_V7_MANIFEST: manifest };
    return current.settings.requested.harness === "omp"
      ? { ...base, OMPCODE: "", OMP_PROFILE: config.profile, ...("herdrIntegration" in config ? { STARTUP_HERDR_OMP_EXTENSION: config.herdrIntegration } : {}) }
      : { ...base, CLAUDE_CONFIG_DIR: config.startupRoot };
  }
  function ternArgv(saved: RuntimeBinding): string[] {
    assertLaunchReadiness(saved.settings);
    const selected = saved.settings.requested;
    return ["/usr/bin/env", ...Object.entries(paneEnvironment(saved)).map(([key, value]) => `${key}=${value}`),
      "omp", "--no-extensions", "--extension", launchArtifact(saved), "--cwd", config.boundRoot,
      ...(selected.model.value === null && selected.role !== "pa" ? ompModelArgs(selected.role) : []), ...ompSettingsArgs(saved.settings)];
  }
  async function createEmployeeTab(id: string, label: string): Promise<Readonly<{ tabId: string; paneId: string }>> {
    const saved = runtime(id);
    return allocate(id, async () => {
      if (tern !== undefined) {
        const location = await tern.createTab({ cwd: config.boundRoot, argv: ternArgv(saved) });
        return { tabId: location.tabId, paneId: location.blockId };
      }
      const tab = await herdr!.createCrew({ label, cwd: config.boundRoot, env: paneEnvironment(saved) });
      return { tabId: tab.tabId, paneId: tab.rootPaneId };
    });
  }
  async function start(): Promise<void> {
    let managerLocation: Readonly<{ paneId: string; tabId: string | null; terminalId: string; nativeSession: string }>;
    if (tern !== undefined && "backend" in config) {
      await tern.check();
      if (!await tern.ownsProcess({ blockId: config.managerPaneId, pid: config.managerPid })) throw new StoreAuthorityError("Manager process is not owned by its Tern pane");
      managerLocation = { paneId: config.managerPaneId, tabId: null, terminalId: config.managerPaneId, nativeSession: config.managerFile };
    } else {
      await herdr!.check();
      const observations = await herdr!.observe();
      const observed = observations.find((o) => o.paneId === config.managerPaneId && o.nativeSession === (managerHarness === "omp" ? config.managerFile : config.managerSession) && o.harness === managerHarness);
      if (!observed) throw new StoreAuthorityError(managerHarness === "omp" ? "Manager pane does not report the actual native OMP manager transcript" : "Manager pane does not report the actual native Claude manager session");
      managerLocation = { paneId: observed.paneId, tabId: observed.tabId, terminalId: observed.terminalId, nativeSession: managerHarness === "omp" ? config.managerFile : config.managerSession };
    }
    store.initializeRoleSettings(managerHarness);
    store.compactRuntimeObservations();
    const currentManager = prepare("manager", config.managerCredential);
    if (currentManager.settings.requested.harness !== managerHarness) throw new StoreConflictError("The saved manager launch harness differs from its active native session; start a new manager session to apply that future-launch setting");
    if (managerHarness === "claude") claudeRuntimeFiles();
    if (currentManager.state === "prepared") store.updateRuntime({ ...currentManager, ...managerLocation, state: "starting" });

  }
  async function admit(value: Readonly<{ credential: string; nativeSession: string; agentSessionId?: string; paneId: string; pid?: number; source: Source }>, signal?: AbortSignal): Promise<{ connection: string; lifecycleSequence?: number }> {
    const request = admissionSchema.parse(value);
    const saved = store.runtimeBindings().findLast((r) => r.credentialDigest === digest(request.credential));
    if (saved?.state === "abandoned") throw new StoreFenceError("Launch credential was abandoned by explicit manager recovery");
    if (!saved || encode(saved.source) !== encode(request.source)) throw new StoreAuthorityError("Invalid employee admission credential or canonical source");
    const current = employee(saved.employeeId);
    const latest = runtime(current.id);
    if (latest.launchId !== saved.launchId) throw new StoreFenceError("Launch credential belongs to a superseded generation");
    const canonical = profile(current, saved.generation);
    if (encode(canonical.source) !== encode(saved.source)) throw new StoreFenceError("Canonical source changed before admission");
    const attempt = randomUUID();
    admissionAttempts.set(saved.launchId, attempt);
    const harness = saved.settings.requested.harness;
    if (tern !== undefined && saved.state === "starting" && saved.paneId === null) throw new AdmissionPendingError("Tern allocation is not committed yet");
    if (tern !== undefined && (saved.state !== "starting" && saved.state !== "ready")) throw new StoreFenceError("Tern launch is not eligible for admission");
    if (tern !== undefined && (request.pid === undefined || request.agentSessionId === undefined)) throw new StoreAuthorityError("Tern admission requires the native process and session identity");
    const observation = tern === undefined ? (await herdr!.observe()).find((o) => o.paneId === request.paneId && o.nativeSession === request.nativeSession && o.harness === harness) : null;
    const owned = tern === undefined ? false : await tern.ownsProcess({ blockId: request.paneId, pid: request.pid! });
    if (signal?.aborted) throw new StoreFenceError("Admission channel disconnected before commit");
    if (admissionAttempts.get(saved.launchId) !== attempt) throw new StoreFenceError("A newer admission superseded this admission attempt");
    if (employee(saved.employeeId).employment !== "hired" || runtime(saved.employeeId).launchId !== saved.launchId) throw new StoreFenceError("Launch changed during admission");
    if (tern !== undefined) {
      const live = runtime(saved.employeeId);
      if ((live.state !== "starting" && live.state !== "ready") || live.paneId !== request.paneId || (live.nativeSession !== null && live.nativeSession !== request.nativeSession))
        throw new StoreFenceError("Tern launch changed during process verification");
    }
    if (saved.paneId !== request.paneId || (saved.nativeSession !== null && saved.nativeSession !== request.nativeSession)) throw new StoreAuthorityError("Admission pane or native session does not match the saved launch");
    if (tern !== undefined && !owned) throw new StoreAuthorityError("Native process is not owned by the reserved Tern pane");
    if (tern === undefined && !observation) throw new AdmissionPendingError(`The expected pane has not reported its native ${harness === "omp" ? "OMP" : "Claude"} session yet; no admission was committed`);
    const terminalId = tern !== undefined ? request.paneId : observation!.terminalId;
    if (saved.terminalId !== null && saved.terminalId !== terminalId) throw new StoreAuthorityError("Admission terminal does not match the saved launch");
    if (tern !== undefined && current.role === "manager" && "backend" in config && (request.pid !== config.managerPid || request.nativeSession !== config.managerFile || request.agentSessionId !== config.managerSession)) throw new StoreAuthorityError("Tern manager native identity conflicts with the configured manager");
    if (harness === "claude") {
      if (request.nativeSession !== (current.role === "manager" ? config.managerSession : saved.nativeSession)) throw new StoreAuthorityError("Native Claude session conflicts with employee admission");
    } else {
      const headers = readFileSync(request.nativeSession, "utf8").split("\n").filter((line) => line.trim()).map((line) => z.object({ type: z.string() }).passthrough().parse(JSON.parse(line))).filter((row) => row.type === "session");
      if (headers.length !== 1 || (request.agentSessionId !== undefined && headers[0]?.id !== request.agentSessionId) || (current.role === "manager" && headers[0]?.id !== config.managerSession)) throw new StoreAuthorityError("Native transcript identity conflicts with employee admission");
    }
    if (current.nativeHandle === null || current.source === null) store.bindEmployee({ manager: store.managerBinding, binding: { employeeId: current.id, generation: saved.generation, nativeHandle: current.role === "manager" ? config.managerSession : `${request.nativeSession}#${saved.generation}`, source: saved.source, assignment: current.assignment } });
    const latestRuntime = runtime(current.id);
    if (latestRuntime.launchId !== saved.launchId || latestRuntime.state === "abandoned") throw new StoreFenceError("Launch was superseded during native admission");
    for (const [token, prior] of connections) if (prior.employeeId === current.id) revoke(token);
    store.updateRuntime({ ...latestRuntime, state: "ready", error: null, nativeSession: request.nativeSession, terminalId, lastPoll: now(), lastSeen: now() });
    const connection = randomBytes(32).toString("hex");
    connections.set(connection, { employeeId: current.id, generation: saved.generation, epoch: store.ownerEpoch, launchId: saved.launchId, nativeSession: request.nativeSession, connectionEpoch: randomUUID(), agentSessionId: request.agentSessionId ?? null, pid: request.pid ?? null, paneId: request.paneId });
    const live = connections.get(connection)!;
    store.admitRuntimeConnection({ startupRoot: root, harness, ownerId: store.ownerId, ownerEpoch: store.ownerEpoch, employeeId: current.id, generation: saved.generation, launchId: saved.launchId, nativeSession: request.nativeSession, agentSessionId: live.agentSessionId, connectionEpoch: live.connectionEpoch });
    return tern === undefined ? { connection } : { connection, lifecycleSequence: latestRuntime.stateSequence ?? 0 };
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
  function workflowBridgeOptions(authority: Parameters<typeof startWorkflowBridge>[0] & { finishTarget(scopeId: string, itemId: string): string | null }): Parameters<typeof startWorkflowBridge>[1] {
    const evidence = {
      architect: z.strictObject({ findings: z.string().min(1), decision: z.string().min(1) }),
      dev: z.strictObject({ implementation: z.string().min(1), artifact: z.string().min(1) }),
      qa: z.strictObject({ method: z.string().min(1), result: z.string().min(1), artifact: z.string().min(1) }),
    };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const canonicalWorktree = (path: string): string => {
      const cwd = realpathSync(path);
      if (realpathSync(git(cwd, "rev-parse", "--show-toplevel")) !== cwd ||
          realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir"))) !== realpathSync(resolve(config.boundRoot, git(config.boundRoot, "rev-parse", "--git-common-dir"))))
        throw new StoreAuthorityError("Workflow worktree is outside the bound repository");
      return cwd;
    };
    const verifyReady = (scopeId: string, item: { itemId: string; worktree: string; head: string; prNumber: number }): boolean => {
      const target = authority.finishTarget(scopeId, item.itemId);
      const cwd = canonicalWorktree(item.worktree);
      if (target === null || cwd !== item.worktree || git(cwd, "rev-parse", "HEAD") !== item.head || git(cwd, "status", "--porcelain") !== "") return false;
      const pr = z.object({ headRefOid: z.string(), baseRefName: z.string(), state: z.string(), isDraft: z.boolean() }).parse(JSON.parse(execFileSync("gh", ["pr", "view", String(item.prNumber), "--json", "headRefOid,baseRefName,state,isDraft"], { cwd, encoding: "utf8" })));
      return pr.headRefOid === item.head && pr.baseRefName === target && pr.state === "OPEN" && !pr.isDraft;
    };
    return {
      acceptBoundHostReceipts: true,
      validateRoleAssignment: async ({ scopeId, itemId, role }) => {
        try {
          const view = authority.view(scopeId);
          return view.scope.kind === "bounded" && view.scope.itemIds.includes(itemId) &&
            (view.workflow !== "hotfix" || role.kind === "dev") && canonicalWorktree(role.worktree) === role.worktree;
        } catch { return false; }
      },
      validateRole: async ({ itemId, proof }) => {
        try {
          if (proof.itemId !== itemId || canonicalWorktree(proof.worktree) !== proof.worktree || !evidence[proof.role].safeParse(proof.evidence).success) return false;
          return git(proof.worktree, "rev-parse", "HEAD") === proof.head;
        } catch { return false; }
      },
      validatePlan: async ({ scopeId, plan }) => {
        try {
          const view = authority.view(scopeId);
          return view.scope.kind === "bounded" && Object.keys(plan.targets).length === view.scope.itemIds.length &&
            view.scope.itemIds.every((itemId) => {
              const target = authority.finishTarget(scopeId, itemId);
              return target !== null && plan.targets[itemId]?.length === 1 && plan.targets[itemId]?.[0] === target;
            });
        } catch { return false; }
      },
      validateReady: async (scopeId, item) => {
        try { return verifyReady(scopeId, item); } catch { return false; }
      },
      nestScope: (parentId, workflow, itemIds, limit, target) => {
        if (target !== undefined && itemIds.some((id) => authority.finishTarget(parentId, id) !== target))
          throw new StoreAuthorityError("Nested target differs from manager-frozen item target");
        return authority.nest(parentId, workflow, itemIds, limit);
      },
      validateFinish: async (scopeId, handoff) => {
        try {
          return handoff.items.every((item) => verifyReady(scopeId, item));
        } catch { return false; }
      },
    };
  }
  function progress(id: string): void { const current = runtime(id); store.updateRuntime({ ...current, lastProgress: now() }); }
  async function execute(connection: string, value: Json): Promise<Json> {
    const request = commandSchema.parse(value);
    const current = tern === undefined ? actor(connection) : await verifiedActor(connection);
    const workflowCommand = request.kind === "workflow_context" || request.kind === "workflow_limit" || request.kind === "workflow_start" || request.kind === "workflow_factory_start" || request.kind === "workflow_review";
    const before = request.kind === "begin_turn" || request.kind === "end_turn" || workflowCommand ? null : encode(store.snapshot());
    let output: unknown;
    switch (request.kind) {
      case "begin_turn": {
        const blocker = crewBlock(current.employee);
        if (blocker !== null) throw new StoreAuthorityError(blocker);
        if (!turnAvailable(current.employee)) throw new StoreAuthorityError("Root execution capacity is reserved for other work; the manager slot remains available");
        store.updateRuntime({ ...current.runtime, turnActive: true }); output = { admitted: true }; break;
      }
      case "workflow_context": {
        if (tern === undefined) {
          const observed = await herdr!.observe();
          const admitted = connections.get(connection);
          if (!admitted || !observed.some((entry) => entry.paneId === admitted.paneId && entry.nativeSession === admitted.nativeSession && entry.harness === current.runtime.settings.requested.harness))
            throw new StoreFenceError("Bounded context requires the current observed native pane and session");
          actor(connection);
        }
        output = { ...store.workflowContext({ employee: current.binding, itemId: request.itemId }), launchId: current.runtime.launchId, nativeSession: current.runtime.nativeSession };
        break;
      }
      case "workflow_limit":
        manager(connection);
        execFileSync("git", ["check-ref-format", "--branch", request.target], { cwd: config.boundRoot, stdio: "ignore" });
        output = { itemId: request.itemId, limit: store.setWorkflowLimit({ manager: current.binding, itemId: request.itemId, limit: request.limit, target: request.target }), target: request.target };
        break;
      case "workflow_start": {
        if (current.runtime.paneId === null) throw new StoreFenceError("Parent native pane is unavailable");
        if (tern === undefined) {
          const observed = await herdr!.observe();
          const admitted = connections.get(connection);
          if (!admitted || !observed.some((entry) => entry.paneId === admitted.paneId && entry.nativeSession === admitted.nativeSession && entry.harness === current.runtime.settings.requested.harness))
            throw new StoreFenceError("Bounded launch requires the observed owning native pane and session");
          actor(connection);
        }
        const context = store.workflowContext({ employee: current.binding, itemId: request.itemId });
        const authority = store.createWorkflowAuthority({ employee: current.binding, itemId: context.itemId, claimId: context.claimId, workflow: request.workflow, limit: request.limit, launchKey: request.launchKey, assertConnection: () => { actor(connection); } });
        let bridge: WorkflowBridge | undefined;
        try {
          bridge = await startWorkflowBridge(authority, workflowBridgeOptions(authority));
          const bridges = workflowBridges.get(connection) ?? new Set<WorkflowBridge>();
          bridges.add(bridge);
          workflowBridges.set(connection, bridges);
          const launcher = createWorkflowBridgeLauncher({ bridge });
          const extension = join(config.skillsRoot, "extensions", "startup", "bounded-entry.ts");
          const directive = `Attach the inherited scope with bounded_attach. Review and landing authority remain with Startup. Execute the authenticated item assignment: ${encode(context.assignment)}`;
          const args = ["--no-extensions", "--extension", extension, "--cwd", config.boundRoot, "--profile", config.profile, ...ompModelArgs(current.employee.role)];
          const receipt = tern !== undefined
            ? await launcher.launch({ kind: "tern", runtime: tern, parentBlockId: current.runtime.paneId, scopeId: authority.rootId, launchKey: request.launchKey, cwd: config.boundRoot, argv: ["omp", ...args, directive] })
            : await launcher.launch({ kind: "herdr", runtime: herdr!, parentPaneId: current.runtime.paneId, scopeId: authority.rootId, launchKey: request.launchKey, cwd: config.boundRoot, name: `w-${digest(request.launchKey).slice(0, 20)}`, harness: "omp", args: [...args, "--extension", ("herdrIntegration" in config ? config.herdrIntegration : ""), directive] });
          authority.launchState("accepted", jsonSchema.parse(receipt));
          output = { scopeId: authority.rootId, receipt, reviewAuthority: "startup", parentClaimId: context.claimId };
        } catch (error: unknown) {
          try { authority.launchState("uncertain", error instanceof WorkflowLaunchUncertainError ? jsonSchema.parse(error.location) : null); } catch { /* A stale owner cannot update the saved intent. */ }
          if (bridge) { workflowBridges.get(connection)?.delete(bridge); await bridge.close(); }
          throw error;
        }
        break;
      }
      case "workflow_factory_start": {
        manager(connection);
        if (current.runtime.paneId === null) throw new StoreFenceError("Manager native pane is unavailable");
        if (tern === undefined) {
          const observed = await herdr!.observe();
          const admitted = connections.get(connection);
          if (!admitted || !observed.some((entry) => entry.paneId === admitted.paneId && entry.nativeSession === admitted.nativeSession && entry.harness === current.runtime.settings.requested.harness))
            throw new StoreFenceError("Factory launch requires the observed manager pane and session");
          actor(connection);
        }
        const authority = store.createFactoryAuthority({ manager: current.binding, itemIds: request.itemIds, limit: request.limit, launchKey: request.launchKey, assertConnection: () => { manager(connection); } });
        let bridge: WorkflowBridge | undefined;
        try {
          bridge = await startWorkflowBridge(authority, workflowBridgeOptions(authority));
          const bridges = workflowBridges.get(connection) ?? new Set<WorkflowBridge>();
          bridges.add(bridge);
          workflowBridges.set(connection, bridges);
          const launcher = createWorkflowBridgeLauncher({ bridge });
          const extension = join(config.skillsRoot, "extensions", "startup", "bounded-entry.ts");
          const directive = `Attach the inherited factory scope with bounded_attach. Dispatch its native planner and freeze the validated graph before item work; observe dependency readiness. Reviews and landing remain with Startup. Execute only these authenticated item assignments: ${encode(authority.assignments)}`;
          const args = ["--no-extensions", "--extension", extension, "--cwd", config.boundRoot, "--profile", config.profile, ...ompModelArgs("dev")];
          const receipt = tern !== undefined
            ? await launcher.launch({ kind: "tern", runtime: tern, parentBlockId: current.runtime.paneId, scopeId: authority.rootId, launchKey: request.launchKey, cwd: config.boundRoot, argv: ["omp", ...args, directive] })
            : await launcher.launch({ kind: "herdr", runtime: herdr!, parentPaneId: current.runtime.paneId, scopeId: authority.rootId, launchKey: request.launchKey, cwd: config.boundRoot, name: `f-${digest(request.launchKey).slice(0, 20)}`, harness: "omp", args: [...args, "--extension", ("herdrIntegration" in config ? config.herdrIntegration : ""), directive] });
          authority.launchState("accepted", jsonSchema.parse(receipt));
          output = { scopeId: authority.rootId, receipt, reviewAuthority: "startup" };
        } catch (error: unknown) {
          try { authority.launchState("uncertain", error instanceof WorkflowLaunchUncertainError ? jsonSchema.parse(error.location) : null); } catch { /* A stale owner cannot update the saved intent. */ }
          if (bridge) { workflowBridges.get(connection)?.delete(bridge); await bridge.close(); }
          throw error;
        }
        break;
      }
      case "end_turn":
        store.updateRuntime({ ...current.runtime, turnActive: false }); output = { released: true }; break;
      case "claim": output = store.claimNext({ employee: current.binding }); break;
      case "settle": {
        try {
          if (current.employee.role === "pa" && !request.result.outgoing.some((cue) => cue.recipient === "manager" && cue.kind === "report")) throw new StoreConflictError("PA check settlement requires an outgoing report TO manager");
          output = store.settleClaim({ employee: current.binding, ...(request.claimId === undefined ? {} : { claimId: request.claimId }), result: request.result });
        } catch (error: unknown) {
          const rejected = error instanceof ClaimSettlementError ? error : error instanceof StoreConflictError ? new ClaimSettlementError({ code: "settlement_conflict", retryable: false, action: `${error.message}. Inspect the saved receipt and correct the result or outgoing cue payload; do not repeat the unchanged request.`, employeeId: current.employee.id, generation: current.employee.generation, claimId: store.employeeView(current.employee.id).claims[0]?.id ?? request.claimId ?? null }) : null;
          if (rejected === null) throw error;
          alertOnce({ id: `settlement-blocked-${digest(encode({ epoch: store.ownerEpoch, employeeId: current.employee.id, generation: current.employee.generation, claimId: rejected.recovery.claimId, code: rejected.recovery.code })).slice(0, 32)}`, correlation: current.employee.id, payload: { kind: "settlement-blocked", ...rejected.recovery, observedAt: now() } });
          throw rejected;
        }
        break;
      }
      case "send": output = store.sendCue({ sender: current.binding, cue: request.cue }); break;
      case "capture": output = store.captureIntake({ architect: current.binding, capture: request.capture }); break;
      case "item":
        output = store.transitionItem({ employee: current.binding, request: request.request }); break;
      case "receive_status": {
        const snapshot = store.snapshot();
        const saved = current.employee.role === "manager"
          ? snapshot.inputs.find((entry) => entry.id === request.id)
          : snapshot.messages.find((entry) => entry.id === `pane-input-${request.id}`)?.payload;
        const parsed = z.object({ source: z.enum(["interactive", "rpc"]), raw: rawInputSchema, employeeId: idSchema.optional() }).safeParse(saved);
        if (!parsed.success) { output = { state: "missing", id: request.id }; break; }
        if (current.employee.role !== "manager" && parsed.data.employeeId !== current.employee.id) throw new StoreAuthorityError("Input receipt belongs to another employee");
        output = { state: "committed", id: request.id, digest: digest(encode({ source: parsed.data.source, raw: parsed.data.raw })) };
        break;
      }
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
        output = { health: paState() ?? "ready", supervision, manager: { id: "manager", pa: snapshot.employees.filter((e) => e.role === "pa"), crews: snapshot.teams.map((team) => ({ id: team.id, eventId: team.eventId, state: team.state, architect: { id: team.architect, qa: team.qa, devs: team.devs }, items: team.items })) }, employees: snapshot.employees.map((e) => ({ id: e.id, role: e.role, assignment: e.assignment, generation: e.generation, error: e.error })), runtime: store.runtimeBindings().map(({ credentialDigest: _credential, ...rest }) => ({ ...rest, capability: runtimeCapabilityFor(rest), effectiveSettings: effectiveSettings(rest) })), roleSettings: store.allRoleSettings(), recovery: { claims: snapshot.claims.filter((c) => c.status !== "settled"), grants: snapshot.grants.filter((g) => g.state !== "released"), assignments: snapshot.assignments.filter((a) => a.state !== "complete") }, inputs: snapshot.inputs.map((i) => ({ id: i.id, disposition: i.disposition })), intakes: snapshot.intakes.map((i) => ({ eventId: i.request.eventId, teamId: i.teamId })) }; break;
      }
      case "intake": manager(connection); output = store.recordIntake({ manager: current.binding, event: { eventId: request.eventId, input: request.input, amendItemIds: request.amendItemIds } }); break;
      case "route": manager(connection); output = store.routeInput({ manager: current.binding, inputId: request.inputId, disposition: { kind: request.disposition, reason: request.reason, amendItemIds: request.amendItemIds } }); break;
      case "manager_migrate": manager(connection); output = store.migrateManagerQueue({ manager: current.binding, migrationId: request.migrationId }); break;
      case "manager_import_legacy": manager(connection); output = migrateLegacyStartup({ manager: current.binding, store, migrationId: request.migrationId, sourceRoot: request.sourceRoot, targetRoot: root }); break;
      case "manager_transfer_legacy": manager(connection); output = json(await transferCancelledLegacyItem({ manager: current.binding, store, migrationId: request.migrationId, sourceRoot: request.sourceRoot, targetRoot: root, itemId: request.itemId, intentId: request.intentId })); break;
      case "manager_request_handover": manager(connection); output = json(await requestLegacyHandover({ sourceRoot: request.sourceRoot, targetRoot: root, migrationId: request.migrationId, itemId: request.itemId, intentId: request.intentId })); break;
      case "manager_run_list": manager(connection); output = json(store.managerRuns()); break;
      case "manager_run_inputs": {
        manager(connection);
        output = json(store.managerInputs(request.launchKey).map((receipt) => ({ ...receipt, state: receipt.state === "delivered" ? "queued" : receipt.state })));
        break;
      }
      case "manager_run_send": {
        manager(connection);
        const receipt = store.reserveManagerInput({ manager: current.binding, launchKey: request.launchKey, messageId: request.messageId, text: request.text });
        if (!receipt.created) { output = json({ ...receipt.receipt, state: receipt.receipt.state === "delivered" ? "queued" : receipt.receipt.state }); break; }
        try {
          const native = managerProcesses.get(request.launchKey);
          if (!native) throw new StoreFenceError("Original OMP RPC process is unavailable for input");
          await native.call({ type: "steer", message: request.text });
          const delivered = store.settleManagerInput({ manager: current.binding, launchKey: request.launchKey, messageId: request.messageId, state: "delivered" });
          output = json({ ...delivered, state: "queued" });
        } catch (error: unknown) {
          store.settleManagerInput({ manager: current.binding, launchKey: request.launchKey, messageId: request.messageId, state: "uncertain" });
          throw error;
        }
        break;
      }
      case "manager_run_report": manager(connection); output = store.settleManagerRun({ manager: current.binding, launchKey: request.launchKey, state: request.state, outcome: request.outcome }); break;
      case "manager_run_start": {
        manager(connection);
        const previous = store.managerRuns().find((run) => run.launchKey === request.launchKey);
        if (previous) {
          const requestedPath = existsSync(request.worktree) ? realpathSync(request.worktree) : resolve(request.worktree);
          if (previous.itemId !== request.itemId || previous.workflow !== request.workflow || previous.limit !== request.limit || previous.target !== request.target || previous.worktree !== requestedPath) throw new StoreConflictError("Manager launch key belongs to a different request");
          output = json(previous);
          break;
        }
        const cwd = realpathSync(request.worktree);
        const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
        if (realpathSync(git("rev-parse", "--show-toplevel")) !== cwd) throw new StoreAuthorityError("Run worktree must be a Git repository root");
        const repository = realpathSync(resolve(cwd, git("rev-parse", "--git-common-dir")));
        git("check-ref-format", `refs/heads/${request.target}`);
        const branch = git("symbolic-ref", "--quiet", "--short", "HEAD");
        if (branch === request.target || realpathSync(resolve(cwd, git("rev-parse", "--git-dir"))) === repository) throw new StoreAuthorityError("Manager runs require a dedicated worktree on a branch different from the target");
        if (!store.managerRuns().some((run) => run.launchKey === request.launchKey) && !Bun.which("omp")) throw new StoreAuthorityError("Manager-led workflows require the OMP executable, including with a Claude manager");
        const item = store.queueItems().find((row) => row.id === request.itemId);
        const repositoryNotice = item ? inspectRepository({ cwd, repo: item.repo, remote: item.remote }) : null;
        const reserved = store.reserveManagerRun({ manager: current.binding, itemId: request.itemId, workflow: request.workflow, limit: request.limit, target: request.target, launchKey: request.launchKey, repository, worktree: cwd, branch });
        if (!reserved.created) { output = json(reserved.run); break; }
        let location: Json = null;
        let native: Awaited<ReturnType<typeof startOwnedOmpRpc>> | undefined;
        let accepted = false;
        let spawnAttempted = false;
        const reviews = new Map<string, ExpectedReview>();
        const settlements = new Map<string, Promise<void>>();
        const settle = async (review: ExpectedReview): Promise<void> => {
          if (!native) throw new StoreFenceError("Original OMP supervisor is unavailable");
          const evidence = await native.observeReview(review);
          store.bindManagerReview({ manager: current.binding, reviewId: review.reviewId, reviewerId: evidence.reviewerId, invocationId: evidence.invocationId });
          if (evidence.verdict === "invalid") await store.failManagerReview({ manager: current.binding, reviewId: review.reviewId, verify: async () => ({ reviewId: evidence.reviewId, launchKey: request.launchKey, head: evidence.head, reviewerId: evidence.reviewerId, invocationId: evidence.invocationId, status: "invalid", evidence: "Original correlated reviewer terminated unsuccessfully or produced invalid output" }) });
          else await store.settleManagerReview({ manager: current.binding, reviewId: review.reviewId, verify: async () => ({ reviewId: evidence.reviewId, launchKey: request.launchKey, head: evidence.head, reviewerId: evidence.reviewerId, invocationId: evidence.invocationId, verdict: evidence.verdict }) });
        };
        try {
          const assignmentPath = join(launchDirectory, `run-${digest(request.launchKey)}.json`);
          writeFileSync(assignmentPath, encode(reserved.run.assignment), { mode: 0o600, flag: "wx" });
          const remainingRounds = store.managerReviewBudget({ itemId: request.itemId, workflow: request.workflow, limit: request.limit }).remaining;
          if (remainingRounds < 1) throw new StoreAuthorityError("No inherited review rounds remain");
          const directive = `Run the jp-${request.workflow} skill in manager-led Startup mode. Read the assignment from ${assignmentPath}. Begin the bounded workflow with execution set to manager-led. Perform all work in the assigned worktree ${cwd} on branch ${branch}; do not change worktrees or branches. Target ${request.target}; maximum review rounds ${remainingRounds}. ${repositoryNotice ? `${repositoryNotice} ` : ""}Use startup_run_report to send questions or progress to the Startup manager; use a stable eventId for each report. Return the actual outcome to the Startup manager.`;
          spawnAttempted = true;
          native = await (input.managerRpc ?? startOwnedOmpRpc)({ binary: "omp", args: ["--mode", "rpc", "--no-ui", "--no-extensions", "--extension", join(config.skillsRoot, "extensions", "startup", "bounded-entry.ts"), "--cwd", cwd, "--profile", config.profile], cwd, env: { ...process.env, JP_STARTUP_MANAGER_RPC: "1" }, journalPath: join(launchDirectory, `rpc-${digest(request.launchKey)}.jsonl`), timeoutMs: 30000,
            reserveReview: async (review) => {
              if (review.itemId !== request.itemId || realpathSync(review.worktree) !== cwd || git("symbolic-ref", "--quiet", "--short", "HEAD") !== branch || git("rev-parse", "HEAD") !== review.head || [...reviews.values()].some((entry) => entry.reviewerId === review.reviewerId && entry.reviewId !== review.reviewId)) throw new OmpReviewRejectedError("Native review does not match this run or reuses a reviewer identity");
              store.reserveManagerReview({ manager: current.binding, launchKey: request.launchKey, reviewId: review.reviewId, head: review.head });
              reviews.set(review.reviewId, review);
            },
            reportRun: async (report) => { store.runtimeAlert({ id: `run-report-${digest(`${request.launchKey}/${report.eventId}`)}`, correlation: request.launchKey, payload: { kind: "manager-run-report", itemId: request.itemId, reportKind: report.kind, text: report.text } }); },
            onNativeEvent: (event) => {
              const parsed = z.object({ type: z.literal("subagent_lifecycle"), payload: z.object({ id: z.string(), status: z.enum(["completed", "failed", "cancelled"]) }) }).safeParse(event);
              if (!parsed.success) return;
              const review = [...reviews.values()].find((entry) => entry.reviewerId === parsed.data.payload.id);
              if (!review || settlements.has(review.reviewId)) return;
              const promise = settle(review);
              settlements.set(review.reviewId, promise);
              void promise.catch((error: unknown) => { if (settlements.get(review.reviewId) === promise) settlements.delete(review.reviewId); process.stderr.write(JSON.stringify({ level: "warn", component: "manager-review", launchKey: request.launchKey, reviewId: review.reviewId, error: error instanceof Error ? error.message : String(error) }) + "\n"); });
            },
            completeRun: async (hint) => {
              const review = reviews.get(hint.reviewId);
              if (!review || hint.itemId !== request.itemId || hint.head !== review.head || realpathSync(hint.worktree) !== cwd) throw new StoreAuthorityError("Completion does not match the reserved review");
              let settlement = settlements.get(hint.reviewId);
              if (!settlement) { settlement = settle(review); settlements.set(hint.reviewId, settlement); }
              try { await settlement; }
              catch (error: unknown) { if (settlements.get(hint.reviewId) === settlement) settlements.delete(hint.reviewId); throw error; }
              await store.completeManagerRun({ manager: current.binding, launchKey: request.launchKey, verify: async (run) => {
                if (git("symbolic-ref", "--quiet", "--short", "HEAD") !== branch || git("rev-parse", "HEAD") !== hint.head || git("status", "--porcelain") !== "" || realpathSync(resolve(cwd, git("rev-parse", "--git-common-dir"))) !== repository) throw new StoreFenceError("Reviewed worktree changed before completion");
                const pr = z.object({ headRefOid: z.string(), baseRefName: z.string(), state: z.enum(["OPEN", "MERGED"]), isDraft: z.boolean(), mergeCommit: z.object({ oid: z.string() }).nullable() }).parse(JSON.parse(execFileSync("gh", ["pr", "view", String(hint.prNumber), "--json", "headRefOid,baseRefName,state,isDraft,mergeCommit"], { cwd, encoding: "utf8" })));
                if (pr.headRefOid !== hint.head || pr.baseRefName !== request.target || pr.isDraft) throw new StoreFenceError("PR does not match the reviewed head and target");
                if (pr.state === "MERGED") { if (!pr.mergeCommit) throw new StoreFenceError("Merged PR has no merge commit"); git("fetch", "--no-tags", "origin", `refs/heads/${request.target}`); git("merge-base", "--is-ancestor", pr.mergeCommit.oid, "FETCH_HEAD"); }
                const record = store.managerReviews(request.launchKey).find((entry) => entry.reviewId === hint.reviewId);
                if (!record || record.state !== "completed" || record.verdict !== "approve" || !record.reviewerId || !record.invocationId) throw new StoreFenceError("Independent approved review is unavailable");
                const rounds = store.managerReviewBudget({ itemId: request.itemId, workflow: request.workflow, limit: request.limit }).completed;
                return { launchKey: run.launchKey, itemId: run.itemId, location: run.location, repository, worktree: cwd, target: request.target, head: hint.head, prNumber: hint.prNumber, prState: pr.state, prDraft: pr.isDraft, mergeCommit: pr.mergeCommit?.oid ?? null, review: { reviewId: record.reviewId, reviewerId: record.reviewerId, invocationId: record.invocationId, head: record.head, verdict: "approve", rounds } };
              } });
              const alertId = `manager-run-complete-${digest(request.launchKey)}`;
              if (!store.hasMessage(alertId)) store.runtimeAlert({ id: alertId, correlation: request.launchKey, payload: { kind: "manager-run-complete", itemId: request.itemId, launchKey: request.launchKey } });
            },
            onCompletedTurn: () => { const process = managerProcesses.get(request.launchKey); if (process) void process.close(); },
            onExit: () => {
              if (!managerProcesses.delete(request.launchKey)) return;
              try {
                for (const receipt of store.managerInputs(request.launchKey).filter((entry) => entry.state === "sending")) store.settleManagerInput({ manager: current.binding, launchKey: request.launchKey, messageId: receipt.messageId, state: "uncertain" });
                const run = store.managerRuns().find((entry) => entry.launchKey === request.launchKey);
                if (run?.state === "accepted" || run?.state === "reported") store.settleManagerRun({ manager: current.binding, launchKey: request.launchKey, state: "uncertain", outcome: json({ reason: "Original OMP RPC process exited before verified completion" }) });
                if (run && location !== null) {
                  store.recordManagerRunExit({ manager: current.binding, launchKey: request.launchKey, location });
                  reconcileExitedRun(request.launchKey, location);
                }

              } catch (error: unknown) { process.stderr.write(JSON.stringify({ level: "warn", component: "manager-process-exit", launchKey: request.launchKey, error: error instanceof Error ? error.message : String(error) }) + "\n"); }
            },
          });
          const state = z.object({ data: z.object({ sessionId: z.string().min(1) }) }).parse(await native.call({ type: "get_state" }));
          location = json({ kind: "omp-rpc", pid: native.pid, sessionId: state.data.sessionId });
          actor(connection);
          output = store.acceptManagerRun({ manager: current.binding, launchKey: request.launchKey, location });
          accepted = true;
          managerProcesses.set(request.launchKey, native);
          await native.call({ type: "prompt", message: directive });
        } catch (error: unknown) {
          if (native) await native.close();
          managerProcesses.delete(request.launchKey);
          const run = store.managerRuns().find((entry) => entry.launchKey === request.launchKey);
          if (run?.state === "starting" || run?.state === "accepted" || run?.state === "reported") store.settleManagerRun({ manager: current.binding, launchKey: request.launchKey, state: "uncertain", outcome: json({ location, error: error instanceof Error ? error.message : String(error) }) });
          if (!accepted && (native || !spawnAttempted || error instanceof OmpRpcStartupError)) await store.releaseUndispatchedManagerRun({ manager: current.binding, launchKey: request.launchKey, verify: async (original) => ({ launchKey: original.launchKey, itemId: original.itemId, status: "not-dispatched", evidence: native || error instanceof OmpRpcStartupError ? "Original supervised OMP process was absent or confirmed exited before any prompt was submitted" : "No OMP process was started or prompt submitted" }) });
          throw error;
        }
        break;
      }
      case "ensure_pa": {
        manager(connection);
        const paProfile = loadProfile({ skillsRoot: config.skillsRoot, role: "pa", employeeId: "pending", generation: 1 });
        const receipt = store.reserveHire({ authority: { kind: "employee", binding: store.managerBinding }, request: { requestId: "v7-manager-pa", role: "pa", additional: 1, revision: paProfile.source.roleRevision } });
        const pa = receipt.employees[0];
        if (!pa) throw new StoreConflictError("PA reservation is missing");
        const saved = store.runtimeBindings().findLast((r) => r.employeeId === pa.id);
        if (saved) {
          if (saved.state === "prepared") await launch(pa.id, await createEmployeeTab(pa.id, `${config.name} manager PA`));
          output = { employeeId: pa.id }; break;
        }
        prepare(pa.id, randomBytes(32).toString("hex"));
        await launch(pa.id, await createEmployeeTab(pa.id, `${config.name} manager PA`));
        output = { employeeId: pa.id }; break;
      }
      case "hire": {
        manager(connection);
        if (request.role === "pa") throw new StoreAuthorityError("The manager has exactly one permanent PA; retry its existing identity");
        const source = loadProfile({ skillsRoot: config.skillsRoot, role: request.role, employeeId: "pending", generation: 1 }).source;
        const receipt = store.reserveHire({ authority: { kind: "employee", binding: current.binding }, request: { requestId: request.requestId, role: request.role, additional: request.additional, revision: source.roleRevision } });
        for (const e of receipt.employees) prepare(e.id, randomBytes(32).toString("hex"));
        output = receipt; break;
      }
      case "delegate": {
        manager(connection);
        const saved = store.snapshot().intakes.find((i) => i.request.eventId === request.eventId);
        if (!saved) throw new StoreConflictError("Persist raw intake before delegating a crew");
        if (saved.teamId !== null) { output = store.snapshot().teams.find((t) => t.id === saved.teamId); break; }
        const snapshot = store.snapshot();
        const observations = tern === undefined ? await herdr!.observe() : [];
        actor(connection);
        const reusable = snapshot.teams.find((team) => team.state === "finished" && team.devs.length === request.developers && [team.architect, team.qa, ...team.devs].every((id) => {
          const current = employee(id);
          const bound = runtime(id);
          return encode(store.roleSettings(current.role)) === encode(bound.settings) && current.assignment === null && current.error === null && bound.state === "ready" && !bound.turnActive && bound.error === null && observations.some((o) => o.harness === bound.settings.requested.harness && o.nativeSession === bound.nativeSession && o.terminalId === bound.terminalId && o.interactiveReady && ["idle", "done"].includes(o.state)) && !snapshot.messages.some((m) => m.recipient === id && m.status !== "acknowledged") && !snapshot.claims.some((c) => c.employeeId === id && c.status !== "settled") && !snapshot.grants.some((g) => g.employeeId === id && g.state !== "released");
        }));
        store.recordTeamRequirement({ manager: current.binding, request: { eventId: request.eventId, developers: request.developers } });
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
          actor(connection);
          await herdr!.renameCrew({ tabId: prior.tabId, label: `${config.name} crew ${team.id.slice(0, 8)}` });
          actor(connection);
          output = store.snapshot().teams.find((t) => t.id === team.id);
          break;
        }
        let first: Readonly<{ tabId: string; paneId: string }> | null = null;
        launchInBackground(members, async (id) => {
          actor(connection);
          const bound = runtime(id);
          const tab = first;
          const location = tab === null ? await createEmployeeTab(id, `${config.name} crew ${team.id.slice(0, 8)}`) : await allocate(id, async () => {
            if (tern !== undefined) {
              const created = await tern.split({ blockId: tab.paneId, cwd: config.boundRoot, argv: ternArgv(bound) });
              return { tabId: created.tabId, paneId: created.blockId };
            }
            return { tabId: tab.tabId, paneId: await herdr!.split({ paneId: tab.paneId, cwd: config.boundRoot, env: paneEnvironment(bound) }) };
          });
          first = tab ?? location;
          actor(connection);
          await launch(id, location);
        });
        output = store.snapshot().teams.find((t) => t.id === team.id); break;
      }
      case "activate": {
        manager(connection);
        assertNotLaunching(request.employeeIds);
        if (request.employeeIds.some((id) => runtime(id).state !== "prepared")) throw new StoreAuthorityError("Existing launch requires identity reconciliation; never blindly start it again");
        launchInBackground(request.employeeIds, async (id) => { actor(connection); const location = await createEmployeeTab(id, `${config.name} ${employee(id).role}`); actor(connection); await launch(id, location); });
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
        if (tern !== undefined) {
          if (previous.paneId === null || previous.ternObservation === undefined)
            throw new StoreAuthorityError("Tern replacement cannot prove an unknown allocation or unobserved native process absent");
          const absentBlock = await tern.isAbsent({ blockId: previous.paneId });
          const absentProcess = await tern.isProcessAbsent({ pid: previous.ternObservation.pid });
          await verifiedActor(connection);
          const latest = runtime(request.employeeId);
          if (latest.launchId !== previous.launchId || latest.stateSequence !== previous.stateSequence || latest.lastPoll !== previous.lastPoll || latest.lastSeen !== previous.lastSeen)
            throw new StoreFenceError("Tern launch changed while verifying replacement evidence");
          if (!absentBlock || !absentProcess || now() - Math.max(latest.lastPoll, latest.lastSeen) <= policy.connectionDeadlineMs)
            throw new StoreAuthorityError("Replacement would duplicate a live or recently connected employee; stop and reconcile the original root first");
        } else {
          const launchName = `s-${previous.launchId.replaceAll("-", "").slice(0, 28)}`;
          const observed = (await herdr!.observe()).some((o) => (previous.nativeSession !== null && o.nativeSession === previous.nativeSession) || (previous.paneId !== null && o.paneId === previous.paneId) || (previous.terminalId !== null && o.terminalId === previous.terminalId) || o.name === launchName);
          actor(connection);
          if (observed || now() - Math.max(previous.lastPoll, previous.lastSeen) <= policy.connectionDeadlineMs) throw new StoreAuthorityError("Replacement would duplicate a live or recently connected employee; stop and reconcile the original root first, including any unknown shell allocation");
        }
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
      case "workflow_review": output = store.workflowReview({ employee: current.binding, request }); break;
      case "retire": manager(connection); output = store.retireEmployees({ manager: current.binding, employeeIds: request.employeeIds, evidence: request.evidence }); break;
      case "block": manager(connection); output = store.runtimeAlert({ id: `block-${request.key}-${digest(encode(request.evidence)).slice(0, 12)}`, correlation: request.key, payload: { kind: "reported-blocker", evidence: request.evidence } }); break;
    }
    if (before !== null && before !== encode(store.snapshot())) progress(current.employee.id);
    if (workflowCommand && request.kind !== "workflow_context") progress(current.employee.id);
    return output === undefined ? null : json(output);
  }
  function waitReason(current: Employee, view: ReturnType<StartupStore["employeeView"]>): string | null {
    if (view.claims.length > 0) return "Settle or explicitly reconcile your outstanding claim before ending.";
    if (view.messages.length > 0 && view.team?.state !== "reserved") return "Claim your pending durable inbox before ending.";
    if (view.itemReview !== null) return `Submit startup_item review for item ${view.itemReview.itemId} using resultId ${view.itemReview.resultId}, expectedRevision ${view.itemReview.revision}, and actual verification evidence. Your saved completed result must reach its owning architect before idling.`;
    if (current.role !== "manager") return null;
    const pending = store.managerPendingWork();
    if (pending.unclassifiedInput) return "Classify saved human inputs before ending.";
    if (pending.undelegatedIntake) return "Delegate every saved independent work event before ending.";
    try {
      const runningItems = new Set(store.managerRuns().map((run) => run.itemId));
      const ready = store.queueItems().find((row) => ["QUEUED", "READY_TO_LAND"].includes(z.string().parse(row.status)) && !runningItems.has(row.id));
      return ready ? `Advance ready item ${ready.id} or record its concrete blocker before ending.` : null;
    } catch (error: unknown) {
      return `Canonical queue unavailable; preserve its contents and repair the reported read error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  function effectiveSettings(binding: Pick<RuntimeBinding, "employeeId" | "generation" | "launchId" | "settings" | "state" | "nativeSession">): EffectiveRoleSettings {
    const saved = store.effectiveRoleSettings(binding.employeeId, binding.generation);
    if (saved !== null && saved.session !== null && activeObservationMatches(binding, saved.session)) return saved;
    if (binding.state === "ready" && binding.nativeSession !== null) {
      const identity = { startupRoot: root, harness: binding.settings.requested.harness, ownerId: store.ownerId, ownerEpoch: store.ownerEpoch, employeeId: binding.employeeId, generation: binding.generation, launchId: binding.launchId, nativeSession: binding.nativeSession, agentSessionId: null, connectionEpoch: "unobserved" };
      return effectiveRoleSettingsSchema.parse({ status: "unavailable", harness: binding.settings.requested.harness, reason: binding.settings.requested.harness === "omp" ? "session_not_observed" : "claude_cli_readback_unavailable", session: identity, observedAt: null, sampleSequence: null });
    }
    return effectiveRoleSettingsSchema.parse({ status: "unavailable", harness: binding.settings.requested.harness, reason: "session_not_observed", session: null, observedAt: null, sampleSequence: null });
  }
  function runtimeCapabilityFor(binding: Pick<RuntimeBinding, "employeeId" | "generation" | "launchId" | "settings" | "state" | "nativeSession">): RuntimeCapability {
    const saved = store.runtimeCapability(binding.employeeId, binding.generation);
    if (saved !== null && saved.session !== null && activeObservationMatches(binding, saved.session)) return saved;
    if (binding.state === "ready" && binding.nativeSession !== null) {
      const identity = { startupRoot: root, harness: binding.settings.requested.harness, ownerId: store.ownerId, ownerEpoch: store.ownerEpoch, employeeId: binding.employeeId, generation: binding.generation, launchId: binding.launchId, nativeSession: binding.nativeSession, agentSessionId: null, connectionEpoch: "unobserved" };
      return runtimeCapabilitySchema.parse({ status: "unavailable", harness: binding.settings.requested.harness, reason: binding.settings.requested.harness === "omp" ? "session_not_observed" : "claude_cli_catalog_unavailable", session: identity, observedAt: null, sampleSequence: null });
    }
    return runtimeCapabilitySchema.parse({ status: "unavailable", harness: binding.settings.requested.harness, reason: "session_not_observed", session: null, observedAt: null, sampleSequence: null });
  }
  function activeObservationMatches(binding: Pick<RuntimeBinding, "employeeId" | "generation" | "launchId" | "state" | "nativeSession">, session: NonNullable<RuntimeCapability["session"]>): boolean {
    const admitted = [...connections.values()].find((entry) => entry.connectionEpoch === session.connectionEpoch);
    const live = runtime(binding.employeeId);
    return admitted !== undefined && admitted.agentSessionId === session.agentSessionId && now() - live.lastPoll <= policy.connectionDeadlineMs && binding.state === "ready" && binding.nativeSession !== null && session.ownerId === store.ownerId && session.ownerEpoch === store.ownerEpoch &&
      session.employeeId === binding.employeeId && session.generation === binding.generation && session.launchId === binding.launchId && session.nativeSession === binding.nativeSession;
  }
  async function poll(connection: string, settingsReport?: OmpSessionSettingsReport, sampleSequence?: number, nativeRoot?: NativeRoot): Promise<Poll> {
    let current = tern === undefined ? actor(connection) : await verifiedActor(connection);
    if (tern !== undefined) {
      const sample = nativeRootSchema.parse(nativeRoot);
      const admitted = connections.get(connection);
      if (!admitted || admitted.pid !== sample.pid || admitted.paneId !== sample.paneId || admitted.agentSessionId !== sample.sessionId || current.runtime.paneId !== sample.paneId)
        throw new StoreFenceError("Tern lifecycle identity does not match the authenticated native root");
      store.observeRuntime({ employeeId: current.employee.id, generation: current.employee.generation, nativeSession: current.runtime.nativeSession!, state: sample.phase, sequence: sample.sequence, observedAt: now(), ternObservation: sample });
      current = actor(connection);
    } else if (nativeRoot !== undefined) throw new StoreAuthorityError("Native Tern lifecycle is not valid for a Herdr coordinator");
    if (settingsReport !== undefined) {
      const report = ompSessionSettingsReportSchema.parse(settingsReport);
      const sequence = z.number().int().positive().safe().parse(sampleSequence);
      const admitted = connections.get(connection);
      if (current.runtime.settings.requested.harness !== "omp" || admitted?.agentSessionId === null || admitted?.agentSessionId === undefined ||
        report.nativeSession !== current.runtime.nativeSession || report.agentSessionId !== admitted.agentSessionId)
        throw new StoreFenceError("OMP settings report does not match the authenticated native session and reserved launch generation");
      const identity = { startupRoot: root, harness: current.runtime.settings.requested.harness, ownerId: store.ownerId, ownerEpoch: store.ownerEpoch, employeeId: current.employee.id, generation: current.employee.generation, launchId: current.runtime.launchId, nativeSession: current.runtime.nativeSession!, agentSessionId: report.agentSessionId, connectionEpoch: admitted.connectionEpoch };
      const observedAt: number = now();
      const capability = report.status === "available"
        ? runtimeCapabilitySchema.parse({ status: "available", harness: "omp", session: identity, availableModels: report.availableModels, availableEfforts: report.availableEfforts, observedAt, sampleSequence: sequence })
        : runtimeCapabilitySchema.parse({ status: "unavailable", harness: "omp", reason: report.reason, session: identity, observedAt, sampleSequence: sequence });
      const effective = report.status === "available"
        ? effectiveRoleSettingsSchema.parse({ status: "available", harness: "omp", session: identity, model: report.model, configuredEffort: report.configuredEffort, effectiveEffort: report.effectiveEffort, observedAt, sampleSequence: sequence })
        : effectiveRoleSettingsSchema.parse({ status: "unavailable", harness: "omp", reason: report.reason, session: identity, observedAt, sampleSequence: sequence });
      store.recordRuntimeSettings({ capability, effective });
    }
    store.updateRuntime({ ...runtime(current.employee.id), lastPoll: now() });
    const view = store.employeeView(current.employee.id);
    const available = turnAvailable(current.employee);
    const admitted = (!view.team || !["reserved", "reconciliation", "finished"].includes(view.team.state)) && available;
    const nextClaim = view.claims.length === 0 ? view.messages[0] : undefined;
    return { toolBlockReason: crewBlock(current.employee) ?? (view.claims.some((c) => c.status === "reconciliation") || view.grants.length > 0 ? "Reconcile saved uncertain claims and grants through the manager before technical work." : null), projection: `${profileText(profile(current.employee, current.employee.generation))}\nSTARTUP_CHECKPOINT=${encode(current.employee.checkpoint)}\nSTARTUP_TEAM=${encode(view.team)}\nSTARTUP_CLAIMS=${encode({ employeeId: current.employee.id, generation: current.employee.generation, claims: view.claims, readyMessageIds: view.claims.length === 0 ? view.messages.map((message) => message.id) : [] })}\nSTARTUP_INBOX=${encode({ selection: current.employee.role === "manager" ? "priority" : "fifo", nextClaim: nextClaim === undefined ? null : { tool: "startup_claim", arguments: {}, messageId: nextClaim.id, kind: nextClaim.kind, sender: nextClaim.sender, correlation: nextClaim.correlation }, deferredMessageCount: view.deferredMessageCount, latestPaReport: view.latestPaReport?.payload ?? null })}\nSTARTUP_ITEM_REVIEW=${encode(view.itemReview)}\nstartup_claim {} directly selects STARTUP_INBOX.nextClaim.messageId; no older administrative message must be consumed first. The ID is a selection receipt, not a tool argument.\nSettle only an outstanding current claim with startup_settle {result}. Do not copy claim IDs. If an existing native tool requires claimId, use the literal "current". On a nonretryable settlement error, follow its action; never repeat unchanged arguments.`, pendingMessageIds: admitted ? view.messages.map((m) => m.id) : [], waitReason: available ? waitReason(current.employee, view) : null };
  }
  function alertOnce(value: Readonly<{ id: string; correlation: string; payload: Json }>): void {
    if (!store.hasMessage(value.id)) store.runtimeAlert(value);
  }
  async function supervise(): Promise<void> {
    store.renewLease();
    for (const run of store.managerRuns()) {
      if (run.termination || !["uncertain", "failed", "completed"].includes(run.state) || managerProcesses.has(run.launchKey)) continue;
      let exit = store.managerRunExit(run.launchKey);
      if (exit === null) {
        const native = z.object({ kind: z.literal("omp-rpc"), pid: z.number().int().positive() }).safeParse(run.location);
        if (!native.success) continue;
        try { process.kill(native.data.pid, 0); continue; }
        catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) continue; }
        store.recordManagerRunExit({ manager: store.managerBinding, launchKey: run.launchKey, location: run.location });
        exit = run.location;
      }
      if (encode(exit) !== encode(run.location)) continue;
      reconcileExitedRun(run.launchKey, run.location);
    }
    supervision = { ...supervision, lastStartedAt: now() };
    const errors: SupervisionFailure[] = [];
    function failure(component: SupervisionFailure["component"], employeeId: string | null, error: unknown): void {
      const detail = (error instanceof Error ? error.message : String(error)).replaceAll(config.managerCredential, "[redacted]");
      errors.push({ component, employeeId, error: detail });
      alertOnce({ id: `supervision-${component}-${employeeId ?? "all"}-${digest(detail).slice(0, 12)}`, correlation: "manager-supervision", payload: { kind: `${component}-unavailable`, employeeId, error: detail, observedAt: now() } });
    }
    let observations: readonly HerdrObservation[] = [];
    if (tern === undefined) {
      try { observations = await herdr!.observe(); }
      catch (error: unknown) { failure("herdr", null, error); }
    } else {
      try { await tern.check(); }
      catch (error: unknown) { failure("tern", null, error); }
    }
    observerAvailable = !errors.some((error) => error.component === (tern === undefined ? "herdr" : "tern"));
    if (tern !== undefined && observerAvailable) {
      for (const [connection, admitted] of connections) {
        if (admitted.pid === null || !await tern.ownsProcess({ blockId: admitted.paneId, pid: admitted.pid })) {
          revoke(connection);
          failure("observation", admitted.employeeId, "Tern native process is not live in its reserved pane");
        }
      }
    }
    for (const saved of currentRuntimes().filter((r) => tern === undefined && observerAvailable && r.state === "ready" && r.employeeId !== "manager")) {
      try {
        const observation = observations.find((o) => o.harness === saved.settings.requested.harness && o.nativeSession === saved.nativeSession && o.terminalId === saved.terminalId);
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
    const managerObserved = tern === undefined
      ? observations.some((o) => o.harness === managerRuntime.settings.requested.harness && o.nativeSession === managerRuntime.nativeSession && o.terminalId === managerRuntime.terminalId)
      : [...connections.values()].some((entry) => entry.employeeId === "manager");
    if (tern === undefined && observerAvailable && managerObserved) store.updateRuntime({ ...managerRuntime, lastSeen: now() });
    const managerOffline = (observerAvailable && !managerObserved) || now() - managerRuntime.lastPoll > policy.connectionDeadlineMs;
    const snapshot = store.supervisionView();
    if (managerOffline) {
      const id = `manager-offline-${managerRuntime.launchId}-${managerRuntime.lastPoll}`;
      alertOnce({ id, correlation: "manager-supervision", payload: { kind: "manager-offline", lastPoll: managerRuntime.lastPoll, observedAt: now() } });
    }
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
    const messages = snapshot.messages;
    for (const saved of currentRuntimes()) {
      if (["prepared", "starting", "uncertain"].includes(saved.state) && now() - saved.lastSeen > policy.connectionDeadlineMs)
        alertOnce({ id: `launch-stalled-${saved.launchId}`, correlation: saved.launchId, payload: { kind: "launch-stalled", employeeId: saved.employeeId, state: saved.state, error: saved.error, preparedAt: saved.lastSeen } });
      const outstanding = messages.some((m) => m.recipient === saved.employeeId && m.status !== "acknowledged");
      if (outstanding && now() - saved.lastProgress > policy.progressDeadlineMs) alertOnce({ id: `stale-${saved.launchId}-${saved.lastProgress}`, correlation: saved.launchId, payload: { kind: "stale-progress", employeeId: saved.employeeId, lastProgress: saved.lastProgress } });
    }
    const completedAt = now();
    supervision = { ...supervision, lastCompletedAt: completedAt, lastSuccessAt: errors.length === 0 ? completedAt : supervision.lastSuccessAt, errors };
  }
  const host = openHostSurface({
    store, now,
    deadlines: { connectionDeadlineMs: policy.connectionDeadlineMs, progressDeadlineMs: policy.progressDeadlineMs },
    readPa: () => paState(),
    readSupervision: () => supervision,
  });
  return {
    start,
    shutdown: async () => {
      const processes = [...managerProcesses.entries()];
      try {
        for (const [launchKey] of processes) {
          const run = store.managerRuns().find((entry) => entry.launchKey === launchKey);
          if (run?.state === "accepted" || run?.state === "reported") store.settleManagerRun({ manager: store.managerBinding, launchKey, state: "uncertain", outcome: json({ reason: "Coordinator shut down before verified completion" }) });
        }
      } finally {
        await Promise.all(processes.map(([, process]) => process.close()));
        await Promise.allSettled([...managerExits]);
        managerProcesses.clear();
      }
    },
    hostAssociations: (query) => {
      if (!("herdrSession" in config)) throw new StoreAuthorityError("Herdr host associations are unavailable for the Tern backend");
      return store.hostAssociations({ ...hostAssociationQuerySchema.parse(query), herdrSession: config.herdrSession, connectionDeadlineMs: policy.connectionDeadlineMs });
    },
    hostSettings: (query) => {
      const limit = z.number().int().min(1).max(100).parse(query.limit);
      const rows = currentRuntimes().toSorted((a, b) => a.launchId.localeCompare(b.launchId)).filter((bound) => query.after === null || bound.launchId.localeCompare(query.after) > 0);
      return json({ saved: store.allRoleSettings(), active: rows.slice(0, limit).map((bound) => ({ employeeId: bound.employeeId, launchId: bound.launchId, effective: effectiveSettings(bound), capability: runtimeCapabilityFor(bound) })), nextCursor: rows.length > limit ? rows[limit - 1]?.launchId ?? null : null });
    },
    hostControl(request): Promise<OwnerControlReceipt> {
      const operation = serial.then(() => store.hostControl(request));
      serial = operation.then(() => undefined, () => undefined);
      return operation;
    },
    revoke, admit, poll, launchFailure,
    health: () => {
      const manager = store.employeeRuntime("manager", employee("manager").generation);
      const initialized = manager?.paneId !== null && manager?.nativeSession !== null && manager !== null;
      const readyForAdmission = initialized && supervision.errors.length === 0 && now() - (supervision.lastCompletedAt ?? openedAt) <= policy.connectionDeadlineMs;
      const connected = manager !== null && manager.lastPoll > 0 && now() - manager.lastPoll <= policy.connectionDeadlineMs;
      return { status: !initialized ? "starting" : !readyForAdmission || (manager !== null && manager.lastPoll > 0 && !connected) ? "degraded" : "running", readyForAdmission, manager: { connected, lastPoll: manager?.lastPoll ?? null }, supervision };
    },
    command(connection, command) {
      const kind = commandSchema.parse(command).kind;
      if (["claim", "begin_turn", "end_turn", "staff", "settle", "send", "item", "capture", "input", "image", "receive", "receive_status"].includes(kind)) return execute(connection, command);
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
    launching(): Promise<void> { return launches; },
    hostStatus(query: unknown): HostStatus { return host.status(query); },
    hostAdmit(request: unknown): Promise<HostReceipt> {
      const operation = serial.then(() => host.admit(request));
      serial = operation.then(() => undefined, () => undefined);
      return operation;
    },
    hostCancel(request: unknown): Promise<HostReceipt> {
      const operation = serial.then(() => host.cancel(request));
      serial = operation.then(() => undefined, () => undefined);
      return operation;
    },
    hostReceipt(id: string): HostReceipt { return host.receipt(id); },
  };
}

export function serveCoordinator(input: Readonly<{ coordinator: Coordinator; socketPath: string }>): Bun.Server<{ connection: string | null; pending: boolean; abort: AbortController }> {
  if (existsSync(input.socketPath)) throw new StoreConflictError("Coordinator socket already exists; reconcile the existing owner");
  const server = Bun.serve<{ connection: string | null; pending: boolean; abort: AbortController }>({ unix: input.socketPath,
    websocket: {
      async message(socket, message): Promise<void> {
        if (socket.data.pending || socket.data.connection !== null) { socket.close(1008, "Already admitted"); return; }
        socket.data.pending = true;
        try {
          const admitted = admissionSchema.parse(JSON.parse(String(message)));
          const receipt = await input.coordinator.admit({ credential: admitted.credential, nativeSession: admitted.nativeSession, paneId: admitted.paneId, source: admitted.source, ...(admitted.agentSessionId === undefined ? {} : { agentSessionId: admitted.agentSessionId }), ...(admitted.pid === undefined ? {} : { pid: admitted.pid }) }, socket.data.abort.signal);
          if (socket.data.abort.signal.aborted) { input.coordinator.revoke(receipt.connection); return; }
          socket.data.connection = receipt.connection;
          socket.send(JSON.stringify(receipt));
        } catch (error: unknown) {
          socket.send(JSON.stringify({ status: error instanceof AdmissionPendingError ? 425 : 403, error: error instanceof Error ? error.message : String(error) }));
          socket.close(1008, "Admission refused");
        }
      },
      close(socket): void { socket.data.abort.abort(); if (socket.data.connection !== null) input.coordinator.revoke(socket.data.connection); },
    },
    async fetch(request, server) {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && path === "/health") { const health = input.coordinator.health(); return Response.json(health, { status: health.status === "running" ? 200 : 503 }); }
      if (request.method === "GET" && path === "/status") {
        const url = new URL(request.url);
        const readParam = (name: string): string | undefined => {
          const value = url.searchParams.get(name);
          return value === null || value.length === 0 ? undefined : value;
        };
        const limit = readParam("limit");
        return Response.json(input.coordinator.hostStatus({
          ...(limit === undefined ? {} : { limit: Number(limit) }),
          ...(readParam("queueCursor") === undefined ? {} : { queueCursor: readParam("queueCursor") }),
          ...(readParam("staffCursor") === undefined ? {} : { staffCursor: readParam("staffCursor") }),
          ...(readParam("teamCursor") === undefined ? {} : { teamCursor: readParam("teamCursor") }),
          ...(readParam("inputCursor") === undefined ? {} : { inputCursor: readParam("inputCursor") }),
        }));
      }
      if (request.method === "GET" && path === "/host/associations") {
        const params = new URL(request.url).searchParams;
        return Response.json(input.coordinator.hostAssociations({ after: params.get("after"), limit: Number(params.get("limit")) }));
      }
      if (request.method === "GET" && path === "/host/settings") {
        const params = new URL(request.url).searchParams;
        return Response.json(input.coordinator.hostSettings({ after: params.get("after"), limit: Number(params.get("limit") ?? "100") }));
      }
      if (request.method === "POST" && path === "/host/control") return Response.json(await input.coordinator.hostControl(ownerControlRequestSchema.parse(await request.json())));
      if (request.method === "POST" && path === "/host/admit") return Response.json(await input.coordinator.hostAdmit(await request.json()));
      if (request.method === "POST" && path === "/host/cancel") return Response.json(await input.coordinator.hostCancel(await request.json()));
      if (request.method === "GET" && path.startsWith("/host/receipt/")) {
        const raw = path.slice("/host/receipt/".length);
        if (raw.length === 0 || raw.includes("/")) return Response.json({ error: "unknown_endpoint" }, { status: 404 });
        return Response.json(input.coordinator.hostReceipt(decodeURIComponent(raw)));
      }
      if (request.method === "GET" && path === "/admit") {
        if (server.upgrade(request, { data: { connection: null, pending: false, abort: new AbortController() } })) return;
        return Response.json({ error: "admission_channel_required" }, { status: 426 });
      }
      if (request.method === "POST" && path === "/launch-failure") {
        input.coordinator.launchFailure(launchFailureSchema.parse(await request.json()));
        return Response.json({ recorded: true });
      }
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) throw new StoreAuthorityError("Employee connection credential is required");
      const connection = authorization.slice(7);
      if (request.method === "POST" && path === "/disconnect") { input.coordinator.revoke(connection); return Response.json({ revoked: true }); }
      if (request.method === "GET" && path === "/poll") return Response.json(await input.coordinator.poll(connection));
      if (request.method === "POST" && path === "/poll") { const sample = coordinatorPollSchema.parse(await request.json()); return Response.json(await input.coordinator.poll(connection, sample.report, sample.sequence, sample.nativeRoot)); }
      if (request.method === "POST" && path === "/command") return Response.json(await input.coordinator.command(connection, jsonSchema.parse(await request.json())));
      return Response.json({ error: "unknown_endpoint" }, { status: 404 });
    } catch (error: unknown) {
      const status = error instanceof AdmissionPendingError ? 425 : error instanceof z.ZodError ? 400 : error instanceof StoreAuthorityError ? 403 : error instanceof StoreConflictError || error instanceof StoreFenceError ? 409 : 500;
      return Response.json({ error: error instanceof Error ? error.constructor.name : "RuntimeError", message: error instanceof Error ? error.message : String(error), ...(error instanceof ClaimSettlementError ? { recovery: error.recovery } : {}), ...(error instanceof AdmissionRevokedError ? { admission: "revoked" } : {}) }, { status });
    }
  } });
  chmodSync(input.socketPath, 0o600);
  return server;
}
