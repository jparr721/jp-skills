import { z } from "zod";
import { ClaudeBridgeSocketError, exchangeBridge, failHook, startupRoot, waiterSocketPath, type BridgeReply } from "./claude-waiter";

const stopFailureSchema = z.looseObject({ session_id: z.string().min(1), error: z.unknown().optional() });
async function report(): Promise<void> {
  const hook = stopFailureSchema.parse(JSON.parse(await Bun.stdin.text()));
  const error: string = typeof hook.error === "string" ? hook.error : JSON.stringify(hook.error ?? null);
  const path: string = waiterSocketPath({ startupRoot: startupRoot(process.env), sessionId: hook.session_id });
  const result: BridgeReply | null = await exchangeBridge({ path, request: { sessionId: hook.session_id, event: "StopFailure", error }, connectDeadlineMs: 0 });
  if (result === null || !("received" in result)) throw new ClaudeBridgeSocketError(`Startup bridge did not receive the StopFailure report: ${JSON.stringify(result)}`);
  process.exit(0);
}
if (import.meta.main) await report().catch((error: unknown) => failHook("startup-claude-event", error));
