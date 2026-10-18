import { z } from "zod";
import { bindingSchema, idSchema, jsonSchema, observedRuntimeSchema, roleSchema, runtimeStateSchema, sourceSchema, timeSchema } from "./contracts";

export const runtimeHarnessSchema = z.enum(["omp", "claude"]);
export const roleSettingsInputSchema = z.strictObject({
  role: roleSchema,
  harness: runtimeHarnessSchema,
  model: z.string().nullable(),
  effort: z.string().nullable(),
}).readonly();
export type RoleSettingsInput = z.infer<typeof roleSettingsInputSchema>;

const requestedValueSchema = z.strictObject({
  value: z.string().nullable(),
  validation: z.enum(["not_requested", "unverified"]),
}).readonly();
export const requestedRoleSettingsSchema = z.strictObject({
  role: roleSchema,
  harness: runtimeHarnessSchema,
  model: requestedValueSchema,
  effort: requestedValueSchema,
}).readonly();
export type RequestedRoleSettings = z.infer<typeof requestedRoleSettingsSchema>;

export const roleSettingsProvenanceSchema = z.strictObject({
  kind: z.enum(["startup_default", "manager_request"]),
  actor: idSchema,
  generation: timeSchema.nullable(),
  updatedAt: timeSchema,
}).readonly();
export const savedRoleSettingsSchema = z.strictObject({
  role: roleSchema,
  requested: requestedRoleSettingsSchema,
  scope: z.literal("future_launch"),
  revision: timeSchema,
  provenance: roleSettingsProvenanceSchema,
}).readonly();
export type SavedRoleSettings = z.infer<typeof savedRoleSettingsSchema>;

export const runtimeIdentitySchema = z.strictObject({
  ownerId: idSchema,
  ownerEpoch: timeSchema,
  employeeId: idSchema,
  generation: timeSchema,
  launchId: idSchema,
  nativeSession: idSchema,
  agentSessionId: idSchema.nullable(),
}).readonly();
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;

export const runtimeModelSchema = z.strictObject({
  provider: idSchema,
  id: idSchema,
  name: z.string().min(1),
}).readonly();
const ompSessionSettingsIdentityShape = {
  nativeSession: idSchema,
  agentSessionId: idSchema,
  observedAt: timeSchema,
};
const ompSessionSettingsValuesShape = {
  model: runtimeModelSchema.nullable(),
  availableModels: z.array(runtimeModelSchema).readonly(),
  configuredEffort: z.string().nullable(),
  effectiveEffort: z.string().nullable(),
  availableEfforts: z.array(z.string()).readonly(),
};
export const ompSessionSettingsReportSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), ...ompSessionSettingsIdentityShape, ...ompSessionSettingsValuesShape }).readonly(),
  z.strictObject({ status: z.literal("unavailable"), reason: z.literal("omp_session_api_unavailable"), ...ompSessionSettingsIdentityShape }).readonly(),
]);
export type OmpSessionSettingsReport = z.infer<typeof ompSessionSettingsReportSchema>;

export const runtimeCapabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    harness: z.literal("omp"),
    session: runtimeIdentitySchema,
    availableModels: z.array(runtimeModelSchema).readonly(),
    availableEfforts: z.array(z.string()).readonly(),
    observedAt: timeSchema,
  }).readonly(),
  z.strictObject({
    status: z.literal("unavailable"),
    harness: runtimeHarnessSchema.nullable(),
    reason: z.enum([
      "session_not_observed",
      "omp_session_api_unavailable",
      "claude_cli_catalog_unavailable",
    ]),
    session: runtimeIdentitySchema.nullable(),
    observedAt: timeSchema.nullable(),
  }).readonly(),
]);
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;

export const effectiveRoleSettingsSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    harness: z.literal("omp"),
    session: runtimeIdentitySchema,
    model: runtimeModelSchema.nullable(),
    configuredEffort: z.string().nullable(),
    effectiveEffort: z.string().nullable(),
    observedAt: timeSchema,
  }).readonly(),
  z.strictObject({
    status: z.literal("unavailable"),
    harness: runtimeHarnessSchema.nullable(),
    reason: z.enum([
      "session_not_observed",
      "omp_session_api_unavailable",
      "claude_cli_readback_unavailable",
    ]),
    session: runtimeIdentitySchema.nullable(),
    observedAt: timeSchema.nullable(),
  }).readonly(),
]);
export type EffectiveRoleSettings = z.infer<typeof effectiveRoleSettingsSchema>;

export const runtimeBindingSchema = z.strictObject({
  employeeId: idSchema,
  generation: timeSchema,
  launchId: idSchema,
  credentialDigest: idSchema,
  source: sourceSchema,
  settings: savedRoleSettingsSchema,
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
