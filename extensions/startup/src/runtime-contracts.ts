import { z } from "zod";
import { bindingSchema, idSchema, jsonSchema, observedRuntimeSchema, runtimeStateSchema, sourceSchema, timeSchema } from "./contracts";

export const runtimeBindingSchema = z.strictObject({
  employeeId: idSchema,
  generation: timeSchema,
  launchId: idSchema,
  credentialDigest: idSchema,
  source: sourceSchema,
  paneId: idSchema.nullable(),
  terminalId: idSchema.nullable(),
  tabId: idSchema.nullable(),
  nativeSession: idSchema.nullable(),
  state: runtimeStateSchema,
  error: z.string().nullable(),
  lastSeen: timeSchema,
  lastPoll: timeSchema,
  lastProgress: timeSchema,
  turnActive: z.boolean(),
  stateSequence: timeSchema.nullable(),
  observedState: observedRuntimeSchema.nullable(),
}).readonly();
export type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;

export const runtimeAbandonmentSchema = z.strictObject({
  employeeId: idSchema,
  launchId: idSchema,
  generation: timeSchema,
  nextGeneration: timeSchema,
  manager: bindingSchema,
  evidence: jsonSchema,
  verifiedAbsentAt: timeSchema,
  connectionDeadlineMs: z.number().int().positive().safe(),
}).readonly();
export type RuntimeAbandonment = z.infer<typeof runtimeAbandonmentSchema>;

export const runtimePolicySchema = z.strictObject({
  tickMs: z.number().int().positive().safe(),
  paCadenceMs: z.number().int().positive().safe(),
  progressDeadlineMs: z.number().int().positive().safe(),
  connectionDeadlineMs: z.number().int().positive().safe(),
  executionLimit: z.number().int().min(3).safe(),
});
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>;
