import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  authoritySchema,
  bindingSchema,
  bindSchema,
  captureSchema,
  claimSchema,
  cueSchema,
  dutySchema,
  employeeSchema,
  encode,
  grantSchema,
  hireSchema,
  idSchema,
  intakeSchema,
  jsonSchema,
  messageSchema,
  ownerSchema,
  resultSchema,
  rowSchema,
  scopeSchema,
  sourceSchema,
  teamRequestSchema,
  teamSchema,
  timeSchema,
  StoreAuthorityError,
  StoreConflictError,
  StoreFenceError,
  StoreRecoveryError,
  type Authority,
  type Bind,
  type Binding,
  type Capture,
  type Claim,
  type Cue,
  type Duty,
  type Employee,
  type Grant,
  type Hire,
  type Intake,
  type Json,
  type Message,
  type Owner,
  type Result,
  type Scope,
  type Source,
  type Team,
  type TeamRequest,
} from "./contracts";
import {
  legacyLockSchema,
  projectResources,
  readLegacyLocks,
  resourceDocumentSchema,
  sameDocument,
  type LegacyLock,
  type ResourceDocument,
} from "./resources";

import {
  itemActionSchema,
  itemExecutionSchema,
  itemTransitionSchema,
  terminalItemStatuses,
  type ItemAction,
  type ItemExecution,
  type ItemTransition,
} from "./items";
const storedSchema = z.strictObject({ payload: z.string() });
const leaseSchema = z.strictObject({
  token: z.string(),
  epoch: timeSchema,
  generation: timeSchema,
  expires: timeSchema,
});
const hireRecordSchema = z
  .strictObject({ request: hireSchema, ids: z.array(idSchema).readonly() })
  .readonly();
const intakeRecordSchema = z
  .strictObject({ request: intakeSchema, teamId: idSchema.nullable() })
  .readonly();
const inputDispositionSchema = z
  .strictObject({
    kind: z.enum(["work", "status", "control", "conversation", "decision"]),
    reason: z.string().trim().min(1),
    amendItemIds: z.array(idSchema),
  })
  .readonly();
const teamRequirementSchema = z
  .strictObject({
    eventId: idSchema,
    developers: z.number().int().positive().safe(),
  })
  .readonly();
const receivedInputSchema = z
  .strictObject({
    id: idSchema,
    receivedAt: timeSchema,
    source: z.enum(["interactive", "rpc"]),
    raw: z.strictObject({ text: z.string(), images: z.array(jsonSchema) }),
    disposition: inputDispositionSchema.nullable(),
  })
  .readonly();
export type ReceivedInput = z.infer<typeof receivedInputSchema>;
const resultRecordSchema = z
  .strictObject({
    claimId: idSchema,
    result: resultSchema,
    messages: z.array(messageSchema).readonly(),
  })
  .readonly();
const captureRecordSchema = z
  .strictObject({
    request: captureSchema,
    teamId: idSchema,
    items: teamSchema.unwrap().shape.items,
  })
  .readonly();
const writeIntentSchema = z
  .strictObject({
    file: z.enum(["queue.json", "resources.json"]),
    before: z.string().nullable(),
    after: z.string(),
    state: z.enum(["pending", "complete"]),
    capture: captureRecordSchema.nullable(),
    item: itemTransitionSchema.optional(),
  })
  .readonly();
const occurrenceSchema = z
  .strictObject({
    id: idSchema,
    dutyId: idSchema,
    employeeId: idSchema,
    scheduledFor: timeSchema,
    claimedAt: timeSchema,
    observation: jsonSchema,
    observedAt: timeSchema.nullable(),
    generation: timeSchema,
    ownerEpoch: timeSchema,
  })
  .readonly();
const queueOwnerSchema = z
  .strictObject({ id: idSchema, eventId: idSchema, revision: timeSchema })
  .readonly();
const assignmentSchema = z
  .strictObject({
    id: idSchema,
    employeeId: idSchema,
    state: z.enum(["pending", "waiting", "reconciliation", "complete"]),
  })
  .readonly();
const authorizationSchema = z
  .strictObject({
    id: idSchema,
    employeeId: idSchema,
    target: idSchema,
    authority: jsonSchema,
  })
  .readonly();
export type HireReceipt = Readonly<{
  requestId: string;
  requested: number;
  reserved: number;
  ready: number;
  starting: number;
  failed: number;
  retired: number;
  employees: readonly Employee[];
}>;
export type Settlement = z.infer<typeof resultRecordSchema>;
export type Occurrence = z.infer<typeof occurrenceSchema>;
export type CaptureReceipt = z.infer<typeof captureRecordSchema>;
export type HireRecord = z.infer<typeof hireRecordSchema>;
export type IntakeRecord = z.infer<typeof intakeRecordSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type TargetAuthorization = z.infer<typeof authorizationSchema>;
export type QueueRevision = z.infer<typeof queueOwnerSchema>;
export type Snapshot = Readonly<{
  ownerEpoch: number;
  employees: readonly Employee[];
  hires: readonly HireRecord[];
  captures: readonly CaptureReceipt[];
  queueRevisions: readonly QueueRevision[];
  authorizations: readonly TargetAuthorization[];
  teams: readonly Team[];
  itemExecutions: readonly ItemExecution[];
  itemTransitions: readonly ItemTransition[];
  messages: readonly Message[];
  claims: readonly Claim[];
  results: readonly Settlement[];
  duties: readonly Duty[];
  dutySchedules: readonly Readonly<{ id: string; nextDue: number | null }>[];
  occurrences: readonly Occurrence[];
  grants: readonly Grant[];
  legacyLocks: readonly LegacyLock[];
  teamRequirements: readonly z.infer<typeof teamRequirementSchema>[];
  intakes: readonly IntakeRecord[];
  inputs: readonly ReceivedInput[];
  assignments: readonly Assignment[];
}>;

// This connector is host-only. The adapter supplies scope, authority and bindings from native evidence.
export function openStore(args: {
  readonly path: string;
  readonly scope: Scope;
  readonly owner: Owner;
  readonly now: () => number;
}) {
  const scope: Scope = scopeSchema.parse(args.scope);
  const owner: Owner = ownerSchema.parse(args.owner);
  const expected: string = join(
    resolve(scope.home),
    "startup",
    scope.name,
    "staff.sqlite",
  );
  if (
    !isAbsolute(scope.home) ||
    !isAbsolute(scope.boundRoot) ||
    resolve(args.path) !== expected
  )
    throw new StoreAuthorityError(
      "Store path must be <absolute home>/startup/<name>/staff.sqlite",
    );
  mkdirSync(dirname(expected), { recursive: true, mode: 0o700 });
  const stateDirectory: string = realpathSync(dirname(expected));
  const boundRoot: string = realpathSync(scope.boundRoot);
  const withinRoot: string = relative(boundRoot, stateDirectory);
  if (
    withinRoot === "" ||
    (!withinRoot.startsWith("..") && !isAbsolute(withinRoot))
  )
    throw new StoreAuthorityError(
      "Startup state must be outside the bound repository",
    );
  if (
    existsSync(expected) &&
    realpathSync(expected) !== join(stateDirectory, "staff.sqlite")
  )
    throw new StoreAuthorityError(
      "Store file may not redirect through a symlink",
    );
  const db: Database = new Database(expected, { create: true, strict: true });
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, epoch INTEGER NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL);",
  );
  const token: string = randomUUID();
  let closed: boolean = false;
  function now(): number {
    return timeSchema.parse(args.now());
  }
  function read<T>(kind: string, id: string, schema: z.ZodType<T>): T | null {
    const row: unknown = db
      .query("SELECT payload FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row === null
      ? null
      : schema.parse(JSON.parse(storedSchema.parse(row).payload));
  }
  function all<T>(kind: string, schema: z.ZodType<T>): readonly T[] {
    return db
      .query("SELECT payload FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map(
        (row: unknown): T =>
          schema.parse(JSON.parse(storedSchema.parse(row).payload)),
      );
  }
  function put(kind: string, id: string, payload: unknown): void {
    const body: string = encode(payload);
    db.query(
      "INSERT INTO records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
    ).run(kind, id, body);
    db.query("INSERT INTO audit(kind,id,payload) VALUES(?,?,?)").run(
      kind,
      id,
      body,
    );
  }
  let epoch: number;
  try {
    epoch = db
      .transaction((): number => {
        const saved: Scope | null = read("meta", "scope", scopeSchema);
        if (saved !== null && !sameDocument(saved, scope))
          throw new StoreAuthorityError(
            "Database belongs to a different host, Startup, bound root or manager session",
          );
        const previous: unknown = db
          .query(
            "SELECT token,epoch,generation,expires FROM lease WHERE singleton=1",
          )
          .get();
        const lease = previous === null ? null : leaseSchema.parse(previous);
        const timestamp: number = now();
        if (lease !== null && lease.expires > timestamp)
          throw new StoreFenceError(
            "A live runtime owner already holds this Startup lease",
          );
        const next: number = timeSchema.parse((lease?.epoch ?? 0) + 1);
        if (lease !== null && owner.managerGeneration < lease.generation)
          throw new StoreFenceError("Manager native generation is stale");
        db.query(
          "INSERT INTO lease VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,epoch=excluded.epoch,generation=excluded.generation,expires=excluded.expires",
        ).run(
          token,
          next,
          owner.managerGeneration,
          timeSchema.parse(timestamp + owner.leaseMs),
        );
        if (saved === null) put("meta", "scope", scope);
        put("owner", String(next), {
          ...owner,
          epoch: next,
          acquiredAt: timestamp,
        });
        const manager: Employee | null = read(
          "employee",
          "manager",
          employeeSchema,
        );
        if (
          manager !== null &&
          manager.error !== null &&
          read("managerFailure", "manager", employeeSchema) === null
        )
          put("managerFailure", "manager", manager);
        if (manager === null)
          put(
            "employee",
            "manager",
            employeeSchema.parse({
              id: "manager",
              role: "manager",
              employment: "hired",
              generation: owner.managerGeneration,
              nativeHandle: scope.managerSession,
              source: null,
              assignment: null,
              canonicalRevision: null,
              checkpoint: null,
              error: null,
            }),
          );
        else if (manager.generation !== owner.managerGeneration)
          put("employee", "manager", {
            ...manager,
            generation: owner.managerGeneration,
            source: null,
          });
        for (const claim of all("claim", claimSchema).filter(
          (entry): boolean => entry.status === "active",
        ))
          put("claim", claim.id, { ...claim, status: "reconciliation" });
        for (const grant of all("grant", grantSchema).filter(
          (entry): boolean => entry.state === "held",
        ))
          put("grant", grant.id, { ...grant, state: "reconciliation" });
        return next;
      })
      .immediate();
  } catch (error: unknown) {
    db.close();
    throw error;
  }
  function fence(): void {
    if (closed) throw new StoreFenceError("Store connection is closed");
    const lease = leaseSchema.parse(
      db
        .query(
          "SELECT token,epoch,generation,expires FROM lease WHERE singleton=1",
        )
        .get(),
    );
    const timestamp: number = now();
    if (
      lease.token !== token ||
      lease.epoch !== epoch ||
      lease.generation !== owner.managerGeneration ||
      lease.expires <= timestamp
    )
      throw new StoreFenceError(
        "Runtime owner lease or generation is stale; reopen and reconcile",
      );
    db.query("UPDATE lease SET expires=? WHERE singleton=1").run(
      timeSchema.parse(timestamp + owner.leaseMs),
    );
  }
  function tx<T>(operation: () => T): T {
    return db
      .transaction((): T => {
        fence();
        return operation();
      })
      .immediate();
  }
  function employee(id: string): Employee {
    const found: Employee | null = read(
      "employee",
      idSchema.parse(id),
      employeeSchema,
    );
    if (found === null || found.employment !== "hired")
      throw new StoreAuthorityError(
        `Employee ${id} is not hired in this Startup`,
      );
    return found;
  }
  function actor(input: Binding): Employee {
    const binding: Binding = bindingSchema.parse(input);
    const found: Employee = employee(binding.employeeId);
    if (
      found.generation !== binding.generation ||
      found.nativeHandle !== binding.nativeHandle
    )
      throw new StoreFenceError(
        `Native binding is stale for employee ${found.id}`,
      );
    if (found.error !== null)
      throw new StoreFenceError(
        `Employee ${found.id} has a failed native binding`,
      );
    if (found.role !== "manager" && found.source === null)
      throw new StoreAuthorityError(
        `Employee ${found.id} has no complete source-load receipt`,
      );
    return found;
  }
  function manager(binding: Binding): Employee {
    const found: Employee = actor(binding);
    if (found.role !== "manager")
      throw new StoreAuthorityError(
        `Employee ${found.id} is not the bound manager`,
      );
    return found;
  }
  function authorize(input: Authority): void {
    const authority: Authority = authoritySchema.parse(input);
    if (authority.kind === "employee") manager(authority.binding);
  }
  function team(id: string): Team {
    const found: Team | null = read("team", id, teamSchema);
    if (found === null)
      throw new StoreConflictError(`Team ${id} does not exist`);
    return found;
  }
  function members(current: Team): readonly string[] {
    return [current.architect, current.qa, ...current.devs];
  }
  function ready(current: Team): boolean {
    return members(current).every((id): boolean => {
      const member: Employee = employee(id);
      return (
        member.assignment === current.id &&
        member.generation === current.generations[id] &&
        member.nativeHandle !== null &&
        member.source !== null &&
        member.error === null
      );
    });
  }
  function assertReplay(saved: unknown, input: unknown, id: string): void {
    if (!sameDocument(saved, input))
      throw new StoreConflictError(
        `Immutable request ${id} conflicts with its saved payload`,
      );
  }
  function hireReceipt(request: Hire, ids: readonly string[]): HireReceipt {
    const employees: readonly Employee[] = ids.map((id): Employee => {
      const found = read("employee", id, employeeSchema);
      if (found === null)
        throw new StoreRecoveryError(
          `Hire ${request.requestId} lost employee ${id}`,
        );
      return found;
    });
    const readyCount: number = employees.filter(
      (entry): boolean =>
        entry.nativeHandle !== null &&
        entry.source !== null &&
        entry.error === null &&
        entry.employment === "hired",
    ).length;
    const failed: number = employees.filter(
      (entry): boolean => entry.error !== null && entry.employment === "hired",
    ).length;
    const retired: number = employees.filter(
      (entry): boolean => entry.employment === "retired",
    ).length;
    return {
      requestId: request.requestId,
      requested: request.additional,
      reserved: ids.length,
      ready: readyCount,
      starting: ids.length - readyCount - failed - retired,
      failed,
      retired,
      employees,
    };
  }
  function route(sender: Employee, cue: Cue): void {
    employee(cue.recipient);
    if (sender.role === "manager") return;
    if (sender.assignment !== null) {
      const current: Team = team(sender.assignment);
      if (current.state === "finished")
        throw new StoreAuthorityError("Finished team cannot send new work");
      if (sender.id === current.architect) {
        if (
          cue.kind === "report" ||
          cue.kind === "question" ||
          cue.kind === "alert"
        ) {
          if (cue.recipient !== "manager")
            throw new StoreAuthorityError(
              "Architect reports only to the manager",
            );
        } else if (
          !members(current).includes(cue.recipient) ||
          cue.recipient === sender.id
        )
          throw new StoreAuthorityError(
            "Architect may assign only its own team members",
          );
      } else if (
        cue.recipient !== current.architect ||
        !["report", "question", "alert"].includes(cue.kind)
      )
        throw new StoreAuthorityError(
          "Team members report only through their architect",
        );
    } else if (
      cue.recipient !== "manager" ||
      !["report", "question", "alert"].includes(cue.kind)
    )
      throw new StoreAuthorityError(
        "Standing staff must route reports and capacity requests to the manager",
      );
  }
  function saveCue(sender: Employee, cue: Cue, teamId: string | null): Message {
    route(sender, cue);
    const previous: Message | null = read("message", cue.id, messageSchema);
    if (previous !== null) {
      assertReplay(
        {
          id: previous.id,
          recipient: previous.recipient,
          kind: previous.kind,
          correlation: previous.correlation,
          payload: previous.payload,
          sender: previous.sender,
          teamId: previous.teamId,
        },
        { ...cue, sender: sender.id, teamId },
        cue.id,
      );
      return previous;
    }
    const sequence: number = all("message", messageSchema).length + 1;
    const message: Message = messageSchema.parse({
      ...cue,
      sender: sender.id,
      sequence,
      teamId,
      status: "pending",
    });
    put("message", cue.id, message);
    if (cue.kind === "assignment")
      put("assignment", cue.id, {
        id: cue.id,
        employeeId: cue.recipient,
        state: "pending",
      });
    return message;
  }
  function readFile(file: string): string | null {
    const path: string = join(stateDirectory, file);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }
  function finalizeCapture(receipt: CaptureReceipt): void {
    const current: Team = team(receipt.teamId);
    for (const item of receipt.items.filter((entry): boolean =>
      receipt.request.rows.some((change): boolean => change.id === entry.id),
    ))
      put("queueOwner", item.id, {
        id: item.id,
        eventId: current.eventId,
        revision: item.revision,
      });
    put("capture", receipt.request.captureId, receipt);
    put("team", current.id, {
      ...current,
      items: receipt.items,
      state: "active",
    });
  }
  function canonicalQueue() {
    const before = readFile("queue.json");
    if (before === null)
      return { before, rows: z.array(rowSchema).parse([]), container: null };
    const document = jsonSchema.parse(JSON.parse(before));
    if (Array.isArray(document))
      return {
        before,
        rows: z.array(rowSchema).parse(document),
        container: null,
      };
    const container = z.record(z.string(), jsonSchema).parse(document);
    return {
      before,
      rows: z.array(rowSchema).parse(container.items),
      container,
    };
  }
  function finalizeItem(receipt: ItemTransition): void {
    const current = team(receipt.teamId);
    put("queueOwner", receipt.request.itemId, {
      id: receipt.request.itemId,
      eventId: receipt.eventId,
      revision: receipt.revision,
    });
    put("team", current.id, {
      ...current,
      items: current.items.map((item) =>
        item.id === receipt.request.itemId
          ? { id: item.id, revision: receipt.revision }
          : item,
      ),
    });
    if (receipt.execution !== null)
      put("itemExecution", receipt.request.itemId, receipt.execution);
    for (const draft of receipt.cues)
      saveCue(draft.sender, draft.cue, draft.teamId);
    put("itemTransition", receipt.request.requestId, receipt);
  }
  function applyIntent(id: string): void {
    tx((): void => {
      const intent = read("intent", id, writeIntentSchema);
      if (intent === null || intent.state === "complete") return;
      const actual: string | null = readFile(intent.file);
      if (actual !== intent.before && actual !== intent.after)
        throw new StoreRecoveryError(
          `Interrupted write ${id} conflicts with ${intent.file}; preserve both versions and reconcile`,
        );
      if (actual !== intent.after) {
        const destination: string = join(stateDirectory, intent.file);
        const temporary: string = `${destination}.${token}.pending`;
        writeFileSync(temporary, intent.after, {
          encoding: "utf8",
          flush: true,
          mode: 0o600,
        });
        renameSync(temporary, destination);
        const directory: number = openSync(stateDirectory, "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      }
      if (readFile(intent.file) !== intent.after)
        throw new StoreRecoveryError(
          `Read-back verification failed for ${intent.file}, write ${id}`,
        );
      if (intent.capture !== null) finalizeCapture(intent.capture);
      if (intent.item !== undefined) finalizeItem(intent.item);
      if (intent.file === "resources.json")
        put(
          "resources",
          "projection",
          jsonSchema.parse(JSON.parse(intent.after)),
        );
      put("intent", id, { ...intent, state: "complete" });
    });
  }
  function pendingWrites(): void {
    const records: readonly {
      readonly id: string;
      readonly payload: string;
    }[] = z
      .array(z.strictObject({ id: z.string(), payload: z.string() }))
      .parse(
        db
          .query(
            "SELECT id,payload FROM records WHERE kind='intent' ORDER BY rowid",
          )
          .all(),
      );
    for (const record of records)
      if (
        writeIntentSchema.parse(JSON.parse(record.payload)).state === "pending"
      )
        applyIntent(record.id);
  }
  try {
    pendingWrites();
  } catch (error: unknown) {
    db.close();
    throw error;
  }

  return {
    ownerEpoch: epoch,
    managerBinding: bindingSchema.parse({
      employeeId: "manager",
      generation: owner.managerGeneration,
      nativeHandle: scope.managerSession,
    }),
    renewLease(): void {
      tx((): void => {});
    },
    recoverManager(input: { readonly evidence: Json }): Employee {
      return tx((): Employee => {
        const current: Employee = employee("manager");
        const failure: Employee | null = read(
          "managerFailure",
          "manager",
          employeeSchema,
        );
        const evidence: Json = jsonSchema.parse(input.evidence);
        if (
          evidence === null ||
          failure === null ||
          current.error === null ||
          failure.generation >= owner.managerGeneration ||
          current.generation !== owner.managerGeneration ||
          current.nativeHandle !== scope.managerSession
        )
          throw new StoreRecoveryError(
            "Manager recovery requires a failed prior generation, current owner/root evidence and a newer native generation",
          );
        const recovered: Employee = { ...current, error: null, source: null };
        put("managerRecovery", String(epoch), {
          ownerEpoch: epoch,
          ownerId: owner.id,
          managerSession: scope.managerSession,
          generation: owner.managerGeneration,
          failure,
          evidence,
        });
        put("employee", "manager", recovered);
        return recovered;
      });
    },
    reserveHire(input: {
      readonly authority: Authority;
      readonly request: Hire;
    }): HireReceipt {
      return tx((): HireReceipt => {
        authorize(input.authority);
        const request: Hire = hireSchema.parse(input.request);
        const previous = read("hire", request.requestId, hireRecordSchema);
        if (previous !== null) {
          assertReplay(previous.request, request, request.requestId);
          return hireReceipt(request, previous.ids);
        }
        const existingCount: number = all("employee", employeeSchema).length;
        if (!Number.isSafeInteger(existingCount + request.additional))
          throw new StoreConflictError(
            "Employee count exceeds safe integer capacity",
          );
        const ids: readonly string[] = Array.from(
          { length: request.additional },
          (): string => randomUUID(),
        );
        for (const id of ids)
          put(
            "employee",
            id,
            employeeSchema.parse({
              id,
              role: request.role,
              employment: "hired",
              generation: 0,
              nativeHandle: null,
              source: null,
              assignment: null,
              canonicalRevision: request.revision,
              checkpoint: null,
              error: null,
            }),
          );
        put("hire", request.requestId, { request, ids });
        return hireReceipt(request, ids);
      });
    },
    bindEmployee(input: {
      readonly manager: Binding;
      readonly binding: Bind;
    }): Employee {
      return tx((): Employee => {
        manager(input.manager);
        const binding: Bind = bindSchema.parse(input.binding);
        const current: Employee = employee(binding.employeeId);
        if (
          !binding.source.rolePath.endsWith(
            `/startup-role-${current.role}/SKILL.md`,
          ) ||
          !binding.source.loopPath.endsWith("/startup-loop/SKILL.md") ||
          (current.canonicalRevision !== null &&
            binding.source.roleRevision !== current.canonicalRevision)
        )
          throw new StoreAuthorityError(
            "Source-load receipt does not match the reserved canonical role and revision",
          );
        if (current.assignment !== binding.assignment)
          throw new StoreConflictError(
            "Native assignment does not match employee reservation",
          );
        const prior = read(
          "binding",
          `${binding.employeeId}/${binding.generation}`,
          bindSchema,
        );
        if (prior !== null) {
          assertReplay(
            prior,
            binding,
            `binding ${binding.employeeId}/${binding.generation}`,
          );
          if (
            current.generation !== binding.generation ||
            current.nativeHandle !== binding.nativeHandle ||
            current.error !== null ||
            current.source === null
          )
            throw new StoreFenceError(
              "Cannot replay a superseded native binding",
            );
          return current;
        }
        if (current.nativeHandle !== null && current.role !== "manager")
          throw new StoreConflictError(
            "Reserve explicit native replacement before rebinding an active employee",
          );
        if (
          binding.generation !== current.generation + 1 &&
          current.role !== "manager"
        )
          throw new StoreFenceError(
            "A new native binding must advance the employee generation by one",
          );
        if (
          current.role === "manager" &&
          (binding.generation !== owner.managerGeneration ||
            binding.nativeHandle !== scope.managerSession)
        )
          throw new StoreFenceError(
            "Manager binding must match the owner root",
          );
        if (
          binding.assignment !== null &&
          team(binding.assignment).generations[current.id] !==
            binding.generation
        )
          throw new StoreFenceError(
            "Team binding must use its reserved generation",
          );
        if (
          all("binding", bindSchema).some(
            (entry): boolean =>
              entry.nativeHandle === binding.nativeHandle &&
              entry.employeeId !== "manager",
          )
        )
          throw new StoreConflictError(
            "Native handle was already used; a fresh assignment requires fresh context",
          );
        const unresolved = all("claim", claimSchema).find(
          (claim): boolean =>
            claim.employeeId === current.id && claim.status !== "settled",
        );
        if (unresolved !== undefined)
          throw new StoreRecoveryError(
            `Employee ${current.id} has unresolved claim ${unresolved.id}`,
          );
        const updated: Employee = employeeSchema.parse({
          ...current,
          generation: binding.generation,
          nativeHandle: binding.nativeHandle,
          source: binding.source,
          error: null,
        });
        put("employee", current.id, updated);
        put("binding", `${current.id}/${binding.generation}`, binding);
        if (current.assignment !== null) {
          const reserved: Team = team(current.assignment);
          if (ready(reserved)) {
            const captured: boolean = all("capture", captureRecordSchema).some(
              (receipt): boolean => receipt.teamId === reserved.id,
            );
            put("team", reserved.id, {
              ...reserved,
              state: captured ? "active" : "ready",
            });
          }
        }
        return updated;
      });
    },
    reserveReplacement(input: {
      readonly manager: Binding;
      readonly employeeId: string;
      readonly evidence: Json;
    }): number {
      return tx((): number => {
        manager(input.manager);
        const current: Employee = employee(input.employeeId);
        if (current.role === "manager")
          throw new StoreAuthorityError(
            "Manager replacement requires a new owner lease",
          );
        if (input.evidence === null)
          throw new StoreRecoveryError(
            "Native replacement requires explicit recovery evidence",
          );
        if (
          all("claim", claimSchema).some(
            (claim): boolean =>
              claim.employeeId === current.id && claim.status !== "settled",
          ) ||
          all("grant", grantSchema).some(
            (grant): boolean =>
              grant.employeeId === current.id && grant.state !== "released",
          )
        )
          throw new StoreRecoveryError(
            "Reconcile claims and target grants before replacing the native context",
          );
        const generation: number = timeSchema.parse(current.generation + 1);
        put(
          "replacement",
          `${current.id}/${generation}`,
          jsonSchema.parse(input.evidence),
        );
        put("employee", current.id, {
          ...current,
          nativeHandle: null,
          source: null,
          error: null,
        });
        if (current.assignment !== null) {
          const assigned: Team = team(current.assignment);
          put("team", assigned.id, {
            ...assigned,
            state: "reserved",
            generations: { ...assigned.generations, [current.id]: generation },
          });
        }
        return generation;
      });
    },
    refreshCanonical(input: {
      readonly manager: Binding;
      readonly employeeId: string;
      readonly source: Source;
      readonly evidence: Json;
    }): number {
      return tx((): number => {
        manager(input.manager);
        const current: Employee = employee(input.employeeId);
        const source: Source = sourceSchema.parse(input.source);
        if (current.role === "manager" || current.employment !== "hired")
          throw new StoreAuthorityError(
            "Canonical refresh requires an employed non-manager; manager refresh requires a newer native owner context",
          );
        if (
          !source.rolePath.endsWith(`/startup-role-${current.role}/SKILL.md`) ||
          !source.loopPath.endsWith("/startup-loop/SKILL.md") ||
          input.evidence === null
        )
          throw new StoreAuthorityError(
            "Canonical refresh requires role-matched host source and explicit evidence",
          );
        if (
          current.assignment !== null ||
          all("claim", claimSchema).some(
            (entry) =>
              entry.employeeId === current.id && entry.status !== "settled",
          ) ||
          all("grant", grantSchema).some(
            (entry) =>
              entry.employeeId === current.id && entry.state !== "released",
          ) ||
          all("assignment", assignmentSchema).some(
            (entry) =>
              entry.employeeId === current.id &&
              entry.state !== "complete" &&
              !(
                entry.state === "pending" &&
                all("message", messageSchema).some(
                  (message) =>
                    message.id === entry.id &&
                    message.recipient === current.id &&
                    message.status === "pending",
                )
              ),
          ) ||
          all("message", messageSchema).some(
            (entry) =>
              entry.recipient === current.id && entry.status === "claimed",
          ) ||
          all("occurrence", occurrenceSchema).some(
            (entry) =>
              entry.employeeId === current.id && entry.observedAt === null,
          )
        )
          throw new StoreRecoveryError(
            "Canonical refresh requires an idle boundary with resolved claims, started assignments, claimed incoming mail, grants and active duty occurrences",
          );
        const generation: number = timeSchema.parse(current.generation + 1);
        put("canonicalRefresh", `${current.id}/${generation}`, {
          previous: current,
          source,
          generation,
          evidence: jsonSchema.parse(input.evidence),
        });
        put("replacement", `${current.id}/${generation}`, {
          kind: "canonical-refresh",
          source,
          evidence: jsonSchema.parse(input.evidence),
        });
        put("employee", current.id, {
          ...current,
          nativeHandle: null,
          source: null,
          error: null,
          canonicalRevision: source.roleRevision,
        });
        return generation;
      });
    },
    recordBindingFailure(input: {
      readonly manager: Binding;
      readonly employeeId: string;
      readonly error: string;
    }): void {
      tx((): void => {
        manager(input.manager);
        const current = employee(input.employeeId);
        put("employee", current.id, {
          ...current,
          error: z.string().min(1).parse(input.error),
        });
        if (current.role === "manager")
          put("managerFailure", "manager", { ...current, error: input.error });
        for (const claim of all("claim", claimSchema).filter(
          (entry): boolean =>
            entry.employeeId === current.id && entry.status === "active",
        ))
          put("claim", claim.id, { ...claim, status: "reconciliation" });
        for (const grant of all("grant", grantSchema).filter(
          (entry): boolean =>
            entry.employeeId === current.id && entry.state === "held",
        ))
          put("grant", grant.id, { ...grant, state: "reconciliation" });
        if (current.assignment !== null)
          put("team", current.assignment, {
            ...team(current.assignment),
            state: "reserved",
          });
      });
    },
    receiveInput(input: ReceivedInput): ReceivedInput {
      return tx((): ReceivedInput => {
        const received: ReceivedInput = receivedInputSchema.parse(input);
        if (received.disposition !== null)
          throw new StoreAuthorityError(
            "Native ingress must begin unclassified",
          );
        const previous = read(
          "receivedInput",
          received.id,
          receivedInputSchema,
        );
        if (previous !== null) {
          assertReplay(
            { ...previous, disposition: null },
            received,
            received.id,
          );
          return previous;
        }
        put("receivedInput", received.id, received);
        return received;
      });
    },
    routeInput(input: {
      readonly manager: Binding;
      readonly inputId: string;
      readonly disposition: z.infer<typeof inputDispositionSchema>;
    }): ReceivedInput {
      return tx((): ReceivedInput => {
        manager(input.manager);
        const id: string = idSchema.parse(input.inputId);
        const received = read("receivedInput", id, receivedInputSchema);
        if (received === null)
          throw new StoreAuthorityError("Native received input does not exist");
        const disposition = inputDispositionSchema.parse(input.disposition);
        if (
          disposition.kind !== "work" &&
          disposition.amendItemIds.length !== 0
        )
          throw new StoreAuthorityError(
            "Only work disposition may reference amended items",
          );
        if (received.disposition !== null) {
          assertReplay(received.disposition, disposition, id);
          return received;
        }
        if (disposition.kind === "work") {
          const event: Intake = intakeSchema.parse({
            eventId: id,
            input: received.raw,
            amendItemIds: disposition.amendItemIds,
          });
          const previous = read("intake", id, intakeRecordSchema);
          if (previous !== null) assertReplay(previous.request, event, id);
          else put("intake", id, { request: event, teamId: null });
        }
        const routed: ReceivedInput = { ...received, disposition };
        put("receivedInput", id, routed);
        return routed;
      });
    },
    recordIntake(input: {
      readonly manager: Binding;
      readonly event: Intake;
    }): Intake {
      return tx((): Intake => {
        manager(input.manager);
        const event: Intake = intakeSchema.parse(input.event);
        const previous = read("intake", event.eventId, intakeRecordSchema);
        if (previous !== null)
          assertReplay(previous.request, event, event.eventId);
        else put("intake", event.eventId, { request: event, teamId: null });
        return event;
      });
    },
    recordTeamRequirement(input: {
      readonly manager: Binding;
      readonly request: z.infer<typeof teamRequirementSchema>;
    }): void {
      tx(() => {
        manager(input.manager);
        const request = teamRequirementSchema.parse(input.request);
        if (read("intake", request.eventId, intakeRecordSchema) === null)
          throw new StoreAuthorityError(
            "Team requirements require saved intake",
          );
        const previous = read(
          "teamRequirement",
          request.eventId,
          teamRequirementSchema,
        );
        if (previous !== null) assertReplay(previous, request, request.eventId);
        else put("teamRequirement", request.eventId, request);
      });
    },
    reserveTeam(input: {
      readonly manager: Binding;
      readonly request: TeamRequest;
    }): Team {
      return tx((): Team => {
        const leader: Employee = manager(input.manager);
        const request: TeamRequest = teamRequestSchema.parse(input.request);
        const event = read("intake", request.eventId, intakeRecordSchema);
        if (event === null)
          throw new StoreConflictError(
            "Record immutable intake before team reservation",
          );
        const previous = read(
          "teamRequest",
          request.eventId,
          teamRequestSchema,
        );
        if (previous !== null) {
          assertReplay(previous, request, request.eventId);
          if (event.teamId === null)
            throw new StoreRecoveryError(
              "Saved team request is missing its team",
            );
          return team(event.teamId);
        }
        const ids: readonly string[] = [
          request.architect,
          request.qa,
          ...request.devs,
        ];
        if (new Set(ids).size !== ids.length)
          throw new StoreConflictError(
            "Each team member must be a distinct employee",
          );
        const staff: readonly Employee[] = ids.map(employee);
        for (const member of staff) {
          const expectedRole: string =
            member.id === request.architect
              ? "architect"
              : member.id === request.qa
                ? "qa"
                : "dev";
          if (member.role !== expectedRole || member.assignment !== null)
            throw new StoreConflictError(
              `Employee ${member.id} is not an idle ${expectedRole}`,
            );
          if (
            all("claim", claimSchema).some(
              (claim): boolean =>
                claim.employeeId === member.id && claim.status !== "settled",
            ) ||
            all("grant", grantSchema).some(
              (grant): boolean =>
                grant.employeeId === member.id && grant.state !== "released",
            ) ||
            all("assignment", assignmentSchema).some(
              (assignment): boolean =>
                assignment.employeeId === member.id &&
                assignment.state !== "complete",
            ) ||
            all("message", messageSchema).some(
              (message): boolean =>
                message.recipient === member.id &&
                message.status !== "acknowledged",
            )
          )
            throw new StoreConflictError(
              `Employee ${member.id} has unfinished work, mail or target grants`,
            );
        }
        if (
          request.cues.length !== ids.length ||
          new Set(request.cues.map((cue): string => cue.recipient)).size !==
            ids.length ||
          request.cues.some(
            (cue): boolean =>
              !ids.includes(cue.recipient) ||
              cue.kind !== "assignment" ||
              cue.correlation !== request.eventId,
          )
        )
          throw new StoreConflictError(
            "Team reservation requires exactly one event-bound assignment cue per member",
          );
        const id: string = randomUUID();
        const reserved: Team = teamSchema.parse({
          id,
          eventId: request.eventId,
          architect: request.architect,
          qa: request.qa,
          devs: request.devs,
          generations: Object.fromEntries(
            staff.map((member): [string, number] => [
              member.id,
              member.generation + 1,
            ]),
          ),
          state: "reserved",
          items: [],
        });
        put("team", id, reserved);
        for (const member of staff)
          put("employee", member.id, {
            ...member,
            assignment: id,
            nativeHandle: null,
            source: null,
            error: null,
            checkpoint: null,
          });
        for (const cue of request.cues) saveCue(leader, cue, id);
        put("teamRequest", request.eventId, request);
        put("intake", request.eventId, { ...event, teamId: id });
        return reserved;
      });
    },
    captureIntake(input: {
      readonly architect: Binding;
      readonly capture: Capture;
    }): CaptureReceipt {
      pendingWrites();
      const receipt: CaptureReceipt = tx((): CaptureReceipt => {
        const leader: Employee = actor(input.architect);
        const capture: Capture = captureSchema.parse(input.capture);
        const event = read("intake", capture.eventId, intakeRecordSchema);
        if (event === null || event.teamId === null)
          throw new StoreAuthorityError("Intake event has no reserved team");
        const current: Team = team(event.teamId);
        if (
          leader.role !== "architect" ||
          current.architect !== leader.id ||
          leader.assignment !== current.id ||
          current.state === "finished" ||
          !ready(current)
        )
          throw new StoreAuthorityError(
            "Only the ready event team's architect may capture its intake",
          );
        const previous = read(
          "capture",
          capture.captureId,
          captureRecordSchema,
        );
        if (previous !== null) {
          assertReplay(previous.request, capture, capture.captureId);
          return previous;
        }
        const before: string | null = readFile("queue.json");
        const document: Json =
          before === null ? [] : jsonSchema.parse(JSON.parse(before));
        const arrayShape: boolean = Array.isArray(document);
        const container = arrayShape
          ? null
          : z.record(z.string(), jsonSchema).parse(document);
        const rows = z
          .array(rowSchema)
          .parse(arrayShape ? document : container?.items);
        if (new Set(rows.map((row): string => row.id)).size !== rows.length)
          throw new StoreRecoveryError(
            "Canonical queue contains duplicate IDs",
          );
        if (
          new Set(capture.rows.map((row): string => row.id)).size !==
          capture.rows.length
        )
          throw new StoreConflictError("Capture contains duplicate row IDs");
        const changes = capture.rows.map((change) => {
          const found = rows.find((row): boolean => row.id === change.id);
          const ownership = read("queueOwner", change.id, queueOwnerSchema);
          if (found !== undefined) {
            if ((ownership?.revision ?? 0) !== change.expectedRevision)
              throw new StoreConflictError(
                `Queue row ${change.id} has a stale revision`,
              );
            if (
              ownership?.eventId !== capture.eventId &&
              !event.request.amendItemIds.includes(change.id)
            )
              throw new StoreAuthorityError(
                `Queue row ${change.id} is outside this delegated event`,
              );
            if (
              !["QUEUED", "NEEDS_DECISION"].includes(
                z.string().parse(found.status),
              ) ||
              found.dispatched_at != null
            )
              throw new StoreAuthorityError(
                `Queue row ${change.id} is dispatched or terminal; create a linked follow-up`,
              );
            if (ownership !== null && ownership.eventId !== capture.eventId) {
              const previousEvent = read(
                "intake",
                ownership.eventId,
                intakeRecordSchema,
              );
              if (
                previousEvent?.teamId !== null &&
                previousEvent?.teamId !== undefined
              ) {
                const previousTeam: Team = team(previousEvent.teamId);
                if (
                  !["waiting", "finished"].includes(previousTeam.state) ||
                  all("claim", claimSchema).some(
                    (claim): boolean =>
                      members(previousTeam).includes(claim.employeeId) &&
                      claim.status !== "settled",
                  )
                )
                  throw new StoreAuthorityError(
                    `Queue row ${change.id} belongs to a competing active team`,
                  );
              }
            }
            if (
              typeof found.request === "string" &&
              typeof change.fields.request === "string" &&
              !change.fields.request.startsWith(found.request)
            )
              throw new StoreConflictError(
                "Queue amendments must retain the previous request text",
              );
          }
          if (found === undefined && change.expectedRevision !== null)
            throw new StoreConflictError(
              `New queue row ${change.id} requires null expectedRevision`,
            );
          if ("id" in change.fields && change.fields.id !== change.id)
            throw new StoreConflictError("Queue ID cannot be changed");
          const revision: number = (ownership?.revision ?? 0) + 1;
          const previousRefs: readonly Json[] =
            found?.intake_refs === undefined
              ? []
              : z.array(jsonSchema).parse(found.intake_refs);
          const suppliedRefs: readonly Json[] =
            change.fields.intake_refs === undefined
              ? []
              : z.array(jsonSchema).parse(change.fields.intake_refs);
          const row = rowSchema.parse({
            ...found,
            ...change.fields,
            id: change.id,
            intake_refs: [
              ...previousRefs,
              ...suppliedRefs.filter(
                (ref): boolean =>
                  !previousRefs.some((old): boolean => sameDocument(old, ref)),
              ),
              capture.eventId,
            ],
          });
          z.object({
            request: z.string().min(1),
            acceptance: jsonSchema,
            blocked_on: jsonSchema,
            status: z.enum(["QUEUED", "NEEDS_DECISION", "REJECTED"]),
          }).parse(row);
          return { row, id: change.id, revision };
        });
        const nextRows = [
          ...rows.map(
            (row) =>
              changes.find((change): boolean => change.id === row.id)?.row ??
              row,
          ),
          ...changes
            .filter(
              (change): boolean =>
                !rows.some((row): boolean => row.id === change.id),
            )
            .map((change) => change.row),
        ];
        const after: string =
          JSON.stringify(
            arrayShape ? nextRows : { ...container, items: nextRows },
            null,
            2,
          ) + "\n";
        const saved: CaptureReceipt = captureRecordSchema.parse({
          request: capture,
          teamId: current.id,
          items: [
            ...current.items.filter(
              (item): boolean =>
                !changes.some((change): boolean => change.id === item.id),
            ),
            ...changes.map((change) => ({
              id: change.id,
              revision: change.revision,
            })),
          ],
        });
        put("intent", `capture/${capture.captureId}`, {
          file: "queue.json",
          before,
          after,
          state: "pending",
          capture: saved,
        });
        return saved;
      });
      applyIntent(`capture/${receipt.request.captureId}`);
      return receipt;
    },
    queueItems(): readonly z.infer<typeof rowSchema>[] {
      return canonicalQueue().rows;
    },
    transitionItem(input: {
      readonly employee: Binding;
      readonly request: ItemAction;
    }): ItemTransition {
      const receipt: ItemTransition = tx(() => {
        const sender = actor(input.employee);
        const request = itemActionSchema.parse(input.request);
        const ownership = read("queueOwner", request.itemId, queueOwnerSchema);
        const event =
          ownership === null
            ? null
            : read("intake", ownership.eventId, intakeRecordSchema);
        if (
          ownership === null ||
          event?.teamId === null ||
          event?.teamId === undefined
        )
          throw new StoreAuthorityError(
            "Canonical item has no owning delegated team",
          );
        const current = team(event.teamId);
        if (
          sender.role !== "manager" &&
          (sender.assignment !== current.id ||
            !members(current).includes(sender.id))
        )
          throw new StoreAuthorityError(
            "Item transition is outside the current owning team",
          );
        const previous = read(
          "itemTransition",
          request.requestId,
          itemTransitionSchema,
        );
        if (previous !== null) {
          assertReplay(previous.request, request, request.requestId);
          if (previous.actorId !== sender.id)
            throw new StoreAuthorityError(
              "Item receipt belongs to another actor",
            );
          return previous;
        }
        if (current.state === "finished")
          throw new StoreAuthorityError(
            "Finished team cannot transition items",
          );
        if (
          ownership.revision !== request.expectedRevision ||
          !current.items.some(
            (item) =>
              item.id === request.itemId &&
              item.revision === request.expectedRevision,
          )
        )
          throw new StoreConflictError("Item transition has a stale revision");
        const document = canonicalQueue();
        const row = document.rows.find((row) => row.id === request.itemId);
        if (!row)
          throw new StoreRecoveryError("Canonical item row is unavailable");
        const status = z.string().parse(row.status);
        let nextStatus = status;
        let execution = read(
          "itemExecution",
          request.itemId,
          itemExecutionSchema,
        );
        const cues: { sender: Employee; cue: Cue; teamId: string }[] = [];
        const evidence =
          request.action === "qa" ? request.proof : request.evidence;
        if (evidence === null)
          throw new StoreAuthorityError(
            "Item transition requires explicit evidence",
          );
        const leader =
          sender.role === "manager" || sender.id === current.architect;
        const cue = (recipient: string, kind: Cue["kind"], payload: Json) => {
          const value: Cue = {
            id: `item-${request.requestId}-${recipient}`,
            recipient,
            kind,
            correlation: request.itemId,
            payload,
          };
          route(sender, value);
          cues.push({ sender, cue: value, teamId: current.id });
          return value.id;
        };
        const resolved = (value: ItemExecution | null): boolean =>
          value === null ||
          ![value.messageId, value.qaMessageId].some(
            (id) =>
              id !== null &&
              (all("claim", claimSchema).some(
                (claim) => claim.messageId === id && claim.status !== "settled",
              ) ||
                all("assignment", assignmentSchema).some(
                  (assignment) =>
                    assignment.id === id && assignment.state !== "complete",
                )),
          );
        const completedResult = (
          resultId: string,
          messageId: string,
          employeeId: string,
          generation: number,
        ) => {
          const saved = read("result", resultId, resultRecordSchema);
          const claim =
            saved === null ? null : read("claim", saved.claimId, claimSchema);
          if (
            saved === null ||
            saved.result.kind !== "completed" ||
            claim?.messageId !== messageId ||
            claim.employeeId !== employeeId ||
            claim.generation !== generation ||
            claim.status !== "settled"
          )
            throw new StoreAuthorityError(
              "Item requires its own durable completed assignment result",
            );
          return saved.result;
        };
        switch (request.action) {
          case "assign": {
            if (!leader || status !== "QUEUED" || !ready(current))
              throw new StoreAuthorityError(
                "Only the ready own-team architect or manager may assign a queued item",
              );
            if (!resolved(execution))
              throw new StoreRecoveryError(
                "Resolve prior item claims and assignments before another execution",
              );
            if (!current.devs.includes(request.employeeId))
              throw new StoreAuthorityError(
                "Item assignee must be an owning team dev",
              );
            if (
              all("assignment", assignmentSchema).some(
                (assignment) =>
                  assignment.employeeId === request.employeeId &&
                  assignment.state !== "complete",
              )
            )
              throw new StoreConflictError("Item dev has unresolved work");
            const member = employee(request.employeeId);
            const messageId = cue(member.id, "assignment", {
              kind: "item-execution",
              itemId: row.id,
              eventId: ownership.eventId,
              teamId: current.id,
              revision: ownership.revision + 1,
              snapshot: row,
            });
            execution = itemExecutionSchema.parse({
              itemId: row.id,
              eventId: ownership.eventId,
              teamId: current.id,
              attemptId: request.requestId,
              employeeId: member.id,
              generation: member.generation,
              messageId,
              qaMessageId: null,
              qaGeneration: null,
              reviewResultId: null,
              qa: null,
              snapshot: row,
            });
            nextStatus = "EXECUTING";
            break;
          }
          case "review": {
            if (
              status !== "EXECUTING" ||
              execution === null ||
              execution.employeeId !== sender.id ||
              execution.generation !== sender.generation
            )
              throw new StoreAuthorityError(
                "Only the current assigned dev may submit item review",
              );
            completedResult(
              request.resultId,
              execution.messageId,
              sender.id,
              sender.generation,
            );
            execution = { ...execution, reviewResultId: request.resultId };
            nextStatus = "REVIEW";
            cue(current.architect, "report", {
              kind: "item-review",
              itemId: row.id,
              resultId: request.resultId,
            });
            break;
          }
          case "qa_assign": {
            if (
              sender.id !== current.architect ||
              status !== "REVIEW" ||
              execution === null ||
              execution.reviewResultId === null ||
              execution.qaMessageId !== null ||
              !ready(current)
            )
              throw new StoreAuthorityError(
                "Only the owning architect may assign pending QA review",
              );
            if (
              all("assignment", assignmentSchema).some(
                (assignment) =>
                  assignment.employeeId === current.qa &&
                  assignment.state !== "complete",
              )
            )
              throw new StoreConflictError("QA has unresolved work");
            execution = {
              ...execution,
              qaGeneration: employee(current.qa).generation,
              qaMessageId: cue(current.qa, "assignment", {
                kind: "item-qa",
                itemId: row.id,
                eventId: ownership.eventId,
                revision: ownership.revision + 1,
                resultId: execution.reviewResultId,
              }),
            };
            break;
          }
          case "qa": {
            if (
              sender.id !== current.qa ||
              status !== "REVIEW" ||
              execution?.qaMessageId === null ||
              execution?.qaMessageId === undefined
            )
              throw new StoreAuthorityError(
                "Only the owning assigned QA may record proof",
              );
            const result = completedResult(
              request.resultId,
              execution.qaMessageId,
              sender.id,
              sender.generation,
            );
            if (execution.qaGeneration !== sender.generation)
              throw new StoreFenceError("QA execution generation has changed");
            if (!sameDocument(result.output, request.proof))
              throw new StoreConflictError(
                "QA proof must equal its saved result",
              );
            execution = {
              ...execution,
              qa: {
                verdict: request.verdict,
                resultId: request.resultId,
                proof: request.proof,
              },
            };
            cue(current.architect, "report", {
              kind: "item-qa-verdict",
              itemId: row.id,
              resultId: request.resultId,
              verdict: request.verdict,
            });
            break;
          }
          case "gate": {
            if (
              sender.id !== current.architect ||
              status !== "REVIEW" ||
              execution === null
            )
              throw new StoreAuthorityError(
                "Only the owning architect may gate review",
              );
            if (
              request.verdict === "APPROVE" &&
              execution.qa?.verdict !== "APPROVE"
            )
              throw new StoreAuthorityError(
                "Architect approval requires matching completed QA proof",
              );
            if (!resolved(execution))
              throw new StoreRecoveryError(
                "Reconcile item claims and assignments before gate or REDO",
              );
            nextStatus =
              request.verdict === "APPROVE" ? "READY_TO_LAND" : "QUEUED";
            cue("manager", "report", {
              kind: "item-architect-gate",
              itemId: row.id,
              verdict: request.verdict,
            });
            break;
          }
          case "decide": {
            if (!leader)
              throw new StoreAuthorityError(
                "Only the manager or own architect may record item decisions",
              );
            if (
              ["MERGED", "DONE", "REJECTED"].includes(request.status) &&
              sender.role !== "manager"
            )
              throw new StoreAuthorityError(
                "Only the manager may record authorized item completion",
              );
            if (
              ["MERGED", "DONE"].includes(request.status) &&
              status !== "READY_TO_LAND"
            )
              throw new StoreAuthorityError(
                "Completion requires READY_TO_LAND review gates",
              );
            if (
              request.status === "QUEUED" &&
              !["BLOCKED", "NEEDS_DECISION"].includes(status)
            )
              throw new StoreAuthorityError(
                "Explicit resume requires blocked or decision state",
              );
            if (
              (request.status === "QUEUED" ||
                terminalItemStatuses.includes(request.status)) &&
              (!resolved(execution) ||
                all("grant", grantSchema).some(
                  (grant) =>
                    members(current).includes(grant.employeeId) &&
                    grant.state !== "released",
                ))
            )
              throw new StoreRecoveryError(
                "Reconcile item claims, assignments and grants before resume or completion",
              );
            if (terminalItemStatuses.includes(status))
              throw new StoreAuthorityError(
                "Terminal item requires a linked follow-up",
              );
            nextStatus = request.status;
            break;
          }
        }
        const revision = ownership.revision + 1;
        const refs =
          row.startup_state_refs === undefined
            ? []
            : z.array(jsonSchema).parse(row.startup_state_refs);
        const nextRow = rowSchema.parse({
          ...row,
          status: nextStatus,
          ...(request.action === "assign"
            ? { dispatched_at: row.dispatched_at ?? now() }
            : {}),
          startup_state_refs: [...refs, request.requestId],
        });
        const after =
          JSON.stringify(
            document.container === null
              ? document.rows.map((old) => (old.id === row.id ? nextRow : old))
              : {
                  ...document.container,
                  items: document.rows.map((old) =>
                    old.id === row.id ? nextRow : old,
                  ),
                },
            null,
            2,
          ) + "\n";
        const receipt = itemTransitionSchema.parse({
          request,
          actorId: sender.id,
          eventId: ownership.eventId,
          teamId: current.id,
          revision,
          status: nextStatus,
          row: nextRow,
          execution,
          cues,
        });
        put("intent", `item/${request.requestId}`, {
          file: "queue.json",
          before: document.before,
          after,
          state: "pending",
          capture: null,
          item: receipt,
        });
        return receipt;
      });
      applyIntent(`item/${receipt.request.requestId}`);
      return receipt;
    },
    finishTeam(input: {
      readonly manager: Binding;
      readonly teamId: string;
      readonly evidence: Json;
    }): Team {
      return tx((): Team => {
        manager(input.manager);
        jsonSchema.parse(input.evidence);
        const current: Team = team(input.teamId);
        if (current.state === "finished") return current;
        if (
          !all("capture", captureRecordSchema).some(
            (capture): boolean => capture.teamId === current.id,
          )
        )
          throw new StoreConflictError(
            "A team cannot finish before its architect records intake capture",
          );
        const rows = canonicalQueue().rows;
        if (
          current.items.some((item) => {
            const ownership = read("queueOwner", item.id, queueOwnerSchema);
            return (
              ownership?.eventId === current.eventId &&
              !terminalItemStatuses.includes(
                z
                  .string()
                  .parse(rows.find((row) => row.id === item.id)?.status),
              )
            );
          })
        )
          throw new StoreConflictError(
            "Team has currently owned nonterminal canonical items",
          );
        for (const id of members(current)) {
          if (
            all("grant", grantSchema).some(
              (grant): boolean =>
                grant.employeeId === id && grant.state !== "released",
            ) ||
            all("claim", claimSchema).some(
              (claim): boolean =>
                claim.employeeId === id && claim.status !== "settled",
            ) ||
            all("assignment", assignmentSchema).some(
              (assignment): boolean =>
                assignment.employeeId === id && assignment.state !== "complete",
            ) ||
            all("message", messageSchema).some(
              (message): boolean =>
                (message.recipient === id || message.sender === id) &&
                message.status !== "acknowledged",
            )
          )
            throw new StoreConflictError(
              `Team member ${id} has unresolved work, mail or target grants`,
            );
          put("employee", id, { ...employee(id), assignment: null });
        }
        put("teamCompletion", current.id, input.evidence);
        const finished: Team = { ...current, state: "finished" };
        put("team", current.id, finished);
        return finished;
      });
    },
    sendCue(input: { readonly sender: Binding; readonly cue: Cue }): Message {
      return tx((): Message => {
        const sender: Employee = actor(input.sender);
        return saveCue(sender, cueSchema.parse(input.cue), sender.assignment);
      });
    },
    claimNext(input: {
      readonly employee: Binding;
    }): Readonly<{ claim: Claim; message: Message }> | null {
      return tx(() => {
        const current: Employee = actor(input.employee);
        if (current.source === null)
          throw new StoreAuthorityError(
            "Inbox admission requires complete canonical role and loop source receipts",
          );
        if (
          all("claim", claimSchema).some(
            (claim): boolean =>
              claim.employeeId === current.id && claim.status !== "settled",
          )
        )
          throw new StoreConflictError(
            `Employee ${current.id} already has an unresolved claim`,
          );
        if (
          all("occurrence", occurrenceSchema).some(
            (occurrence): boolean =>
              occurrence.employeeId === current.id &&
              occurrence.observedAt === null,
          )
        )
          throw new StoreConflictError(
            "Employee already has an unresolved duty occurrence",
          );
        if (current.assignment !== null && !ready(team(current.assignment)))
          return null;
        const message: Message | undefined = all("message", messageSchema).find(
          (cue): boolean =>
            cue.recipient === current.id && cue.status === "pending",
        );
        if (message === undefined) return null;
        const claim: Claim = claimSchema.parse({
          id: randomUUID(),
          employeeId: current.id,
          messageId: message.id,
          ownerEpoch: epoch,
          generation: current.generation,
          status: "active",
        });
        const claimed: Message = { ...message, status: "claimed" };
        put("claim", claim.id, claim);
        put("message", message.id, claimed);
        return { claim, message: claimed };
      });
    },
    settleClaim(input: {
      readonly employee: Binding;
      readonly claimId: string;
      readonly result: Result;
    }): Settlement {
      return tx((): Settlement => {
        const current: Employee = actor(input.employee);
        const result: Result = resultSchema.parse(input.result);
        const claim: Claim | null = read(
          "claim",
          idSchema.parse(input.claimId),
          claimSchema,
        );
        if (
          claim === null ||
          claim.employeeId !== current.id ||
          claim.generation !== current.generation
        )
          throw new StoreFenceError(
            "Claim does not belong to this native employee generation",
          );
        const saved = read("result", result.id, resultRecordSchema);
        if (saved !== null) {
          assertReplay(
            { claimId: saved.claimId, result: saved.result },
            { claimId: claim.id, result },
            result.id,
          );
          return saved;
        }
        if (claim.ownerEpoch !== epoch || claim.status !== "active")
          throw new StoreFenceError(
            "Claim is settled or requires explicit reconciliation",
          );
        if (
          all("result", resultRecordSchema).some(
            (entry): boolean => entry.claimId === claim.id,
          )
        )
          throw new StoreConflictError("Claim already has a result");
        const incoming: Message | null = read(
          "message",
          claim.messageId,
          messageSchema,
        );
        if (incoming === null)
          throw new StoreRecoveryError("Claim lost its incoming message");
        const messages: readonly Message[] = result.outgoing.map(
          (cue): Message => saveCue(current, cue, current.assignment),
        );
        const settlement: Settlement = { claimId: claim.id, result, messages };
        put("result", result.id, settlement);
        put("claim", claim.id, {
          ...claim,
          status: result.kind === "uncertain" ? "reconciliation" : "settled",
        });
        put("message", incoming.id, { ...incoming, status: "acknowledged" });
        put("employee", current.id, {
          ...current,
          checkpoint: result.checkpoint,
        });
        if (incoming.kind === "assignment")
          put("assignment", incoming.id, {
            id: incoming.id,
            employeeId: current.id,
            state:
              result.kind === "completed"
                ? "complete"
                : result.kind === "question"
                  ? "waiting"
                  : "reconciliation",
          });
        if (current.assignment !== null && result.kind !== "completed")
          put("team", current.assignment, {
            ...team(current.assignment),
            state: result.kind === "question" ? "waiting" : "reconciliation",
          });
        return settlement;
      });
    },
    resolveAssignment(input: {
      readonly manager: Binding;
      readonly assignmentId: string;
      readonly evidence: Json;
    }): void {
      tx((): void => {
        manager(input.manager);
        const saved = read(
          "assignment",
          idSchema.parse(input.assignmentId),
          assignmentSchema,
        );
        if (saved === null) throw new StoreConflictError("Unknown assignment");
        if (saved.state === "reconciliation")
          throw new StoreRecoveryError(
            "Reconcile uncertain claim before resolving its assignment",
          );
        put("assignmentResolution", saved.id, jsonSchema.parse(input.evidence));
        put("assignment", saved.id, { ...saved, state: "complete" });
      });
    },
    reconcileClaim(input: {
      readonly manager: Binding;
      readonly claimId: string;
      readonly evidence: Json;
    }): void {
      tx((): void => {
        manager(input.manager);
        const saved = read("claim", idSchema.parse(input.claimId), claimSchema);
        if (saved === null || saved.status !== "reconciliation")
          throw new StoreConflictError("Claim is not awaiting reconciliation");
        const message = read("message", saved.messageId, messageSchema);
        if (message === null)
          throw new StoreRecoveryError(
            "Reconciliation claim lost incoming message",
          );
        if (input.evidence === null)
          throw new StoreRecoveryError(
            "Claim reconciliation requires recorded evidence",
          );
        put("claimReconciliation", saved.id, jsonSchema.parse(input.evidence));
        put("claim", saved.id, { ...saved, status: "settled" });
        put("message", message.id, { ...message, status: "acknowledged" });
        const assignment = read("assignment", message.id, assignmentSchema);
        if (assignment !== null)
          put("assignment", assignment.id, { ...assignment, state: "waiting" });
      });
    },
    setDuty(input: { readonly manager: Binding; readonly duty: Duty }): Duty {
      return tx((): Duty => {
        manager(input.manager);
        const duty = dutySchema.parse(input.duty);
        employee(duty.employeeId);
        const existing = read("duty", duty.id, dutySchema);
        if (existing !== null) assertReplay(existing, duty, duty.id);
        else put("duty", duty.id, duty);
        return duty;
      });
    },
    endDuty(input: {
      readonly manager: Binding;
      readonly dutyId: string;
      readonly evidence: Json;
    }): void {
      tx((): void => {
        manager(input.manager);
        const duty = read("duty", idSchema.parse(input.dutyId), dutySchema);
        if (duty === null) throw new StoreConflictError("Unknown duty");
        if (
          all("occurrence", occurrenceSchema).some(
            (entry): boolean =>
              entry.dutyId === duty.id && entry.observedAt === null,
          )
        )
          throw new StoreConflictError("Duty has an unresolved occurrence");
        if (input.evidence === null)
          throw new StoreConflictError(
            "Ending a duty requires recorded evidence",
          );
        put("dutyEnd", duty.id, jsonSchema.parse(input.evidence));
      });
    },
    claimDue(input: { readonly employee: Binding }): Occurrence | null {
      return tx((): Occurrence | null => {
        const current = actor(input.employee);
        const timestamp = now();
        if (current.source === null)
          throw new StoreAuthorityError(
            "Duty admission requires complete canonical role and loop source receipts",
          );
        if (
          all("claim", claimSchema).some(
            (claim): boolean =>
              claim.employeeId === current.id && claim.status !== "settled",
          )
        )
          throw new StoreConflictError(
            "Employee already has an unresolved inbox claim",
          );
        const pending = all("occurrence", occurrenceSchema).find(
          (entry): boolean =>
            entry.employeeId === current.id && entry.observedAt === null,
        );
        if (pending !== undefined) {
          const reclaimed: Occurrence = {
            ...pending,
            generation: current.generation,
            ownerEpoch: epoch,
            claimedAt: timestamp,
          };
          put("occurrence", pending.id, reclaimed);
          return reclaimed;
        }
        const duty = all("duty", dutySchema).find(
          (entry): boolean =>
            entry.employeeId === current.id &&
            entry.target !== null &&
            entry.probe !== null &&
            entry.acceptance !== null &&
            entry.cadenceMs !== null &&
            entry.nextDue !== null &&
            (read("dutyNext", entry.id, timeSchema) ?? entry.nextDue) <=
              timestamp &&
            read("dutyEnd", entry.id, jsonSchema) === null,
        );
        if (
          duty === undefined ||
          duty.nextDue === null ||
          duty.cadenceMs === null
        )
          return null;
        const scheduledFor: number =
          read("dutyNext", duty.id, timeSchema) ?? duty.nextDue;
        const occurrence: Occurrence = {
          id: `${duty.id}/${scheduledFor}`,
          dutyId: duty.id,
          employeeId: current.id,
          scheduledFor,
          claimedAt: timestamp,
          observation: null,
          observedAt: null,
          generation: current.generation,
          ownerEpoch: epoch,
        };
        put("occurrence", occurrence.id, occurrence);
        put("dutyNext", duty.id, timeSchema.parse(timestamp + duty.cadenceMs));
        return occurrence;
      });
    },
    observeDuty(input: {
      readonly employee: Binding;
      readonly occurrenceId: string;
      readonly observation: Json;
    }): Occurrence {
      return tx((): Occurrence => {
        const current = actor(input.employee);
        const saved = read(
          "occurrence",
          idSchema.parse(input.occurrenceId),
          occurrenceSchema,
        );
        if (
          saved === null ||
          saved.employeeId !== current.id ||
          saved.generation !== current.generation ||
          saved.ownerEpoch !== epoch
        )
          throw new StoreAuthorityError(
            "Duty occurrence belongs to another employee generation or owner epoch",
          );
        const observation: Json = jsonSchema.parse(input.observation);
        if (saved.observedAt !== null) {
          assertReplay(saved.observation, observation, saved.id);
          return saved;
        }
        const observed: Occurrence = {
          ...saved,
          observation,
          observedAt: now(),
        };
        put("occurrence", saved.id, observed);
        return observed;
      });
    },
    authorizeTarget(input: {
      readonly manager: Binding;
      readonly authorization: TargetAuthorization;
    }): void {
      tx((): void => {
        manager(input.manager);
        const authorization = authorizationSchema.parse(input.authorization);
        employee(authorization.employeeId);
        if (authorization.authority === null)
          throw new StoreAuthorityError(
            "Target mutation requires explicit recorded authority",
          );
        const saved = read(
          "authorization",
          authorization.id,
          authorizationSchema,
        );
        if (saved !== null)
          assertReplay(saved, authorization, authorization.id);
        else put("authorization", authorization.id, authorization);
      });
    },
    acquireTarget(input: {
      readonly employee: Binding;
      readonly grantId: string;
      readonly authorizationId: string;
    }): Grant {
      return tx((): Grant => {
        const current = actor(input.employee);
        const id: string = idSchema.parse(input.grantId);
        const authorization = read(
          "authorization",
          idSchema.parse(input.authorizationId),
          authorizationSchema,
        );
        if (authorization === null || authorization.employeeId !== current.id)
          throw new StoreAuthorityError(
            "No manager authorization for this employee and target",
          );
        if (read("resources", "original", resourceDocumentSchema) === null)
          throw new StoreRecoveryError(
            "Import legacy resources before acquiring a target",
          );
        const previous = read("grant", id, grantSchema);
        if (previous !== null) {
          assertReplay(
            {
              authorizationId: previous.authorizationId,
              employeeId: previous.employeeId,
              generation: previous.generation,
              target: previous.target,
              authority: previous.authority,
            },
            {
              authorizationId: authorization.id,
              employeeId: current.id,
              generation: current.generation,
              target: authorization.target,
              authority: authorization.authority,
            },
            id,
          );
          return previous;
        }
        if (
          all("grant", grantSchema).some(
            (grant): boolean => grant.authorizationId === authorization.id,
          )
        )
          throw new StoreConflictError(
            "Mutation authorization already has a grant; reconcile or request new authority",
          );
        if (
          all("legacyLock", legacyLockSchema).some(
            (lock): boolean =>
              lock.target === authorization.target && lock.state === "blocked",
          ) ||
          all("grant", grantSchema).some(
            (grant): boolean =>
              grant.target === authorization.target &&
              grant.state !== "released",
          )
        )
          throw new StoreConflictError(
            `Target ${authorization.target} is held or requires legacy reconciliation`,
          );
        const grant: Grant = {
          id,
          authorizationId: authorization.id,
          employeeId: current.id,
          generation: current.generation,
          target: authorization.target,
          authority: authorization.authority,
          state: "held",
          verification: null,
        };
        put("grant", id, grant);
        return grant;
      });
    },
    verifyAndReleaseTarget(input: {
      readonly employee: Binding;
      readonly grantId: string;
      readonly verification: Json;
    }): Grant {
      return tx((): Grant => {
        const current = actor(input.employee);
        const grant = read("grant", idSchema.parse(input.grantId), grantSchema);
        if (
          grant === null ||
          (current.role !== "manager" &&
            (grant.employeeId !== current.id ||
              grant.generation !== current.generation)) ||
          (current.role === "manager" && grant.state === "held")
        )
          throw new StoreAuthorityError(
            "Target grant requires its owning employee generation or manager reconciliation",
          );
        const verification = jsonSchema.parse(input.verification);
        if (verification === null)
          throw new StoreConflictError("Post-action verification is required");
        if (grant.state === "released") {
          assertReplay(grant.verification, verification, grant.id);
          return grant;
        }
        const released: Grant = { ...grant, state: "released", verification };
        put("grant", grant.id, released);
        return released;
      });
    },
    importResources(input: {
      readonly manager: Binding;
    }): readonly LegacyLock[] {
      return tx((): readonly LegacyLock[] => {
        manager(input.manager);
        const previous = read("resources", "original", resourceDocumentSchema);
        if (previous !== null) return all("legacyLock", legacyLockSchema);
        const raw: string | null = readFile("resources.json");
        const document: ResourceDocument =
          raw === null ? {} : resourceDocumentSchema.parse(JSON.parse(raw));
        const locks: readonly LegacyLock[] = readLegacyLocks(document);
        put("resources", "original", document);
        for (const lock of locks) put("legacyLock", lock.id, lock);
        return locks;
      });
    },
    reconcileLegacyLock(input: {
      readonly manager: Binding;
      readonly lockId: string;
      readonly evidence: Json;
    }): void {
      tx((): void => {
        manager(input.manager);
        const lock = read(
          "legacyLock",
          idSchema.parse(input.lockId),
          legacyLockSchema,
        );
        if (lock === null) throw new StoreConflictError("Unknown legacy lock");
        const evidence = jsonSchema.parse(input.evidence);
        if (evidence === null)
          throw new StoreRecoveryError(
            "Legacy lock reconciliation requires evidence",
          );
        if (lock.state === "resolved")
          assertReplay(lock.evidence, evidence, lock.id);
        else
          put("legacyLock", lock.id, { ...lock, state: "resolved", evidence });
      });
    },
    projectResources(input: { readonly manager: Binding }): ResourceDocument {
      pendingWrites();
      const id: string = `resources/${randomUUID()}`;
      const projection: ResourceDocument = tx((): ResourceDocument => {
        manager(input.manager);
        const original = read("resources", "original", resourceDocumentSchema);
        if (original === null)
          throw new StoreRecoveryError(
            "Import legacy resources before projecting their lock view",
          );
        const actual: string | null = readFile("resources.json");
        const baseline: Json =
          read("resources", "projection", jsonSchema) ?? original;
        if (
          (actual === null &&
            (read("resources", "projection", jsonSchema) !== null ||
              Object.keys(original).length > 0)) ||
          (actual !== null && !sameDocument(JSON.parse(actual), baseline))
        )
          throw new StoreRecoveryError(
            "resources.json changed outside the runtime; reconcile before projection",
          );
        const projected: ResourceDocument = projectResources({
          original,
          locks: all("legacyLock", legacyLockSchema),
          grants: all("grant", grantSchema),
        });
        put("intent", id, {
          file: "resources.json",
          before: readFile("resources.json"),
          after: JSON.stringify(projected, null, 2) + "\n",
          state: "pending",
          capture: null,
        });
        return projected;
      });
      applyIntent(id);
      return projection;
    },
    retireEmployees(input: {
      readonly manager: Binding;
      readonly employeeIds: readonly string[];
      readonly evidence: Json;
    }): readonly Employee[] {
      return tx((): readonly Employee[] => {
        manager(input.manager);
        jsonSchema.parse(input.evidence);
        const ids: readonly string[] = z
          .array(idSchema)
          .min(1)
          .parse(input.employeeIds);
        const retired: readonly Employee[] = ids.map((id): Employee => {
          const current = employee(id);
          if (
            current.role !== "devops" ||
            current.assignment !== null ||
            all("claim", claimSchema).some(
              (claim): boolean =>
                claim.employeeId === id && claim.status !== "settled",
            ) ||
            all("grant", grantSchema).some(
              (grant): boolean =>
                grant.employeeId === id && grant.state !== "released",
            ) ||
            all("assignment", assignmentSchema).some(
              (assignment): boolean =>
                assignment.employeeId === id && assignment.state !== "complete",
            ) ||
            all("message", messageSchema).some(
              (message): boolean =>
                (message.recipient === id || message.sender === id) &&
                message.status !== "acknowledged",
            ) ||
            all("duty", dutySchema).some(
              (duty): boolean =>
                duty.employeeId === id &&
                read("dutyEnd", duty.id, jsonSchema) === null,
            )
          )
            throw new StoreConflictError(
              `DevOps employee ${id} is busy or has unresolved mail, duties, claims or grants`,
            );
          return { ...current, employment: "retired" };
        });
        for (const current of retired) {
          put("employee", current.id, current);
          put("retirement", current.id, input.evidence);
        }
        return retired;
      });
    },
    snapshot(): Snapshot {
      return db
        .transaction(
          (): Snapshot => ({
            ownerEpoch: epoch,
            employees: all("employee", employeeSchema),
            hires: all("hire", hireRecordSchema),
            captures: all("capture", captureRecordSchema),
            queueRevisions: all("queueOwner", queueOwnerSchema),
            authorizations: all("authorization", authorizationSchema),
            teams: all("team", teamSchema),
            itemExecutions: all("itemExecution", itemExecutionSchema),
            itemTransitions: all("itemTransition", itemTransitionSchema),
            messages: all("message", messageSchema),
            claims: all("claim", claimSchema),
            results: all("result", resultRecordSchema),
            duties: all("duty", dutySchema),
            dutySchedules: all("duty", dutySchema).map((duty) => ({
              id: duty.id,
              nextDue: read("dutyNext", duty.id, timeSchema) ?? duty.nextDue,
            })),
            occurrences: all("occurrence", occurrenceSchema),
            grants: all("grant", grantSchema),
            legacyLocks: all("legacyLock", legacyLockSchema),
            teamRequirements: all("teamRequirement", teamRequirementSchema),
            intakes: all("intake", intakeRecordSchema),
            inputs: all("receivedInput", receivedInputSchema),
            assignments: all("assignment", assignmentSchema),
          }),
        )
        .deferred();
    },
    close(): void {
      if (closed) return;
      db.transaction((): void => {
        db.query(
          "UPDATE lease SET expires=0 WHERE singleton=1 AND token=? AND epoch=?",
        ).run(token, epoch);
      }).immediate();
      db.close();
      closed = true;
    },
  };
}
export type StartupStore = ReturnType<typeof openStore>;
