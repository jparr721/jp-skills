import { z } from "zod";

export type HerdrObservation = Readonly<{
  name: string | null;
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  nativeSession: string | null;
  state: "working" | "idle" | "done" | "blocked" | "unknown";
  stateSequence: number;
  interactiveReady: boolean;
}>;
type LayoutEnvironment = Readonly<Record<string, string>>;
export type HerdrRuntime = Readonly<{
  check: () => Promise<void>;
  createCrew: (input: Readonly<{ label: string; cwd: string; env: LayoutEnvironment }>) => Promise<{ tabId: string; rootPaneId: string }>;
  split: (input: Readonly<{ paneId: string; cwd: string; env: LayoutEnvironment }>) => Promise<string>;
  launch: (input: Readonly<{ paneId: string; name: string; args: readonly string[] }>) => Promise<HerdrObservation>;
  observe: () => Promise<readonly HerdrObservation[]>;
}>;
type CommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
type FailureCode = "command_failed" | "invalid_response" | "dependency_unavailable" | "binding_mismatch" | "invalid_request" | "spawn_failed";
type Diagnostic = Readonly<{
  code: FailureCode;
  command: readonly string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  detail: string;
}>;
export class HerdrRuntimeError extends Error {
  readonly code: FailureCode;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly detail: string;
  constructor(diagnostic: Diagnostic) {
    super(JSON.stringify(diagnostic));
    this.name = "HerdrRuntimeError";
    this.code = diagnostic.code;
    this.command = diagnostic.command;
    this.exitCode = diagnostic.exitCode;
    this.stdout = diagnostic.stdout;
    this.stderr = diagnostic.stderr;
    this.detail = diagnostic.detail;
  }
}
const textSchema = z.string().min(1).refine((value) => !value.includes("\0"), "NUL is not valid in command arguments");
const targetSchema = textSchema.refine((value) => !value.startsWith("-"), "Targets cannot begin with a command option");
const environmentSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine((value) => !value.includes("\0")));
const createSchema = z.strictObject({ label: textSchema, cwd: textSchema, env: environmentSchema });
const splitSchema = z.strictObject({ paneId: targetSchema, cwd: textSchema, env: environmentSchema });
const launchSchema = z.strictObject({ paneId: targetSchema, name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), args: z.array(z.string().refine((value) => !value.includes("\0"))) });
const locationSchema = z.object({ workspace_id: textSchema, tab_id: textSchema, pane_id: textSchema, terminal_id: textSchema });
const agentSchema = locationSchema.extend({
  agent: textSchema.nullable(),
  name: textSchema.nullable(),
  agent_status: z.enum(["working", "idle", "done", "blocked", "unknown"]),
  state_change_seq: z.number().int().nonnegative().safe(),
  interactive_ready: z.boolean(),
  agent_session: z.object({ source: textSchema, agent: textSchema, kind: z.enum(["id", "path"]), value: textSchema }).nullable(),
});
const createResultSchema = z.object({ type: z.literal("tab_created"), tab: z.object({ workspace_id: textSchema, tab_id: textSchema }), root_pane: locationSchema });
const splitResultSchema = z.object({ type: z.literal("pane_info"), pane: locationSchema });
const launchResultSchema = z.object({ type: z.literal("agent_started"), agent: agentSchema, argv: z.array(z.string()) });
const listResultSchema = z.object({ type: z.literal("agent_list"), agents: z.array(agentSchema) });
const statusSchema = z.object({ running: z.boolean(), version: textSchema, protocol: z.number().int(), compatible: z.boolean(), endpoint_compatible: z.boolean() });
const apiSchema = z.object({ protocol: z.literal(22), schema_version: z.literal(1), schemas: z.object({ success_response: z.object({ $defs: z.object({
  AgentInfo: z.object({ properties: z.object({ state_change_seq: z.object({ type: z.literal("integer") }), interactive_ready: z.object({ type: z.literal("boolean") }), agent_session: z.record(z.string(), z.unknown()) }) }),
  ResponseResult: z.object({ oneOf: z.array(z.object({ properties: z.object({ type: z.object({ const: z.string() }) }) })) }),
}) }) }) });

function normalize(agent: z.infer<typeof agentSchema>): HerdrObservation {
  return { name: agent.name, workspaceId: agent.workspace_id, tabId: agent.tab_id,
    paneId: agent.pane_id, terminalId: agent.terminal_id,
    nativeSession: agent.agent_session?.value ?? null,
    state: agent.agent_status, stateSequence: agent.state_change_seq,
    interactiveReady: agent.interactive_ready };
}
function environmentArgs(environment: LayoutEnvironment): readonly string[] {
  return Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}
function supportedVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major: number = Number(match[1]);
  const minor: number = Number(match[2]);
  const patch: number = Number(match[3]);
  return major > 0 || minor > 9 || (minor === 9 && patch >= 5);
}
export async function runHerdrCommand(argv: readonly string[]): Promise<CommandResult> {
  if (argv.length === 0 || argv.some((value) => value.includes("\0")))
    throw new HerdrRuntimeError({ code: "invalid_request", command: argv, exitCode: null, stdout: "", stderr: "", detail: "A nonempty executable argv without NUL is required" });
  try {
    const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } catch (error: unknown) {
    throw new HerdrRuntimeError({ code: "spawn_failed", command: argv, exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), detail: "Subprocess did not return a complete result; reconcile before retrying a write" });
  }
}
export function createHerdrRuntime(input: Readonly<{
  session: string;
  workspaceId: string;
  binary: string;
  run: (argv: readonly string[]) => Promise<CommandResult>;
}>): HerdrRuntime {
  const config = z.object({ session: targetSchema, workspaceId: targetSchema, binary: textSchema }).safeParse(input);
  if (!config.success)
    throw new HerdrRuntimeError({ code: "invalid_request", command: [input.binary], exitCode: null, stdout: "", stderr: "", detail: config.error.message });
  const prefix: readonly string[] = [config.data.binary, "--session", config.data.session];
  function fail(code: FailureCode, command: readonly string[], result: CommandResult, detail: string): never {
    throw new HerdrRuntimeError({ code, command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, detail });
  }
  function validate<T>(schema: z.ZodType<T>, value: unknown, command: readonly string[]): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new HerdrRuntimeError({ code: "invalid_request", command, exitCode: null, stdout: "", stderr: "", detail: parsed.error.message });
    return parsed.data;
  }
  async function execute<T>(args: readonly string[], schema: z.ZodType<T>, code: "invalid_response" | "dependency_unavailable"): Promise<Readonly<{ data: T; command: readonly string[]; result: CommandResult }>> {
    const command: readonly string[] = [...prefix, ...args];
    let result: CommandResult;
    try {
      result = await input.run(command);
    } catch (error: unknown) {
      if (error instanceof HerdrRuntimeError) throw error;
      throw new HerdrRuntimeError({ code: "spawn_failed", command, exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), detail: "Subprocess did not return a complete result; reconcile before retrying a write" });
    }
    if (result.exitCode !== 0) fail("command_failed", command, result, "Command outcome may be uncertain; reconcile before retrying a write");
    let raw: unknown;
    try { raw = JSON.parse(result.stdout); }
    catch (error: unknown) { fail(code, command, result, error instanceof Error ? error.message : String(error)); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) fail(code, command, result, parsed.error.message);
    return { data: parsed.data, command, result };
  }
  return {
    check: async (): Promise<void> => {
      const server = await execute(["status", "server", "--json"], statusSchema, "dependency_unavailable");
      if (!server.data.running || !server.data.compatible || !server.data.endpoint_compatible || server.data.protocol !== 22 || !supportedVersion(server.data.version))
        fail("dependency_unavailable", server.command, server.result, "Require a running compatible Herdr >=0.9.5 with protocol 22");
      const bundled = await execute(["api", "schema", "--json"], apiSchema, "dependency_unavailable");
      const variants: readonly string[] = bundled.data.schemas.success_response.$defs.ResponseResult.oneOf.map((variant) => variant.properties.type.const);
      if (!["tab_created", "pane_info", "agent_started", "agent_list"].every((kind) => variants.includes(kind)))
        fail("dependency_unavailable", bundled.command, bundled.result, "Bundled schema omits required layout or agent response variants");
    },
    createCrew: async (request): Promise<{ tabId: string; rootPaneId: string }> => {
      const parsed = validate(createSchema, request, [...prefix, "tab", "create"]);
      const response = await execute(["tab", "create", "--workspace", config.data.workspaceId, "--cwd", parsed.cwd, "--label", parsed.label, "--no-focus", ...environmentArgs(parsed.env)], z.object({ id: textSchema, result: createResultSchema }), "invalid_response");
      const created = response.data.result;
      if (created.tab.workspace_id !== config.data.workspaceId || created.root_pane.workspace_id !== config.data.workspaceId || created.root_pane.tab_id !== created.tab.tab_id)
        fail("binding_mismatch", response.command, response.result, "Created layout is outside the selected workspace or tab");
      return { tabId: created.tab.tab_id, rootPaneId: created.root_pane.pane_id };
    },
    split: async (request): Promise<string> => {
      const parsed = validate(splitSchema, request, [...prefix, "pane", "split"]);
      const response = await execute(["pane", "split", parsed.paneId, "--direction", "right", "--cwd", parsed.cwd, "--no-focus", ...environmentArgs(parsed.env)], z.object({ id: textSchema, result: splitResultSchema }), "invalid_response");
      if (response.data.result.pane.workspace_id !== config.data.workspaceId)
        fail("binding_mismatch", response.command, response.result, "Split pane is outside the selected workspace");
      return response.data.result.pane.pane_id;
    },
    launch: async (request): Promise<HerdrObservation> => {
      const parsed = validate(launchSchema, request, [...prefix, "agent", "start"]);
      const response = await execute(["agent", "start", parsed.name, "--kind", "omp", "--pane", parsed.paneId, "--", ...parsed.args], z.object({ id: textSchema, result: launchResultSchema }), "invalid_response");
      const agent = response.data.result.agent;
      if (agent.workspace_id !== config.data.workspaceId || agent.pane_id !== parsed.paneId || agent.name !== parsed.name || agent.agent !== "omp" || !agent.interactive_ready || (agent.agent_session !== null && agent.agent_session.agent !== "omp"))
        fail("binding_mismatch", response.command, response.result, "Started agent does not match the expected ready OMP pane identity");
      return normalize(agent);
    },
    observe: async (): Promise<readonly HerdrObservation[]> => {
      const response = await execute(["agent", "list"], z.object({ id: textSchema, result: listResultSchema }), "invalid_response");
      const agents = response.data.result.agents.filter((agent) => agent.workspace_id === config.data.workspaceId && agent.agent === "omp");
      if (agents.some((agent) => agent.agent_session !== null && agent.agent_session.agent !== "omp"))
        fail("binding_mismatch", response.command, response.result, "OMP native session identity belongs to a different agent kind");
      return agents.map(normalize);
    },
  };
}
