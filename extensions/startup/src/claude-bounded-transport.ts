import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** The socket is private to the current OS user, not an authenticated Claude identity. */
export async function serveClaudeBoundedHooks(host: { hook(raw: unknown): Record<string, unknown>; close(): void }, call?: (request: unknown) => Promise<unknown>): Promise<{ socket: string; close(): Promise<void> }> {
  const directory = mkdtempSync(join(tmpdir(), "claude-bounded-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "hook.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (part: string) => {
      buffer += part;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const raw: unknown = JSON.parse(buffer.slice(0, end));
        const request = z.strictObject({ kind: z.literal("mcp"), request: z.unknown() }).safeParse(raw);
        if (request.success && call) {
          void call(request.data.request).then((reply) => socket.end(JSON.stringify(reply) + "\n"), () => socket.destroy());
        } else socket.end(JSON.stringify(host.hook(raw)) + "\n");
      } catch { socket.destroy(); }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(path, () => { server.removeListener("error", listening.reject); listening.resolve(); });
    await listening.promise;
    chmodSync(path, 0o600);
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  return { socket: path, async close() {
    host.close();
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    rmSync(directory, { recursive: true, force: true });
  } };
}

/** Settings fragment to merge only into the explicitly launched Claude session. */
export function claudeBoundedHookSettings(bun: string, script: string): object {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(bun)} ${quote(script)}`;
  return { hooks: {
    ...Object.fromEntries(["PreToolUse", "PostToolUse", "PostToolUseFailure"].map((event) => [event, [{ matcher: event === "PreToolUse" ? "Agent|^mcp__bounded__.*" : "Agent", hooks: [{ type: "command", command, timeout: 30, ...(event === "PreToolUse" ? { onFailure: "block" } : {}) }] }]])),
    UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 30, onFailure: "block" }] }],
  } };
}
