import { createDuties } from "./duties";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  bindingSchema,
  captureSchema,
  cueSchema,
  encode,
  idSchema,
  jsonSchema,
  resultSchema,
  roleSchema,
  timeSchema,
  type Binding,
  type Employee,
  type Json,
  type Message,
  type Team,
  StoreAuthorityError,
  StoreFenceError,
} from "./contracts";
import {
  openStore,
  type StartupStore,
  type HireReceipt,
  type Snapshot,
  type ReceivedInput,
} from "./store";
import {
  loadProfile,
  profileText,
  projectEmployee,
  verifyProfile,
  writeProfile,
  ProfileSourceError,
  type Profile,
} from "./profiles";

import {
  itemActionSchema,
  terminalItemStatuses,
  type ItemTransition,
} from "./items";
export type NativeResult = Readonly<{
  content: readonly Readonly<{ type: string; text?: string }>[];
  details?: unknown;
  isError?: boolean;
}>;
type ActivationReservation = Readonly<{
  profile: Profile;
  nativeId: string | null;
  sessionId: string | null;
}>;
export type NativeSession = Readonly<{
  sessionManager: Readonly<{
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
    ensureOnDisk?: () => Promise<void>;
  }>;
  asyncJobManager?: Readonly<{
    getAllJobs: (filter: Readonly<{ ownerId: string }>) => readonly unknown[];
  }>;
  settings: unknown;
  effectiveExtensionRoots?: unknown;
  getSessionAgents?: () => readonly Readonly<{
    name: string;
    spawns?: readonly string[] | "*";
  }>[];
  getPlanModeState: () => Readonly<{ enabled: boolean }> | undefined;
  getToolByName: (name: string) =>
    | Readonly<{
        execute: (
          id: string,
          params: Record<string, unknown>,
        ) => Promise<NativeResult>;
      }>
    | undefined;
}>;
export type NativeRef = Readonly<{
  id: string;
  kind: string;
  parentId?: string;
  status: string;
  createdAt: number;
  session: NativeSession | null;
  sessionFile: string | null;
}>;
export type NativeRegistry = Readonly<{
  get: (id: string) => NativeRef | undefined;
  list: () => readonly NativeRef[];
  onChange: (
    listener: (event: Readonly<{ type: string; ref: NativeRef }>) => void,
  ) => () => void;
}>;
export type NativeContext = Readonly<{
  agent: Readonly<{
    id: string;
    kind: string;
    name?: string;
    parentId?: string;
  }>;
  cwd: string;
  sessionManager: Readonly<{
    getSessionId: () => string;
    getSessionFile: () => string | undefined;
  }>;
  getSystemPrompt: () => string[];
  invokeTool?: (params: Record<string, unknown>) => Promise<NativeResult>;
  setInterval: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  clearTimer: (timer: ReturnType<typeof setInterval>) => void;
}>;
export type AdapterConfig = Readonly<{
  boundRoot: string;
  name: string;
  home: string;
  skillsRoot: string;
  employeeLimit: number | null;
  executionLimit: number | null;
  leaseMs: number;
}>;
export type Capacity = Readonly<{
  nativeLimit: number | null;
  explicitLimit: number | null;
  active: number;
  reserved: number;
  available: number | null;
  employees: number;
  employeeLimit: number | null;
}>;
export const hireInputSchema = z.strictObject({
  startup: z.literal("hire"),
  requestId: idSchema,
  role: roleSchema.exclude(["manager"]),
  additional: z.number().int().positive().safe(),
});
export const delegateInputSchema = z.strictObject({
  startup: z.literal("delegate"),
  eventId: idSchema,
  developers: z.number().int().positive().safe(),
});
export const activateInputSchema = z.strictObject({
  startup: z.literal("activate"),
  employeeIds: z.array(idSchema).min(1),
});
export const replaceInputSchema = z.strictObject({
  startup: z.literal("replace"),
  employeeId: idSchema,
  evidence: jsonSchema,
});
export const startupTaskSchema = z.discriminatedUnion("startup", [
  hireInputSchema,
  delegateInputSchema,
  activateInputSchema,
  replaceInputSchema,
]);
export const intakeInputSchema = z.strictObject({
  eventId: idSchema,
  input: jsonSchema,
  amendItemIds: z.array(idSchema),
});
export const routeInputSchema = z.strictObject({
  inputId: idSchema,
  disposition: z.enum([
    "work",
    "status",
    "control",
    "conversation",
    "decision",
  ]),
  reason: z.string().trim().min(1),
  amendItemIds: z.array(idSchema),
});
const nativeInputSchema = z.object({
  text: z.string(),
  images: z.array(jsonSchema).optional(),
  source: z.enum(["interactive", "rpc", "extension"]),
});
export const settleInputSchema = z.strictObject({
  claimId: idSchema,
  result: resultSchema,
});
export const retireInputSchema = z.strictObject({
  employeeIds: z.array(idSchema).min(1),
  evidence: jsonSchema,
});
const nativeDispatchSchema = z
  .object({
    progress: z.array(
      z
        .object({
          index: timeSchema,
          id: idSchema,
          status: z.string(),
          agent: z.string(),
          assignment: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const nativeActivationSchema = z.union([
  nativeDispatchSchema,
  z.object({ results: z.array(z.object({
    index: timeSchema,
    id: idSchema,
    agent: z.string(),
    assignment: z.string().optional(),
    exitCode: z.number().int(),
    aborted: z.boolean().optional(),
  }).passthrough()) }).passthrough().transform((details) => ({
    progress: details.results.map((result) => ({
      ...result,
      status: result.aborted ? "aborted" : result.exitCode === 0 ? "completed" : "failed",
    })),
  })),
]);
const nativeJobSchema = z
  .object({
    id: idSchema,
    type: z.string(),
    ownerId: idSchema,
    agentId: idSchema,
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    promise: z.instanceof(Promise),
    latestDetails: z.unknown(),
  })
  .passthrough();
type NativeJobObservation = Readonly<{
  ownerId: string;
  nativeId: string;
  agent: string;
  jobs: NonNullable<NativeSession["asyncJobManager"]>;
  previousIds: ReadonlySet<string>;
  current: () => boolean;
  authorize: () => void;
  settle: (status: "completed" | "failed" | "cancelled") => void;
}>;
function nativeJobIds(
  jobs: NativeSession["asyncJobManager"],
  ownerId: string,
): ReadonlySet<string> {
  return new Set(
    jobs
      ?.getAllJobs({ ownerId })
      .map((job) => z.object({ id: idSchema }).parse(job).id) ?? [],
  );
}
export const nativeHandleSchema = z.strictObject({
  version: z.literal(1),
  id: idSchema,
  sessionId: idSchema,
});
export function nativeHandle(id: string, sessionId: string): string {
  return encode(nativeHandleSchema.parse({ version: 1, id, sessionId }));
}
function decodeHandle(value: string): z.infer<typeof nativeHandleSchema> {
  return nativeHandleSchema.parse(JSON.parse(value));
}
const headerSchema = z
  .object({
    type: z.literal("session"),
    id: idSchema,
    parentSession: z.string().optional(),
  })
  .passthrough();
const nativeWakeSchema = z
  .object({
    receipts: z.array(
      z
        .object({
          to: idSchema,
          outcome: z.enum(["injected", "woken", "revived", "failed"]),
          error: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type StartupAdapter = ReturnType<typeof createAdapter>;

const rawInputSchema = z.object({
  text: z.string(),
  images: z.array(jsonSchema),
});
const imageSchema = z.object({
  type: z.literal("image"),
  data: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});
function inputSummary(inputId: string, raw: Json) {
  const parsed = rawInputSchema.safeParse(raw);
  const text = parsed.success
    ? parsed.data.text
    : typeof raw === "string"
      ? raw
      : encode(raw);
  const images = parsed.success ? parsed.data.images : [];
  return {
    inputId,
    textPreview: text.slice(0, 512),
    textLength: text.length,
    attachmentCount: images.length,
    attachments: images.slice(0, 8).map((raw, index) => {
      const image = imageSchema.parse(raw);
      return {
        inputId,
        index,
        mimeType: image.mimeType,
        bytes: Buffer.from(image.data, "base64").length,
        sha256: createHash("sha256").update(image.data).digest("hex"),
        tool: "startup_image",
      };
    }),
    textTool: "startup_input",
  };
}
function inputMetadata(received: ReceivedInput) {
  return {
    id: received.id,
    receivedAt: received.receivedAt,
    source: received.source,
    disposition: received.disposition,
    ...inputSummary(received.id, jsonSchema.parse(received.raw)),
  };
}
function publicMessage(message: Message): Message {
  const parsed = z
    .object({ kind: z.literal("architect-intake"), raw: jsonSchema })
    .passthrough()
    .safeParse(message.payload);
  return parsed.success
    ? {
        ...message,
        payload: jsonSchema.parse({
          ...parsed.data,
          raw: inputSummary(message.correlation, parsed.data.raw),
        }),
      }
    : message;
}
function projectedCue(message: Message | null): Json {
  return message === null ? null : jsonSchema.parse(publicMessage(message));
}
function reusableStaff(
  snapshot: Snapshot,
  role: Employee["role"],
): readonly Employee[] {
  return snapshot.employees.filter(
    (employee) =>
      employee.role === role &&
      employee.employment === "hired" &&
      employee.assignment === null &&
      employee.error === null &&
      !snapshot.messages.some(
        (message) =>
          message.recipient === employee.id &&
          message.status !== "acknowledged",
      ) &&
      !snapshot.claims.some(
        (claim) =>
          claim.employeeId === employee.id && claim.status !== "settled",
      ) &&
      !snapshot.assignments.some(
        (assignment) =>
          assignment.employeeId === employee.id &&
          assignment.state !== "complete",
      ) &&
      !snapshot.grants.some(
        (grant) =>
          grant.employeeId === employee.id && grant.state !== "released",
      ),
  );
}
export function createAdapter(
  input: Readonly<{
    ctx: NativeContext;
    registry: NativeRegistry;
    config: AdapterConfig;
    nativeLimit: () => number;
    nativeBatch: () => boolean;
    notifyManager: (cueId: string) => void;
    now: () => number;
  }>,
) {
  const { registry, config, now } = input;
  const root: NativeRef | undefined = registry.get(input.ctx.agent.id);
  if (
    input.ctx.agent.kind !== "main" ||
    !root?.session ||
    root.kind !== "main" ||
    root.session.sessionManager.getSessionId() !==
      input.ctx.sessionManager.getSessionId()
  )
    throw new StoreAuthorityError(
      "Startup owner must be the actual native root session",
    );
  const rootId: string = root.id;
  const rootSession: string = root.session.sessionManager.getSessionId();
  const rootFile: string | undefined =
    root.session.sessionManager.getSessionFile();
  if (!rootFile)
    throw new StoreAuthorityError(
      "Native root transcript must exist before Startup binding",
    );
  const rootDirectory: string = realpathSync(input.ctx.cwd);
  const managerProfile: Profile = loadProfile({
    skillsRoot: config.skillsRoot,
    role: "manager",
    employeeId: "manager",
    generation: root.createdAt,
  });
  const store: StartupStore = openStore({
    path: join(config.home, "startup", config.name, "staff.sqlite"),
    scope: {
      home: config.home,
      host: hostname(),
      name: config.name,
      boundRoot: realpathSync(config.boundRoot),
      managerSession: rootSession,
    },
    owner: {
      id: randomUUID(),
      managerGeneration: root.createdAt,
      leaseMs: config.leaseMs,
    },
    now,
  });
  let managerReady: boolean = false;
  function bindManager(): boolean {
    verifyProfile(managerProfile);
    const snapshot = store.snapshot();
    if (
      snapshot.claims.some(
        (claim) => claim.employeeId === "manager" && claim.status !== "settled",
      ) ||
      snapshot.grants.some(
        (grant) => grant.employeeId === "manager" && grant.state !== "released",
      )
    )
      return false;
    store.bindEmployee({
      manager: store.managerBinding,
      binding: {
        ...store.managerBinding,
        assignment: null,
        source: managerProfile.source,
      },
    });
    managerReady = true;
    return true;
  }
  try {
    const existing = store
      .snapshot()
      .employees.find((employee) => employee.id === "manager");
    if (existing?.error !== null && existing?.error !== undefined)
      store.recoverManager({
        evidence: {
          kind: "verified-native-root-reopen",
          nativeSession: rootSession,
          rootTranscript: rootFile,
          createdAt: root.createdAt,
        },
      });
    bindManager();
  } catch (error: unknown) {
    store.close();
    throw error;
  }
  const expected: Map<string, ActivationReservation> = new Map();
  const receipts: Map<
    string,
    Readonly<{ nativeId: string; sessionId: string; profile: Profile }>
  > = new Map();
  const nativeFailures: Map<string, string> = new Map();
  const loaded: Map<
    string,
    Readonly<{ nativeId: string; sessionId: string; profile: Profile }>
  > = new Map();
  for (const employee of store.snapshot().employees) {
    if (
      employee.role === "manager" ||
      employee.employment !== "hired" ||
      employee.nativeHandle === null ||
      employee.source === null
    )
      continue;
    const token = decodeHandle(employee.nativeHandle);
    const profile = loadProfile({
      skillsRoot: config.skillsRoot,
      role: employee.role,
      employeeId: employee.id,
      generation: employee.generation,
    });
    if (encode(profile.source) !== encode(employee.source)) {
      store.recordBindingFailure({
        manager: store.managerBinding,
        employeeId: employee.id,
        error:
          "Canonical source changed while host was offline; explicit safe refresh required",
      });
      continue;
    }
    expected.set(employee.id, {
      profile,
      nativeId: token.id,
      sessionId: token.sessionId,
    });
  }
  const nativeJobObservers: Set<NativeJobObservation> = new Set();
  const admissions: Map<string, number> = new Map();
  const ordinaryAdmissions: Map<string, string | null> = new Map();
  const blockers: Map<string, Json> = new Map();
  const deliveries: Map<string, Json> = new Map();
  const pendingWakes: Set<string> = new Set();
  const timer: ReturnType<typeof setInterval> = input.ctx.setInterval(
    async () => {
      store.renewLease();
      for (const id of [...pendingWakes]) {
        const message = store
          .snapshot()
          .messages.find(
            (entry) => entry.id === id && entry.status === "pending",
          );
        if (message) {
          const result = await wake(message);
          if (
            z
              .object({
                kind: z.enum(["capacity-blocked", "dependency-blocked"]),
              })
              .safeParse(result).success
          )
            continue;
        }
        pendingWakes.delete(id);
      }
    },
    Math.max(1, Math.min(1000, Math.floor(config.leaseMs / 3))),
  );
  function snapshotEmployee(id: string): Employee {
    const employee: Employee | undefined = store
      .snapshot()
      .employees.find((entry) => entry.id === id);
    if (!employee)
      throw new StoreAuthorityError(`Unknown Startup employee ${id}`);
    return employee;
  }
  function nativeRef(ctx: NativeContext): NativeRef {
    const ref: NativeRef | undefined = registry.get(ctx.agent.id);
    if (
      !ref?.session ||
      ref.session.sessionManager.getSessionId() !==
        ctx.sessionManager.getSessionId()
    )
      throw new StoreAuthorityError(
        "Native caller session does not match registry evidence",
      );
    if (ref.id !== rootId) {
      if (ref.parentId !== rootId || !ref.sessionFile)
        throw new StoreAuthorityError(
          "Caller is outside the bound Startup root",
        );
      const headers = readFileSync(ref.sessionFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) =>
          z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)),
        )
        .filter((entry) => entry.type === "session");
      if (headers.length !== 1)
        throw new StoreAuthorityError(
          "Native transcript must contain exactly one session header",
        );
      const header = headerSchema.parse(headers[0]);
      if (
        header.id !== ctx.sessionManager.getSessionId() ||
        header.parentSession !== rootFile
      )
        throw new StoreAuthorityError(
          "Caller transcript has another native root",
        );
    } else if (ctx.sessionManager.getSessionId() !== rootSession)
      throw new StoreFenceError("Manager root session changed");
    return ref;
  }
  function caller(ctx: NativeContext): Binding {
    return boundCaller(ctx, nativeRef(ctx));
  }
  function boundCaller(ctx: NativeContext, ref: NativeRef): Binding {
    if (ref.id === rootId) {
      verifyProfile(managerProfile);
      if (!managerReady)
        throw new StoreAuthorityError(
          "Manager recovery requires explicit reconciliation before canonical source admission",
        );
      return store.managerBinding;
    }
    const receipt = receipts.get(ref.id);
    if (!receipt || receipt.sessionId !== ctx.sessionManager.getSessionId())
      throw new StoreAuthorityError(
        "Native caller has no source-verified Startup binding",
      );
    const employee: Employee = snapshotEmployee(receipt.profile.employeeId);
    if (
      employee.generation !== receipt.profile.generation ||
      employee.nativeHandle !==
        nativeHandle(receipt.nativeId, receipt.sessionId) ||
      employee.error !== null
    )
      throw new StoreFenceError("Native caller generation has been superseded");
    verifyProfile(receipt.profile);
    return bindingSchema.parse({
      employeeId: employee.id,
      generation: employee.generation,
      nativeHandle: nativeHandle(receipt.nativeId, receipt.sessionId),
    });
  }
  function rootAdmin(ctx: NativeContext): Binding {
    const ref = nativeRef(ctx);
    if (ref.id !== rootId)
      throw new StoreAuthorityError(
        "Only the current native root owner may reconcile recovery",
      );
    verifyProfile(managerProfile);
    store.renewLease();
    return store.managerBinding;
  }
  function manager(ctx: NativeContext): Binding {
    const binding: Binding = caller(ctx);
    if (binding.employeeId !== "manager")
      throw new StoreAuthorityError(
        "Only the bound manager may hire or delegate raw intake",
      );
    return binding;
  }
  function capacity(): Capacity {
    const native: number = z
      .number()
      .int()
      .nonnegative()
      .safe()
      .parse(input.nativeLimit());
    const nativeLimit: number | null = native === 0 ? null : native;
    const limit: number | null =
      config.executionLimit === null
        ? nativeLimit
        : nativeLimit === null
          ? config.executionLimit
          : Math.min(nativeLimit, config.executionLimit);
    const descendants: Set<string> = new Set([rootId]);
    let changed: boolean = true;
    while (changed) {
      changed = false;
      for (const ref of registry.list())
        if (
          ref.parentId &&
          descendants.has(ref.parentId) &&
          !descendants.has(ref.id)
        ) {
          descendants.add(ref.id);
          changed = true;
        }
    }
    const activeIds: readonly string[] = registry
      .list()
      .filter(
        (ref) =>
          ref.id !== rootId &&
          descendants.has(ref.id) &&
          ["running", "working", "starting", "pending"].includes(ref.status),
      )
      .map((ref) => ref.id);
    const active: number = activeIds.length;
    const reserved: number =
      [...ordinaryAdmissions.values()].filter(
        (id) => id === null || !activeIds.includes(id),
      ).length +
      [...admissions.keys()].filter((id) => {
        const expectedId = expected.get(id)?.nativeId;
        const employee = store
          .snapshot()
          .employees.find((employee) => employee.id === id);
        const nativeId =
          expectedId ??
          (employee?.nativeHandle
            ? decodeHandle(employee.nativeHandle).id
            : null);
        return nativeId === null || !activeIds.includes(nativeId);
      }).length;
    const employees: number = store
      .snapshot()
      .employees.filter((entry) => entry.employment === "hired").length;
    return {
      nativeLimit,
      explicitLimit: config.executionLimit,
      active,
      reserved,
      available: limit === null ? null : Math.max(0, limit - active - reserved),
      employees,
      employeeLimit: config.employeeLimit,
    };
  }
  function admit(
    employeeId: string,
    generation: number,
    nativeId: string | null,
  ): "running" | "existing" | "reserved" | "blocked" {
    const ref = nativeId === null ? undefined : registry.get(nativeId);
    if (
      ref &&
      ["running", "working", "starting", "pending"].includes(ref.status)
    )
      return "running";
    if (admissions.get(employeeId) === generation) return "existing";
    if (capacity().available === 0) return "blocked";
    admissions.set(employeeId, generation);
    return "reserved";
  }
  function observeNativeJob(observation: NativeJobObservation): void {
    const matches = observation.jobs
      .getAllJobs({ ownerId: observation.ownerId })
      .filter((job) => {
        const identity = z
          .object({
            id: idSchema,
            type: z.string(),
            ownerId: z.string().optional(),
            agentId: z.string().optional(),
          })
          .parse(job);
        return (
          !observation.previousIds.has(identity.id) &&
          identity.ownerId === observation.ownerId &&
          identity.type === "task" &&
          identity.agentId === observation.nativeId
        );
      })
      .map((job) => ({ raw: job, parsed: nativeJobSchema.parse(job) }));
    if (matches.length !== 1)
      throw new StoreAuthorityError(
        "Native async task requires one correlated caller-owned task job",
      );
    const match = matches[0];
    if (!match)
      throw new StoreAuthorityError("Native task job correlation missing");
    nativeJobObservers.add(observation);
    void match.parsed.promise
      .then(() => {
        if (!nativeJobObservers.has(observation) || !observation.current())
          return;
        const terminal = nativeJobSchema.parse(match.raw);
        if (
          terminal.id !== match.parsed.id ||
          terminal.ownerId !== observation.ownerId ||
          terminal.type !== "task" ||
          terminal.agentId !== observation.nativeId
        )
          throw new StoreAuthorityError("Native terminal job identity changed");
        if (terminal.status === "running") return;
        const progress = nativeDispatchSchema
          .parse(terminal.latestDetails)
          .progress.find((entry) => entry.id === observation.nativeId);
        if (
          !progress ||
          progress.agent !== observation.agent ||
          !(terminal.status === "completed"
            ? progress.status === "completed"
            : ["failed", "aborted"].includes(progress.status))
        )
          throw new StoreAuthorityError(
            "Native terminal progress does not match its task job",
          );
        rootAdmin(input.ctx);
        observation.authorize();
        observation.settle(terminal.status);
      })
      .catch((error: unknown) => {
        process.stderr.write(
          JSON.stringify({
            level: "warning",
            component: "startup-native-task",
            ownerId: observation.ownerId,
            nativeId: observation.nativeId,
            jobId: match.parsed.id,
            error: error instanceof Error ? error.message : String(error),
          }) + "\n",
        );
      })
      .finally(() => nativeJobObservers.delete(observation));
  }
  function ordinaryAuthority(ctx: NativeContext): NativeRef {
    const ref = registry.get(ctx.agent.id);
    const parked =
      ref?.session === null &&
      ["parked", "idle", "completed", "aborted"].includes(ref.status);
    if (
      !ref ||
      (!parked &&
        ref.session?.sessionManager.getSessionId() !==
          ctx.sessionManager.getSessionId())
    )
      throw new StoreAuthorityError(
        "Ordinary native caller differs from registry evidence",
      );
    let ancestor: NativeRef | undefined = ref;
    const seen: Set<string> = new Set();
    while (ancestor?.parentId) {
      if (seen.has(ancestor.id))
        throw new StoreAuthorityError("Native registry parent cycle");
      seen.add(ancestor.id);
      ancestor = registry.get(ancestor.parentId);
    }
    if (
      ancestor?.id !== rootId ||
      ancestor.session?.sessionManager.getSessionId() !== rootSession
    )
      throw new StoreAuthorityError(
        "Ordinary task caller is outside the bound root",
      );
    if (parked) {
      if (
        !ref.sessionFile ||
        ref.sessionFile !== ctx.sessionManager.getSessionFile()
      )
        throw new StoreAuthorityError(
          "Parked ordinary caller transcript differs from retained native evidence",
        );
      const headers = readFileSync(ref.sessionFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) =>
          z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)),
        )
        .filter((entry) => entry.type === "session");
      if (headers.length !== 1)
        throw new StoreAuthorityError(
          "Parked ordinary caller requires one retained session header",
        );
      const header = headerSchema.parse(headers[0]);
      if (
        header.id !== ctx.sessionManager.getSessionId() ||
        header.parentSession !== registry.get(ref.parentId ?? "")?.sessionFile
      )
        throw new StoreAuthorityError(
          "Parked ordinary caller session ancestry changed",
        );
    }
    if (
      ref.id === rootId ||
      /(?:^|\n)STARTUP_BINDING=/.test(ctx.getSystemPrompt().join("\n"))
    )
      boundCaller(ctx, ref);
    store.renewLease();
    return ref;
  }
  async function ordinary(
    ctx: NativeContext,
    params: Record<string, unknown>,
  ): Promise<NativeResult> {
    if (!ctx.invokeTool)
      throw new StoreAuthorityError(
        "Ordinary native task requires the actual same-name handler",
      );
    const ref = ordinaryAuthority(ctx);
    const jobs = ref.session?.asyncJobManager;
    const previousJobs = nativeJobIds(jobs, ref.id);
    const count = Array.isArray(params.tasks) ? params.tasks.length : 1;
    const available = capacity().available;
    if (available !== null && count > available)
      throw new StoreAuthorityError(
        "Aggregate Startup execution capacity prevents this bounded native task launch",
      );
    const reservations = Array.from({ length: count }, () => randomUUID());
    for (const token of reservations) ordinaryAdmissions.set(token, null);
    let result: NativeResult;
    try {
      result = await ctx.invokeTool(params);
    } catch (error: unknown) {
      for (const token of reservations) ordinaryAdmissions.delete(token);
      throw error;
    }
    const parsed = nativeDispatchSchema.safeParse(result.details);
    const settled = z
      .object({
        results: z.array(
          z
            .object({
              index: timeSchema,
              id: idSchema,
              exitCode: z.number().int(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .safeParse(result.details);
    if (
      settled.success &&
      reservations.every((_token, index) =>
        settled.data.results.some((result) => result.index === index),
      )
    ) {
      for (const token of reservations) ordinaryAdmissions.delete(token);
    } else if (parsed.success) {
      for (const [index, token] of reservations.entries()) {
        const progress = parsed.data.progress.find(
          (progress) => progress.index === index,
        );
        if (!progress) {
          ordinaryAdmissions.delete(token);
          continue;
        }
        const actual = registry.get(progress.id);
        if (
          ["idle", "completed", "failed", "aborted", "error"].includes(
            progress.status,
          ) ||
          (actual && ["idle", "aborted"].includes(actual.status))
        )
          ordinaryAdmissions.delete(token);
        else ordinaryAdmissions.set(token, progress.id);
      }
    } else if (
      z
        .object({
          projectAgentsDir: z.null(),
          results: z.array(z.unknown()).length(0),
          totalDurationMs: z.literal(0),
        })
        .safeParse(result.details).success
    ) {
      for (const token of reservations) ordinaryAdmissions.delete(token);
    } else if (
      result.isError ||
      z.object({ error: z.string() }).safeParse(result.details).success
    ) {
      for (const token of reservations) ordinaryAdmissions.delete(token);
    } else
      throw new StoreAuthorityError(
        "Native task returned no correlated progress or rejection; execution admission remains reserved pending native evidence",
      );
    if (
      z
        .object({ async: z.object({ type: z.literal("task") }).passthrough() })
        .safeParse(result.details).success &&
      parsed.success
    ) {
      if (!jobs)
        throw new StoreAuthorityError(
          "Native async task requires terminal job observation capability",
        );
      for (const [index, token] of reservations.entries()) {
        const progress = parsed.data.progress.find(
          (entry) => entry.index === index,
        );
        if (!progress || ordinaryAdmissions.get(token) !== progress.id)
          continue;
        observeNativeJob({
          ownerId: ref.id,
          nativeId: progress.id,
          agent: progress.agent,
          jobs,
          previousIds: previousJobs,
          current: () => ordinaryAdmissions.get(token) === progress.id,
          authorize: () => {
            ordinaryAuthority(ctx);
          },
          settle: () => {
            ordinaryAdmissions.delete(token);
          },
        });
      }
    }
    return result;
  }
  function reserve(ctx: NativeContext, request: unknown): HireReceipt {
    const managerBinding: Binding = manager(ctx);
    const parsed = hireInputSchema.parse(request);
    const profile: Profile = loadProfile({
      skillsRoot: config.skillsRoot,
      role: parsed.role,
      employeeId: "source-validation",
      generation: 1,
    });
    const existing = store
      .snapshot()
      .hires.find((entry) => entry.request.requestId === parsed.requestId);
    if (
      !existing &&
      config.employeeLimit !== null &&
      capacity().employees + parsed.additional > config.employeeLimit
    )
      throw new StoreAuthorityError(
        "Explicit employee capacity prevents this additional hire",
      );
    return store.reserveHire({
      authority: { kind: "employee", binding: managerBinding },
      request: {
        requestId: parsed.requestId,
        role: parsed.role,
        additional: parsed.additional,
        revision: existing?.request.revision ?? profile.source.roleRevision,
      },
    });
  }
  function bindLoaded(
    receipt: Readonly<{
      nativeId: string;
      sessionId: string;
      profile: Profile;
    }>,
  ): void {
    const ref = registry.get(receipt.nativeId);
    if (
      !ref?.session ||
      ref.parentId !== rootId ||
      ref.session.sessionManager.getSessionId() !== receipt.sessionId
    )
      throw new StoreAuthorityError(
        "Source-loaded native session changed before dispatch binding",
      );
    verifyProfile(receipt.profile);
    if (!["running", "working", "starting", "pending"].includes(ref.status))
      admissions.delete(receipt.profile.employeeId);
    const employee = snapshotEmployee(receipt.profile.employeeId);
    store.bindEmployee({
      manager: store.managerBinding,
      binding: {
        employeeId: employee.id,
        generation: receipt.profile.generation,
        nativeHandle: nativeHandle(receipt.nativeId, receipt.sessionId),
        assignment: employee.assignment,
        source: receipt.profile.source,
      },
    });
    receipts.set(receipt.nativeId, receipt);
    loaded.delete(receipt.nativeId);
    expected.set(employee.id, {
      profile: receipt.profile,
      nativeId: receipt.nativeId,
      sessionId: receipt.sessionId,
    });
  }
  function itemInfo() {
    const snapshot = store.snapshot();
    return store.queueItems().map((row) => {
      const ownership = snapshot.queueRevisions.find(
        (owner) => owner.id === row.id,
      );
      const team =
        ownership === undefined
          ? undefined
          : snapshot.teams.find((team) => team.eventId === ownership.eventId);
      const execution = snapshot.itemExecutions.find(
        (execution) =>
          execution.itemId === row.id &&
          execution.eventId === ownership?.eventId,
      );
      const result = (messageId: string | null | undefined) => {
        const claim = snapshot.claims.find(
          (claim) =>
            claim.messageId === messageId && claim.status === "settled",
        );
        return (
          snapshot.results.find(
            (result) =>
              result.claimId === claim?.id &&
              result.result.kind === "completed",
          )?.result.id ?? null
        );
      };
      return {
        id: row.id,
        status: z.string().parse(row.status),
        revision: ownership?.revision ?? 0,
        eventId: ownership?.eventId ?? null,
        teamId: team?.id ?? null,
        employeeId: execution?.employeeId ?? null,
        executionMessageId: execution?.messageId ?? null,
        reviewResultId: execution?.reviewResultId ?? null,
        devResultId: result(execution?.messageId),
        qaMessageId: execution?.qaMessageId ?? null,
        qaResultId: result(execution?.qaMessageId),
        qaVerdict: execution?.qa?.verdict ?? null,
      };
    });
  }
  function availableTeamDevs(team: Team): readonly string[] {
    const snapshot = store.snapshot();
    return team.devs.filter(
      (id) =>
        !snapshot.assignments.some(
          (assignment) =>
            assignment.employeeId === id && assignment.state !== "complete",
        ) &&
        !snapshot.claims.some(
          (claim) => claim.employeeId === id && claim.status !== "settled",
        ),
    );
  }
  async function item(
    ctx: NativeContext,
    request: unknown,
  ): Promise<ItemTransition> {
    const saved = store.transitionItem({
      employee: caller(ctx),
      request: itemActionSchema.parse(request),
    });
    for (const draft of saved.cues) {
      const message = store
        .snapshot()
        .messages.find(
          (message) =>
            message.id === draft.cue.id && message.status === "pending",
        );
      if (message) await wake(message);
    }
    return saved;
  }
  async function projection(ctx: NativeContext): Promise<string | null> {
    const candidate = registry.get(ctx.agent.id);
    if (
      candidate?.id !== rootId &&
      !receipts.has(ctx.agent.id) &&
      ![...expected.values()].some((entry) =>
        ctx.getSystemPrompt().join("\n").includes(entry.profile.marker),
      )
    ) {
      if (/(?:^|\n)STARTUP_BINDING=/.test(ctx.getSystemPrompt().join("\n")))
        throw new StoreFenceError(
          "Native Startup profile generation is superseded or unproven",
        );
      return null;
    }
    const ref: NativeRef = nativeRef(ctx);
    if (ref.id === rootId) {
      verifyProfile(managerProfile);
      return projectEmployee({
        profile: managerProfile,
        checkpoint: snapshotEmployee("manager").checkpoint,
        cue: managerReady
          ? projectedCue(
              store
                .snapshot()
                .messages.find(
                  (entry) =>
                    entry.recipient === "manager" &&
                    entry.status !== "acknowledged" &&
                    blockedMessage(entry) === null,
                ) ?? null,
            )
          : null,
        team: {
          items: itemInfo()
            .filter((item) => !terminalItemStatuses.includes(item.status))
            .slice(0, 64),
          receivedInputs: store
            .snapshot()
            .inputs.filter((entry) => entry.disposition === null)
            .slice(0, 8)
            .map(inputMetadata),
          mode: managerReady ? "ready" : "recovery",
          unresolvedManagerClaims: store
            .snapshot()
            .claims.filter(
              (claim) =>
                claim.employeeId === "manager" && claim.status !== "settled",
            )
            .map((claim) => claim.id),
          unreleasedManagerGrants: store
            .snapshot()
            .grants.filter(
              (grant) =>
                grant.employeeId === "manager" && grant.state !== "released",
            )
            .map((grant) => grant.id),
        },
      });
    }
    let receipt = receipts.get(ref.id);
    if (!receipt) {
      const prompt: string = ctx.getSystemPrompt().join("\n");
      const candidates = [...expected.values()].filter((entry) =>
        prompt.includes(entry.profile.marker),
      );
      if (candidates.length !== 1) return null;
      const reservation = candidates[0];
      if (
        !reservation ||
        (reservation.nativeId !== null && reservation.nativeId !== ref.id) ||
        (reservation.sessionId !== null &&
          reservation.sessionId !== ctx.sessionManager.getSessionId())
      )
        throw new StoreAuthorityError(
          "Native dispatch identity differs from source reservation",
        );
      const profile: Profile = reservation.profile;
      if (!prompt.includes(profileText(profile).trim()))
        throw new StoreAuthorityError(
          "Native profile did not load complete canonical role and loop sources",
        );
      const employee: Employee = snapshotEmployee(profile.employeeId);
      receipt = {
        nativeId: ref.id,
        sessionId: ctx.sessionManager.getSessionId(),
        profile,
      };
      loaded.set(ref.id, receipt);
      if (reservation.nativeId === null)
        return projectEmployee({
          profile,
          checkpoint: employee.checkpoint,
          cue: null,
          team: null,
        });
      bindLoaded(receipt);
      const assigned =
        employee.assignment === null
          ? undefined
          : store
              .snapshot()
              .teams.find((entry) => entry.id === employee.assignment);
      if (assigned) await wakeTeam(assigned);
    }
    caller(ctx);
    const employee: Employee = snapshotEmployee(receipt.profile.employeeId);
    const pending: Message | null =
      store
        .snapshot()
        .messages.find(
          (entry) =>
            entry.recipient === employee.id &&
            entry.status !== "acknowledged" &&
            blockedMessage(entry) === null,
        ) ?? null;
    const team: Team | null =
      employee.assignment === null
        ? null
        : (store
            .snapshot()
            .teams.find((entry) => entry.id === employee.assignment) ?? null);
    return projectEmployee({
      profile: receipt.profile,
      checkpoint: employee.checkpoint,
      cue: team?.state === "reserved" ? null : projectedCue(pending),
      team:
        team === null
          ? null
          : {
              id: team.id,
              items: itemInfo()
                .filter((item) => item.teamId === team.id)
                .slice(0, 64),
              availableDevs: availableTeamDevs(team),
              architect: team.architect,
              qa: team.qa,
              devs: team.devs,
              state: team.state,
              eventId: team.eventId,
            },
    });
  }
  function notifyManager(message: Message): Json {
    store.renewLease();
    const current = registry.get(rootId);
    if (
      message.recipient !== "manager" ||
      !current?.session ||
      current.session.sessionManager.getSessionId() !== rootSession
    )
      throw new StoreAuthorityError(
        "Manager notification requires the actual current owning root session",
      );
    try {
      input.notifyManager(message.id);
    } catch (error: unknown) {
      deliveries.set(message.id, {
        kind: "manager-notification-failed",
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const attempt: Json = {
      kind: "manager-notification-attempt",
      nativeId: rootId,
      sessionId: rootSession,
      messageId: message.id,
    };
    deliveries.set(message.id, attempt);
    return attempt;
  }
  async function wake(message: Message): Promise<Json> {
    const blockedItem = blockedMessage(message);
    if (blockedItem !== null) {
      const reason: Json = {
        kind: "dependency-blocked",
        messageId: message.id,
        itemId: blockedItem,
      };
      deliveries.set(message.id, reason);
      pendingWakes.add(message.id);
      return reason;
    }
    const employee: Employee = snapshotEmployee(message.recipient);
    if (employee.nativeHandle === null)
      throw new StoreAuthorityError(
        `Persisted cue ${message.id} awaits authorized native activation`,
      );
    const handle =
      employee.id === "manager"
        ? { id: rootId, sessionId: rootSession }
        : decodeHandle(employee.nativeHandle);
    const ref: NativeRef | undefined = registry.get(handle.id);
    if (
      ref?.session &&
      (ref.session.sessionManager.getSessionId() !== handle.sessionId ||
        (ref.id !== rootId && ref.parentId !== rootId))
    )
      throw new StoreAuthorityError(
        "Native wake recipient differs from the persisted scoped binding",
      );
    const content: string = `Startup inbox cue ${message.id} is durable. Claim your own inbox and follow the canonical loop.`;
    let result: NativeResult;
    if (employee.id === "manager") {
      return notifyManager(message);
    } else {
      const decision = admit(employee.id, employee.generation, handle.id);
      if (decision === "blocked") {
        const reason: Json = {
          kind: "capacity-blocked",
          messageId: message.id,
          employeeId: employee.id,
        };
        deliveries.set(message.id, reason);
        blockers.set(employee.id, { kind: "capacity" });
        pendingWakes.add(message.id);
        return reason;
      }

      const write = registry.get(rootId)?.session?.getToolByName("write");
      if (!write)
        throw new StoreAuthorityError(
          "Native agent:// write wake transport is unavailable",
        );
      try {
        result = await write.execute(`startup-wake-${message.id}`, {
          path: `agent://${handle.id}`,
          content,
        });
      } catch (error: unknown) {
        if (decision === "reserved") admissions.delete(employee.id);
        throw error;
      }
    }
    if (result.isError) {
      admissions.delete(employee.id);
      throw new StoreAuthorityError(
        `Native wake failed: ${encode(jsonSchema.parse(result))}`,
      );
    }
    const details: unknown = z
      .object({ message: z.unknown() })
      .parse(result.details).message;
    const parsed = nativeWakeSchema.parse(details);
    const receipt = parsed.receipts.find((entry) => entry.to === handle.id);
    if (
      !receipt ||
      !["injected", "woken", "revived"].includes(receipt.outcome)
    ) {
      admissions.delete(employee.id);
      throw new StoreAuthorityError(
        `Native wake was not accepted: ${encode(jsonSchema.parse(result.details))}`,
      );
    }
    const restored = registry.get(handle.id);
    if (
      !restored?.session ||
      restored.parentId !== rootId ||
      restored.session.sessionManager.getSessionId() !== handle.sessionId
    )
      throw new StoreAuthorityError(
        "Native persisted roster wake did not restore the actual scoped session",
      );
    const evidence: Json = {
      nativeId: handle.id,
      sessionId: handle.sessionId,
      outcome: receipt.outcome,
      messageId: message.id,
    };
    deliveries.set(message.id, evidence);
    return evidence;
  }
  async function wakeTeam(team: Team): Promise<void> {
    if (team.state === "reserved") return;
    const messages: readonly Message[] = store
      .snapshot()
      .messages.filter(
        (entry) => entry.teamId === team.id && entry.status === "pending",
      );
    for (const message of messages)
      if (
        !deliveries.has(message.id) ||
        z
          .object({ kind: z.enum(["capacity-blocked", "dependency-blocked"]) })
          .safeParse(deliveries.get(message.id)).success
      )
        await wake(message);
  }
  async function activate(
    ctx: NativeContext,
    ids: readonly string[],
  ): Promise<
    Readonly<{ employees: readonly Employee[]; native: NativeResult | null }>
  > {
    manager(ctx);
    if (!ctx.invokeTool)
      throw new StoreAuthorityError(
        "Activation must execute inside the same-name native task handler",
      );
    const jobs = nativeRef(ctx).session?.asyncJobManager;
    const previousJobs = nativeJobIds(jobs, rootId);
    const staff: readonly Employee[] = ids.map(snapshotEmployee);
    const unbound: readonly Employee[] = staff.filter((entry) => {
      const prior = expected.get(entry.id);
      return (
        entry.nativeHandle === null &&
        entry.employment === "hired" &&
        !(
          prior &&
          prior.profile.generation === entry.generation + 1 &&
          entry.error === null
        )
      );
    });
    if (unbound.length === 0) return { employees: staff, native: null };
    const available: number | null = capacity().available;
    const selected: readonly Employee[] =
      available === null ? unbound : unbound.slice(0, available);
    if (selected.length === 0) {
      for (const employee of unbound)
        blockers.set(employee.id, { kind: "capacity" });
      return { employees: staff, native: null };
    }
    const tasks: Record<string, unknown>[] = [];
    const prepared: Profile[] = [];
    for (const employee of selected) {
      const team: Team | undefined =
        employee.assignment === null
          ? undefined
          : store
              .snapshot()
              .teams.find((entry) => entry.id === employee.assignment);
      const generation: number =
        team?.generations[employee.id] ?? employee.generation + 1;
      const profile: Profile = loadProfile({
        skillsRoot: config.skillsRoot,
        role: employee.role,
        employeeId: employee.id,
        generation,
      });
      if (profile.source.roleRevision !== employee.canonicalRevision)
        throw new StoreAuthorityError(
          "Canonical role source differs from the hire reservation",
        );
      writeProfile({ root: rootDirectory, profile });
      prepared.push(profile);
      tasks.push({
        name: `${employee.id}-${generation}`,
        agent: profile.name,
        task: "Load the complete canonical role and loop. Claim your own inbox. An incompletely bound team returns no claim; yield and wait for the durable team wake.",
        solutionSpace:
          "Use only assigned authority. Hiring grants no mutation authority. Report through your architect; architect reports to manager.",
      });
    }
    const context: string =
      "Startup canonical employee activation. Raw intake remains in each employee own durable inbox. Wait for full team binding before scoped intake.";
    const batch: boolean = input.nativeBatch();
    const dispatched: NativeResult[] = [];
    for (const profile of prepared) {
      const previousId = expected.get(profile.employeeId)?.nativeId;
      if (previousId) nativeFailures.delete(previousId);
      expected.set(profile.employeeId, { profile, nativeId: null, sessionId: null });
    }
    for (const employee of selected) {
      const profile = expected.get(employee.id)?.profile;
      if (!profile)
        throw new StoreAuthorityError("Activation source reservation missing");
      if (admit(employee.id, profile.generation, null) === "blocked")
        throw new StoreAuthorityError(
          "Activation lost reserved execution capacity",
        );
    }
    function correlate(native: NativeResult, selected: readonly Employee[]): void {
    const parsed = nativeActivationSchema.safeParse(native.details);
    if (!parsed.success) {
      for (const employee of selected) {
        admissions.delete(employee.id);
        store.recordBindingFailure({
          manager: store.managerBinding,
          employeeId: employee.id,
          error: `Native dispatch rejected activation: ${JSON.stringify(native)}`,
        });
      }
      return;
    }
    for (const [index, employee] of selected.entries()) {
      const progress = parsed.data.progress.find(
        (entry) => entry.index === index,
      );
      const reservation = expected.get(employee.id);
      if (!progress || !reservation) {
        admissions.delete(employee.id);
        store.recordBindingFailure({
          manager: store.managerBinding,
          employeeId: employee.id,
          error: "Native dispatch omitted correlated progress",
        });
        continue;
      }
      if (reservation.nativeId !== null && reservation.nativeId !== progress.id)
        throw new StoreAuthorityError(
          "Source-loaded native actor differs from dispatch progress",
        );
      const sourceReceipts = [...loaded.values()].filter(
        (entry) =>
          entry.profile.employeeId === employee.id &&
          entry.profile.generation === reservation.profile.generation,
      );
      if (sourceReceipts.some((entry) => entry.nativeId !== progress.id)) {
        store.recordBindingFailure({
          manager: store.managerBinding,
          employeeId: employee.id,
          error: "Native source projection differs from dispatch identity",
        });
        throw new StoreAuthorityError(
          "Native source projection differs from dispatch identity",
        );
      }
      expected.set(employee.id, {
        profile: reservation.profile,
        nativeId: progress.id,
        sessionId: reservation.sessionId,
      });
      if (
        ["failed", "aborted", "error", "idle", "completed"].includes(
          progress.status,
        )
      )
        admissions.delete(employee.id);
      const failedReason = nativeFailures.get(progress.id);
      const sourceReceipt = loaded.get(progress.id);
      if (
        sourceReceipt &&
        failedReason === undefined &&
        !["failed", "aborted", "error"].includes(progress.status)
      )
        bindLoaded(sourceReceipt);
      if (failedReason !== undefined) nativeEnded(progress.id, failedReason);
      if (progress.status === "completed" && snapshotEmployee(employee.id).nativeHandle === null)
        nativeEnded(progress.id, "completed without verified source binding");
      if (["failed", "aborted", "error"].includes(progress.status))
        store.recordBindingFailure({
          manager: store.managerBinding,
          employeeId: employee.id,
          error: `Native activation ${progress.status}`,
        });
      blockers.delete(employee.id);
    }
    if (
      [native].some(
        (result) =>
          z
            .object({
              async: z.object({ type: z.literal("task") }).passthrough(),
            })
            .safeParse(result.details).success,
      )
    ) {
      if (!jobs)
        throw new StoreAuthorityError(
          "Native async activation requires terminal job observation capability",
        );
      for (const employee of selected) {
        const reservation = expected.get(employee.id);
        if (
          !reservation?.nativeId ||
          snapshotEmployee(employee.id).nativeHandle !== null
        )
          continue;
        const nativeId = reservation.nativeId;
        observeNativeJob({
          ownerId: rootId,
          nativeId,
          agent: reservation.profile.name,
          jobs,
          previousIds: previousJobs,
          current: () => expected.get(employee.id) === reservation,
          authorize: () => {
            rootAdmin(ctx);
            verifyProfile(reservation.profile);
          },
          settle: (status) => {
            const pending = snapshotEmployee(employee.id);
            if (
              pending.nativeHandle !== null ||
              pending.generation + 1 !== reservation.profile.generation
            )
              return;
            nativeEnded(
              nativeId,
              status === "completed"
                ? "completed without verified source binding"
                : status === "cancelled"
                  ? "aborted"
                  : "failed",
            );
            if (admissions.get(employee.id) === reservation.profile.generation)
              admissions.delete(employee.id);
          },
        });
      }
    }
    }
    const completed = new Set<string>();
    try {
      if (batch) {
        const result = await ctx.invokeTool({ context, tasks });
        correlate(result, selected);
        dispatched.push(result);
        for (const employee of selected) completed.add(employee.id);
      } else {
        for (const [index, task] of tasks.entries()) {
          const employee = selected[index]!;
          const result = await ctx.invokeTool({ ...task, task: `${context}\n${String(task.task)}` });
          correlate(result, [employee]);
          dispatched.push(result);
          completed.add(employee.id);
        }
      }
    } catch (error: unknown) {
      for (const employee of selected.filter((entry) => !completed.has(entry.id))) {
        expected.delete(employee.id);
        admissions.delete(employee.id);
        store.recordBindingFailure({
          manager: store.managerBinding,
          employeeId: employee.id,
          error: `Native dispatch threw for ${employee.id}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw error;
    }
    const native: NativeResult = dispatched.length === 1 ? dispatched[0]! : {
      content: dispatched.flatMap((entry) => entry.content),
      details: { progress: dispatched.flatMap((entry, index) => {
        const parsed = nativeActivationSchema.safeParse(entry.details);
        return parsed.success ? parsed.data.progress.map((progress) => ({ ...progress, index })) : [];
      }) },
      isError: dispatched.some((entry) => entry.isError || !nativeActivationSchema.safeParse(entry.details).success),
    };
    for (const team of store.snapshot().teams) await wakeTeam(team);
    return { employees: ids.map(snapshotEmployee), native };
  }
  function receiveInput(ctx: NativeContext, event: unknown) {
    const parsed = nativeInputSchema.parse(event);
    if (ctx.agent.id !== rootId || parsed.source === "extension") return null;
    nativeRef(ctx);
    return store.receiveInput({
      id: randomUUID(),
      receivedAt: now(),
      source: parsed.source,
      raw: { text: parsed.text, images: parsed.images ?? [] },
      disposition: null,
    });
  }
  function routeInput(ctx: NativeContext, request: unknown) {
    const parsed = routeInputSchema.parse(request);
    return inputMetadata(
      store.routeInput({
        manager: rootAdmin(ctx),
        inputId: parsed.inputId,
        disposition: {
          kind: parsed.disposition,
          reason: parsed.reason,
          amendItemIds: parsed.amendItemIds,
        },
      }),
    );
  }
  function scopedInput(ctx: NativeContext, inputId: string): Json {
    const snapshot = store.snapshot();
    const binding = ctx.agent.id === rootId ? rootAdmin(ctx) : caller(ctx);
    const received = snapshot.inputs.find((entry) => entry.id === inputId);
    const intake = snapshot.intakes.find(
      (entry) => entry.request.eventId === inputId,
    );
    const assigned =
      intake?.teamId === null || intake?.teamId === undefined
        ? null
        : snapshot.teams.find((team) => team.id === intake.teamId);
    const allowed =
      binding.employeeId === "manager"
        ? received?.disposition === null ||
          (assigned !== null &&
            assigned !== undefined &&
            assigned.state !== "finished")
        : assigned !== null &&
          assigned !== undefined &&
          ["ready", "active", "waiting", "reconciliation"].includes(
            assigned.state,
          ) &&
          [assigned.architect, assigned.qa, ...assigned.devs].includes(
            binding.employeeId,
          ) &&
          snapshotEmployee(binding.employeeId).assignment === assigned.id;
    if (!allowed)
      throw new StoreAuthorityError(
        "Input retrieval requires a selected current manager input or the active owning team",
      );
    const raw = received?.raw ?? intake?.request.input;
    if (raw === undefined)
      throw new StoreAuthorityError("Scoped input is unavailable");
    return jsonSchema.parse(raw);
  }
  function readInput(ctx: NativeContext, request: unknown) {
    const parsed = z
      .strictObject({
        inputId: idSchema,
        offset: z.number().int().nonnegative().safe(),
      })
      .parse(request);
    const raw = scopedInput(ctx, parsed.inputId);
    const input = rawInputSchema.safeParse(raw);
    const text = input.success
      ? input.data.text
      : typeof raw === "string"
        ? raw
        : encode(raw);
    if (parsed.offset > text.length)
      throw new StoreAuthorityError("Input offset exceeds stored text length");
    return {
      ...inputSummary(parsed.inputId, raw),
      offset: parsed.offset,
      text: text.slice(parsed.offset, parsed.offset + 4096),
      nextOffset:
        parsed.offset + 4096 < text.length ? parsed.offset + 4096 : null,
    };
  }
  function image(ctx: NativeContext, request: unknown): NativeResult {
    const parsed = z
      .strictObject({
        inputId: idSchema,
        index: z.number().int().nonnegative().safe(),
      })
      .parse(request);
    const raw = rawInputSchema.parse(scopedInput(ctx, parsed.inputId));
    const image = imageSchema.parse(raw.images[parsed.index]);
    return {
      content: [image],
      details: {
        inputId: parsed.inputId,
        index: parsed.index,
        mimeType: image.mimeType,
      },
    };
  }
  function recordIntake(ctx: NativeContext, event: unknown) {
    const saved = store.recordIntake({
      manager: manager(ctx),
      event: intakeInputSchema.parse(event),
    });
    return { ...saved, input: inputSummary(saved.eventId, saved.input) };
  }
  async function delegate(ctx: NativeContext, request: unknown): Promise<Team> {
    const binding: Binding = manager(ctx);
    const parsed = delegateInputSchema.parse(request);
    store.recordTeamRequirement({
      manager: binding,
      request: { eventId: parsed.eventId, developers: parsed.developers },
    });
    const event = store
      .snapshot()
      .intakes.find((entry) => entry.request.eventId === parsed.eventId);
    if (!event)
      throw new StoreAuthorityError("Persist raw intake before delegating it");
    if (event.teamId !== null) {
      const prior = store
        .snapshot()
        .teams.find((entry) => entry.id === event.teamId);
      if (!prior) throw new StoreAuthorityError("Saved intake team is missing");
      if (prior.devs.length !== parsed.developers)
        throw new StoreAuthorityError("Conflicting intake team retry");
      await activate(ctx, [prior.architect, prior.qa, ...prior.devs]);
      return (
        store.snapshot().teams.find((entry) => entry.id === prior.id) ?? prior
      );
    }
    for (const role of ["architect", "qa", "dev"] as const) {
      const count = role === "dev" ? parsed.developers : 1;
      for (const employee of reusableStaff(store.snapshot(), role).slice(0, count)) {
        const profile = loadProfile({ skillsRoot: config.skillsRoot, role, employeeId: employee.id, generation: employee.generation + 1 });
        if (profile.source.roleRevision !== employee.canonicalRevision)
          throw new StoreAuthorityError(`Canonical role source differs for ${employee.id}; use startup_refresh before delegation`);
      }
    }
    const members: string[] = [];
    for (const role of ["architect", "qa", "dev"] as const) {
      const count: number = role === "dev" ? parsed.developers : 1;
      const eligible: readonly Employee[] = reusableStaff(
        store.snapshot(),
        role,
      ).slice(0, count);
      members.push(...eligible.map((entry) => entry.id));
      if (eligible.length < count) {
        const hire = reserve(ctx, {
          startup: "hire",
          requestId: `intake-${parsed.eventId}-${role}`,
          role,
          additional: count - eligible.length,
        });
        members.push(...hire.employees.map((entry) => entry.id));
      }
    }
    const architect: string | undefined = members[0];
    const qa: string | undefined = members[1];
    if (!architect || !qa)
      throw new StoreAuthorityError(
        "Complete architect and QA team membership is required",
      );
    const devs: string[] = members.slice(2);
    const team: Team = store.reserveTeam({
      manager: binding,
      request: {
        eventId: parsed.eventId,
        architect,
        qa,
        devs,
        cues: members.map((id) => ({
          id: `intake-${parsed.eventId}-${id}`,
          recipient: id,
          kind: "assignment",
          correlation: parsed.eventId,
          payload:
            id === architect
              ? {
                  kind: "architect-intake",
                  raw: event.request.input,
                  amendItemIds: event.request.amendItemIds,
                }
              : { kind: "team-assignment", architect, eventId: parsed.eventId },
        })),
      },
    });
    await activate(ctx, members);
    return store.snapshot().teams.find((entry) => entry.id === team.id) ?? team;
  }
  async function send(ctx: NativeContext, cue: unknown): Promise<Message> {
    const message: Message = store.sendCue({
      sender: caller(ctx),
      cue: cueSchema.parse(cue),
    });
    await wake(message);
    return message;
  }
  function supervisor(employee: Employee): string {
    const team = store
      .snapshot()
      .teams.find((entry) => entry.id === employee.assignment);
    return team && team.architect !== employee.id ? team.architect : "manager";
  }
  async function settle(ctx: NativeContext, request: unknown) {
    const parsed = settleInputSchema.parse(request);
    const binding = caller(ctx);
    const employee = snapshotEmployee(binding.employeeId);
    const result =
      parsed.result.kind === "completed"
        ? parsed.result
        : {
            ...parsed.result,
            outgoing: [
              ...parsed.result.outgoing,
              {
                id: `${parsed.result.id}-concern`,
                recipient: supervisor(employee),
                kind: parsed.result.kind === "question" ? "question" : "alert",
                correlation: parsed.claimId,
                payload: {
                  resultId: parsed.result.id,
                  kind: parsed.result.kind,
                  output: parsed.result.output,
                },
              },
            ],
          };
    const settlement = store.settleClaim({
      employee: binding,
      claimId: parsed.claimId,
      result: resultSchema.parse(result),
    });
    for (const message of settlement.messages) await wake(message);
    return settlement;
  }
  function nativeEnded(nativeId: string, reason: string): void {
    if (["idle", "completed", "failed", "aborted"].includes(reason))
      for (const [token, id] of ordinaryAdmissions)
        if (id === nativeId) ordinaryAdmissions.delete(token);
    const receipt = receipts.get(nativeId);
    if (!receipt) {
      if (reason === "idle") return;
      nativeFailures.set(nativeId, reason);
      const planned = [...expected.values()].find(
        (entry) => entry.nativeId === nativeId,
      );
      if (planned) {
        const employee = snapshotEmployee(planned.profile.employeeId);
        if (
          employee.generation + 1 !== planned.profile.generation ||
          employee.nativeHandle !== null ||
          employee.error !== null
        )
          return;
        store.recordBindingFailure({
          manager: store.managerBinding,
          employeeId: employee.id,
          error: `Native activation ${reason}`,
        });
        const cue = store.sendCue({
          sender: store.managerBinding,
          cue: {
            id: `native-activation-alert-${nativeId}-${planned.profile.generation}`,
            recipient: "manager",
            kind: "alert",
            correlation: employee.id,
            payload: {
              nativeId,
              reason,
              generation: planned.profile.generation,
            },
          },
        });
        notifyManager(cue);
      }
      return;
    }
    const employee = snapshotEmployee(receipt.profile.employeeId);
    if (
      employee.generation !== receipt.profile.generation ||
      employee.nativeHandle !==
        nativeHandle(receipt.nativeId, receipt.sessionId) ||
      employee.employment !== "hired" ||
      employee.error !== null
    )
      return;
    const unfinishedClaims = store
      .snapshot()
      .claims.filter(
        (claim) =>
          claim.employeeId === employee.id && claim.status === "active",
      );
    const unfinished = unfinishedClaims.length > 0;
    if (!unfinished && reason === "idle") return;
    const binding: Binding = {
      employeeId: employee.id,
      generation: employee.generation,
      nativeHandle: nativeHandle(receipt.nativeId, receipt.sessionId),
    };
    const cue = store.sendCue({
      sender: binding,
      cue: {
        id: `native-alert-${nativeId}-${employee.generation}`,
        recipient: supervisor(employee),
        kind: "alert",
        correlation: employee.assignment ?? employee.id,
        payload: {
          reason,
          nativeId,
          generation: employee.generation,
          unresolved: unfinished,
          claimIds: unfinishedClaims.map((claim) => claim.id),
          messageIds: unfinishedClaims.map((claim) => claim.messageId),
          employeeId: employee.id,
          teamId: employee.assignment,
          ownerEpoch: store.ownerEpoch,
        },
      },
    });
    store.recordBindingFailure({
      manager: store.managerBinding,
      employeeId: employee.id,
      error: `Native ${reason}; durable unfinished work requires reconciliation`,
    });
    if (cue.recipient === "manager") notifyManager(cue);
    else pendingWakes.add(cue.id);
  }
  const blockerSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("capacity") }),
    z.strictObject({ kind: z.literal("resource"), target: idSchema }),
    z.strictObject({ kind: z.literal("dependency"), itemId: idSchema }),
    z.strictObject({ kind: z.literal("employee-limit") }),
  ]);
  function blockerCurrent(key: string, evidence: Json): boolean {
    const parsed = blockerSchema.parse(evidence);
    const snapshot = store.snapshot();
    switch (parsed.kind) {
      case "capacity":
        return capacity().available === 0;
      case "resource":
        return (
          (snapshot.authorizations.some(
            (authorization) =>
              authorization.employeeId === key &&
              authorization.target === parsed.target,
          ) ||
            snapshot.duties.some(
              (duty) =>
                duty.employeeId === key && duty.target === parsed.target,
            )) &&
          (snapshot.grants.some(
            (grant) =>
              grant.target === parsed.target && grant.state !== "released",
          ) ||
            snapshot.legacyLocks.some(
              (lock) =>
                lock.target === parsed.target && lock.state === "blocked",
            ))
        );
      case "employee-limit": {
        if (config.employeeLimit === null) return false;
        const requirement = snapshot.teamRequirements.find(
          (entry) => entry.eventId === key,
        );
        if (!requirement) return false;
        const missing: number = (["architect", "qa", "dev"] as const).reduce(
          (total, role) =>
            total +
            Math.max(
              0,
              (role === "dev" ? requirement.developers : 1) -
                reusableStaff(snapshot, role).length,
            ),
          0,
        );
        return capacity().employees + missing > config.employeeLimit;
      }
      case "dependency": {
        const file: Json = jsonSchema.parse(
          JSON.parse(
            readFileSync(
              join(config.home, "startup", config.name, "queue.json"),
              "utf8",
            ),
          ),
        );
        const rows = z
          .array(
            z
              .object({
                id: idSchema,
                status: z.string(),
                blocked_on: z.unknown(),
              })
              .passthrough(),
          )
          .parse(
            Array.isArray(file)
              ? file
              : z.object({ items: z.unknown() }).parse(file).items,
          );
        const dependent = rows.find((row) => row.id === key);
        const prerequisite = rows.find((row) => row.id === parsed.itemId);
        return (
          dependent !== undefined &&
          prerequisite !== undefined &&
          z
            .array(idSchema)
            .parse(dependent.blocked_on)
            .includes(parsed.itemId) &&
          !["MERGED", "DONE", "COMPLETED"].includes(prerequisite.status)
        );
      }
    }
  }
  function blocked(key: string): boolean {
    const evidence = blockers.get(key);
    return evidence !== undefined && blockerCurrent(key, evidence);
  }
  function blockedMessage(message: Message): string | null {
    if (message.status !== "pending") return null;
    const snapshot = store.snapshot();
    const ownership = snapshot.queueRevisions.find(
      (item) => item.id === message.correlation,
    );
    const team = snapshot.teams.find(
      (team) =>
        team.id === message.teamId &&
        team.eventId === ownership?.eventId &&
        team.items.some(
          (item) =>
            item.id === ownership.id && item.revision === ownership.revision,
        ),
    );
    if (
      !team ||
      (message.recipient !== "manager" &&
        ![team.architect, team.qa, ...team.devs].includes(message.recipient))
    )
      return null;
    return blocked(message.correlation) ? message.correlation : null;
  }
  function waitGuard(): string | null {
    const snapshot = store.snapshot();
    const unrouted = snapshot.inputs.find(
      (entry) => entry.disposition === null,
    );
    if (unrouted)
      return `Route received input ${unrouted.id} through startup_route before lookup, waiting or ending.`;

    if (!managerReady) return null;
    const available: number | null = capacity().available;
    if (available !== null && available === 0) return null;
    const raw = snapshot.intakes.find(
      (entry) => entry.teamId === null && !blocked(entry.request.eventId),
    );
    if (raw)
      return `Delegate raw intake ${raw.request.eventId} through task startup=delegate before waiting or ending.`;
    for (const info of itemInfo()) {
      if (
        blocked(info.id) ||
        terminalItemStatuses.includes(info.status) ||
        ["BLOCKED", "NEEDS_DECISION"].includes(info.status)
      )
        continue;
      const team =
        info.teamId === null
          ? undefined
          : snapshot.teams.find((team) => team.id === info.teamId);
      const running = (employeeId: string | null): boolean =>
        employeeId !== null &&
        registry.list().some((ref) => {
          const employee = snapshot.employees.find(
            (employee) => employee.id === employeeId,
          );
          return (
            employee?.nativeHandle !== null &&
            employee?.nativeHandle !== undefined &&
            ref.session !== null &&
            nativeHandle(ref.id, ref.session.sessionManager.getSessionId()) ===
              employee.nativeHandle &&
            ["running", "working", "starting", "pending"].includes(ref.status)
          );
        });
      if (info.status === "QUEUED") {
        if (team && availableTeamDevs(team).length === 0) continue;
        if (
          !team &&
          snapshot.intakes.some(
            (intake) =>
              intake.request.amendItemIds.includes(info.id) &&
              (intake.teamId !== null || blocked(intake.request.eventId)),
          )
        )
          continue;
        return `Assign ready canonical item ${info.id} revision ${info.revision} through its owning team before waiting or ending.`;
      }
      if (
        info.status === "EXECUTING" &&
        info.devResultId !== null &&
        !running(info.employeeId)
      )
        return `Advance completed item ${info.id} through its assigned dev review action before waiting or ending.`;
      if (info.status === "REVIEW" && team) {
        const responsible =
          info.qaMessageId === null || info.qaVerdict !== null
            ? team.architect
            : team.qa;
        if (
          !running(responsible) &&
          (info.qaMessageId === null || info.qaResultId !== null)
        )
          return `Dispatch the owning team review/gate continuation for item ${info.id} before waiting or ending.`;
      }
      if (info.status === "READY_TO_LAND")
        return `Record authorized manager landing/close or a concrete blocker for item ${info.id} before waiting or ending.`;
    }
    const pending = snapshot.messages.find((message) => {
      if (
        message.status !== "pending" ||
        blocked(message.recipient) ||
        blockedMessage(message) !== null
      )
        return false;
      const employee = snapshot.employees.find(
        (entry) => entry.id === message.recipient,
      );
      if (employee?.error !== null && employee?.error !== undefined)
        return false;
      const ref = registry
        .list()
        .find(
          (entry) =>
            employee?.nativeHandle !== null &&
            employee?.nativeHandle !== undefined &&
            nativeHandle(
              entry.id,
              entry.session?.sessionManager.getSessionId() ??
                receipts.get(entry.id)?.sessionId ??
                "offline",
            ) === employee.nativeHandle,
        );
      return !ref || ref.status !== "running";
    });
    if (pending)
      return `Dispatch ready independent inbox ${pending.id} before waiting or ending; unrelated intake, CI and reviews do not block it.`;
    return null;
  }
  const unsubscribe: () => void = registry.onChange((event) => {
    if (
      event.type === "status_changed" &&
      ["idle", "aborted"].includes(event.ref.status)
    ) {
      for (const [employeeId, generation] of admissions) {
        const association = expected.get(employeeId);
        const receipt = receipts.get(event.ref.id);
        if (
          (association?.nativeId === event.ref.id &&
            association.profile.generation === generation) ||
          (receipt?.profile.employeeId === employeeId &&
            receipt.profile.generation === generation)
        )
          admissions.delete(employeeId);
      }
      nativeEnded(event.ref.id, event.ref.status);
    }
  });
  function dutyBinding(employeeId: string): Binding | null {
    store.renewLease();
    const rootNow = registry.get(rootId);
    if (
      !managerReady ||
      !rootNow?.session ||
      rootNow.session.sessionManager.getSessionId() !== rootSession
    )
      return null;
    verifyProfile(managerProfile);
    if (employeeId === "manager") return store.managerBinding;
    const employee = snapshotEmployee(employeeId);
    if (
      employee.nativeHandle === null ||
      employee.source === null ||
      employee.error !== null ||
      employee.employment !== "hired"
    )
      return null;
    const handle = decodeHandle(employee.nativeHandle);
    const receipt = receipts.get(handle.id);
    const ref = registry.get(handle.id);
    if (
      !receipt ||
      !ref?.session ||
      ref.parentId !== rootId ||
      !ref.sessionFile ||
      receipt.sessionId !== handle.sessionId ||
      ref.session.sessionManager.getSessionId() !== handle.sessionId ||
      receipt.profile.generation !== employee.generation ||
      encode(receipt.profile.source) !== encode(employee.source)
    )
      return null;
    const headers = readFileSync(ref.sessionFile, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) =>
        z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)),
      )
      .filter((entry) => entry.type === "session");
    if (headers.length !== 1)
      throw new StoreAuthorityError(
        "Duty native transcript requires exactly one session header",
      );
    const header = headerSchema.parse(headers[0]);
    if (header.id !== handle.sessionId || header.parentSession !== rootFile)
      throw new StoreAuthorityError(
        "Duty native transcript belongs to another root",
      );
    verifyProfile(receipt.profile);
    return {
      employeeId,
      generation: employee.generation,
      nativeHandle: employee.nativeHandle,
    };
  }
  const dutyReads = new AsyncLocalStorage<
    Readonly<{ id: string; path: string }>
  >();
  const activeDutyReads = new Set<string>();
  const duties = createDuties({
    store,
    now,
    owner: () => rootAdmin(input.ctx),
    binding: dutyBinding,
    wake,
    setInterval: input.ctx.setInterval,
    clearTimer: input.ctx.clearTimer,
    read: async (id, path) => {
      rootAdmin(input.ctx);
      const tool = registry.get(rootId)?.session?.getToolByName("read");
      if (!tool)
        throw new StoreAuthorityError(
          "Native restricted read capability unavailable",
        );
      const invocationId: string = `${id}-${randomUUID()}`;
      activeDutyReads.add(invocationId);
      try {
        return await dutyReads.run({ id: invocationId, path }, () =>
          tool.execute(invocationId, { path }),
        );
      } finally {
        activeDutyReads.delete(invocationId);
      }
    },
    write: async (id, path, content) => {
      if (!dutyBinding("manager"))
        throw new StoreAuthorityError("Native duty root is offline or unbound");
      const tool = registry.get(rootId)?.session?.getToolByName("write");
      if (!tool)
        throw new StoreAuthorityError(
          "Native JSON document write capability unavailable",
        );
      return tool.execute(id, { path, content });
    },
    warn: (fields) => {
      process.stderr.write(
        JSON.stringify({
          level: "warning",
          component: "startup-duty",
          ...fields,
        }) + "\n",
      );
    },
  });
  duties.start();
  return {
    store,
    admitDutyRead: (
      ctx: NativeContext,
      toolName: string,
      toolCallId: string | undefined,
      params: unknown,
    ): boolean => {
      const admitted = dutyReads.getStore();
      const parsed = z.strictObject({ path: z.string() }).safeParse(params);
      if (
        !admitted ||
        !activeDutyReads.has(admitted.id) ||
        toolName !== "read" ||
        toolCallId !== admitted.id ||
        !parsed.success ||
        parsed.data.path !== admitted.path ||
        ctx.agent.kind !== "main" ||
        ctx.agent.id !== rootId
      )
        return false;
      rootAdmin(ctx);
      activeDutyReads.delete(admitted.id);
      return true;
    },
    guardTurn: (ctx: NativeContext, toolName: string): string | null => {
      if (ctx.agent.id === rootId) {
        const pending = store
          .snapshot()
          .inputs.find((entry) => entry.disposition === null);
        if (
          pending &&
          ![
            "startup_staff",
            "startup_route",
            "startup_input",
            "startup_image",
            "startup_reconcile",
            "startup_resolve",
            "startup_release_reconciled",
            "startup_repair_reconcile",
            "startup_bind_manager",
          ].includes(toolName)
        )
          return `Route received input ${pending.id} through startup_route before lookup, waiting or ending.`;
        return null;
      }
      if (
        !/(?:^|\n)STARTUP_BINDING=/.test(ctx.getSystemPrompt().join("\n")) ||
        toolName === "yield"
      )
        return null;
      try {
        caller(ctx);
        return null;
      } catch (error: unknown) {
        if (
          error instanceof StoreFenceError ||
          error instanceof StoreAuthorityError ||
          error instanceof ProfileSourceError
        )
          return error.message;
        throw error;
      }
    },
    nativeEnded,
    replace: async (ctx: NativeContext, request: unknown) => {
      const parsed = replaceInputSchema.parse(request);
      const generation = store.reserveReplacement({
        manager: manager(ctx),
        employeeId: parsed.employeeId,
        evidence: parsed.evidence,
      });
      expected.delete(parsed.employeeId);
      await activate(ctx, [parsed.employeeId]);
      return { employee: snapshotEmployee(parsed.employeeId), generation };
    },
    sourceFailed: (ctx: NativeContext, error: string): void => {
      const ref = nativeRef(ctx);
      if (ref.id === rootId) {
        store.recordBindingFailure({
          manager: store.managerBinding,
          employeeId: "manager",
          error,
        });
        return;
      }
      nativeEnded(ref.id, error);
    },
    duties,
    dutyBinding,
    shutdown: async (): Promise<void> => {
      nativeJobObservers.clear();
      try {
        await duties.stop();
      } finally {
        input.ctx.clearTimer(timer);
        unsubscribe();
        store.close();
      }
    },
    rootId,
    rootSession,
    rootDirectory,
    capacity,
    caller,
    manager,
    projection,
    reserve,
    ordinary,
    activate,
    receiveInput,
    routeInput,
    readInput,
    image,
    item,
    recordIntake,
    delegate,
    send,
    settle,
    wake,
    dispatch: async (
      ctx: NativeContext,
      ids: readonly string[],
    ): Promise<readonly Json[]> => {
      manager(ctx);
      const messages = ids.map((id) => {
        const message = store
          .snapshot()
          .messages.find((entry) => entry.id === id);
        if (!message || message.status !== "pending")
          throw new StoreAuthorityError(
            `Message ${id} is not pending native delivery`,
          );
        return message;
      });
      return Promise.all(messages.map(wake));
    },
    refresh: (ctx: NativeContext, request: unknown) => {
      const binding = manager(ctx);
      const parsed = z
        .strictObject({ employeeId: idSchema, evidence: jsonSchema })
        .parse(request);
      const current = snapshotEmployee(parsed.employeeId);
      const ref = registry
        .list()
        .find(
          (entry) =>
            receipts.get(entry.id) !== undefined &&
            nativeHandle(entry.id, receipts.get(entry.id)!.sessionId) ===
              current.nativeHandle,
        );
      if (ref?.status === "running")
        throw new StoreAuthorityError(
          "Canonical refresh requires an idle native context",
        );
      const profile = loadProfile({
        skillsRoot: config.skillsRoot,
        role: current.role,
        employeeId: current.id,
        generation: current.generation + 1,
      });
      const generation = store.refreshCanonical({
        manager: binding,
        employeeId: current.id,
        source: profile.source,
        evidence: parsed.evidence,
      });
      expected.delete(current.id);
      return { employeeId: current.id, generation, source: profile.source };
    },
    reconcile: (ctx: NativeContext, request: unknown) => {
      const parsed = z
        .strictObject({ claimId: idSchema, evidence: jsonSchema })
        .parse(request);
      store.reconcileClaim({
        manager: rootAdmin(ctx),
        claimId: parsed.claimId,
        evidence: parsed.evidence,
      });
      bindManager();
      return parsed;
    },
    resolve: (ctx: NativeContext, request: unknown) => {
      const parsed = z
        .strictObject({ assignmentId: idSchema, evidence: jsonSchema })
        .parse(request);
      store.resolveAssignment({
        manager: rootAdmin(ctx),
        assignmentId: parsed.assignmentId,
        evidence: parsed.evidence,
      });
      return parsed;
    },
    finish: (ctx: NativeContext, request: unknown) => {
      const parsed = z
        .strictObject({ teamId: idSchema, evidence: jsonSchema })
        .parse(request);
      return store.finishTeam({
        manager: manager(ctx),
        teamId: parsed.teamId,
        evidence: parsed.evidence,
      });
    },
    reconcileRepair: (ctx: NativeContext, request: unknown) =>
      duties.reconcile(rootAdmin(ctx), request),
    releaseReconciled: async (ctx: NativeContext, request: unknown) => {
      const parsed = z
        .strictObject({ grantId: idSchema, verification: jsonSchema })
        .parse(request);
      const owner = rootAdmin(ctx);
      const saved = store
        .snapshot()
        .grants.find((entry) => entry.id === parsed.grantId);
      if (
        saved &&
        z.object({ kind: z.literal("replace-json") }).safeParse(saved.authority)
          .success
      ) {
        const released = await duties.reconcile(owner, {
          grantId: parsed.grantId,
          evidence: parsed.verification,
        });
        bindManager();
        return released;
      }
      const grant = store.verifyAndReleaseTarget({
        employee: owner,
        grantId: parsed.grantId,
        verification: parsed.verification,
      });
      store.projectResources({ manager: store.managerBinding });
      bindManager();
      return grant;
    },
    bindManager: (ctx: NativeContext) => {
      rootAdmin(ctx);
      return { ready: bindManager() };
    },
    claim: (ctx: NativeContext) => {
      const employee = caller(ctx);
      const claimed = store.claimNext({
        employee,
        excludedMessageIds: store
          .snapshot()
          .messages.filter(
            (message) =>
              message.recipient === employee.employeeId &&
              blockedMessage(message) !== null,
          )
          .map((message) => message.id),
      });
      return claimed === null
        ? null
        : { claim: claimed.claim, message: publicMessage(claimed.message) };
    },
    capture: (ctx: NativeContext, request: unknown) =>
      store.captureIntake({
        architect: caller(ctx),
        capture: captureSchema.parse(request),
      }),
    retire: (ctx: NativeContext, request: unknown) => {
      const parsed = retireInputSchema.parse(request);
      for (const id of parsed.employeeIds) {
        const employee = snapshotEmployee(id);
        if (
          registry
            .list()
            .some(
              (ref) =>
                receipts.get(ref.id) !== undefined &&
                nativeHandle(ref.id, receipts.get(ref.id)!.sessionId) ===
                  employee.nativeHandle &&
                ref.status === "running",
            )
        )
          throw new StoreAuthorityError(
            "Retirement requires an idle native employee",
          );
      }
      return store.retireEmployees({
        manager: manager(ctx),
        employeeIds: parsed.employeeIds,
        evidence: parsed.evidence,
      });
    },
    staff: (ctx: NativeContext, recoveryOffset?: number) => {
      rootAdmin(ctx);
      const offset = timeSchema.parse(recoveryOffset ?? 0);
      const snapshot = store.snapshot();
      const claims = snapshot.claims.filter((claim) => claim.status !== "settled");
      const assignments = snapshot.assignments.filter((assignment) => assignment.state !== "complete");
      const pendingMessages = snapshot.messages.filter((message) => message.status === "pending");
      const employeeMetadata = (id: string) => {
        const employee = snapshot.employees.find((entry) => entry.id === id);
        if (!employee) throw new StoreAuthorityError(`Recovery employee missing: ${id}`);
        return { employeeId: id, teamId: employee.assignment, generation: employee.generation, ownerEpoch: store.ownerEpoch };
      };
      return {
        recovery: {
          offset,
          nextOffset: Math.max(claims.length, assignments.length, pendingMessages.length) > offset + 64 ? offset + 64 : null,
          counts: { claims: claims.length, assignments: assignments.length, pendingMessages: pendingMessages.length },
          claims: claims.slice(offset, offset + 64).map((claim) => ({ ...employeeMetadata(claim.employeeId), ...claim })),
          assignments: assignments.slice(offset, offset + 64).map((assignment) => ({ ...employeeMetadata(assignment.employeeId), ...assignment })),
          pendingMessages: pendingMessages.slice(offset, offset + 64).map((message) => ({ ...employeeMetadata(message.recipient), id: message.id, sender: message.sender, recipient: message.recipient, teamId: message.teamId, kind: message.kind, status: message.status })),
        },
        mode: managerReady ? "ready" : "recovery",
        managerClaims: store
          .snapshot()
          .claims.filter(
            (claim) =>
              claim.employeeId === "manager" && claim.status !== "settled",
          ),
        managerGrants: store
          .snapshot()
          .grants.filter(
            (grant) =>
              grant.employeeId === "manager" && grant.state !== "released",
          ),
        inputs: store
          .snapshot()
          .inputs.filter((entry) => entry.disposition === null)
          .slice(0, 8)
          .map(inputMetadata),
        inputCounts: {
          total: store.snapshot().inputs.length,
          unclassified: store
            .snapshot()
            .inputs.filter((entry) => entry.disposition === null).length,
        },
        items: itemInfo()
          .filter((item) => !terminalItemStatuses.includes(item.status))
          .slice(0, 64),
        employees: store.snapshot().employees,
        teams: store.snapshot().teams,
        capacity: capacity(),
        blockers: Object.fromEntries(blockers),
        deliveries: Object.fromEntries(deliveries),
      };
    },
    block: (ctx: NativeContext, key: string, evidence: Json) => {
      manager(ctx);
      const parsed = blockerSchema.parse(evidence);
      if (!blockerCurrent(key, jsonSchema.parse(parsed)))
        throw new StoreAuthorityError(
          "No current native capacity, explicit employee limit, persisted resource grant or queue dependency proves this blocker",
        );
      blockers.set(key, jsonSchema.parse(parsed));
    },
    waitGuard,
    close: (): void => {
      nativeJobObservers.clear();
      duties.close();
      input.ctx.clearTimer(timer);
      unsubscribe();
      store.close();
    },
  };
}
