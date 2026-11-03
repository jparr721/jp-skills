import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeApprovalGate, verifyClaudeHumanGo } from "../src/claude-bounded-approval";

function fixture() {
  const configRoot = mkdtempSync(join(tmpdir(), "claude-approval-test-"));
  const directory = join(configRoot, "projects", "workspace");
  mkdirSync(directory, { recursive: true });
  const transcript = join(directory, "session.jsonl");
  const input = { configRoot, sessionId: "session", transcript, promptId: "prompt-1" };
  const row = (origin: string, promptId = "prompt-1", sessionId = "session") => ({ type: "user", sessionId, uuid: "row-1", promptId, origin: { kind: origin }, message: { content: "go" } });
  const write = (value: unknown) => writeFileSync(transcript, JSON.stringify(value) + "\n");
  return { configRoot, directory, transcript, input, row, write };
}

test("only a correlated human prompt in the selected session transcript approves", () => {
  const f = fixture();
  try {
    f.write(f.row("human"));
    expect(verifyClaudeHumanGo(f.input)).toBe(true);
    expect(verifyClaudeHumanGo({ ...f.input, promptId: "another" })).toBe(false);
    f.write(f.row("task-notification"));
    expect(verifyClaudeHumanGo(f.input)).toBe(false);
    f.write(f.row("human", "prompt-1", "other-session"));
    expect(verifyClaudeHumanGo(f.input)).toBe(false);
    f.write({ ...f.row("human"), origin: undefined });
    expect(verifyClaudeHumanGo(f.input)).toBe(false);
  } finally { rmSync(f.configRoot, { recursive: true, force: true }); }
});

test("missing, partial, wrong-path and symlink transcript evidence fails closed", () => {
  const f = fixture();
  try {
    expect(verifyClaudeHumanGo(f.input)).toBe(false);
    writeFileSync(f.transcript, JSON.stringify(f.row("human")));
    expect(verifyClaudeHumanGo(f.input)).toBe(false);
    f.write(f.row("human"));
    expect(verifyClaudeHumanGo({ ...f.input, sessionId: "wrong" })).toBe(false);
    const link = join(f.directory, "other.jsonl");
    symlinkSync(f.transcript, link);
    expect(verifyClaudeHumanGo({ ...f.input, transcript: link, sessionId: "other" })).toBe(false);
  } finally { rmSync(f.configRoot, { recursive: true, force: true }); }
});

test("human go is single-use and bound to the pending scope, head and prompt", () => {
  const f = fixture();
  try {
    const gate = new ClaudeApprovalGate("session", f.configRoot);
    const event = { sessionId: "session", prompt: "go", promptId: "prompt-1", transcript: f.transcript };
    gate.observe(event);
    gate.request("scope", "head");
    gate.observe(event);
    f.write(f.row("human"));
    expect(gate.authorized("scope", "head")).toBe(false);
    expect(() => gate.request("other", "head")).toThrow();
    gate.observe({ ...event, promptId: "prompt-2" });
    f.write(f.row("task-notification", "prompt-2"));
    expect(gate.authorized("scope", "head")).toBe(false);
    f.write(f.row("human", "prompt-2"));
    expect(gate.authorized("scope", "other-head")).toBe(false);
    expect(gate.authorized("other", "head")).toBe(false);
    expect(gate.authorized("scope", "head")).toBe(true);
    gate.consume("scope", "head");
    expect(gate.authorized("scope", "head")).toBe(false);
  } finally { rmSync(f.configRoot, { recursive: true, force: true }); }
});
