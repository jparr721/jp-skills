import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  encode,
  idSchema,
  jsonSchema,
  timeSchema,
  type Binding,
  type Duty,
  type Grant,
  type Json,
  type Message,
  StoreAuthorityError,
  StoreConflictError,
} from "./contracts";
import type { StartupStore, Occurrence } from "./store";
import type { NativeResult } from "./omp-adapter";

const acceptanceSchema = z.strictObject({
  path: z.array(z.string()).max(32),
  equals: jsonSchema,
});
const probeSchema = z.strictObject({
  path: z.string().min(1),
  acceptance: acceptanceSchema,
});
const repairSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read-only") }),
  z.strictObject({
    kind: z.literal("replace-json"),
    payload: jsonSchema,
    verification: probeSchema,
  }),
]);
export const dutyInputSchema = z.strictObject({
  id: idSchema,
  employeeId: idSchema,
  target: z.string().min(1).nullable(),
  probe: z.string().min(1).nullable(),
  acceptance: acceptanceSchema.nullable(),
  repairAuthority: repairSchema.nullable(),
  cadenceMs: z.number().int().positive().safe().max(2147483647).nullable(),
  nextDue: timeSchema.nullable(),
});
type DutyInput = z.infer<typeof dutyInputSchema>;
const savedDutySchema = z.strictObject({
  kind: z.literal("native-json-duty"),
  config: dutyInputSchema,
});
const actionSchema = z.strictObject({
  kind: z.literal("replace-json"),
  dutyId: idSchema,
  payload: jsonSchema,
  verification: probeSchema,
});
const observationSchema = z.strictObject({
  kind: z.literal("native-json-observation"),
  checkedAt: timeSchema,
  probe: z.string(),
  status: z.enum(["healthy", "unhealthy", "failed"]),
  value: jsonSchema,
  error: z.string().nullable(),
  actionable: z.boolean(),
});
type Observation = z.infer<typeof observationSchema>;
const nativeJsonDetailsSchema = z
  .object({
    totalLines: z.number().int().positive(),
    fileSize: z.number().int().nonnegative().max(16384),
    displayContent: z.object({
      text: z.string(),
      startLine: z.literal(1),
      lineNumbers: z.array(z.number().int().positive()),
    }),
    meta: z.object({
      source: z.object({ type: z.literal("path"), value: z.string() }),
    }),
    truncation: z.unknown().optional(),
    suffixResolution: z.unknown().optional(),
  })
  .passthrough();

export class DutyProbeError extends Error {}
export class DutyRepairError extends Error {}

export function parseNativeJson(result: NativeResult, path: string): Json {
  if (result.isError)
    throw new DutyProbeError(
      `Native JSON read failed for ${path}: ${encode(result)}`,
    );
  const parsed = nativeJsonDetailsSchema.safeParse(result.details);
  if (!parsed.success)
    throw new DutyProbeError(
      `Unsupported native JSON read metadata for ${path}: ${parsed.error.message}`,
    );
  const details = parsed.data;
  const text = details.displayContent.text;
  const lines = text.split("\n").length;
  if (
    details.meta.source.value !== path ||
    details.truncation !== undefined ||
    details.suffixResolution !== undefined ||
    Buffer.byteLength(text, "utf8") !== details.fileSize ||
    details.totalLines !== lines ||
    details.displayContent.lineNumbers.length !== lines ||
    details.displayContent.lineNumbers.some((line, index) => line !== index + 1)
  )
    throw new DutyProbeError(
      `Incomplete or redirected native JSON read for ${path}`,
    );
  try {
    return jsonSchema.parse(JSON.parse(text));
  } catch (error: unknown) {
    throw new DutyProbeError(
      `Invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalFile(path: string): string {
  if (
    !isAbsolute(path) ||
    /[:;?#[\]\r\n\0]/.test(path) ||
    !path.endsWith(".json")
  )
    throw new StoreAuthorityError(
      `Duty target must be an absolute regular .json path without native selectors: ${path}`,
    );
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    !canonical.endsWith(".json") ||
    /[:;?#[\]\r\n\0]/.test(canonical)
  )
    throw new StoreAuthorityError(
      `Duty target must be one regular JSON file with no hard links: ${path}`,
    );
  return canonical;
}
function assertCanonical(path: string): void {
  if (canonicalFile(path) !== path)
    throw new StoreAuthorityError(`Assigned duty path was retargeted: ${path}`);
}
function complete(config: DutyInput): boolean {
  return (
    config.target !== null &&
    config.probe !== null &&
    config.acceptance !== null &&
    config.repairAuthority !== null &&
    config.cadenceMs !== null &&
    config.nextDue !== null
  );
}
function accepted(
  value: Json,
  acceptance: z.infer<typeof acceptanceSchema>,
): boolean {
  let current: Json = value;
  for (const key of acceptance.path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    )
      return false;
    const next: Json | undefined = Object.entries(current).find(
      ([field]) => field === key,
    )?.[1];
    if (next === undefined) return false;
    current = next;
  }
  return encode(current) === encode(acceptance.equals);
}
function cueId(kind: string, key: string): string {
  return `duty-${kind}-${createHash("sha256").update(key).digest("hex")}`;
}
function configOf(duty: Duty): DutyInput {
  return savedDutySchema.parse(duty.assignment).config;
}
export type DutyHost = Readonly<{
  store: StartupStore;
  owner: () => Binding;
  now: () => number;
  binding: (employeeId: string) => Binding | null;
  read: (id: string, path: string) => Promise<NativeResult>;
  write: (id: string, path: string, content: string) => Promise<NativeResult>;
  wake: (message: Message) => Promise<Json>;
  setInterval: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  clearTimer: (timer: ReturnType<typeof setInterval>) => void;
  warn: (
    fields: Readonly<{
      operation: string;
      path: string;
      attempt: number;
      error: string;
    }>,
  ) => void;
}>;

export function createDuties(host: DutyHost) {
  const { store, now } = host;
  let running: boolean = false;
  let work: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const repairs: Set<Promise<Grant>> = new Set();
  const delivered: Set<string> = new Set();
  const blockers: Map<string, string> = new Map();
  function manager(): Binding {
    const binding = host.binding("manager");
    if (!binding)
      throw new StoreAuthorityError(
        "Duty scheduling awaits actual manager source/native admission",
      );
    store.renewLease();
    return binding;
  }
  function duty(id: string): Duty {
    const found = store.snapshot().duties.find((entry) => entry.id === id);
    if (!found) throw new StoreAuthorityError(`Unknown duty ${id}`);
    return found;
  }
  async function read(
    probe: z.infer<typeof probeSchema>,
    operationId: string,
  ): Promise<Json> {
    assertCanonical(probe.path);
    let result: NativeResult;
    try {
      result = await host.read(operationId, `${probe.path}:raw`);
    } catch (error: unknown) {
      host.warn({
        operation: operationId,
        path: probe.path,
        attempt: 1,
        error: error instanceof Error ? error.message : String(error),
      });
      assertCanonical(probe.path);
      result = await host.read(`${operationId}-retry`, `${probe.path}:raw`);
    }
    assertCanonical(probe.path);
    return parseNativeJson(result, probe.path);
  }
  async function deliver(message: Message): Promise<void> {
    if (message.status !== "pending" || delivered.has(message.id)) return;
    const result = await host.wake(message);
    if (
      !z
        .object({ kind: z.enum(["capacity-blocked", "dependency-blocked"]) })
        .safeParse(result).success
    )
      delivered.add(message.id);
  }
  async function recover(): Promise<void> {
    if (!running) return;
    const owner = manager();
    for (const occurrence of store.snapshot().occurrences) {
      const parsed = observationSchema.safeParse(occurrence.observation);
      if (
        !parsed.success ||
        !parsed.data.actionable ||
        occurrence.observedAt === null
      )
        continue;
      const existing = store
        .snapshot()
        .messages.find(
          (entry) => entry.id === cueId("observation", occurrence.id),
        );
      if (existing) {
        await deliver(existing);
        continue;
      }
      const message = store.sendCue({
        sender: owner,
        cue: {
          id: cueId("observation", occurrence.id),
          recipient: occurrence.employeeId,
          kind: "duty",
          correlation: occurrence.dutyId,
          payload: {
            kind: "duty-observation",
            occurrenceId: occurrence.id,
            observation: parsed.data,
          },
        },
      });
      await deliver(message);
    }
    for (const grant of store
      .snapshot()
      .grants.filter((entry) => entry.state === "reconciliation")) {
      const action = actionSchema.safeParse(grant.authority);
      if (!action.success) continue;
      const message = store.sendCue({
        sender: owner,
        cue: {
          id: cueId("uncertain", grant.id),
          recipient: "manager",
          kind: "alert",
          correlation: action.data.dutyId,
          payload: {
            kind: "duty-repair-reconciliation",
            grantId: grant.id,
            target: grant.target,
            authorizationId: grant.authorizationId,
          },
        },
      });
      await deliver(message);
    }
  }
  async function poll(employeeId: string): Promise<void> {
    const binding = host.binding(employeeId);
    if (!binding) {
      blockers.set(
        employeeId,
        "pending native/source admission; current health unknown",
      );
      const employee = store
        .snapshot()
        .employees.find((entry) => entry.id === employeeId);
      if (employee?.nativeHandle && employee.error === null) {
        const message = store.sendCue({
          sender: manager(),
          cue: {
            id: cueId(
              "recover",
              `${store.ownerEpoch}/${employeeId}/${employee.generation}`,
            ),
            recipient: employeeId,
            kind: "duty",
            correlation: "duty-recovery",
            payload: {
              kind: "duty-source-admission",
              ownerEpoch: store.ownerEpoch,
              generation: employee.generation,
            },
          },
        });
        await deliver(message);
      }
      return;
    }
    const snapshot = store.snapshot();
    if (
      snapshot.claims.some(
        (entry) =>
          entry.employeeId === employeeId && entry.status !== "settled",
      ) ||
      snapshot.grants.some(
        (entry) =>
          entry.employeeId === employeeId && entry.state !== "released",
      ) ||
      snapshot.messages.some(
        (entry) =>
          entry.recipient === employeeId && entry.status !== "acknowledged",
      )
    ) {
      blockers.set(employeeId, "pending inbox or repair reconciliation");
      return;
    }
    blockers.delete(employeeId);
    const occurrence = store.claimDue({ employee: binding });
    if (!occurrence) return;
    const config = configOf(duty(occurrence.dutyId));
    if (
      !complete(config) ||
      config.probe === null ||
      config.acceptance === null
    )
      throw new StoreAuthorityError(
        `Incomplete duty admitted unexpectedly: ${config.id}`,
      );
    let status: Observation["status"];
    let value: Json = null;
    let error: string | null = null;
    try {
      value = await read(
        { path: config.probe, acceptance: config.acceptance },
        occurrence.id,
      );
      status = accepted(value, config.acceptance) ? "healthy" : "unhealthy";
    } catch (failure: unknown) {
      status = "failed";
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (!running) return;
    const current = host.binding(employeeId);
    if (!current || encode(current) !== encode(binding))
      throw new StoreAuthorityError(
        `Duty binding changed during probe ${occurrence.id}`,
      );
    const previous = snapshot.occurrences
      .filter(
        (entry) =>
          entry.dutyId === occurrence.dutyId && entry.observedAt !== null,
      )
      .sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))[0];
    const prior = observationSchema.safeParse(previous?.observation);
    const observation: Observation = {
      kind: "native-json-observation",
      checkedAt: now(),
      probe: config.probe,
      status,
      value,
      error,
      actionable:
        status !== "healthy" ||
        (prior.success && prior.data.status !== "healthy"),
    };
    store.observeDuty({
      employee: binding,
      occurrenceId: occurrence.id,
      observation,
    });
  }
  function tick(): Promise<void> {
    if (work) return work;
    const pending = run();
    work = pending;
    void pending.then(
      () => {
        work = null;
      },
      () => {
        work = null;
      },
    );
    return pending;
  }
  function arm(): void {
    if (timer !== null) host.clearTimer(timer);
    timer = null;
    if (!running) return;
    const snapshot = store.snapshot();
    const cadences = snapshot.duties
      .filter(
        (entry) =>
          snapshot.dutySchedules.some(
            (schedule) => schedule.id === entry.id && schedule.nextDue !== null,
          ) &&
          savedDutySchema.safeParse(entry.assignment).success &&
          complete(configOf(entry)),
      )
      .map((entry) => entry.cadenceMs ?? 1000);
    if (cadences.length > 0)
      timer = host.setInterval(
        async () => {
          await tick();
        },
        Math.min(1000, ...cadences),
      );
  }
  async function run(): Promise<void> {
    if (!running) return;
    manager();
    await recover();
    const duties = store
      .snapshot()
      .duties.filter((entry) =>
        store
          .snapshot()
          .dutySchedules.some(
            (schedule) => schedule.id === entry.id && schedule.nextDue !== null,
          ),
      );
    const employees = new Set(
      duties
        .filter(
          (entry) =>
            savedDutySchema.safeParse(entry.assignment).success &&
            complete(configOf(entry)),
        )
        .map((entry) => entry.employeeId),
    );
    for (const employeeId of employees) {
      if (!running) return;
      await poll(employeeId);
    }
    if (running) await recover();
  }
  async function executeRepair(
    employee: Binding,
    authorizationId: string,
  ): Promise<Grant> {
    if (!running) throw new DutyRepairError("Duty host is offline");
    manager();
    const authorization = store
      .snapshot()
      .authorizations.find((entry) => entry.id === authorizationId);
    if (!authorization || authorization.employeeId !== employee.employeeId)
      throw new StoreAuthorityError(
        "Repair authority belongs to another employee or is missing",
      );
    const actual = host.binding(employee.employeeId);
    if (!actual || encode(actual) !== encode(employee))
      throw new StoreAuthorityError(
        "Repair requires actual native/source admission",
      );
    const action = actionSchema.parse(authorization.authority);
    const configured = configOf(duty(action.dutyId));
    if (
      !store
        .snapshot()
        .dutySchedules.some(
          (entry) => entry.id === configured.id && entry.nextDue !== null,
        )
    )
      throw new StoreAuthorityError("Ended duty cannot execute a repair");
    if (
      configured.repairAuthority?.kind !== "replace-json" ||
      configured.target !== authorization.target
    )
      throw new StoreAuthorityError("Duty does not authorize this JSON repair");
    if (
      store
        .snapshot()
        .grants.some((entry) => entry.authorizationId === authorizationId)
    )
      throw new DutyRepairError(
        `Repair ${authorizationId} already has a grant; never replay an uncertain or completed action`,
      );
    assertCanonical(authorization.target);
    const grant = store.acquireTarget({
      employee,
      authorizationId,
      grantId: cueId("grant", authorizationId),
    });
    try {
      store.projectResources({ manager: manager() });
      const output = await host.write(
        grant.id,
        authorization.target,
        `${encode(action.payload)}\n`,
      );
      if (output.isError)
        throw new DutyRepairError(
          `Native write failed for ${authorization.target}: ${encode(output)}`,
        );
      const value = await read(action.verification, `${grant.id}-verify`);
      if (!accepted(value, action.verification.acceptance))
        throw new DutyRepairError(
          `Post-action acceptance failed for ${authorization.target}: ${encode(value)}`,
        );
      if (!running)
        throw new DutyRepairError(
          `Host stopped before verification settlement for ${grant.id}`,
        );
      const current = host.binding(employee.employeeId);
      if (!current || encode(current) !== encode(employee))
        throw new StoreAuthorityError(
          "Repair binding changed before verification settlement",
        );
      const released = store.verifyAndReleaseTarget({
        employee,
        grantId: grant.id,
        verification: {
          kind: "native-json-verification",
          checkedAt: now(),
          probe: action.verification,
          value,
        },
      });
      store.projectResources({ manager: manager() });
      return released;
    } catch (error: unknown) {
      store.markTargetUncertain({
        employee,
        grantId: grant.id,
        evidence: {
          kind: "uncertain-json-repair",
          error: error instanceof Error ? error.message : String(error),
          recordedAt: now(),
        },
      });
      store.projectResources({ manager: manager() });
      await recover();
      throw error;
    }
  }
  async function executeReconciliation(
    owner: Binding,
    request: unknown,
  ): Promise<Grant> {
    if (!running) throw new DutyRepairError("Duty host is offline");
    if (encode(owner) !== encode(host.owner()))
      throw new StoreAuthorityError("Only the current root reconciles repair");
    const parsed = z
      .strictObject({
        grantId: idSchema,
        evidence: jsonSchema.refine((value) => value !== null),
      })
      .parse(request);
    const grant = store
      .snapshot()
      .grants.find((entry) => entry.id === parsed.grantId);
    if (!grant || grant.state !== "reconciliation")
      throw new DutyRepairError("Only uncertain grants can be reconciled");
    const action = actionSchema.parse(grant.authority);
    const value = await read(action.verification, `${grant.id}-reconcile`);
    if (!accepted(value, action.verification.acceptance))
      throw new DutyRepairError(
        "Fresh reconciliation probe failed assigned acceptance; target remains locked",
      );
    const released = store.verifyAndReleaseTarget({
      employee: owner,
      grantId: grant.id,
      verification: {
        kind: "native-json-reconciliation",
        checkedAt: now(),
        probe: action.verification,
        value,
        evidence: parsed.evidence,
      },
    });
    store.projectResources({ manager: host.owner() });
    return released;
  }
  function track(operation: Promise<Grant>): Promise<Grant> {
    repairs.add(operation);
    void operation.then(
      () => repairs.delete(operation),
      () => repairs.delete(operation),
    );
    return operation;
  }
  return {
    assign(owner: Binding, request: unknown): Duty {
      if (encode(owner) !== encode(manager()))
        throw new StoreAuthorityError("Only the bound manager assigns duties");
      const parsed = dutyInputSchema.parse(request);
      const config: DutyInput = {
        ...parsed,
        target: parsed.target === null ? null : canonicalFile(parsed.target),
        probe: parsed.probe === null ? null : canonicalFile(parsed.probe),
        repairAuthority:
          parsed.repairAuthority?.kind === "replace-json"
            ? {
                ...parsed.repairAuthority,
                verification: {
                  ...parsed.repairAuthority.verification,
                  path: canonicalFile(parsed.repairAuthority.verification.path),
                },
              }
            : parsed.repairAuthority,
      };
      const saved = store.setDuty({
        manager: owner,
        duty: {
          id: config.id,
          employeeId: config.employeeId,
          assignment: { kind: "native-json-duty", config },
          target: config.target,
          probe: config.probe === null ? null : "native-json",
          acceptance: config.acceptance === null ? null : "json-equals",
          repairAuthority: config.repairAuthority,
          cadenceMs: complete(config) ? config.cadenceMs : null,
          nextDue: config.nextDue,
        },
      });
      arm();
      return saved;
    },
    async end(
      owner: Binding,
      request: unknown,
    ): Promise<{ dutyId: string; evidence: Json }> {
      if (encode(owner) !== encode(manager()))
        throw new StoreAuthorityError("Only the bound manager ends duties");
      const parsed = z
        .strictObject({ dutyId: idSchema, evidence: jsonSchema })
        .parse(request);
      await recover();
      store.endDuty({ manager: owner, ...parsed });
      arm();
      return parsed;
    },
    authorize(owner: Binding, request: unknown): void {
      if (encode(owner) !== encode(manager()))
        throw new StoreAuthorityError(
          "Only the bound manager authorizes repair",
        );
      const parsed = z
        .strictObject({ id: idSchema, dutyId: idSchema })
        .parse(request);
      const config = configOf(duty(parsed.dutyId));
      if (
        !store
          .snapshot()
          .dutySchedules.some(
            (entry) => entry.id === config.id && entry.nextDue !== null,
          )
      )
        throw new StoreAuthorityError("Ended duty cannot authorize repair");
      if (
        !complete(config) ||
        config.target === null ||
        config.repairAuthority?.kind !== "replace-json"
      )
        throw new StoreAuthorityError(
          "Duty has no explicit complete JSON replacement authority",
        );
      assertCanonical(config.target);
      store.importResources({ manager: owner });
      for (const lock of store.snapshot().legacyLocks) {
        if (lock.state !== "blocked" || !isAbsolute(lock.target)) continue;
        let identity: string;
        try {
          identity = realpathSync(lock.target);
        } catch (error) {
          if (
            z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) }).safeParse(error)
              .success
          )
            continue;
          throw error;
        }
        if (identity === config.target)
          throw new StoreConflictError(
            `Canonical target has an unresolved legacy lock: ${config.target}`,
          );
      }
      store.authorizeTarget({
        manager: owner,
        authorization: {
          id: parsed.id,
          employeeId: config.employeeId,
          target: config.target,
          authority: {
            kind: "replace-json",
            dutyId: config.id,
            payload: config.repairAuthority.payload,
            verification: config.repairAuthority.verification,
          },
        },
      });
    },
    repair(employee: Binding, authorizationId: string): Promise<Grant> {
      return track(executeRepair(employee, authorizationId));
    },
    reconcile(owner: Binding, request: unknown): Promise<Grant> {
      return track(executeReconciliation(owner, request));
    },
    start(): void {
      running = true;
      arm();
    },
    tick,
    close(): void {
      if (work || repairs.size > 0)
        throw new DutyRepairError(
          "Stop and drain duty work before closing the host",
        );
      running = false;
      if (timer !== null) host.clearTimer(timer);
      timer = null;
    },
    recover,
    async stop(): Promise<void> {
      running = false;
      if (timer !== null) host.clearTimer(timer);
      timer = null;
      const results = await Promise.allSettled([
        ...(work ? [work] : []),
        ...repairs,
      ]);
      const failed = results.find((entry) => entry.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
    status() {
      const snapshot = store.snapshot();
      return {
        runtime: running ? "ONLINE" : "OFFLINE",
        duties: snapshot.duties
          .filter(
            (entry) => savedDutySchema.safeParse(entry.assignment).success,
          )
          .map((entry) => {
            const last: Occurrence | undefined = snapshot.occurrences
              .filter(
                (occurrence) =>
                  occurrence.dutyId === entry.id &&
                  occurrence.observedAt !== null,
              )
              .sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))[0];
            const observation = observationSchema.safeParse(last?.observation);
            const current =
              snapshot.dutySchedules.some(
                (schedule) =>
                  schedule.id === entry.id && schedule.nextDue !== null,
              ) &&
              running &&
              last?.ownerEpoch === store.ownerEpoch &&
              host.binding(entry.employeeId) !== null &&
              observation.success &&
              now() - observation.data.checkedAt < (entry.cadenceMs ?? 0);
            return {
              id: entry.id,
              employeeId: entry.employeeId,
              configured: complete(configOf(entry)),
              currentHealth:
                current && observation.success
                  ? observation.data.status
                  : "unknown",
              lastObservation: last ?? null,
              blocker: blockers.get(entry.employeeId) ?? null,
            };
          }),
      };
    },
  };
}
