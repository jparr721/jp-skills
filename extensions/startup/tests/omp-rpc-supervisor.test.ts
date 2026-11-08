import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createReviewObservation, OmpReviewRejectedError, OmpRpcStartupError, startOwnedOmpRpc, type ExpectedReview } from "../src/omp-rpc-supervisor";

const head = "a".repeat(40);
const review = { scopeId: "scope", itemId: "item", assignmentKey: "review-1", reviewId: "review-id", reviewerId: "ReviewOne", head, worktree: "/repo" };
const changes = [{ changeId: "item", head, worktree: "/repo" }];
const lifecycle = (status: string, parentToolCallId: string) => ({ type: "subagent_lifecycle", payload: { id: "ReviewOne", agent: "reviewer", status, parentToolCallId, sessionFile: "/run/review.jsonl" } });
const transcript = { sessionFile: "/run/review.jsonl", messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ changes, verdict: "approve" }) }] }] };

test("review evidence requires the reserved token on the same native invocation", () => {
  const progress = (token: string, parentToolCallId: string) => ({ type: "subagent_progress", payload: { agent: "reviewer", parentToolCallId, sessionFile: "/run/review.jsonl", assignment: `review-token:${token} ${JSON.stringify(changes)}`, progress: { id: "ReviewOne" } } });
  const events = [lifecycle("started", "native"), progress("secret", "native"), lifecycle("completed", "native")];
  const evidence = createReviewObservation({ review, token: "secret", events, transcript });
  expect(evidence).toMatchObject({ reviewId: "review-id", reviewerId: "ReviewOne", invocationId: "native", head, verdict: "approve" });
  expect(() => createReviewObservation({ review, token: "wrong", events, transcript })).toThrow();
  expect(() => createReviewObservation({ review, token: "secret", events: [lifecycle("started", "native"), { ...progress("secret", "native"), payload: { ...progress("secret", "native").payload, assignment: "review-token:secret" } }, lifecycle("completed", "native")], transcript })).toThrow();
  expect(() => createReviewObservation({ review: { ...review, head: "b".repeat(40) }, token: "secret", events, transcript })).toThrow();
  expect(() => createReviewObservation({ review, token: "secret", events: [lifecycle("started", "native"), progress("secret", "other"), lifecycle("completed", "native")], transcript })).toThrow();
  expect(() => createReviewObservation({ review, token: "secret", events: [...events, progress("secret", "other")], transcript })).toThrow();
  expect(() => createReviewObservation({ review, token: "secret", events, transcript: { ...transcript, sessionFile: "/foreign" } })).toThrow();
  expect(createReviewObservation({ review, token: "secret", events, transcript: { ...transcript, messages: [{ role: "assistant", content: [{ type: "text", text: "invalid JSON" }] }] } }).verdict).toBe("invalid");
  for (const terminal of ["failed", "cancelled"]) {
    expect(createReviewObservation({ review, token: "secret", events: [lifecycle("started", "native"), progress("secret", "native"), lifecycle(terminal, "native")], transcript: undefined }).verdict).toBe("invalid");
    expect(() => createReviewObservation({ review, token: "secret", events: [lifecycle("started", "native"), progress("secret", "native"), lifecycle(terminal, "other")], transcript: undefined })).toThrow();
  }
});

test.skipIf(!Bun.which("omp"))("owned OMP RPC process responds and journals lifecycle when installed", async () => {
  const binary = Bun.which("omp");
  if (!binary) throw new Error("OMP executable disappeared before the test started");
  const directory = mkdtempSync(join(tmpdir(), "omp-rpc-owner-"));
  const path = join(directory, "journal.jsonl");
  try {
    const client = await startOwnedOmpRpc({ binary, args: ["--mode", "rpc", "--no-ui", "--no-extensions", "--no-skills", "--no-context-files", "--no-session"], cwd: process.cwd(), env: process.env, journalPath: path, timeoutMs: 15000 });
    const state = await client.call({ type: "get_state" });
    expect(state).toMatchObject({ type: "response", command: "get_state", success: true });
    const agents = await client.call({ type: "get_subagents" });
    expect(agents).toMatchObject({ type: "response", command: "get_subagents", success: true });
    await client.close();
    expect(readFileSync(path, "utf8")).toContain('"kind":"exit"');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);


test.skipIf(!Bun.which("omp"))("owned RPC host tool reserves before native execution on a real OMP host", async () => {
  const binary = Bun.which("omp");
  if (!binary) throw new Error("OMP executable disappeared before the test started");
  const directory = mkdtempSync(join(tmpdir(), "omp-rpc-reserve-"));
  const extension = join(directory, "probe.ts");
  const captured = Promise.withResolvers<ExpectedReview>();
  writeFileSync(extension, `export default function(pi) { pi.registerCommand("reserve-probe", { description: "probe", handler: async (_args, ctx) => { const session = pi.pi.AgentRegistry.global().get(ctx.agent.id).session; const tool = session.getToolByName("startup_review_reserve"); await tool.execute("reserve-call", ${JSON.stringify(review)}); } }); }`);
  try {
    const client = await startOwnedOmpRpc({ binary, args: ["--mode", "rpc", "--no-ui", "--no-extensions", "--no-skills", "--no-context-files", "--no-session", "--extension", extension], cwd: process.cwd(), env: process.env, journalPath: join(directory, "journal"), timeoutMs: 15000, reserveReview: async (input) => { captured.resolve(input); } });
    try {
      await client.call({ type: "prompt", message: "/reserve-probe" });
      expect(await Promise.race([captured.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("host tool was not called")), 10000))])).toEqual(review);
    } finally { await client.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);


test.skipIf(!Bun.which("omp"))("bounded entry requests coordinator review before native reviewer starts on real OMP", async () => {
  const binary = Bun.which("omp");
  if (!binary) throw new Error("OMP executable disappeared before the test started");
  const directory = mkdtempSync(join(tmpdir(), "omp-bounded-rpc-"));
  const extension = join(directory, "probe.ts");
  mkdirSync(join(directory, "repo"));
  const root = realpathSync(join(directory, "repo"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root });
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const boundedPath = join(import.meta.dir, "../bounded-entry.ts");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ headRefOid: actualHead, baseRefName: "main", state: "OPEN", isDraft: false, url: "https://example.test/pr/1", mergeCommit: null })}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const calls: string[] = [];
  let reservationAttempts = 0;
  const reservationIds: string[] = [];
  const reserved = Promise.withResolvers<ExpectedReview>();
  const started = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  const report = Promise.withResolvers<void>();
  const source = `import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import boundedEntry from ${JSON.stringify(boundedPath)};
export default function(pi) {
 boundedEntry(pi);
 pi.registerProvider("rpc-fixture", { api: "rpc-fixture", apiKey: "offline", baseUrl: "http://127.0.0.1:1", models: [{id:"offline",name:"offline",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}], streamSimple: (model) => { const msg={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"text",text:${JSON.stringify(JSON.stringify({changes:[{changeId:"item",head:actualHead,worktree:root}],verdict:"approve"}))}}],stopReason:"stop",timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}; const stream=createAssistantMessageEventStream();stream.push({type:"start",partial:msg});stream.push({type:"done",reason:"stop",message:msg});stream.end();return stream; } });
 pi.on("before_subagent_spawn", () => ({model:"rpc-fixture/offline"}));
 pi.registerCommand("bounded-reserve-probe", {description:"probe",handler:async(_args,ctx)=> { const s=pi.pi.AgentRegistry.global().get(ctx.agent.id).session; const call=(name,args)=>s.getToolByName(name).execute("probe-"+name,args); await call("startup_run_report",{eventId:"question-1",kind:"question",text:"Need input"}); const begin=JSON.parse((await call("bounded_begin",{workflow:"pipeline",itemIds:["item"],reviewLimit:2,execution:"manager-led",landing:{mode:"ready-pr",target:"main"}})).content[0].text); const args={scopeId:begin.scopeId,itemId:"item",assignmentKey:"review-1",context:"read only",tasks:[{name:"ReviewOne",agent:"reviewer",task:"Review",solutionSpace:"read only"}],review:[{changeId:"item",head:${JSON.stringify(actualHead)},worktree:${JSON.stringify(root)}}]}; try { await call("task",args); } catch {} try { await call("task",args); } catch {} await call("task",args); await new Promise(resolve=>setTimeout(resolve,1000)); await call("bounded_complete",{scopeId:begin.scopeId,itemId:"item",worktree:${JSON.stringify(root)},head:${JSON.stringify(actualHead)},prNumber:1}); }});
}`;
  writeFileSync(extension, source);
  try {
    const client = await startOwnedOmpRpc({ binary, args: ["--mode", "rpc", "--no-ui", "--no-extensions", "--no-skills", "--no-context-files", "--extension", extension], cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, JP_STARTUP_MANAGER_RPC: "1" }, journalPath: join(directory, "journal"), timeoutMs: 15000, reserveReview: async (entry) => { reservationIds.push(entry.reviewId); if (++reservationAttempts <= 3) throw new Error("transient reservation failure"); if (reservationAttempts === 4) throw new OmpReviewRejectedError("definite rejection"); calls.push("reserved"); reserved.resolve(entry); }, completeRun: async (hint) => { expect(hint).toMatchObject({ itemId: "item", head: actualHead, worktree: root, prNumber: 1 }); completion.resolve(); }, reportRun: async (entry) => { expect(entry).toEqual({ eventId: "question-1", kind: "question", text: "Need input" }); report.resolve(); }, onNativeEvent: (event) => { if (typeof event === "object" && event !== null && "type" in event && event.type === "subagent_lifecycle" && "payload" in event && typeof event.payload === "object" && event.payload !== null && "status" in event.payload && event.payload.status === "started") { calls.push("started"); started.resolve(); } if (typeof event === "object" && event !== null && "type" in event && event.type === "subagent_lifecycle" && "payload" in event && typeof event.payload === "object" && event.payload !== null && "status" in event.payload && event.payload.status === "completed") completed.resolve(); } });
    try {
      await client.call({ type: "prompt", message: "/bounded-reserve-probe" });
      await Promise.race([report.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("report callback not called")), 10000))]);
      const entry = await Promise.race([reserved.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("review reservation not called")), 10000))]);
      await Promise.race([started.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reviewer not started")), 10000))]);
      expect(entry).toMatchObject({ itemId: "item", head: actualHead, worktree: root, reviewerId: "ReviewOne" });
      expect(calls.slice(0, 2)).toEqual(["reserved", "started"]);
      expect(reservationAttempts).toBe(5);
      expect(new Set(reservationIds.slice(0, 4)).size).toBe(1);
      expect(reservationIds[4]).not.toBe(reservationIds[0]);
      await Promise.race([completed.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reviewer not completed")), 10000))]);
      expect(await client.observeReview(entry)).toMatchObject({ reviewId: entry.reviewId, reviewerId: "ReviewOne", head: actualHead, verdict: "approve" });
      await Promise.race([completion.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("completion callback not called")), 5000))]);
    } finally { await client.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);

test.skipIf(!Bun.which("omp"))("real OMP steer delivers to running and idle sessions", async () => {
  const binary = Bun.which("omp");
  if (!binary) throw new Error("OMP executable disappeared before the test started");
  const directory = mkdtempSync(join(tmpdir(), "omp-steer-"));
  const extension = join(directory, "offline.ts");
  writeFileSync(extension, `import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
export default function(pi) {
  pi.registerProvider("steer-fixture", { api: "steer-fixture", apiKey: "offline", baseUrl: "http://127.0.0.1:1", models: [{id:"offline",name:"offline",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}], streamSimple: (model) => {
    const msg={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[{type:"text",text:"done"}],stopReason:"stop",timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const stream=createAssistantMessageEventStream(); stream.push({type:"start",partial:msg}); setTimeout(()=>{stream.push({type:"done",reason:"stop",message:msg});stream.end()},800); return stream;
  } });
  pi.on("session_start", async (_event, ctx) => { const model = ctx.modelRegistry.find("steer-fixture", "offline"); if (!model) throw new Error("fixture model unavailable"); await pi.setModel(model); });
}`);
  try {
    const client = await startOwnedOmpRpc({ binary, args: ["--mode", "rpc", "--no-ui", "--no-extensions", "--no-skills", "--no-context-files", "--no-session", "--extension", extension], cwd: directory, env: process.env, journalPath: join(directory, "journal"), timeoutMs: 15000 });
    try {
      const until = async (predicate: () => Promise<boolean>): Promise<void> => {
        for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await Bun.sleep(50); }
        throw new Error("OMP steer fixture timed out");
      };
      const state = async (): Promise<boolean> => z.object({ data: z.object({ isStreaming: z.boolean() }) }).parse(await client.call({ type: "get_state" })).data.isStreaming;
      const contains = async (message: string): Promise<boolean> => JSON.stringify(await client.call({ type: "get_messages" })).includes(message);
      await client.call({ type: "prompt", message: "initial run" });
      await until(state);
      await client.call({ type: "steer", message: "running follow-up" });
      await until(() => contains("running follow-up"));
      await until(async () => !await state());
      await client.call({ type: "steer", message: "idle follow-up" });
      await until(() => contains("idle follow-up"));
    } finally { await client.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);


test("missing OMP process reports verified pre-prompt startup failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-missing-"));
  try {
    await expect(startOwnedOmpRpc({ binary: join(directory, "missing-omp"), args: [], cwd: directory, env: process.env, journalPath: join(directory, "journal"), timeoutMs: 1000 })).rejects.toBeInstanceOf(OmpRpcStartupError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
