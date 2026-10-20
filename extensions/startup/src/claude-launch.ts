import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assertStartupPath, canonicalStartupRoot, ensureStartupRoot, StartupBootError } from "./boot";
import type { Json } from "./contracts";
import type { Environment } from "./employee-entry";

type ClaudeFiles = Readonly<{ settingsFile: string; mcpFile: string }>;
type BridgeInput = Readonly<{ bun: string; skillsRoot: string }>;
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function shim(input: BridgeInput, file: string): string {
  return `${shellQuote(input.bun)} ${shellQuote(join(input.skillsRoot, "extensions/startup/src", file))}`;
}
function hook(input: Readonly<Record<string, string>>, timeout: number): Json {
  return { type: "mcp_tool", server: "startup", tool: "hook", timeout, input: { sessionId: "${session_id}", ...input } };
}
export function claudeSettings(input: BridgeInput): Json {
  const rewake: Json = { type: "command", command: shim(input, "claude-waiter.ts"), async: true, asyncRewake: true, timeout: 2000000 };
  return { hooks: {
    SessionStart: [{ hooks: [hook({ event: "SessionStart", transcript: "${transcript_path}" }, 30), rewake] }],
    SessionEnd: [{ hooks: [hook({ event: "SessionEnd" }, 30)] }],
    UserPromptSubmit: [{ hooks: [hook({ event: "UserPromptSubmit", prompt: "${prompt}", promptId: "${prompt_id}", transcript: "${transcript_path}" }, 120), rewake] }],
    // Claude 2.1.302 honors onFailure "block" only on command and http hooks, so tool gating runs as a command.
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: shim(input, "claude-pretool.ts"), timeout: 30, onFailure: "block" }] }],
    PostToolUse: [{ matcher: "*", hooks: [hook({ event: "PostToolUse", tool: "${tool_name}", agentId: "${agent_id}" }, 30)] }],
    Stop: [{ hooks: [hook({ event: "Stop", active: "${stop_hook_active}" }, 30)] }],
    StopFailure: [{ hooks: [{ type: "command", command: shim(input, "claude-event.ts"), timeout: 10 }] }],
  } };
}
export function claudeMcpConfig(input: BridgeInput): Json {
  return { mcpServers: { startup: { type: "stdio", command: input.bun, args: [join(input.skillsRoot, "extensions/startup/claude-bridge.ts")] } } };
}
function sharedArgs(input: Readonly<{ promptFile: string; settingsFile: string; mcpFile: string; name: string }>): readonly string[] {
  return ["--append-system-prompt-file", input.promptFile, "--settings", input.settingsFile, "--mcp-config", input.mcpFile, "-n", input.name];
}
export function claudeEmployeeArgs(input: Readonly<{ sessionId: string; promptFile: string; settingsFile: string; mcpFile: string; name: string; model: string | null; effort: string | null }>): readonly string[] {
  return ["--session-id", input.sessionId, ...(input.model === null ? [] : ["--model", input.model]), ...(input.effort === null ? [] : ["--effort", input.effort]), ...sharedArgs(input)];
}
export function claudeManagerArgs(input: Readonly<{ session: Readonly<{ kind: "new" | "resume"; id: string }>; model: string | null; effort: string | null; promptFile: string; settingsFile: string; mcpFile: string }>): readonly string[] {
  return [input.session.kind === "new" ? "--session-id" : "--resume", input.session.id, ...(input.session.kind === "resume" || input.model === null ? [] : ["--model", input.model]), ...(input.session.kind === "resume" || input.effort === null ? [] : ["--effort", input.effort]), ...sharedArgs({ ...input, name: "startup-manager" })];
}
function privateFile(path: string, content: string): void {
  if (!existsSync(path)) { writeFileSync(path, content, { flag: "wx", mode: 0o600 }); return; }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || readFileSync(path, "utf8") !== content)
    throw new StartupBootError(`Shared Claude Startup file conflicts with this checkout; inspect and remove it explicitly: ${path}`);
}
export function writeClaudeFiles(input: Readonly<{ startupRoot: string; skillsRoot: string; bun: string }>): ClaudeFiles {
  const root: string = ensureStartupRoot(input.startupRoot);
  const directory = join(root, "startup", "claude");
  for (const candidate of [join(root, "startup"), directory]) {
    assertStartupPath(root, candidate, "directory");
    if (existsSync(candidate)) {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
        throw new StartupBootError(`Claude Startup directory must be an owner-only directory, not a symlink: ${candidate}`);
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertStartupPath(root, directory, "directory");
  const files: ClaudeFiles = { settingsFile: join(directory, "settings.json"), mcpFile: join(directory, "mcp.json") };
  assertStartupPath(root, files.settingsFile, "file");
  assertStartupPath(root, files.mcpFile, "file");
  privateFile(files.settingsFile, JSON.stringify(claudeSettings(input)));
  privateFile(files.mcpFile, JSON.stringify(claudeMcpConfig(input)));
  return files;
}
const settingsSchema = z.looseObject({ hooks: z.looseObject({ SessionStart: z.array(z.looseObject({ hooks: z.array(z.looseObject({ type: z.string(), command: z.string().optional() })) })).optional() }).optional() });
export function claudeIntegrationPath(environment: Environment): string {
  const configuredRoot: string | undefined = environment.CLAUDE_CONFIG_DIR;
  if (configuredRoot === undefined) throw new StartupBootError("Claude Startup requires CLAUDE_CONFIG_DIR to name the selected Startup root");
  const directory: string = canonicalStartupRoot(configuredRoot, false);
  const configured: string = join(directory, "hooks", "herdr-agent-state.sh");
  const settings: string = join(directory, "settings.json");
  assertStartupPath(directory, configured, "file");
  assertStartupPath(directory, settings, "file");
  if (!existsSync(configured) || !existsSync(settings))
    throw new StartupBootError(`Startup requires the managed Herdr Claude integration; run herdr integration install claude so ${configured} and ${settings} exist`);
  for (const path of [configured, settings]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new StartupBootError(`Claude integration file must be a regular owner-only file under the selected Startup root: ${path}`);
  }
  const path: string = realpathSync(configured);
  const source: string = readFileSync(path, "utf8");
  if (!/^# HERDR_INTEGRATION_ID=claude$/m.test(source) || !/^# HERDR_INTEGRATION_VERSION=[1-9]\d*$/m.test(source))
    throw new StartupBootError(`Startup requires the managed Herdr Claude integration headers in ${configured}; reinstall it with herdr integration install claude`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(settings, "utf8")); }
  catch (error: unknown) {
    throw new StartupBootError(`Claude settings are not valid JSON: ${settings}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) throw new StartupBootError(`Claude settings are not valid hook configuration: ${settings}: ${parsed.error.message}`);
  const commands: readonly string[] = (parsed.data.hooks?.SessionStart ?? []).flatMap((entry) => entry.hooks.flatMap((entry) => entry.type === "command" && entry.command !== undefined ? [entry.command] : []));
  if (!commands.some((command) => command.includes(configured) || command.includes(path)))
    throw new StartupBootError(`Herdr Claude integration ${configured} is not registered as a SessionStart hook in ${settings}; reinstall it with herdr integration install claude`);
  return path;
}
const trustSchema = z.looseObject({ projects: z.record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() })).optional() });
export function requireClaudeTrust(input: Readonly<{ boundRoot: string; startupRoot: string; claudeJson: string }>): void {
  assertStartupPath(input.startupRoot, input.claudeJson, "file");
  const stat = existsSync(input.claudeJson) ? lstatSync(input.claudeJson) : null;
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new StartupBootError(`Claude trust state must be a regular Startup-owned file: ${input.claudeJson}`);
  let state: z.infer<typeof trustSchema>;
  try { state = trustSchema.parse(JSON.parse(readFileSync(input.claudeJson, "utf8"))); }
  catch (error: unknown) {
    throw new StartupBootError(`Cannot read Claude Code workspace trust from ${input.claudeJson}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let directory: string = input.boundRoot;
  while (true) {
    if (state.projects?.[directory]?.hasTrustDialogAccepted === true) return;
    const parent: string = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new StartupBootError(`Claude Code has not accepted workspace trust for ${input.boundRoot}; run claude in that directory once, accept the trust dialog, then retry Startup`);
}
