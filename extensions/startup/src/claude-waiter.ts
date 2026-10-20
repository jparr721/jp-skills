import { join } from "node:path";
import { z } from "zod";
import { assertStartupPath, canonicalStartupRoot, StartupBootError } from "./boot";
import { jsonSchema, type Json } from "./contracts";
import type { Environment } from "./employee-entry";

export class ClaudeBridgeSocketError extends Error {}
export const bridgeRequestSchema = z.union([
  z.strictObject({ sessionId: z.string().min(1), transcript: z.string().startsWith("/") }),
  z.strictObject({ sessionId: z.string().min(1), event: z.literal("StopFailure"), error: z.string() }),
  z.strictObject({ sessionId: z.string().min(1), hook: z.strictObject({ event: z.literal("PreToolUse"), tool: z.string().min(1), query: z.string(), agentId: z.string() }) }),
]);
export const waiterReplySchema = z.union([
  z.strictObject({ fire: z.string() }),
  z.strictObject({ superseded: z.literal(true) }),
  z.strictObject({ received: z.literal(true) }),
  z.strictObject({ reply: z.record(z.string(), jsonSchema) }),
  z.strictObject({ error: z.string() }),
]);
export type BridgeReply = z.infer<typeof waiterReplySchema>;
const hookInputSchema = z.looseObject({ session_id: z.string().min(1), transcript_path: z.string().startsWith("/") });
const socketBytes: number = 103;

export function startupRoot(environment: Environment): string {
  const configured: string | undefined = environment.STARTUP_ROOT;
  if (configured === undefined) throw new StartupBootError("Claude Startup bridge requires the selected STARTUP_ROOT");
  if (environment.CLAUDE_CONFIG_DIR !== configured)
    throw new StartupBootError("CLAUDE_CONFIG_DIR must match the selected STARTUP_ROOT for Claude Startup hooks");
  return canonicalStartupRoot(configured, false);
}
export function waiterSocketPath(input: Readonly<{ startupRoot: string; sessionId: string }>): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.sessionId)) throw new StartupBootError("Claude Startup session ID is not a safe socket filename");
  const root: string = canonicalStartupRoot(input.startupRoot, false);
  const path: string = join(root, "startup", "claude", "w", `${input.sessionId}.sock`);
  assertStartupPath(root, path, "socket");
  if (Buffer.byteLength(path) > socketBytes)
    throw new ClaudeBridgeSocketError(`Claude Startup bridge socket path exceeds ${socketBytes} bytes; set STARTUP_ROOT to a shorter directory: ${path}`);
  return path;
}
export async function exchangeBridge(input: Readonly<{ path: string; request: Json; connectDeadlineMs: number }>): Promise<BridgeReply | null> {
  const deadline: number = Date.now() + input.connectDeadlineMs;
  let reply: (value: BridgeReply | null) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const replied: Promise<BridgeReply | null> = new Promise((resolveReply, rejectReply) => { reply = resolveReply; reject = rejectReply; });
  let buffer: string = "";
  while (true) {
    try {
      await Bun.connect({ unix: input.path, socket: {
        open(socket): void { socket.write(JSON.stringify(input.request) + "\n"); },
        data(_socket, data: Buffer): void {
          buffer += data.toString("utf8");
          const line: string | undefined = buffer.split("\n")[0];
          if (line === undefined || !buffer.includes("\n")) return;
          try { reply(waiterReplySchema.parse(jsonSchema.parse(JSON.parse(line)))); }
          catch (error: unknown) { reject(error instanceof Error ? error : new Error(String(error))); }
        },
        close(): void { reply(null); },
        error(_socket, error: Error): void { reject(error); },
      } });
      return await replied;
    } catch (error: unknown) {
      const code: string | undefined = z.object({ code: z.string() }).safeParse(error).data?.code;
      // Claude starts SessionStart hooks before its MCP servers, so the bridge socket can appear after the waiter.
      if ((code !== "ENOENT" && code !== "ECONNREFUSED") || Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
}
export function failHook(component: string, error: unknown): never {
  process.stderr.write(JSON.stringify({ level: "error", component, error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exit(1);
}
async function wait(): Promise<void> {
  const hook = hookInputSchema.parse(JSON.parse(await Bun.stdin.text()));
  const path: string = waiterSocketPath({ startupRoot: startupRoot(process.env), sessionId: hook.session_id });
  const result: BridgeReply | null = await exchangeBridge({ path, request: { sessionId: hook.session_id, transcript: hook.transcript_path }, connectDeadlineMs: 30000 });
  if (result !== null && "fire" in result) { process.stderr.write(result.fire, () => process.exit(2)); return; }
  if (result === null || "superseded" in result) process.exit(0);
  throw new ClaudeBridgeSocketError(`Startup bridge refused the waiter: ${JSON.stringify(result)}`);
}
if (import.meta.main) await wait().catch((error: unknown) => failHook("startup-claude-waiter", error));
