import { z } from "zod";
import { ClaudeBridgeSocketError, exchangeBridge, failHook, startupHome, waiterSocketPath, type BridgeReply } from "./claude-waiter";

const preToolSchema = z.looseObject({ session_id: z.string().min(1), tool_name: z.string().min(1), tool_input: z.unknown(), agent_id: z.string().optional() });
async function decide(): Promise<void> {
  const hook = preToolSchema.parse(JSON.parse(await Bun.stdin.text()));
  const query: string = z.object({ query: z.string() }).safeParse(hook.tool_input).data?.query ?? "";
  const path: string = waiterSocketPath({ home: startupHome(process.env), sessionId: hook.session_id });
  const result: BridgeReply | null = await exchangeBridge({ path, request: { sessionId: hook.session_id, hook: { event: "PreToolUse", tool: hook.tool_name, query, agentId: hook.agent_id ?? "" } }, connectDeadlineMs: 5000 });
  if (result === null || !("reply" in result)) throw new ClaudeBridgeSocketError(`Startup bridge gave no PreToolUse decision: ${JSON.stringify(result)}`);
  process.stdout.write(JSON.stringify(result.reply), () => process.exit(0));
}
// Any failure exits 1, which the onFailure "block" command hook turns into a denied tool call.
if (import.meta.main) await decide().catch((error: unknown) => failHook("startup-claude-pretool", error));
