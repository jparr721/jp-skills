import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { jsonSchema, rowSchema, scopeSchema, type Binding, type Json } from "./contracts";
import type { StartupStore } from "./store";
import { terminalItemStatuses } from "./items";
import { verifyCancelledLegacySnapshot } from "./legacy-cancel-verifier";

export const migrationName = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const manifestSchema = z.strictObject({ migrationId: migrationName, sourceRoot: z.string(), binding: z.string(), queue: z.string(), database: z.string(), wal: z.string().nullable(), snapshot: z.string(), items: z.array(z.string()) });

function hashFile(path: string): string {
  const digest = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(65536);
  try {
    let size: number;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size));
  } finally { closeSync(fd); }
  return digest.digest("hex");
}

function sourceHashes(root: string): { binding: string; queue: string; database: string; wal: string | null } {
  for (const name of ["binding.json", "queue.json", "staff.sqlite"]) {
    const stat = lstatSync(join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Legacy ${name} must be a regular file`);
  }
  const wal = join(root, "staff.sqlite-wal");
  if (existsSync(wal) && (!lstatSync(wal).isFile() || lstatSync(wal).isSymbolicLink())) throw new Error("Legacy WAL must be a regular file");
  return { binding: hashFile(join(root, "binding.json")), queue: hashFile(join(root, "queue.json")), database: hashFile(join(root, "staff.sqlite")), wal: existsSync(wal) ? hashFile(wal) : null };
}

function queueRows(raw: unknown): readonly z.infer<typeof rowSchema>[] {
  if (Array.isArray(raw)) return z.array(rowSchema).parse(raw);
  const document = z.record(z.string(), jsonSchema).parse(raw);
  if (Object.hasOwn(document, "items") === Object.hasOwn(document, "rows")) throw new Error("Legacy queue must have exactly one items or rows array");
  return z.array(rowSchema).parse(Object.hasOwn(document, "items") ? document.items : document.rows);
}

export function migrateLegacyStartup(input: Readonly<{ sourceRoot: string; targetRoot: string; migrationId: string; store: StartupStore; manager: Binding }>): Readonly<{ migrationId: string; archive: string; items: readonly string[]; unresolved: readonly string[]; retained: readonly string[] }> {
  const migrationId = migrationName.parse(input.migrationId);
  if (!isAbsolute(input.sourceRoot) || !isAbsolute(input.targetRoot)) throw new Error("Legacy and target roots must be absolute");
  const sourceRoot = realpathSync(input.sourceRoot);
  const targetRoot = realpathSync(input.targetRoot);
  const inside = (parent: string, child: string): boolean => { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };
  if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot)) throw new Error("Legacy and target roots must be separate");
  const hashes = sourceHashes(sourceRoot);
  const binding = z.record(z.string(), jsonSchema).parse(JSON.parse(readFileSync(join(sourceRoot, "binding.json"), "utf8")));
  const scoped = Object.hasOwn(binding, "scope") ? z.strictObject({ scope: scopeSchema, executionLimit: z.number().int().positive().safe().nullable() }).parse(binding) : null;
  if (scoped === null) z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]+$/), bound_root: z.string().min(1) }).parse(binding);
  else if (scoped.scope.startupRoot !== sourceRoot) throw new Error("Scoped source binding does not match source root");
  const archives = join(targetRoot, "legacy-imports");
  mkdirSync(archives, { recursive: true, mode: 0o700 });
  if (lstatSync(archives).isSymbolicLink()) throw new Error("Legacy archive directory cannot be a symlink");
  const archive = join(archives, migrationId);
  if (!existsSync(archive)) {
    const temporary = join(archives, `.pending-${randomUUID()}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      const originalQueue = readFileSync(join(sourceRoot, "queue.json"));
      const rows = queueRows(JSON.parse(originalQueue.toString("utf8")));
      if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Legacy queue contains duplicate item IDs");
      writeFileSync(join(temporary, "binding.json"), readFileSync(join(sourceRoot, "binding.json")), { mode: 0o600, flag: "wx" });
      writeFileSync(join(temporary, "queue.json"), originalQueue, { mode: 0o600, flag: "wx" });
      const db = new Database(join(sourceRoot, "staff.sqlite"), { readonly: true });
      try {
        const tables = z.array(z.object({ name: z.string() })).parse(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('records', 'audit', 'lease')").all());
        if (tables.length !== 3) throw new Error("Legacy database does not match the Startup store format");
        db.run("VACUUM main INTO ?", [join(temporary, "staff.sqlite")]);
      } finally { db.close(); }
      const after = sourceHashes(sourceRoot);
      if (JSON.stringify(hashes) !== JSON.stringify(after)) throw new Error("Legacy source changed during snapshot; retry after it is stable");
      const manifest = manifestSchema.parse({ migrationId, sourceRoot, ...hashes, snapshot: hashFile(join(temporary, "staff.sqlite")), items: rows.map((row) => row.id) });
      writeFileSync(join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, archive);
    } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
  }
  if (lstatSync(archive).isSymbolicLink() || !lstatSync(archive).isDirectory()) throw new Error("Legacy archive must be a directory");
  for (const name of ["manifest.json", "binding.json", "queue.json", "staff.sqlite"]) {
    const stat = lstatSync(join(archive, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Legacy archive ${name} must be a regular file`);
  }
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8")));
  if (manifest.migrationId !== migrationId || manifest.sourceRoot !== sourceRoot || JSON.stringify(hashes) !== JSON.stringify({ binding: manifest.binding, queue: manifest.queue, database: manifest.database, wal: manifest.wal }) || hashFile(join(archive, "binding.json")) !== manifest.binding || hashFile(join(archive, "queue.json")) !== manifest.queue || hashFile(join(archive, "staff.sqlite")) !== manifest.snapshot) throw new Error("Legacy source or archive changed; use a new migration after reconciliation");
  if (scoped !== null) {
    const snapshot = new Database(join(archive, "staff.sqlite"), { readonly: true });
    try {
      const saved = z.object({ payload: z.string() }).parse(snapshot.query("SELECT payload FROM records WHERE kind='meta' AND id='scope'").get());
      if (JSON.stringify(scopeSchema.parse(JSON.parse(saved.payload))) !== JSON.stringify(scoped.scope)) throw new Error("Scoped source binding does not match its database");
    } finally { snapshot.close(); }
  }
  const rows = queueRows(JSON.parse(readFileSync(join(archive, "queue.json"), "utf8")));
  if (JSON.stringify(rows.map((row) => row.id)) !== JSON.stringify(manifest.items)) throw new Error("Legacy archive item list does not match snapshot");
  const retained = rows.filter((row) => typeof row.status === "string" && terminalItemStatuses.includes(row.status));
  const pending = rows.filter((row) => typeof row.status !== "string" || !terminalItemStatuses.includes(row.status));
  if (pending.length === 0) return { migrationId, archive, items: [], unresolved: [], retained: retained.map((row) => row.id) };
  const existing = input.store.queueItems();
  const snapshot = input.store.snapshot();
  let alreadyImported = 0;
  for (const row of pending) {
    const current = existing.find((entry) => entry.id === row.id);
    if (!current) continue;
    const imported = z.object({ migrationId: z.string(), sourceRoot: z.string().optional(), original: jsonSchema }).safeParse(current.legacy_import);
    const owner = snapshot.queueRevisions.find((entry) => entry.id === row.id);
    const intake = snapshot.intakes.find((entry) => entry.request.eventId === owner?.eventId);
    const provenance = z.object({ kind: z.literal("legacy-import"), sourceRoot: z.string(), migrationId: z.string() }).safeParse(intake?.request.input);
    const savedSource = imported.success ? imported.data.sourceRoot ?? (provenance.success && provenance.data.migrationId === migrationId ? provenance.data.sourceRoot : undefined) : undefined;
    if (!imported.success || imported.data.migrationId !== migrationId || savedSource !== sourceRoot || JSON.stringify(imported.data.original) !== JSON.stringify(row)) throw new Error(`Target already contains item ${row.id}; preserve both and reconcile`);
    alreadyImported++;
  }
  if (alreadyImported === pending.length) return { migrationId, archive, items: pending.map((row) => row.id), unresolved: pending.map((row) => row.id), retained: retained.map((row) => row.id) };
  if (alreadyImported !== 0) throw new Error("Legacy import is partially present; reconcile its original receipt");
  const eventId = `legacy-${migrationId}`;
  const captureId = `legacy-capture-${migrationId}`;
  input.store.recordIntake({ manager: input.manager, event: { eventId, input: { kind: "legacy-import", sourceRoot, archive, migrationId }, amendItemIds: [] } });
  input.store.captureIntake({ architect: input.manager, capture: { captureId, eventId, receipt: { kind: "legacy-import", archive, migrationId }, rows: pending.map((row) => {
    const fields: Record<string, Json> = { ...row, request: typeof row.request === "string" && row.request.trim() ? row.request : `Legacy item ${row.id}`, acceptance: row.acceptance ?? null, status: "NEEDS_DECISION", blocked_on: "Reconcile legacy work and review history before dispatch", legacy_import: { migrationId, sourceRoot, original: row } };
    return { id: row.id, expectedRevision: null, fields };
  }) } });
  return { migrationId, archive, items: pending.map((row) => row.id), unresolved: pending.map((row) => row.id), retained: retained.map((row) => row.id) };
}

export async function transferCancelledLegacyItem(input: Readonly<{ sourceRoot: string; targetRoot: string; migrationId: string; itemId: string; intentId: string; store: StartupStore; manager: Binding }>): Promise<import("./store").LegacyTransferEvidence> {
  const migrationId = migrationName.parse(input.migrationId);
  if (!isAbsolute(input.sourceRoot) || !isAbsolute(input.targetRoot)) throw new Error("Source and target roots must be absolute");
  const sourceRoot = realpathSync(input.sourceRoot);
  const targetRoot = realpathSync(input.targetRoot);
  if (input.store.scope.startupRoot !== targetRoot) throw new Error("Transfer destination does not match the owned store");
  const within = (parent: string, child: string): boolean => { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };
  if (within(sourceRoot, targetRoot) || within(targetRoot, sourceRoot)) throw new Error("Source and target roots must be separate");
  for (const name of ["binding.json", "staff.sqlite", "queue.json"]) { const stat = lstatSync(join(sourceRoot, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Legacy source ${name} must be a regular file`); }
  const binding = z.strictObject({ scope: scopeSchema, executionLimit: z.number().int().positive().safe().nullable() }).parse(JSON.parse(readFileSync(join(sourceRoot, "binding.json"), "utf8")));
  if (binding.scope.startupRoot !== sourceRoot) throw new Error("Legacy binding belongs to another root");
  const key = createHash("sha256").update(JSON.stringify([migrationId, input.itemId, input.intentId, sourceRoot])).digest("hex");
  const parent = join(targetRoot, "legacy-transfers");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink()) throw new Error("Legacy transfer directory cannot be a symlink");
  const archive = join(parent, key);
  if (!existsSync(archive)) {
    const temporary = join(parent, `.pending-${randomUUID()}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      const source = new Database(join(sourceRoot, "staff.sqlite"), { readonly: true });
      try { source.run("VACUUM main INTO ?", [join(temporary, "staff.sqlite")]); } finally { source.close(); }
      chmodSync(join(temporary, "staff.sqlite"), 0o600);
      writeFileSync(join(temporary, "binding.json"), JSON.stringify(binding), { mode: 0o600, flag: "wx" });
      const snapshot = join(temporary, "staff.sqlite");
      const evidence = verifyCancelledLegacySnapshot({ snapshot, sourceRoot, itemId: input.itemId, intentId: input.intentId, migrationId });
      writeFileSync(join(temporary, "manifest.json"), JSON.stringify({ key, sourceRoot, itemId: input.itemId, intentId: input.intentId, migrationId, snapshot: hashFile(snapshot), original: evidence.original }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, archive);
    } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
  }
  if (!lstatSync(archive).isDirectory() || lstatSync(archive).isSymbolicLink()) throw new Error("Legacy transfer archive must be a directory");
  for (const name of ["manifest.json", "staff.sqlite", "binding.json"]) if (!lstatSync(join(archive, name)).isFile() || lstatSync(join(archive, name)).isSymbolicLink()) throw new Error(`Invalid legacy transfer ${name}`);
  const manifest = z.strictObject({ key: z.string(), sourceRoot: z.string(), itemId: z.string(), intentId: z.string(), migrationId: z.string(), snapshot: z.string(), original: jsonSchema }).parse(JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8")));
  if (manifest.key !== key || manifest.sourceRoot !== sourceRoot || manifest.itemId !== input.itemId || manifest.intentId !== input.intentId || manifest.migrationId !== migrationId || manifest.snapshot !== hashFile(join(archive, "staff.sqlite"))) throw new Error("Legacy transfer archive changed");
  const snapshotDb = new Database(join(archive, "staff.sqlite"), { readonly: true });
  try { const saved = z.object({ payload: z.string() }).parse(snapshotDb.query("SELECT payload FROM records WHERE kind='meta' AND id='scope'").get()); if (JSON.stringify(scopeSchema.parse(JSON.parse(saved.payload))) !== JSON.stringify(binding.scope)) throw new Error("Legacy binding does not match its source database"); } finally { snapshotDb.close(); }
  const current = queueRows(JSON.parse(readFileSync(join(sourceRoot, "queue.json"), "utf8"))).filter((row) => row.id === input.itemId);
  if (current.length !== 1 || current[0]!.status !== "CANCELLED") throw new Error("Source item is not currently cancelled");
  const proof = verifyCancelledLegacySnapshot({ snapshot: join(archive, "staff.sqlite"), sourceRoot, itemId: input.itemId, intentId: input.intentId, migrationId });
  if (JSON.stringify(proof.original) !== JSON.stringify(manifest.original)) throw new Error("Legacy transfer before-image changed");
  const checkDestination = () => {
    const existing = input.store.queueItems().find((row) => row.id === input.itemId);
    if (existing) {
      const imported = z.object({ migrationId: z.string(), sourceRoot: z.string().optional(), original: jsonSchema }).safeParse(existing.legacy_import);
      const snapshot = input.store.snapshot();
      const owner = snapshot.queueRevisions.find((row) => row.id === input.itemId);
      const event = snapshot.intakes.find((row) => row.request.eventId === owner?.eventId);
      const provenance = z.object({ kind: z.literal("legacy-import"), sourceRoot: z.string(), migrationId: z.string() }).safeParse(event?.request.input);
      const savedSource = imported.success ? imported.data.sourceRoot ?? (provenance.success && provenance.data.migrationId === migrationId ? provenance.data.sourceRoot : undefined) : undefined;
      if (!imported.success || imported.data.migrationId !== migrationId || savedSource !== sourceRoot || JSON.stringify(imported.data.original) !== JSON.stringify(proof.original)) throw new Error("Destination item belongs to a different source or transfer");
    }
    return existing;
  };
  checkDestination();
  claimLegacyHandover({ sourceRoot, targetRoot, itemId: input.itemId, intentId: input.intentId, migrationId });
  const existing = checkDestination();
  if (!existing) {
    const eventId = `legacy-cancel-${key}`;
    const original = z.record(z.string(), jsonSchema).parse(proof.original);
    input.store.recordIntake({ manager: input.manager, event: { eventId, input: { kind: "legacy-cancel-transfer", sourceRoot, archive, migrationId }, amendItemIds: [] } });
    input.store.captureIntake({ architect: input.manager, capture: { captureId: eventId, eventId, receipt: { kind: "legacy-cancel-transfer", archive, migrationId }, rows: [{ id: input.itemId, expectedRevision: null, fields: { ...original, status: "NEEDS_DECISION", blocked_on: "Verify legacy cancellation before transfer", legacy_import: { migrationId, sourceRoot, original } } }] } });
  }
  return input.store.reconcileLegacyItem({ manager: input.manager, itemId: input.itemId, verify: async () => proof });
}

export function claimLegacyHandover(input: Readonly<{ sourceRoot: string; targetRoot: string; itemId: string; intentId: string; migrationId: string }>): void {
  const { sourceRoot, targetRoot, itemId, intentId, migrationId } = input;
  const handovers = join(sourceRoot, "legacy-handovers");
  mkdirSync(handovers, { recursive: true, mode: 0o700 });
  const sourceDirectory = openSync(sourceRoot, "r");
  try { fsyncSync(sourceDirectory); } finally { closeSync(sourceDirectory); }
  const handoverStat = lstatSync(handovers);
  if (!handoverStat.isDirectory() || handoverStat.isSymbolicLink() || (handoverStat.mode & 0o077) !== 0) throw new Error("Legacy handover directory must be private");
  const receiptPath = join(handovers, `${createHash("sha256").update(itemId).digest("hex")}.json`);
  const receiptBody = JSON.stringify({ itemId: itemId, intentId: intentId, migrationId, targetRoot });
  const temporaryReceipt = join(handovers, `.pending-${randomUUID()}`);
  const receiptFd = openSync(temporaryReceipt, "wx", 0o600);
  try { writeFileSync(receiptFd, receiptBody); fsyncSync(receiptFd); } finally { closeSync(receiptFd); }
  try {
    try { linkSync(temporaryReceipt, receiptPath); }
    catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    const saved = lstatSync(receiptPath);
    if (!saved.isFile() || saved.isSymbolicLink() || (saved.mode & 0o077) !== 0 || readFileSync(receiptPath, "utf8") !== receiptBody) throw new Error("Legacy item is already bound to a different handover");
    const directory = openSync(handovers, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temporaryReceipt); }
}
