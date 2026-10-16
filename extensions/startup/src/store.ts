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
import { runtimeAbandonmentSchema, runtimeBindingSchema, type RuntimeAbandonment, type RuntimeBinding } from "./runtime-contracts";
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
  ClaimSettlementError,
  type SettlementRecovery,
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
type QueueDocument = Readonly<{ before: string | null; rows: readonly z.infer<typeof rowSchema>[] }> & (
  Readonly<{ container: null; key: null }> |
  Readonly<{ container: Readonly<Record<string, Json>>; key: "items" | "rows" }>
);
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
const itemProgressSchema = z.strictObject({
  itemId: idSchema,
  revision: timeSchema,
  status: z.string().min(1),
  changedAt: timeSchema,
}).readonly();
export type ItemProgress = z.infer<typeof itemProgressSchema>;
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS records_message_recipient_status ON records(json_extract(payload,'$.recipient'),json_extract(payload,'$.status')) WHERE kind='message';
    CREATE INDEX IF NOT EXISTS records_claim_employee_status ON records(json_extract(payload,'$.employeeId'),json_extract(payload,'$.status')) WHERE kind='claim';
    CREATE INDEX IF NOT EXISTS records_grant_employee_state ON records(json_extract(payload,'$.employeeId'),json_extract(payload,'$.state')) WHERE kind='grant';
    CREATE INDEX IF NOT EXISTS records_item_execution_employee_generation ON records(json_extract(payload,'$.employeeId'),json_extract(payload,'$.generation')) WHERE kind='itemExecution';
    CREATE INDEX IF NOT EXISTS records_result_claim ON records(json_extract(payload,'$.claimId')) WHERE kind='result';
    CREATE INDEX IF NOT EXISTS records_runtime_employee_generation ON records(json_extract(payload,'$.employeeId'),json_extract(payload,'$.generation')) WHERE kind='runtimeBinding';
  `);
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
  function selected<T>(sql: string, params: readonly (string | number)[], schema: z.ZodType<T>): readonly T[] {
    return db.query(sql).all(...params).map((row: unknown): T => schema.parse(JSON.parse(storedSchema.parse(row).payload)));
  }
  function employeeView(employeeId: string) {
    const current = employee(employeeId);
    let itemReview: { itemId: string; resultId: string; revision: number } | null = null;
    if (current.role === "dev") {
      for (const execution of selected("SELECT payload FROM records WHERE kind='itemExecution' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.generation')=?", [current.id, current.generation], itemExecutionSchema)) {
        if (execution.reviewResultId !== null) continue;
        const ownership = read("queueOwner", execution.itemId, queueOwnerSchema);
        const assigned = read("itemTransition", execution.attemptId, itemTransitionSchema);
        if (ownership === null || assigned?.revision !== ownership.revision || assigned.status !== "EXECUTING") continue;
        const claim = selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status')='settled' AND json_extract(payload,'$.messageId')=?", [current.id, execution.messageId], claimSchema)[0];
        if (claim === undefined || claim.generation !== current.generation) continue;
        const result = selected("SELECT payload FROM records WHERE kind='result' AND json_extract(payload,'$.claimId')=?", [claim.id], resultRecordSchema)[0];
        if (result?.result.kind !== "completed") continue;
        itemReview = { itemId: execution.itemId, resultId: result.result.id, revision: ownership.revision };
        break;
      }
    }
    return {
      itemReview,
      team: current.assignment === null ? null : team(current.assignment),
      messages: selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')=? AND json_extract(payload,'$.status')='pending' ORDER BY rowid", [current.id], messageSchema),
      claims: selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status') IN ('active','reconciliation') ORDER BY rowid", [current.id], claimSchema),
      grants: selected("SELECT payload FROM records WHERE kind='grant' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.state')='reconciliation' ORDER BY rowid", [current.id], grantSchema),
    };
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
  function observeItemProgress(input: Readonly<{ itemId: string; revision: number; status: string; observedAt: number }>): ItemProgress {
    const next: ItemProgress = itemProgressSchema.parse({ itemId: input.itemId, revision: input.revision, status: input.status, changedAt: input.observedAt });
    const previous: ItemProgress | null = read("itemProgress", next.itemId, itemProgressSchema);
    if (previous !== null) {
      if (next.revision < previous.revision || next.changedAt < previous.changedAt)
        throw new StoreFenceError("Item progress revision or timestamp regressed");
      if (next.revision === previous.revision) {
        if (next.status !== previous.status) throw new StoreConflictError("Item status changed without a new queue revision");
        return previous;
      }
    }
    put("itemProgress", next.itemId, next);
    return next;
  }
  function finalizeCapture(receipt: CaptureReceipt): void {
    const current: Team = team(receipt.teamId);
    const rows = canonicalQueue().rows;
    for (const item of receipt.items.filter((entry): boolean =>
      receipt.request.rows.some((change): boolean => change.id === entry.id),
    )) {
      put("queueOwner", item.id, {
        id: item.id,
        eventId: current.eventId,
        revision: item.revision,
      });
      const row = rows.find((entry) => entry.id === item.id);
      if (row === undefined) throw new StoreRecoveryError("Captured item is missing from the canonical queue");
      observeItemProgress({ itemId: item.id, revision: item.revision, status: z.string().parse(row.status), observedAt: now() });
    }
    put("capture", receipt.request.captureId, receipt);
    put("team", current.id, {
      ...current,
      items: receipt.items,
      state: "active",
    });
  }
  function canonicalQueue(): QueueDocument {
    const before = readFile("queue.json");
    if (before === null)
      return { before, rows: z.array(rowSchema).parse([]), container: null, key: null };
    const document = jsonSchema.parse(JSON.parse(before));
    if (Array.isArray(document))
      return {
        before,
        rows: z.array(rowSchema).parse(document),
        container: null,
        key: null,
      };
    const container = z.record(z.string(), jsonSchema).parse(document);
    if (Object.hasOwn(container, "items") && Object.hasOwn(container, "rows"))
      throw new StoreRecoveryError("Canonical queue contains both items and rows; preserve the document and resolve its ownership");
    const key: "items" | "rows" = Object.hasOwn(container, "rows") ? "rows" : "items";
    const parsed = z.array(rowSchema).safeParse(container[key]);
    if (!parsed.success) throw new StoreRecoveryError(`Canonical queue ${key} must be a valid row array: ${parsed.error.message}`);
    return {
      before,
      rows: parsed.data,
      container, key,
    };
  }
  function queueText(document: ReturnType<typeof canonicalQueue>, rows: readonly z.infer<typeof rowSchema>[]): string {
    return JSON.stringify(document.container === null ? rows : { ...document.container, [document.key]: rows }, null, 2) + "\n";
  }
  function finalizeItem(receipt: ItemTransition): void {
    const current = team(receipt.teamId);
    put("queueOwner", receipt.request.itemId, {
      id: receipt.request.itemId,
      eventId: receipt.eventId,
      revision: receipt.revision,
    });
    observeItemProgress({ itemId: receipt.request.itemId, revision: receipt.revision, status: receipt.status, observedAt: now() });
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

  function compactObservations(pending: readonly Message[]): Readonly<{ acknowledged: number }> {
    const latest = new Set<string>();
    let acknowledged: number = 0;
    for (const message of pending) {
      const payload = z.object({ employeeId: idSchema, generation: timeSchema, sequence: timeSchema }).safeParse(message.payload);
      if (!payload.success) continue;
      const key = encode([message.correlation, payload.data.employeeId, payload.data.generation]);
      if (!latest.has(key)) { latest.add(key); continue; }
      put("message", message.id, { ...message, status: "acknowledged" });
      put("observationCompaction", message.id, { reason: "Superseded pending lifecycle observation; latest observation retained", acknowledgedAt: now() });
      acknowledged += 1;
    }
    return { acknowledged };
  }

  return {
    ownerEpoch: epoch,
    getEmployee: employee,
    getTeam: team,
    hasMessage(id: string): boolean { return read("message", id, messageSchema) !== null; },
    employees(): readonly Employee[] { return all("employee", employeeSchema); },
    employeeView,
    outstandingMessages(employeeId: string): readonly Message[] {
      return selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')=? AND json_extract(payload,'$.status') IN ('pending','claimed') ORDER BY rowid", [employeeId], messageSchema);
    },
    lastPaCheck(employeeId: string): Message | null {
      return selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')=? AND id LIKE 'pa-check-%' ORDER BY rowid DESC LIMIT 1", [employeeId], messageSchema)[0] ?? null;
    },
    managerPendingWork(): Readonly<{ unclassifiedInput: boolean; undelegatedIntake: boolean }> {
      return {
        unclassifiedInput: db.query("SELECT 1 FROM records WHERE kind='receivedInput' AND json_extract(payload,'$.disposition') IS NULL LIMIT 1").get() !== null,
        undelegatedIntake: db.query("SELECT 1 FROM records WHERE kind='intake' AND json_extract(payload,'$.teamId') IS NULL LIMIT 1").get() !== null,
      };
    },
    supervisionView(): Pick<Snapshot, "employees" | "teams" | "messages" | "claims" | "inputs" | "queueRevisions" | "itemExecutions"> {
      return {
        employees: all("employee", employeeSchema),
        teams: all("team", teamSchema),
        messages: selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.status') IN ('pending','claimed') ORDER BY rowid", [], messageSchema),
        claims: selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.status') IN ('active','reconciliation') ORDER BY rowid", [], claimSchema),
        inputs: selected("SELECT payload FROM records WHERE kind='receivedInput' AND json_extract(payload,'$.disposition') IS NULL ORDER BY rowid", [], receivedInputSchema),
        queueRevisions: all("queueOwner", queueOwnerSchema),
        itemExecutions: all("itemExecution", itemExecutionSchema),
      };
    },
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
        const document = canonicalQueue();
        const { before, rows } = document;
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
        const after: string = queueText(document, nextRows);
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
      pendingWrites();
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
              directive: request.evidence,
              reportTo: current.architect,
              instruction: "Execute directive as the current attempt scope; snapshot preserves original intake. Implement requested rework even when the original procedure was review-only. Preserve explicit user restrictions. After completed settlement, submit startup_item review with the saved resultId and current revision. Settlement reports the result to reportTo automatically.",
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
        const after = queueText(document, document.rows.map((old) => old.id === row.id ? nextRow : old));
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
      readonly excludedMessageIds?: readonly string[];
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
            cue.recipient === current.id &&
            cue.status === "pending" &&
            !input.excludedMessageIds?.includes(cue.id),
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
      readonly claimId?: string;
      readonly result: Result;
    }): Settlement {
      return tx((): Settlement => {
        const current: Employee = actor(input.employee);
        const result: Result = resultSchema.parse(input.result);
        function reject(code: SettlementRecovery["code"], action: string, claimId: string | null): never {
          throw new ClaimSettlementError({ code, retryable: false, action, employeeId: current.id, generation: current.generation, claimId });
        }
        const saved = read("result", result.id, resultRecordSchema);
        const explicit: string | null = input.claimId === undefined || input.claimId === "current" ? null : idSchema.parse(input.claimId);
        const unresolved: readonly Claim[] = explicit !== null || saved !== null ? [] : selected("SELECT payload FROM records WHERE kind='claim' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.status') IN ('active','reconciliation') ORDER BY rowid", [current.id], claimSchema);
        if (unresolved.length > 1) reject("ambiguous_claim", "Multiple outstanding claims require manager inspection and evidence-based reconciliation. Do not guess a claim or repeat settlement.", null);
        const selectedId: string | null = explicit ?? saved?.claimId ?? unresolved[0]?.id ?? null;
        if (selectedId === null) reject("no_active_claim", "No outstanding claim. Use startup_claim before settling; inspect the saved result if an earlier attempt may have completed.", null);
        const claim: Claim | null = read("claim", selectedId, claimSchema);
        if (claim === null) reject("claim_not_found", 'Claim ID does not exist. Do not retry it. Use startup_settle {result} for your current claim; legacy tools may use claimId="current".', selectedId);
        if (saved !== null && explicit === null && (claim.employeeId !== current.id || claim.generation !== current.generation)) reject("result_replay_conflict", "This result ID is already used outside your current employee generation. Use a unique result ID for genuinely new work; ask the manager to reconcile old work. Do not retry unchanged.", null);
        if (claim.employeeId !== current.id) reject("claim_not_owned", "This claim belongs to another employee. Settle only your own current claim with startup_settle {result}.", selectedId);
        if (claim.generation !== current.generation) reject("claim_generation_stale", "This claim belongs to a prior native generation. Ask the manager to use startup_reconcile with verified evidence. Do not replay work.", claim.id);
        if (saved !== null) {
          if (saved.claimId !== claim.id || !sameDocument(saved.result, result)) reject("result_replay_conflict", "This result ID already names a different claim or payload. Reuse the exact original result to recover its receipt, or use a unique result ID for genuinely new work. Do not retry changed content under the same ID.", claim.id);
          return saved;
        }
        if (claim.ownerEpoch !== epoch || claim.status === "reconciliation") reject("claim_requires_reconciliation", "The saved claim requires explicit manager reconciliation with evidence through startup_reconcile. Do not retry settlement or replay the work.", claim.id);
        if (claim.status === "settled" || all("result", resultRecordSchema).some((entry): boolean => entry.claimId === claim.id)) reject("claim_already_settled", "This claim already has a result. Reuse the original result ID and exact payload to recover its receipt; do not create another result.", claim.id);
        const incoming: Message | null = read(
          "message",
          claim.messageId,
          messageSchema,
        );
        if (incoming === null)
          throw new StoreRecoveryError("Claim lost its incoming message");
        const execution: ItemExecution | null = current.role === "dev" && incoming.kind === "assignment"
          ? read("itemExecution", incoming.correlation, itemExecutionSchema)
          : null;
        const handoff: readonly Cue[] = execution !== null && execution.messageId === incoming.id && execution.employeeId === current.id && execution.generation === current.generation
          ? [{
              id: `item-result-${incoming.id}`,
              recipient: team(execution.teamId).architect,
              kind: "report",
              correlation: execution.itemId,
              payload: {
                kind: "item-result",
                itemId: execution.itemId,
                attemptId: execution.attemptId,
                resultId: result.id,
                outcome: result.kind,
                output: result.output,
                nextAction: result.kind === "completed"
                  ? "Assigned dev submits startup_item review with this resultId and current revision; architect coordinates QA after REVIEW."
                  : "Architect handles the saved question or uncertainty through Paused execution before another attempt.",
              },
            }]
          : [];
        const messages: readonly Message[] = [...result.outgoing, ...handoff].map(
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
        if (saved === null)
          throw new StoreConflictError("Claim is not awaiting reconciliation");
        const evidence: Json = jsonSchema.parse(input.evidence);
        if (evidence === null)
          throw new StoreRecoveryError("Claim reconciliation requires recorded evidence");
        const prior = read("claimReconciliation", saved.id, jsonSchema);
        if (saved.status === "settled" && prior !== null)
          assertReplay(prior, evidence, `claim reconciliation ${saved.id}`);
        else if (saved.status !== "reconciliation")
          throw new StoreConflictError("Claim is not awaiting reconciliation");
        const message = read("message", saved.messageId, messageSchema);
        if (message === null)
          throw new StoreRecoveryError(
            "Reconciliation claim lost incoming message",
          );
        put("claimReconciliation", saved.id, evidence);
        put("claim", saved.id, { ...saved, status: "settled" });
        put("message", message.id, { ...message, status: "acknowledged" });
        const assignment = read("assignment", message.id, assignmentSchema);
        if (assignment !== null && saved.status === "reconciliation")
          put("assignment", assignment.id, { ...assignment, state: "waiting" });
        const current: Employee = employee(saved.employeeId);
        if (current.assignment !== null) {
          const assigned: Team = team(current.assignment);
          const ids: readonly string[] = members(assigned);
          if (assigned.state === "reconciliation" && ready(assigned) &&
            !all("claim", claimSchema).some((claim) => ids.includes(claim.employeeId) && claim.status === "reconciliation") &&
            !all("grant", grantSchema).some((grant) => ids.includes(grant.employeeId) && grant.state === "reconciliation"))
            put("team", assigned.id, { ...assigned, state: "waiting" });
        }
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
          const duty = read("duty", pending.dutyId, dutySchema);
          if (duty?.cadenceMs === null || duty === null)
            throw new StoreRecoveryError(
              "Pending occurrence has no configured cadence",
            );
          put("occurrence", pending.id, reclaimed);
          put(
            "dutyNext",
            pending.dutyId,
            timeSchema.parse(timestamp + duty.cadenceMs),
          );
          return reclaimed;
        }
        let duty: Duty | undefined;
        let earliestDue: number | null = null;
        for (const entry of all("duty", dutySchema)) {
          if (
            entry.employeeId !== current.id ||
            entry.target === null ||
            entry.probe === null ||
            entry.acceptance === null ||
            entry.cadenceMs === null ||
            entry.nextDue === null ||
            read("dutyEnd", entry.id, jsonSchema) !== null
          )
            continue;
          const dueAt = read("dutyNext", entry.id, timeSchema) ?? entry.nextDue;
          if (
            dueAt <= timestamp &&
            (earliestDue === null || dueAt < earliestDue)
          ) {
            duty = entry;
            earliestDue = dueAt;
          }
        }
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
    markTargetUncertain(input: {
      readonly employee: Binding;
      readonly grantId: string;
      readonly evidence: Json;
    }): Grant {
      return tx((): Grant => {
        const current = actor(input.employee);
        const grant = read("grant", idSchema.parse(input.grantId), grantSchema);
        if (
          !grant ||
          grant.employeeId !== current.id ||
          grant.generation !== current.generation ||
          grant.state === "released"
        )
          throw new StoreAuthorityError(
            "Only the current target owner may record an uncertain action",
          );
        const evidence = jsonSchema.parse(input.evidence);
        if (evidence === null)
          throw new StoreConflictError(
            "Uncertain target requires explicit evidence",
          );
        const uncertain: Grant = {
          ...grant,
          state: "reconciliation",
          verification: evidence,
        };
        put("grant", grant.id, uncertain);
        return uncertain;
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
            (current.role !== "devops" && !all("team", teamSchema).some((saved) => saved.state === "finished" && members(saved).includes(id) && saved.generations[id] === current.generation)) ||
            current.role === "manager" || current.role === "pa" ||
            current.assignment !== null ||
            all("runtimeBinding", runtimeBindingSchema).some((runtime) => runtime.employeeId === id && runtime.generation === current.generation && runtime.turnActive) ||
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
              `Employee ${id} must be idle, detached from a finished crew (or DevOps), and free of unresolved mail, duties, claims and grants; manager and PA cannot retire`,
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
    abandonUnadmittedRuntime(input: Readonly<{
      manager: Binding;
      employeeId: string;
      launchId: string;
      evidence: Json;
      verifiedAbsentAt: number;
      connectionDeadlineMs: number;
    }>): number {
      return tx((): number => {
        manager(input.manager);
        const evidence: Json = jsonSchema.parse(input.evidence);
        if (evidence === null) throw new StoreRecoveryError("Runtime abandonment requires explicit manager recovery evidence");
        const previous = read("runtimeAbandonment", input.launchId, runtimeAbandonmentSchema);
        if (previous !== null) {
          assertReplay({ employeeId: previous.employeeId, evidence: previous.evidence }, { employeeId: input.employeeId, evidence }, input.launchId);
          return previous.nextGeneration;
        }
        const current: Employee = employee(input.employeeId);
        const key: string = `${current.id}/${current.generation + 1}`;
        const saved = read("runtimeBinding", key, runtimeBindingSchema);
        if (current.role === "manager" || current.nativeHandle !== null || current.source !== null || saved === null || saved.launchId !== input.launchId || saved.state === "ready" || saved.state === "abandoned")
          throw new StoreAuthorityError("Only a never-admitted pending employee generation may be abandoned");
        const verifiedAbsentAt: number = timeSchema.parse(input.verifiedAbsentAt);
        const connectionDeadlineMs: number = z.number().int().positive().safe().parse(input.connectionDeadlineMs);
        if (verifiedAbsentAt !== now()) throw new StoreRecoveryError("Runtime abandonment requires current absence verification");
        if (verifiedAbsentAt - Math.max(saved.lastPoll, saved.lastSeen) <= connectionDeadlineMs)
          throw new StoreRecoveryError("Runtime is too recent to abandon; wait for the connection deadline and verify absence");
        if (all("claim", claimSchema).some((claim) => claim.employeeId === current.id && claim.status !== "settled") || all("grant", grantSchema).some((grant) => grant.employeeId === current.id && grant.state !== "released"))
          throw new StoreRecoveryError("Reconcile claims and target grants before abandoning a pending runtime");
        const nextGeneration: number = timeSchema.parse(saved.generation + 1);
        const receipt: RuntimeAbandonment = runtimeAbandonmentSchema.parse({ ...input, generation: saved.generation, nextGeneration });
        put("runtimeAbandonment", saved.launchId, receipt);
        put("runtimeBinding", key, { ...saved, state: "abandoned", turnActive: false, error: "Abandoned by explicit manager recovery" });
        put("employee", current.id, { ...current, generation: saved.generation, nativeHandle: null, source: null, error: null });
        put("replacement", `${current.id}/${nextGeneration}`, { kind: "abandoned-runtime", launchId: saved.launchId, evidence });
        if (current.assignment !== null) {
          const assigned: Team = team(current.assignment);
          put("team", assigned.id, { ...assigned, state: "reserved", generations: { ...assigned.generations, [current.id]: nextGeneration } });
        }
        return nextGeneration;
      });
    },
    runtimeAbandonments(): readonly RuntimeAbandonment[] {
      return all("runtimeAbandonment", runtimeAbandonmentSchema);
    },
    observeItemProgress(input: Readonly<{ itemId: string; revision: number; status: string; observedAt: number }>): ItemProgress {
      return tx(() => observeItemProgress(input));
    },
    itemProgress(): readonly ItemProgress[] {
      return all("itemProgress", itemProgressSchema);
    },
    prepareRuntime(input: RuntimeBinding): RuntimeBinding {
      return tx(() => {
        const runtime = runtimeBindingSchema.parse(input);
        const current = employee(runtime.employeeId);
        const key = `${runtime.employeeId}/${runtime.generation}`;
        const saved = read("runtimeBinding", key, runtimeBindingSchema);
        if (saved !== null) {
          if (saved.state === "abandoned") throw new StoreFenceError("Runtime generation was abandoned by manager recovery");
          if (saved.launchId !== runtime.launchId || saved.credentialDigest !== runtime.credentialDigest || encode(saved.source) !== encode(runtime.source))
            throw new StoreConflictError("Runtime generation already has a different launch reservation");
          return saved;
        }
        if (runtime.generation !== (current.role === "manager" ? current.generation : current.generation + 1))
          throw new StoreFenceError("Runtime launch must match the next reserved employee generation");
        if (!runtime.source.rolePath.endsWith(`/startup-role-${current.role}/SKILL.md`) || (current.canonicalRevision !== null && runtime.source.roleRevision !== current.canonicalRevision))
          throw new StoreAuthorityError("Runtime source does not match the reserved employee role");
        put("runtimeBinding", key, runtime);
        return runtime;
      });
    },
    updateRuntime(input: RuntimeBinding): RuntimeBinding {
      return tx(() => {
        const runtime = runtimeBindingSchema.parse(input);
        const key = `${runtime.employeeId}/${runtime.generation}`;
        const saved = read("runtimeBinding", key, runtimeBindingSchema);
        if (saved === null || saved.launchId !== runtime.launchId || saved.credentialDigest !== runtime.credentialDigest || encode(saved.source) !== encode(runtime.source))
          throw new StoreFenceError("Runtime update does not match its saved launch reservation");
        if (saved.state === "abandoned") {
          if (!sameDocument(saved, runtime)) throw new StoreFenceError("Runtime generation was abandoned by manager recovery");
          return saved;
        }
        if ((saved.nativeSession !== null && saved.nativeSession !== runtime.nativeSession) || runtime.lastProgress < saved.lastProgress || runtime.lastSeen < saved.lastSeen)
          throw new StoreFenceError("Runtime identity or timestamp regressed");
        if (saved.stateSequence !== null && (runtime.stateSequence === null || runtime.stateSequence < saved.stateSequence))
          throw new StoreFenceError("Runtime lifecycle observation checkpoint regressed");
        if (runtime.state === "ready" && (runtime.nativeSession === null || runtime.paneId === null || runtime.terminalId === null))
          throw new StoreAuthorityError("Runtime readiness requires pane, terminal and native session evidence");
        put("runtimeBinding", key, runtime);
        return runtime;
      });
    },
    runtimeBindings(): readonly RuntimeBinding[] {
      return all("runtimeBinding", runtimeBindingSchema);
    },
    employeeRuntime(employeeId: string, minimumGeneration: number): RuntimeBinding | null {
      return selected("SELECT payload FROM records WHERE kind='runtimeBinding' AND json_extract(payload,'$.employeeId')=? AND json_extract(payload,'$.generation')>=? ORDER BY json_extract(payload,'$.generation') DESC LIMIT 1", [employeeId, minimumGeneration], runtimeBindingSchema)[0] ?? null;
    },
    observeRuntime(input: Readonly<{ employeeId: string; generation: number; nativeSession: string; state: NonNullable<RuntimeBinding["observedState"]>; sequence: number; observedAt: number }>): void {
      tx(() => {
        const key = `${input.employeeId}/${input.generation}`;
        const runtime = read("runtimeBinding", key, runtimeBindingSchema);
        if (runtime === null || runtime.nativeSession !== input.nativeSession)
          throw new StoreFenceError("Observation does not match the bound native session");
        if (runtime.state === "abandoned") throw new StoreFenceError("Runtime generation was abandoned by manager recovery");
        const sequence = timeSchema.parse(input.sequence);
        if (runtime.stateSequence !== null && sequence < runtime.stateSequence)
          throw new StoreFenceError("Lifecycle observation sequence regressed");
        const seenCompletion = ["done", "idle"].includes(runtime.observedState ?? "") && ["done", "idle"].includes(input.state);
        if (runtime.stateSequence === sequence && runtime.observedState !== input.state && !seenCompletion)
          throw new StoreConflictError("Lifecycle sequence conflicts with its saved state");
        const observedAt = timeSchema.parse(input.observedAt);
        if (observedAt < runtime.lastSeen) throw new StoreFenceError("Observation time regressed");
        if (runtime.stateSequence !== sequence && input.state !== "working" && runtime.observedState !== input.state && !seenCompletion) {
          const id = `runtime-${runtime.launchId}-${sequence}-${input.state}`;
          const prior = read("message", id, messageSchema);
          if (prior !== null) {
            const payload = z.object({ kind: z.literal("runtime-observation"), employeeId: z.literal(runtime.employeeId), generation: z.literal(runtime.generation), state: z.literal(input.state), sequence: z.literal(sequence) }).safeParse(prior.payload);
            if (!payload.success || prior.recipient !== "manager" || prior.correlation !== runtime.launchId || prior.kind !== "alert")
              throw new StoreConflictError("Saved runtime observation alert conflicts with its launch identity");
          } else saveCue(employee("manager"), {
            id,
            recipient: "manager", kind: "alert", correlation: runtime.launchId,
            payload: { kind: "runtime-observation", employeeId: runtime.employeeId, generation: runtime.generation, state: input.state, observedAt, previousSequence: runtime.stateSequence, sequence },
          }, null);
          compactObservations(selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')='manager' AND json_extract(payload,'$.status')='pending' AND json_extract(payload,'$.correlation')=? AND json_extract(payload,'$.payload.kind')='runtime-observation' ORDER BY json_extract(payload,'$.sequence') DESC", [runtime.launchId], messageSchema));
        }
        put("runtimeBinding", key, { ...runtime, stateSequence: sequence, observedState: input.state, lastSeen: observedAt });
      });
    },
    compactRuntimeObservations(): Readonly<{ acknowledged: number }> {
      return tx(() => {
        const pending = selected("SELECT payload FROM records WHERE kind='message' AND json_extract(payload,'$.recipient')='manager' AND json_extract(payload,'$.status')='pending' AND json_extract(payload,'$.payload.kind')='runtime-observation' ORDER BY json_extract(payload,'$.sequence') DESC", [], messageSchema);
        return compactObservations(pending);
      });
    },
    runtimeAlert(input: Readonly<{ id: string; correlation: string; payload: Json }>): Message {
      return tx(() => saveCue(employee("manager"), { ...input, recipient: "manager", kind: "alert" }, null));
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
              nextDue:
                read("dutyEnd", duty.id, jsonSchema) === null
                  ? (read("dutyNext", duty.id, timeSchema) ?? duty.nextDue)
                  : null,
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
