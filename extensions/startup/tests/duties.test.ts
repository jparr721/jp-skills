import { afterEach, expect, test } from "bun:test";
import { createDuties, parseNativeJson, type DutyHost } from "../src/duties";

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store";
import { type Binding, type Json, type Message } from "../src/contracts";
import type { NativeResult } from "../src/omp-adapter";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "startup-duty-"));
  const boundRoot = join(root, "repo");
  mkdirSync(boundRoot);
  const target = join(boundRoot, "config.json");
  const health = join(boundRoot, "health.json");
  writeFileSync(target, '{"enabled":true}\n');
  writeFileSync(health, '{"healthy":true}\n');
  let timestamp = 100;
  const scope = {
    home: join(root, "home"),
    boundRoot,
    host: "fixture",
    name: "duties",
    managerSession: "root",
  };
  const path = join(scope.home, "startup", scope.name, "staff.sqlite");
  let store = openStore({
    path,
    scope,
    owner: { id: "one", managerGeneration: 1, leaseMs: 1000 },
    now: () => timestamp,
  });
  function source(role: string) {
    return {
      rolePath: `/skills/startup-role-${role}/SKILL.md`,
      roleRevision: "rev",
      loopPath: "/skills/startup-loop/SKILL.md",
      loopRevision: "loop",
    };
  }
  function bindManager() {
    store.bindEmployee({
      manager: store.managerBinding,
      binding: {
        ...store.managerBinding,
        assignment: null,
        source: source("manager"),
      },
    });
  }
  bindManager();
  const receipt = store.reserveHire({
    authority: { kind: "employee", binding: store.managerBinding },
    request: {
      requestId: "hire",
      role: "devops",
      additional: 2,
      revision: "rev",
    },
  });
  const employees: Binding[] = receipt.employees.map((employee, index) => ({
    employeeId: employee.id,
    generation: 1,
    nativeHandle: `native-${index}`,
  }));
  for (const employee of employees)
    store.bindEmployee({
      manager: store.managerBinding,
      binding: { ...employee, assignment: null, source: source("devops") },
    });
  const first = employees[0];
  const second = employees[1];
  if (!first || !second) throw new Error("Missing fixture staff");
  let admitted = true;
  let readCount = 0;
  let writeCount = 0;
  let readDelay: Promise<void> | null = null;
  let writeDelay: Promise<void> | null = null;
  let writeError = false;
  let wakeError = false;
  const wakes: Message[] = [];
  const warnings: Json[] = [];
  const timers: Map<ReturnType<typeof setInterval>, () => void> = new Map();
  const host = (): DutyHost => ({
    store,
    owner: () => store.managerBinding,
    now: () => timestamp,
    binding: (id) =>
      id === "manager"
        ? store.managerBinding
        : admitted
          ? (employees.find((employee) => employee.employeeId === id) ?? null)
          : null,
    read: async (_id, selector) => {
      readCount += 1;
      if (readDelay) await readDelay;
      const path = selector.replace(/:raw$/, "");
      const text = readFileSync(path, "utf8");
      return {
        content: [{ type: "text", text: "decorated native text" }],
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
    write: async (_id, path, content): Promise<NativeResult> => {
      writeCount += 1;
      if (writeDelay) await writeDelay;
      writeFileSync(path, content);
      writeFileSync(
        health,
        JSON.stringify({ healthy: JSON.parse(content).enabled }) + "\n",
      );
      if (writeError)
        throw new Error("Lost native write response after mutation");
      return { content: [] };
    },
    wake: async (message) => {
      if (wakeError) throw new Error("Wake transport failed");
      wakes.push(message);
      return { kind: "accepted" };
    },
    warn: (fields) => warnings.push(fields),
    setInterval: (callback, _ms) => {
      const timer = setInterval(() => {}, 2147483647);
      timer.unref();
      timers.set(timer, callback);
      return timer;
    },
    clearTimer: (timer) => {
      clearInterval(timer);
      timers.delete(timer);
    },
  });
  let scheduler = createDuties(host());
  scheduler.start();
  function request(id: string, employeeId: string) {
    return {
      id,
      employeeId,
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
      cadenceMs: 50,
      nextDue: 100,
    };
  }
  function settle(employee: Binding) {
    const claim = store.claimNext({ employee, excludedMessageIds: [] });
    if (!claim) throw new Error("Expected duty cue");
    return store.settleClaim({
      employee,
      claimId: claim.claim.id,
      result: {
        id: `result-${claim.claim.id}`,
        kind: "completed",
        output: { checked: true },
        checkpoint: null,
        outgoing: [],
      },
    });
  }
  cleanup.push(async () => {
    await scheduler.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    target,
    health,
    first,
    second,
    request,
    settle,
    wakes,
    warnings,
    timers,
    get store() {
      return store;
    },
    get scheduler() {
      return scheduler;
    },
    get reads() {
      return readCount;
    },
    get writes() {
      return writeCount;
    },
    time: (value: number) => {
      timestamp = value;
    },
    admit: (value: boolean) => {
      admitted = value;
    },
    delayRead: (value: Promise<void> | null) => {
      readDelay = value;
    },
    delayWrite: (value: Promise<void> | null) => {
      writeDelay = value;
    },
    failWrite: () => {
      writeError = true;
    },
    failWake: (value: boolean) => {
      wakeError = value;
    },
    reopen: async () => {
      await scheduler.stop();
      store.close();
      store = openStore({
        path,
        scope,
        owner: { id: "two", managerGeneration: 2, leaseMs: 1000 },
        now: () => timestamp,
      });
      bindManager();
      scheduler = createDuties(host());
      scheduler.start();
    },
  };
}

test("native JSON uses complete unformatted metadata and rejects partial evidence", () => {
  const details = {
    totalLines: 2,
    fileSize: 17,
    displayContent: {
      text: '{"healthy":true}\n',
      startLine: 1,
      lineNumbers: [1, 2],
    },
    meta: { source: { type: "path", value: "/fixture/health.json" } },
  };
  const result = {
    content: [{ type: "text", text: "native repeat notice" }],
    details,
  };
  expect(parseNativeJson(result, "/fixture/health.json")).toEqual({
    healthy: true,
  });
  expect(() =>
    parseNativeJson(
      { ...result, details: { ...details, fileSize: 99 } },
      "/fixture/health.json",
    ),
  ).toThrow();
  expect(() => parseNativeJson(result, "/another/health.json")).toThrow();
  expect(() =>
    parseNativeJson({ ...result, isError: true }, "/fixture/health.json"),
  ).toThrow();
});

test("managed polling records quiet cadence, alerts transitions and resumes duty", async () => {
  const f = fixture();
  f.scheduler.assign(
    f.store.managerBinding,
    f.request("health", f.first.employeeId),
  );
  expect(f.timers.size).toBe(1);
  await f.scheduler.tick();
  expect(f.reads).toBe(1);
  expect(f.wakes).toHaveLength(0);
  f.time(149);
  await f.scheduler.tick();
  expect(f.reads).toBe(1);
  f.time(150);
  await f.scheduler.tick();
  expect(f.reads).toBe(2);
  writeFileSync(f.health, '{"healthy":false}\n');
  f.time(200);
  await f.scheduler.tick();
  expect(f.wakes).toHaveLength(1);
  expect(f.store.snapshot().occurrences).toHaveLength(3);
  f.settle(f.first);
  f.scheduler.authorize(f.store.managerBinding, {
    id: "repair",
    dutyId: "health",
  });
  expect((await f.scheduler.repair(f.first, "repair")).state).toBe("released");
  expect(f.writes).toBe(1);
  f.time(250);
  await f.scheduler.tick();
  expect(f.wakes).toHaveLength(2);
  f.settle(f.first);
  f.time(300);
  await f.scheduler.tick();
  expect(f.wakes).toHaveLength(2);
  expect(f.store.snapshot().occurrences).toHaveLength(5);
  await expect(f.scheduler.repair(f.first, "repair")).rejects.toThrow(
    "never replay",
  );
});

test("missing duty fields stay pending and read-only authority cannot repair", async () => {
  const f = fixture();
  const full = f.request("full", f.first.employeeId);
  for (const key of [
    "target",
    "probe",
    "acceptance",
    "repairAuthority",
    "cadenceMs",
    "nextDue",
  ]) {
    f.scheduler.assign(f.store.managerBinding, {
      ...full,
      id: key,
      [key]: null,
    });
  }
  await f.scheduler.tick();
  expect(f.reads).toBe(0);
  expect(f.wakes).toHaveLength(0);
  expect(
    f.scheduler
      .status()
      .duties.every(
        (entry) => !entry.configured && entry.currentHealth === "unknown",
      ),
  ).toBe(true);
  f.scheduler.assign(f.store.managerBinding, {
    ...full,
    id: "readonly",
    repairAuthority: { kind: "read-only" },
  });
  await f.scheduler.tick();
  expect(f.reads).toBe(1);
  expect(() =>
    f.scheduler.authorize(f.store.managerBinding, {
      id: "forbidden",
      dutyId: "readonly",
    }),
  ).toThrow();
  expect(() => f.scheduler.assign(f.first, full)).toThrow();
  expect(() =>
    f.scheduler.assign(f.store.managerBinding, { ...full, cadenceMs: -1 }),
  ).toThrow();
  expect(() =>
    f.scheduler.assign(f.store.managerBinding, { ...full, caller: "manager" }),
  ).toThrow();
});

test("observation saved before failed cue wake survives restart without duplicate mail", async () => {
  const f = fixture();
  f.scheduler.assign(
    f.store.managerBinding,
    f.request("health", f.first.employeeId),
  );
  writeFileSync(f.health, '{"healthy":false}\n');
  f.failWake(true);
  await expect(f.scheduler.tick()).rejects.toThrow("Wake transport failed");
  expect(f.store.snapshot().occurrences[0]?.observedAt).toBe(100);
  expect(f.store.snapshot().messages).toHaveLength(1);
  f.failWake(false);
  f.time(500);
  await f.reopen();
  await f.scheduler.recover();
  await f.scheduler.recover();
  expect(f.store.snapshot().messages).toHaveLength(1);
  expect(f.wakes).toHaveLength(1);
  expect(f.store.snapshot().messages[0]?.status).toBe("pending");
});

test("recover reconstructs a missing observation cue and coalesces missed polls", async () => {
  const f = fixture();
  f.scheduler.assign(
    f.store.managerBinding,
    f.request("health", f.first.employeeId),
  );
  const occurrence = f.store.claimDue({ employee: f.first });
  if (!occurrence) throw new Error("Missing occurrence");
  f.store.observeDuty({
    employee: f.first,
    occurrenceId: occurrence.id,
    observation: {
      kind: "native-json-observation",
      checkedAt: 100,
      probe: f.health,
      status: "failed",
      value: null,
      error: "interrupted read",
      actionable: true,
    },
  });
  f.time(1000);
  await f.reopen();
  expect(f.scheduler.status().duties[0]?.currentHealth).toBe("unknown");
  await f.scheduler.recover();
  expect(f.store.snapshot().messages).toHaveLength(1);
  f.settle(f.first);
  await f.scheduler.tick();
  expect(f.store.snapshot().occurrences).toHaveLength(2);
  expect(f.store.snapshot().occurrences[1]?.observedAt).toBe(1000);
  expect(f.store.snapshot().dutySchedules[0]?.nextDue).toBe(1050);
});

test("unadmitted sources remain unknown until one saved recovery cue is processed", async () => {
  const f = fixture();
  f.scheduler.assign(
    f.store.managerBinding,
    f.request("health", f.first.employeeId),
  );
  f.admit(false);
  await f.scheduler.tick();
  await f.scheduler.tick();
  expect(f.reads).toBe(0);
  expect(f.wakes).toHaveLength(1);
  expect(f.store.snapshot().messages).toHaveLength(1);
  expect(f.scheduler.status().duties[0]?.currentHealth).toBe("unknown");
  f.admit(true);
  f.settle(f.first);
  await f.scheduler.tick();
  expect(f.reads).toBe(1);
});

test("canonical aliases serialize target grants and reject hard links and retargeting", async () => {
  const f = fixture();
  const alias = join(f.root, "alias.json");
  symlinkSync(f.target, alias);
  f.scheduler.assign(
    f.store.managerBinding,
    f.request("one", f.first.employeeId),
  );
  f.scheduler.assign(f.store.managerBinding, {
    ...f.request("two", f.second.employeeId),
    target: alias,
  });
  f.scheduler.authorize(f.store.managerBinding, { id: "one", dutyId: "one" });
  f.scheduler.authorize(f.store.managerBinding, { id: "two", dutyId: "two" });
  expect(
    f.store.snapshot().authorizations.map((entry) => entry.target),
  ).toEqual([realpathSync(f.target), realpathSync(f.target)]);
  let release: (() => void) | undefined;
  f.delayWrite(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const first = f.scheduler.repair(f.first, "one");
  await expect(f.scheduler.repair(f.second, "two")).rejects.toThrow("held");
  release?.();
  await first;
  f.delayWrite(null);
  await f.scheduler.repair(f.second, "two");
  expect(f.writes).toBe(2);
  const linked = join(f.root, "linked.json");
  linkSync(f.target, linked);
  expect(() =>
    f.scheduler.assign(f.store.managerBinding, {
      ...f.request("links", f.first.employeeId),
      target: linked,
    }),
  ).toThrow("hard links");
});

test("uncertain write is never repeated and manager reconciles using a fresh assigned probe", async () => {
  const f = fixture();
  f.scheduler.assign(
    f.store.managerBinding,
    f.request("health", f.first.employeeId),
  );
  f.scheduler.authorize(f.store.managerBinding, {
    id: "repair",
    dutyId: "health",
  });
  f.failWrite();
  await expect(f.scheduler.repair(f.first, "repair")).rejects.toThrow(
    "Lost native write response",
  );
  expect(f.writes).toBe(1);
  const grant = f.store.snapshot().grants[0];
  if (!grant) throw new Error("Missing grant");
  expect(grant.state).toBe("reconciliation");
  f.time(200);
  await f.reopen();
  await expect(f.scheduler.repair(f.first, "repair")).rejects.toThrow(
    "never replay",
  );
  expect(f.writes).toBe(1);
  const reads = f.reads;
  const result = await f.scheduler.reconcile(f.store.managerBinding, {
    grantId: grant.id,
    evidence: { inspected: true },
  });
  expect(result.state).toBe("released");
  expect(f.reads).toBe(reads + 1);
  expect(f.writes).toBe(1);
});

test("stop drains an in-flight read without post-stop observation and restart retries it once", async () => {
  const f = fixture();
  f.scheduler.assign(
    f.store.managerBinding,
    f.request("health", f.first.employeeId),
  );
  let release: (() => void) | undefined;
  f.delayRead(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const tick = f.scheduler.tick();
  await Promise.resolve();
  await Promise.resolve();
  const stop = f.scheduler.stop();
  release?.();
  await tick;
  await stop;
  expect(f.timers.size).toBe(0);
  expect(f.scheduler.status().runtime).toBe("OFFLINE");
  expect(f.scheduler.status().duties[0]?.currentHealth).toBe("unknown");
  expect(f.store.snapshot().occurrences[0]?.observedAt).toBeNull();
  f.delayRead(null);
  f.time(1000);
  await f.reopen();
  await f.scheduler.tick();
  expect(f.store.snapshot().occurrences).toHaveLength(1);
  expect(f.store.snapshot().occurrences[0]?.observedAt).toBe(1000);
});

test("ended duties never probe, and native malformed JSON is saved as failure evidence", async () => {
  const f = fixture();
  f.scheduler.assign(
    f.store.managerBinding,
    f.request("health", f.first.employeeId),
  );
  writeFileSync(f.health, "not json\n");
  await f.scheduler.tick();
  expect(f.scheduler.status().duties[0]?.currentHealth).toBe("failed");
  expect(f.wakes).toHaveLength(1);
  f.settle(f.first);
  f.store.endDuty({
    manager: f.store.managerBinding,
    dutyId: "health",
    evidence: { ended: true },
  });
  expect(f.store.snapshot().dutySchedules[0]?.nextDue).toBeNull();
  f.time(200);
  await f.scheduler.tick();
  expect(f.reads).toBe(1);
});

test("ended authority, substituted callers and failed verification cannot release a target", async () => {
  const f = fixture();
  const request = f.request("health", f.first.employeeId);
  f.scheduler.assign(f.store.managerBinding, {
    ...request,
    repairAuthority: {
      ...request.repairAuthority,
      verification: {
        path: f.health,
        acceptance: { path: ["healthy"], equals: false },
      },
    },
  });
  f.scheduler.authorize(f.store.managerBinding, {
    id: "repair",
    dutyId: "health",
  });
  await expect(f.scheduler.repair(f.second, "repair")).rejects.toThrow(
    "another employee",
  );
  expect(f.writes).toBe(0);
  await expect(f.scheduler.repair(f.first, "repair")).rejects.toThrow(
    "acceptance failed",
  );
  const grant = f.store.snapshot().grants[0];
  if (!grant) throw new Error("Missing grant");
  expect(grant.state).toBe("reconciliation");
  await expect(
    f.scheduler.reconcile(f.store.managerBinding, {
      grantId: grant.id,
      evidence: { investigated: true },
    }),
  ).rejects.toThrow("remains locked");
  f.store.endDuty({
    manager: f.store.managerBinding,
    dutyId: "health",
    evidence: { ended: true },
  });
  expect(() =>
    f.scheduler.authorize(f.store.managerBinding, {
      id: "new",
      dutyId: "health",
    }),
  ).toThrow("Ended duty");
  await expect(f.scheduler.repair(f.first, "repair")).rejects.toThrow(
    "Ended duty",
  );
});

test("retired duty history does not resend acknowledged observations", async () => {
  const f = fixture();
  f.scheduler.assign(
    f.store.managerBinding,
    f.request("health", f.first.employeeId),
  );
  writeFileSync(f.health, '{"healthy":false}\n');
  await f.scheduler.tick();
  f.settle(f.first);
  f.store.endDuty({
    manager: f.store.managerBinding,
    dutyId: "health",
    evidence: { ended: true },
  });
  f.store.retireEmployees({
    manager: f.store.managerBinding,
    employeeIds: [f.first.employeeId],
    evidence: { retired: true },
  });
  await f.scheduler.recover();
  expect(f.wakes).toHaveLength(1);
});
