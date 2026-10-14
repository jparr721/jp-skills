import { afterEach, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HostAPI } from "../index";
import type {
  NativeContext,
  NativeRef,
  NativeRegistry,
  NativeResult,
} from "../src/omp-adapter";

const setting = { get: () => 32 };
mock.module("@oh-my-pi/pi-coding-agent/task/types", () => ({
  getTaskSchema: () => ({}),
}));
mock.module("@oh-my-pi/pi-coding-agent/task/settings", () => ({
  cfgTaskBatch: setting,
  cfgTaskEnableEffort: setting,
  cfgTaskIsolationEnabled: setting,
  cfgTaskMaxConcurrency: setting,
}));
mock.module("@oh-my-pi/pi-coding-agent/task/discovery", () => ({
  discoverAgents: async () => ({ agents: [] }),
}));
mock.module("@oh-my-pi/pi-coding-agent/task/spawn-policy", () => ({
  resolveSpawnPolicy: () => ({ defaultAgent: "task" }),
}));
mock.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
  lookup: () => setting,
}));
const {
  installStartup,
  parseExecutionLimit,
  default: startupEntry,
} = await import("../index");
const nativeSchema: ReturnType<HostAPI["zod"]["object"]> = {
  or: () => nativeSchema,
  and: () => nativeSchema,
  toJsonSchema: () => ({}),
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function entryFixture() {
  const root = mkdtempSync(join(tmpdir(), "startup-entry-"));
  directories.push(root);
  for (const name of ["startup-role-manager", "startup-loop"]) {
    const path = join(root, "skills", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), "Complete fixture canonical source");
  }
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  const file = join(root, "session.jsonl");
  writeFileSync(file, '{"type":"session","id":"same-canonical-session"}\n');
  const ctx: NativeContext = {
    agent: { id: "Main", kind: "main" },
    cwd,
    sessionManager: {
      getSessionId: () => "same-canonical-session",
      getSessionFile: () => file,
    },
    getSystemPrompt: () => [],
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearTimer: clearInterval,
  };
  const nativeTools = new Map<
    string,
    Readonly<{
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<NativeResult>;
    }>
  >();
  let native: NativeRef = {
    id: "Main",
    kind: "main",
    status: "idle",
    createdAt: 1,
    sessionFile: file,
    session: {
      sessionManager: ctx.sessionManager,
      settings: {},
      getPlanModeState: () => undefined,
      getToolByName: (name) => nativeTools.get(name),
    },
  };
  const helpers: NativeRef[] = [];
  const registry: NativeRegistry = {
    get: (id) => (id === "Main" ? native : undefined),
    list: () => [native, ...helpers],
    onChange: () => () => {},
  };
  function factory(name: string | null) {
    const handlers = new Map<
      string,
      (event: unknown, context: NativeContext) => unknown
    >();
    const tools = new Map<string, Parameters<HostAPI["registerTool"]>[0]>();
    const commands = new Map<
      string,
      Parameters<HostAPI["registerCommand"]>[1]
    >();
    const messages: string[] = [];
    const api: HostAPI = {
      pi: {
        VERSION: "18.8.9",
        AgentRegistry: { global: () => registry },
        settings: {},
      },
      zod: {
        object: () => nativeSchema,
        string: () => ({}),
        number: () => ({}),
        unknown: () => ({}),
        array: () => ({}),
        literal: () => ({}),
        enum: () => ({}),
      },
      sendMessage: (message) => {
        messages.push(message.content);
      },
      events: { on: () => () => {} },
      arktype: (definition) => {
        expect(definition).toEqual({ "recoveryOffset?": "number" });
        return nativeSchema;
      },
      on: (name, handler) => {
        handlers.set(name, handler);
      },
      registerTool: (tool) => {
        tools.set(tool.name, tool);
      },
      registerCommand: (name, command) => {
        commands.set(name, command);
      },
      getCommands: () => [{ name: "fixture-status" }],
      getAllTools: () => [],
    };
    installStartup(api, {
      name,
      home: join(root, "home"),
      skillsRoot: root,
      employeeLimit: null,
      executionLimit: null,
      leaseMs: 60000,
    });
    return { handlers, tools, api, commands, messages };
  }
  return {
    ctx,
    root,
    factory,
    nativeTools,
    occupy: () => {
      for (let index = 0; index < 32; index++)
        helpers.push({
          ...native,
          id: `helper-${index}`,
          kind: "task",
          parentId: "Main",
          status: "running",
        });
    },
    release: () => {
      helpers.splice(0);
    },
    advance: () => {
      native = { ...native, createdAt: native.createdAt + 1 };
    },
  };
}

test("old root shutdown cannot close a newer root's same-session adapter", async () => {
  const { ctx, factory, advance } = entryFixture();
  const first = factory("fixture");
  await first.handlers.get("session_start")!({}, ctx);
  await first.handlers.get("session_shutdown")!({}, ctx);
  advance();
  const second = factory("fixture");
  await second.handlers.get("session_start")!({}, ctx);
  try {
    await first.handlers.get("session_shutdown")!({}, ctx);
    const staff = await second.tools
      .get("startup_staff")!
      .execute("staff", {}, undefined, undefined, ctx);
    expect(staff.isError).not.toBe(true);
    expect(staff.details).toMatchObject({ mode: "ready" });
  } finally {
    await second.handlers.get("session_shutdown")!({}, ctx);
  }
});

test("recovery classifies human input before wait/final without resolving unrelated claims", async () => {
  const { ctx, factory, advance } = entryFixture();
  const first = factory("fixture");
  await first.handlers.get("session_start")!({}, ctx);
  const tool = async (
    host: ReturnType<typeof factory>,
    name: string,
    params: unknown,
  ) => host.tools.get(name)!.execute(name, params, undefined, undefined, ctx);
  await tool(first, "startup_send", {
    id: "prior-mail",
    recipient: "manager",
    kind: "report",
    correlation: "prior",
    payload: {},
  });
  await tool(first, "startup_claim", {});
  await first.handlers.get("session_shutdown")!({}, ctx);
  advance();
  const next = factory("fixture");
  await next.handlers.get("session_start")!({}, ctx);
  try {
    expect((await tool(next, "startup_staff", {})).details).toMatchObject({
      mode: "recovery",
    });
    for (const disposition of ["status", "control", "decision", "work"]) {
      await next.handlers.get("input")!(
        { text: disposition, source: "rpc", images: [] },
        ctx,
      );
      expect(next.handlers.get("session_stop")!({}, ctx)).toMatchObject({
        continue: true,
      });
      const snapshot = (await tool(next, "startup_staff", {})).details;
      const inputId = z
        .object({
          inputs: z.array(
            z.object({ id: z.string(), disposition: z.unknown() }),
          ),
        })
        .parse(snapshot)
        .inputs.find((entry) => entry.disposition === null)!.id;
      expect(
        next.handlers.get("tool_call")!(
          { toolName: "startup_route", input: {} },
          ctx,
        ),
      ).toBeUndefined();
      await tool(next, "startup_route", {
        inputId,
        disposition,
        reason: "High-level recovery disposition",
        amendItemIds: [],
      });
      expect(
        next.handlers.get("tool_call")!({ toolName: "wait", input: {} }, ctx),
      ).toBeUndefined();
      expect(next.handlers.get("session_stop")!({}, ctx)).toBeUndefined();
      expect(
        next.handlers.get("tool_call")!({ toolName: "task", input: {} }, ctx),
      ).toMatchObject({ block: true });
    }
    await expect(
      Promise.resolve(
        next.handlers.get("input")!(
          { text: "/fixture-status", source: "rpc", images: [] },
          ctx,
        ),
      ),
    ).resolves.toBeUndefined();
    expect((await tool(next, "startup_staff", {})).details).toMatchObject({
      mode: "recovery",
    });
    await expect(tool(next, "startup_claim", {})).rejects.toThrow(
      "reconciliation",
    );
  } finally {
    await next.handlers.get("session_shutdown")!({}, ctx);
  }
});

test("host execution limit retains guards and rejects invalid input before store side effects", async () => {
  const { root, factory, ctx } = entryFixture();
  const host = factory("fixture");
  const old = {
    name: process.env.STARTUP_NAME,
    limit: process.env.STARTUP_EXECUTION_LIMIT,
    home: process.env.JP_SKILLS_HOME,
  };
  try {
    process.env.STARTUP_NAME = "fixture";
    process.env.JP_SKILLS_HOME = join(root, "home");
    for (const invalid of [
      "",
      "0",
      "-1",
      "1.2",
      " 1",
      "oops",
      "9007199254740992",
    ]) {
      process.env.STARTUP_EXECUTION_LIMIT = invalid;
      expect(() => startupEntry(host.api)).not.toThrow();
      await host.handlers.get("session_start")!({}, ctx);
      expect(
        await host.handlers.get("input")!(
          { text: "work", source: "rpc", images: [] },
          ctx,
        ),
      ).toEqual({ handled: true });
      expect(
        host.handlers.get("tool_call")!({ toolName: "read", input: {} }, ctx),
      ).toMatchObject({ block: true });
      expect(host.handlers.get("session_stop")!({}, ctx)).toMatchObject({
        continue: true,
      });
      expect(() => parseExecutionLimit(invalid)).toThrow();
      expect(
        existsSync(join(root, "home", "startup", "fixture", "staff.sqlite")),
      ).toBe(false);
    }
    expect(parseExecutionLimit(undefined)).toBeNull();
    expect(parseExecutionLimit("1")).toBe(1);
    expect(parseExecutionLimit("32")).toBe(32);
  } finally {
    for (const [key, value] of Object.entries({
      STARTUP_NAME: old.name,
      STARTUP_EXECUTION_LIMIT: old.limit,
      JP_SKILLS_HOME: old.home,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("normal wait honors the authoritative capacity guard with undelegated work", async () => {
  const { ctx, factory, occupy, release } = entryFixture();
  const host = factory("fixture");
  await host.handlers.get("session_start")!({}, ctx);
  const call = (name: string, params: unknown) =>
    host.tools.get(name)!.execute(name, params, undefined, undefined, ctx);
  const guard = (name: string) =>
    host.handlers.get("tool_call")!({ toolName: name, input: {} }, ctx);
  try {
    await call("startup_intake", {
      eventId: "pending",
      input: "work",
      amendItemIds: [],
    });
    expect(guard("wait")).toMatchObject({ block: true });
    expect(guard("yield")).toMatchObject({ block: true });
    occupy();
    expect(guard("wait")).toBeUndefined();
    await call("startup_block", {
      key: "pending",
      evidence: { kind: "capacity" },
    });
    expect(guard("yield")).toBeUndefined();
    expect(host.handlers.get("session_stop")!({}, ctx)).toBeUndefined();
    await host.handlers.get("input")!(
      { text: "unclassified", source: "rpc", images: [] },
      ctx,
    );
    expect(guard("wait")).toMatchObject({ block: true });
    expect(host.handlers.get("session_stop")!({}, ctx)).toMatchObject({
      continue: true,
    });
    const staff = z
      .object({ inputs: z.array(z.object({ id: z.string() })) })
      .parse((await call("startup_staff", {})).details);
    await call("startup_route", {
      inputId: staff.inputs[0]!.id,
      disposition: "status",
      reason: "status",
      amendItemIds: [],
    });
    release();
    expect(guard("wait")).toMatchObject({ block: true });
    expect(guard("read")).toMatchObject({ block: true });
  } finally {
    await host.handlers.get("session_shutdown")!({}, ctx);
  }
});

test("unbound native boot preserves first work and images and gates malformed AGENTS", async () => {
  const { ctx, factory, root } = entryFixture();
  const host = factory(null);
  await host.handlers.get("session_start")!({}, ctx);
  const input = {
    text: "/startup new first -- fix screenshot",
    source: "rpc",
    images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
  };
  await host.handlers.get("input")!(input, ctx);
  await host.commands
    .get("startup")!
    .handler("new first -- fix screenshot", ctx);
  const result = await host.tools
    .get("startup_staff")!
    .execute("staff", {}, undefined, undefined, ctx);
  expect(result.details).toMatchObject({
    inputCounts: { total: 1, unclassified: 0 },
    teams: [],
  });
  expect(
    host.messages.some((text) => text.includes("Saved Startup work event")),
  ).toBe(true);
  const saved = JSON.parse(
    readFileSync(join(ctx.cwd, "AGENTS.md"), "utf8")
      .split("<!-- identity: ")[1]!
      .split(" -->")[0]!,
  );
  expect(saved.name).toBe("first");
  await host.handlers.get("session_shutdown")!({}, ctx);
  const broken = factory("broken");
  writeFileSync(join(ctx.cwd, "AGENTS.md"), "<!-- jp-skills-startup:begin -->");
  await broken.handlers.get("session_start")!({}, ctx);
  expect(
    await broken.handlers.get("input")!(
      { text: "work", source: "rpc", images: [] },
      ctx,
    ),
  ).toEqual({ handled: true });
  expect(
    broken.handlers.get("tool_call")!({ toolName: "read", input: {} }, ctx),
  ).toMatchObject({ block: true });
  expect(broken.handlers.get("session_stop")!({}, ctx)).toMatchObject({
    continue: true,
  });
  expect(
    existsSync(join(root, "home", "startup", "broken", "staff.sqlite")),
  ).toBe(false);
});

test("native first-space command split correlates repeated and trailing spaces", async () => {
  for (const text of [
    "/startup  new spaced -- fix this",
    "/startup new spaced -- fix this   ",
    "/startup   new spaced -- fix this \t\n",
  ]) {
    const { ctx, factory } = entryFixture();
    const host = factory(null);
    await host.handlers.get("session_start")!({}, ctx);
    const images = [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }];
    await host.handlers.get("input")!({ text, source: "rpc", images }, ctx);
    const args = text.slice(text.indexOf(" ") + 1);
    try {
      await host.commands.get("startup")!.handler(args, ctx);
      expect(
        host.messages.some((message) =>
          message.includes("Saved Startup work event"),
        ),
      ).toBe(true);
    } finally {
      await host.handlers.get("session_shutdown")!({}, ctx);
    }
  }
});

test("nonmatching native command names and delimiters never boot Startup", async () => {
  for (const text of [
    "/startup-other new unrelated",
    "/startup\tnew unrelated",
    "/startup\nnew unrelated",
    " /startup new unrelated",
    "/startup\u00a0new unrelated",
  ]) {
    const { ctx, factory, root } = entryFixture();
    const host = factory(null);
    await host.handlers.get("session_start")!({}, ctx);
    expect(
      await host.handlers.get("input")!(
        { text, source: "rpc", images: [] },
        ctx,
      ),
    ).toBeUndefined();
    expect(existsSync(join(ctx.cwd, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(root, "home/startup/unrelated/staff.sqlite"))).toBe(
      false,
    );
  }
});

test("recovery permits only the admitted native duty verification read through entry guards", async () => {
  const { ctx, root, factory, advance, nativeTools } = entryFixture();
  const target: string = join(ctx.cwd, "target.json");
  const health: string = join(ctx.cwd, "health.json");
  writeFileSync(target, '{"enabled":false}\n');
  writeFileSync(health, '{"healthy":false}\n');
  let host = factory("fixture");
  let failRead: boolean = false;
  let lastRead: Readonly<{
    toolName: string;
    toolCallId: string;
    input: { path: string };
  }> | null = null;
  const call = (name: string, params: unknown) =>
    host.tools.get(name)!.execute(name, params, undefined, undefined, ctx);
  const guard = (event: unknown, context: NativeContext) =>
    host.handlers.get("tool_call")!(event, context);
  nativeTools.set("write", {
    execute: async (_id, params) => {
      const parsed = z
        .object({ path: z.string(), content: z.string() })
        .parse(params);
      writeFileSync(parsed.path, parsed.content);
      return { content: [] };
    },
  });
  nativeTools.set("read", {
    execute: async (id, params) => {
      const input = z.strictObject({ path: z.string() }).parse(params);
      const event = { toolName: "read", toolCallId: id, input };
      lastRead = event;
      const staff = await call("startup_staff", {});
      if (
        z.object({ mode: z.string() }).parse(staff.details).mode === "recovery"
      ) {
        for (const attempt of [
          { ...event, toolCallId: "model-read" },
          { ...event, input: { path: target + ":raw" } },
          { ...event, toolName: "write" },
          { ...event, toolCallId: undefined },
          { ...event, input: { ...input, offset: 1 } },
        ])
          expect(guard(attempt, ctx)).toMatchObject({ block: true });
        expect(() =>
          guard(event, {
            ...ctx,
            sessionManager: {
              ...ctx.sessionManager,
              getSessionId: () => "foreign-session",
            },
          }),
        ).toThrow("session");
      }
      const outcome = guard(event, ctx);
      if (outcome !== undefined) throw new Error(JSON.stringify(outcome));
      if (failRead) throw new Error("Native verification fixture failure");
      const path: string = input.path.replace(/:raw$/, "");
      const text: string = readFileSync(path, "utf8");
      return {
        content: [],
        details: {
          totalLines: text.split("\n").length,
          fileSize: Buffer.byteLength(text),
          displayContent: {
            text,
            startLine: 1,
            lineNumbers: text.split("\n").map((_line, index) => index + 1),
          },
          meta: { source: { type: "path", value: path } },
        },
      };
    },
  });
  await host.handlers.get("session_start")!({}, ctx);
  await call("startup_duty", {
    id: "saved",
    employeeId: "manager",
    target,
    probe: health,
    acceptance: { path: ["healthy"], equals: true },
    repairAuthority: {
      kind: "replace-json",
      payload: { enabled: true },
      verification: {
        path: health,
        acceptance: { path: ["healthy"], equals: true },
      },
    },
    cadenceMs: 1000,
    nextDue: Date.now() + 3600000,
  });
  await call("startup_repair_authorize", { id: "repair", dutyId: "saved" });
  await expect(
    call("startup_repair", { authorizationId: "repair" }),
  ).rejects.toThrow("acceptance failed");
  const grants = z
    .object({ managerGrants: z.array(z.object({ id: z.string() })) })
    .parse((await call("startup_staff", {})).details);
  const grantId: string = grants.managerGrants[0]!.id;
  await host.handlers.get("session_shutdown")!({}, ctx);
  advance();
  host = factory("fixture");
  await host.handlers.get("session_start")!({}, ctx);
  try {
    expect(
      guard(
        {
          toolName: "read",
          toolCallId: "model-read",
          input: { path: health + ":raw" },
        },
        ctx,
      ),
    ).toMatchObject({ block: true });
    failRead = true;
    await expect(
      call("startup_repair_reconcile", {
        grantId,
        evidence: { observed: true },
      }),
    ).rejects.toThrow("Native verification fixture failure");
    expect(lastRead).not.toBeNull();
    expect(guard(lastRead, ctx)).toMatchObject({ block: true });
    failRead = false;
    await expect(
      call("startup_repair_reconcile", {
        grantId,
        evidence: { observed: true },
      }),
    ).rejects.toThrow("failed assigned acceptance");
    expect(guard(lastRead, ctx)).toMatchObject({ block: true });
    const loopPath: string = join(root, "skills/startup-loop/SKILL.md");
    const original: string = readFileSync(loopPath, "utf8");
    writeFileSync(loopPath, "changed canonical loop");
    await expect(
      call("startup_repair_reconcile", {
        grantId,
        evidence: { observed: true },
      }),
    ).rejects.toThrow("source changed");
    writeFileSync(loopPath, original);
    writeFileSync(health, '{"healthy":true}\n');
    expect(
      (
        await call("startup_repair_reconcile", {
          grantId,
          evidence: { observed: true },
        })
      ).details,
    ).toMatchObject({ state: "released" });
    expect(guard(lastRead, ctx)).toMatchObject({ block: true });
  } finally {
    await host.handlers.get("session_shutdown")!({}, ctx);
  }
});

test("pending human input permits repair reconciliation while ordinary work stays gated", async () => {
  const { ctx, factory, advance } = entryFixture();
  const first = factory("fixture");
  await first.handlers.get("session_start")!({}, ctx);
  await first.tools
    .get("startup_send")!
    .execute(
      "send",
      {
        id: "prior",
        recipient: "manager",
        kind: "report",
        correlation: "prior",
        payload: {},
      },
      undefined,
      undefined,
      ctx,
    );
  await first.tools
    .get("startup_claim")!
    .execute("claim", {}, undefined, undefined, ctx);
  await first.handlers.get("session_shutdown")!({}, ctx);
  advance();
  const host = factory("fixture");
  await host.handlers.get("session_start")!({}, ctx);
  try {
    await host.handlers.get("input")!(
      { text: "new human work", images: [], source: "rpc" },
      ctx,
    );
    expect(
      host.handlers.get("tool_call")!(
        {
          toolName: "startup_repair_reconcile",
          toolCallId: "recover",
          input: { grantId: "saved", evidence: {} },
        },
        ctx,
      ),
    ).toBeUndefined();
    expect(
      host.handlers.get("tool_call")!(
        {
          toolName: "read",
          toolCallId: "model",
          input: { path: "target.json" },
        },
        ctx,
      ),
    ).toMatchObject({ block: true });
    expect(host.handlers.get("session_stop")!({}, ctx)).toMatchObject({
      continue: true,
    });
  } finally {
    await host.handlers.get("session_shutdown")!({}, ctx);
  }
});
