import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerEvent, priorEventCount, splitLines, TranscriptFormatError, TranscriptTail, type LedgerEvent } from "../src/claude-ledger";

const roots: string[] = [];
const tails: TranscriptTail[] = [];
afterEach(() => {
  for (const tail of tails.splice(0)) tail.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-ledger-")));
  roots.push(root);
  return root;
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

const session = "16eda9d5-30a8-468e-965d-196304fff106";
const common = { userType: "external", entrypoint: "cli", cwd: "/work", sessionId: session, version: "2.1.302", gitBranch: "HEAD" };
const humanRow = {
  parentUuid: "6f79352a-8390-4b22-8d5f-69f6f957f0c6", isSidechain: false, promptId: "7f82adc6-7e6d-4427-906d-4a5274389fd1", type: "user",
  message: { role: "user", content: "Reply with exactly ONE" },
  uuid: "25c8ae83-d9e1-4ef8-8a2d-1ff6b1505e73", timestamp: "2026-10-16T23:46:03.582Z", permissionMode: "bypassPermissions",
  origin: { kind: "human" }, promptSource: "typed", turnOrigin: "human", turnPosition: { promptIndex: 1, turnIndex: 1 }, ...common,
};
const skillExpansionRow = {
  parentUuid: "eccd716a-2f10-4fbf-a2e7-458e883e362e", isSidechain: false, promptId: "7f82adc6-7e6d-4427-906d-4a5274389fd1", type: "user",
  message: { role: "user", content: "<command-message>workflow-authoring</command-message>\n<command-name>workflow-authoring</command-name>\n<skill-format>true</skill-format>" },
  isMeta: true, turnCompanion: true, uuid: "653c5722-30a5-4a6c-964d-b4fdfc670016", timestamp: "2026-10-16T23:46:03.720Z", ...common,
};
const stopSummaryRow = {
  parentUuid: "86a4b224-2a5b-4124-bb17-2019aa06d609", isSidechain: false, type: "system", subtype: "stop_hook_summary", hookCount: 1,
  hookInfos: [{ command: "/work/hook.sh Stop", durationMs: 70 }], hookErrors: [], hookAdditionalContext: [], preventedContinuation: false,
  stopReason: "", hasOutput: false, level: "suggestion", timestamp: "2026-10-16T23:46:07.419Z", uuid: "61bbb199-775e-410e-8c28-af1fbf667db2",
  toolUseID: "8145680c-4470-464b-b7d8-1bf08ec20264", session_id: session, ...common,
};
const turnDurationRow = {
  parentUuid: "61bbb199-775e-410e-8c28-af1fbf667db2", isSidechain: false, type: "system", subtype: "turn_duration", durationMs: 3848, messageCount: 25,
  timestamp: "2026-10-16T23:46:07.421Z", uuid: "deffc2fe-1f7d-478a-bc08-3c4272ced074", isMeta: false, ...common,
};
const enqueueRow = { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-16T23:46:19.149Z", sessionId: session, content: "Reply with exactly THREE" };
const removeRow = {
  type: "queue-operation", operation: "remove", timestamp: "2026-10-16T23:46:24.188Z", sessionId: session, content: "Reply with exactly THREE",
  reason: "absorbed_mid_turn", commandUuid: "e53dbf84-be49-4030-898f-00da338307c7", deliveryId: "e7f4e588-80ef-4db8-a662-50b9e964aaaf",
};
const dequeueRow = { type: "queue-operation", operation: "dequeue", timestamp: "2026-10-16T23:47:11.388Z", sessionId: session };
const toolResultRow = {
  parentUuid: "8bc3172e-c4ea-4f08-92ac-d0313fa56dd3", isSidechain: false, promptId: "8c1250e6-7d62-4ac4-a69e-4d02db0a366c", type: "user",
  message: { role: "user", content: [{ tool_use_id: "toolu_01WuQgLdYLCh3bTgLAyspWhW", type: "tool_result", content: "", is_error: false }] },
  uuid: "8893066a-ba9e-43c4-aa55-7e37a860a621", timestamp: "2026-10-16T23:46:24.181Z",
  toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
  sourceToolAssistantUUID: "8bc3172e-c4ea-4f08-92ac-d0313fa56dd3", session_id: session, ...common,
};
const queuedCommandRow = {
  parentUuid: "8893066a-ba9e-43c4-aa55-7e37a860a621", isSidechain: false,
  attachment: {
    type: "queued_command", prompt: "Reply with exactly THREE", source_uuid: "e53dbf84-be49-4030-898f-00da338307c7", delivery_id: "e7f4e588-80ef-4db8-a662-50b9e964aaaf",
    commandMode: "prompt", origin: { kind: "human" }, timestamp: "2026-10-16T23:46:19.086Z", humanTurn: true,
  },
  type: "attachment", uuid: "91a167ba-4867-4ebe-a20f-fac8dabe222d", timestamp: "2026-10-16T23:46:19.086Z",
  rendered: [{ content: "<system-reminder>\nThe user sent a new message while you were working:\nReply with exactly THREE\n</system-reminder>" }],
  renderedRole: "system", session_id: session, ...common,
};
const interruptRow = {
  parentUuid: "5304c328-925b-4ba7-a468-847af6e56616", isSidechain: false, promptId: "0d63d44e-f9ff-4add-b0b3-fa9a30b67d3d", type: "user",
  message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  uuid: "e91c8548-46a3-417c-b165-60825377143b", timestamp: "2026-10-16T23:47:02.265Z", interruptedMessageId: "msg_011Cg6oqE85y69o1emAyF4FS", session_id: session, ...common,
};
const toolInterruptRow = { ...interruptRow, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } };
const blockedWakeRow = {
  parentUuid: "e91c8548-46a3-417c-b165-60825377143b", isSidechain: false, type: "system", subtype: "informational",
  content: "UserPromptSubmit operation blocked by hook:\nBEGIN_TURN_REFUSED", isMeta: false, timestamp: "2026-10-16T23:47:11.449Z",
  uuid: "f796ea4f-8820-4a36-9202-44ee6dbd11f6", level: "warning", preventContinuation: true,
  promptSubmitEnding: { ending: { kind: "blocked_by_hook", reason: "BEGIN_TURN_REFUSED" }, promptKept: false }, ...common,
};
const taskNotificationRow = {
  parentUuid: "27adc5b5-8c98-4b60-83d3-e9b5127dcf00", isSidechain: false, promptId: "180cf0d8-87c3-4ffb-ba6a-a65e65f402ac", type: "user",
  message: { role: "user", content: "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command \"UserPromptSubmit\": startup-cue: reply with exactly WOKEN2\n\n</system-reminder>" },
  uuid: "d6ff4494-fddc-4a6f-8ad2-11f79de504ed", timestamp: "2026-10-16T23:48:04.848Z", permissionMode: "bypassPermissions",
  origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", turnOrigin: "task_notification",
  turnPosition: { promptIndex: 4, turnIndex: 5 }, queueSkipAttachments: true, ...common,
};
const compactRow = {
  type: "system", subtype: "compact_boundary", session_id: "aaaaaaaa-1111-4222-8333-000000000001", uuid: "f8e32c72-6b6c-4460-8618-1ecd2f88c974",
  compact_metadata: { trigger: "manual", pre_tokens: 33186, post_tokens: 1093 }, logical_parent_uuid: "23388ec4-ac92-4c1a-9bca-3631b0a0bcb5",
};
const hookContextRow = {
  parentUuid: "25c8ae83-d9e1-4ef8-8a2d-1ff6b1505e73", isSidechain: false, type: "attachment",
  attachment: { type: "hook_additional_context", content: ["live state"], hookName: "UserPromptSubmit", toolUseID: "hook-1", hookEvent: "UserPromptSubmit" },
  uuid: "1d3c9d8e-0bb5-4c3b-9b5c-0e2f8d5f3a10", timestamp: "2026-10-16T23:46:03.600Z", ...common,
};
const assistantRow = {
  parentUuid: "653c5722-30a5-4a6c-964d-b4fdfc670016", isSidechain: false, type: "assistant",
  message: { id: "msg_01", type: "message", role: "assistant", model: "claude-haiku", content: [{ type: "text", text: "ONE" }], stop_reason: "end_turn" },
  uuid: "86a4b224-2a5b-4124-bb17-2019aa06d609", timestamp: "2026-10-16T23:46:07.300Z", ...common,
};
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=" } };

test.each([
  ["human user row", humanRow, { kind: "human", id: "25c8ae83-d9e1-4ef8-8a2d-1ff6b1505e73", promptId: "7f82adc6-7e6d-4427-906d-4a5274389fd1", text: "Reply with exactly ONE", images: [] }],
  ["skill expansion meta row", skillExpansionRow, { kind: "turn_row", promptId: "7f82adc6-7e6d-4427-906d-4a5274389fd1" }],
  ["turn_duration", turnDurationRow, { kind: "end", marker: "turn_duration" }],
  ["enqueue", enqueueRow, { kind: "queue", delta: 1 }],
  ["absorbed remove", removeRow, { kind: "queue", delta: -1 }],
  ["dequeue", dequeueRow, { kind: "queue", delta: -1 }],
  ["composer popAll", { ...enqueueRow, operation: "popAll" }, { kind: "queue", delta: -1 }],
  ["composer popOne", { ...enqueueRow, operation: "popOne" }, { kind: "queue", delta: -1 }],
  ["tool result row", toolResultRow, { kind: "turn_row", promptId: "8c1250e6-7d62-4ac4-a69e-4d02db0a366c" }],
  ["human queued_command", queuedCommandRow, { kind: "human", id: "e53dbf84-be49-4030-898f-00da338307c7", promptId: null, text: "Reply with exactly THREE", images: [] }],
  ["Esc interrupt row", interruptRow, { kind: "end", marker: "interrupted" }],
  ["Esc during tool use", toolInterruptRow, { kind: "end", marker: "interrupted" }],
  ["task-notification wake row", taskNotificationRow, { kind: "turn_row", promptId: "180cf0d8-87c3-4ffb-ba6a-a65e65f402ac" }],
  ["compact_boundary", compactRow, { kind: "compact" }],
] as const)("ledgerEvent maps a real %s", (_name: string, row: unknown, event: LedgerEvent) => {
  expect(ledgerEvent(row)).toEqual(event);
});

test.each([
  ["stop_hook_summary", stopSummaryRow],
  ["blocked wake informational row", blockedWakeRow],
  ["hook_additional_context attachment", hookContextRow],
  ["assistant row", assistantRow],
  ["file-history-snapshot", { type: "file-history-snapshot", messageId: "m1", snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false }],
  ["last-prompt", { type: "last-prompt", lastPrompt: "Reply with exactly ONE", sessionId: session }],
  ["queued_command from a task notification", { ...queuedCommandRow, attachment: { ...queuedCommandRow.attachment, origin: { kind: "task-notification" } } }],
  ["queued_command without origin", { ...queuedCommandRow, attachment: { ...queuedCommandRow.attachment, origin: undefined } }],
  ["user row without promptId", { ...toolResultRow, promptId: undefined }],
])("ledgerEvent ignores an unrelated %s", (_name: string, row: unknown) => {
  expect(ledgerEvent(row)).toBeNull();
});

test("ledgerEvent receipts human text blocks and images and never treats typed interrupt text as an end marker", () => {
  expect(ledgerEvent({ ...humanRow, message: { role: "user", content: [image, { type: "text", text: "Look at" }, { type: "text", text: "this" }] } }))
    .toEqual({ kind: "human", id: humanRow.uuid, promptId: humanRow.promptId, text: "Look at\nthis", images: [image] });
  expect(ledgerEvent({ ...queuedCommandRow, attachment: { ...queuedCommandRow.attachment, prompt: [{ type: "text", text: "and this" }, image] } }))
    .toEqual({ kind: "human", id: queuedCommandRow.attachment.source_uuid, promptId: null, text: "and this", images: [image] });
  expect(ledgerEvent({ ...humanRow, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }))
    .toEqual({ kind: "human", id: humanRow.uuid, promptId: humanRow.promptId, text: "[Request interrupted by user]", images: [] });
  expect(ledgerEvent({ ...interruptRow, message: { role: "user", content: "[Request interrupted by user]" } }))
    .toEqual({ kind: "turn_row", promptId: interruptRow.promptId });
});

test.each([
  ["a non-object row", "row"],
  ["a row without a type", { uuid: "u1" }],
  ["an unknown queue operation", { ...dequeueRow, operation: "rewind" }],
  ["a system row without a subtype", { type: "system", uuid: "u1" }],
  ["a user row without message content", { ...humanRow, message: { role: "user" } }],
  ["a human row without a uuid", { ...humanRow, uuid: undefined }],
  ["a human queued_command without source_uuid", { ...queuedCommandRow, attachment: { ...queuedCommandRow.attachment, source_uuid: undefined } }],
])("ledgerEvent rejects transcript format drift: %s", (_name: string, row: unknown) => {
  expect(() => ledgerEvent(row)).toThrow(TranscriptFormatError);
});

test.each([
  ["", [], ""],
  ["partial", [], "partial"],
  ["one\n", ["one"], ""],
  ["one\ntwo\nthr", ["one", "two"], "thr"],
  ["\n\nx\n", ["", "", "x"], ""],
] as const)("splitLines buffers the trailing partial line of %j", (buffer: string, lines: readonly string[], rest: string) => {
  expect(splitLines(buffer)).toEqual({ lines, rest });
});

test("TranscriptTail waits for a late transcript, buffers partial and multi-byte writes, and emits in order", async () => {
  const path = join(temporary(), "session.jsonl");
  const events: LedgerEvent[] = [];
  const errors: Error[] = [];
  tails.push(new TranscriptTail({ path, pollMs: 10, onEvent: async (event: LedgerEvent) => { await Bun.sleep(1); events.push(event); }, onError: (error: Error) => { errors.push(error); } }));
  await Bun.sleep(40);
  expect(events).toEqual([]);
  const human = Buffer.from(`${JSON.stringify({ ...humanRow, message: { role: "user", content: "caf\u00e9 ONE" } })}\n`);
  const split = human.indexOf(0xc3) + 1;
  writeFileSync(path, human.subarray(0, split));
  await Bun.sleep(40);
  expect(events).toEqual([]);
  appendFileSync(path, Buffer.concat([human.subarray(split), Buffer.from(`${JSON.stringify(stopSummaryRow)}\n\n${JSON.stringify(enqueueRow)}\n${JSON.stringify(turnDurationRow).slice(0, 20)}`)]));
  await until(() => events.length === 2);
  appendFileSync(path, `${JSON.stringify(turnDurationRow).slice(20)}\n${JSON.stringify(compactRow)}\n`);
  await until(() => events.length === 4);
  expect(events).toEqual([
    { kind: "human", id: humanRow.uuid, promptId: humanRow.promptId, text: "caf\u00e9 ONE", images: [] },
    { kind: "queue", delta: 1 },
    { kind: "end", marker: "turn_duration" },
    { kind: "compact" },
  ]);
  expect(errors).toEqual([]);
});

test("TranscriptTail stops emitting after close", async () => {
  const path = join(temporary(), "session.jsonl");
  writeFileSync(path, `${JSON.stringify(enqueueRow)}\n`);
  const events: LedgerEvent[] = [];
  const tail = new TranscriptTail({ path, pollMs: 10, onEvent: async (event: LedgerEvent) => { events.push(event); }, onError: (error: Error) => { throw error; } });
  tails.push(tail);
  await until(() => events.length === 1);
  tail.close();
  appendFileSync(path, `${JSON.stringify(dequeueRow)}\n`);
  await Bun.sleep(50);
  expect(events).toEqual([{ kind: "queue", delta: 1 }]);
});

test.each([
  ["an unparseable line", (path: string) => appendFileSync(path, "{not json\n"), "Claude transcript line is not JSON"],
  ["format drift", (path: string) => appendFileSync(path, `${JSON.stringify({ ...dequeueRow, operation: "rewind" })}\n`), "Unknown Claude transcript queue operation"],
  ["truncation", (path: string) => writeFileSync(path, ""), "Claude transcript shrank"],
] as const)("TranscriptTail reports %s once and stops", async (_name: string, corrupt: (path: string) => void, message: string) => {
  const path = join(temporary(), "session.jsonl");
  writeFileSync(path, `${JSON.stringify(enqueueRow)}\n`);
  const events: LedgerEvent[] = [];
  const errors: Error[] = [];
  tails.push(new TranscriptTail({ path, pollMs: 10, onEvent: async (event: LedgerEvent) => { events.push(event); }, onError: (error: Error) => { errors.push(error); } }));
  await until(() => events.length === 1);
  corrupt(path);
  await until(() => errors.length === 1);
  appendFileSync(path, `${JSON.stringify(dequeueRow)}\n`);
  await Bun.sleep(50);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(TranscriptFormatError);
  expect(errors[0]?.message).toContain(message);
  expect(errors[0]?.message).toContain(path);
  expect(events).toEqual([{ kind: "queue", delta: 1 }]);
});

test("TranscriptTail reports a rejected onEvent and stops", async () => {
  const path = join(temporary(), "session.jsonl");
  writeFileSync(path, `${JSON.stringify(enqueueRow)}\n${JSON.stringify(dequeueRow)}\n`);
  const failure = new Error("ledger rejected");
  const events: LedgerEvent[] = [];
  const errors: Error[] = [];
  tails.push(new TranscriptTail({ path, pollMs: 10, onEvent: async (event: LedgerEvent) => { events.push(event); throw failure; }, onError: (error: Error) => { errors.push(error); } }));
  await until(() => errors.length === 1);
  await Bun.sleep(30);
  expect(errors).toEqual([failure]);
  expect(events).toEqual([{ kind: "queue", delta: 1 }]);
});

test("priorEventCount counts existing ledger events and reports drift with the transcript path", () => {
  const root = temporary();
  expect(priorEventCount(join(root, "missing.jsonl"))).toBe(0);
  const path = join(root, "session.jsonl");
  writeFileSync(path, `${JSON.stringify(humanRow)}\n${JSON.stringify(assistantRow)}\n\n${JSON.stringify(enqueueRow)}\n${JSON.stringify(turnDurationRow).slice(0, 20)}`);
  expect(priorEventCount(path)).toBe(2);
  writeFileSync(path, `${JSON.stringify(humanRow)}\n{not json\n`);
  expect(() => priorEventCount(path)).toThrow(TranscriptFormatError);
  expect(() => priorEventCount(path)).toThrow(path);
  writeFileSync(path, `${JSON.stringify({ ...dequeueRow, operation: "rewind" })}\n`);
  expect(() => priorEventCount(path)).toThrow(`Unknown Claude transcript queue operation: rewind (${path})`);
});
