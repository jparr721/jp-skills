import { fileURLToPath } from "node:url";
import { ClaudeBoundedController } from "./src/claude-bounded-controller";
import { claudeBoundedHookSettings, serveClaudeBoundedHooks } from "./src/claude-bounded-transport";

// Launch explicitly with bun claude-bounded-entry.ts [Claude arguments]. State
// exists only for this process; no Startup root, profile, or pane is required.
const args = process.argv.slice(2);
const forbidden = ["--session-id", "--resume", "--continue", "-c", "-r", "--settings", "--mcp-config", "--strict-mcp-config", "--bare", "--safe-mode"];
if (args.some((arg) => forbidden.includes(arg.split("=")[0] ?? ""))) throw new Error("Session, settings and MCP configuration are owned by the bounded launcher; resume and hook-disabling modes are not supported");
if (process.env.CLAUDE_CODE_SIMPLE === "1" || process.env.CLAUDE_CODE_SAFE_MODE === "1") throw new Error("Claude hook-disabling modes are not supported by the bounded launcher");
const claude = Bun.which("claude");
const bun = Bun.which("bun");
if (!claude || !bun) throw new Error("Claude Code and Bun must be available on PATH");
const sessionId = crypto.randomUUID();
const controller = new ClaudeBoundedController(sessionId, process.cwd());
const transport = await serveClaudeBoundedHooks(controller, (request) => controller.request(request));
try {
  const hook = fileURLToPath(new URL("./src/claude-bounded-hook.ts", import.meta.url));
  const mcp = fileURLToPath(new URL("./src/claude-bounded-mcp.ts", import.meta.url));
  const settings = claudeBoundedHookSettings(bun, hook);
  const config = { mcpServers: { bounded: { type: "stdio", command: bun, args: [mcp] } } };
  const child = Bun.spawn({ cmd: [claude, "--session-id", sessionId, "--settings", JSON.stringify(settings), "--mcp-config", JSON.stringify(config), ...args], env: { ...process.env, JP_CLAUDE_BOUNDED_SOCKET: transport.socket }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} finally { await transport.close(); }
