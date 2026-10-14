import { existsSync, readFileSync } from "node:fs";
import {
  bootSelection,
  parseBootCommand,
  writeBootGuidance,
  StartupBootError,
  type BootCommand,
  type Selection,
} from "./src/boot";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { z } from "zod";
import {
  getTaskSchema,
  type NativeSchema,
} from "@oh-my-pi/pi-coding-agent/task/types";
import {
  cfgTaskBatch,
  cfgTaskEnableEffort,
  cfgTaskIsolationEnabled,
  cfgTaskMaxConcurrency,
} from "@oh-my-pi/pi-coding-agent/task/settings";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { resolveSpawnPolicy } from "@oh-my-pi/pi-coding-agent/task/spawn-policy";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { ProfileSourceError } from "./src/profiles";
import {
  captureSchema,
  cueSchema,
  idSchema,
  jsonSchema,
} from "./src/contracts";
import {
  createAdapter,
  hireInputSchema,
  delegateInputSchema,
  activateInputSchema,
  replaceInputSchema,
  routeInputSchema,
  intakeInputSchema,
  retireInputSchema,
  settleInputSchema,
  type AdapterConfig,
  type NativeContext,
  type NativeRegistry,
  type NativeResult,
  type StartupAdapter,
} from "./src/omp-adapter";

export type SchemaBuilder = Readonly<{
  object: (shape: Record<string, unknown>) => NativeSchema;
  string: () => unknown;
  number: () => unknown;
  unknown: () => unknown;
  array: (schema: unknown) => unknown;
  literal: (value: string) => unknown;
  enum: (values: readonly string[]) => unknown;
}>;
export type HostAPI = Readonly<{
  pi: Readonly<{
    AgentRegistry: Readonly<{ global: () => NativeRegistry }>;
    settings: unknown;
    VERSION: string;
  }>;
  zod: SchemaBuilder;
  sendMessage: (
    message: Readonly<{
      customType: string;
      content: string;
      display: boolean;
    }>,
    options: Readonly<{ triggerTurn: boolean; deliverAs: "nextTurn" }>,
  ) => void;
  events: Readonly<{
    on: (channel: string, handler: (payload: unknown) => void) => () => void;
  }>;
  arktype: (definition: unknown) => NativeSchema;
  on: (
    name: string,
    handler: (event: unknown, ctx: NativeContext) => unknown,
  ) => void;
  registerTool: (
    tool: Readonly<{
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (
        id: string,
        params: unknown,
        signal: unknown,
        update: unknown,
        ctx: NativeContext,
      ) => Promise<NativeResult>;
    }>,
  ) => void;
  registerCommand: (
    name: string,
    options: Readonly<{
      description: string;
      handler: (args: string, ctx: NativeContext) => Promise<void>;
    }>,
  ) => void;
  getCommands: () => readonly Readonly<{ name: string }>[];
  getAllTools: () => readonly Readonly<{
    name: string;
    description: string;
    parameters: NativeSchema;
  }>[];
}>;
const adapters: Map<string, StartupAdapter> = new Map();
const contextEventSchema = z.object({ messages: z.array(z.unknown()) });
const toolEventSchema = z
  .object({
    toolName: z.string(),
    toolCallId: idSchema.optional(),
    input: z.unknown(),
  })
  .passthrough();
const rootConfigSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .nullable(),
  home: z.string().min(1),
  skillsRoot: z.string().min(1),
  employeeLimit: z.number().int().positive().nullable(),
  executionLimit: z.number().int().positive().nullable(),
  leaseMs: z.number().int().positive(),
});
function nativeEvalTools(settings: unknown): boolean {
  const setting = lookup("eval.tools.enabled");
  if (!setting)
    throw new Error("Native eval.tools.enabled setting unavailable");
  return z.boolean().parse(setting.get(settings));
}
function result(value: unknown): NativeResult {
  const serialized: string | undefined = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("Startup tool result is not JSON serializable");
  return {
    content: [{ type: "text", text: serialized }],
    details: jsonSchema.parse(JSON.parse(serialized)),
  };
}
function rootAdapter(
  registry: NativeRegistry,
  ctx: NativeContext,
): StartupAdapter | undefined {
  let ref = registry.get(ctx.agent.id);
  const visited: Set<string> = new Set();
  while (ref?.parentId) {
    if (visited.has(ref.id))
      throw new Error("Native registry contains a parent cycle");
    visited.add(ref.id);
    ref = registry.get(ref.parentId);
  }
  const sessionId: string | undefined =
    ref?.session?.sessionManager.getSessionId();
  return sessionId === undefined ? undefined : adapters.get(sessionId);
}
export type StartupConfig = Omit<AdapterConfig, "name" | "boundRoot"> &
  Readonly<{ name: string | null }>;
export function installStartup(
  pi: HostAPI,
  config: StartupConfig,
  configurationError?: string,
): void {
  const registry: NativeRegistry = pi.pi.AgentRegistry.global();
  let ownContext: NativeContext | null = null;
  let ownedAdapter: StartupAdapter | null = null;
  let defaultAgent: string = "task";
  let bootFailure: string | null = null;
  let selected: Selection | null = null;
  let commandReceipt: Readonly<{
    args: string;
    inputId: string;
    work: boolean;
  }> | null = null;
  let initializing: Promise<void> | null = null;
  let unsubscribeLifecycle: (() => void) | null = null;
  const ordinaryDescription: string =
    "Delegate bounded work through native task. Batch mode accepts context and tasks; single mode accepts task and solutionSpace. Native agent, name, outputSchema, schemaMode and enabled isolation, effort and eval-tool fields retain native validation. Context is shared task background; task is the concrete assignment; solutionSpace bounds the work. Native dispatch policy, capacity, isolation, budgets and transcripts apply.";
  function adapter(ctx: NativeContext): StartupAdapter {
    if (bootFailure !== null) throw new StartupBootError(bootFailure);
    const current = rootAdapter(registry, ctx);
    if (!current) throw new Error("Startup is not bound to this native root");
    return current;
  }
  function fail(error: unknown): void {
    bootFailure = error instanceof Error ? error.message : String(error);
    pi.sendMessage(
      {
        customType: "startup-boot-error",
        content: `Startup boot blocked: ${bootFailure}`,
        display: true,
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
  }
  async function initialize(
    ctx: NativeContext,
    command: BootCommand | null,
  ): Promise<void> {
    if (configurationError !== undefined)
      throw new StartupBootError(configurationError);
    rootConfigSchema.parse(config);
    if (ctx.agent.kind !== "main")
      throw new StartupBootError(
        "Only the actual native root may select a Startup",
      );
    if (pi.pi.VERSION !== "18.8.9")
      throw new StartupBootError(
        `Startup requires running OMP 18.8.9; actual host is ${pi.pi.VERSION}`,
      );
    const selection = bootSelection({
      cwd: ctx.cwd,
      home: config.home,
      skillsRoot: config.skillsRoot,
      command,
      explicitName: config.name,
      executionLimit: config.executionLimit,
    });
    if (selection === null) return;
    if (ownedAdapter !== null) {
      if (
        selected?.name !== selection.name ||
        selected.boundRoot !== selection.boundRoot ||
        ownedAdapter.rootSession !== ctx.sessionManager.getSessionId()
      )
        throw new StartupBootError(
          "Startup selection is already bound to another root or session; resume its canonical manager",
        );
      writeBootGuidance(selection);
      bootFailure = null;
      return;
    }
    writeBootGuidance(selection);
    const native = registry.get(ctx.agent.id);
    const session = native?.session?.sessionManager;
    if (
      !session ||
      native?.kind !== "main" ||
      session.getSessionId() !== ctx.sessionManager.getSessionId()
    )
      throw new StartupBootError(
        "Native root session evidence unavailable at boot",
      );
    const file = session.getSessionFile();
    if (!file)
      throw new StartupBootError(
        "Startup requires a persistent native root transcript",
      );
    if (!existsSync(file)) {
      if (!session.ensureOnDisk)
        throw new StartupBootError(
          "Native root transcript cannot be materialized by this host",
        );
      await session.ensureOnDisk();
    }
    const headers = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) =>
        z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)),
      )
      .filter((row) => row.type === "session");
    if (headers.length !== 1 || headers[0]?.id !== session.getSessionId())
      throw new StartupBootError(
        "Native root transcript identity conflicts at boot",
      );
    selected = selection;
    const current: StartupAdapter = createAdapter({
      ctx,
      registry,
      config: {
        ...config,
        name: selection.name,
        boundRoot: selection.boundRoot,
        executionLimit: selection.executionLimit,
      },
      nativeLimit: () => {
        const root = registry.get(ctx.agent.id);
        if (!root?.session)
          throw new Error("Native root offline; execution capacity is unknown");
        return cfgTaskMaxConcurrency.get(root.session.settings);
      },
      nativeBatch: () => {
        const root = registry.get(ctx.agent.id);
        if (!root?.session) throw new Error("Native root offline");
        return cfgTaskBatch.get(root.session.settings);
      },
      notifyManager: (cueId) =>
        pi.sendMessage(
          {
            customType: "startup-cue",
            content: `Durable Startup manager inbox cue ${cueId} is pending. Claim your own inbox and follow the canonical loop.`,
            display: false,
          },
          { triggerTurn: true, deliverAs: "nextTurn" },
        ),
      now: Date.now,
    });
    ownedAdapter = current;
    adapters.set(current.rootSession, current);
    unsubscribeLifecycle = pi.events.on(
      "task:subagent:lifecycle",
      (payload) => {
        const event = z
          .object({
            id: idSchema,
            status: z.enum(["started", "completed", "failed", "aborted"]),
          })
          .passthrough()
          .parse(payload);
        if (event.status === "failed" || event.status === "aborted")
          current.nativeEnded(event.id, event.status);
      },
    );
    bootFailure = null;
  }
  async function boot(
    ctx: NativeContext,
    command: BootCommand | null,
  ): Promise<void> {
    if (initializing !== null) await initializing;
    const attempt = initialize(ctx, command);
    initializing = attempt;
    try {
      await attempt;
    } catch (error: unknown) {
      fail(error);
      throw error;
    } finally {
      if (initializing === attempt) initializing = null;
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    ownContext = ctx;
    if (ctx.agent.kind !== "main") {
      const nativeSession =
        registry.get(ctx.agent.id)?.session ??
        (ctx.agent.parentId ? registry.get(ctx.agent.parentId)?.session : null);
      const discovered = await discoverAgents(
        ctx.cwd,
        homedir(),
        nativeSession?.effectiveExtensionRoots,
      );
      const definition = [
        ...discovered.agents,
        ...(nativeSession?.getSessionAgents?.() ?? []),
      ].find((agent) => agent.name === ctx.agent.name);
      if (!definition)
        throw new Error(
          `Native agent profile unavailable for task schema: ${ctx.agent.name}`,
        );
      defaultAgent = resolveSpawnPolicy(
        definition.spawns === "*" ? "*" : definition.spawns?.join(","),
      ).defaultAgent;
      return;
    }
    try {
      await boot(ctx, null);
    } catch {
      /* fail() retains the explicit initialization error for every guard. */
    }
  });
  pi.registerCommand("startup", {
    description:
      "Bind Startup: new <name> [--dir <JSON-quoted-path>] [-- <work>], select <name> [-- <work>], or status",
    handler: async (args, ctx) => {
      const command = parseBootCommand(args);
      await boot(ctx, command);
      if (selected === null)
        throw new StartupBootError(
          "No Startup selected; use /startup new <name> or /startup select <name>",
        );
      const current = adapter(ctx);
      const receipt = commandReceipt;
      commandReceipt = null;
      if (command.work !== null) {
        if (receipt === null || receipt.args !== args || !receipt.work)
          throw new StartupBootError(
            "Startup work command requires its original native input receipt; submit through native interactive/RPC input",
          );
        pi.sendMessage(
          {
            customType: "startup-work",
            content: `Saved Startup work event ${receipt.inputId}. Delegate through task startup=delegate to a complete architect-led team before lookup.`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "nextTurn" },
        );
      } else
        pi.sendMessage(
          {
            customType: "startup-status",
            content: JSON.stringify({
              runningOMP: pi.pi.VERSION,
              selection: selected,
              staff: current.staff(ctx),
              duties: current.duties.status(),
            }),
            display: true,
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
    },
  });
  const builder: SchemaBuilder = pi.zod;
  const hireSchema = builder.object({
    startup: builder.literal("hire"),
    requestId: builder.string(),
    role: builder.enum(["architect", "qa", "dev", "devops", "pa"]),
    additional: builder.number(),
  });
  const delegateSchema = builder.object({
    startup: builder.literal("delegate"),
    eventId: builder.string(),
    developers: builder.number(),
  });
  const replaceSchema = builder.object({
    startup: builder.literal("replace"),
    employeeId: builder.string(),
    evidence: builder.unknown(),
  });
  const activateSchema = builder.object({
    startup: builder.literal("activate"),
    employeeIds: builder.array(builder.string()),
  });
  pi.registerTool({
    name: "task",
    label: "Task",
    get description() {
      return `${ordinaryDescription}\nStartup hire reserves additional durable employees. Startup delegate dispatches a complete fresh architect-led team for a persisted raw event. Startup activate retries existing pending employee identities.`;
    },
    get parameters() {
      const session =
        ownContext === null ? null : registry.get(ownContext.agent.id)?.session;
      const settings: unknown = session?.settings ?? pi.pi.settings;
      const ordinary: NativeSchema = getTaskSchema({
        isolationEnabled:
          session?.getPlanModeState()?.enabled !== true &&
          cfgTaskIsolationEnabled.get(settings),
        batchEnabled: cfgTaskBatch.get(settings),
        effortEnabled: cfgTaskEnableEffort.get(settings),
        evalToolsEnabled: nativeEvalTools(settings),
        defaultAgent,
      });
      return ordinary
        .and(pi.arktype({ "startup?": "never" }))
        .or(hireSchema)
        .or(delegateSchema)
        .or(activateSchema)
        .or(replaceSchema);
    },
    execute: async (_id, params, _signal, _update, ctx) => {
      if (bootFailure !== null) throw new StartupBootError(bootFailure);
      if (!ctx.invokeTool)
        throw new Error("Native same-name task delegate unavailable");
      const shape = z.record(z.string(), z.unknown()).parse(params);
      if (!("startup" in shape)) {
        const current = rootAdapter(registry, ctx);
        return current ? current.ordinary(ctx, shape) : ctx.invokeTool(shape);
      }
      const current: StartupAdapter = adapter(ctx);
      switch (shape.startup) {
        case "hire": {
          const request = hireInputSchema.parse(shape);
          const receipt = current.reserve(ctx, request);
          await current.activate(
            ctx,
            receipt.employees.map((employee) => employee.id),
          );
          return result(current.reserve(ctx, request));
        }
        case "delegate":
          return result(
            await current.delegate(ctx, delegateInputSchema.parse(shape)),
          );
        case "replace":
          return result(
            await current.replace(ctx, replaceInputSchema.parse(shape)),
          );
        case "activate": {
          const request = activateInputSchema.parse(shape);
          return result(await current.activate(ctx, request.employeeIds));
        }
        default:
          throw new Error("Unknown Startup native task operation");
      }
    },
  });
  function tool(
    name: string,
    description: string,
    parameters: unknown,
    execute: (
      ctx: NativeContext,
      params: unknown,
    ) => unknown | Promise<unknown>,
  ): void {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters,
      execute: async (_id, params, _signal, _update, ctx) =>
        result(await execute(ctx, params)),
    });
  }
  tool(
    "startup_route",
    "Manager-only high-level disposition of saved human input. Work preserves the exact raw receipt as an intake event for immediate architect-team delegation. Other dispositions retain a reason and create no queue row.",
    builder.object({
      inputId: builder.string(),
      disposition: builder.enum([
        "work",
        "status",
        "control",
        "conversation",
        "decision",
      ]),
      reason: builder.string(),
      amendItemIds: builder.array(builder.string()),
    }),
    (ctx, params) =>
      adapter(ctx).routeInput(ctx, routeInputSchema.parse(params)),
  );
  tool(
    "startup_input",
    "Read a bounded 4096-character page of a scoped saved input; offsets are host-validated. Only the selected manager input or its active assigned team may retrieve it.",
    builder.object({ inputId: builder.string(), offset: builder.number() }),
    (ctx, params) => adapter(ctx).readInput(ctx, params),
  );
  pi.registerTool({
    name: "startup_image",
    label: "Startup image",
    description:
      "Retrieve an actual native image block by scoped saved input ID and attachment index. No model paths or raw base64 text echoes.",
    parameters: builder.object({
      inputId: builder.string(),
      index: builder.number(),
    }),
    execute: async (_id, params, _signal, _update, ctx) =>
      adapter(ctx).image(ctx, params),
  });
  const itemCommon = {
    requestId: builder.string(),
    itemId: builder.string(),
    expectedRevision: builder.number(),
  };
  const itemParameters = builder
    .object({
      ...itemCommon,
      action: builder.literal("assign"),
      employeeId: builder.string(),
      evidence: builder.unknown(),
    })
    .or(
      builder.object({
        ...itemCommon,
        action: builder.literal("review"),
        resultId: builder.string(),
        evidence: builder.unknown(),
      }),
    )
    .or(
      builder.object({
        ...itemCommon,
        action: builder.literal("qa_assign"),
        evidence: builder.unknown(),
      }),
    )
    .or(
      builder.object({
        ...itemCommon,
        action: builder.literal("qa"),
        resultId: builder.string(),
        verdict: builder.enum(["APPROVE", "REDO"]),
        proof: builder.unknown(),
      }),
    )
    .or(
      builder.object({
        ...itemCommon,
        action: builder.literal("gate"),
        verdict: builder.enum(["APPROVE", "REDO"]),
        evidence: builder.unknown(),
      }),
    )
    .or(
      builder.object({
        ...itemCommon,
        action: builder.literal("decide"),
        status: builder.enum([
          "BLOCKED",
          "NEEDS_DECISION",
          "QUEUED",
          "REJECTED",
          "MERGED",
          "DONE",
        ]),
        evidence: builder.unknown(),
      }),
    );
  tool(
    "startup_item",
    "Typed canonical item transition with current revision and stable requestId. Manager/own architect assign; assigned dev submits durable result to REVIEW; architect qa_assign owns QA dispatch; QA records saved proof; architect gates; manager alone lands/closes. Evidence and unresolved-work reconciliation are required.",
    itemParameters,
    (ctx, params) => adapter(ctx).item(ctx, params),
  );
  tool(
    "startup_intake",
    "Persist raw requests and high-level amendment IDs. Delegate the event immediately through native task startup=delegate.",
    builder.object({
      eventId: builder.string(),
      input: builder.unknown(),
      amendItemIds: builder.array(builder.string()),
    }),
    (ctx, params) =>
      adapter(ctx).recordIntake(ctx, intakeInputSchema.parse(params)),
  );
  tool(
    "startup_claim",
    "Claim only the runtime-bound employee inbox. Incomplete teams have no claim.",
    builder.object({}),
    (ctx, params) => {
      z.strictObject({}).parse(params);
      return adapter(ctx).claim(ctx);
    },
  );
  tool(
    "startup_settle",
    "Atomically save result, own checkpoint, acknowledgement and outgoing architect/manager messages.",
    builder.object({ claimId: builder.string(), result: builder.unknown() }),
    (ctx, params) => adapter(ctx).settle(ctx, settleInputSchema.parse(params)),
  );
  tool(
    "startup_send",
    "Persist a scoped cue before native delivery. Team members report through their architect.",
    builder.object({
      id: builder.string(),
      recipient: builder.string(),
      kind: builder.enum([
        "assignment",
        "report",
        "question",
        "answer",
        "alert",
        "duty",
      ]),
      correlation: builder.string(),
      payload: builder.unknown(),
    }),
    (ctx, params) => adapter(ctx).send(ctx, cueSchema.parse(params)),
  );
  tool(
    "startup_capture",
    "Architect-only scoped technical intake capture and queue revision receipt.",
    builder.object({
      captureId: builder.string(),
      eventId: builder.string(),
      rows: builder.array(builder.unknown()),
      receipt: builder.unknown(),
    }),
    (ctx, params) => adapter(ctx).capture(ctx, captureSchema.parse(params)),
  );
  tool(
    "startup_staff",
    "Manager-only source readiness, capacity and bounded recovery IDs. Use recoveryOffset from recovery.nextOffset for subsequent recovery pages.",
    builder.object({}).or(builder.object({ recoveryOffset: builder.number() })),
    (ctx, params) => {
      const parsed = z.strictObject({ recoveryOffset: z.number().int().nonnegative().optional() }).parse(params);
      return adapter(ctx).staff(ctx, parsed.recoveryOffset);
    },
  );
  tool(
    "startup_dispatch",
    "Manager-only native wake of existing durable message IDs; delivery never settles a claim.",
    builder.object({ messageIds: builder.array(builder.string()) }),
    async (ctx, params) => {
      const parsed = z
        .strictObject({ messageIds: z.array(idSchema).min(1) })
        .parse(params);
      return adapter(ctx).dispatch(ctx, parsed.messageIds);
    },
  );
  tool(
    "startup_refresh",
    "Manager-only host-loaded canonical source refresh at an idle boundary; retains history and standing duty, requires fresh native activation.",
    builder.object({
      employeeId: builder.string(),
      evidence: builder.unknown(),
    }),
    (ctx, params) => adapter(ctx).refresh(ctx, params),
  );
  tool(
    "startup_reconcile",
    "Manager-only explicit evidence resolution of an uncertain native claim.",
    builder.object({ claimId: builder.string(), evidence: builder.unknown() }),
    (ctx, params) => adapter(ctx).reconcile(ctx, params),
  );
  tool(
    "startup_resolve",
    "Manager-only explicit resolution of an assignment after evidence/reconciliation.",
    builder.object({
      assignmentId: builder.string(),
      evidence: builder.unknown(),
    }),
    (ctx, params) => adapter(ctx).resolve(ctx, params),
  );
  tool(
    "startup_finish_team",
    "Manager-only complete-team finish after architect capture and resolved work, mail and grants.",
    builder.object({ teamId: builder.string(), evidence: builder.unknown() }),
    (ctx, params) => adapter(ctx).finish(ctx, params),
  );
  tool(
    "startup_bind_manager",
    "Current-root recovery admin: bind full canonical manager sources after explicit reconciliation.",
    builder.object({}),
    (ctx, params) => {
      z.strictObject({}).parse(params);
      return adapter(ctx).bindManager(ctx);
    },
  );
  tool(
    "startup_release_reconciled",
    "Current-root recovery admin: release only reconciled target grants after explicit verification evidence.",
    builder.object({
      grantId: builder.string(),
      verification: builder.unknown(),
    }),
    (ctx, params) => adapter(ctx).releaseReconciled(ctx, params),
  );
  tool(
    "startup_duty",
    "Manager assigns a persisted filesystem-only JSON duty. Missing configuration remains pending. No deployment connector or arbitrary shell authority.",
    builder.object({
      id: builder.string(),
      employeeId: builder.string(),
      target: builder.unknown(),
      probe: builder.unknown(),
      acceptance: builder.unknown(),
      repairAuthority: builder.unknown(),
      cadenceMs: builder.unknown(),
      nextDue: builder.unknown(),
    }),
    (ctx, params) => {
      const current = adapter(ctx);
      return current.duties.assign(current.manager(ctx), params);
    },
  );
  tool(
    "startup_duty_end",
    "Manager ends a resolved standing duty with explicit evidence.",
    builder.object({ dutyId: builder.string(), evidence: builder.unknown() }),
    async (ctx, params) => {
      const current = adapter(ctx);
      return current.duties.end(current.manager(ctx), params);
    },
  );
  tool(
    "startup_duties",
    "Manager reads runtime/offline status and timestamped filesystem duty observations. Historical observations do not establish current health.",
    builder.object({}),
    (ctx, params) => {
      z.strictObject({}).parse(params);
      const current = adapter(ctx);
      current.manager(ctx);
      return current.duties.status();
    },
  );
  tool(
    "startup_repair_authorize",
    "Manager authorizes one exact JSON document replacement and its separately assigned post-action probe from a configured duty.",
    builder.object({ id: builder.string(), dutyId: builder.string() }),
    (ctx, params) => {
      const current = adapter(ctx);
      current.duties.authorize(current.manager(ctx), params);
      return params;
    },
  );
  tool(
    "startup_repair",
    "Assigned actual employee executes a fresh authorized filesystem repair once under a canonical target grant, then verifies. Existing grants are never replayed.",
    builder.object({ authorizationId: builder.string() }),
    (ctx, params) => {
      const current = adapter(ctx);
      const parsed = z
        .strictObject({ authorizationId: idSchema })
        .parse(params);
      return current.duties.repair(current.caller(ctx), parsed.authorizationId);
    },
  );
  tool(
    "startup_repair_reconcile",
    "Manager verifies an uncertain JSON repair using its saved assigned probe before releasing its target grant. Never repeats the write.",
    builder.object({ grantId: builder.string(), evidence: builder.unknown() }),
    (ctx, params) => {
      const current = adapter(ctx);
      return current.reconcileRepair(ctx, params);
    },
  );
  tool(
    "startup_retire",
    "Manager-only safe retirement of idle DevOps after explicit duty/work resolution.",
    builder.object({
      employeeIds: builder.array(builder.string()),
      evidence: builder.unknown(),
    }),
    (ctx, params) => adapter(ctx).retire(ctx, retireInputSchema.parse(params)),
  );
  tool(
    "startup_block",
    "Record concrete native capacity, resource or dependency evidence for an intake/employee; manager only.",
    builder.object({ key: builder.string(), evidence: builder.unknown() }),
    (ctx, params) => {
      const parsed = z
        .strictObject({ key: idSchema, evidence: jsonSchema })
        .parse(params);
      adapter(ctx).block(ctx, parsed.key, parsed.evidence);
      return parsed;
    },
  );
  pi.on("input", async (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const parsed = z
      .object({
        text: z.string(),
        source: z.enum(["interactive", "rpc", "extension"]),
        images: z.array(z.unknown()).optional(),
      })
      .parse(event);
    if (parsed.source === "extension") return;
    const spaceIndex = parsed.text.indexOf(" ");
    const commandName = parsed.text.startsWith("/")
      ? parsed.text.slice(1, spaceIndex === -1 ? undefined : spaceIndex)
      : null;
    if (commandName === "startup") {
      const args = spaceIndex === -1 ? "" : parsed.text.slice(spaceIndex + 1);
      try {
        const command = parseBootCommand(args);
        await boot(ctx, command);
        if (selected === null)
          throw new StartupBootError(
            "No Startup selected; use /startup new <name> or /startup select <name>",
          );
        const current = adapter(ctx);
        const received = current.receiveInput(ctx, event);
        if (received === null)
          throw new StartupBootError("Native Startup work receipt unavailable");
        current.routeInput(ctx, {
          inputId: received.id,
          disposition: command.work === null ? "control" : "work",
          reason:
            command.work === null
              ? "Native Startup control command"
              : "Explicit native Startup work command",
          amendItemIds: [],
        });
        commandReceipt = {
          args,
          inputId: received.id,
          work: command.work !== null,
        };
      } catch (error: unknown) {
        fail(error);
        return { handled: true };
      }
      return;
    }
    if (bootFailure !== null) return { handled: true };
    const current = rootAdapter(registry, ctx);
    if (!current) return;
    const received = current.receiveInput(ctx, event);
    if (received === null) return;
    if (
      commandName &&
      pi.getCommands().some((entry) => entry.name === commandName)
    )
      current.routeInput(ctx, {
        inputId: received.id,
        disposition: "control",
        reason: `Native registered command /${commandName}`,
        amendItemIds: [],
      });
  });
  pi.on("context", async (event, ctx) => {
    const current = rootAdapter(registry, ctx);
    if (!current) return;
    let projection: string | null;
    try {
      projection = await current.projection(ctx);
    } catch (error: unknown) {
      if (error instanceof ProfileSourceError)
        current.sourceFailed(ctx, error.message);
      throw error;
    }
    if (projection === null) return;
    const parsed = contextEventSchema.parse(event);
    return {
      messages: [
        { role: "developer", content: projection, timestamp: Date.now() },
        ...parsed.messages,
      ],
    };
  });
  pi.on("tool_call", (event, ctx) => {
    if (bootFailure !== null)
      return { block: true, reason: `Startup boot blocked: ${bootFailure}` };
    const current = rootAdapter(registry, ctx);
    if (!current) return;
    const parsed = toolEventSchema.parse(event);
    if (
      current.admitDutyRead(
        ctx,
        parsed.toolName,
        parsed.toolCallId,
        parsed.input,
      )
    )
      return;
    const fenced = current.guardTurn(ctx, parsed.toolName);
    if (fenced) return { block: true, reason: fenced };
    if (ctx.agent.kind !== "main") return;
    if (current.staff(ctx).mode === "recovery") {
      if (
        ![
          "startup_staff",
          "startup_route",
          "startup_reconcile",
          "startup_resolve",
          "startup_release_reconciled",
          "startup_repair_reconcile",
          "startup_bind_manager",
          "wait",
          "yield",
        ].includes(parsed.toolName)
      )
        return {
          block: true,
          reason:
            "Resolve saved manager claims/grants through current-owner recovery admin tools before inbox, hire, intake or technical work.",
        };
      const reason = current.waitGuard();
      if ((parsed.toolName === "wait" || parsed.toolName === "yield") && reason)
        return { block: true, reason };
      return;
    }
    if (parsed.toolName === "wait" || parsed.toolName === "yield") {
      const reason: string | null = current.waitGuard();
      if (reason) return { block: true, reason };
      return;
    }
    const undelegated = current.store
      .snapshot()
      .intakes.some((entry) => entry.teamId === null);
    if (
      undelegated &&
      ![
        "startup_intake",
        "startup_route",
        "startup_staff",
        "startup_block",
        "task",
      ].includes(parsed.toolName)
    )
      return {
        block: true,
        reason:
          "Delegate the durable raw event to its architect-led team before technical lookup or implementation.",
      };
  });
  pi.on("session_stop", (_event, ctx) => {
    if (bootFailure !== null)
      return {
        continue: true,
        additionalContext: `Startup boot blocked: ${bootFailure}. Report the blocker; correct the reported files and retry /startup; invalid host configuration requires a corrected host restart.`,
      };
    const current = rootAdapter(registry, ctx);
    if (!current || ctx.agent.kind !== "main") return;
    const reason: string | null = current.waitGuard();
    return reason === null
      ? undefined
      : { continue: true, additionalContext: reason };
  });
  pi.on("session_switch", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    try {
      if (ownedAdapter !== null) {
        const closing = ownedAdapter;
        unsubscribeLifecycle?.();
        await closing.shutdown();
        if (adapters.get(closing.rootSession) === closing)
          adapters.delete(closing.rootSession);
        ownedAdapter = null;
        selected = null;
      }
      ownContext = ctx;
      await boot(ctx, null);
    } catch (error: unknown) {
      fail(error);
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    if (ownedAdapter === null || ownedAdapter.rootId !== ctx.agent.id) return;
    const closing = ownedAdapter;
    unsubscribeLifecycle?.();
    try {
      await closing.shutdown();
    } finally {
      if (adapters.get(closing.rootSession) === closing)
        adapters.delete(closing.rootSession);
    }
  });
}
export function parseExecutionLimit(value: string | undefined): number | null {
  if (value === undefined) return null;
  return z
    .number()
    .int()
    .positive()
    .safe()
    .parse(
      Number(
        z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .parse(value),
      ),
    );
}
export default function startup(pi: HostAPI): void {
  const name: string | null = process.env.STARTUP_NAME ?? null;
  let executionLimit: number | null = null;
  let configurationError: string | undefined;
  try {
    executionLimit = parseExecutionLimit(process.env.STARTUP_EXECUTION_LIMIT);
  } catch (error: unknown) {
    configurationError = `Invalid STARTUP_EXECUTION_LIMIT ${JSON.stringify(process.env.STARTUP_EXECUTION_LIMIT)}: ${error instanceof Error ? error.message : String(error)}`;
  }
  installStartup(
    pi,
    {
      name,
      home: resolve(
        process.env.JP_SKILLS_HOME ??
          join(
            process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
            "jp-skills",
          ),
      ),
      skillsRoot: resolve(
        process.env.STARTUP_SKILLS_ROOT ?? join(import.meta.dir, "../.."),
      ),
      employeeLimit: null,
      executionLimit,
      leaseMs: 60000,
    },
    configurationError,
  );
}
