import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ledgerEvent, splitLines } from "./claude-ledger";

/** Correlate the hook's prompt ID with a native human row, not just hook text. */
export function verifyClaudeHumanGo(input: { configRoot: string; sessionId: string; transcript: string; promptId: string }): boolean {
  try {
    if (!isAbsolute(input.transcript) || basename(input.transcript) !== `${input.sessionId}.jsonl` || lstatSync(input.transcript).isSymbolicLink()) return false;
    const root = realpathSync(join(input.configRoot, "projects"));
    const file = realpathSync(input.transcript);
    const inside = relative(root, file);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return false;
    for (const line of splitLines(readFileSync(file, "utf8")).lines) {
      if (!line) continue;
      const row: unknown = JSON.parse(line);
      const identity = z.object({ sessionId: z.literal(input.sessionId) }).safeParse(row);
      if (!identity.success) continue;
      const event = ledgerEvent(row);
      if (event?.kind === "human" && event.promptId === input.promptId && event.text.trim().toLowerCase() === "go" && event.images.length === 0) return true;
    }
  } catch { return false; }
  return false;
}

/** Approval is single-use and bound before the native user prompt arrives. */
export class ClaudeApprovalGate {
  private pending: { scopeId: string; head: string; candidate?: { promptId: string; transcript: string } } | undefined;
  private readonly seen = new Set<string>();
  private readonly approved = new Set<string>();
  constructor(private readonly sessionId: string, private readonly configRoot: string) {}
  request(scopeId: string, head: string): void {
    if (this.pending && (this.pending.scopeId !== scopeId || this.pending.head !== head)) throw new Error("A different scope or head already awaits approval");
    this.pending ??= { scopeId, head };
  }
  observe(event: { sessionId: string; agentId?: string; prompt: string; promptId?: string; transcript?: string }): void {
    if (event.sessionId !== this.sessionId || event.agentId || !event.promptId || this.seen.has(event.promptId)) return;
    this.seen.add(event.promptId);
    if (event.prompt.trim().toLowerCase() === "go" && event.transcript && this.pending) this.pending.candidate = { promptId: event.promptId, transcript: event.transcript };
  }
  authorized(scopeId: string, head: string): boolean {
    const key = `${scopeId}:${head}`;
    if (this.approved.has(key)) return true;
    const pending = this.pending;
    if (!pending || pending.scopeId !== scopeId || pending.head !== head || !pending.candidate || !verifyClaudeHumanGo({ configRoot: this.configRoot, sessionId: this.sessionId, ...pending.candidate })) return false;
    this.approved.add(key);
    this.pending = undefined;
    return true;
  }
  consume(scopeId: string, head: string): void { this.approved.delete(`${scopeId}:${head}`); }
}
