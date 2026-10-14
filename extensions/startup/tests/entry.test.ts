import { afterEach, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
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
      getToolByName: () => undefined,
    },
  };
  const registry: NativeRegistry = {
    get: (id) => (id === "Main" ? native : undefined),
    list: () => [native],
    onChange: () => () => {},
  };
  function factory() {
    const handlers = new Map<
      string,
      (event: unknown, context: NativeContext) => unknown
    >();
    const tools = new Map<string, Parameters<HostAPI["registerTool"]>[0]>();
    const api: HostAPI = {
      pi: { AgentRegistry: { global: () => registry }, settings: {} },
      zod: {
        object: () => nativeSchema,
        string: () => ({}),
        number: () => ({}),
        unknown: () => ({}),
        array: () => ({}),
        literal: () => ({}),
        enum: () => ({}),
      },
      sendMessage: () => {},
      events: { on: () => () => {} },
      arktype: () => {
        throw new Error("Unused native schema");
      },
      on: (name, handler) => {
        handlers.set(name, handler);
      },
      registerTool: (tool) => {
        tools.set(tool.name, tool);
      },
      getCommands: () => [{ name: "fixture-status" }],
      getAllTools: () => [],
    };
    installStartup(api, {
      name: "fixture",
      home: join(root, "home"),
      skillsRoot: root,
      employeeLimit: null,
      executionLimit: null,
      leaseMs: 60000,
    });
    return { handlers, tools, api };
  }
  return {
    ctx,
    root,
    factory,
    advance: () => {
      native = { ...native, createdAt: native.createdAt + 1 };
    },
  };
}

test("old root shutdown cannot close a newer root's same-session adapter", async () => {
  const { ctx, factory, advance } = entryFixture();
  const first = factory();
  await first.handlers.get("session_start")!({}, ctx);
  await first.handlers.get("session_shutdown")!({}, ctx);
  advance();
  const second = factory();
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
  const first = factory();
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
  const next = factory();
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

test("host execution limit rejects invalid input before entry or store side effects", () => {
  const { root, factory } = entryFixture();
  const host = factory();
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
      expect(() => startupEntry(host.api)).toThrow();
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
