import { createConnection } from "node:net";
import { z } from "zod";

async function main(): Promise<void> {
  const path = z.string().min(1).parse(process.env.JP_CLAUDE_BOUNDED_SOCKET);
  const text = await Bun.stdin.text();
  const event: unknown = JSON.parse(text);
  const received = Promise.withResolvers<string>();
  const socket = createConnection(path);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(JSON.stringify(event) + "\n"));
  socket.on("data", (data: string) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { received.reject(new Error("Hook reply too large")); socket.destroy(); return; }
    const end = buffer.indexOf("\n");
    if (end >= 0) { received.resolve(buffer.slice(0, end)); socket.end(); }
  });
  socket.on("error", received.reject);
  socket.on("end", () => received.reject(new Error("Hook transport closed without a reply")));
  const reply: unknown = JSON.parse(await received.promise);
  process.stdout.write(JSON.stringify(reply));
}
main().catch((error: unknown) => { process.stderr.write(`Claude bounded hook failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
