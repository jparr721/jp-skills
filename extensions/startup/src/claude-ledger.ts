import { closeSync, existsSync, type FSWatcher, openSync, readFileSync, readSync, statSync, watch } from "node:fs";
import { z } from "zod";
import { jsonSchema, type Json } from "./contracts";

export type LedgerEvent =
  | Readonly<{ kind: "end"; marker: "turn_duration" | "interrupted" }>
  | Readonly<{ kind: "queue"; delta: 1 | -1 }>
  | Readonly<{ kind: "human"; id: string; promptId: string | null; text: string; images: readonly Json[] }>
  | Readonly<{ kind: "turn_row"; promptId: string }>
  | Readonly<{ kind: "compact" }>;
export class TranscriptFormatError extends Error {}
type TailInput = Readonly<{ path: string; onEvent: (event: LedgerEvent) => Promise<void>; pollMs: number; onError: (error: Error) => void }>;

const blockSchema = z.looseObject({ type: z.string(), text: z.string().optional() });
const contentSchema = z.union([z.string(), z.array(blockSchema)]);
const originSchema = z.object({ kind: z.string() }).optional();
const rowSchema = z.looseObject({ type: z.string() });
const systemSchema = z.object({ subtype: z.string() });
const queueSchema = z.object({ operation: z.string() });
const attachmentSchema = z.object({ attachment: z.looseObject({ type: z.string(), origin: originSchema }) });
const queuedSchema = z.object({ attachment: z.object({ source_uuid: z.string().min(1), prompt: contentSchema }) });
const userSchema = z.object({ promptId: z.string().min(1).optional(), origin: originSchema, message: z.object({ content: contentSchema }) });
const humanSchema = z.object({ uuid: z.string().min(1) });
const interruptPattern = /^\[Request interrupted by user(?: for tool use)?\]$/;

function parse<T>(schema: z.ZodType<T>, row: unknown, kind: string): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) throw new TranscriptFormatError(`Claude transcript ${kind} row does not match the supported format: ${parsed.error.message}`);
  return parsed.data;
}
function textOf(content: z.infer<typeof contentSchema>): string {
  return typeof content === "string" ? content : content.flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : []).join("\n");
}
function imagesOf(content: z.infer<typeof contentSchema>): readonly Json[] {
  return typeof content === "string" ? [] : content.filter((block) => block.type === "image").map((block) => jsonSchema.parse(block));
}
function human(id: string, promptId: string | null, content: z.infer<typeof contentSchema>): LedgerEvent {
  return { kind: "human", id, promptId, text: textOf(content), images: imagesOf(content) };
}
function systemEvent(row: unknown): LedgerEvent | null {
  const subtype = parse(systemSchema, row, "system").subtype;
  if (subtype === "turn_duration") return { kind: "end", marker: "turn_duration" };
  return subtype === "compact_boundary" ? { kind: "compact" } : null;
}
function queueEvent(row: unknown): LedgerEvent {
  const operation = parse(queueSchema, row, "queue-operation").operation;
  if (operation === "enqueue") return { kind: "queue", delta: 1 };
  if (operation === "dequeue" || operation === "remove" || operation === "popAll" || operation === "popOne") return { kind: "queue", delta: -1 };
  throw new TranscriptFormatError(`Unknown Claude transcript queue operation: ${operation}`);
}
function attachmentEvent(row: unknown): LedgerEvent | null {
  const attachment = parse(attachmentSchema, row, "attachment").attachment;
  if (attachment.type !== "queued_command" || attachment.origin?.kind !== "human") return null;
  const queued = parse(queuedSchema, row, "queued_command").attachment;
  return human(queued.source_uuid, null, queued.prompt);
}
function userEvent(row: unknown): LedgerEvent | null {
  const user = parse(userSchema, row, "user");
  if (user.origin?.kind === "human") return human(parse(humanSchema, row, "human user").uuid, user.promptId ?? null, user.message.content);
  if (typeof user.message.content !== "string" && user.message.content.some((block) => block.type === "text" && interruptPattern.test(block.text ?? "")))
    return { kind: "end", marker: "interrupted" };
  return user.promptId === undefined ? null : { kind: "turn_row", promptId: user.promptId };
}
export function ledgerEvent(row: unknown): LedgerEvent | null {
  const type = parse(rowSchema, row, "transcript").type;
  if (type === "system") return systemEvent(row);
  if (type === "queue-operation") return queueEvent(row);
  if (type === "attachment") return attachmentEvent(row);
  return type === "user" ? userEvent(row) : null;
}
export function splitLines(buffer: string): Readonly<{ lines: readonly string[]; rest: string }> {
  const parts = buffer.split("\n");
  return { lines: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}
function eventOf(line: string, path: string): LedgerEvent | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch (error) {
    throw new TranscriptFormatError(`Claude transcript line is not JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return ledgerEvent(row);
  } catch (error) {
    if (error instanceof TranscriptFormatError) throw new TranscriptFormatError(`${error.message} (${path})`);
    throw error;
  }
}
export function priorEventCount(path: string): number {
  if (!existsSync(path)) return 0;
  return splitLines(readFileSync(path, "utf8")).lines.filter((line) => line !== "" && eventOf(line, path) !== null).length;
}

export class TranscriptTail {
  private readonly input: TailInput;
  private readonly decoder: TextDecoder = new TextDecoder();
  private readonly timer: ReturnType<typeof setInterval>;
  private watcher: FSWatcher | null = null;
  private offset: number = 0;
  private rest: string = "";
  private running: boolean = false;
  private again: boolean = false;
  private closed: boolean = false;
  constructor(input: TailInput) {
    this.input = input;
    this.timer = setInterval(() => this.pump(), input.pollMs);
    this.pump();
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.watcher?.close();
    this.watcher = null;
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.close();
    this.input.onError(error instanceof Error ? error : new Error(String(error)));
  }
  private pump(): void {
    if (this.closed) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
    this.drain().catch((error: unknown) => this.fail(error)).finally(() => { this.running = false; });
  }
  private read(): string {
    const size = statSync(this.input.path).size;
    if (size < this.offset) throw new TranscriptFormatError(`Claude transcript shrank from ${this.offset} to ${size} bytes: ${this.input.path}`);
    if (size === this.offset) return "";
    const bytes = Buffer.alloc(size - this.offset);
    const descriptor = openSync(this.input.path, "r");
    try {
      const count = readSync(descriptor, bytes, 0, bytes.length, this.offset);
      this.offset += count;
      return this.decoder.decode(bytes.subarray(0, count), { stream: true });
    } finally {
      closeSync(descriptor);
    }
  }
  private async drain(): Promise<void> {
    do {
      this.again = false;
      if (!existsSync(this.input.path)) return;
      if (this.watcher === null) {
        this.watcher = watch(this.input.path, () => this.pump());
        this.watcher.on("error", (error: Error) => this.fail(error));
      }
      const { lines, rest } = splitLines(this.rest + this.read());
      this.rest = rest;
      for (const line of lines) {
        if (this.closed) return;
        if (line === "") continue;
        const event = eventOf(line, this.input.path);
        if (event !== null) await this.input.onEvent(event);
      }
    } while (this.again && !this.closed);
  }
}
