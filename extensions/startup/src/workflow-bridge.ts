import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { WorkflowKind, WorkflowOutcome, WorkflowView } from "./workflow-engine";
import { observeWorkflowBinding, type WorkflowNativeBinding } from "./workflow-bridge-native";

const MAX_FRAME = 1024 * 1024;
const roleAssignmentSchema = z.strictObject({ kind: z.enum(["architect", "dev", "qa"]), worktree: z.string().refine(isAbsolute) });
const roleProofSchema = z.strictObject({ role: z.enum(["architect", "dev", "qa"]), itemId: z.string().min(1), verdict: z.literal("pass"), worktree: z.string().refine(isAbsolute), agentId: z.string().min(1), head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), evidence: z.record(z.string().min(1), z.string().min(1)) });
const runHandoffSchema = z.strictObject({
  items: z.array(z.strictObject({ itemId: z.string().trim().min(1), worktree: z.string().refine(isAbsolute), head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), prNumber: z.number().int().positive().safe() })).min(1),
}).refine((handoff) => new Set(handoff.items.map((item) => item.itemId)).size === handoff.items.length, "Handoff item IDs must be unique");
const workflowPlanSchema = z.strictObject({ dependencies: z.record(z.string().min(1), z.array(z.string().min(1))), targets: z.record(z.string().min(1), z.array(z.string().min(1))) });
const readyItemSchema = z.strictObject({ itemId: z.string().min(1), worktree: z.string().refine(isAbsolute), head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), prNumber: z.number().int().positive().safe() });
const plannerReceiptSchema = z.strictObject({ scopeId: z.string().min(1), reservationId: z.string().uuid(), launchId: z.string().uuid(), nativeJobId: z.string().min(1), nativeAgentId: z.string().min(1), status: z.enum(["completed", "failed"]), plan: workflowPlanSchema.optional() });
const requestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("view") }),
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("reserve") }),
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("submit"), evidence: z.unknown() }),
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("reserve-assignment"), itemId: z.string().min(1), assignmentKey: z.string().min(1), role: roleAssignmentSchema.optional() }),
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("submit-assignment"), reservationId: z.string().uuid(), evidence: z.unknown() }),
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("reserve-plan") }),
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("submit-plan"), reservationId: z.string().uuid(), evidence: z.unknown() }),
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("ready-item"), item: readyItemSchema }),
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("finish-run"), handoff: runHandoffSchema }),
  z.strictObject({ id: z.string().uuid(), token: z.string(), operation: z.literal("nest"), workflow: z.enum(["factory", "pipeline", "hotfix"]), itemIds: z.array(z.string().min(1)).min(1), limit: z.number().int(), target: z.string().min(1).refine((value) => !value.includes("\0")).optional() }),
]);
const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ id: z.string().uuid(), ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ id: z.string().uuid(), ok: z.literal(false), error: z.string() }),
]);
const nestedSchema = z.strictObject({ scopeId: z.string().min(1), token: z.string().min(1) });
const runReservationSchema = z.strictObject({ reservationId: z.string().uuid(), launchId: z.string().uuid() });
const reservationSchema = z.string().min(1);
const outcomeSchema = z.enum(["completed", "failed", "uncertain"]);
const assignmentOutcomeSchema = z.enum(["completed", "completed_without_role", "failed", "uncertain"]);
const boundReceiptSchema = z.strictObject({ scopeId: z.string().min(1), itemId: z.string().min(1), assignmentKey: z.string().min(1), reservationId: z.string().uuid(), launchId: z.string().uuid(), nativeJobId: z.string().min(1), status: z.enum(["completed", "failed"]), roleProof: roleProofSchema.optional(), roleEvidence: z.literal("invalid").optional() });
const manifestSchema = z.strictObject({ socket: z.string().min(1), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), scopeId: z.string().min(1) });
type Workflow = Exclude<WorkflowKind, "startup">;
type Operation = { operation: "view" } | { operation: "reserve" } | { operation: "submit"; evidence: unknown } | { operation: "reserve-assignment"; itemId: string; assignmentKey: string; role?: WorkflowRoleAssignment } | { operation: "submit-assignment"; reservationId: string; evidence: unknown } | { operation: "reserve-plan" } | { operation: "submit-plan"; reservationId: string; evidence: unknown } | { operation: "ready-item"; item: WorkflowReadyItem } | { operation: "finish-run"; handoff: WorkflowRunHandoff } | { operation: "nest"; workflow: Workflow; itemIds: readonly string[]; limit: number; target?: string };
type Controller = { kind: "controller"; scopeId: string };
type Assignment = { kind: "assignment"; scopeId: string; itemId: string; assignmentKey: string; launchId: string; role?: WorkflowRoleAssignment; connection: Socket | null; reservationId: string | null; terminal: boolean; verifying: boolean };
type RunGroup = { rootScopeId: string; assignments: Set<Assignment>; planner: { reservationId: string; launchId: string; socket: Socket; terminal: boolean; verifying: boolean; outcome: "completed" | "failed" | "uncertain" | null } | null; sockets: Set<Socket>; active: number; finishing: boolean; finished: boolean };
type Run = { kind: "run"; scopeId: string; connection: Socket | null; binding: WorkflowNativeBinding; assignments: Map<string, Assignment>; group: RunGroup };
type Capability = Controller | Assignment | Run;
export type WorkflowReceiptVerifier = (input: Readonly<{ scopeId: string; itemId: string; assignmentKey: string; reservationId: string; launchId: string; evidence: unknown }>) => Promise<"completed" | "failed" | null>;
export type WorkflowRoleAssignment = z.infer<typeof roleAssignmentSchema>;
export type WorkflowRoleProof = z.infer<typeof roleProofSchema>;
export type WorkflowRoleValidation = Readonly<{ scopeId: string; itemId: string; assignmentKey: string; reservationId: string; launchId: string; nativeJobId: string; proof: WorkflowRoleProof }>;
export type WorkflowRunHandoff = z.infer<typeof runHandoffSchema>;
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
export type WorkflowReadyItem = z.infer<typeof readyItemSchema>;
export type WorkflowPlanValidation = Readonly<{ scopeId: string; reservationId: string; launchId: string; nativeJobId: string; nativeAgentId: string; plan: WorkflowPlan }>;

/** Canonical authority must fence each call and commit reservation transitions atomically. */
export type WorkflowBridgeAuthority = {
  readonly rootId: string;
  view(scopeId: string): WorkflowView;
  nest(parentId: string, workflow: Workflow, itemIds: readonly string[], limit: number): string;
  reserve(scopeId: string, itemId: string, assignmentKey: string, role?: WorkflowRoleAssignment): string;
  settle(scopeId: string, reservationId: string, outcome: WorkflowOutcome): void;
  settleRole?(scopeId: string, reservationId: string, receipt: { itemId: string; role: WorkflowRoleAssignment["kind"]; agentId: string; head: string; evidence: Record<string, string> }): void;
  settleRoleWithoutProof?(scopeId: string, reservationId: string, role: { itemId: string; role: WorkflowRoleAssignment["kind"] }): void;
  reservePlan?(scopeId: string): string;
  settlePlan?(scopeId: string, reservationId: string, outcome: "failed" | "uncertain"): void;
  completePlan?(scopeId: string, reservationId: string, plan: WorkflowPlan): void;
  readyItem?(scopeId: string, itemId: string, evidence: Omit<WorkflowReadyItem, "itemId">): void;
  finishRun?(scopeId: string, handoff: WorkflowRunHandoff): void;
};

export type WorkflowBridge = {
  socket: string; ownerToken: string;
  assign(input: { scopeId: string; itemId: string; assignmentKey: string; launchId: string }): string;
  issueRun(input: { scopeId: string; binding: WorkflowNativeBinding }): string;
  writeRunManifest(input: { scopeId: string; binding: WorkflowNativeBinding }): string;
  prepareRunManifest(input: { scopeId: string }): { path: string; publish(binding: WorkflowNativeBinding): void };
  close(): Promise<void>;
};

export type WorkflowBridgeOptions = (
  | { acceptBoundHostReceipts: true; verifyTerminal?: never }
  | { acceptBoundHostReceipts?: false; verifyTerminal: WorkflowReceiptVerifier }
) & {
  validateRoleAssignment?: (input: Readonly<{ scopeId: string; itemId: string; assignmentKey: string; role: WorkflowRoleAssignment }>) => Promise<boolean>;
  validateRole?: (input: WorkflowRoleValidation) => Promise<boolean>;
  validateFinish?: (scopeId: string, handoff: WorkflowRunHandoff) => Promise<boolean>;
  validatePlan?: (input: WorkflowPlanValidation) => Promise<boolean>;
  validateReady?: (scopeId: string, item: WorkflowReadyItem) => Promise<boolean>;
  nestScope?: (parentId: string, workflow: Workflow, itemIds: readonly string[], limit: number, target?: string) => string;
};

/** A custom verifier must independently observe a native receipt; evidence is untrusted. */
export async function startWorkflowBridge(host: WorkflowBridgeAuthority, options: WorkflowBridgeOptions): Promise<WorkflowBridge> {
  if (process.platform === "win32") throw new Error("Workflow bridge requires Unix domain sockets");
  const directory = mkdtempSync(join(tmpdir(), "workflow-bridge-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "s");
  const capabilities = new Map<string, Capability>();
  const launchIds = new Set<string>();
  const grant = (capability: Capability): string => {
    const token = randomBytes(32).toString("base64url");
    capabilities.set(token, capability);
    return token;
  };
  const ownerToken = grant({ kind: "controller", scopeId: host.rootId });
  const sockets = new Map<Socket, () => void>();
  function uncertain(assignment: Assignment): void {
    if (assignment.terminal || assignment.reservationId === null) return;
    assignment.terminal = true;
    host.settle(assignment.scopeId, assignment.reservationId, "uncertain");
  }
  const server = createServer((socket) => {
    const groups = new Set<RunGroup>();
    sockets.set(socket, cleanupSocket);
    const assignments = new Set<Assignment>();
    let buffer = "";
    let serial = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        serial = serial.then(async () => {
          if (socket.destroyed) return;
          let raw: unknown;
          try { raw = JSON.parse(line); } catch { socket.destroy(); return; }
          const parsed = requestSchema.safeParse(raw);
          if (!parsed.success) { socket.destroy(); return; }
          const request = parsed.data;
          const capability = capabilities.get(request.token);
          if (!capability || (capability.kind !== "controller" && capability.connection !== null && capability.connection !== socket)) {
            socket.write(JSON.stringify({ id: request.id, ok: false, error: "Unauthorized" }) + "\n"); return;
          }
          const group = capability.kind === "run" ? capability.group : null;
          if (group && (group.finishing || group.finished)) {
            socket.write(JSON.stringify({ id: request.id, ok: false, error: "Run is closing" }) + "\n"); return;
          }
          if (group) group.active += 1;
          try {
          if (capability.kind !== "controller" && capability.connection === null) {
            capability.connection = socket;
            if (group) { group.sockets.add(socket); groups.add(group); }
            if (capability.kind === "assignment") assignments.add(capability);
            else if (!await observeWorkflowBinding(capability.binding) || socket.destroyed) {
              socket.destroy();
              return;
            }
          }
          try {
            let result: unknown;
            switch (request.operation) {
              case "view": {
                if (capability.kind === "assignment") throw new Error("Unauthorized operation");
                result = host.view(capability.scopeId);
                break;
              }
              case "nest": {
                if (capability.kind === "assignment") throw new Error("Unauthorized operation");
                if (request.target !== undefined && !options.nestScope) throw new Error("Nested target is not authorized");
                const scopeId = options.nestScope ? options.nestScope(capability.scopeId, request.workflow, request.itemIds, request.limit, request.target) : host.nest(capability.scopeId, request.workflow, request.itemIds, request.limit);
                result = { scopeId, token: capability.kind === "run" ? grant({ kind: "run", scopeId, connection: null, binding: capability.binding, assignments: new Map(), group: capability.group }) : grant({ kind: "controller", scopeId }) };
                break;
              }
              case "reserve": {
                if (capability.kind !== "assignment") throw new Error("Unauthorized operation");
                if (capability.reservationId !== null || capability.terminal) throw new Error("Assignment already reserved");
                const view = host.view(capability.scopeId);
                if (view.graphFrozen === false || (view.workflow === "factory" && view.graphFrozen !== true)) throw new Error("Planner graph is not frozen");
                const reservation = host.reserve(capability.scopeId, capability.itemId, capability.assignmentKey);
                capability.reservationId = reservation;
                result = reservation;
                break;
              }
              case "reserve-assignment": {
                if (capability.kind !== "run") throw new Error("Unauthorized operation");
                if (request.role && (!options.validateRoleAssignment || !await options.validateRoleAssignment({ scopeId: capability.scopeId, itemId: request.itemId, assignmentKey: request.assignmentKey, role: request.role }))) throw new Error("Role assignment is not authorized");
                if (socket.destroyed) return;
                const view = host.view(capability.scopeId);
                if (view.graphFrozen === false || (view.workflow === "factory" && view.graphFrozen !== true)) throw new Error("Planner graph is not frozen");
                const launchId = randomUUID();
                const reservationId = host.reserve(capability.scopeId, request.itemId, request.assignmentKey, request.role);
                const assignment: Assignment = { kind: "assignment", scopeId: capability.scopeId, itemId: request.itemId, assignmentKey: request.assignmentKey, launchId, ...(request.role ? { role: request.role } : {}), connection: socket, reservationId, terminal: false, verifying: false };
                capability.assignments.set(reservationId, assignment);
                capability.group.assignments.add(assignment);
                assignments.add(assignment);
                result = { reservationId, launchId };
                break;
              }
              case "submit-assignment": {
                if (capability.kind !== "run") throw new Error("Unauthorized operation");
                const assignment = capability.assignments.get(request.reservationId);
                if (!assignment || assignment.reservationId === null || assignment.terminal || assignment.verifying) throw new Error("No active assignment reservation");
                assignment.verifying = true;
                let verdict: "completed" | "failed" | null = null;
                let roleProof: WorkflowRoleProof | undefined;
                let withoutRole = false;
                try {
                  const receipt = boundReceiptSchema.safeParse(request.evidence);
                  const correlated = receipt.success && receipt.data.scopeId === assignment.scopeId && receipt.data.itemId === assignment.itemId && receipt.data.assignmentKey === assignment.assignmentKey && receipt.data.reservationId === assignment.reservationId && receipt.data.launchId === assignment.launchId;
                  if (options.acceptBoundHostReceipts === true) {
                    if (receipt.success && correlated && await observeWorkflowBinding(capability.binding)) verdict = receipt.data.status;
                  } else {
                    verdict = await options.verifyTerminal({ scopeId: assignment.scopeId, itemId: assignment.itemId, assignmentKey: assignment.assignmentKey, reservationId: assignment.reservationId, launchId: assignment.launchId, evidence: request.evidence });
                  }
                  const hasMarker = typeof request.evidence === "object" && request.evidence !== null && "roleEvidence" in request.evidence;
                  if (hasMarker) {
                    if (!receipt.success || !correlated || receipt.data.roleEvidence !== "invalid" || receipt.data.roleProof !== undefined || receipt.data.status !== "completed" || verdict !== "completed" || !assignment.role || !host.settleRoleWithoutProof) verdict = null;
                    else if (!await observeWorkflowBinding(capability.binding)) verdict = null;
                    else withoutRole = true;
                  } else if (!socket.destroyed && !assignment.terminal && verdict === "completed" && assignment.role) {
                    const proof = receipt.success && correlated ? receipt.data.roleProof : undefined;
                    if (!receipt.success || receipt.data.status !== "completed" || !proof || proof.itemId !== assignment.itemId || proof.role !== assignment.role.kind || proof.worktree !== assignment.role.worktree || !host.settleRole || !options.validateRole || !await options.validateRole({ scopeId: assignment.scopeId, itemId: assignment.itemId, assignmentKey: assignment.assignmentKey, reservationId: assignment.reservationId, launchId: assignment.launchId, nativeJobId: receipt.data.nativeJobId, proof })) verdict = null;
                    else roleProof = proof;
                  }
                } catch { verdict = null; }
                if (socket.destroyed || assignment.terminal) return;
                if (verdict !== "completed" && verdict !== "failed") {
                  uncertain(assignment);
                  result = "uncertain";
                } else if (withoutRole && assignment.role && host.settleRoleWithoutProof) {
                  try {
                    host.settleRoleWithoutProof(assignment.scopeId, assignment.reservationId, { itemId: assignment.itemId, role: assignment.role.kind });
                    assignment.terminal = true;
                    result = "completed_without_role";
                  } catch {
                    uncertain(assignment);
                    result = "uncertain";
                  }
                } else if (roleProof && host.settleRole) {
                  try {
                    host.settleRole(assignment.scopeId, assignment.reservationId, { itemId: assignment.itemId, role: roleProof.role, agentId: roleProof.agentId, head: roleProof.head, evidence: roleProof.evidence });
                    assignment.terminal = true;
                    result = "completed";
                  } catch {
                    uncertain(assignment);
                    result = "uncertain";
                  }
                } else {
                  host.settle(assignment.scopeId, assignment.reservationId, verdict);
                  assignment.terminal = true;
                  result = verdict;
                }
                break;
              }
              case "submit": {
                if (capability.kind !== "assignment") throw new Error("Unauthorized operation");
                if (capability.reservationId === null || capability.terminal || capability.verifying) throw new Error("No active assignment reservation");
                capability.verifying = true;
                let verdict: "completed" | "failed" | null = null;
                try {
                  if (options.acceptBoundHostReceipts !== true) verdict = await options.verifyTerminal({ scopeId: capability.scopeId, itemId: capability.itemId, assignmentKey: capability.assignmentKey, reservationId: capability.reservationId, launchId: capability.launchId, evidence: request.evidence });
                } catch { /* a failed verifier cannot establish a terminal receipt */ }
                if (socket.destroyed || capability.terminal) return;
                if (verdict !== "completed" && verdict !== "failed") {
                  uncertain(capability);
                  result = "uncertain";
                } else {
                  host.settle(capability.scopeId, capability.reservationId, verdict);
                  capability.terminal = true;
                  result = verdict;
                }
                break;
              }
              case "reserve-plan": {
                if (capability.kind !== "run" || capability.scopeId !== capability.group.rootScopeId) throw new Error("Only the root run can plan");
                if (!host.reservePlan || !host.settlePlan || !host.completePlan || !options.validatePlan) throw new Error("Planner authority is unavailable");
                if (capability.group.planner) throw new Error("Planner already attempted; reconcile before retrying");
                const reservationId = host.reservePlan(capability.scopeId);
                const launchId = randomUUID();
                capability.group.planner = { reservationId, launchId, socket, terminal: false, verifying: false, outcome: null };
                result = { reservationId, launchId };
                break;
              }
              case "submit-plan": {
                if (capability.kind !== "run" || capability.scopeId !== capability.group.rootScopeId) throw new Error("Only the root run can submit a plan");
                const planner = capability.group.planner;
                if (!planner || planner.socket !== socket || planner.reservationId !== request.reservationId || planner.terminal || planner.verifying || !host.settlePlan || !host.completePlan) throw new Error("No active planner reservation");
                planner.verifying = true;
                let outcome: "completed" | "failed" | "uncertain" = "uncertain";
                const parsed = plannerReceiptSchema.safeParse(request.evidence);
                try {
                  if (parsed.success && parsed.data.scopeId === capability.scopeId && parsed.data.reservationId === planner.reservationId && parsed.data.launchId === planner.launchId && await observeWorkflowBinding(capability.binding)) {
                    if (parsed.data.status === "failed") outcome = "failed";
                    else if (parsed.data.plan && options.validatePlan && await options.validatePlan({ scopeId: capability.scopeId, reservationId: planner.reservationId, launchId: planner.launchId, nativeJobId: parsed.data.nativeJobId, nativeAgentId: parsed.data.nativeAgentId, plan: parsed.data.plan })) outcome = "completed";
                  }
                } catch { outcome = "uncertain"; }
                if (outcome === "completed" && !await observeWorkflowBinding(capability.binding)) outcome = "uncertain";
                if (socket.destroyed || planner.terminal) return;
                try {
                  if (outcome === "completed" && parsed.success && parsed.data.plan) host.completePlan(capability.scopeId, planner.reservationId, parsed.data.plan);
                  else host.settlePlan(capability.scopeId, planner.reservationId, outcome === "failed" ? "failed" : "uncertain");
                } catch {
                  outcome = "uncertain";
                  host.settlePlan(capability.scopeId, planner.reservationId, "uncertain");
                }
                planner.terminal = true;
                planner.outcome = outcome;
                result = outcome;
                break;
              }
              case "ready-item": {
                if (capability.kind !== "run" || capability.scopeId !== capability.group.rootScopeId) throw new Error("Only the root run can mark readiness");
                if (!host.readyItem || !options.validateReady) throw new Error("Readiness verification is unavailable");
                const scope = host.view(capability.scopeId).scope;
                if (scope.kind !== "bounded" || !scope.itemIds.includes(request.item.itemId)) throw new Error("Readiness item is outside the frozen scope");
                if (!await observeWorkflowBinding(capability.binding) || !await options.validateReady(capability.scopeId, request.item) || socket.destroyed || !await observeWorkflowBinding(capability.binding) || socket.destroyed) throw new Error("Readiness evidence is not verified");
                host.readyItem(capability.scopeId, request.item.itemId, { worktree: request.item.worktree, head: request.item.head, prNumber: request.item.prNumber });
                result = { ready: true };
                break;
              }
              case "finish-run": {
                if (capability.kind !== "run" || capability.scopeId !== capability.group.rootScopeId) throw new Error("Only the root run can hand off");
                const current = capability.group;
                if (!host.finishRun) throw new Error("Run handoff is unavailable");
                if (current.active !== 1 || current.sockets.size !== 1 || current.assignments.size === 0) throw new Error("Run has active connections or no child assignments");
                if (current.planner && current.planner.outcome !== "completed") throw new Error("Run planner is active, failed or uncertain");
                current.finishing = true;
                try {
                  if (!await observeWorkflowBinding(capability.binding) || socket.destroyed) throw new Error("Run binding is unavailable");
                  for (const assignment of current.assignments) {
                    const state = host.view(assignment.scopeId).reservations.find((entry) => entry.id === assignment.reservationId)?.state;
                    if (!assignment.terminal || (state !== "completed" && state !== "failed")) throw new Error("Run has active or uncertain assignments");
                  }
                  const scope = host.view(current.rootScopeId).scope;
                  const handoffIds = new Set(request.handoff.items.map((item) => item.itemId));
                  if (scope.kind !== "bounded" || handoffIds.size !== scope.itemIds.length || scope.itemIds.some((itemId) => !handoffIds.has(itemId))) throw new Error("Handoff must cover the frozen scope exactly");
                  if (!options.validateFinish) throw new Error("Run handoff verification is unavailable");
                  current.finished = true;
                  for (const [token, value] of capabilities) if (value.kind === "run" && value.group === current) capabilities.delete(token);
                  if (!await options.validateFinish(current.rootScopeId, request.handoff)) throw new Error("Run handoff evidence is not verified");
                  if (socket.destroyed || !await observeWorkflowBinding(capability.binding) || socket.destroyed) throw new Error("Run binding is unavailable");
                  host.finishRun(current.rootScopeId, request.handoff);
                  result = { handedOff: true };
                } finally { current.finishing = false; }
                break;
              }
            }
            socket.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
          } catch (error: unknown) {
            socket.write(JSON.stringify({ id: request.id, ok: false, error: error instanceof Error ? error.message : "Workflow operation failed" }) + "\n");
          }
          } finally { if (group) group.active -= 1; }
        }).catch(() => { socket.destroy(); });
      }
    });
    socket.on("error", () => {});
    function cleanupSocket(): void {
      if (!sockets.delete(socket)) return;
      for (const group of groups) {
        group.sockets.delete(socket);
        const planner = group.planner;
        if (planner && planner.socket === socket && !planner.terminal) {
          planner.terminal = true;
          planner.outcome = "uncertain";
          try { host.settlePlan?.(group.rootScopeId, planner.reservationId, "uncertain"); } catch { /* leave the canonical reservation active for reconciliation */ }
        }
      }
      for (const assignment of assignments) {
        try { uncertain(assignment); } catch { /* owner may already have settled the reservation */ }
      }
    }
    socket.on("close", cleanupSocket);
  });
  try {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(path, () => { server.removeListener("error", listening.reject); listening.resolve(); });
    await listening.promise;
    chmodSync(path, 0o600);
  } catch (error) {
    server.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let closing: Promise<void> | undefined;
  function prepareRunManifest({ scopeId }: { scopeId: string }): { path: string; publish(binding: WorkflowNativeBinding): void } {
    if (closing) throw new Error("Workflow bridge is closed");
    host.view(scopeId);
    const manifestPath = join(directory, `run-${randomBytes(16).toString("hex")}.json`);
    let attempted = false;
    return { path: manifestPath, publish: (binding) => {
      if (attempted || closing) throw new Error("Workflow manifest cannot be published");
      attempted = true;
      const group: RunGroup = { rootScopeId: scopeId, assignments: new Set(), planner: null, sockets: new Set(), active: 0, finishing: false, finished: false };
      const token = grant({ kind: "run", scopeId, connection: null, binding, assignments: new Map(), group });
      const temporary = `${manifestPath}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ socket: path, token, scopeId }), { mode: 0o600, flag: "wx" });
        linkSync(temporary, manifestPath);
      } catch (error) { capabilities.delete(token); throw error; }
      finally { rmSync(temporary, { force: true }); }
    } };
  }
  return {
    socket: path, ownerToken,
    assign: ({ scopeId, itemId, assignmentKey, launchId }) => {
      if (closing) throw new Error("Workflow bridge is closed");
      const view = host.view(scopeId);
      if (view.scope.kind !== "bounded" || !view.scope.itemIds.includes(itemId) || !assignmentKey.trim() || !launchId.trim() || launchIds.has(launchId)) throw new Error("Invalid or reused assignment");
      launchIds.add(launchId);
      return grant({ kind: "assignment", scopeId, itemId, assignmentKey, launchId, connection: null, reservationId: null, terminal: false, verifying: false });
    },
    issueRun: ({ scopeId, binding }) => {
      if (closing) throw new Error("Workflow bridge is closed");
      host.view(scopeId);
      const group: RunGroup = { rootScopeId: scopeId, assignments: new Set(), planner: null, sockets: new Set(), active: 0, finishing: false, finished: false };
      return grant({ kind: "run", scopeId, connection: null, binding, assignments: new Map(), group });
    },
    prepareRunManifest,
    writeRunManifest: ({ scopeId, binding }) => {
      const prepared = prepareRunManifest({ scopeId });
      prepared.publish(binding);
      return prepared.path;
    },
    close: () => {
      if (closing) return closing;
      capabilities.clear();
      const stopped = Promise.withResolvers<void>();
      closing = stopped.promise;
      for (const [socket, cleanupSocket] of sockets) {
        socket.destroy();
        cleanupSocket();
      }
      server.close((error) => {
        try { rmSync(directory, { recursive: true, force: true }); } catch (cleanupError) { stopped.reject(cleanupError); return; }
        if (error) stopped.reject(error); else stopped.resolve();
      });
      return closing;
    },
  };
}

/** Read and consume an owner-only manifest; the bearer must not be returned to model tools. */
export function readRunManifest(path: string): { socket: string; token: string; scopeId: string } {
  if (!isAbsolute(path)) throw new Error("Workflow manifest path must be absolute");
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) throw new Error("Workflow manifest directory is not private");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.() || file.size > 4096) throw new Error("Workflow manifest is not private");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    if (!isAbsolute(manifest.socket) || dirname(manifest.socket) !== dirname(path)) throw new Error("Workflow manifest socket is outside its private directory");
    const current = lstatSync(path);
    if (current.isSymbolicLink() || current.dev !== file.dev || current.ino !== file.ino) throw new Error("Workflow manifest changed during attachment");
    unlinkSync(path);
    return manifest;
  } finally { closeSync(fd); }
}

export type WorkflowBridgeClient = {
  view(): Promise<unknown>;
  nest(workflow: Workflow, itemIds: readonly string[], limit: number, target?: string): Promise<{ scopeId: string; token: string }>;
  reserve(): Promise<string>;
  submit(evidence: unknown): Promise<"completed" | "failed" | "uncertain">;
  reserveAssignment(input: { itemId: string; assignmentKey: string; role?: WorkflowRoleAssignment }): Promise<{ reservationId: string; launchId: string }>;
  submitAssignment(input: { reservationId: string; evidence: unknown }): Promise<"completed" | "completed_without_role" | "failed" | "uncertain">;
  reservePlan(): Promise<{ reservationId: string; launchId: string }>;
  submitPlan(input: { reservationId: string; evidence: unknown }): Promise<"completed" | "failed" | "uncertain">;
  readyItem(item: WorkflowReadyItem): Promise<void>;
  finishRun(handoff: WorkflowRunHandoff): Promise<void>;
  close(): Promise<void>;
};

/** Tokens are bearer capabilities, not proof of native identity or a terminal receipt. */
export async function connectWorkflowBridge(input: { socket: string; token: string }): Promise<WorkflowBridgeClient> {
  const socket = createConnection(input.socket);
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let buffer = "";
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    failure ??= error;
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
  };
  socket.setEncoding("utf8");
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Workflow bridge connection closed; any in-flight operation is uncertain")));
  socket.on("data", (data: string) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > MAX_FRAME) { fail(new Error("Workflow bridge response too large")); socket.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { fail(new Error("Invalid workflow bridge response")); socket.destroy(); return; }
      const response = responseSchema.safeParse(raw);
      if (!response.success) { fail(new Error("Invalid workflow bridge response")); socket.destroy(); return; }
      const call = pending.get(response.data.id);
      if (!call) { fail(new Error("Unexpected workflow bridge response")); socket.destroy(); return; }
      pending.delete(response.data.id);
      if (response.data.ok) call.resolve(response.data.result); else call.reject(new Error(response.data.error));
    }
  });
  const connected = Promise.withResolvers<void>();
  socket.once("connect", connected.resolve);
  socket.once("error", connected.reject);
  await connected.promise;
  const call = (operation: Operation): Promise<unknown> => {
    if (failure || socket.destroyed) return Promise.reject(failure ?? new Error("Workflow bridge connection closed"));
    const id = randomUUID();
    const response = Promise.withResolvers<unknown>();
    pending.set(id, response);
    socket.write(JSON.stringify({ id, token: input.token, ...operation }) + "\n");
    return response.promise;
  };
  return {
    view: () => call({ operation: "view" }),
    nest: async (workflow, itemIds, limit, target) => nestedSchema.parse(await call({ operation: "nest", workflow, itemIds, limit, ...(target === undefined ? {} : { target }) })),
    reserve: async () => reservationSchema.parse(await call({ operation: "reserve" })),
    submit: async (evidence) => outcomeSchema.parse(await call({ operation: "submit", evidence })),
    reserveAssignment: async ({ itemId, assignmentKey, role }) => runReservationSchema.parse(await call({ operation: "reserve-assignment", itemId, assignmentKey, ...(role ? { role } : {}) })),
    submitAssignment: async ({ reservationId, evidence }) => assignmentOutcomeSchema.parse(await call({ operation: "submit-assignment", reservationId, evidence })),
    reservePlan: async () => runReservationSchema.parse(await call({ operation: "reserve-plan" })),
    submitPlan: async ({ reservationId, evidence }) => outcomeSchema.parse(await call({ operation: "submit-plan", reservationId, evidence })),
    readyItem: async (item) => { z.strictObject({ ready: z.literal(true) }).parse(await call({ operation: "ready-item", item })); },
    finishRun: async (handoff) => { z.strictObject({ handedOff: z.literal(true) }).parse(await call({ operation: "finish-run", handoff })); },
    close: () => {
      if (socket.destroyed) return Promise.resolve();
      const closed = Promise.withResolvers<void>();
      socket.once("close", closed.resolve);
      socket.destroy();
      return closed.promise;
    },
  };
}
