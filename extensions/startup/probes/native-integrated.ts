import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  employeeSchema,
  teamSchema,
  messageSchema,
  claimSchema,
} from "../src/contracts";
import nativeAdapter from "./native-adapter";
import { loadProfile } from "../src/profiles";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing integrated fixture variable ${name}`);
  return value;
}
function events(): readonly Record<string, unknown>[] {
  return readFileSync(env("STARTUP_ADAPTER_EVENTS"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}
function record(value: unknown): void {
  appendFileSync(env("STARTUP_ADAPTER_EVENTS"), JSON.stringify(value) + "\n");
}
function rows(kind: string): readonly unknown[] {
  const db = new Database(
    join(env("JP_SKILLS_HOME"), "startup/adapter-proof/staff.sqlite"),
    { readonly: true },
  );
  try {
    return z
      .array(z.object({ payload: z.string() }))
      .parse(db.query("SELECT payload FROM records WHERE kind=?").all(kind))
      .map((row) => JSON.parse(row.payload));
  } finally {
    db.close();
  }
}
async function wait(
  ctx: ExtensionContext,
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 30000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Integrated fixture timeout: ${label}`);
    await new Promise<void>((resolve) => ctx.setTimeout(resolve, 20));
  }
}
export default function nativeIntegrated(pi: ExtensionAPI): void {
  nativeAdapter(pi);
  const blocked = join(dirname(env("STARTUP_INTEGRATED_RELEASE")), "block-qa");
  pi.on("before_subagent_spawn", (event, ctx) => {
    if (event.agent === "fixture-refused") {
      record({ kind: "ordinary-preflight-refusal", event });
      return {
        block: true,
        reason: "Explicit isolated ordinary helper refusal",
      };
    }
    const profile = join(ctx.cwd, ".omp/agents", event.agent + ".md");
    if (
      existsSync(blocked) &&
      existsSync(profile) &&
      readFileSync(profile, "utf8").includes("name: startup-role-qa")
    ) {
      record({ kind: "integrated-partial-refusal", agent: event.agent });
      return {
        block: true,
        reason: "Explicit isolated fixture partial launch refusal",
      };
    }
  });
  pi.registerCommand("startup-integrated-proof", {
    description: "Coherent product-source native acceptance deltas",
    handler: async (_args, ctx) => {
      const checks: Record<string, boolean> = {};
      try {
        const registry = pi.pi.AgentRegistry.global();
        const root = registry.get(ctx.agent.id);
        if (!root?.session) throw new Error("Missing actual native root");
        const invoke = async (
          name: string,
          params: unknown,
        ): Promise<unknown> => {
          const tool = root.session?.getToolByName(name);
          if (!tool) throw new Error(`Missing integrated tool ${name}`);
          const output = await tool.execute(
            `integrated-${name}-${Date.now()}`,
            params,
          );
          record({ kind: "integrated-admin", name, params, output });
          if (output.isError)
            throw new Error(`Native ${name} failed: ${JSON.stringify(output)}`);
          return output.details;
        };
        const idle = () =>
          registry
            .list()
            .filter((ref) => ref.kind === "sub")
            .every((ref) => ref.status === "idle" || ref.status === "aborted");
        const staff = () => z.array(employeeSchema).parse(rows("employee"));
        const teams = () => z.array(teamSchema).parse(rows("team"));
        const messages = () => z.array(messageSchema).parse(rows("message"));
        const transitions = () =>
          events()
            .filter(
              (row) =>
                row.kind === "tool" &&
                row.name === "startup_item" &&
                row.error === false,
            )
            .map((row) =>
              z
                .object({
                  request: z.object({ itemId: z.string(), action: z.string() }),
                  status: z.string(),
                })
                .passthrough()
                .parse(row.details),
            );
        if (env("STARTUP_INTEGRATED_SCENARIO") === "preflight") {
          const profiles = join(ctx.cwd, ".omp/agents");
          mkdirSync(dirname(profiles), { recursive: true });
          writeFileSync(profiles, "Owned fixture preflight obstruction");
          const hire = { startup: "hire", requestId: "prepare-retry", role: "devops", additional: 2 };
          let refused = false;
          try { await invoke("task", hire); } catch { refused = true; }
          unlinkSync(profiles);
          const saved = staff().filter((employee) => employee.role === "devops");
          if (!refused || saved.length !== 2) throw new Error("Expected saved undispatched hires");
          mkdirSync(profiles);
          const second = saved[1]!;
          const profile = loadProfile({ skillsRoot: env("STARTUP_ADAPTER_SOURCES"), role: second.role, employeeId: second.id, generation: 1 });
          const conflict = join(profiles, profile.name + ".md");
          writeFileSync(conflict, "Owned conflicting profile fixture");
          let preparationRefused = false;
          try { await invoke("task", { startup: "activate", employeeIds: saved.map((employee) => employee.id) }); } catch { preparationRefused = true; }
          unlinkSync(conflict);
          await invoke("task", hire);
          await wait(ctx, () => saved.every((employee) => staff().some((current) => current.id === employee.id && current.nativeHandle !== null)) && idle(), "native profile preparation retry");
          checks.preparationRetryPreservesAllIds = preparationRefused && staff().filter((employee) => employee.role === "devops").length === 2;
          // Reserve one unactivated architect with a native preparation obstruction.
          const directory = join(ctx.cwd, ".omp");
          const oldProfiles = profiles + "-saved";
          renameSync(profiles, oldProfiles);
          writeFileSync(profiles, "Owned source-preflight obstruction");
          try { await invoke("task", { startup: "hire", requestId: "saved-architect", role: "architect", additional: 1 }); } catch (error) { record({ kind: "preflight-reserve-refused", error: String(error) }); }
          unlinkSync(profiles);
          renameSync(oldProfiles, profiles);
          const architect = staff().find((employee) => employee.role === "architect")!;
          const rolePath = join(env("STARTUP_ADAPTER_SOURCES"), "skills/startup-role-architect/SKILL.md");
          writeFileSync(rolePath, readFileSync(rolePath, "utf8") + "\nIsolated canonical source revision proof.\n");
          await invoke("startup_intake", { eventId: "PREFLIGHT", input: "Preserve original event", amendItemIds: [] });
          let sourceRefused = false;
          try { await invoke("task", { startup: "delegate", eventId: "PREFLIGHT", developers: 1 }); } catch (error) { sourceRefused = String(error).includes("Canonical role source"); }
          checks.sourceRefusedBeforeTeam = sourceRefused && teams().length === 0 && staff().find((employee) => employee.id === architect.id)?.assignment === null;
          await invoke("startup_refresh", { employeeId: architect.id, evidence: { fixture: "explicit safe source refresh" } });
          await invoke("task", { startup: "delegate", eventId: "PREFLIGHT", developers: 1 });
          await wait(ctx, () => teams().some((team) => team.eventId === "PREFLIGHT" && team.state === "active") && idle(), "native refreshed original intake team");
          checks.originalEmployeeAndEventRetained = teams().some((team) => team.eventId === "PREFLIGHT" && team.architect === architect.id);
          record({ kind: "preflight-final", staff: await invoke("startup_staff", {}), directory });
        } else if (env("STARTUP_INTEGRATED_SCENARIO") === "helper") {
          await invoke("task", {
            startup: "hire",
            requestId: "canonical-helper",
            role: "dev",
            additional: 1,
          });
          await wait(
            ctx,
            () =>
              events().some(
                (row) =>
                  row.kind === "tool" &&
                  row.name === "task" &&
                  row.id !== root.id,
              ),
            "actual canonical dev helper attempt",
          );
          await wait(
            ctx,
            () =>
              registry
                .list()
                .some(
                  (ref) =>
                    ref.id.endsWith("procedure-helper") &&
                    ref.status === "idle",
                ),
            "actual canonical helper completion",
          );
          await invoke("task", {
            startup: "hire",
            requestId: "canonical-pa-control",
            role: "pa",
            additional: 1,
          });
          await wait(
            ctx,
            () =>
              events().some(
                (row) =>
                  row.kind === "tool" &&
                  row.name === "task" &&
                  JSON.stringify(row.content).includes("spawns disabled"),
              ),
            "actual PA child denial",
          );
          checks.paSpawnDenied = true;
          const helper = registry
            .list()
            .find((ref) => ref.id.endsWith("procedure-helper"));
          checks.canonicalDevHelper = helper?.status === "idle";
          checks.helperNoEmployeeAuthority = staff().length === 3;
          record({
            kind: "canonical-helper",
            helper: helper
              ? {
                  id: helper.id,
                  parentId: helper.parentId,
                  status: helper.status,
                }
              : null,
            staff: staff(),
          });
        } else if (
          ["ordinary-root", "ordinary-child"].includes(
            env("STARTUP_INTEGRATED_SCENARIO"),
          )
        ) {
          mkdirSync(join(ctx.cwd, ".omp/agents"), { recursive: true });
          writeFileSync(
            join(ctx.cwd, ".omp/agents/fixture-refused.md"),
            "---\nname: fixture-refused\ndescription: Explicit native preflight refusal fixture\nblocking: false\n---\nReturn a bounded checkpoint.\n",
          );
          let ownerId = root.id;
          if (env("STARTUP_INTEGRATED_SCENARIO") === "ordinary-child") {
            await invoke("task", {
              startup: "hire",
              requestId: "ordinary-architect",
              role: "architect",
              additional: 1,
            });
            await wait(
              ctx,
              () =>
                staff().some(
                  (entry) =>
                    entry.role === "architect" && entry.nativeHandle !== null,
                ),
              "source-bound ordinary helper owner",
            );
            const architect = staff().find(
              (entry) => entry.role === "architect",
            );
            if (!architect?.nativeHandle)
              throw new Error("Missing native architect");
            await wait(
              ctx,
              idle,
              "canonical architect synchronous spawn refusal",
            );
            record({
              kind: "ordinary-architect-refusal",
              staff: await invoke("startup_staff", {}),
            });
            writeFileSync(
              join(ctx.cwd, ".omp/agents/fixture-ordinary-parent.md"),
              "---\nname: fixture-ordinary-parent\ndescription: Native child-owned ordinary refusal fixture\nspawns: [fixture-refused]\nblocking: false\n---\nNATIVE_ORDINARY_CHILD_PROBE\n",
            );
            await invoke("task", {
              context: "Bounded native ordinary parent",
              tasks: [
                {
                  name: "ordinary-parent",
                  agent: "fixture-ordinary-parent",
                  task: "NATIVE_ORDINARY_CHILD_PROBE",
                  solutionSpace: "Fixture only",
                  isolated: false,
                },
              ],
            });
            ownerId = "ordinary-parent";
          } else
            await invoke("task", {
              context: "Explicit isolated ordinary refusal fixture",
              tasks: [
                {
                  name: "ordinary-refused",
                  agent: "fixture-refused",
                  task: "Explicit isolated refusal",
                  solutionSpace: "Fixture only",
                  isolated: false,
                },
              ],
            });
          await wait(
            ctx,
            () =>
              root.session?.asyncJobManager
                ?.getAllJobs({ ownerId })
                .some(
                  (job) => job.type === "task" && job.status === "failed",
                ) === true,
            "actual terminal refused ordinary job",
          );
          await wait(ctx, idle, "successful native owner idle");
          const terminalJobs = root.session.asyncJobManager
            ?.getAllJobs({ ownerId })
            .map((job) => ({
              id: job.id,
              agentId: job.agentId,
              ownerId: job.ownerId,
              type: job.type,
              status: job.status,
              errorText: job.errorText,
              latestDetails: job.latestDetails,
            }));
          const before = await invoke("startup_staff", {});
          record({
            kind: "ordinary-terminal-state",
            ownerId,
            terminalJobs,
            before,
          });
          const retry = await root.session
            .getToolByName("task")
            ?.execute("ordinary-capacity-reuse", {
              context: "Bounded ordinary slot reuse",
              tasks: [
                {
                  name: "reuse-one",
                  agent: "task",
                  task: "Bounded ordinary checkpoint",
                  solutionSpace: "Fixture only",
                  isolated: false,
                },
                {
                  name: "reuse-two",
                  agent: "task",
                  task: "Bounded ordinary checkpoint",
                  solutionSpace: "Fixture only",
                  isolated: false,
                },
              ],
            });
          await wait(
            ctx,
            () =>
              ["reuse-one", "reuse-two"].every((id) =>
                registry
                  .list()
                  .some((ref) => ref.id === id && ref.status === "idle"),
              ),
            "actual ordinary two-slot reuse completes",
          );
          const after = await invoke("startup_staff", {});
          checks.reusedNativeSlotsComplete =
            z
              .object({ capacity: z.object({ available: z.number() }) })
              .parse(after).capacity.available === 2;
          record({
            kind: "ordinary-terminal-proof",
            after,
            refs: registry.list().map((ref) => ({
              id: ref.id,
              parentId: ref.parentId,
              status: ref.status,
              sessionFile: ref.sessionFile,
            })),
            ownerId,
            terminalJobs,
            before,
            retry,
            staff: staff(),
          });
          checks.failedOrdinaryReleasesSlot =
            z
              .object({ capacity: z.object({ available: z.number() }) })
              .parse(before).capacity.available === 2;
          checks.ordinarySlotReuse = retry !== undefined && !retry.isError;
        } else if (env("STARTUP_INTEGRATED_SCENARIO") === "single") {
          record({
            kind: "single-schema",
            tools: pi
              .getAllTools()
              .filter((tool) => tool.name === "task")
              .map((tool) => tool.parameters.toJsonSchema()),
          });
          const ordinary = await invoke("task", {
            agent: "task",
            task: "Return a read-only checkpoint",
            solutionSpace: "Fixture only",
            name: "single-ordinary",
            isolated: false,
          });
          await wait(
            ctx,
            () =>
              registry
                .list()
                .some(
                  (ref) =>
                    ref.id === "single-ordinary" && ref.status === "idle",
                ),
            "native single task",
          );
          mkdirSync(join(ctx.cwd, ".omp/agents"), { recursive: true });
          writeFileSync(
            join(ctx.cwd, ".omp/agents/fixture-default-parent.md"),
            "---\nname: fixture-default-parent\ndescription: Canonical bounded native default selection\nspawns: [scout]\nblocking: false\n---\nNATIVE_DEFAULT_AGENT_PROBE\n",
          );
          await invoke("task", {
            agent: "fixture-default-parent",
            name: "single-parent",
            task: "NATIVE_DEFAULT_AGENT_PROBE",
            solutionSpace: "Fixture only",
            isolated: false,
          });
          await wait(
            ctx,
            () =>
              registry
                .list()
                .some(
                  (ref) =>
                    ref.parentId === "single-parent" && ref.status === "idle",
                ),
            "actual default scout",
          );
          const refused = await invoke("task", {
            agent: "does-not-exist",
            task: "Rejected",
            solutionSpace: "Fixture only",
          });
          const refs = registry.list().map((ref) => ({
            id: ref.id,
            parentId: ref.parentId,
            status: ref.status,
            name: ref.name,
          }));
          checks.singleNativeProgress =
            JSON.stringify(ordinary).includes("single-ordinary");
          checks.parentDefaultScout = refs.some(
            (ref) =>
              ref.parentId === "single-parent" &&
              ref.id.endsWith("default-scout"),
          );
          checks.nativeRejection = events().some(
            (row) =>
              row.kind === "integrated-admin" &&
              JSON.stringify(row).includes("Unknown agent") &&
              JSON.stringify(row).includes("does-not-exist"),
          );
          checks.ordinaryNoEmployeeAuthority = staff().length === 1;
          record({
            kind: "single-final",
            refs,
            staff: await invoke("startup_staff", {}),
          });
        } else {
          if (!["partial", "final-single", "sync"].includes(env("STARTUP_INTEGRATED_SCENARIO"))) {
            checks.bootBeforeIntake =
              existsSync(join(ctx.cwd, "AGENTS.md")) &&
              existsSync(join(ctx.cwd, ".startup"));
            record({
              kind: "integrated-boot",
              agents: readFileSync(join(ctx.cwd, "AGENTS.md"), "utf8"),
            });
            for (const requestId of ["one", "six-a", "six-a", "six-b"]) {
              const result = await invoke("task", {
                startup: "hire",
                requestId,
                role: "devops",
                additional: requestId === "one" ? 1 : 6,
              });
              const expected =
                requestId === "one" ? 1 : requestId === "six-a" ? 7 : 13;
              await wait(
                ctx,
                () =>
                  staff().filter(
                    (entry) =>
                      entry.role === "devops" && entry.nativeHandle !== null,
                  ).length === expected && idle(),
                "additive canonical DevOps",
              );
              record({
                kind: "integrated-hire",
                requestId,
                result,
                staff: staff(),
              });
            }
            checks.additiveRetryNewIntent =
              staff().filter((entry) => entry.role === "devops").length === 13;
            await invoke("task", {
              startup: "hire",
              requestId: "pa",
              role: "pa",
              additional: 1,
            });
            await wait(
              ctx,
              () =>
                staff().some(
                  (entry) => entry.role === "pa" && entry.nativeHandle !== null,
                ) && idle(),
              "canonical PA",
            );
            await invoke("startup_intake", {
              eventId: "BUILD",
              input: "BUILD-1: investigate missing build input",
              amendItemIds: [],
            });
            await invoke("task", {
              startup: "delegate",
              eventId: "BUILD",
              developers: 1,
            });
            await wait(
              ctx,
              () =>
                events().some((row) => row.kind === "integrated-build-held"),
              "real BUILD architect held before capture",
            );
            await invoke("startup_intake", {
              eventId: "AGENTS",
              input: "AGENTS-1: independent ready docs request",
              amendItemIds: [],
            });
            const finalGuard =
              await root.session.extensionRunner?.emitSessionStop({
                messages: [],
                turn_id: 0,
                session_id: ctx.sessionManager.getSessionId(),
                stop_hook_active: false,
                signal: new AbortController().signal,
              });
            record({ kind: "integrated-native-final-guard", finalGuard });
            pi.sendMessage(
              {
                customType: "integrated-ready",
                content: "INTEGRATED_READY_SWEEP",
                display: false,
              },
              { triggerTurn: true, deliverAs: "nextTurn" },
            );
            await wait(
              ctx,
              () =>
                transitions().some(
                  (row) =>
                    row.request.itemId === "item-AGENTS" &&
                    row.request.action === "assign",
                ),
              "independent AGENTS full team item dispatch",
            );
            const build = teams().find((team) => team.eventId === "BUILD");
            const agents = teams().find((team) => team.eventId === "AGENTS");
            if (!build || !agents)
              throw new Error("Both native teams required");
            checks.completeIndependentTeams =
              [build, agents].every((team) =>
                ["ready", "active"].includes(team.state),
              ) &&
              new Set([
                build.architect,
                build.qa,
                ...build.devs,
                agents.architect,
                agents.qa,
                ...agents.devs,
              ]).size === 6;
            checks.agentsBeforeBuildCapture = !events().some(
              (row) =>
                row.kind === "tool" &&
                row.name === "startup_capture" &&
                JSON.stringify(row.details).includes('"BUILD"'),
            );
            const contexts = events().filter((row) => row.kind === "provider");
            const history = JSON.stringify(contexts);
            checks.managerWaitGuard =
              history.includes("integrated-wait") &&
              (history.includes("Delegate raw intake AGENTS") ||
                history.includes("Delegate the durable raw event"));
            checks.managerFinalGuard =
              history.includes("INTEGRATED_EARLY_FINAL") &&
              finalGuard?.continue === true &&
              JSON.stringify(finalGuard).includes(
                "Delegate raw intake AGENTS",
              ) &&
              history.includes("integrated-delegate");
            for (const eventId of ["CLARIFY-1", "CLARIFY-2", "MULTI"]) {
              await invoke("startup_intake", {
                eventId,
                input: `Successive clarification ${eventId}`,
                amendItemIds: [],
              });
              await invoke("task", {
                startup: "delegate",
                eventId,
                developers: 1,
              });
              const itemIds =
                eventId === "MULTI" ? ["MULTI-A", "MULTI-B"] : [eventId];
              await wait(
                ctx,
                () =>
                  itemIds.every((id) =>
                    transitions().some(
                      (row) =>
                        row.request.itemId === `item-${id}` &&
                        row.status === "DONE",
                    ),
                  ),
                "clarification and multi-request capture",
              );
            }
            checks.successiveDistinctTeams =
              new Set(
                teams().flatMap((team) => [
                  team.architect,
                  team.qa,
                  ...team.devs,
                ]),
              ).size === 15;
            checks.multiRequestWhileBuildHeld =
              !existsSync(env("STARTUP_INTEGRATED_RELEASE")) &&
              transitions().filter(
                (row) =>
                  row.status === "DONE" &&
                  ["item-MULTI-A", "item-MULTI-B"].includes(row.request.itemId),
              ).length === 2;
            record({
              kind: "integrated-independent-dispatch",
              build,
              agents,
              staff: await invoke("startup_staff", {}),
              transitions: transitions(),
            });
            ctx.setTimeout(
              () =>
                writeFileSync(
                  env("STARTUP_INTEGRATED_RELEASE"),
                  "release observed held BUILD intake\n",
                ),
              50,
            );
            await invoke("wait", {});
            checks.waitAllowedForActualPendingWork = true;
            await wait(
              ctx,
              () =>
                ["item-BUILD", "item-AGENTS"].every((id) =>
                  transitions().some(
                    (row) => row.request.itemId === id && row.status === "DONE",
                  ),
                ) && idle(),
              "both canonical phase paths",
            );
            const replay = await invoke("task", {
              startup: "delegate",
              eventId: "AGENTS",
              developers: 1,
            });
            checks.eventReplaySameTeam =
              z.object({ id: z.string() }).parse(replay).id === agents.id;
          }
          writeFileSync(blocked, "qa refused once\n");
          await invoke("startup_intake", {
            eventId: "PARTIAL",
            input: "Separate intentional partial activation request",
            amendItemIds: [],
          });
          await invoke("task", {
            startup: "delegate",
            eventId: "PARTIAL",
            developers: 1,
          });
          await wait(
            ctx,
            () =>
              events().some((row) => row.kind === "integrated-partial-refusal"),
            "actual native partial launch refusal",
          );
          const partial = teams().find((team) => team.eventId === "PARTIAL");
          if (!partial) throw new Error("Reserved partial team missing");
          checks.partialNotReady =
            partial.state === "reserved" &&
            !events().some(
              (row) =>
                row.kind === "tool" &&
                row.name === "startup_capture" &&
                JSON.stringify(row.details).includes('"PARTIAL"'),
            );
          record({ kind: "integrated-partial", partial, staff: staff() });
          await wait(
            ctx,
            () =>
              staff().filter(
                (entry) =>
                  [partial.architect, ...partial.devs].includes(entry.id) &&
                  entry.nativeHandle !== null,
              ).length === 2 &&
              staff().some(
                (entry) =>
                  entry.id === partial.qa &&
                  entry.nativeHandle === null &&
                  entry.error !== null,
              ),
            "actual terminal QA failure and bound siblings",
          );
          const beforeRetry = staff();
          checks.actualPartialBinding =
            beforeRetry.filter(
              (entry) =>
                [partial.architect, ...partial.devs].includes(entry.id) &&
                entry.nativeHandle !== null,
            ).length === 2 &&
            beforeRetry.some(
              (entry) =>
                entry.id === partial.qa &&
                entry.nativeHandle === null &&
                entry.error !== null,
            );
          record({
            kind: "integrated-native-jobs",
            jobs: root.session.asyncJobManager
              ?.getAllJobs({ ownerId: root.id })
              .map((job) => ({
                id: job.id,
                agentId: job.agentId,
                ownerId: job.ownerId,
                type: job.type,
                status: job.status,
                errorText: job.errorText,
                latestDetails: job.latestDetails,
              })),
            refs: registry.list().map((ref) => ({
              id: ref.id,
              status: ref.status,
              sessionFile: ref.sessionFile,
            })),
            staff: staff(),
          });
          unlinkSync(blocked);
          const identities = staff().map((entry) => entry.id);
          await invoke("task", {
            startup: "activate",
            employeeIds: [partial.architect, partial.qa, ...partial.devs],
          });
          await wait(
            ctx,
            () =>
              transitions().some(
                (row) =>
                  row.request.itemId === "item-PARTIAL" &&
                  row.status === "DONE",
              ) && idle(),
            "partial retry admitted same identities",
          );
          checks.successfulSiblingsPreserved = beforeRetry
            .filter((entry) =>
              [partial.architect, ...partial.devs].includes(entry.id),
            )
            .every((entry) =>
              staff().some(
                (current) =>
                  current.id === entry.id &&
                  current.generation === entry.generation &&
                  current.nativeHandle === entry.nativeHandle,
              ),
            );
          checks.retryCompleteSourceAdmission =
            staff()
              .filter((entry) =>
                [partial.architect, partial.qa, ...partial.devs].includes(
                  entry.id,
                ),
              )
              .every(
                (entry) =>
                  entry.nativeHandle !== null &&
                  entry.source !== null &&
                  entry.error === null,
              ) &&
            teams().some(
              (team) => team.id === partial.id && team.state === "active",
            );
          checks.partialRetryStable =
            JSON.stringify(staff().map((entry) => entry.id)) ===
            JSON.stringify(identities);
          if (!["partial", "final-single", "sync"].includes(env("STARTUP_INTEGRATED_SCENARIO"))) {
            const coordinator = staff().find(
              (entry) => entry.role === "devops",
            );
            if (!coordinator)
              throw new Error("Missing shared DevOps coordinator");
            for (const team of teams()) {
              const id = `coordinate-${team.eventId}`;
              await invoke("startup_send", {
                id,
                recipient: team.architect,
                kind: "assignment",
                correlation: team.eventId,
                payload: {
                  coordinate: true,
                  devops: coordinator.id,
                  technical: `Saved ${team.eventId} resource request`,
                  authorization: "Read-only fixture checkpoint",
                },
              });
              await wait(
                ctx,
                () =>
                  messages().some(
                    (message) =>
                      message.id === `report-report-${id}` &&
                      message.recipient === coordinator.id &&
                      message.status === "acknowledged",
                  ),
                "team manager DevOps coordination",
              );
            }
            checks.allTeamsCoordinateDevops = teams().every((team) =>
              messages().some(
                (message) =>
                  message.id === `report-report-coordinate-${team.eventId}` &&
                  message.recipient === coordinator.id,
              ),
            );
            await invoke("startup_send", {
              id: "question-attempt-1",
              recipient: coordinator.id,
              kind: "assignment",
              correlation: "question-work",
              payload: {
                kind: "fixture-question",
                request: "Await explicit clarification",
              },
            });
            await wait(
              ctx,
              () =>
                rows("assignment").some(
                  (row) =>
                    z.object({ id: z.string(), state: z.string() }).parse(row)
                      .id === "question-attempt-1" &&
                    z.object({ state: z.string() }).parse(row).state ===
                      "waiting",
                ),
              "actual question waiting",
            );
            await invoke("startup_resolve", {
              assignmentId: "question-attempt-1",
              evidence: { answer: "Clarified, new attempt required" },
            });
            await invoke("startup_send", {
              id: "question-attempt-2",
              recipient: coordinator.id,
              kind: "assignment",
              correlation: "question-work",
              payload: { answer: "New explicit attempt with clarified input" },
            });
            await wait(
              ctx,
              () =>
                messages().some(
                  (message) =>
                    message.id === "question-attempt-2" &&
                    message.status === "acknowledged",
                ) && idle(),
              "actual answered new attempt",
            );
            checks.questionNewAttempt =
              messages().some(
                (message) =>
                  message.id === "question-attempt-1" &&
                  message.status === "acknowledged",
              ) &&
              z
                .array(claimSchema)
                .parse(rows("claim"))
                .filter(
                  (claim) =>
                    ["question-attempt-1", "question-attempt-2"].includes(
                      claim.messageId,
                    ) && claim.status === "settled",
                ).length === 2;
            const devops = staff().find(
              (entry) => entry.role === "devops" && entry.id !== coordinator.id,
            );
            if (!devops) throw new Error("No idle DevOps");
            await invoke("startup_retire", {
              employeeIds: [devops.id],
              evidence: { fixture: "resolved idle employee" },
            });
            checks.idleScaleDown =
              staff().find((entry) => entry.id === devops.id)?.employment ===
              "retired";
            checks.queueDrainKeepsStaff =
              staff().filter((entry) => entry.employment === "hired").length ===
              identities.length - 1;
          }
          record({
            kind: "integrated-final",
            staff: staff(),
            teams: teams(),
            messages: messages(),
            claims: z.array(claimSchema).parse(rows("claim")),
            transitions: transitions(),
          });
        }
        if (!Object.values(checks).every(Boolean))
          throw new Error(
            `Integrated assertion failed: ${JSON.stringify(checks)}`,
          );
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({ status: "COMPLETE", checks }),
        );
      } catch (error: unknown) {
        writeFileSync(
          env("STARTUP_ADAPTER_REPORT"),
          JSON.stringify({
            status: "FAIL",
            checks,
            error: error instanceof Error ? error.stack : String(error),
          }),
        );
      }
    },
  });
}
