import { z } from "zod";
import {
  encode,
  jsonSchema,
  StoreRecoveryError,
  type Grant,
  type Json,
} from "./contracts";

export const resourceDocumentSchema = z
  .record(z.string(), jsonSchema)
  .readonly();
export type ResourceDocument = z.infer<typeof resourceDocumentSchema>;
export const legacyLockSchema = z
  .strictObject({
    id: z.string(),
    target: z.string(),
    payload: jsonSchema,
    state: z.enum(["blocked", "resolved"]),
    evidence: jsonSchema,
  })
  .readonly();
export type LegacyLock = z.infer<typeof legacyLockSchema>;

export function readLegacyLocks(
  document: ResourceDocument,
): readonly LegacyLock[] {
  function heldRecords(
    value: Json,
    path: string,
  ): readonly (readonly [string, Json])[] {
    if (Array.isArray(value))
      return value.flatMap((entry: Json, index: number) =>
        heldRecords(entry, `${path}/${index}`),
      );
    if (value === null || typeof value !== "object") return [];
    const record = resourceDocumentSchema.parse(value);
    if (record["held-by"] != null || record.held_by != null) {
      const target = z.string().min(1).safeParse(record.target);
      if (!target.success)
        throw new StoreRecoveryError(
          `Held legacy resource at ${path} has no explicit target; reconcile its target before import`,
        );
      return [[target.data, value]];
    }
    return Object.entries(record).flatMap(([key, entry]) =>
      heldRecords(entry, `${path}/${key}`),
    );
  }
  const locks: Json | undefined = document.locks;
  if (locks !== undefined && (locks === null || typeof locks !== "object"))
    throw new StoreRecoveryError(
      "resources.locks must be a target-keyed object or array with target fields; retain and reconcile the source",
    );
  const explicit: readonly (readonly [string, Json])[] =
    locks === undefined
      ? []
      : Array.isArray(locks)
        ? locks.map((payload: Json, index: number): readonly [string, Json] => {
            const parsed = z
              .object({ target: z.string().min(1) })
              .passthrough()
              .safeParse(payload);
            if (!parsed.success)
              throw new StoreRecoveryError(
                `Legacy lock ${index} has no unambiguous target; reconcile its target before import`,
              );
            return [parsed.data.target, payload];
          })
        : Object.entries(locks);
  const entries: readonly (readonly [string, Json])[] = [
    ...explicit,
    ...Object.entries(document)
      .filter(
        ([key]): boolean => !["locks", "history", "startup_v6"].includes(key),
      )
      .flatMap(([key, value]) => heldRecords(value, key)),
  ];
  return entries.map(
    ([target, payload], index): LegacyLock => ({
      id: `legacy-${index}`,
      target,
      payload,
      state: "blocked",
      evidence: null,
    }),
  );
}

export function projectResources(args: {
  readonly original: ResourceDocument;
  readonly locks: readonly LegacyLock[];
  readonly grants: readonly Grant[];
}): ResourceDocument {
  return resourceDocumentSchema.parse({
    ...args.original,
    locks: Object.fromEntries([
      ...args.locks
        .filter((lock): boolean => lock.state === "blocked")
        .map((lock): [string, Json] => [lock.target, lock.payload]),
      ...args.grants
        .filter((grant): boolean => grant.state !== "released")
        .map((grant): [string, Json] => [
          grant.target,
          {
            "held-by": grant.employeeId,
            grantId: grant.id,
            state: grant.state,
          },
        ]),
    ]),
    startup_v6: {
      original: args.original,
      legacyLocks: args.locks,
      grants: args.grants,
    },
  });
}

export function sameDocument(left: unknown, right: unknown): boolean {
  return encode(left) === encode(right);
}
