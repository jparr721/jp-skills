import { z } from "zod";
import {
  cueSchema,
  employeeSchema,
  idSchema,
  jsonSchema,
  rowSchema,
  timeSchema,
} from "./contracts";
const common = {
  requestId: idSchema,
  itemId: idSchema,
  expectedRevision: timeSchema,
};
export const itemActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...common,
    action: z.literal("assign"),
    employeeId: idSchema,
    evidence: jsonSchema,
  }),
  z.strictObject({
    ...common,
    action: z.literal("review"),
    resultId: idSchema,
    evidence: jsonSchema,
  }),
  z.strictObject({
    ...common,
    action: z.literal("qa_assign"),
    evidence: jsonSchema,
  }),
  z.strictObject({
    ...common,
    action: z.literal("qa"),
    resultId: idSchema,
    verdict: z.enum(["APPROVE", "REDO"]),
    proof: jsonSchema,
  }),
  z.strictObject({
    ...common,
    action: z.literal("gate"),
    verdict: z.enum(["APPROVE", "REDO"]),
    evidence: jsonSchema,
  }),
  z.strictObject({
    ...common,
    action: z.literal("decide"),
    status: z.enum([
      "BLOCKED",
      "NEEDS_DECISION",
      "QUEUED",
      "REJECTED",
      "MERGED",
      "DONE",
    ]),
    evidence: jsonSchema,
  }),
]);
export const itemExecutionSchema = z
  .strictObject({
    itemId: idSchema,
    eventId: idSchema,
    teamId: idSchema,
    attemptId: idSchema,
    employeeId: idSchema,
    generation: timeSchema,
    messageId: idSchema,
    qaMessageId: idSchema.nullable(),
    qaGeneration: timeSchema.nullable(),
    reviewResultId: idSchema.nullable(),
    qa: z
      .strictObject({
        verdict: z.enum(["APPROVE", "REDO"]),
        resultId: idSchema,
        proof: jsonSchema,
      })
      .nullable(),
    snapshot: rowSchema,
  })
  .readonly();
export const itemTransitionSchema = z
  .strictObject({
    request: itemActionSchema,
    actorId: idSchema,
    eventId: idSchema,
    teamId: idSchema,
    revision: timeSchema,
    status: z.string(),
    row: rowSchema,
    execution: itemExecutionSchema.nullable(),
    cues: z
      .array(
        z.strictObject({
          sender: employeeSchema,
          cue: cueSchema,
          teamId: idSchema,
        }),
      )
      .readonly(),
  })
  .readonly();
export type ItemAction = z.infer<typeof itemActionSchema>;
export type ItemExecution = z.infer<typeof itemExecutionSchema>;
export type ItemTransition = z.infer<typeof itemTransitionSchema>;
export const terminalItemStatuses: readonly string[] = [
  "MERGED",
  "DONE",
  "COMPLETED",
  "REJECTED",
];
