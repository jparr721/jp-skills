import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { z } from "zod";

const path = z.string().min(1).parse(process.env.JP_CLAUDE_BOUNDED_SOCKET);
const requestSchema = z.looseObject({ id: z.union([z.string(), z.number()]).optional() });
async function exchange(request: unknown): Promise<unknown> {
  const reply = Promise.withResolvers<unknown>();
  const socket = createConnection(path);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(JSON.stringify({ kind: "mcp", request }) + "\n"));
  socket.on("data", (part: string) => {
    buffer += part;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { reply.reject(new Error("Bounded response too large")); socket.destroy(); return; }
    const end = buffer.indexOf("\n");
    if (end >= 0) { try { reply.resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reply.reject(error); } socket.end(); }
  });
  socket.on("error", reply.reject);
  socket.on("end", () => reply.reject(new Error("Bounded authority disconnected")));
  return reply.promise;
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  try {
    const raw: unknown = JSON.parse(line);
    const parsed = requestSchema.parse(raw);
    if (parsed.id === undefined) continue;
    const response = await exchange(raw);
    process.stdout.write(JSON.stringify(response) + "\n");
  } catch (error: unknown) {
    process.stderr.write(`Bounded MCP request failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    break;
  }
}
