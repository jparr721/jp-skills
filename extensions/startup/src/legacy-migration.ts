import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { jsonSchema, rowSchema, scopeSchema, type Binding, type Json } from "./contracts";
import type { StartupStore } from "./store";
import { terminalItemStatuses } from "./items";

const migrationName = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
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
  for (const row of pending) {
    const current = existing.find((entry) => entry.id === row.id);
    if (!current) continue;
    const imported = z.object({ migrationId: z.string(), original: jsonSchema }).safeParse(current.legacy_import);
    if (!imported.success || imported.data.migrationId !== migrationId || JSON.stringify(imported.data.original) !== JSON.stringify(row)) throw new Error(`Target already contains item ${row.id}; preserve both and reconcile`);
  }
  const eventId = `legacy-${migrationId}`;
  const captureId = `legacy-capture-${migrationId}`;
  input.store.recordIntake({ manager: input.manager, event: { eventId, input: { kind: "legacy-import", sourceRoot, archive, migrationId }, amendItemIds: [] } });
  input.store.captureIntake({ architect: input.manager, capture: { captureId, eventId, receipt: { kind: "legacy-import", archive, migrationId }, rows: pending.map((row) => {
    const fields: Record<string, Json> = { ...row, request: typeof row.request === "string" && row.request.trim() ? row.request : `Legacy item ${row.id}`, acceptance: row.acceptance ?? null, status: "NEEDS_DECISION", blocked_on: "Reconcile legacy work and review history before dispatch", legacy_import: { migrationId, original: row } };
    return { id: row.id, expectedRevision: null, fields };
  }) } });
  return { migrationId, archive, items: pending.map((row) => row.id), unresolved: pending.map((row) => row.id), retained: retained.map((row) => row.id) };
}
