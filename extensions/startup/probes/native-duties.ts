import { appendFileSync, writeFileSync, readFileSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import nativeAdapter from "./native-adapter";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing duty fixture variable ${name}`);
  return value;
}
export default function nativeDuties(pi: ExtensionAPI): void {
  nativeAdapter(pi);
  pi.registerCommand("startup-native-read-proof", {
    description: "Isolated native raw read boundary proof",
    handler: async (_args, ctx) => {
      try {
        const root = pi.pi.AgentRegistry.global().get(ctx.agent.id);
        const read = root?.session?.getToolByName("read");
        if (!read) throw new Error("Actual native root read unavailable");
        const path = `${ctx.cwd}/health.json`;
        writeFileSync(path, '{"healthy":true}\n');
        const results = [];
        for (let index = 0; index < 5; index += 1) {
          await new Promise<void>((resolve) => ctx.setTimeout(resolve, 10));
          results.push(
            await read.execute(`raw-${index}`, { path: `${path}:raw` }),
          );
        }
        appendFileSync(
          env("STARTUP_ADAPTER_EVENTS"),
          JSON.stringify({ kind: "raw-results", results }) + "\n",
        );
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({
            status: "COMPLETE",
            results,
            rootFile: root?.sessionFile,
          }),
        );
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
  pi.registerCommand("startup-monitor-proof", {
    description: "Isolated product scheduler and repair acceptance",
    handler: async (_args, ctx) => {
      try {
        const registry = pi.pi.AgentRegistry.global();
        const root = registry.get(ctx.agent.id);
        if (!root?.session) throw new Error("Native root missing");
        async function invoke(name: string, params: Record<string, unknown>) {
          const tool = root?.session?.getToolByName(name);
          if (!tool) throw new Error(`Missing product tool ${name}`);
          const output = await tool.execute(
            `duty-${name}-${Date.now()}`,
            params,
          );
          if (output.isError)
            throw new Error(
              `Product tool ${name} failed: ${JSON.stringify(output)}`,
            );
          return output.details;
        }
        async function status() {
          return await invoke("startup_duties", {});
        }
        async function waitFor(
          predicate: () => Promise<boolean>,
          label: string,
        ): Promise<void> {
          const deadline = Date.now() + 15000;
          while (!(await predicate())) {
            if (Date.now() > deadline)
              throw new Error(`Duty fixture timed out: ${label}`);
            await new Promise<void>((resolve) => ctx.setTimeout(resolve, 20));
          }
        }
        const events = () =>
          readFileSync(env("STARTUP_ADAPTER_EVENTS"), "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line));
        const providers = () =>
          events().filter((event) => event.kind === "provider").length;
        const target = `${ctx.cwd}/config.json`;
        const health = `${ctx.cwd}/health.json`;
        const resumed = process.env.STARTUP_DUTY_RESUMED === "1";
        let employee;
        const snapshots = [];
        if (!resumed) {
          writeFileSync(target, '{"enabled":true}\n');
          writeFileSync(health, '{"healthy":true}\n');
          const hired = await invoke("task", {
            startup: "hire",
            requestId: "duty-staff",
            role: "devops",
            additional: 1,
          });
          employee = hired.employees[0];
          await waitFor(
            async () =>
              registry
                .list()
                .some((ref) => ref.kind === "sub" && ref.status === "idle"),
            "initial employee idle",
          );
          await invoke("startup_duty", {
            id: "health",
            employeeId: employee.id,
            target,
            probe: health,
            acceptance: { path: ["healthy"], equals: true },
            repairAuthority: {
              kind: "replace-json",
              payload: { enabled: true },
              verification: {
                path: target,
                acceptance: { path: ["enabled"], equals: true },
              },
            },
            cadenceMs: 100,
            nextDue: Date.now(),
          });
          await waitFor(
            async () => (await status()).duties[0].lastObservation !== null,
            "first quiet observation",
          );
          const before = providers();
          const quietStart = await status();
          await new Promise<void>((resolve) => ctx.setTimeout(resolve, 450));
          const quietEnd = await status();
          if (providers() !== before)
            throw new Error("Healthy polls caused model wakes");
          if (
            quietEnd.duties[0].lastObservation.id ===
            quietStart.duties[0].lastObservation.id
          )
            throw new Error("Healthy polls did not advance");
          snapshots.push({
            kind: "quiet",
            providersBefore: before,
            providersAfter: providers(),
            start: quietStart,
            end: quietEnd,
          });
          writeFileSync(target, '{"enabled":false}\n');
          writeFileSync(health, '{"healthy":false}\n');
          await waitFor(
            async () =>
              events().some(
                (event) =>
                  event.kind === "tool" &&
                  event.name === "startup_settle" &&
                  !event.error &&
                  JSON.stringify(event.details).includes("duty-observation-"),
              ),
            "actual employee observation settlement",
          );
          snapshots.push({
            kind: "transition",
            status: await status(),
            providerCount: providers(),
          });
          await invoke("startup_repair_authorize", {
            id: "repair-once",
            dutyId: "health",
          });
          const currentStaff = await invoke("startup_staff", {});
          employee = currentStaff.employees.find(
            (entry) => entry.id === employee.id,
          );
          const handle = JSON.parse(employee.nativeHandle);
          const child = registry.get(handle.id);
          const repair = child?.session?.getToolByName("startup_repair");
          if (!repair)
            throw new Error("Actual bound employee repair tool unavailable");
          const repaired = await repair.execute("duty-repair", {
            authorizationId: "repair-once",
          });
          if (repaired.isError || repaired.details.state !== "released")
            throw new Error(
              `Repair did not verify/release: ${JSON.stringify(repaired)}`,
            );
          const configured = JSON.parse(readFileSync(target, "utf8"));
          writeFileSync(
            health,
            JSON.stringify({ healthy: configured.enabled === true }) + "\n",
          );
          snapshots.push({ kind: "repair", repaired, config: configured });
          await invoke("startup_duty", {
            id: "uncertain",
            employeeId: employee.id,
            target,
            probe: health,
            acceptance: { path: ["healthy"], equals: true },
            repairAuthority: {
              kind: "replace-json",
              payload: { enabled: "pending-verification" },
              verification: {
                path: target,
                acceptance: { path: ["enabled"], equals: "approved" },
              },
            },
            cadenceMs: 1000,
            nextDue: Date.now() + 60000,
          });
          await invoke("startup_repair_authorize", {
            id: "uncertain-once",
            dutyId: "uncertain",
          });
          let failure: string | null = null;
          try {
            await repair.execute("uncertain-write", {
              authorizationId: "uncertain-once",
            });
          } catch (error: unknown) {
            failure = error instanceof Error ? error.message : String(error);
          }
          if (!failure?.includes("acceptance failed"))
            throw new Error(
              `Expected actual post-write verification failure: ${failure}`,
            );
          const modifiedAt = statSync(target, {
            bigint: true,
          }).mtimeNs.toString();
          let replay: string | null = null;
          try {
            await repair.execute("uncertain-replay", {
              authorizationId: "uncertain-once",
            });
          } catch (error: unknown) {
            replay = error instanceof Error ? error.message : String(error);
          }
          if (
            !replay?.includes("never replay") ||
            statSync(target, { bigint: true }).mtimeNs.toString() !== modifiedAt
          )
            throw new Error("Uncertain native write was replayed");
          const resources = JSON.parse(
            readFileSync(
              `${env("JP_SKILLS_HOME")}/startup/duty-proof/resources.json`,
              "utf8",
            ),
          );
          const uncertain = resources.startup_v6.grants.find(
            (entry) => entry.authorizationId === "uncertain-once",
          );
          if (uncertain?.state !== "reconciliation")
            throw new Error("Unknown mutation lost its target grant");
          writeFileSync(target, '{"enabled":"approved"}\n');
          const reconciled = await invoke("startup_repair_reconcile", {
            grantId: uncertain.id,
            evidence: { fixture: "explicit local-file reconciliation" },
          });
          if (reconciled.state !== "released")
            throw new Error("Fresh native probe did not reconcile grant");
          snapshots.push({
            kind: "uncertain",
            failure,
            replay,
            uncertain,
            reconciled,
            modifiedAt,
          });
          await invoke("startup_duty_end", {
            dutyId: "uncertain",
            evidence: { fixture: "finished uncertain action acceptance" },
          });

          await waitFor(
            async () =>
              (await status()).duties[0].lastObservation.observation.status ===
              "healthy",
            "return to healthy monitoring",
          );
          await waitFor(
            async () =>
              registry
                .list()
                .filter((ref) => ref.kind === "sub")
                .every((ref) => ref.status === "idle"),
            "employee quiet after repair",
          );
        } else {
          snapshots.push({ kind: "resume-initial", status: await status() });
          await waitFor(
            async () =>
              (await status()).duties[0].lastObservation.ownerEpoch >= 2,
            "current-owner resumed observation",
          );
          const currentStaff = await invoke("startup_staff", {});
          employee = currentStaff.employees.find(
            (entry) => entry.role === "devops",
          );
          snapshots.push({
            kind: "resume-ready",
            employee,
            status: await status(),
            registry: registry
              .list()
              .map((ref) => ({
                id: ref.id,
                status: ref.status,
                file: ref.sessionFile,
                sessionId: ref.session?.sessionManager.getSessionId(),
              })),
          });
        }
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({
            status: "COMPLETE",
            rootFile: root.sessionFile,
            rootSession: ctx.sessionManager.getSessionId(),
            employee,
            snapshots,
            final: await status(),
          }),
        );
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
