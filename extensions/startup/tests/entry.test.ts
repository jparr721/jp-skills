import { afterEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { installStartup } = await import("../index");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("old root shutdown cannot close a newer root's same-session adapter", async () => {
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
        object: () => ({
          or: () => {
            throw new Error("Unused native schema");
          },
          and: () => {
            throw new Error("Unused native schema");
          },
          toJsonSchema: () => ({}),
        }),
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
      getCommands: () => [],
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
    return { handlers, tools };
  }
  const first = factory();
  await first.handlers.get("session_start")!({}, ctx);
  first.handlers.get("session_shutdown")!({}, ctx);
  native = { ...native, createdAt: 2 };
  const second = factory();
  await second.handlers.get("session_start")!({}, ctx);
  try {
    first.handlers.get("session_shutdown")!({}, ctx);
    const staff = await second.tools
      .get("startup_staff")!
      .execute("staff", {}, undefined, undefined, ctx);
    expect(staff.isError).not.toBe(true);
    expect(staff.details).toMatchObject({ mode: "ready" });
  } finally {
    second.handlers.get("session_shutdown")!({}, ctx);
  }
});
