import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeBoundedHost } from "../src/claude-bounded-host";
import { claudeBoundedHookSettings, serveClaudeBoundedHooks } from "../src/claude-bounded-transport";
import { BoundedWorkflowHost } from "../src/workflow-host";

// Explicit opt-in: runs a real Claude session and consumes model/API budget.
// Existing authentication is opt-in; supplied hook settings remain process-local.
if (process.env.JP_CLAUDE_BOUNDED_PROBE !== "1") throw new Error("Set JP_CLAUDE_BOUNDED_PROBE=1 to run the isolated native Claude probe");
const claude = Bun.which("claude");
const bun = Bun.which("bun");
if (!claude || !bun) throw new Error("claude and bun must be available on PATH");
const sessionId = crypto.randomUUID();
const authority = new BoundedWorkflowHost("pipeline", ["probe"], 1);
const host = new ClaudeBoundedHost({ sessionId, authority, limit: 1, validateRole: () => false });
const hooks = await serveClaudeBoundedHooks(host);
const directory = mkdtempSync(join(tmpdir(), "claude-bounded-probe-"));
try {
  const assignment = host.prepare({ scopeId: authority.rootId, itemId: "probe", assignmentKey: "native-probe" });
  const settings = claudeBoundedHookSettings(bun, fileURLToPath(new URL("../src/claude-bounded-hook.ts", import.meta.url)));
  const child = Bun.spawn({ cmd: [claude, "-p", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--session-id", sessionId, "--settings", JSON.stringify(settings), "--allowedTools=Agent", `Use the Agent tool once, in the foreground, with this exact assignment marker in its prompt: ${assignment.marker}. Ask it to reply with exactly this JSON object: {"status":"completed","result":"READY"}. Do not edit files.`], cwd: directory, env: { ...process.env, ...(process.env.JP_CLAUDE_BOUNDED_EXISTING_AUTH === "1" ? {} : { CLAUDE_CONFIG_DIR: directory }), JP_CLAUDE_BOUNDED_SOCKET: hooks.socket }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const view = authority.view(authority.rootId);
  const reservation = view.reservations.find((entry) => entry.id === assignment.reservationId);
  process.stdout.write(JSON.stringify({ exitCode: code, reservation: reservation?.state ?? null, stdout, stderr }) + "\n");
  if (code !== 0 || reservation?.state !== "completed") process.exitCode = 1;
} finally { await hooks.close(); rmSync(directory, { recursive: true, force: true }); }
