import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hostCancelReceiptSchema, jsonSchema, rowSchema, scopeSchema } from "./contracts";
import type { LegacyTransferEvidence } from "./store";

const reviewSchema = z.strictObject({ changeId: z.string().min(1), reservationId: z.string().min(1), head: z.string().min(1), reviewerId: z.string().min(1), messageId: z.string().min(1), limit: z.number().int().min(1).max(3), state: z.literal("completed"), verdict: z.enum(["changes-requested", "block"]), resultId: z.string().min(1) });

export function verifyCancelledLegacySnapshot(input: Readonly<{ snapshot: string; sourceRoot: string; itemId: string; intentId: string; migrationId: string }>): LegacyTransferEvidence {
  const db = new Database(input.snapshot, { readonly: true });
  try {
    const read = (kind: string, id: string): unknown => {
      const raw = db.query("SELECT payload FROM records WHERE kind=? AND id=?").get(kind, id);
      return raw == null ? null : JSON.parse(z.object({ payload: z.string() }).parse(raw).payload);
    };
    if (scopeSchema.parse(read("meta", "scope")).startupRoot !== input.sourceRoot) throw new Error("Legacy snapshot belongs to a different root");
    const receipt = hostCancelReceiptSchema.parse(read("hostReceipt", `cancel:${input.intentId}`));
    if (receipt.intentId !== input.intentId || receipt.target.kind !== "item" || receipt.target.itemId !== input.itemId || receipt.target.slots.length !== 0) throw new Error("Cancellation does not prove an unassigned item");
    const expectedDigest = createHash("sha256").update(JSON.stringify({ intentId: receipt.intentId, requestOrItemId: receipt.requestOrItemId })).digest("hex");
    if (receipt.id !== `cancel:${input.intentId}` || receipt.digest !== expectedDigest) throw new Error("Cancellation receipt digest does not match");
    const intent = z.object({ state: z.literal("complete"), file: z.literal("queue.json"), before: z.string(), after: z.string(), hostCancel: z.object({ itemId: z.string(), eventId: z.string(), teamId: z.string(), revision: z.number().int().positive() }) }).parse(read("intent", `host-cancel/${input.intentId}`));
    if (intent.hostCancel.itemId !== input.itemId || intent.hostCancel.revision !== receipt.target.revision) throw new Error("Cancellation journal does not match receipt");
    const rows = (raw: string): readonly z.infer<typeof rowSchema>[] => { const value: unknown = JSON.parse(raw); if (Array.isArray(value)) return z.array(rowSchema).parse(value); const object = z.record(z.string(), z.unknown()).parse(value); if (Object.hasOwn(object, "items") === Object.hasOwn(object, "rows")) throw new Error("Ambiguous legacy queue"); return z.array(rowSchema).parse(object.items ?? object.rows); };
    const original = rows(intent.before).filter((row) => row.id === input.itemId);
    const cancelled = rows(intent.after).filter((row) => row.id === input.itemId);
    if (original.length !== 1 || original[0]!.status !== "QUEUED" || original[0]!.dispatched_at != null || cancelled.length !== 1 || cancelled[0]!.status !== "CANCELLED") throw new Error("Cancellation before-image is not an undispatched queued item");
    const owner = z.object({ id: z.string(), eventId: z.string(), revision: z.number().int() }).parse(read("queueOwner", input.itemId));
    const team = z.object({ id: z.string(), eventId: z.string(), state: z.literal("finished") }).parse(read("team", intent.hostCancel.teamId));
    if (owner.id !== input.itemId || owner.eventId !== intent.hostCancel.eventId || owner.revision !== receipt.target.revision || team.id !== intent.hostCancel.teamId || team.eventId !== owner.eventId) throw new Error("Cancelled item ownership or finished team does not match");
    if (read("itemExecution", input.itemId) !== null) throw new Error("Legacy item has execution history");
    const related = z.object({ n: z.number() }).parse(db.query(`SELECT COUNT(*) AS n FROM records WHERE (kind IN ('workflowChild','managerRun') AND json_extract(payload,'$.itemId')=?) OR (kind='workflowLaunch' AND json_extract(payload,'$.scopeId') IN (SELECT id FROM records WHERE kind='workflowScope' AND json_extract(payload,'$.itemId')=? UNION SELECT id FROM records WHERE kind='workflowFactoryScope' AND EXISTS (SELECT 1 FROM json_each(records.payload,'$.items') WHERE json_extract(value,'$.itemId')=?))) OR (kind='claim' AND json_extract(payload,'$.status')!='settled' AND id IN (SELECT json_extract(payload,'$.claimId') FROM records WHERE kind='workflowScope' AND json_extract(payload,'$.itemId')=?))`).get(input.itemId, input.itemId, input.itemId, input.itemId)).n;
    if (related !== 0) throw new Error("Legacy item has workflow or execution history");
    const limit = z.number().int().min(1).max(3).nullable().parse(read("workflowLimit", input.itemId));
    const target = z.string().trim().min(1).nullable().parse(read("workflowTarget", input.itemId));
    const reviews = z.array(z.object({ payload: z.string() })).parse(db.query("SELECT payload FROM records WHERE kind='workflowReview' AND json_extract(payload,'$.changeId')=?").all(input.itemId)).map((entry) => reviewSchema.parse(JSON.parse(entry.payload)));
    if (reviews.length > 0 && (limit === null || reviews.length >= Math.min(limit, 2) || reviews.some((review) => review.limit < limit))) throw new Error("Legacy review history is unresolved or its budget is exhausted");
    for (const review of reviews) {
      const result = z.object({ claimId: z.string(), result: z.object({ kind: z.literal("completed"), output: z.object({ kind: z.literal("workflow-review"), reservationId: z.string(), head: z.string(), verdict: z.string() }) }) }).parse(read("result", review.resultId));
      const claim = z.object({ employeeId: z.string(), messageId: z.string(), status: z.literal("settled") }).parse(read("claim", result.claimId));
      if (claim.employeeId !== review.reviewerId || claim.messageId !== review.messageId || result.result.output.reservationId !== review.reservationId || result.result.output.head !== review.head || result.result.output.verdict !== review.verdict) throw new Error("Legacy review result does not match its reservation");
    }
    return { itemId: input.itemId, migrationId: input.migrationId, original: jsonSchema.parse(original[0]), source: input.sourceRoot, ownerFenced: true, notDispatched: true, limit, target, reviews, evidence: `Committed cancellation ${input.intentId}; finished team ${team.id}; snapshot ${input.snapshot}` };
  } finally { db.close(); }
}
