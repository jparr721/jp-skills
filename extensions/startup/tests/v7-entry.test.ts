import { afterEach, expect, test, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";
import type { HostAPI } from "../index";
import type { NativeContext, NativeRef } from "../src/omp-adapter";
import type { Json } from "../src/contracts";
import { connectEmployee } from "../src/employee-client";
import { loadProfile } from "../src/profiles";
import { startRuntimeHost } from "../runtime-host";
mock.module("@oh-my-pi/pi-coding-agent/task/settings", () => ({ cfgTaskMaxConcurrency: { get: () => 6 } }));
const { installLaunchedEmployee, installStartupV7 } = await import("../v7");
import { launchRuntimeHost, type RuntimeHostConfig } from "../src/v7-launch";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root: string = mkdtempSync(join(tmpdir(), "v7-entry-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const skillsRoot: string = join(root, "skills-repo");
  for (const role of ["manager", "dev", "pa"]) {
    mkdirSync(join(skillsRoot, "skills", `startup-role-${role}`), { recursive: true });
    writeFileSync(join(skillsRoot, "skills", `startup-role-${role}`, "SKILL.md"), `Complete canonical ${role} persona`);
  }
  mkdirSync(join(skillsRoot, "skills", "startup-loop"));
  writeFileSync(join(skillsRoot, "skills", "startup-loop", "SKILL.md"), "Complete canonical shared loop");
  const cwd: string = join(root, "repo");
  mkdirSync(cwd);
  const file: string = join(root, "native.jsonl");
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
    setInterval(callback, ms) { const timer = setInterval(callback, ms); timers.add(timer); return timer; },
    clearTimer(timer) { clearInterval(timer); timers.delete(timer); },
  };
  const ref: NativeRef = {
    id: "Main", kind: "main", status: "idle", createdAt: 1, sessionFile: file,
    session: { sessionManager: ctx.sessionManager, settings: {}, getPlanModeState: () => undefined, getToolByName: () => undefined },
  };
  const schema: ReturnType<HostAPI["zod"]["object"]> = { or: () => schema, and: () => schema, toJsonSchema: () => ({}) };
  const host: HostAPI = {
    pi: { VERSION: "18.8.9", settings: {}, AgentRegistry: { global: () => ({ get: (id) => id === "Main" ? ref : undefined, list: () => [ref], onChange: () => () => {} }) } },
    zod: { object: () => schema, string: () => ({}), number: () => ({}), unknown: () => ({}), array: () => ({}), literal: () => ({}), enum: () => ({}) },
    arktype: () => schema,
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
  const socketPath: string = join(root, "runtime.sock");
  let projection: string = "Complete canonical dev persona\nComplete canonical shared loop";
  const server = Bun.serve({ unix: socketPath, async fetch(request: Request): Promise<Response> {
    const path: string = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "running" });
    if (path === "/admit") { admissions.push(z.json().parse(await request.json())); return Response.json({ connection: "private-token" }); }
    if (path === "/poll") return Response.json({ projection, pendingMessageIds: [], waitReason: null, toolBlockReason: null });
    const command: Json = z.json().parse(await request.json());
    requests.push(command);
    if (z.object({ kind: z.literal("image") }).safeParse(command).success)
      return Response.json({ type: "image", data: "fixture-image", mimeType: "image/png" });
    return Response.json(command);
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
    HERDR_ENV: "1", HERDR_SESSION: "fixture", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", OMP_PROFILE: "isolated-test", STARTUP_HERDR_OMP_EXTENSION: integration,
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
    const path: string = join(root, "manifest.json");
    writeFileSync(path, JSON.stringify({ socketPath, credential: "private-credential", source: profile.source, employeeId: profile.employeeId, generation: 1, profile: "isolated-test", skillsRoot }), { mode: 0o600 });
    return path;
  }
  return { root, skillsRoot, cwd, file, ctx, host, tools, commands, messages, requests, admissions, socketPath, environment, useEnvironment, manifest, emit, getAborts: () => aborts, setProjection(value: string) { projection = value; } };
}

test("manager extension loads before native action methods become available", () => {
  const f = fixture();
  const host: HostAPI = { ...f.host, getCommands: () => { throw new Error("Extension runtime not initialized"); } };
  expect(() => installStartupV7(host, {
    home: join(f.root, "home"), skillsRoot: f.skillsRoot, nativeLimit: () => 6, environment: f.environment,
    launch: async (config) => ({ ...config, socketPath: f.socketPath }),
  })).not.toThrow();
  expect(f.commands.has("startup")).toBe(true);
});

test("launched root verifies source and transcript before admission, exposes dedicated tools and preserves interactive input", async () => {
  const f = fixture(); f.useEnvironment();
  installLaunchedEmployee(f.host, f.manifest("dev"));
  await f.emit("session_start", {}, f.ctx);
  expect(f.admissions).toHaveLength(1);
  expect(f.admissions[0]).toMatchObject({ nativeSession: f.file, paneId: "w1:p1", credential: "private-credential" });
  expect(f.tools.has("task")).toBe(false);
  for (const name of ["startup_claim", "startup_hire", "startup_delegate", "startup_activate", "startup_replace", "startup_capture", "startup_item"]) expect(f.tools.has(name)).toBe(true);
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

test("modified canonical source and parented transcript fail before any credential admission", async () => {
  for (const kind of ["source", "parent"]) {
    const f = fixture(); f.useEnvironment();
    const manifest = f.manifest("dev");
    if (kind === "source") writeFileSync(join(f.skillsRoot, "skills/startup-role-dev/SKILL.md"), "changed source");
    else writeFileSync(f.file, JSON.stringify({ type: "session", id: "native-root", parentSession: "/other-root.jsonl" }) + "\n");
    installLaunchedEmployee(f.host, manifest);
    await expect(f.emit("session_start", {}, f.ctx)).rejects.toThrow(kind === "source" ? "source" : "parented");
    expect(f.admissions).toHaveLength(0);
  }
});

test("manager boot preserves native command work and binds independent runtime config to original session", async () => {
  const f = fixture();
  const launched: RuntimeHostConfig[] = [];
  installStartupV7(f.host, {
    home: join(f.root, "home"), skillsRoot: f.skillsRoot, nativeLimit: () => 6, environment: f.environment,
    launch: async (config) => { launched.push(config); return { ...config, socketPath: f.socketPath }; },
  });
  await f.emit("input", { text: "/startup new alpha --  fix exact work  ", source: "interactive", images: [] }, f.ctx);
  expect(launched).toHaveLength(1);
  expect(launched[0]).toMatchObject({ managerSession: "native-root", managerFile: f.file, managerPaneId: "w1:p1", herdrSession: "fixture", workspaceId: "w1", profile: "isolated-test", ownerGeneration: 1 });
  expect(readFileSync(join(f.cwd, "AGENTS.md"), "utf8")).toContain("Selected Startup: alpha");
  expect(f.requests[0]).toMatchObject({ kind: "receive", raw: { text: "/startup new alpha --  fix exact work  ", images: [] } });
  expect(f.requests[1]).toMatchObject({ kind: "route", disposition: "work" });
  const command = f.commands.get("startup");
  if (!command) throw new Error("Missing Startup command");
  await command.handler("new alpha --  fix exact work  ", f.ctx);
  expect(launched).toHaveLength(1);
  expect(f.requests.filter((request) => z.object({ kind: z.literal("receive") }).safeParse(request).success)).toHaveLength(1);
});

test("outside Herdr, unnamed profiles and wrong OMP versions cannot launch a coordinator", async () => {
  for (const kind of ["outside", "profile", "version"]) {
    const f = fixture();
    let launched: boolean = false;
    const host: HostAPI = kind === "version" ? { ...f.host, pi: { ...f.host.pi, VERSION: "18.8.8" } } : f.host;
    const environment = { ...f.environment };
    if (kind === "outside") delete environment.HERDR_ENV;
    if (kind === "profile") delete environment.OMP_PROFILE;
    installStartupV7(host, { home: join(f.root, "home"), skillsRoot: f.skillsRoot, nativeLimit: () => 6, environment, launch: async (config) => { launched = true; return config; } });
    expect(await f.emit("input", { text: "/startup new alpha", source: "interactive", images: [] }, f.ctx)).toEqual({ handled: true });
    expect(launched).toBe(false);
    expect(f.messages.join("\n")).toContain("blocked");
    expect(f.admissions).toHaveLength(0);
    expect(f.getAborts()).toBeGreaterThan(0);
    expect(await f.emit("tool_call", { toolName: "bash", input: { command: "must not execute" } }, f.ctx)).toMatchObject({ block: true });
    expect(await f.emit("session_stop", {}, f.ctx)).toMatchObject({ continue: true });
    expect(await f.emit("session_stop", {}, f.ctx)).toBeUndefined();
  }
});

test("existing live runtime intent is reused without spawning a duplicate host", async () => {
  const f = fixture();
  const stateDirectory: string = join(f.root, "state");
  mkdirSync(stateDirectory);
  const config: RuntimeHostConfig = {
    name: "alpha", home: join(f.root, "home"), stateDirectory, boundRoot: f.cwd, skillsRoot: f.skillsRoot,
    socketPath: f.socketPath, profile: "isolated-test", managerSession: "native-root", managerFile: f.file, managerPaneId: "w1:p1", managerCredential: "private-credential",
    herdrSession: "fixture", workspaceId: "w1", herdrBinary: "/must-not-run", herdrIntegration: f.environment.STARTUP_HERDR_OMP_EXTENSION ?? "", ownerGeneration: 1,
    policy: { tickMs: 100, paCadenceMs: 1000, progressDeadlineMs: 3000, connectionDeadlineMs: 1000, executionLimit: 4 },
  };
  writeFileSync(join(stateDirectory, "runtime-config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(stateDirectory, "runtime-launch.json"), JSON.stringify({ state: "spawned", pid: process.pid, startedAt: 1 }), { mode: 0o600 });
  expect(await launchRuntimeHost(config)).toEqual(config);
  expect(statSync(join(stateDirectory, "runtime-config.json")).mode & 0o777).toBe(0o600);
});


function runtimeFixture(f: ReturnType<typeof fixture>): Readonly<{ config: RuntimeHostConfig; stateFile: string }> {
  const home: string = join(f.root, "runtime-home");
  const stateDirectory: string = join(home, "startup", "alpha");
  const socketPath: string = join(f.root, "actual-runtime.sock");
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
  const native = ${JSON.stringify(join(f.root, "fake-pa.jsonl"))};
  writeFileSync(native, JSON.stringify({ type: "session", id: args[2] }) + String.fromCharCode(10));
  const agent = { ...location, agent: "omp", name: args[2], agent_status: "idle", state_change_seq: 1, interactive_ready: true, agent_session: { source: "herdr:omp", agent: "omp", kind: "path", value: native } };
  state.agents.push(agent);
  writeFileSync(stateFile, JSON.stringify(state));
  result = { id: "fixture", result: { type: "agent_started", agent, argv: ["omp"] } };
} else throw new Error("Unexpected fake Herdr command " + JSON.stringify(args));
process.stdout.write(JSON.stringify(result));
`;
  writeFileSync(fake, script, { mode: 0o700 }); chmodSync(fake, 0o700);
  writeFileSync(stateFile, JSON.stringify({ agents: [{ agent: "omp", name: "manager", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: "term-1", agent_status: "idle", state_change_seq: 1, interactive_ready: true, agent_session: { source: "herdr:omp", agent: "omp", kind: "path", value: f.file } }] }));
  const config: RuntimeHostConfig = {
    name: "alpha", home, stateDirectory, boundRoot: f.cwd, skillsRoot: f.skillsRoot, socketPath, profile: "isolated-test", managerSession: "native-root", managerFile: f.file, managerPaneId: "w1:p1", managerCredential: "private-credential",
    herdrSession: "fixture", workspaceId: "w1", herdrBinary: fake, herdrIntegration: f.environment.STARTUP_HERDR_OMP_EXTENSION ?? "", ownerGeneration: 1,
    policy: { tickMs: 1000, paCadenceMs: 60000, progressDeadlineMs: 300000, connectionDeadlineMs: 30000, executionLimit: 8 },
  };
  return { config, stateFile };
}

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
      expect(z.object({ host: z.string() }).parse(JSON.parse(scope.payload)).host).toBe(hostname() + ":startup-v7");
    } finally { database.close(); }
  } finally { await runtime.close(); }
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


test("swallowed native session-start failure still aborts and blocks native root tools", async () => {
  const f = fixture(); f.useEnvironment();
  const manifest: string = f.manifest("dev");
  installLaunchedEmployee(f.host, manifest);
  expect(await f.emit("tool_call", { toolName: "bash", input: { command: "before admission" } }, f.ctx)).toMatchObject({ block: true });
  writeFileSync(join(f.skillsRoot, "skills/startup-role-dev/SKILL.md"), "modified source");
  try { await f.emit("session_start", {}, f.ctx); } catch { /* Native ExtensionRunner reports and swallows hook errors. */ }
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
    else installStartupV7(f.host, { home: join(f.root, "home"), skillsRoot: f.skillsRoot, nativeLimit: () => 6, environment: f.environment, launch: async (config) => config });
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
  const f = fixture();
  f.environment.OMP_PROFILE = "startup.v7";
  f.useEnvironment();
  const path: string = f.manifest("dev");
  const manifest = z.record(z.string(), z.json()).parse(JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(path, JSON.stringify({ ...manifest, profile: "startup.v7" }));
  installLaunchedEmployee(f.host, path);
  await f.emit("session_start", {}, f.ctx);
  expect(f.admissions).toHaveLength(1);
});
