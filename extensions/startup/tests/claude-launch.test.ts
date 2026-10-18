import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartupBootError } from "../src/boot";
import { claudeEmployeeArgs, claudeIntegrationPath, claudeManagerArgs, claudeMcpConfig, claudeSettings, requireClaudeTrust, writeClaudeFiles } from "../src/claude-launch";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-claude-")));
  roots.push(root);
  return root;
}
const bun = "/opt/bun it's/bin/bun";
const skillsRoot = "/src/jp-skills";
const waiter = `'/opt/bun it'\\''s/bin/bun' '/src/jp-skills/extensions/startup/src/claude-waiter.ts'`;
const event = `'/opt/bun it'\\''s/bin/bun' '/src/jp-skills/extensions/startup/src/claude-event.ts'`;
const pretool = `'/opt/bun it'\\''s/bin/bun' '/src/jp-skills/extensions/startup/src/claude-pretool.ts'`;

test("Claude settings register the bridge hooks, waiter and StopFailure shim exactly", () => {
  const rewake = { type: "command", command: waiter, async: true, asyncRewake: true, timeout: 2000000 };
  expect(claudeSettings({ bun, skillsRoot })).toEqual({ hooks: {
    SessionStart: [{ hooks: [{ type: "mcp_tool", server: "startup", tool: "hook", timeout: 30, input: { sessionId: "${session_id}", event: "SessionStart", transcript: "${transcript_path}" } }, rewake] }],
    SessionEnd: [{ hooks: [{ type: "mcp_tool", server: "startup", tool: "hook", timeout: 30, input: { sessionId: "${session_id}", event: "SessionEnd" } }] }],
    UserPromptSubmit: [{ hooks: [
      { type: "mcp_tool", server: "startup", tool: "hook", timeout: 120, input: { sessionId: "${session_id}", event: "UserPromptSubmit", prompt: "${prompt}", promptId: "${prompt_id}", transcript: "${transcript_path}" } },
      rewake,
    ] }],
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: pretool, timeout: 30, onFailure: "block" }] }],
    PostToolUse: [{ matcher: "*", hooks: [{ type: "mcp_tool", server: "startup", tool: "hook", timeout: 30, input: { sessionId: "${session_id}", event: "PostToolUse", tool: "${tool_name}", agentId: "${agent_id}" } }] }],
    Stop: [{ hooks: [{ type: "mcp_tool", server: "startup", tool: "hook", timeout: 30, input: { sessionId: "${session_id}", event: "Stop", active: "${stop_hook_active}" } }] }],
    StopFailure: [{ hooks: [{ type: "command", command: event, timeout: 10 }] }],
  } });
});

test("Claude MCP config starts the stdio bridge with the absolute Bun executable", () => {
  expect(claudeMcpConfig({ bun, skillsRoot })).toEqual({ mcpServers: { startup: { type: "stdio", command: bun, args: ["/src/jp-skills/extensions/startup/claude-bridge.ts"] } } });
});

test("employee and manager argv are exact and fit the canonical line limit", () => {
  const sessionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const state = "/Users/someone/.config/jp-skills/startup/example-startup";
  const files = { settingsFile: "/Users/someone/.config/jp-skills/startup/claude/settings.json", mcpFile: "/Users/someone/.config/jp-skills/startup/claude/mcp.json" };
  const employee = claudeEmployeeArgs({ sessionId, promptFile: `${state}/launches/${sessionId}.prompt.md`, ...files, name: "s-0f8fad5bd9cb469fa16570867728", model: null, effort: null });
  expect(employee).toEqual(["--session-id", sessionId, "--append-system-prompt-file", `${state}/launches/${sessionId}.prompt.md`, "--settings", files.settingsFile, "--mcp-config", files.mcpFile, "-n", "s-0f8fad5bd9cb469fa16570867728"]);
  expect(Buffer.byteLength(["herdr", "--session", "default", "agent", "start", "s-0f8fad5bd9cb469fa16570867728", "--kind", "claude", "--pane", "w1:p12", "--", ...employee].join(" "))).toBeLessThanOrEqual(900);
  const promptFile = "/Users/someone/.config/jp-skills/startup/claude/manager.prompt.md";
  expect(claudeManagerArgs({ session: { kind: "new", id: sessionId }, promptFile, ...files })).toEqual(["--session-id", sessionId, "--append-system-prompt-file", promptFile, "--settings", files.settingsFile, "--mcp-config", files.mcpFile, "-n", "startup-manager"]);
  expect(claudeManagerArgs({ session: { kind: "resume", id: sessionId }, promptFile, ...files })).toEqual(["--resume", sessionId, "--append-system-prompt-file", promptFile, "--settings", files.settingsFile, "--mcp-config", files.mcpFile, "-n", "startup-manager"]);
});

test("Claude employee argv carries only the selected interactive CLI model and effort", () => {
  const args = claudeEmployeeArgs({ sessionId: "00000000-0000-4000-8000-000000000001", promptFile: "/startup/prompt.md", settingsFile: "/startup/settings.json", mcpFile: "/startup/mcp.json", name: "startup-dev", model: "sonnet", effort: "xhigh" });
  expect(args.slice(0, 6)).toEqual(["--session-id", "00000000-0000-4000-8000-000000000001", "--model", "sonnet", "--effort", "xhigh"]);
});

test("shared Claude files are private, created once and compared byte for byte", () => {
  const home = temporary();
  const written = writeClaudeFiles({ startupRoot: home, skillsRoot, bun });
  const directory = join(home, "startup", "claude");
  expect(written).toEqual({ settingsFile: join(directory, "settings.json"), mcpFile: join(directory, "mcp.json") });
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  for (const path of [written.settingsFile, written.mcpFile]) expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(written.settingsFile, "utf8")).toBe(JSON.stringify(claudeSettings({ bun, skillsRoot })));
  expect(readFileSync(written.mcpFile, "utf8")).toBe(JSON.stringify(claudeMcpConfig({ bun, skillsRoot })));
  expect(writeClaudeFiles({ startupRoot: home, skillsRoot, bun })).toEqual(written);
  expect(() => writeClaudeFiles({ startupRoot: home, skillsRoot: "/other/root", bun })).toThrow(StartupBootError);
  expect(readFileSync(written.mcpFile, "utf8")).toBe(JSON.stringify(claudeMcpConfig({ bun, skillsRoot })));
});

test("shared Claude files refuse symlinked and group-readable owners", () => {
  const linked = temporary();
  mkdirSync(join(linked, "startup", "claude"), { recursive: true });
  writeFileSync(join(linked, "target.json"), JSON.stringify(claudeMcpConfig({ bun, skillsRoot })));
  symlinkSync(join(linked, "target.json"), join(linked, "startup", "claude", "mcp.json"));
  expect(() => writeClaudeFiles({ startupRoot: linked, skillsRoot, bun })).toThrow(StartupBootError);
  const open = temporary();
  writeClaudeFiles({ startupRoot: open, skillsRoot, bun });
  chmodSync(join(open, "startup", "claude", "settings.json"), 0o644);
  expect(() => writeClaudeFiles({ startupRoot: open, skillsRoot, bun })).toThrow(StartupBootError);
  const redirected = temporary();
  mkdirSync(join(redirected, "startup"));
  mkdirSync(join(redirected, "elsewhere"));
  symlinkSync(join(redirected, "elsewhere"), join(redirected, "startup", "claude"));
  expect(() => writeClaudeFiles({ startupRoot: redirected, skillsRoot, bun })).toThrow(StartupBootError);
  expect(lstatSync(join(redirected, "startup", "claude")).isSymbolicLink()).toBe(true);
});

function integrationFixture(header: string, registered: boolean): Readonly<{ environment: Readonly<Record<string, string>>; hook: string }> {
  const directory = temporary();
  mkdirSync(join(directory, "hooks"));
  const hook = join(directory, "hooks", "herdr-agent-state.sh");
  writeFileSync(hook, `#!/bin/sh\n${header}\nset -eu\n`);
  chmodSync(hook, 0o600);
  const command = registered ? `bash '${hook}' session` : "bash '/elsewhere/other.sh' session";
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "^(startup|resume|clear|compact|fork)$", hooks: [{ type: "command", command, timeout: 10 }] }] } }));
  chmodSync(join(directory, "settings.json"), 0o600);
  return { environment: { CLAUDE_CONFIG_DIR: directory }, hook };
}
test("Claude Herdr integration requires its managed headers and SessionStart registration", () => {
  const valid = integrationFixture("# HERDR_INTEGRATION_ID=claude\n# HERDR_INTEGRATION_VERSION=11", true);
  expect(claudeIntegrationPath(valid.environment)).toBe(valid.hook);
});
test("Claude Herdr integration reports malformed Claude settings JSON as a boot error", () => {
  const f = integrationFixture("# HERDR_INTEGRATION_ID=claude\n# HERDR_INTEGRATION_VERSION=11", true);
  writeFileSync(join(f.environment.CLAUDE_CONFIG_DIR ?? "", "settings.json"), "{");
  expect(() => claudeIntegrationPath(f.environment)).toThrow(StartupBootError);
  expect(() => claudeIntegrationPath(f.environment)).toThrow("Claude settings are not valid JSON");
});
test.each([
  ["missing file", "", true, true],
  ["wrong integration id", "# HERDR_INTEGRATION_ID=omp\n# HERDR_INTEGRATION_VERSION=11", true, false],
  ["missing version", "# HERDR_INTEGRATION_ID=claude", true, false],
  ["not registered", "# HERDR_INTEGRATION_ID=claude\n# HERDR_INTEGRATION_VERSION=11", false, false],
])("Claude Herdr integration rejects %s", (_label, header, registered, missing) => {
  const f = integrationFixture(header, registered);
  if (missing) rmSync(f.hook);
  expect(() => claudeIntegrationPath(f.environment)).toThrow(StartupBootError);
});

function trustFixture(projects: Readonly<Record<string, Readonly<{ hasTrustDialogAccepted: boolean }>>>): Readonly<{ startupRoot: string; claudeJson: string }> {
  const startupRoot = temporary();
  const path = join(startupRoot, ".claude.json");
  writeFileSync(path, JSON.stringify({ numStartups: 3, projects }));
  chmodSync(path, 0o600);
  return { startupRoot, claudeJson: path };
}
test.each([
  ["exact root", "/work/repo", true],
  ["trusted ancestor", "/work", true],
  ["filesystem root", "/", true],
  ["untrusted root", "/work/repo", false],
  ["unrelated sibling", "/work/other", true],
  ["descendant only", "/work/repo/sub", true],
])("Claude trust preflight for %s", (_label, project, accepted) => {
  const trust = trustFixture({ [project]: { hasTrustDialogAccepted: accepted } });
  const trusted = accepted && "/work/repo".startsWith(project) && project !== "/work/repo/sub";
  if (trusted) expect(requireClaudeTrust({ boundRoot: "/work/repo", ...trust })).toBeUndefined();
  else expect(() => requireClaudeTrust({ boundRoot: "/work/repo", ...trust })).toThrow(StartupBootError);
});
test("Claude trust preflight rejects a missing or malformed Claude state file", () => {
  const directory = temporary();
  expect(() => requireClaudeTrust({ boundRoot: "/work/repo", startupRoot: directory, claudeJson: join(directory, "missing.json") })).toThrow(StartupBootError);
  writeFileSync(join(directory, "bad.json"), "{");
  chmodSync(join(directory, "bad.json"), 0o600);
  expect(() => requireClaudeTrust({ boundRoot: "/work/repo", startupRoot: directory, claudeJson: join(directory, "bad.json") })).toThrow(StartupBootError);
});
