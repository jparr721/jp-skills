import { z } from "zod";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.json();
export const idSchema = z.string().min(1).max(512);
export const timeSchema = z.number().int().nonnegative().safe();
export const roleSchema = z.enum([
  "manager",
  "architect",
  "qa",
  "dev",
  "devops",
  "pa",
]);
export const scopeSchema = z
  .strictObject({
    home: idSchema,
    host: idSchema,
    name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    boundRoot: idSchema,
    managerSession: idSchema,
  })
  .readonly();
export const ownerSchema = z
  .strictObject({
    id: idSchema,
    managerGeneration: timeSchema,
    leaseMs: z.number().int().positive().safe(),
  })
  .readonly();
export const bindingSchema = z
  .strictObject({
    employeeId: idSchema,
    generation: timeSchema,
    nativeHandle: idSchema,
  })
  .readonly();
export const authoritySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), acceptedEventId: idSchema }),
    z.strictObject({ kind: z.literal("employee"), binding: bindingSchema }),
  ])
  .readonly();
export const sourceSchema = z
  .strictObject({
    rolePath: idSchema,
    roleRevision: idSchema,
    loopPath: idSchema,
    loopRevision: idSchema,
  })
  .readonly();
export const employeeSchema = z
  .strictObject({
    id: idSchema,
    role: roleSchema,
    employment: z.enum(["hired", "retired"]),
    generation: timeSchema,
    nativeHandle: idSchema.nullable(),
    source: sourceSchema.nullable(),
    assignment: idSchema.nullable(),
    canonicalRevision: idSchema.nullable(),
    checkpoint: jsonSchema,
    error: z.string().nullable(),
  })
  .readonly();
export const hireSchema = z
  .strictObject({
    requestId: idSchema,
    role: roleSchema.exclude(["manager"]),
    additional: z.number().int().positive().safe(),
    revision: idSchema,
  })
  .readonly();
export const intakeSchema = z
  .strictObject({
    eventId: idSchema,
    input: jsonSchema,
    amendItemIds: z.array(idSchema).readonly(),
  })
  .readonly();
export const cueSchema = z
  .strictObject({
    id: idSchema,
    recipient: idSchema,
    kind: z.enum([
      "assignment",
      "report",
      "question",
      "answer",
      "alert",
      "duty",
    ]),
    correlation: idSchema,
    payload: jsonSchema,
  })
  .readonly();
export const messageSchema = cueSchema
  .unwrap()
  .extend({
    sender: idSchema,
    sequence: timeSchema,
    teamId: idSchema.nullable(),
    status: z.enum(["pending", "claimed", "acknowledged"]),
  })
  .readonly();
export const claimSchema = z
  .strictObject({
    id: idSchema,
    employeeId: idSchema,
    messageId: idSchema,
    ownerEpoch: timeSchema,
    generation: timeSchema,
    status: z.enum(["active", "settled", "reconciliation"]),
  })
  .readonly();
export const resultSchema = z
  .strictObject({
    id: idSchema,
    kind: z.enum(["completed", "question", "uncertain"]),
    output: jsonSchema,
    checkpoint: jsonSchema,
    outgoing: z.array(cueSchema).readonly(),
  })
  .readonly();
export const teamSchema = z
  .strictObject({
    id: idSchema,
    eventId: idSchema,
    architect: idSchema,
    qa: idSchema,
    devs: z.array(idSchema).min(1).readonly(),
    generations: z.record(idSchema, timeSchema).readonly(),
    state: z.enum([
      "reserved",
      "ready",
      "active",
      "waiting",
      "reconciliation",
      "finished",
    ]),
    items: z
      .array(z.strictObject({ id: idSchema, revision: timeSchema }).readonly())
      .readonly(),
  })
  .readonly();
export const rowSchema = z
  .object({ id: idSchema })
  .catchall(jsonSchema)
  .readonly();
export const captureSchema = z
  .strictObject({
    captureId: idSchema,
    eventId: idSchema,
    rows: z
      .array(
        z
          .strictObject({
            id: idSchema,
            expectedRevision: timeSchema.nullable(),
            fields: z.record(z.string(), jsonSchema).readonly(),
          })
          .readonly(),
      )
      .readonly(),
    receipt: jsonSchema,
  })
  .readonly();
export const dutySchema = z
  .strictObject({
    id: idSchema,
    employeeId: idSchema,
    assignment: jsonSchema,
    target: idSchema.nullable(),
    probe: idSchema.nullable(),
    acceptance: idSchema.nullable(),
    repairAuthority: jsonSchema,
    cadenceMs: z.number().int().positive().safe().nullable(),
    nextDue: timeSchema.nullable(),
  })
  .readonly();
export const grantSchema = z
  .strictObject({
    id: idSchema,
    authorizationId: idSchema,
    employeeId: idSchema,
    generation: timeSchema,
    target: idSchema,
    authority: jsonSchema,
    state: z.enum(["held", "reconciliation", "released"]),
    verification: jsonSchema,
  })
  .readonly();
export const bindSchema = z
  .strictObject({
    employeeId: idSchema,
    generation: timeSchema,
    nativeHandle: idSchema,
    assignment: idSchema.nullable(),
    source: sourceSchema,
  })
  .readonly();
export const teamRequestSchema = z
  .strictObject({
    eventId: idSchema,
    architect: idSchema,
    qa: idSchema,
    devs: z.array(idSchema).min(1).readonly(),
    cues: z.array(cueSchema).min(3).readonly(),
  })
  .readonly();
export type Scope = z.infer<typeof scopeSchema>;
export type Owner = z.infer<typeof ownerSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type Authority = z.infer<typeof authoritySchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Employee = z.infer<typeof employeeSchema>;
export type Hire = z.infer<typeof hireSchema>;
export type Intake = z.infer<typeof intakeSchema>;
export type Cue = z.infer<typeof cueSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Result = z.infer<typeof resultSchema>;
export type Team = z.infer<typeof teamSchema>;
export type Capture = z.infer<typeof captureSchema>;
export type Duty = z.infer<typeof dutySchema>;
export type Grant = z.infer<typeof grantSchema>;
export type Bind = z.infer<typeof bindSchema>;
export type TeamRequest = z.infer<typeof teamRequestSchema>;
export type QueueRow = z.infer<typeof rowSchema>;

export class StoreConflictError extends Error {}
export class StoreAuthorityError extends Error {}
export class StoreFenceError extends Error {}
export class StoreRecoveryError extends Error {}

export function encode(value: unknown): string {
  const parsed: Json = jsonSchema.parse(value);
  function sorted(entry: Json): Json {
    if (Array.isArray(entry))
      return entry.map((item: Json): Json => sorted(item));
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]): number => a.localeCompare(b))
          .map(([key, item]): [string, Json] => [key, sorted(item)]),
      );
    }
    return entry;
  }
  return JSON.stringify(sorted(parsed));
}
