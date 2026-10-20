import { createHash } from "node:crypto";
import { afterEach, expect, test, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync, chmodSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";
import type { HostAPI } from "../index";
import type { NativeContext, NativeRef } from "../src/omp-adapter";
import { encode, jsonSchema, sourceSchema, type Json } from "../src/contracts";
import { bootSelection, parseBootCommand, persistBinding } from "../src/boot";
import { connectEmployee } from "../src/employee-client";
import { loadProfile } from "../src/profiles";
import { startRuntimeHost } from "../runtime-host";
import { openStore } from "../src/store";
import { openCoordinator, serveCoordinator } from "../src/coordinator";
import type { HerdrObservation, HerdrRuntime } from "../src/herdr-runtime";
const taskSetting = { get: () => 6 };
mock.module("@oh-my-pi/pi-coding-agent/task/settings", () => ({ cfgTaskBatch: taskSetting, cfgTaskEnableEffort: taskSetting, cfgTaskIsolationEnabled: taskSetting, cfgTaskMaxConcurrency: taskSetting }));
const { installLaunchedEmployee, installStartupV7, integrationPath } = await import("../v7");
const { assertNativeTranscript, nativeRoot } = await import("../src/employee-entry");
const { installLaunchedEmployeeWith } = await import("../src/employee-entry");
const omp = { harness: "omp", root: nativeRoot, integration: integrationPath } as const;
import { launchRuntimeHost, parseRuntimeHostConfig, type RuntimeHostConfig } from "../src/v7-launch";

type TestNativeSchema = ReturnType<HostAPI["zod"]["object"]>;
const publicToolProperties = {
  startup_claim: {},
  startup_settle: { result: {} },
  startup_send: {
    id: { type: "string" },
    recipient: { type: "string" },
    kind: { type: "string", enum: ["assignment", "report", "question", "answer", "alert", "duty"] },
    correlation: { type: "string" },
    payload: {},
  },
  startup_item: {},
  startup_capture: {
    captureId: { type: "string" },
    eventId: { type: "string" },
    rows: { type: "array", items: {} },
    receipt: {},
  },
  startup_staff: {},
  startup_hire: {
    requestId: { type: "string" },
    role: { type: "string", enum: ["architect", "qa", "dev", "devops", "pa"] },
    additional: { type: "number" },
  },
  startup_delegate: { eventId: { type: "string" }, developers: { type: "number" } },
  startup_activate: { employeeIds: { type: "array", items: { type: "string" } } },
  startup_replace: { employeeId: { type: "string" }, evidence: {} },
  startup_intake: {
    eventId: { type: "string" },
    input: {},
    amendItemIds: { type: "array", items: { type: "string" } },
  },
  startup_route: {
    inputId: { type: "string" },
    disposition: { type: "string", enum: ["work", "status", "control", "conversation", "decision"] },
    reason: { type: "string" },
    amendItemIds: { type: "array", items: { type: "string" } },
  },
  startup_input: { inputId: { type: "string" }, offset: { type: "number" } },
  startup_image: { inputId: { type: "string" }, index: { type: "number" } },
  startup_reconcile: { claimId: { type: "string" }, evidence: {} },
  startup_resolve: { assignmentId: { type: "string" }, evidence: {} },
  startup_finish_team: { teamId: { type: "string" }, evidence: {} },
  startup_refresh: { employeeId: { type: "string" }, evidence: {} },
  startup_block: { key: { type: "string" }, evidence: {} },
  startup_retire: { employeeIds: { type: "array", items: { type: "string" } }, evidence: {} },
} satisfies Readonly<Record<string, Readonly<Record<string, Json>>>>;

function nativeSchemaJson(value: unknown): Json {
  if (typeof value !== "object" || value === null || !("toJsonSchema" in value) || typeof value.toJsonSchema !== "function")
    throw new Error("Test OMP tool schema does not expose toJsonSchema");
  return jsonSchema.parse(value.toJsonSchema());
}
function testNativeSchema(value: Json): TestNativeSchema {
  return {
    or: (other) => {
      const previous = z.object({ anyOf: z.array(jsonSchema) }).safeParse(value);
      return testNativeSchema({ anyOf: [...(previous.success ? previous.data.anyOf : [value]), nativeSchemaJson(other)] });
    },
    and: (other) => testNativeSchema({ allOf: [value, nativeSchemaJson(other)] }),
    toJsonSchema: () => value,
  };
}
const testSchemaBuilder: HostAPI["zod"] = {
  object: (shape) => testNativeSchema({ type: "object", properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, nativeSchemaJson(value)])), required: Object.keys(shape), additionalProperties: false }),
  string: () => testNativeSchema({ type: "string" }),
  number: () => testNativeSchema({ type: "number" }),
  unknown: () => testNativeSchema({}),
  array: (schema) => testNativeSchema({ type: "array", items: nativeSchemaJson(schema) }),
  literal: (value) => testNativeSchema({ type: "string", const: value }),
  enum: (values) => testNativeSchema({ type: "string", enum: [...values] }),
};

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  return fixtureFor("default");
}
function fixtureFor(ompProfile: string) {
  const root: string = realpathSync(mkdtempSync(join(tmpdir(), "v7-entry-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const skillsRoot: string = join(root, "skills-repo");
  for (const role of ["manager", "architect", "qa", "dev", "devops", "pa"]) {
    mkdirSync(join(skillsRoot, "skills", `startup-role-${role}`), { recursive: true });
    writeFileSync(join(skillsRoot, "skills", `startup-role-${role}`, "SKILL.md"), `Complete canonical ${role} persona`);
  }
  mkdirSync(join(skillsRoot, "skills", "startup-loop"));
  writeFileSync(join(skillsRoot, "skills", "startup-loop", "SKILL.md"), "Complete canonical shared loop");
  const skillsHome: string = join(root, "home");
  mkdirSync(skillsHome, { mode: 0o700 });
  const configHome: string = join(root, "xdg");
  mkdirSync(configHome, { mode: 0o700 });
  const startupRoot: string = join(root, "startup-state");
  mkdirSync(startupRoot, { mode: 0o700 });
  const cwd: string = join(root, "repo");
  mkdirSync(cwd);
  const ompHome: string = join(root, "omp-home");
  const agentDirectory: string = ompProfile === "default" ? join(ompHome, ".omp", "agent") : join(ompHome, ".omp", "profiles", ompProfile, "agent");
  mkdirSync(join(agentDirectory, "sessions"), { recursive: true, mode: 0o700 });
  const file: string = join(agentDirectory, "sessions", "native.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id: "native-root" }) + "\n");
  const handlers = new Map<string, ((event: unknown, ctx: NativeContext) => unknown)[]>();
  const tools = new Map<string, Parameters<HostAPI["registerTool"]>[0]>();
  const commands = new Map<string, Parameters<HostAPI["registerCommand"]>[1]>();
  const messages: string[] = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  let aborts: number = 0;
  const ctx: NativeContext = {
    agent: { id: "Main", kind: "main" }, cwd,
    sessionManager: { getSessionId: () => "native-root", getSessionFile: () => file },
    getSystemPrompt: () => [],
    abort: () => { aborts += 1; },
    isIdle: () => false,
    hasPendingMessages: () => false,
    models: { resolve: () => ({ id: "model" }) },
    setInterval(callback, ms) { const timer = setInterval(callback, ms); timers.add(timer); return timer; },
    clearTimer(timer) { clearInterval(timer); timers.delete(timer); },
  };
  const ref: NativeRef = {
    id: "Main", kind: "main", status: "idle", createdAt: 1, sessionFile: file,
    session: { sessionManager: ctx.sessionManager, settings: {}, model: { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" }, thinkingLevel: "high", configuredThinkingLevel: () => "auto", getAvailableModels: () => [{ provider: "openai", id: "gpt-5.2", name: "GPT-5.2" }], getAvailableThinkingLevels: () => ["low", "high"], getPlanModeState: () => undefined, getToolByName: () => undefined },
  };
  const host: HostAPI = {
    pi: { VERSION: "18.8.9", settings: {}, AgentRegistry: { global: () => ({ get: (id) => id === "Main" ? ref : undefined, list: () => [ref], onChange: () => () => {} }) } },
    zod: testSchemaBuilder,
    arktype: () => testNativeSchema({}),
    events: { on: () => () => {} },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    getCommands: () => [...commands.keys()].map((name) => ({ name })),
    getAllTools: () => [],
    sendMessage(message) { messages.push(message.content); },
  };
  cleanup.push(() => { for (const timer of timers) clearInterval(timer); });
  const requests: Json[] = [];
  const admissions: Json[] = [];
  const pollReports: Json[] = [];
  const socketPath: string = join(root, "runtime.sock");
  let projection: string = "Complete canonical dev persona\nComplete canonical shared loop";
  let available: boolean = true;
  let commandResponse: Response | null = null;
  const channels: { close: () => void }[] = [];
  const server = Bun.serve({ unix: socketPath, websocket: { message(socket, message): void { channels.push(socket); admissions.push(z.json().parse(JSON.parse(String(message)))); socket.send(JSON.stringify({ connection: "private-token" })); } }, async fetch(request: Request, server): Promise<Response | undefined> {
    if (new URL(request.url).pathname === "/admit" && server.upgrade(request)) return;
    const path: string = new URL(request.url).pathname;
    if (path === "/disconnect") return Response.json({ revoked: true });
    if (path === "/health") return Response.json({ status: "running" });
    if (path === "/admit") { admissions.push(z.json().parse(await request.json())); return Response.json({ connection: "private-token" }); }
    if (path === "/poll" && !available) return new Response("Owned coordinator stopped", { status: 503 });
    if (path === "/poll") {
      if (request.method === "POST") pollReports.push(z.json().parse(await request.json()));
      return Response.json({ projection, pendingMessageIds: [], waitReason: null, toolBlockReason: null });
    }
    const command: Json = z.json().parse(await request.json());
    requests.push(command);
    if (z.object({ kind: z.literal("image") }).safeParse(command).success)
      return Response.json({ type: "image", data: "fixture-image", mimeType: "image/png" });
    return commandResponse?.clone() ?? Response.json(command);
  } });
  cleanup.push(() => server.stop(true));
  async function emit(name: string, event: unknown, context: NativeContext): Promise<unknown> {
    let value: unknown = undefined;
    for (const handler of handlers.get(name) ?? []) {
      const next: unknown = await handler(event, context);
      if (next !== undefined) value = next;
    }
    return value;
  }
  const integration: string = join(root, "herdr-omp-agent-state.ts");
  writeFileSync(integration, "// installed by herdr\n// HERDR_INTEGRATION_ID=omp\n// HERDR_INTEGRATION_VERSION=10\n");
  const environment: Record<string, string | undefined> = {
    HERDR_ENV: "1", HERDR_SESSION: "fixture", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", OMP_PROFILE: ompProfile === "default" ? "" : ompProfile, STARTUP_HERDR_OMP_EXTENSION: integration,
    JP_SKILLS_HOME: skillsHome, STARTUP_ROOT: startupRoot, HOME: ompHome, CLAUDE_CONFIG_DIR: startupRoot, XDG_CONFIG_HOME: configHome,
  };
  function useEnvironment(): void {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(environment)) {
      previous.set(key, process.env[key]);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    cleanup.push(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  }
  function manifest(role: "manager" | "dev"): string {
    const profile = loadProfile({ skillsRoot, role, employeeId: role === "manager" ? "manager" : "dev-1", generation: 1 });
    const startupRoot: string = join(root, "manifest-state");
    mkdirSync(startupRoot, { mode: 0o700 });
    environment.STARTUP_ROOT = startupRoot;
    environment.JP_SKILLS_HOME = skillsHome;
    const path: string = join(startupRoot, "manifest.json");
    writeFileSync(path, JSON.stringify({ socketPath, credential: "private-credential", source: profile.source, employeeId: profile.employeeId, generation: 1, profile: ompProfile, harness: "omp", skillsHome, startupRoot, skillsRoot }), { mode: 0o600 });
    useEnvironment();
    return path;
  }
  return { handlers, disconnect: () => { for (const channel of channels) channel.close(); }, root, skillsRoot, skillsHome, configHome, ompHome, agentDirectory, cwd, file, ctx, host, tools, commands, messages, requests, admissions, pollReports, socketPath, environment, useEnvironment, manifest, emit, getAborts: () => aborts, setProjection(value: string) { projection = value; }, setAvailable(value: boolean) { available = value; }, setCommandResponse(value: Response) { commandResponse = value; } };
}
function entryRoots(f: ReturnType<typeof fixture>, startupRoot: string | null = f.environment.STARTUP_ROOT ?? null) {
  if (startupRoot !== null) {
    f.environment.STARTUP_ROOT = startupRoot;
    f.environment.CLAUDE_CONFIG_DIR = startupRoot;
  }
  return { skillsHome: f.skillsHome, startupRoot, skillsRoot: f.skillsRoot };
}
function bindRuntimeFixture(f: ReturnType<typeof fixture>, config: RuntimeHostConfig): void {
  const selection = bootSelection({ cwd: f.cwd, skillsHome: config.skillsHome, startupRoot: config.startupRoot, skillsRoot: f.skillsRoot, host: hostname(), managerSession: config.managerSession, command: parseBootCommand(`new ${config.name}`), explicitName: null, executionLimit: null });
  if (selection === null) throw new Error("Missing fixture Startup selection");
  persistBinding(selection);
}

test("manager extension loads before native action methods become available", () => {
  const f = fixture();
  const host: HostAPI = { ...f.host, getCommands: () => { throw new Error("Extension runtime not initialized"); } };
  expect(() => installStartupV7(host, { ...omp,
    ...entryRoots(f), nativeLimit: () => 6, environment: f.environment,
    launch: async (config) => ({ ...config, socketPath: f.socketPath }),
  })).not.toThrow();
  expect(f.commands.has("startup")).toBe(true);
});

test("ordinary manager resume automatically reconnects the exact saved root without changing launch identity", async () => {
  const f = fixture();
  const { config: initial } = runtimeFixture(f);
  const config = { ...initial, socketPath: f.socketPath, boundRoot: realpathSync(f.cwd), skillsRoot: realpathSync(f.skillsRoot) };
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  bindRuntimeFixture(f, config);
  const path = join(config.stateDirectory, "runtime-config.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const original = readFileSync(path, "utf8");
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(f.host, { ...omp, ...entryRoots(f, config.startupRoot), nativeLimit: () => { throw new Error("Resume must reuse saved capacity"); }, environment: f.environment, launch: async (saved) => { launched.push(saved); return saved; } });
  await f.emit("session_start", {}, f.ctx);
  expect(launched).toEqual([config]);
  expect(f.admissions).toHaveLength(1);
  expect(f.admissions[0]).toMatchObject({ credential: config.managerCredential, nativeSession: f.file });
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(f.messages.join("\n")).toContain("reconnected");
  await f.emit("session_start", {}, f.ctx);
  expect(f.admissions).toHaveLength(1);
  const staff = f.tools.get("startup_staff");
  if (!staff) throw new Error("Missing staff tool");
  await expect(staff.execute("staff", {}, undefined, undefined, f.ctx)).resolves.toBeDefined();
});

test("employee reattachment restores a provider pause even after a gated turn was aborted", async () => {
  const f = fixture();
  f.useEnvironment();
  writeFileSync(f.file, readFileSync(f.file, "utf8") + [
    { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "Weekly budget exhausted" } },
    { type: "message", message: { role: "assistant", stopReason: "aborted" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  expect(f.admissions).toHaveLength(1);
  expect(z.object({ report: z.unknown() }).parse(f.pollReports[0]).report).toMatchObject({ status: "available", nativeSession: f.file, agentSessionId: "native-root", model: { id: "gpt-5.2" }, configuredEffort: "auto", effectiveEffort: "high", availableModels: [{ provider: "openai", id: "gpt-5.2" }], availableEfforts: ["low", "high"] });
  expect(f.messages.join("\n")).toContain("inference paused");
  await f.emit("context", { messages: [] }, f.ctx);
  expect(f.getAborts()).toBeGreaterThan(0);
  expect(f.requests.filter((request) => z.object({ kind: z.literal("begin_turn") }).safeParse(request).success)).toHaveLength(0);
});

test("manager resume refuses a foreign root, pane, profile or harness before using saved credentials", async () => {
  for (const mismatch of ["session", "pane", "profile", "harness"]) {
    const f = fixture();
    const { config: initial } = runtimeFixture(f);
    const config: RuntimeHostConfig = parseRuntimeHostConfig({ ...initial, socketPath: f.socketPath, boundRoot: realpathSync(f.cwd), skillsRoot: realpathSync(f.skillsRoot), ...(mismatch === "session" ? { managerSession: "another-root" } : {}), ...(mismatch === "pane" ? { managerPaneId: "other-pane" } : {}), ...(mismatch === "profile" ? { profile: "other-profile" } : {}), ...(mismatch === "harness" ? { harness: "claude" } : {}) });
    mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
    bindRuntimeFixture(f, mismatch === "session" ? { ...config, managerSession: initial.managerSession } : config);
    writeFileSync(join(config.stateDirectory, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
    let launched = false;
    installStartupV7(f.host, { ...omp, ...entryRoots(f, config.startupRoot), nativeLimit: () => 6, environment: f.environment, launch: async (saved) => { launched = true; return saved; } });
    await expect(f.emit("session_start", {}, f.ctx)).resolves.toBeUndefined();
    expect(launched).toBe(false);
    expect(f.admissions).toHaveLength(0);
    expect(f.messages.join("\n")).toContain("saved manager");
    expect(f.messages.join("\n")).not.toContain(config.managerCredential);
    expect(await f.emit("tool_call", { toolName: "bash" }, f.ctx)).toMatchObject({ block: true });
  }
});

test("manager resume retries a failed initial poll in the same root and stops its admission timer after recovery", async () => {
  const f = fixture();
  const { config: initial } = runtimeFixture(f);
  const config = { ...initial, socketPath: f.socketPath, boundRoot: realpathSync(f.cwd), skillsRoot: realpathSync(f.skillsRoot) };
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  bindRuntimeFixture(f, config);
  writeFileSync(join(config.stateDirectory, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  const callbacks: (() => void)[] = [];
  const ctx: NativeContext = { ...f.ctx, setInterval(callback, ms) { if (ms === 5000) callbacks.push(callback); return f.ctx.setInterval(callback, ms); } };
  f.setAvailable(false);
  installStartupV7(f.host, { ...omp, ...entryRoots(f, config.startupRoot), nativeLimit: () => 6, environment: f.environment, launch: async (saved) => saved });
  await f.emit("session_start", {}, ctx);
  expect(f.messages.join("\n")).toContain("retries in 5 seconds");
  expect(await f.emit("tool_call", { toolName: "bash" }, ctx)).toMatchObject({ block: true });
  expect(callbacks).toHaveLength(1);
  f.setAvailable(true);
  callbacks[0]?.();
  const deadline = Date.now() + 1000;
  while (!f.messages.some((message) => message.includes("manager reconnected"))) {
    if (Date.now() > deadline) throw new Error("Manager admission retry did not recover");
    await Bun.sleep(5);
  }
  expect(f.admissions).toHaveLength(2);
  expect(f.admissions[0]).toEqual(f.admissions[1]);
  await f.emit("session_shutdown", {}, ctx);
  callbacks[0]?.();
  await Bun.sleep(5);
  expect(f.admissions).toHaveLength(2);
});

test("launched root verifies source and transcript before admission, exposes dedicated tools and preserves interactive input", async () => {
  const f = fixture(); f.useEnvironment();
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  expect(f.admissions).toHaveLength(1);
  expect(f.admissions[0]).toMatchObject({ nativeSession: f.file, paneId: "w1:p1", credential: "private-credential" });
  expect(f.tools.has("task")).toBe(false);
  expect([...f.tools.keys()]).toEqual(Object.keys(publicToolProperties));
  for (const [name, properties] of Object.entries(publicToolProperties)) {
    const tool = f.tools.get(name);
    if (tool === undefined) throw new Error(`Missing public Startup tool ${name}`);
    const schema: Json = nativeSchemaJson(tool.parameters);
    if (name === "startup_item") {
      const union = z.object({ anyOf: z.array(jsonSchema) }).parse(schema);
      expect(union.anyOf).toHaveLength(6);
      expect(union.anyOf.map((action) => z.object({ properties: z.object({ action: z.object({ const: z.string() }) }) }).parse(action).properties.action.const)).toEqual(["assign", "review", "qa_assign", "qa", "gate", "decide"]);
      continue;
    }
    expect(schema).toEqual({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  }
  const claim = f.tools.get("startup_claim");
  if (!claim) throw new Error("Missing own inbox tool");
  await claim.execute("claim", {}, undefined, undefined, f.ctx);
  expect(f.requests[0]).toEqual({ kind: "claim" });
  await expect(claim.execute("forged", { employeeId: "manager" }, undefined, undefined, f.ctx)).rejects.toThrow();
  await f.emit("input", { text: "  exact direct request  ", source: "interactive", images: [{ type: "image", data: "fixture", mimeType: "image/png" }] }, f.ctx);
  expect(f.requests.at(-1)).toMatchObject({ kind: "receive", source: "interactive", raw: { text: "  exact direct request  ", images: [{ type: "image", data: "fixture", mimeType: "image/png" }] } });
  const helper: NativeContext = { ...f.ctx, agent: { id: "helper", kind: "task", parentId: "Main" } };
  await expect(claim.execute("helper", {}, undefined, undefined, helper)).rejects.toThrow("root");
  expect(JSON.stringify(f.messages)).not.toContain("private-");
});

test("employee admission does not require unused session, workspace or profile environment variables", async () => {
  const f = fixture();
  for (const key of ["HERDR_SESSION", "STARTUP_HERDR_SESSION", "HERDR_WORKSPACE_ID", "OMP_PROFILE"]) f.environment[key] = undefined;
  f.useEnvironment();
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  expect(f.admissions).toHaveLength(1);
  expect(f.messages.some((message) => message.includes("boot blocked"))).toBe(false);
});

test("employee boot errors are contained and retry admission on the next native session start", async () => {
  const f = fixture(); f.useEnvironment();
  const path = f.manifest("dev");
  const source = join(f.skillsRoot, "skills/startup-role-dev/SKILL.md");
  const original = readFileSync(source, "utf8");
  writeFileSync(source, "changed source");
  installLaunchedEmployee(f.host, path);
  await expect(f.emit("session_start", {}, f.ctx)).resolves.toBeUndefined();
  expect(f.messages.join("\n")).toContain("source");
  expect(f.requests.at(-1)).toMatchObject({ credential: "private-credential", error: expect.stringContaining("source") });
  expect(f.admissions).toHaveLength(0);
  writeFileSync(source, original);
  await f.emit("session_start", {}, f.ctx);
  expect(f.admissions).toHaveLength(1);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, f.ctx)).toBeUndefined();
});

test("automatic employee admission retry retires the failed bridge and stops retrying after recovery", async () => {
  const f = fixture(); f.useEnvironment();
  const scheduled: Readonly<{ callback: () => void; ms: number }>[] = [];
  const context: NativeContext = { ...f.ctx, setInterval(callback, ms) { scheduled.push({ callback, ms }); return f.ctx.setInterval(callback, ms); } };
  f.setAvailable(false);
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, context);
  expect(f.admissions).toHaveLength(1);
  expect(f.messages.join("\n")).toContain("HTTP 503");
  const retry = scheduled.find((timer) => timer.ms === 5000);
  if (!retry) throw new Error("Missing automatic admission retry");
  f.setAvailable(true);
  retry.callback();
  const command = f.commands.get("startup-retry");
  if (!command) throw new Error("Missing admission retry command");
  await command.handler("", context);
  expect(f.admissions).toHaveLength(2);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, context)).toBeUndefined();
  await f.emit("before_agent_start", { systemPrompt: [] }, context);
  expect(f.requests.filter((request) => z.object({ kind: z.literal("begin_turn") }).safeParse(request).success)).toHaveLength(1);
  retry.callback();
  await command.handler("", context);
  expect(f.admissions).toHaveLength(2);
  await f.emit("session_shutdown", {}, context);
  retry.callback();
  await command.handler("", context);
  expect(f.admissions).toHaveLength(2);
});

test("coordinator and failure-report outages remain visible and recoverable", async () => {
  const f = fixture(); f.useEnvironment();
  const path = f.manifest("dev");
  const original = readFileSync(path, "utf8");
  const manifest = z.record(z.string(), z.json()).parse(JSON.parse(original));
  writeFileSync(path, JSON.stringify({ ...manifest, socketPath: join(f.root, "offline.sock") }));
  installLaunchedEmployee(f.host, path);
  await expect(f.emit("session_start", {}, f.ctx)).resolves.toBeUndefined();
  expect(f.messages.join("\n")).toContain("boot failure reporting failed");
  expect(f.messages.join("\n")).not.toContain("private-credential");
  writeFileSync(path, original);
  const retry = f.commands.get("startup-retry");
  if (!retry) throw new Error("Missing retry command");
  await retry.handler("", f.ctx);
  expect(f.admissions).toHaveLength(1);
});

test("missing OMP profile means the native default profile for a manager", async () => {
  const f = fixture();
  f.environment.OMP_PROFILE = undefined;
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => { launched.push(config); return { ...config, socketPath: f.socketPath }; } });
  await f.emit("input", { text: "/startup new defaults", source: "interactive", images: [] }, f.ctx);
  expect(launched[0]?.profile).toBe("default");
  expect(f.admissions).toHaveLength(1);
});

test.each([null, "fixture"])("manager resolves absent Herdr environment from the CLI in session %s", async (session: string | null) => {
  const f = fixture();
  const binary = join(f.root, "herdr");
  writeFileSync(binary, `#!/usr/bin/env bun\nconst args = process.argv.slice(2);\nconsole.log(JSON.stringify(args.includes("status") ? { session: ${JSON.stringify(session)} } : { result: { type: "pane_current", pane: { pane_id: "w1:p1", workspace_id: "w1" } } }));\n`, { mode: 0o700 });
  for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_SESSION", "STARTUP_HERDR_SESSION"]) f.environment[key] = undefined;
  f.environment.HERDR_BIN_PATH = binary;
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => { launched.push(config); return { ...config, socketPath: f.socketPath }; } });
  await f.emit("input", { text: "/startup new recovered", source: "interactive", images: [] }, f.ctx);
  expect(f.messages.some((message) => message.includes("boot blocked"))).toBe(false);
  expect(launched[0]).toMatchObject({ managerPaneId: "w1:p1", workspaceId: "w1", herdrSession: session ?? "default" });
  expect(f.admissions).toHaveLength(1);
});

test.each(["exit", "json", "shape"])("Herdr CLI %s failure is handled and a corrected boot can retry in the same pane", async (kind: string) => {
  const f = fixture();
  const binary = join(f.root, "herdr");
  const failure = kind === "exit" ? 'console.error("socket unavailable"); process.exit(33);' : kind === "json" ? 'console.log("invalid-json");' : 'console.log("{}");';
  writeFileSync(binary, `#!/usr/bin/env bun\n${failure}\n`, { mode: 0o700 });
  f.environment.HERDR_SESSION = undefined;
  f.environment.STARTUP_HERDR_SESSION = undefined;
  f.environment.HERDR_BIN_PATH = binary;
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }) });
  const command = f.commands.get("startup");
  if (!command) throw new Error("Missing Startup command");
  await expect(command.handler("new corrected", f.ctx)).resolves.toBeUndefined();
  expect(f.messages.join("\n")).toContain(kind === "exit" ? "command_failed" : "invalid_response");
  expect(f.admissions).toHaveLength(0);
  writeFileSync(binary, '#!/usr/bin/env bun\nconsole.log(JSON.stringify(process.argv.includes("status") ? { session: null } : { result: { type: "pane_current", pane: { pane_id: "w1:p1", workspace_id: "w1" } } }));\n');
  await command.handler("new corrected", f.ctx);
  expect(f.admissions).toHaveLength(1);
});

test("modified canonical source and parented transcript fail before any credential admission", async () => {
  for (const kind of ["source", "parent"]) {
    const f = fixture(); f.useEnvironment();
    const manifest = f.manifest("dev");
    if (kind === "source") writeFileSync(join(f.skillsRoot, "skills/startup-role-dev/SKILL.md"), "changed source");
    else writeFileSync(f.file, JSON.stringify({ type: "session", id: "native-root", parentSession: "/other-root.jsonl" }) + "\n");
    installLaunchedEmployee(f.host, manifest);
    await expect(f.emit("session_start", {}, f.ctx)).resolves.toBeUndefined();
    expect(f.messages.join("\n")).toContain(kind === "source" ? "source" : "parented");
    expect(f.admissions).toHaveLength(0);
  }
});

test("manager boot preserves native command work and binds independent runtime config to original session", async () => {
  const f = fixture();
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(f.host, { ...omp,
    ...entryRoots(f), nativeLimit: () => 6, environment: f.environment,
    launch: async (config) => { launched.push(config); return { ...config, socketPath: f.socketPath }; },
  });
  await f.emit("input", { text: "/startup new alpha --  fix exact work  ", source: "interactive", images: [] }, f.ctx);
  expect(launched).toHaveLength(1);
  expect(launched[0]).toMatchObject({ managerSession: "native-root", managerFile: f.file, managerPaneId: "w1:p1", herdrSession: "fixture", workspaceId: "w1", profile: "default", skillsHome: f.skillsHome, startupRoot: f.environment.STARTUP_ROOT, ownerGeneration: 1 });
  expect(existsSync(join(f.cwd, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(f.cwd, "CLAUDE.md"))).toBe(false);
  expect(existsSync(join(launched[0]!.startupRoot, "binding.json"))).toBe(true);
  expect(f.requests[0]).toMatchObject({ kind: "receive", raw: { text: "/startup new alpha --  fix exact work  ", images: [] } });
  expect(f.requests[1]).toMatchObject({ kind: "route", disposition: "work" });
  expect(z.object({ report: z.unknown() }).parse(f.pollReports[0]).report).toMatchObject({ status: "available", nativeSession: f.file, agentSessionId: "native-root", model: { id: "gpt-5.2" }, configuredEffort: "auto", effectiveEffort: "high" });
  const command = f.commands.get("startup");
  if (!command) throw new Error("Missing Startup command");
  await command.handler("new alpha --  fix exact work  ", f.ctx);
  expect(launched).toHaveLength(1);
  expect(f.admissions).toHaveLength(1);
  expect(f.requests.filter((request) => z.object({ kind: z.literal("receive") }).safeParse(request).success)).toHaveLength(1);
});

test("invalid profiles and missing native abort are reported without launching a coordinator", async () => {
  for (const kind of ["profile", "abort"]) {
    const f = fixture();
    let launched: boolean = false;
    const host: HostAPI = f.host;
    const { abort: _abort, ...withoutAbort } = f.ctx;
    const context: NativeContext = kind === "abort" ? withoutAbort : f.ctx;
    const environment = { ...f.environment };
    if (kind === "profile") environment.OMP_PROFILE = "invalid/profile";
    installStartupV7(host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment, launch: async (config) => { launched = true; return config; } });
    expect(await f.emit("input", { text: "/startup new alpha", source: "interactive", images: [] }, context)).toEqual({ handled: true });
    expect(launched).toBe(false);
    expect(f.messages.join("\n")).toContain("blocked");
    expect(f.admissions).toHaveLength(0);
    if (kind !== "abort") expect(f.getAborts()).toBeGreaterThan(0);
    expect(await f.emit("tool_call", { toolName: "bash", input: { command: "must not execute" } }, context)).toMatchObject({ block: true });
    expect(await f.emit("session_stop", {}, context)).toMatchObject({ continue: true });
    expect(await f.emit("session_stop", {}, context)).toBeUndefined();
  }
});

test("an OMP profile missing a bound model role is reported without launching a coordinator", async () => {
  for (const kind of ["unresolved", "unsupported"]) {
    const f = fixture();
    let launched: boolean = false;
    const { models: _models, ...withoutModels } = f.ctx;
    const context: NativeContext = kind === "unsupported" ? withoutModels : { ...f.ctx, models: { resolve: (spec: string) => spec === "@plan" ? undefined : { id: "model" } } };
    installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => { launched = true; return config; } });
    expect(await f.emit("input", { text: "/startup new alpha", source: "interactive", images: [] }, context)).toEqual({ handled: true });
    expect(launched).toBe(false);
    expect(f.messages.join("\n")).toContain(kind === "unresolved" ? "@plan (architect)" : "ctx.models");
    expect(f.admissions).toHaveLength(0);
  }
});

test("an admitted manager is not blocked when a bound model role later stops resolving", async () => {
  const f = fixture();
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }) });
  await f.emit("input", { text: "/startup new alpha", source: "interactive", images: [] }, f.ctx);
  expect(f.admissions).toHaveLength(1);
  const degraded: NativeContext = { ...f.ctx, models: { resolve: () => undefined } };
  await f.emit("input", { text: "/startup status", source: "interactive", images: [] }, degraded);
  expect(await f.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, f.ctx)).toBeUndefined();
});

test("existing live runtime intent is reused without spawning a duplicate host", async () => {
  const f = fixture();
  const stateDirectory: string = join(f.root, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  const config: RuntimeHostConfig = {
    name: "alpha", skillsHome: f.skillsHome, startupRoot: stateDirectory, stateDirectory, boundRoot: f.cwd, skillsRoot: f.skillsRoot,
    socketPath: join(stateDirectory, "runtime.sock"), profile: "default", managerSession: "native-root", managerFile: f.file, managerPaneId: "w1:p1", managerCredential: "private-credential",
    herdrSession: "fixture", workspaceId: "w1", herdrBinary: "/must-not-run", herdrIntegration: f.environment.STARTUP_HERDR_OMP_EXTENSION ?? "", ownerGeneration: 1,
    policy: { tickMs: 100, paCadenceMs: 1000, progressDeadlineMs: 3000, connectionDeadlineMs: 1000, executionLimit: 4 },
  };
  writeFileSync(join(stateDirectory, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(stateDirectory, "runtime-launch.json"), JSON.stringify({ state: "spawned", pid: process.pid, startedAt: 1 }), { mode: 0o600 });
  const server = Bun.serve({ unix: config.socketPath, fetch: (): Response => Response.json({ status: "running" }) });
  cleanup.push(() => server.stop(true));
  expect(await launchRuntimeHost(config)).toEqual(config);
  expect(statSync(join(stateDirectory, "runtime-config.json")).mode & 0o777).toBe(0o600);
});


function runtimeFixture(f: ReturnType<typeof fixture>): Readonly<{ config: RuntimeHostConfig; stateFile: string }> {
  return harnessRuntimeFixture(f, "omp");
}
function harnessRuntimeFixture(f: ReturnType<typeof fixture>, harness: "omp" | "claude"): Readonly<{ config: RuntimeHostConfig; stateFile: string }> {
  const skillsHome: string = f.skillsHome;
  const startupRoot: string = join(skillsHome, "startup", "alpha");
  const stateDirectory: string = startupRoot;
  const socketPath: string = join(startupRoot, "runtime.sock");
  if (harness === "claude") {
    mkdirSync(join(startupRoot, "hooks"), { recursive: true, mode: 0o700 });
    const hook = join(startupRoot, "hooks", "herdr-agent-state.sh");
    writeFileSync(hook, "# HERDR_INTEGRATION_ID=claude\n# HERDR_INTEGRATION_VERSION=11\n", { mode: 0o600 });
    writeFileSync(join(startupRoot, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook }] }] } }), { mode: 0o600 });
    writeFileSync(join(startupRoot, ".claude.json"), JSON.stringify({ projects: { [f.cwd]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  }
  const stateFile: string = join(f.root, "fake-herdr-state.json");
  const fake: string = join(f.root, "fake-herdr");
  const script: string = `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2).slice(2);
const file = ${JSON.stringify(f.file)};
const stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const location = { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2", terminal_id: "term-2" };
let result;
if (args[0] === "status") result = { running: true, version: "0.9.5", protocol: 22, compatible: true, endpoint_compatible: true };
else if (args[0] === "api") result = { protocol: 22, schema_version: 1, schemas: { success_response: { $defs: {
  AgentInfo: { properties: { state_change_seq: { type: "integer" }, interactive_ready: { type: "boolean" }, agent_session: {} } },
  ResponseResult: { oneOf: ["tab_created", "tab_info", "pane_info", "agent_started", "agent_list"].map((type) => ({ properties: { type: { const: type } } })) }
} } } };
else if (args[0] === "agent" && args[1] === "list") result = { id: "fixture", result: { type: "agent_list", agents: state.agents } };
else if (args[0] === "tab") result = { id: "fixture", result: { type: "tab_created", tab: { workspace_id: "w1", tab_id: "w1:t2" }, root_pane: location } };
else if (args[0] === "agent" && args[1] === "start") {
  const health = await fetch("http://localhost/health", { unix: ${JSON.stringify(socketPath)} });
  state.serverSeenBeforeLaunch = health.ok;
  if (state.rejectLaunch) { process.stderr.write("Fixture PA approval blocked"); process.exit(1); }
  const kind = ${JSON.stringify(harness)};
  if (args[4] !== kind) throw new Error("Unexpected agent kind " + args[4]);
  const native = kind === "claude" ? args[args.indexOf("--session-id") + 1] : ${JSON.stringify(join(f.root, "fake-pa.jsonl"))};
  if (kind === "omp") writeFileSync(native, JSON.stringify({ type: "session", id: args[2] }) + String.fromCharCode(10));
  const agent = { ...location, agent: kind, name: args[2], agent_status: "idle", state_change_seq: 1, interactive_ready: true, agent_session: { source: "herdr:" + kind, agent: kind, kind: kind === "claude" ? "id" : "path", value: native } };
  state.agents.push(agent);
  state.started = [...(state.started ?? []), args];
  writeFileSync(stateFile, JSON.stringify(state));
  result = { id: "fixture", result: { type: "agent_started", agent, argv: ["omp"] } };
} else throw new Error("Unexpected fake Herdr command " + JSON.stringify(args));
process.stdout.write(JSON.stringify(result));
`;
  writeFileSync(fake, script, { mode: 0o700 }); chmodSync(fake, 0o700);
  const managerSession = harness === "claude" ? { source: "herdr:claude", agent: "claude", kind: "id", value: "native-root" } : { source: "herdr:omp", agent: "omp", kind: "path", value: f.file };
  writeFileSync(stateFile, JSON.stringify({ agents: [{ agent: harness, name: "manager", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term-1", agent_status: "idle", state_change_seq: 1, interactive_ready: true, agent_session: managerSession }] }));
  const config: RuntimeHostConfig = {
    name: "alpha", skillsHome, startupRoot, stateDirectory, boundRoot: f.cwd, skillsRoot: f.skillsRoot, socketPath, profile: "default", managerSession: "native-root", managerFile: harness === "claude" ? join(f.environment.STARTUP_ROOT!, "projects", "repo", "native-root.jsonl") : f.file, managerPaneId: "w1:p1", managerCredential: "private-credential",
    herdrSession: "fixture", workspaceId: "w1", herdrBinary: fake, herdrIntegration: f.environment.STARTUP_HERDR_OMP_EXTENSION ?? "", ownerGeneration: 1,
    policy: { tickMs: 1000, paCadenceMs: 60000, progressDeadlineMs: 300000, connectionDeadlineMs: 30000, executionLimit: 8 },
  };
  return { config: harness === "claude" ? { ...config, harness } : config, stateFile };
}

test("production timer keeps issuing PA checks while queue reads fail and recovers from degraded health", async () => {
  const f = fixture(); f.useEnvironment();
  const { config: initial } = runtimeFixture(f);
  const config = { ...initial, policy: { ...initial.policy, tickMs: 10, paCadenceMs: 20 } };
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  const queue = join(config.stateDirectory, "queue.json");
  writeFileSync(queue, '{"rows":');
  const runtime = await startRuntimeHost(config);
  let client: Awaited<ReturnType<typeof connectEmployee>> | null = null;
  try {
    const database = new Database(join(config.stateDirectory, "staff.sqlite"), { readonly: true });
    const saved = z.object({ payload: z.string() }).parse(database.query("SELECT payload FROM records WHERE kind='runtimeBinding' AND json_extract(payload,'$.employeeId') != 'manager'").get());
    database.close();
    const pa = z.object({ employeeId: z.string(), launchId: z.string() }).parse(JSON.parse(saved.payload));
    const manifest = z.object({ credential: z.string(), source: sourceSchema }).parse(JSON.parse(readFileSync(join(config.stateDirectory, "launches", `${pa.launchId}.json`), "utf8")));
    client = await connectEmployee({ socketPath: config.socketPath, credential: manifest.credential, source: manifest.source, nativeSession: join(f.root, "fake-pa.jsonl"), paneId: "w1:p2" });
    for (let index = 0; index < 2; index += 1) {
      const deadline = Date.now() + 5000;
      while (!(await client.poll()).pendingMessageIds.some((id) => id.startsWith("pa-check-"))) {
        if (Date.now() >= deadline) throw new Error("Production timer starved the PA");
        await Bun.sleep(20);
      }
      while (true) {
        const claim = z.object({ claim: z.object({ id: z.string() }), message: z.object({ id: z.string() }) }).parse(await client.request({ kind: "claim" }));
        await client.request({ kind: "settle", claimId: claim.claim.id, result: { id: `timer-result-${index}-${claim.claim.id}`, kind: "completed", output: "PA check during queue failure", checkpoint: null, outgoing: [{ id: `timer-report-${claim.claim.id}`, recipient: "manager", kind: "report", correlation: "manager-supervision", payload: "PA remains active" }] } });
        if (claim.message.id.startsWith("pa-check-")) break;
      }
      expect((await fetch("http://localhost/health", { unix: config.socketPath })).status).toBe(503);
    }
    writeFileSync(queue, '{"rows":[]}');
    const deadline = Date.now() + 5000;
    while ((await fetch("http://localhost/health", { unix: config.socketPath })).status !== 200) {
      if (Date.now() >= deadline) throw new Error("Degraded coordinator never resumed supervision");
      await Bun.sleep(20);
    }
  } finally { client?.close(); await runtime.close(); }
});

test("runtime serves admission before launching roots and owns separate V7 state", async () => {
  const f = fixture(); f.useEnvironment();
  const { config, stateFile } = runtimeFixture(f);
  const stateDirectory: string = config.stateDirectory;
  const runtime = await startRuntimeHost(config);
  try {
    expect(z.object({ serverSeenBeforeLaunch: z.literal(true) }).parse(JSON.parse(readFileSync(stateFile, "utf8"))).serverSeenBeforeLaunch).toBe(true);
    const database = new Database(join(stateDirectory, "staff.sqlite"), { readonly: true });
    try {
      const scope = z.object({ payload: z.string() }).parse(database.query("SELECT payload FROM records WHERE kind='meta' AND id='scope'").get());
      expect(z.object({ host: z.string() }).parse(JSON.parse(scope.payload)).host).toBe(hostname());
    } finally { database.close(); }
  } finally { await runtime.close(); }
});

test("manager and assigned PA retain manager-only Startup command authority", async () => {
  const f = fixture(); f.useEnvironment();
  const { config } = runtimeFixture(f);
  const runtime = await startRuntimeHost(config);
  let manager: Awaited<ReturnType<typeof connectEmployee>> | null = null;
  let pa: Awaited<ReturnType<typeof connectEmployee>> | null = null;
  try {
    const managerSource = loadProfile({ skillsRoot: f.skillsRoot, role: "manager", employeeId: "manager", generation: 1 }).source;
    manager = await connectEmployee({ socketPath: config.socketPath, credential: config.managerCredential, nativeSession: config.managerFile, paneId: config.managerPaneId, source: managerSource });
    const managerStaff = await manager.request({ kind: "staff" });
    expect(z.object({ manager: z.object({ id: z.literal("manager") }) }).parse(managerStaff).manager.id).toBe("manager");

    await runtime.coordinator.tick();
    const database = new Database(join(config.stateDirectory, "staff.sqlite"), { readonly: true });
    let savedPayload: string;
    try {
      savedPayload = z.object({ payload: z.string() }).parse(database.query("SELECT payload FROM records WHERE kind='runtimeBinding' AND json_extract(payload,'$.employeeId') != 'manager'").get()).payload;
    } finally { database.close(); }
    const binding = z.object({ employeeId: z.string(), launchId: z.string() }).parse(JSON.parse(savedPayload));
    const manifest = z.object({ credential: z.string(), source: sourceSchema }).parse(JSON.parse(readFileSync(join(config.stateDirectory, "launches", `${binding.launchId}.json`), "utf8")));
    const herdrState = z.object({ agents: z.array(z.object({ name: z.string(), pane_id: z.string(), agent_session: z.object({ value: z.string() }) })) }).parse(JSON.parse(readFileSync(join(f.root, "fake-herdr-state.json"), "utf8")));
    const paAgent = herdrState.agents.find((agent) => agent.agent_session.value !== config.managerFile);
    if (paAgent === undefined) throw new Error(`Missing assigned PA observation for ${binding.employeeId}`);
    pa = await connectEmployee({ socketPath: config.socketPath, credential: manifest.credential, nativeSession: paAgent.agent_session.value, paneId: paAgent.pane_id, source: manifest.source });
    await expect(pa.request({ kind: "staff" })).rejects.toThrow("Only the manager may perform this operation");
  } finally {
    manager?.close();
    pa?.close();
    await runtime.close();
  }
});


test("item tools retain typed flat actions and image tools return actual native image content", async () => {
  const f = fixture(); f.useEnvironment();
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  const item = f.tools.get("startup_item");
  const image = f.tools.get("startup_image");
  if (item === undefined || image === undefined) throw new Error("Missing item/image tools");
  await item.execute("item", { requestId: "action-1", itemId: "item-1", expectedRevision: 1, action: "review", resultId: "result-1", evidence: { tests: "passed" } }, undefined, undefined, f.ctx);
  expect(f.requests[0]).toEqual({ kind: "item", request: { requestId: "action-1", itemId: "item-1", expectedRevision: 1, action: "review", resultId: "result-1", evidence: { tests: "passed" } } });
  const result = await image.execute("image", { inputId: "input-1", index: 0 }, undefined, undefined, f.ctx);
  const images = z.array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })).parse(result.content);
  expect(images).toEqual([{ type: "image", data: "fixture-image", mimeType: "image/png" }]);
});


test("detached runtime launches from private intent and admits manager independently of native inference", async () => {
  const f = fixture(); f.useEnvironment();
  const { config } = runtimeFixture(f);
  let pid: number | null = null;
  try {
    const launched: RuntimeHostConfig = await launchRuntimeHost(config);
    const intent = z.object({ state: z.literal("spawned"), pid: z.number().int().positive() }).parse(JSON.parse(readFileSync(join(config.stateDirectory, "runtime-launch.json"), "utf8")));
    pid = intent.pid;
    expect(pid).not.toBe(process.pid);
    expect(launched.managerCredential).toBe("private-credential");
    expect(statSync(join(config.stateDirectory, "runtime-config.json")).mode & 0o777).toBe(0o600);
    expect(await launchRuntimeHost({ ...config, managerCredential: "ignored-new-credential" })).toEqual(launched);
    const client = await connectEmployee({ socketPath: config.socketPath, credential: launched.managerCredential, nativeSession: f.file, paneId: "w1:p1", source: loadProfile({ skillsRoot: f.skillsRoot, role: "manager", employeeId: "manager", generation: 1 }).source });
    try { expect((await client.poll()).projection).toContain("Complete canonical manager persona"); }
    finally { client.close(); }
    const logPath: string = join(config.stateDirectory, "runtime.log");
    for (let attempt: number = 0; attempt < 200; attempt++) {
      if (existsSync(logPath) && readFileSync(logPath, "utf8").includes('"operation":"started"')) break;
      await Bun.sleep(10);
    }
    expect(readFileSync(logPath, "utf8")).toContain('"operation":"started"');
  } finally {
    if (pid !== null) {
      process.kill(pid, "SIGTERM");
      for (let attempt: number = 0; attempt < 200 && existsSync(config.socketPath); attempt++) await Bun.sleep(10);
      expect(existsSync(config.socketPath)).toBe(false);
    }
  }
});


test("partial PA launch failure preserves admission endpoint for later pane recovery", async () => {
  const f = fixture(); f.useEnvironment();
  const { config, stateFile } = runtimeFixture(f);
  const state = z.record(z.string(), z.json()).parse(JSON.parse(readFileSync(stateFile, "utf8")));
  writeFileSync(stateFile, JSON.stringify({ ...state, rejectLaunch: true }));
  const runtime = await startRuntimeHost(config);
  try {
    const response = await fetch("http://localhost/health", { unix: config.socketPath });
    expect(response.status).toBe(200);
    const client = await connectEmployee({ socketPath: config.socketPath, credential: config.managerCredential, nativeSession: f.file, paneId: "w1:p1", source: loadProfile({ skillsRoot: f.skillsRoot, role: "manager", employeeId: "manager", generation: 1 }).source });
    try { expect((await client.poll()).pendingMessageIds.length).toBeGreaterThan(0); }
    finally { client.close(); }
    const database = new Database(join(config.stateDirectory, "staff.sqlite"), { readonly: true });
    try {
      const messages = z.array(z.object({ payload: z.string() })).parse(database.query("SELECT payload FROM records WHERE kind='message'").all());
      expect(messages.some((message) => message.payload.includes("startup-blocked"))).toBe(true);
    } finally { database.close(); }
  } finally { await runtime.close(); }
});


test("handled native session-start failure still aborts and blocks unadmitted root tools", async () => {
  const f = fixture(); f.useEnvironment();
  const manifest: string = f.manifest("dev");
  installLaunchedEmployee(f.host, manifest);
  expect(await f.emit("tool_call", { toolName: "bash", input: { command: "before admission" } }, f.ctx)).toMatchObject({ block: true });
  writeFileSync(join(f.skillsRoot, "skills/startup-role-dev/SKILL.md"), "modified source");
  await expect(f.emit("session_start", {}, f.ctx)).resolves.toBeUndefined();
  expect(f.getAborts()).toBeGreaterThan(0);
  expect(f.messages.join("\n")).toContain("blocked");
  expect(f.admissions).toHaveLength(0);
  expect(await f.emit("tool_call", { toolName: "bash", input: { command: "must not execute" } }, f.ctx)).toMatchObject({ block: true });
  expect(await f.emit("session_stop", {}, f.ctx)).toMatchObject({ continue: true });
  expect(await f.emit("session_stop", {}, f.ctx)).toBeUndefined();
});

test("fresh native helper factories block employee tools before any root attachment", async () => {
  for (const factory of ["launched", "manager"]) {
    const f = fixture(); f.useEnvironment();
    if (factory === "launched") installLaunchedEmployee(f.host, f.manifest("dev"));
    else installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => config });
    const helper: NativeContext = { ...f.ctx, agent: { id: "helper", kind: "task", parentId: "Main" } };
    await f.emit("session_start", {}, helper);
    expect(await f.emit("tool_call", { toolName: "startup_settle", input: {} }, helper)).toMatchObject({ block: true });
    expect(await f.emit("tool_call", { toolName: "task", input: { startup: "hire" } }, helper)).toMatchObject({ block: true });
    expect(await f.emit("tool_call", { toolName: "task", input: { task: "bounded helper" } }, helper)).toBeUndefined();
    expect(await f.emit("tool_call", { toolName: "bash", input: { command: "ordinary helper work" } }, helper)).toBeUndefined();
    expect(f.admissions).toHaveLength(0);
  }
});

test("named OMP profile accepted by installer is accepted by employee admission", async () => {
  const f = fixtureFor("startup.v7");
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  expect(f.messages.some((message) => message.includes("boot blocked"))).toBe(false);
  expect(f.admissions).toHaveLength(1);
});

test("an employee whose actual OMP profile differs from its launch manifest is refused before admission", async () => {
  for (const [actual, recorded] of [["default", "work"], ["work", "default"], ["other", "work"]] as const) {
    const f = fixtureFor(actual);
    const path: string = f.manifest("dev");
    writeFileSync(path, JSON.stringify({ ...z.record(z.string(), z.json()).parse(JSON.parse(readFileSync(path, "utf8"))), profile: recorded }), { mode: 0o600 });
    installLaunchedEmployee(f.host, path);
    await f.emit("session_start", {}, f.ctx);
    expect(f.messages.join("\n")).toContain(`launch manifest profile ${recorded}`);
    expect(f.admissions).toHaveLength(0);
  }
});

test("a named-profile employee transcript must live under that profile's agent directory", async () => {
  const f = fixtureFor("work");
  const defaultTranscript = join(f.ompHome, ".omp", "agent", "sessions", "native.jsonl");
  mkdirSync(join(f.ompHome, ".omp", "agent", "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(defaultTranscript, JSON.stringify({ type: "session", id: "native-root" }) + "\n");
  const altered: NativeContext = { ...f.ctx, sessionManager: { getSessionId: () => "native-root", getSessionFile: () => defaultTranscript } };
  installLaunchedEmployeeWith(f.host, f.manifest("dev"), async () => ({ nativeSession: defaultTranscript, file: defaultTranscript, lastAssistant: undefined }));
  await f.emit("session_start", {}, altered);
  expect(f.admissions).toHaveLength(0);
  expect(f.messages.join("\n")).toContain("Native transcript");
});

test("a manager on a named OMP profile records it and keeps its transcripts under that profile", async () => {
  const f = fixtureFor("work");
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => { launched.push(config); return { ...config, socketPath: f.socketPath }; } });
  await f.emit("input", { text: "/startup new named", source: "interactive", images: [] }, f.ctx);
  expect(launched[0]?.profile).toBe("work");
  expect(f.admissions).toHaveLength(1);
});


test("explicit manager select recovers a stopped coordinator in the same native root", async () => {
  const f = fixture();
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(f.host, { ...omp,
    ...entryRoots(f), nativeLimit: () => 6, environment: f.environment,
    launch: async (config) => { launched.push(config); f.setAvailable(true); return { ...config, socketPath: f.socketPath }; },
  });
  await f.emit("input", { text: "/startup new alpha", source: "interactive", images: [] }, f.ctx);
  f.setAvailable(false);
  await f.emit("input", { text: "/startup select alpha", source: "interactive", images: [] }, f.ctx);
  expect(launched).toHaveLength(2);
  const initial = launched[0];
  if (!initial) throw new Error("Missing initial launch config");
  expect(launched[1]).toEqual({ ...initial, socketPath: f.socketPath });
  expect(f.messages.some((message) => message.includes("boot blocked"))).toBe(false);
  expect(f.admissions).toHaveLength(2);
});


test.each(["18.8.8", "18.10.4", "19.0.0", "19.0.0-preview.1"])("native manager admission accepts capable OMP %s", async (version: string) => {
  const f = fixture();
  const host: HostAPI = { ...f.host, pi: { ...f.host.pi, VERSION: version } };
  installStartupV7(host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }) });
  await f.emit("input", { text: "/startup new capable", source: "interactive", images: [] }, f.ctx);
  expect(f.admissions).toHaveLength(1);
  expect(f.messages.some((message) => message.includes("boot blocked"))).toBe(false);
});

test.each([9, 10, 11])("managed Herdr integration revision %s is validated by runtime capabilities", async (revision: number) => {
  const f = fixture();
  const path = f.environment.STARTUP_HERDR_OMP_EXTENSION;
  if (!path) throw new Error("Missing integration fixture");
  writeFileSync(path, `// HERDR_INTEGRATION_ID=omp\n// HERDR_INTEGRATION_VERSION=${revision}\n`);
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }) });
  await f.emit("input", { text: "/startup new capable", source: "interactive", images: [] }, f.ctx);
  expect(f.admissions).toHaveLength(1);
});

test("native settlement accepts the result without a copied claim ID", async () => {
  const f = fixture(); f.useEnvironment();
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  const settle = f.tools.get("startup_settle");
  if (!settle) throw new Error("Missing settlement tool");
  const result = { id: "result", kind: "completed", output: "done", checkpoint: null, outgoing: [] };
  await settle.execute("settle", { result }, undefined, undefined, f.ctx);
  expect(f.requests.at(-1)).toEqual({ kind: "settle", result });
});


test("duplicate native settlement errors abort once without another command and do not loop on stop", async () => {
  const f = fixture(); f.useEnvironment();
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  f.setCommandResponse(Response.json({ error: "ClaimSettlementError", message: "Claim needs reconciliation", recovery: { code: "claim_requires_reconciliation", retryable: false, action: "Ask manager to reconcile; do not retry", employeeId: "dev-1", generation: 1, claimId: "claim" } }, { status: 409 }));
  const settle = f.tools.get("startup_settle");
  if (!settle) throw new Error("Missing settlement tool");
  const params = { result: { id: "result", kind: "completed", output: "done", checkpoint: null, outgoing: [] } };
  await expect(settle.execute("first", params, undefined, undefined, f.ctx)).rejects.toThrow("reconcile");
  expect(f.getAborts()).toBe(0);
  for (let attempt = 0; attempt < 3; attempt += 1)
    await expect(settle.execute("repeat", params, undefined, undefined, f.ctx)).rejects.toThrow("suppressed locally");
  expect(f.requests.filter((r) => z.object({ kind: z.literal("settle") }).safeParse(r).success)).toHaveLength(1);
  expect(f.getAborts()).toBe(3);
  expect(f.messages.filter((m) => m.includes("suppressed locally"))).toHaveLength(1);
  expect(await f.emit("session_stop", {}, f.ctx)).toBeUndefined();
});

test("duplicate rejected native claims abort the turn and stop automatic continuations", async () => {
  const f = fixture(); f.useEnvironment();
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  f.setCommandResponse(Response.json({ error: "StoreConflictError", message: "Employee already has an unresolved claim" }, { status: 409 }));
  const claim = f.tools.get("startup_claim");
  if (!claim) throw new Error("Missing claim tool");
  await expect(claim.execute("first", {}, undefined, undefined, f.ctx)).rejects.toThrow("retryable=false");
  await expect(claim.execute("repeat", {}, undefined, undefined, f.ctx)).rejects.toThrow("duplicate command suppressed");
  expect(f.requests.filter((request) => z.object({ kind: z.literal("claim") }).safeParse(request).success)).toHaveLength(1);
  expect(f.getAborts()).toBe(1);
  expect(await f.emit("session_stop", {}, f.ctx)).toBeUndefined();
});

const claudeManagerFile = (f: ReturnType<typeof fixture>): string => join(f.environment.STARTUP_ROOT!, "projects", "repo", "native-root.jsonl");
function claudeEntry(f: ReturnType<typeof fixture>) {
  return { harness: "claude", integration: () => "/fixture/claude/hooks/herdr-agent-state.sh",
    root: async () => ({ nativeSession: "native-root", file: claudeManagerFile(f), lastAssistant: undefined }) } as const;
}

test("runtime config parses saved OMP bytes unchanged, accepts Claude and rejects a mixed harness", () => {
  const f = fixture();
  const { config } = runtimeFixture(f);
  const saved: string = JSON.stringify(config);
  expect(JSON.stringify(parseRuntimeHostConfig(JSON.parse(saved)))).toBe(saved);
  expect("harness" in parseRuntimeHostConfig(JSON.parse(saved))).toBe(false);
  const claude: string = JSON.stringify({ ...config, harness: "claude" });
  expect(JSON.stringify(parseRuntimeHostConfig(JSON.parse(claude)))).toBe(claude);
  for (const harness of ["omp", "codex", null]) expect(() => parseRuntimeHostConfig({ ...config, harness })).toThrow(z.ZodError);
});

test("an invalid OMP runtime config reports only the OMP schema issues", () => {
  const f = fixture();
  const { config } = runtimeFixture(f);
  let caught: unknown = null;
  try { parseRuntimeHostConfig({ ...config, name: "a b" }); } catch (error: unknown) { caught = error; }
  const issues = z.object({ issues: z.array(z.object({ code: z.string(), path: z.array(z.union([z.string(), z.number()])) })) }).parse(caught).issues;
  expect(issues).toEqual([expect.objectContaining({ code: "invalid_format", path: ["name"] })]);
});

test("Claude manager first boot stores runtime state under its root without writing repository guidance", async () => {
  const f = fixture();
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(f.host, { ...claudeEntry(f), ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => { launched.push(config); return { ...config, socketPath: f.socketPath }; } });
  await f.emit("input", { text: "/startup new claudeco", source: "interactive", images: [] }, f.ctx);
  expect(f.messages.some((message) => message.includes("boot blocked"))).toBe(false);
  expect(launched).toHaveLength(1);
  expect(launched[0]).toMatchObject({ harness: "claude", managerSession: "native-root", managerFile: claudeManagerFile(f), herdrIntegration: "/fixture/claude/hooks/herdr-agent-state.sh" });
  expect(parseRuntimeHostConfig(launched[0])).toEqual(launched[0]!);
  expect(existsSync(claudeManagerFile(f))).toBe(false);
  expect(f.admissions[0]).toMatchObject({ credential: launched[0]?.managerCredential, nativeSession: "native-root" });
  expect(existsSync(join(f.cwd, "CLAUDE.md"))).toBe(false);
  expect(existsSync(join(f.cwd, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(launched[0]!.startupRoot, "binding.json"))).toBe(true);
});

test("OMP manager first boot leaves CLAUDE.md untouched", async () => {
  const f = fixture();
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }) });
  await f.emit("input", { text: "/startup new ompco", source: "interactive", images: [] }, f.ctx);
  expect(f.admissions).toHaveLength(1);
  expect(existsSync(join(f.cwd, "CLAUDE.md"))).toBe(false);
});

test.each(["claude", "omp"] as const)("manager resume requires the saved harness when the bridge is %s", async (bridge) => {
  const f = fixture();
  const { config: initial } = harnessRuntimeFixture(f, "claude");
  const config = { ...initial, socketPath: f.socketPath, boundRoot: realpathSync(f.cwd), skillsRoot: realpathSync(f.skillsRoot) };
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  bindRuntimeFixture(f, config);
  writeFileSync(join(config.stateDirectory, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(f.host, { ...(bridge === "claude" ? claudeEntry(f) : omp), ...entryRoots(f, config.startupRoot), nativeLimit: () => 6, environment: f.environment, launch: async (saved) => { launched.push(saved); return saved; } });
  await f.emit("session_start", {}, f.ctx);
  if (bridge === "claude") {
    expect(launched).toEqual([config]);
    expect(f.admissions[0]).toMatchObject({ nativeSession: "native-root" });
  } else {
    expect(launched).toHaveLength(0);
    expect(f.messages.join("\n")).toContain("saved manager");
  }
});

test("a launched employee admits through the supplied native root seam", async () => {
  const f = fixture(); f.useEnvironment();
  installLaunchedEmployeeWith(f.host, f.manifest("dev"), async () => ({ nativeSession: f.file, file: f.file, lastAssistant: undefined }));
  await f.emit("session_start", {}, f.ctx);
  expect(f.admissions).toHaveLength(1);
  expect(f.admissions[0]).toMatchObject({ nativeSession: f.file, paneId: "w1:p1" });
});

test("Claude runtime launches the PA with the claude kind and admits it by its assigned session", async () => {
  const f = fixture(); f.useEnvironment();
  const { config, stateFile } = harnessRuntimeFixture(f, "claude");
  const runtime = await startRuntimeHost(config);
  const clients: Awaited<ReturnType<typeof connectEmployee>>[] = [];
  try {
    const database = new Database(join(config.stateDirectory, "staff.sqlite"), { readonly: true });
    const saved = z.object({ payload: z.string() }).parse(database.query("SELECT payload FROM records WHERE kind='runtimeBinding' AND json_extract(payload,'$.employeeId') != 'manager'").get());
    database.close();
    const pa = z.object({ employeeId: z.string(), launchId: z.string(), nativeSession: z.string() }).parse(JSON.parse(saved.payload));
    expect(pa.nativeSession).toBe(pa.launchId);
    const launches = join(config.stateDirectory, "launches");
    const shared = join(config.startupRoot, "startup", "claude");
    const name = `s-${pa.launchId.replaceAll("-", "").slice(0, 28)}`;
    const state = z.object({ started: z.array(z.array(z.string())) }).parse(JSON.parse(readFileSync(stateFile, "utf8")));
    expect(state.started).toEqual([["agent", "start", name, "--kind", "claude", "--pane", "w1:p2", "--", "--session-id", pa.launchId, "--append-system-prompt-file", join(launches, `${pa.launchId}.prompt.md`), "--settings", join(shared, "settings.json"), "--mcp-config", join(shared, "mcp.json"), "-n", name]]);
    expect(existsSync(join(launches, `${pa.launchId}.ts`))).toBe(false);
    const manifest = z.object({ credential: z.string(), source: sourceSchema }).parse(JSON.parse(readFileSync(join(launches, `${pa.launchId}.json`), "utf8")));
    clients.push(await connectEmployee({ socketPath: config.socketPath, credential: manifest.credential, source: manifest.source, nativeSession: pa.launchId, paneId: "w1:p2" }));
    clients.push(await connectEmployee({ socketPath: config.socketPath, credential: config.managerCredential, nativeSession: "native-root", paneId: "w1:p1", source: loadProfile({ skillsRoot: f.skillsRoot, role: "manager", employeeId: "manager", generation: 1 }).source }));
    expect((await clients[1]!.poll()).projection).toContain("Complete canonical manager persona");
  } finally { for (const client of clients) client.close(); await runtime.close(); }
});

test("explicit manager retry replaces the prior admitted channel without replaying work", async () => {
  const f = fixture();
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }) });
  await f.emit("input", { text: "/startup new alpha", source: "interactive" }, f.ctx);
  expect(f.admissions).toHaveLength(1);
  const requests = f.requests.length;
  const retry = f.commands.get("startup-retry");
  if (!retry) throw new Error("Missing retry command");
  await retry.handler("", f.ctx);
  expect(f.admissions).toHaveLength(2);
  expect(f.requests).toHaveLength(requests);
});

test("manager admission resolves omitted tooling home and canonical root spelling", async () => {
  const f = fixture();
  delete f.environment.JP_SKILLS_HOME;
  f.environment.STARTUP_ROOT += "/.";
  installStartupV7(f.host, { ...omp, ...entryRoots(f), environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }), nativeLimit: () => 6 });
  await f.commands.get("startup")!.handler("new test", f.ctx);
  expect(f.admissions).toHaveLength(1);
});

test("explicit employee retry rebinds only the same native identity after channel loss", async () => {
  const f = fixture();
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  expect(f.admissions).toHaveLength(1);
  f.disconnect(); await Bun.sleep(20);
  await f.commands.get("startup-retry")!.handler("", f.ctx);
  expect(f.admissions).toHaveLength(2);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, f.ctx)).toBeUndefined();
  f.disconnect(); await Bun.sleep(20);
  const changed: NativeContext = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "other" } };
  await f.commands.get("startup-retry")!.handler("", changed);
  expect(f.admissions).toHaveLength(2);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, changed)).toMatchObject({ block: true });
});

test("uncertain receive persists its ID and explicit reconciliation never resends it", async () => {
  const f = fixture();
  const manifest = f.manifest("dev");
  installLaunchedEmployee(f.host, manifest);
  await f.emit("session_start", {}, f.ctx);
  f.setCommandResponse(new Response("lost response after commit"));
  await f.emit("input", { id: "stable-event", text: "work", source: "interactive", images: [] }, f.ctx);
  const path = join(f.environment.STARTUP_ROOT!, "input-receipts", createHash("sha256").update("native-root").digest("hex") + ".json");
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ id: "stable-event", state: "uncertain" });
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, f.ctx)).toMatchObject({ block: true });
  const count = f.requests.filter((request) => z.object({ kind: z.literal("receive") }).safeParse(request).success).length;
  const digest = createHash("sha256").update(encode({ source: "interactive", raw: { text: "work", images: [] } })).digest("hex");
  f.setCommandResponse(Response.json({ state: "committed", id: "stable-event", digest }));
  await f.commands.get("startup-retry")!.handler("", f.ctx);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ state: "committed" });
  expect(f.requests.filter((request) => z.object({ kind: z.literal("receive") }).safeParse(request).success)).toHaveLength(count);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, f.ctx)).toBeUndefined();
});
test("pre-dispatch input failure stays durable and does not replay after rebind", async () => {
  const f = fixture();
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  f.disconnect(); await Bun.sleep(20);
  await f.emit("input", { id: "unsent-event", text: "work", source: "interactive", images: [] }, f.ctx);
  const path = join(f.environment.STARTUP_ROOT!, "input-receipts", createHash("sha256").update("native-root").digest("hex") + ".json");
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ id: "unsent-event", state: "failed" });
  f.setCommandResponse(Response.json({ state: "missing", id: "unsent-event" }));
  await f.commands.get("startup-retry")!.handler("", f.ctx);
  expect(f.requests.filter((request) => z.object({ kind: z.literal("receive") }).safeParse(request).success)).toHaveLength(0);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, f.ctx)).toMatchObject({ block: true });
});

test("admission rejects a foreign native transcript tree", async () => {
  const f = fixture();
  const manifest = f.manifest("dev");
  const foreign = join(f.root, "foreign.jsonl");
  writeFileSync(foreign, JSON.stringify({ type: "session", id: "native-root" }) + "\n");
  const altered: NativeContext = { ...f.ctx, sessionManager: { getSessionId: () => "native-root", getSessionFile: () => foreign } };
  installLaunchedEmployeeWith(f.host, manifest, async () => ({ nativeSession: foreign, file: foreign, lastAssistant: undefined }));
  await f.emit("session_start", {}, altered);
  expect(f.admissions).toHaveLength(0);
  expect(f.messages.join("\n")).toContain("Native transcript");
});

test("native transcript policy rejects symlink ancestors, symlink files and Claude session mismatch", () => {
  const f = fixture();
  const foreign = join(f.root, "foreign"); mkdirSync(foreign);
  const file = join(foreign, "native.jsonl"); writeFileSync(file, "{}");
  symlinkSync(foreign, join(f.agentDirectory, "sessions", "link"));
  symlinkSync(file, join(f.agentDirectory, "sessions", "linked.jsonl"));
  for (const target of [join(f.agentDirectory, "sessions", "link", "native.jsonl"), join(f.agentDirectory, "sessions", "linked.jsonl")]) {
    expect(() => assertNativeTranscript({ harness: "omp", root: f.agentDirectory, sessionId: "native-root", file: target })).toThrow("symlink");
  }
  expect(() => assertNativeTranscript({ harness: "omp", root: f.agentDirectory, sessionId: "native-root", file: join(foreign, "native.jsonl") })).toThrow("Native transcript");
  expect(() => assertNativeTranscript({ harness: "claude", root: f.environment.STARTUP_ROOT!, sessionId: "native-root", file: join(f.environment.STARTUP_ROOT!, "projects", "repo", "other.jsonl") })).toThrow("Native transcript");
});

test("manager admission resolves an omitted Startup root independently of tooling home", async () => {
  const f = fixture(); delete f.environment.STARTUP_ROOT;
  installStartupV7(f.host, { ...omp, ...entryRoots(f, null), environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }), nativeLimit: () => 6 });
  await f.commands.get("startup")!.handler("new defaultroot", f.ctx);
  expect(f.admissions).toHaveLength(1);
});

test("manager rejects a foreign transcript before launching its owner", async () => {
  const f = fixture();
  const foreign = join(f.root, "foreign-manager.jsonl");
  writeFileSync(foreign, JSON.stringify({ type: "session", id: "native-root" }) + "\n");
  let launches = 0;
  installStartupV7(f.host, { ...omp, ...entryRoots(f, null), environment: f.environment, root: async () => ({ nativeSession: foreign, file: foreign, lastAssistant: undefined }), launch: async (config) => { launches++; return { ...config, socketPath: f.socketPath }; }, nativeLimit: () => 6 });
  await f.commands.get("startup")!.handler("new foreign", f.ctx);
  expect(launches).toBe(0);
  expect(f.messages.join("\n")).toContain("Native transcript");
});

async function lifecycleOwnerFixture() {
  const f = fixture();
  const startupRoot = f.environment.STARTUP_ROOT!;
  let now = 1000;
  const store = openStore({ path: join(startupRoot, "staff.sqlite"), scope: { skillsHome: f.skillsHome, startupRoot, boundRoot: f.cwd, host: hostname(), name: "lifecycle", managerSession: "native-root" }, owner: { id: "lifecycle-owner", managerGeneration: 1, leaseMs: 60000 }, now: () => now });
  cleanup.push(() => store.close());
  const config: RuntimeHostConfig = { name: "lifecycle", skillsHome: f.skillsHome, startupRoot, stateDirectory: startupRoot, boundRoot: f.cwd, skillsRoot: f.skillsRoot, socketPath: join(startupRoot, "r.sock"), profile: "default", managerSession: "native-root", managerFile: f.file, managerPaneId: "w1:p1", managerCredential: "owner-manager", herdrSession: "fixture", workspaceId: "w1", herdrBinary: "unused", herdrIntegration: f.environment.STARTUP_HERDR_OMP_EXTENSION!, ownerGeneration: 1, policy: { tickMs: 1000, paCadenceMs: 60000, progressDeadlineMs: 300000, connectionDeadlineMs: 30000, executionLimit: 8 } };
  const observations: HerdrObservation[] = [{ harness: "omp", name: "manager", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "manager-term", nativeSession: f.file, state: "idle", stateSequence: 1, interactiveReady: true }];
  let commandAccepted: (() => void) | null = null;
  let lastConnection: string | null = null;
  let commandBarrier: Readonly<{ entered: () => void; wait: Promise<void> }> | null = null;
  let commandResultBarrier: Readonly<{ entered: () => void; wait: Promise<void> }> | null = null;
  let observationBarrier: Readonly<{ entered: () => void; wait: Promise<void> }> | null = null;
  let layouts = 0;
  let launches = 0;
  const herdr: HerdrRuntime = {
    check: async () => {}, renameCrew: async () => {},
    createCrew: async () => { layouts++; return { tabId: `w1:t${layouts + 1}`, rootPaneId: `w1:p${layouts + 1}` }; },
    split: async () => `w1:p${++layouts + 1}`,
    launch: async (input) => {
      launches++;
      const nativeSession = join(f.agentDirectory, "sessions", `${input.name}.jsonl`);
      writeFileSync(nativeSession, JSON.stringify({ type: "session", id: input.name }) + "\n");
      const observation: HerdrObservation = { harness: "omp", name: input.name, workspaceId: "w1", tabId: "w1:t2", paneId: input.paneId, terminalId: input.name, nativeSession, state: "idle", stateSequence: 1, interactiveReady: true };
      observations.push(observation);
      return observation;
    },
    observe: async () => { if (observationBarrier !== null) { observationBarrier.entered(); await observationBarrier.wait; } return observations; },
  };
  const coordinator = openCoordinator({ store, config, herdr, now: () => now });
  await coordinator.start();
  const server = serveCoordinator({ coordinator: { ...coordinator, command: async (connection, command) => {
    lastConnection = connection;
    if (commandBarrier !== null) { commandBarrier.entered(); await commandBarrier.wait; }
    const pending = coordinator.command(connection, command);
    commandAccepted?.();
    const result = await pending;
    if (commandResultBarrier !== null) { commandResultBarrier.entered(); await commandResultBarrier.wait; }
    return result;
  } }, socketPath: config.socketPath });
  cleanup.push(() => server.stop(true));
  const pa = store.runtimeBindings().find((bound) => bound.employeeId !== "manager");
  const observedPa = observations.find((entry) => entry.paneId === pa?.paneId);
  if (pa === undefined || pa.paneId === null || !observedPa?.nativeSession) throw new Error("Missing PA launch");
  const manifest = join(startupRoot, "launches", `${pa.launchId}.json`);
  const saved = z.object({ credential: z.string(), source: sourceSchema }).parse(JSON.parse(readFileSync(manifest, "utf8")));
  const client = await connectEmployee({ socketPath: config.socketPath, credential: saved.credential, source: saved.source, nativeSession: observedPa.nativeSession, paneId: pa.paneId, agentSessionId: `s-${pa.launchId.replaceAll("-", "").slice(0, 28)}` });
  cleanup.push(() => { client.close(); });
  return { f, store, coordinator, config, client, manifest, connection: () => lastConnection, onCommandAccepted: (callback: () => void) => { commandAccepted = callback; }, pa: store.employeeRuntime(pa.employeeId, pa.generation)!, delayCommand: (entered: () => void, wait: Promise<void>) => { commandBarrier = { entered, wait }; }, delayResult: (entered: () => void, wait: Promise<void>) => { commandResultBarrier = { entered, wait }; }, advance: (value: number) => { now = value; }, counts: () => ({ layouts, launches }), delayObservation: (entered: () => void, wait: Promise<void>) => { observationBarrier = { entered, wait }; } };
}

for (const lifecycle of ["session_start", "session_shutdown"] as const) test(`production manager ${lifecycle} fences awaiting and queued owner mutations`, async () => {
  const o = await lifecycleOwnerFixture();
  const { f } = o;
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async () => o.config });
  await f.commands.get("startup")!.handler("new lifecycle", f.ctx);
  await f.tools.get("startup_intake")!.execute("intake", { eventId: "pending-native", input: "work", amendItemIds: [] }, undefined, undefined, f.ctx);
  const barrier = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  o.delayObservation(entered.resolve, barrier.promise);
  const pending = f.tools.get("startup_delegate")!.execute("delegate", { eventId: "pending-native", developers: 1 }, undefined, undefined, f.ctx).then(() => "committed", () => "rejected");
  await entered.promise;
  const accepted = Promise.withResolvers<void>();
  o.onCommandAccepted(accepted.resolve);
  const queued = f.tools.get("startup_intake")!.execute("queued", { eventId: "queued-native", input: "work", amendItemIds: [] }, undefined, undefined, f.ctx).then(() => "committed", () => "rejected");
  await accepted.promise;
  const before = o.counts();
  const changed: NativeContext = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "changed-native" } };
  await f.emit(lifecycle, {}, lifecycle === "session_start" ? changed : f.ctx);
  await expect(o.coordinator.poll(o.connection()!)).rejects.toThrow("connection");
  barrier.resolve();
  expect(await pending).toBe("rejected");
  expect(await queued).toBe("rejected");
  await o.coordinator.launching();
  expect(o.store.snapshot().teams).toHaveLength(0);
  expect(o.store.snapshot().teamRequirements).toHaveLength(0);
  expect(o.store.snapshot().intakes.map((entry) => entry.request.eventId)).toEqual(["pending-native"]);
  expect(o.counts()).toEqual(before);
});

for (const lifecycle of ["session_start", "session_shutdown"] as const) test(`production employee ${lifecycle} fences a pending owner write`, async () => {
  const o = await lifecycleOwnerFixture();
  const { f } = o;
  const ctx = await installOwnerEmployee(o);
  expect(f.messages.filter((message) => message.includes("boot blocked"))).toEqual([]);
  const barrier = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  o.delayCommand(entered.resolve, barrier.promise);
  const pending = f.tools.get("startup_claim")!.execute("claim", {}, undefined, undefined, ctx).then(() => "committed", () => "rejected");
  await entered.promise;
  const changed: NativeContext = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "changed" } };
  await f.emit(lifecycle, {}, lifecycle === "session_start" ? changed : ctx);
  await expect(o.coordinator.poll(o.connection()!)).rejects.toThrow("connection");
  barrier.resolve();
  expect(await pending).toBe("rejected");
  await Bun.sleep(0);
  expect(o.store.snapshot().claims).toHaveLength(0);
});

test("production shutdown after delegation commit retains one durable result for read-only recovery", async () => {
  const o = await lifecycleOwnerFixture();
  const { f } = o;
  installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async () => o.config });
  await f.commands.get("startup")!.handler("new lifecycle", f.ctx);
  await f.tools.get("startup_intake")!.execute("intake", { eventId: "committed-native", input: "work", amendItemIds: [] }, undefined, undefined, f.ctx);
  const barrier = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  o.delayResult(committed.resolve, barrier.promise);
  const pending = f.tools.get("startup_delegate")!.execute("delegate", { eventId: "committed-native", developers: 1 }, undefined, undefined, f.ctx).then(() => "delivered", () => "uncertain");
  await committed.promise;
  expect(o.store.snapshot().teams).toHaveLength(1);
  await f.emit("session_shutdown", {}, f.ctx);
  barrier.resolve();
  expect(await pending).toBe("uncertain");
  await o.coordinator.launching();
  const before = o.store.snapshot();
  const effects = o.counts();
  const manager = o.store.employeeRuntime("manager", 1)!;
  const client = await connectEmployee({ socketPath: o.config.socketPath, credential: o.config.managerCredential, source: manager.source, nativeSession: f.file, paneId: "w1:p1", agentSessionId: "native-root" });
  try {
    const recovered = z.object({ manager: z.object({ crews: z.array(z.object({ id: z.string(), eventId: z.string() })) }), intakes: z.array(z.object({ eventId: z.string(), teamId: z.string().nullable() })) }).parse(await client.request({ kind: "staff" }));
    expect(recovered.manager.crews).toEqual([expect.objectContaining({ id: before.teams[0]!.id, eventId: "committed-native" })]);
    expect(recovered.intakes).toEqual([{ eventId: "committed-native", teamId: before.teams[0]!.id }]);
    expect(o.store.snapshot().teamRequirements).toHaveLength(1);
    expect(o.store.snapshot().teams).toEqual(before.teams);
    expect(o.counts()).toEqual(effects);
  } finally { client.close(); }
});

for (const role of ["manager", "employee"] as const) for (const loss of ["close", "error", "bridge"] as const) test(`${role} native tools block immediately after delivered ${loss} before heartbeat`, async () => {
  const f = fixture();
  const send = WebSocket.prototype.send;
  const sockets: WebSocket[] = [];
  const socketSpy = spyOn(WebSocket.prototype, "send").mockImplementation(function(this: WebSocket, data) {
    if (!sockets.includes(this)) sockets.push(this);
    return send.call(this, data);
  });
  cleanup.push(() => socketSpy.mockRestore());
  if (role === "employee") {
    installLaunchedEmployee(f.host, f.manifest("dev"));
    await f.emit("session_start", {}, f.ctx);
  } else {
    installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }) });
    await f.commands.get("startup")!.handler("new closure", f.ctx);
  }
  expect(f.admissions).toHaveLength(1);
  const polls = f.pollReports.length;
  if (loss === "bridge") {
    const shutdown = f.handlers.get("session_shutdown")!.at(-1)!;
    await shutdown({}, f.ctx);
  } else {
    const socket = sockets[0]!;
    if (loss === "error") socket.onerror?.(new Event("error"));
    else socket.onclose?.(new CloseEvent("close"));
  }
  for (const toolName of ["bash", "write"]) expect(await f.emit("tool_call", { toolName, input: {} }, f.ctx)).toMatchObject({ block: true });
  expect(f.pollReports).toHaveLength(polls);
  await f.commands.get("startup-retry")!.handler("", f.ctx);
  expect(f.admissions).toHaveLength(2);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, f.ctx)).toBeUndefined();
});

async function installOwnerEmployee(o: Awaited<ReturnType<typeof lifecycleOwnerFixture>>): Promise<NativeContext> {
  const { f } = o;
  const nativeSession = o.pa.nativeSession!;
  const sessionId = z.object({ id: z.string() }).parse(JSON.parse(readFileSync(nativeSession, "utf8").split("\n")[0]!)).id;
  const ctx: NativeContext = { ...f.ctx, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => nativeSession } };
  const original = f.host.pi.AgentRegistry.global().get("Main")!;
  const ref: NativeRef = { ...original, session: { ...original.session!, sessionManager: ctx.sessionManager } };
  const host: HostAPI = { ...f.host, pi: { ...f.host.pi, AgentRegistry: { global: () => ({ get: () => ref, list: () => [ref], onChange: () => () => {} }) } } };
  f.environment.HERDR_PANE_ID = o.pa.paneId!;
  f.useEnvironment();
  installLaunchedEmployee(host, o.manifest);
  await f.emit("session_start", {}, ctx);
  return ctx;
}

for (const pendingInput of [false, true]) test(`expired employee explicitly re-admits without replay; pending input ${pendingInput}`, async () => {
  const o = await lifecycleOwnerFixture();
  const { f } = o;
  const ctx = await installOwnerEmployee(o);
  const connectionEpoch = (): string => {
    const db = new Database(join(o.config.startupRoot, "staff.sqlite"), { readonly: true });
    try { return z.object({ epoch: z.string() }).parse(db.query("SELECT json_extract(payload,'$.identity.connectionEpoch') AS epoch FROM records WHERE kind='runtimeConnection' AND id=?").get(o.pa.launchId)).epoch; }
    finally { db.close(); }
  };
  const oldEpoch = connectionEpoch();
  const inputPath = join(o.config.startupRoot, "input-receipts", createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex") + ".json");
  if (pendingInput) {
    await f.emit("input", { id: "expiry-input", text: "saved input", source: "interactive" }, ctx);
    const receipt = z.record(z.string(), jsonSchema).parse(JSON.parse(readFileSync(inputPath, "utf8")));
    writeFileSync(inputPath, encode({ ...receipt, state: "uncertain" }), { mode: 0o600 });
  }
  const savedMessages = o.store.snapshot().messages;
  o.advance(32000);
  await f.emit("context", { messages: [] }, ctx);
  expect(await f.emit("tool_call", { toolName: "write", input: {} }, ctx)).toMatchObject({ block: true });
  await f.commands.get("startup-retry")!.handler("", ctx);
  expect(connectionEpoch()).not.toBe(oldEpoch);
  if (pendingInput) expect(JSON.parse(readFileSync(inputPath, "utf8"))).toMatchObject({ id: "expiry-input", state: "committed" });
  expect(o.store.snapshot().messages).toEqual(savedMessages);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, ctx)).toBeUndefined();
  const changed: NativeContext = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "changed" } };
  const epoch = connectionEpoch();
  await f.commands.get("startup-retry")!.handler("", changed);
  expect(connectionEpoch()).toBe(epoch);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, changed)).toMatchObject({ block: true });
});

for (const role of ["manager", "employee"] as const) test(`${role} accepts a canonical shared OMP root at mode 0755 without changing it`, async () => {
  const f = fixture();
  const sharedRoot = f.agentDirectory;
  chmodSync(sharedRoot, 0o755);
  if (role === "employee") {
    installLaunchedEmployee(f.host, f.manifest("dev"));
    await f.emit("session_start", {}, f.ctx);
  } else {
    installStartupV7(f.host, { ...omp, ...entryRoots(f), nativeLimit: () => 6, environment: f.environment, launch: async (config) => ({ ...config, socketPath: f.socketPath }) });
    await f.commands.get("startup")!.handler("new shared", f.ctx);
  }
  expect(f.messages.filter((message) => message.includes("boot blocked"))).toEqual([]);
  expect(f.admissions).toHaveLength(1);
  expect(statSync(sharedRoot).mode & 0o777).toBe(0o755);
  expect(await f.emit("tool_call", { toolName: "bash", input: {} }, f.ctx)).toBeUndefined();
});

test("shared OMP containment does not weaken private Startup root permissions or native header identity", async () => {
  const f = fixture();
  chmodSync(f.agentDirectory, 0o755);
  writeFileSync(f.file, JSON.stringify({ type: "session", id: "foreign" }) + "\n");
  await expect(nativeRoot(f.host, f.ctx)).rejects.toThrow("does not match");
  const startupRoot = f.environment.STARTUP_ROOT!;
  chmodSync(startupRoot, 0o755);
  expect(() => assertNativeTranscript({ harness: "claude", root: startupRoot, sessionId: "native-root", file: join(startupRoot, "projects", "repo", "native-root.jsonl") })).toThrow("owner-only");
});
