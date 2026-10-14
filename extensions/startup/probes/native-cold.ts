import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
  claimSchema,
  employeeSchema,
  grantSchema,
  jsonSchema,
  messageSchema,
} from "../src/contracts";
import nativeAdapter from "./native-adapter";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing cold fixture variable ${name}`);
  return value;
}
function record(value: unknown): void {
  appendFileSync(env("STARTUP_ADAPTER_EVENTS"), JSON.stringify(value) + "\n");
}
function rows(kind: string): readonly unknown[] {
  const db = new Database(
    join(env("JP_SKILLS_HOME"), "startup/cold-proof/staff.sqlite"),
    { readonly: true },
  );
  try {
    return z
      .array(z.object({ payload: z.string() }))
      .parse(db.query("SELECT payload FROM records WHERE kind=?").all(kind))
      .map((entry) => JSON.parse(entry.payload));
  } finally {
    db.close();
  }
}
async function wait(
  ctx: ExtensionContext,
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const deadline: number = Date.now() + 30000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Cold fixture timeout: ${label}`);
    await new Promise<void>((resolve) => ctx.setTimeout(resolve, 25));
  }
}
const checkpointSchema = z.object({
  rootFile: z.string(),
  rootSession: z.string(),
  recipientId: z.string(),
  workerId: z.string(),
  workerClaimId: z.string(),
  managerClaimId: z.string(),
  grantId: z.string(),
  target: z.string(),
  health: z.string(),
});
const handleSchema = z.object({ id: z.string(), sessionId: z.string() });
export default function nativeCold(pi: ExtensionAPI): void {
  nativeAdapter(pi);
  pi.on("session_start", (_event, ctx) => {
    const ref = pi.pi.AgentRegistry.global().get(ctx.agent.id);
    record({
      kind: "cold-session-start",
      phase: env("STARTUP_COLD_PHASE"),
      id: ctx.agent.id,
      parent: ctx.agent.parentId,
      sessionId: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(),
      createdAt: ref?.createdAt,
      tools: pi.getAllTools().map((tool) => tool.name),
    });
  });
  pi.registerCommand("startup-cold-proof", {
    description: "Installed native crash and persisted-roster acceptance",
    handler: async (_args, ctx) => {
      try {
        const registry = pi.pi.AgentRegistry.global();
        const root = registry.get(ctx.agent.id);
        if (!root?.session)
          throw new Error("Actual cold fixture root unavailable");
        async function invoke(name: string, params: unknown): Promise<unknown> {
          const tool = root?.session?.getToolByName(name);
          if (!tool) throw new Error(`Missing native tool ${name}`);
          const output = await tool.execute(
            `cold-${name}-${Date.now()}`,
            params,
          );
          record({ kind: "cold-admin", name, params, output });
          if (output.isError)
            throw new Error(
              `Native ${name} rejected: ${JSON.stringify(output)}`,
            );
          return output.details;
        }
        const snapshotRegistry = () =>
          registry
            .list()
            .map((ref) => ({
              id: ref.id,
              kind: ref.kind,
              status: ref.status,
              parentId: ref.parentId,
              createdAt: ref.createdAt,
              sessionFile: ref.sessionFile,
              sessionId: ref.session?.sessionManager.getSessionId() ?? null,
            }));
        const employees = () => z.array(employeeSchema).parse(rows("employee"));
        const messages = () => z.array(messageSchema).parse(rows("message"));
        const claims = () => z.array(claimSchema).parse(rows("claim"));
        const grants = () => z.array(grantSchema).parse(rows("grant"));
        if (env("STARTUP_COLD_PHASE") === "A") {
          for (const requestId of ["cold-recipient", "cold-worker"]) {
            await invoke("task", {
              startup: "hire",
              requestId,
              role: "devops",
              additional: 1,
            });
            await wait(
              ctx,
              () =>
                employees()
                  .filter((entry) => entry.role === "devops")
                  .every((entry) => entry.nativeHandle !== null) &&
                registry.list().filter((ref) => ref.kind === "sub").length >=
                  employees().filter((entry) => entry.role === "devops")
                    .length &&
                registry
                  .list()
                  .filter((ref) => ref.kind === "sub")
                  .every((ref) => ref.status === "idle"),
              "employee bootstrap idle",
            );
          }
          const staff = z.object({ employees: z.array(employeeSchema) }).parse(await invoke("startup_staff", {})).employees.filter((entry) => entry.role === "devops");
          const recipient = staff[0];
          const worker = staff[1];
          if (!recipient?.nativeHandle || !worker?.nativeHandle)
            throw new Error("Two real admitted employees required");
          const recipientHandle = handleSchema.parse(
            JSON.parse(recipient.nativeHandle),
          );
          await AgentLifecycleManager.global().park(recipientHandle.id);
          record({
            kind: "cold-parked",
            registry: snapshotRegistry(),
            recipient,
          });
          const target: string = join(ctx.cwd, "config.json");
          const health: string = join(ctx.cwd, "verification.json");
          writeFileSync(target, '{"enabled":false}\n');
          writeFileSync(health, '{"healthy":false}\n');
          await invoke("startup_duty", {
            id: "cold-duty",
            employeeId: worker.id,
            target,
            probe: health,
            acceptance: { path: ["healthy"], equals: true },
            repairAuthority: {
              kind: "replace-json",
              payload: { enabled: true },
              verification: {
                path: health,
                acceptance: { path: ["healthy"], equals: true },
              },
            },
            cadenceMs: 1000,
            nextDue: Date.now() + 3600000,
          });
          await invoke("startup_repair_authorize", {
            id: "cold-action",
            dutyId: "cold-duty",
          });
          await invoke("startup_send", {
            id: "cold-interrupt",
            recipient: worker.id,
            kind: "assignment",
            correlation: "cold-work",
            payload: { kind: "cold-interrupt" },
          });
          await wait(
            ctx,
            () =>
              grants().some(
                (grant) =>
                  grant.authorizationId === "cold-action" &&
                  grant.state === "reconciliation",
              ),
            "actual failed verification retains grant",
          );
          await wait(
            ctx,
            () =>
              readFileSync(env("STARTUP_ADAPTER_EVENTS"), "utf8").includes(
                '"kind":"cold-provider-held"',
              ),
            "worker held after failed verification",
          );
          await invoke("startup_send", {
            id: "cold-saved-pending",
            recipient: recipient.id,
            kind: "assignment",
            correlation: "later",
            payload: { kind: "cold-later" },
          });
          await invoke("startup_send", {
            id: "cold-manager-active",
            recipient: "manager",
            kind: "assignment",
            correlation: "cold-manager",
            payload: { kind: "cold-manager-hold" },
          });
          await wait(
            ctx,
            () =>
              claims().some(
                (claim) =>
                  claim.messageId === "cold-manager-active" &&
                  claim.status === "active",
              ),
            "actual manager claim",
          );
          await invoke("startup_send", {
            id: "cold-manager-pending",
            recipient: "manager",
            kind: "report",
            correlation: "cold-manager",
            payload: { pending: true },
          });
          const publicStaff = z.object({ recovery: z.object({ claims: z.array(z.object({ id: z.string(), messageId: z.string() })), grants: z.array(z.object({ id: z.string(), authorizationId: z.string() })) }) }).parse(await invoke("startup_staff", {}));
          const workerClaim = publicStaff.recovery.claims.find(
            (claim) => claim.messageId === "cold-interrupt",
          );
          const managerClaim = publicStaff.recovery.claims.find(
            (claim) => claim.messageId === "cold-manager-active",
          );
          const grant = publicStaff.recovery.grants.find(
            (entry) => entry.authorizationId === "cold-action",
          );
          if (
            !workerClaim ||
            !managerClaim ||
            !grant ||
            messages().find((entry) => entry.id === "cold-saved-pending")
              ?.status !== "pending"
          )
            throw new Error("Actual interrupted checkpoint incomplete");
          const checkpoint = {
            rootFile: ctx.sessionManager.getSessionFile(),
            rootSession: ctx.sessionManager.getSessionId(),
            recipientId: recipient.id,
            workerId: worker.id,
            workerClaimId: workerClaim.id,
            managerClaimId: managerClaim.id,
            grantId: grant.id,
            target,
            health,
            registry: snapshotRegistry(),
            employees: employees(),
            claims: claims(),
            messages: messages(),
            grants: grants(),
            staff: await invoke("startup_staff", {}),
            createdAt: root.createdAt,
          };
          checkpointSchema.parse(checkpoint);
          writeFileSync(
            env("STARTUP_COLD_CHECKPOINT"),
            JSON.stringify(checkpoint),
          );
          record({ kind: "cold-ready-to-kill", checkpoint });
        } else {
          const saved = checkpointSchema.parse(
            JSON.parse(readFileSync(env("STARTUP_COLD_CHECKPOINT"), "utf8")),
          );
          record({
            kind: "cold-reopened",
            registry: snapshotRegistry(),
            claims: claims(),
            grants: grants(),
            messages: messages(),
            staff: await invoke("startup_staff", {}),
            rootSession: ctx.sessionManager.getSessionId(),
            rootFile: ctx.sessionManager.getSessionFile(),
            createdAt: root.createdAt,
          });
          pi.sendMessage(
            {
              customType: "cold-recovery",
              content: "Exercise current native recovery guard.",
              display: false,
            },
            { triggerTurn: true, deliverAs: "nextTurn" },
          );
          await wait(
            ctx,
            () =>
              readFileSync(env("STARTUP_ADAPTER_EVENTS"), "utf8").includes(
                '"kind":"tool"',
              ) &&
              readFileSync(env("STARTUP_ADAPTER_EVENTS"), "utf8").includes(
                "Resolve saved manager claims/grants",
              ),
            "native manager recovery denial",
          );
          const recovery = z.object({ recovery: z.object({
            grants: z.array(z.object({ id: z.string(), employeeId: z.string(), state: z.string() })),
            claims: z.array(z.object({ id: z.string(), messageId: z.string(), employeeId: z.string(), status: z.string() })),
            assignments: z.array(z.object({ id: z.string(), employeeId: z.string() })),
            pendingMessages: z.array(z.object({ id: z.string(), recipient: z.string() })),
          }) }).parse(await invoke("startup_staff", {})).recovery;
          record({ kind: "cold-public-recovery", recovery });
          const publicGrant = recovery.grants.find((grant) => grant.employeeId === saved.workerId && grant.state === "reconciliation");
          if (!publicGrant) throw new Error("Public recovery omitted worker repair grant");
          let refused: string | null = null;
          try {
            await invoke("startup_repair_reconcile", {
              grantId: publicGrant.id,
              evidence: { fixture: "still unhealthy" },
            });
          } catch (error: unknown) {
            refused = error instanceof Error ? error.message : String(error);
          }
          if (!refused?.includes("failed assigned acceptance"))
            throw new Error(`Expected fresh verification refusal: ${refused}`);
          record({
            kind: "cold-verification-refused",
            refused,
            grants: grants(),
          });
          writeFileSync(saved.health, '{"healthy":true}\n');
          await invoke("startup_repair_reconcile", {
            grantId: publicGrant.id,
            evidence: { fixture: "operator verified local derived state" },
          });
          const interrupted = recovery.claims.filter((claim) => claim.status === "reconciliation");
          if (!interrupted.some((claim) => claim.employeeId === saved.workerId) || !interrupted.some((claim) => claim.employeeId === "manager"))
            throw new Error("Public recovery omitted interrupted child or manager");
          for (const claimId of interrupted.map((claim) => claim.id))
            await invoke("startup_reconcile", {
              claimId,
              evidence: {
                fixture: "observed interrupted transcript and actual target",
              },
            });
          for (const assignmentId of recovery.assignments.filter((assignment) => interrupted.some((claim) => claim.messageId === assignment.id)).map((assignment) => assignment.id))
            await invoke("startup_resolve", {
              assignmentId,
              evidence: { fixture: "resolved interrupted work" },
            });
          await invoke("startup_bind_manager", {});
          record({
            kind: "cold-dispatch-before",
            registry: snapshotRegistry(),
          });
          await invoke("startup_dispatch", {
            messageIds: recovery.pendingMessages.filter((message) => message.recipient === saved.recipientId).map((message) => message.id),
          });
          await wait(
            ctx,
            () =>
              messages().find((entry) => entry.id === "cold-saved-pending")
                ?.status === "acknowledged",
            "original saved cue settlement after cold revival",
          );
          record({
            kind: "cold-dispatch-after",
            registry: snapshotRegistry(),
            employees: employees(),
            claims: claims(),
            messages: messages(),
            staff: await invoke("startup_staff", {}),
          });
          await invoke("startup_send", {
            id: "cold-stale-check",
            recipient: saved.workerId,
            kind: "assignment",
            correlation: "cold-stale",
            payload: { kind: "cold-stale", oldClaimId: saved.workerClaimId },
          });
          await wait(
            ctx,
            () =>
              messages().find((entry) => entry.id === "cold-stale-check")
                ?.status === "acknowledged",
            "worker stale-claim check and later settlement",
          );
          await wait(
            ctx,
            () =>
              messages().find((entry) => entry.id === "cold-manager-pending")
                ?.status === "acknowledged",
            "retained manager mail",
          );
          const report = {
            status: "COMPLETE",
            registry: snapshotRegistry(),
            employees: employees(),
            claims: claims(),
            messages: messages(),
            grants: grants(),
            target: jsonSchema.parse(
              JSON.parse(readFileSync(saved.target, "utf8")),
            ),
            staff: await invoke("startup_staff", {}),
          };
          writeFileSync(env("STARTUP_ADAPTER_REPORT"), JSON.stringify(report));
        }
      } catch (error: unknown) {
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({
            status: "FAIL",
            error: error instanceof Error ? error.stack : String(error),
          }),
        );
      }
    },
  });
}
