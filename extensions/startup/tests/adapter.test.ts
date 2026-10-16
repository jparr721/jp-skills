import { Database } from "bun:sqlite";
import { afterEach, expect, test, spyOn } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, projectEmployee, verifyProfile } from "../src/profiles";
import {
  createAdapter,
  type NativeContext,
  type NativeRef,
  type NativeResult,
  type StartupAdapter,
} from "../src/omp-adapter";
import { z } from "zod";
import type { Employee, Result } from "../src/contracts";
import type { ItemAction } from "../src/items";
const directories: string[] = [];
function sources(): string {
  const root: string = mkdtempSync(join(tmpdir(), "startup-adapter-"));
  directories.push(root);
  for (const name of ["startup-role-devops", "startup-loop"]) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(
      join(root, "skills", name, "SKILL.md"),
      `---\nname: ${name}\n---\nFull canonical ${name} source.\n`,
    );
  }
  return root;
}
afterEach((): void => {
  for (const adapter of adapters.splice(0)) adapter.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
test("profiles load full role and loop, fence modified sources and isolate checkpoints", (): void => {
  const root: string = sources();
  const profile = loadProfile({
    skillsRoot: root,
    role: "devops",
    employeeId: "devops-1",
    generation: 1,
  });
  verifyProfile(profile);
  const content: string = projectEmployee({
    profile,
    checkpoint: { own: "first" },
    cue: { id: "own" },
    team: null,
  });
  expect(content).toContain("Full canonical startup-role-devops source.");
  expect(content).toContain("Full canonical startup-loop source.");
  expect(content).toContain("first");
  writeFileSync(profile.source.loopPath, "modified");
  expect(() => verifyProfile(profile)).toThrow("source changed");
});
test("missing canonical source blocks profiles honestly", (): void => {
  const root: string = sources();
  expect(() =>
    loadProfile({
      skillsRoot: root,
      role: "qa",
      employeeId: "qa-1",
      generation: 1,
    }),
  ).toThrow();
});

const adapters: StartupAdapter[] = [];

function configuredFixture(
  limits: Readonly<{
    employeeLimit: number | null;
    executionLimit: number | null;
  }>,
): Readonly<{
  adapter: StartupAdapter;
  managerNotifications: string[];
  wakePaths: string[];
  setStatus: (id: string, status: string) => void;
  setBatch: (batch: boolean) => void;

  ctx: NativeContext;
  refs: Map<string, NativeRef>;
  root: string;
  activate: (params: Record<string, unknown>) => Promise<NativeResult>;
  project: (employee: Employee) => Promise<NativeContext>;
}> {
  const root: string = sources();
  for (const role of ["manager", "architect", "qa", "dev", "pa"]) {
    const directory: string = join(root, "skills", `startup-role-${role}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "SKILL.md"),
      `Full canonical ${role} source.\n`,
    );
  }
  const cwd: string = join(root, "repo");
  mkdirSync(cwd);
  const home: string = join(root, "home");
  const sessionFile: string = join(root, "root.jsonl");
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: "session", id: "root-session" }) + "\n",
  );
  const refs: Map<string, NativeRef> = new Map();
  const listeners: Set<
    (event: Readonly<{ type: string; ref: NativeRef }>) => void
  > = new Set();

  const wakePaths: string[] = [];
  const wake = async (
    _id: string,
    params: Record<string, unknown>,
  ): Promise<NativeResult> => {
    wakePaths.push(z.string().parse(params.path));
    return {
      content: [],
      details: {
        message: {
          receipts: [
            {
              to: z.string().parse(params.path).replace("agent://", ""),
              outcome: "woken",
            },
          ],
        },
      },
    };
  };
  const rootRef: NativeRef = {
    id: "Main",
    kind: "main",
    status: "running",
    createdAt: 1,
    sessionFile,
    session: {
      sessionManager: {
        getSessionId: () => "root-session",
        getSessionFile: () => sessionFile,
      },
      settings: {},
      getPlanModeState: () => undefined,
      getToolByName: () => ({ execute: wake }),
    },
  };
  refs.set("Main", rootRef);
  let count: number = 0;
  const activate = async (
    params: Record<string, unknown>,
  ): Promise<NativeResult> => {
    const tasks = Array.isArray(params.tasks) ? params.tasks : [];
    return {
      content: [],
      details: {
        progress: tasks.map((task: unknown, index: number) => {
          count += 1;
          const parsed = z
            .object({ agent: z.string(), task: z.string() })
            .parse(task);
          return {
            index,
            id: `child-${count}`,
            agent: parsed.agent,
            assignment: parsed.task,
            status: "running",
          };
        }),
      },
    };
  };
  const ctx: NativeContext = {
    agent: { id: "Main", kind: "main" },
    cwd,
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => sessionFile,
    },
    getSystemPrompt: () => [],
    invokeTool: activate,
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearTimer: clearInterval,
  };
  const managerNotifications: string[] = [];
  let batch = true;
  const adapter = createAdapter({
    ctx,
    registry: {
      get: (id) => refs.get(id),
      list: () => [...refs.values()],
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    config: {
      boundRoot: ctx.cwd,
      name: "fixture",
      home,
      skillsRoot: root,
      employeeLimit: limits.employeeLimit,
      executionLimit: limits.executionLimit,
      leaseMs: 60000,
    },
    nativeLimit: () => 32,
    nativeBatch: () => batch,
    notifyManager: (cueId) => {
      managerNotifications.push(cueId);
    },
    now: Date.now,
  });
  adapters.push(adapter);
  const project = async (employee: Employee): Promise<NativeContext> => {
    const profile = loadProfile({
      skillsRoot: root,
      role: employee.role,
      employeeId: employee.id,
      generation: employee.generation + 1,
    });
    const id: string = `child-${[...refs.values()].filter((ref) => ref.kind === "sub").length + 1}`;
    const path: string = join(root, `${id}.jsonl`);
    const sessionId: string = `session-${id}`;
    writeFileSync(
      path,
      JSON.stringify({
        type: "session",
        id: sessionId,
        parentSession: sessionFile,
      }) + "\n",
    );
    const child: NativeContext = {
      ...ctx,
      agent: { id, kind: "sub", parentId: "Main" },
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => path,
      },
      getSystemPrompt: () => [
        `${profile.marker}\n${profile.role}\n${profile.loop}`,
      ],
    };
    refs.set(id, {
      id,
      kind: "sub",
      parentId: "Main",
      status: "idle",
      createdAt: 2,
      sessionFile: path,
      session: { ...rootRef.session!, sessionManager: child.sessionManager },
    });
    await adapter.projection(child);
    return child;
  };
  return {
    adapter,
    ctx,
    refs,
    root,
    activate,
    project,
    managerNotifications,
    wakePaths,
    setBatch: (value) => { batch = value; },
    setStatus: (id, status) => {
      const current = refs.get(id);
      if (!current) throw new Error("Fixture native ref missing");
      const ref = { ...current, status };
      refs.set(id, ref);
      for (const listener of listeners)
        listener({ type: "status_changed", ref });
    },
  };
}

function fixture() {
  return configuredFixture({ employeeLimit: null, executionLimit: null });
}

test("adapter additive reservations preserve retry IDs and source-loaded readiness", async (): Promise<void> => {
  const f = fixture();
  const first = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "existing",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(
    f.ctx,
    first.employees.map((entry) => entry.id),
  );
  await f.project(first.employees[0]!);
  const six = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "six",
    role: "devops",
    additional: 6,
  });
  await f.adapter.activate(
    f.ctx,
    six.employees.map((entry) => entry.id),
  );
  for (const employee of six.employees) await f.project(employee);
  const replay = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "six",
    role: "devops",
    additional: 6,
  });
  expect(replay.ready).toBe(6);
  expect(replay.employees.map((entry) => entry.id)).toEqual(
    six.employees.map((entry) => entry.id),
  );
  expect(f.adapter.store.snapshot().employees).toHaveLength(8);
  expect(
    f.adapter.reserve(f.ctx, {
      startup: "hire",
      requestId: "more-six",
      role: "devops",
      additional: 6,
    }).reserved,
  ).toBe(6);
});
test("raw events delegate fresh complete teams and retain an unrelated intake wait guard", async (): Promise<void> => {
  const f = fixture();
  f.adapter.recordIntake(f.ctx, {
    eventId: "first",
    input: "raw request",
    amendItemIds: [],
  });
  f.adapter.recordIntake(f.ctx, {
    eventId: "unrelated",
    input: "unresolved BUILD",
    amendItemIds: [],
  });
  const team = await f.adapter.delegate(f.ctx, {
    startup: "delegate",
    eventId: "first",
    developers: 1,
  });
  expect(team.state).toBe("reserved");
  expect(f.adapter.waitGuard()).toContain("unrelated");
  const messages = f.adapter.store.snapshot().messages;
  expect(
    messages.find((message) => message.recipient === team.architect)?.payload,
  ).toEqual({ kind: "architect-intake", raw: "raw request", amendItemIds: [] });
  expect(
    JSON.stringify(
      messages.find((message) => message.recipient === team.qa)?.payload,
    ),
  ).not.toContain("raw request");
  const retry = await f.adapter.delegate(f.ctx, {
    startup: "delegate",
    eventId: "first",
    developers: 1,
  });
  expect(retry.id).toBe(team.id);
  const next = await f.adapter.delegate(f.ctx, {
    startup: "delegate",
    eventId: "unrelated",
    developers: 1,
  });
  expect(
    [next.architect, next.qa, ...next.devs].some((id) =>
      [team.architect, team.qa, ...team.devs].includes(id),
    ),
  ).toBe(false);
});
test("runtime identity rejects outsiders, cross-root transcripts, injected identity and stale generation", async (): Promise<void> => {
  const f = fixture();
  expect(() =>
    f.adapter.recordIntake(
      { ...f.ctx, agent: { id: "outsider", kind: "sub" } },
      { eventId: "bad", input: "bad", amendItemIds: [] },
    ),
  ).toThrow("registry evidence");
  expect(() =>
    f.adapter.reserve(f.ctx, {
      startup: "hire",
      requestId: "bad",
      role: "devops",
      additional: 1,
      from: "manager",
    }),
  ).toThrow();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "one",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(
    f.ctx,
    hire.employees.map((entry) => entry.id),
  );
  const employee = hire.employees[0]!;
  const child = await f.project(employee);
  expect(() =>
    f.adapter.reserve(child, {
      startup: "hire",
      requestId: "forbidden",
      role: "devops",
      additional: 1,
    }),
  ).toThrow("bound manager");
  const file: string = child.sessionManager.getSessionFile()!;
  writeFileSync(
    file,
    JSON.stringify({
      type: "session",
      id: child.sessionManager.getSessionId(),
      parentSession: "another-root",
    }) + "\n",
  );
  expect(() => f.adapter.caller(child)).toThrow("another native root");
  const rootFile: string = f.ctx.sessionManager.getSessionFile()!;
  writeFileSync(
    file,
    JSON.stringify({
      type: "session",
      id: child.sessionManager.getSessionId(),
      parentSession: rootFile,
    }) + "\n",
  );
  f.adapter.store.recordBindingFailure({
    manager: f.adapter.store.managerBinding,
    employeeId: employee.id,
    error: "aborted",
  });
  f.adapter.store.reserveReplacement({
    manager: f.adapter.store.managerBinding,
    employeeId: employee.id,
    evidence: { authorized: true },
  });
  expect(() => f.adapter.caller(child)).toThrow("superseded");
});
test("native transcript title rows precede the authoritative session header", async (): Promise<void> => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "title",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(
    f.ctx,
    hire.employees.map((entry) => entry.id),
  );
  const child = await f.project(hire.employees[0]!);
  const path: string = child.sessionManager.getSessionFile()!;
  const contents: string = readFileSync(path, "utf8");
  writeFileSync(
    path,
    JSON.stringify({ type: "title", v: 1, title: "" }) + "\n" + contents,
  );
  expect(() => f.adapter.caller(child)).not.toThrow();
});
test("safe canonical refresh preserves duties, audits revisions and fences old native context", async (): Promise<void> => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "refresh",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(
    f.ctx,
    hire.employees.map((entry) => entry.id),
  );
  const old = await f.project(hire.employees[0]!);
  const employee = f.adapter.store
    .snapshot()
    .employees.find((entry) => entry.id === hire.employees[0]!.id)!;
  f.adapter.store.setDuty({
    manager: f.adapter.store.managerBinding,
    duty: {
      id: "future-duty",
      employeeId: employee.id,
      assignment: { readOnly: true },
      target: "fixture",
      probe: "health",
      acceptance: "healthy",
      repairAuthority: null,
      cadenceMs: 10000,
      nextDue: Date.now() + 10000,
    },
  });
  writeFileSync(
    employee.source!.rolePath,
    "Refreshed full canonical devops source.\n",
  );
  const refreshed = f.adapter.refresh(f.ctx, {
    employeeId: employee.id,
    evidence: { approved: true },
  });
  expect(refreshed.generation).toBe(2);
  expect(f.adapter.store.snapshot().duties).toHaveLength(1);
  expect(() => f.adapter.caller(old)).toThrow("superseded");
  await f.adapter.activate(f.ctx, [employee.id]);
  const current = f.adapter.store
    .snapshot()
    .employees.find((entry) => entry.id === employee.id)!;
  const next = await f.project(current);
  expect(f.adapter.caller(next).generation).toBe(2);
  expect(
    f.adapter.store
      .snapshot()
      .employees.find((entry) => entry.id === employee.id)!.canonicalRevision,
  ).not.toBe(employee.canonicalRevision);
});
test("partial activation hides raw intake until every actual role binding is verified", async (): Promise<void> => {
  const f = fixture();
  f.adapter.recordIntake(f.ctx, {
    eventId: "partial",
    input: "private technical input",
    amendItemIds: [],
  });
  const team = await f.adapter.delegate(f.ctx, {
    startup: "delegate",
    eventId: "partial",
    developers: 1,
  });
  const architect = f.adapter.store
    .snapshot()
    .employees.find((entry) => entry.id === team.architect)!;
  const architectContext = await f.project(architect);
  expect(await f.adapter.projection(architectContext)).not.toContain(
    "private technical input",
  );
  expect(f.adapter.claim(architectContext)).toBeNull();
  await f.project(
    f.adapter.store.snapshot().employees.find((entry) => entry.id === team.qa)!,
  );
  await f.project(
    f.adapter.store
      .snapshot()
      .employees.find((entry) => entry.id === team.devs[0])!,
  );
  expect(await f.adapter.projection(architectContext)).toContain(
    "private technical input",
  );
  expect(f.adapter.claim(architectContext)?.message.correlation).toBe(
    "partial",
  );
  expect(f.adapter.waitGuard()).toContain("Dispatch ready independent");
});
test("native capacity counts bounded review descendants and unrelated intake does not consume a slot", (): void => {
  const f = fixture();
  const root = f.refs.get("Main")!;
  f.refs.set("review", {
    ...root,
    id: "review",
    kind: "sub",
    parentId: "Main",
    status: "running",
  });
  f.refs.set("buddy", {
    ...root,
    id: "buddy",
    kind: "sub",
    parentId: "review",
    status: "running",
  });
  f.adapter.recordIntake(f.ctx, {
    eventId: "pending",
    input: "clarification",
    amendItemIds: [],
  });
  expect(f.adapter.capacity().active).toBe(2);
  expect(f.adapter.capacity().available).toBe(30);
  expect(f.adapter.waitGuard()).toContain("Delegate raw intake pending");
});
test("canonical refresh blocks unresolved work and model-supplied source identities", async (): Promise<void> => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "busy-refresh",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(
    f.ctx,
    hire.employees.map((entry) => entry.id),
  );
  const ctx = await f.project(hire.employees[0]!);
  const employee = f.adapter.caller(ctx);
  f.adapter.store.sendCue({
    sender: f.adapter.store.managerBinding,
    cue: {
      id: "busy",
      recipient: employee.employeeId,
      kind: "assignment",
      correlation: "busy",
      payload: { readOnly: true },
    },
  });
  const claim = f.adapter.claim(ctx)!;
  expect(() =>
    f.adapter.refresh(f.ctx, {
      employeeId: employee.employeeId,
      evidence: { approved: true },
    }),
  ).toThrow("idle boundary");
  expect(() =>
    f.adapter.refresh(f.ctx, {
      employeeId: employee.employeeId,
      evidence: { approved: true },
      source: { rolePath: "invented" },
    }),
  ).toThrow();
  expect(
    f.adapter.store
      .snapshot()
      .claims.find((entry) => entry.id === claim.claim.id)?.status,
  ).toBe("active");
  expect(
    f.adapter.store
      .snapshot()
      .employees.find((entry) => entry.id === employee.employeeId)
      ?.nativeHandle,
  ).toBe(employee.nativeHandle);
});
test("native terminal events preserve unresolved claims and reject stale completion", async (): Promise<void> => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "terminal",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(
    f.ctx,
    hire.employees.map((entry) => entry.id),
  );
  const ctx = await f.project(hire.employees[0]!);
  const employee = f.adapter.caller(ctx);
  f.adapter.store.sendCue({
    sender: f.adapter.store.managerBinding,
    cue: {
      id: "unfinished",
      recipient: employee.employeeId,
      kind: "assignment",
      correlation: "unfinished",
      payload: { fixture: true },
    },
  });
  const claimed = f.adapter.claim(ctx)!;
  f.adapter.nativeEnded(ctx.agent.id, "idle");
  const snapshot = f.adapter.store.snapshot();
  expect(
    snapshot.claims.find((entry) => entry.id === claimed.claim.id)?.status,
  ).toBe("reconciliation");
  expect(
    snapshot.messages.find((entry) => entry.id === "unfinished")?.status,
  ).toBe("claimed");
  expect(
    snapshot.messages.some(
      (entry) =>
        entry.recipient === "manager" &&
        entry.kind === "alert" &&
        entry.status === "pending",
    ),
  ).toBe(true);
  await expect(
    f.adapter.settle(ctx, {
      claimId: claimed.claim.id,
      result: {
        id: "late",
        kind: "completed",
        output: null,
        checkpoint: null,
        outgoing: [],
      },
    }),
  ).rejects.toThrow("superseded");
});
test("manager blockers require current native capacity or persisted resource/dependency evidence", (): void => {
  const f = fixture();
  f.adapter.recordIntake(f.ctx, {
    eventId: "ready",
    input: "ready independent work",
    amendItemIds: [],
  });
  expect(() =>
    f.adapter.block(f.ctx, "ready", { kind: "ci", pending: true }),
  ).toThrow();
  expect(() => f.adapter.block(f.ctx, "ready", { kind: "capacity" })).toThrow();
  expect(f.adapter.waitGuard()).toContain("Delegate raw intake ready");
});
test("immediate activation retry retains in-flight native assignment instead of spawning twice", async (): Promise<void> => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "in-flight",
    role: "devops",
    additional: 1,
  });
  let calls: number = 0;
  const ctx: NativeContext = {
    ...f.ctx,
    invokeTool: async (params) => {
      calls += 1;
      return f.activate(params);
    },
  };
  const ids: string[] = hire.employees.map((employee) => employee.id);
  await f.adapter.activate(ctx, ids);
  await f.adapter.activate(ctx, ids);
  expect(calls).toBe(1);
  expect(
    f.adapter.reserve(f.ctx, {
      startup: "hire",
      requestId: "in-flight",
      role: "devops",
      additional: 1,
    }).starting,
  ).toBe(1);
});
test("safe source refresh preserves saved unclaimed mail for the fresh native generation", async (): Promise<void> => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "mail-refresh",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(
    f.ctx,
    hire.employees.map((entry) => entry.id),
  );
  const old = await f.project(hire.employees[0]!);
  const binding = f.adapter.caller(old);
  f.adapter.store.sendCue({
    sender: f.adapter.store.managerBinding,
    cue: {
      id: "saved-mail",
      recipient: binding.employeeId,
      kind: "assignment",
      correlation: "later",
      payload: { readOnly: true },
    },
  });
  const employee = f.adapter.store
    .snapshot()
    .employees.find((entry) => entry.id === binding.employeeId)!;
  writeFileSync(
    employee.source!.rolePath,
    "Fresh canonical source with saved unclaimed work.\n",
  );
  expect(() => f.adapter.claim(old)).toThrow("source changed");
  expect(
    f.adapter.refresh(f.ctx, {
      employeeId: employee.id,
      evidence: { approved: true },
    }).generation,
  ).toBe(2);
  await f.adapter.activate(f.ctx, [employee.id]);
  const next = await f.project(
    f.adapter.store
      .snapshot()
      .employees.find((entry) => entry.id === employee.id)!,
  );
  expect(f.adapter.claim(next)?.message.id).toBe("saved-mail");
  expect(
    f.adapter.store
      .snapshot()
      .messages.find((entry) => entry.id === "saved-mail")?.status,
  ).toBe("claimed");
});
test("failed manager reopens through current-root reconciliation before source admission and retains pending mail", async (): Promise<void> => {
  const f = fixture();
  f.adapter.store.sendCue({
    sender: f.adapter.store.managerBinding,
    cue: {
      id: "manager-old",
      recipient: "manager",
      kind: "report",
      correlation: "recovery",
      payload: { evidence: "old" },
    },
  });
  const old = f.adapter.claim(f.ctx)!;
  f.adapter.store.sendCue({
    sender: f.adapter.store.managerBinding,
    cue: {
      id: "manager-pending",
      recipient: "manager",
      kind: "report",
      correlation: "recovery",
      payload: { evidence: "saved" },
    },
  });
  const pendingInput = f.adapter.receiveInput(f.ctx, {
    text: "also after recovery",
    source: "rpc",
    images: [],
  })!;
  f.adapter.sourceFailed(f.ctx, "manager source unavailable");
  f.adapter.close();
  const root = f.refs.get("Main")!;
  f.refs.set("Main", { ...root, createdAt: 2 });
  writeFileSync(
    join(f.root, "skills", "startup-role-manager", "SKILL.md"),
    "Fresh native manager canonical source.\n",
  );
  const next = createAdapter({
    ctx: f.ctx,
    registry: {
      get: (id) => f.refs.get(id),
      list: () => [...f.refs.values()],
      onChange: () => () => {},
    },
    config: {
      boundRoot: f.ctx.cwd,
      name: "fixture",
      home: join(f.root, "home"),
      skillsRoot: f.root,
      employeeLimit: null,
      executionLimit: null,
      leaseMs: 60000,
    },
    nativeLimit: () => 32,
    nativeBatch: () => true,
    notifyManager: () => {},
    now: Date.now,
  });
  adapters.push(next);
  expect(next.staff(f.ctx).mode).toBe("recovery");
  expect(
    next.staff(f.ctx).inputs.find((entry) => entry.id === pendingInput.id)
      ?.disposition,
  ).toBeNull();
  expect(await next.projection(f.ctx)).toContain(
    "Fresh native manager canonical source.",
  );
  expect(() => next.claim(f.ctx)).toThrow("reconciliation");
  expect(() =>
    next.recordIntake(f.ctx, {
      eventId: "too-early",
      input: "raw",
      amendItemIds: [],
    }),
  ).toThrow("reconciliation");
  next.reconcile(f.ctx, {
    claimId: old.claim.id,
    evidence: { verified: true },
  });
  expect(next.staff(f.ctx).mode).toBe("ready");
  expect(next.claim(f.ctx)?.message.id).toBe("manager-pending");
  expect(
    next.recordIntake(f.ctx, {
      eventId: "after-recovery",
      input: "raw",
      amendItemIds: [],
    }).eventId,
  ).toBe("after-recovery");
});
test("source projection cannot grant readiness before native dispatch identity is correlated", async (): Promise<void> => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "correlate",
    role: "devops",
    additional: 1,
  });
  const employee = hire.employees[0]!;
  const ctx: NativeContext = {
    ...f.ctx,
    invokeTool: async (params) => {
      await f.project(employee);
      const task = z
        .object({
          tasks: z.array(z.object({ agent: z.string(), task: z.string() })),
        })
        .parse(params).tasks[0]!;
      return {
        content: [],
        details: {
          progress: [
            {
              index: 0,
              id: "different-native-child",
              agent: task.agent,
              assignment: task.task,
              status: "running",
            },
          ],
        },
      };
    },
  };
  await expect(f.adapter.activate(ctx, [employee.id])).rejects.toThrow(
    "dispatch",
  );
  expect(
    f.adapter.store
      .snapshot()
      .employees.find((entry) => entry.id === employee.id)?.nativeHandle,
  ).toBeNull();
});
test("human input is saved before routing, blocks idle at full capacity and retains raw event identity", async (): Promise<void> => {
  const f = fixture();
  const received = f.adapter.receiveInput(f.ctx, {
    text: "also investigate fixture",
    source: "rpc",
    images: [],
  });
  expect(received).not.toBeNull();
  expect(f.adapter.waitGuard()).toContain(received!.id);
  expect(f.adapter.store.snapshot().intakes).toHaveLength(0);
  const main = f.refs.get("Main")!;
  for (let index = 0; index < 32; index += 1)
    f.refs.set(`review-${index}`, {
      ...main,
      id: `review-${index}`,
      kind: "sub",
      parentId: "Main",
      status: "running",
    });
  expect(f.adapter.capacity().available).toBe(0);
  expect(f.adapter.waitGuard()).toContain(received!.id);
  for (let index = 0; index < 32; index += 1) f.refs.delete(`review-${index}`);
  expect(f.adapter.guardTurn(f.ctx, "read")).toContain("Route");
  const routed = f.adapter.routeInput(f.ctx, {
    inputId: received!.id,
    disposition: "work",
    reason: "Additional user work",
    amendItemIds: [],
  });
  expect(routed.disposition?.kind).toBe("work");
  expect(f.adapter.store.snapshot().intakes[0]!.request).toEqual({
    eventId: received!.id,
    input: { text: "also investigate fixture", images: [] },
    amendItemIds: [],
  });
  expect(f.adapter.waitGuard()).toContain(received!.id);
  expect(
    f.adapter.routeInput(f.ctx, {
      inputId: received!.id,
      disposition: "work",
      reason: "Additional user work",
      amendItemIds: [],
    }),
  ).toEqual(routed);
  expect(() =>
    f.adapter.routeInput(f.ctx, {
      inputId: received!.id,
      disposition: "status",
      reason: "Changed mind",
      amendItemIds: [],
    }),
  ).toThrow();
});
test("status/control disposition creates no work and synthetic or child input creates no receipt", (): void => {
  const f = fixture();
  expect(
    f.adapter.receiveInput(f.ctx, {
      text: "internal cue",
      source: "extension",
      images: [],
    }),
  ).toBeNull();
  expect(
    f.adapter.receiveInput(
      { ...f.ctx, agent: { id: "ordinary-child", kind: "sub" } },
      { text: "child input", source: "rpc", images: [] },
    ),
  ).toBeNull();
  const received = f.adapter.receiveInput(f.ctx, {
    text: "status please",
    source: "interactive",
    images: [],
  });
  expect(() =>
    f.adapter.routeInput(f.ctx, {
      inputId: received!.id,
      disposition: "status",
      reason: "",
      amendItemIds: [],
    }),
  ).toThrow();
  f.adapter.routeInput(f.ctx, {
    inputId: received!.id,
    disposition: "status",
    reason: "Only asks for existing queue status",
    amendItemIds: [],
  });
  expect(f.adapter.waitGuard()).toBeNull();
  expect(f.adapter.store.snapshot().intakes).toHaveLength(0);
  expect(f.adapter.store.snapshot().inputs).toHaveLength(1);
});
test("unrelated held resource cannot excuse undelegated intake", (): void => {
  const f = fixture();
  writeFileSync(
    join(f.root, "home", "startup", "fixture", "resources.json"),
    JSON.stringify({ locks: { unrelated: { "held-by": "old-work" } } }),
  );
  f.adapter.store.importResources({ manager: f.adapter.store.managerBinding });
  f.adapter.recordIntake(f.ctx, {
    eventId: "ready-raw",
    input: "New independent work",
    amendItemIds: [],
  });
  expect(() =>
    f.adapter.block(f.ctx, "ready-raw", {
      kind: "resource",
      target: "unrelated",
    }),
  ).toThrow();
  expect(f.adapter.waitGuard()).toContain("ready-raw");
});

test("native failure saves and immediately attempts manager notification before timer or acknowledgement", async (): Promise<void> => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "immediate-alert",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(
    f.ctx,
    hire.employees.map((employee) => employee.id),
  );
  const child = await f.project(hire.employees[0]!);
  f.adapter.nativeEnded(child.agent.id, "aborted");
  const cue = f.adapter.store
    .snapshot()
    .messages.find((message) => message.kind === "alert")!;
  expect(f.managerNotifications).toEqual([cue.id]);
  expect(cue.status).toBe("pending");
  expect(f.adapter.staff(f.ctx).deliveries[cue.id]).toMatchObject({
    kind: "manager-notification-attempt",
    messageId: cue.id,
  });
});
test("native async preflight failure releases only its proven failed activation for retry", async (): Promise<void> => {
  const f = fixture();
  const root = f.refs.get("Main");
  if (!root?.session) throw new Error("Fixture root session required");
  const terminal = Promise.withResolvers<void>();
  const job = {
    id: "native-job-2",
    agentId: "child-2",
    ownerId: "Main",
    type: "task",
    status: "running",
    promise: terminal.promise,
    errorText: "Actual native preflight refused",
    latestDetails: { progress: new Array<unknown>() },
  };
  const siblingJob = { ...job, id: "native-job-1", agentId: "child-1" };
  let registered = false;
  const session = {
    ...root.session,
    asyncJobManager: {
      getAllJobs: () => (registered ? [siblingJob, job] : []),
    },
  };
  f.refs.set("Main", { ...root, session });
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "async-partial",
    role: "devops",
    additional: 2,
  });
  const ids = hire.employees.map((employee) => employee.id);
  const ctx: NativeContext = {
    ...f.ctx,
    invokeTool: async (params) => {
      const result = await f.activate(params);
      const details = z
        .object({
          progress: z.array(
            z.object({
              index: z.number(),
              id: z.string(),
              agent: z.string(),
              assignment: z.string(),
              status: z.string(),
            }),
          ),
        })
        .parse(result.details);
      job.latestDetails.progress = details.progress.map((entry) => ({
        ...entry,
        status: "failed",
      }));
      registered = true;
      return {
        ...result,
        details: {
          ...details,
          async: { state: "running", type: "task", jobId: job.id },
        },
      };
    },
  };
  await f.adapter.activate(ctx, ids);
  await f.project(hire.employees[0]!);
  const sibling = f.adapter.store
    .snapshot()
    .employees.find((employee) => employee.id === ids[0]);
  expect((await f.adapter.activate(f.ctx, ids)).native).toBeNull();
  job.status = "failed";
  terminal.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(
    f.adapter.store
      .snapshot()
      .employees.find((employee) => employee.id === ids[1])?.error,
  ).toContain("failed");
  const retry = await f.adapter.activate(f.ctx, ids);
  expect(retry.native).not.toBeNull();
  expect(
    f.adapter.store
      .snapshot()
      .employees.find((employee) => employee.id === ids[0]),
  ).toEqual(sibling);
  expect(
    f.adapter.store
      .snapshot()
      .employees.map((employee) => employee.id)
      .sort(),
  ).toEqual(["manager", ...ids].sort());
});

function asyncActivationFixture() {
  const f = fixture();
  const root = f.refs.get("Main");
  if (!root?.session) throw new Error("Fixture native root required");
  const terminal = Promise.withResolvers<void>();
  const progress: {
    index: number;
    id: string;
    agent: string;
    assignment: string;
    status: string;
  }[] = [];
  const job = {
    id: "job-1",
    agentId: "child-1",
    ownerId: "Main",
    type: "task",
    status: "running",
    promise: terminal.promise,
    latestDetails: { progress },
  };
  const jobs: (typeof job)[] = [];
  const session = {
    ...root.session,
    asyncJobManager: { getAllJobs: () => jobs },
  };
  f.refs.set("Main", { ...root, session });
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "async-fences",
    role: "devops",
    additional: 1,
  });
  const ids = hire.employees.map((employee) => employee.id);
  const ctx: NativeContext = {
    ...f.ctx,
    invokeTool: async (params) => {
      const result = await f.activate(params);
      const details = z
        .object({
          progress: z.array(
            z.object({
              index: z.number(),
              id: z.string(),
              agent: z.string(),
              assignment: z.string(),
              status: z.string(),
            }),
          ),
        })
        .parse(result.details);
      progress.push(...details.progress);
      jobs.push(job);
      return {
        ...result,
        details: {
          ...details,
          async: { type: "task", state: "running", jobId: job.id },
        },
      };
    },
  };
  return { f, root, session, terminal, job, jobs, ids, ctx, hire };
}

for (const mutation of [
  "owner",
  "type",
  "agent",
  "job-id",
  "progress-id",
  "progress-agent",
  "progress-running",
  "running",
  "source",
  "employee-source",
  "lease",
  "session",
  "close",
  "shutdown",
]) {
  test(`native activation terminal observation fences ${mutation}`, async (): Promise<void> => {
    const a = asyncActivationFixture();
    await a.f.adapter.activate(a.ctx, a.ids);
    a.job.status = "failed";
    const progress = a.job.latestDetails.progress[0];
    if (!progress) throw new Error("Expected native progress");
    progress.status = "failed";
    switch (mutation) {
      case "owner":
        a.job.ownerId = "Other";
        break;
      case "type":
        a.job.type = "bash";
        break;
      case "agent":
        a.job.agentId = "other-child";
        break;
      case "job-id":
        a.job.id = "other-job";
        break;
      case "progress-id":
        progress.id = "other-child";
        break;
      case "progress-agent":
        progress.agent = "other-profile";
        break;
      case "progress-running":
        progress.status = "running";
        break;
      case "running":
        a.job.status = "running";
        break;
      case "source":
        writeFileSync(
          join(a.f.root, "skills/startup-role-manager/SKILL.md"),
          "changed",
        );
        break;
      case "employee-source":
        writeFileSync(
          join(a.f.root, "skills/startup-role-devops/SKILL.md"),
          "changed",
        );
        break;
      case "lease": {
        const db = new Database(
          join(a.f.root, "home/startup/fixture/staff.sqlite"),
        );
        db.query(
          "UPDATE lease SET token='other-owner' WHERE singleton=1",
        ).run();
        db.close();
        break;
      }
      case "session":
        a.f.refs.set("Main", {
          ...a.root,
          session: {
            ...a.session,
            sessionManager: {
              getSessionId: () => "other-session",
              getSessionFile: () => a.root.sessionFile ?? undefined,
            },
          },
        });
        break;
      case "close":
        a.f.adapter.close();
        break;
      case "shutdown":
        await a.f.adapter.shutdown();
        break;
    }
    const diagnostic = spyOn(process.stderr, "write").mockImplementation(() => true);
    a.terminal.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const diagnostics = diagnostic.mock.calls.map((call) => String(call[0]));
    diagnostic.mockRestore();
    expect(diagnostics).toHaveLength(["running", "close", "shutdown"].includes(mutation) ? 0 : 1);
    for (const line of diagnostics) expect(JSON.parse(line)).toMatchObject({ level: "warning", component: "startup-native-task" });
    expect(a.f.managerNotifications).toHaveLength(0);
    if (mutation !== "close" && mutation !== "shutdown" && mutation !== "lease")
      expect(
        a.f.adapter.store
          .snapshot()
          .employees.find((employee) => employee.id === a.ids[0])?.error,
      ).toBeNull();
  });
}

for (const field of ["ownerId", "type", "agentId"] as const) {
  test(`native activation refuses unmatched job ${field}`, async (): Promise<void> => {
    const a = asyncActivationFixture();
    a.job[field] = "unrelated";
    await expect(a.f.adapter.activate(a.ctx, a.ids)).rejects.toThrow(
      "correlated caller-owned task job",
    );
    expect(a.f.managerNotifications).toHaveLength(0);
  });
}

test("actual cancelled native job releases its pending reservation", async (): Promise<void> => {
  const a = asyncActivationFixture();
  await a.f.adapter.activate(a.ctx, a.ids);
  a.job.status = "cancelled";
  for (const progress of a.job.latestDetails.progress)
    progress.status = "aborted";
  a.terminal.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(
    a.f.adapter.store
      .snapshot()
      .employees.find((employee) => employee.id === a.ids[0])?.error,
  ).toContain("aborted");
  expect((await a.f.adapter.activate(a.f.ctx, a.ids)).native).not.toBeNull();
});

test("completed native activation without source binding is retryable and never ready", async (): Promise<void> => {
  const a = asyncActivationFixture();
  await a.f.adapter.activate(a.ctx, a.ids);
  a.job.status = "completed";
  for (const progress of a.job.latestDetails.progress)
    progress.status = "completed";
  a.terminal.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const employee = a.f.adapter.store
    .snapshot()
    .employees.find((entry) => entry.id === a.ids[0]);
  expect(employee?.nativeHandle).toBeNull();
  expect(employee?.error).toContain(
    "completed without verified source binding",
  );
  expect((await a.f.adapter.activate(a.f.ctx, a.ids)).native).not.toBeNull();
});

test("completed source-bound activation retains its successful native handle", async (): Promise<void> => {
  const a = asyncActivationFixture();
  await a.f.adapter.activate(a.ctx, a.ids);
  const original = a.hire.employees[0];
  if (!original) throw new Error("Expected reserved employee");
  await a.f.project(original);
  const bound = a.f.adapter.store
    .snapshot()
    .employees.find((entry) => entry.id === original.id);
  a.job.status = "completed";
  for (const progress of a.job.latestDetails.progress)
    progress.status = "completed";
  a.terminal.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(
    a.f.adapter.store
      .snapshot()
      .employees.find((entry) => entry.id === original.id),
  ).toEqual(bound);
  expect(a.f.managerNotifications).toHaveLength(0);
});

test("already-completed native job preserves source receipt awaiting dispatch correlation", async (): Promise<void> => {
  const a = asyncActivationFixture();
  const original = a.hire.employees[0];
  if (!original || !a.ctx.invokeTool)
    throw new Error("Expected activation fixture");
  const invoke = a.ctx.invokeTool;
  const ctx: NativeContext = {
    ...a.ctx,
    invokeTool: async (params) => {
      const result = await invoke(params);
      await a.f.project(original);
      a.job.status = "completed";
      for (const progress of a.job.latestDetails.progress)
        progress.status = "completed";
      a.terminal.resolve();
      return result;
    },
  };
  await a.f.adapter.activate(ctx, a.ids);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const bound = a.f.adapter.store
    .snapshot()
    .employees.find((entry) => entry.id === original.id);
  expect(bound?.generation).toBe(1);
  expect(bound?.error).toBeNull();
  expect(bound?.nativeHandle).toContain("child-1");
  expect(a.f.managerNotifications).toHaveLength(0);
});

test("ordinary terminal preflight failure releases its actual native admission", async (): Promise<void> => {
  const a = asyncActivationFixture();
  await a.f.adapter.ordinary(a.ctx, {
    context: "Bounded helper",
    tasks: [{ agent: "scout", task: "Return checkpoint" }],
  });
  expect(a.f.adapter.capacity().reserved).toBe(1);
  a.job.status = "failed";
  for (const progress of a.job.latestDetails.progress)
    progress.status = "failed";
  a.terminal.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(a.f.adapter.capacity().reserved).toBe(0);
});

for (const state of [
  "live",
  "parked",
  "completed",
  "wrong-parent",
  "wrong-header",
]) {
  test(`ordinary child-owned terminal admission validates ${state} caller`, async (): Promise<void> => {
    const a = asyncActivationFixture();
    const sessionFile = join(a.f.root, "ordinary-parent.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "session",
        id: "ordinary-session",
        parentSession: a.root.sessionFile,
      }) + "\n",
    );
    const sessionManager = {
      getSessionId: () => "ordinary-session",
      getSessionFile: () => sessionFile,
    };
    const owner: NativeRef = {
      ...a.root,
      id: "ordinary-parent",
      kind: "sub",
      parentId: "Main",
      createdAt: 2,
      sessionFile,
      session: { ...a.session, sessionManager },
    };
    a.f.refs.set(owner.id, owner);
    a.job.ownerId = owner.id;
    const ctx: NativeContext = {
      ...a.ctx,
      agent: { id: owner.id, kind: "sub", parentId: "Main" },
      sessionManager,
      getSystemPrompt: () => [],
    };
    await a.f.adapter.ordinary(ctx, {
      context: "Bounded helper",
      tasks: [{ agent: "scout", task: "Return checkpoint" }],
    });
    if (state !== "live")
      a.f.refs.set(owner.id, { ...owner, status: state, session: null });
    if (state === "wrong-parent")
      a.f.refs.set(owner.id, {
        ...owner,
        status: "parked",
        session: null,
        parentId: "Other",
      });
    if (state === "wrong-header") {
      a.f.refs.set(owner.id, { ...owner, status: "parked", session: null });
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: "session",
          id: "other-session",
          parentSession: a.root.sessionFile,
        }) + "\n",
      );
    }
    a.job.status = "failed";
    for (const progress of a.job.latestDetails.progress)
      progress.status = "failed";
    const diagnostic = spyOn(process.stderr, "write").mockImplementation(() => true);
    a.terminal.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const diagnostics = diagnostic.mock.calls.map((call) => String(call[0]));
    diagnostic.mockRestore();
    expect(diagnostics).toHaveLength(state.startsWith("wrong") ? 1 : 0);
    for (const line of diagnostics) expect(JSON.parse(line)).toMatchObject({ level: "warning", component: "startup-native-task" });
    expect(a.f.adapter.capacity().reserved).toBe(
      state.startsWith("wrong") ? 1 : 0,
    );
    expect(a.f.managerNotifications).toHaveLength(0);
  });
}

for (const fence of ["owner", "session", "source", "running"]) {
  test(`ordinary terminal admission retains slot on ${fence} mismatch`, async (): Promise<void> => {
    const a = asyncActivationFixture();
    await a.f.adapter.ordinary(a.ctx, {
      context: "Bounded helper",
      tasks: [{ agent: "scout", task: "Return checkpoint" }],
    });
    a.job.status = "failed";
    for (const progress of a.job.latestDetails.progress)
      progress.status = "failed";
    if (fence === "owner") a.job.ownerId = "Other";
    if (fence === "session")
      a.f.refs.set("Main", {
        ...a.root,
        session: {
          ...a.session,
          sessionManager: {
            getSessionId: () => "wrong-session",
            getSessionFile: () => a.root.sessionFile ?? undefined,
          },
        },
      });
    if (fence === "source")
      writeFileSync(
        join(a.f.root, "skills/startup-role-manager/SKILL.md"),
        "changed",
      );
    if (fence === "running") a.job.status = "running";
    const diagnostic = spyOn(process.stderr, "write").mockImplementation(() => true);
    a.terminal.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const diagnostics = diagnostic.mock.calls.map((call) => String(call[0]));
    diagnostic.mockRestore();
    expect(diagnostics).toHaveLength(fence === "running" ? 0 : 1);
    for (const line of diagnostics) expect(JSON.parse(line)).toMatchObject({ level: "warning", component: "startup-native-task" });
    expect(a.f.adapter.capacity().reserved).toBe(1);
  });
}

test("late ordinary job cannot release a different token reusing its native ID", async (): Promise<void> => {
  const a = asyncActivationFixture();
  const params = {
    context: "Bounded helper",
    tasks: [{ agent: "scout", task: "Return checkpoint" }],
  };
  await a.f.adapter.ordinary(a.ctx, params);
  a.f.adapter.nativeEnded("child-1", "idle");
  const ctx: NativeContext = {
    ...a.f.ctx,
    invokeTool: async () => ({
      content: [],
      details: { progress: a.job.latestDetails.progress },
    }),
  };
  await a.f.adapter.ordinary(ctx, params);
  a.job.status = "failed";
  for (const progress of a.job.latestDetails.progress)
    progress.status = "failed";
  a.terminal.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(a.f.adapter.capacity().reserved).toBe(1);
});

test("closed ordinary observer never inspects its eventual terminal job", async (): Promise<void> => {
  const a = asyncActivationFixture();
  await a.f.adapter.ordinary(a.ctx, {
    context: "Bounded helper",
    tasks: [{ agent: "scout", task: "Return checkpoint" }],
  });
  a.f.adapter.close();
  let reads = 0;
  Object.defineProperty(a.job, "status", {
    get: () => {
      reads += 1;
      return "failed";
    },
  });
  a.terminal.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(reads).toBe(0);
});

test("ordinary batch terminal failure releases only its own token", async (): Promise<void> => {
  const a = asyncActivationFixture();
  const other = Promise.withResolvers<void>();
  const job = {
    ...a.job,
    id: "job-2",
    agentId: "child-2",
    promise: other.promise,
  };
  const invoke = a.ctx.invokeTool;
  if (!invoke) throw new Error("Expected fixture dispatcher");
  const ctx: NativeContext = {
    ...a.ctx,
    invokeTool: async (params) => {
      const result = await invoke(params);
      a.jobs.push(job);
      return result;
    },
  };
  await a.f.adapter.ordinary(ctx, {
    context: "Independent bounded helpers",
    tasks: [
      { agent: "scout", task: "First" },
      { agent: "scout", task: "Second" },
    ],
  });
  a.job.status = "failed";
  const first = a.job.latestDetails.progress[0];
  const second = a.job.latestDetails.progress[1];
  if (!first || !second) throw new Error("Expected batch progress");
  first.status = "failed";
  a.terminal.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(a.f.adapter.capacity().reserved).toBe(1);
  second.status = "completed";
  job.status = "completed";
  other.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(a.f.adapter.capacity().reserved).toBe(0);
});

test("old terminal attempt cannot poison retry reusing a native ID", async (): Promise<void> => {
  const a = asyncActivationFixture();
  await a.f.adapter.activate(a.ctx, a.ids);
  a.f.adapter.nativeEnded("child-1", "failed");
  const retryCtx: NativeContext = {
    ...a.f.ctx,
    invokeTool: async () => ({
      content: [],
      details: {
        progress: a.job.latestDetails.progress.map((entry) => ({
          ...entry,
          status: "running",
        })),
      },
    }),
  };
  await a.f.adapter.activate(retryCtx, a.ids);
  a.job.status = "failed";
  for (const progress of a.job.latestDetails.progress)
    progress.status = "failed";
  a.terminal.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const original = a.hire.employees[0];
  if (!original) throw new Error("Expected reserved employee");
  await a.f.project(original);
  const bound = a.f.adapter.store
    .snapshot()
    .employees.find((employee) => employee.id === original.id);
  expect(bound?.generation).toBe(1);
  expect(bound?.error).toBeNull();
  expect(bound?.nativeHandle).toContain("child-1");
  expect(a.f.managerNotifications).toHaveLength(1);
});

test("async activation requires actual job observation but sync mode remains supported", async (): Promise<void> => {
  const a = asyncActivationFixture();
  a.f.refs.set("Main", a.root);
  await expect(a.f.adapter.activate(a.ctx, a.ids)).rejects.toThrow(
    "terminal job observation capability",
  );
});

test("duplicate pending-activation lifecycle failures do not trigger repeated manager turns", async (): Promise<void> => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "pending-failure",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(
    f.ctx,
    hire.employees.map((employee) => employee.id),
  );
  f.adapter.nativeEnded("child-1", "aborted");
  f.adapter.nativeEnded("child-1", "aborted");
  expect(f.managerNotifications).toHaveLength(1);
  expect(
    f.adapter.store
      .snapshot()
      .messages.filter((message) => message.kind === "alert"),
  ).toHaveLength(1);
});

test("employee-limit uses exact reusable staff and requested multi-developer team count", async (): Promise<void> => {
  const f = configuredFixture({ employeeLimit: 5, executionLimit: null });
  for (const [role, additional] of [
    ["architect", 1],
    ["qa", 1],
    ["dev", 2],
  ] as const) {
    const hire = f.adapter.reserve(f.ctx, {
      startup: "hire",
      requestId: `existing-${role}`,
      role,
      additional,
    });
    await f.adapter.activate(
      f.ctx,
      hire.employees.map((employee) => employee.id),
    );
    for (const employee of hire.employees) await f.project(employee);
  }
  const dev = f.adapter.store
    .snapshot()
    .employees.find((employee) => employee.role === "dev")!;
  f.adapter.store.sendCue({
    sender: f.adapter.store.managerBinding,
    cue: {
      id: "outstanding",
      recipient: dev.id,
      kind: "assignment",
      correlation: "other-work",
      payload: {},
    },
  });
  f.adapter.recordIntake(f.ctx, {
    eventId: "two-devs",
    input: "raw work",
    amendItemIds: [],
  });
  await expect(
    f.adapter.delegate(f.ctx, {
      startup: "delegate",
      eventId: "two-devs",
      developers: 2,
    }),
  ).rejects.toThrow("employee capacity");
  expect(() =>
    f.adapter.block(f.ctx, "two-devs", { kind: "employee-limit" }),
  ).not.toThrow();
  expect(f.adapter.waitGuard()).toContain("outstanding");
  await expect(
    f.adapter.delegate(f.ctx, {
      startup: "delegate",
      eventId: "two-devs",
      developers: 1,
    }),
  ).rejects.toThrow("conflicts");
});
test("raw images/history stay durable while projected current input is bounded and image retrieval is scoped", async (): Promise<void> => {
  const f = fixture();
  const image = {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
  };
  for (let index = 0; index < 100; index += 1) {
    const received = f.adapter.receiveInput(f.ctx, {
      source: "rpc",
      text: `Historical ${index} ` + "retained ".repeat(1024),
      images: [image],
    })!;
    f.adapter.routeInput(f.ctx, {
      inputId: received.id,
      disposition: "status",
      reason: "Retained historical status",
      amendItemIds: [],
    });
  }
  const received = f.adapter.receiveInput(f.ctx, {
    source: "rpc",
    text: "Relevant current image " + "request ".repeat(2048),
    images: [image],
  })!;
  const projection = (await f.adapter.projection(f.ctx))!;
  expect(projection).not.toContain(image.data);
  expect(projection.length).toBeLessThan(8192);
  expect(JSON.stringify(f.adapter.staff(f.ctx))).not.toContain("Historical");
  expect(JSON.stringify(f.adapter.staff(f.ctx))).not.toContain(image.data);
  expect(f.adapter.store.snapshot().inputs).toHaveLength(101);
  expect(
    f.adapter.image(f.ctx, { inputId: received.id, index: 0 }).content,
  ).toEqual([image]);
  const page = f.adapter.readInput(f.ctx, { inputId: received.id, offset: 0 });
  expect(page.text.length).toBe(4096);
  expect(page.nextOffset).toBe(4096);
  expect(() =>
    f.adapter.readInput(f.ctx, { inputId: received.id, offset: 999999 }),
  ).toThrow("offset");
  const routed = f.adapter.routeInput(f.ctx, {
    inputId: received.id,
    disposition: "work",
    reason: "Raw image work",
    amendItemIds: [],
  });
  expect(JSON.stringify(routed)).not.toContain(image.data);
  const team = await f.adapter.delegate(f.ctx, {
    startup: "delegate",
    eventId: received.id,
    developers: 1,
  });
  const contexts = new Map<string, NativeContext>();
  for (const id of [team.architect, team.qa, ...team.devs])
    contexts.set(
      id,
      await f.project(
        f.adapter.store
          .snapshot()
          .employees.find((employee) => employee.id === id)!,
      ),
    );
  const architect = contexts.get(team.architect)!;
  expect((await f.adapter.projection(architect))!).not.toContain(image.data);
  const claimed = f.adapter.claim(architect)!;
  const serializedClaim = JSON.stringify(claimed);
  expect(serializedClaim).not.toContain(image.data);
  expect(serializedClaim).not.toContain("request ".repeat(128));
  expect(serializedClaim.length).toBeLessThan(8192);
  expect(claimed.message.payload).toMatchObject({
    raw: {
      inputId: received.id,
      textTool: "startup_input",
      attachmentCount: 1,
      attachments: [{ tool: "startup_image", index: 0 }],
    },
  });
  const storedMessage = f.adapter.store
    .snapshot()
    .messages.find((message) => message.id === claimed.message.id)!;
  expect(storedMessage.payload).toMatchObject({ raw: received.raw });
  expect(
    f.adapter.store
      .snapshot()
      .claims.find((claim) => claim.id === claimed.claim.id)?.messageId,
  ).toBe(storedMessage.id);
  expect(
    f.adapter.readInput(architect, { inputId: received.id, offset: 4096 }).text,
  ).toBe(
    z.object({ text: z.string() }).parse(received.raw).text.slice(4096, 8192),
  );
  expect(
    f.adapter.image(architect, { inputId: received.id, index: 0 }).content,
  ).toEqual([image]);
  expect(
    f.adapter.image(contexts.get(team.qa)!, { inputId: received.id, index: 0 })
      .content,
  ).toEqual([image]);
  expect(() =>
    f.adapter.image(contexts.get(team.qa)!, {
      inputId: "foreign-input",
      index: 0,
    }),
  ).toThrow();
  const historical = f.adapter.store.snapshot().inputs[0]!;
  expect(() =>
    f.adapter.image(f.ctx, { inputId: historical.id, index: 0 }),
  ).toThrow();
});
test("wake admission reserves explicit capacity across sends and dispatch while allowing running injection", async (): Promise<void> => {
  const f = configuredFixture({ employeeLimit: null, executionLimit: 1 });
  const contexts: NativeContext[] = [];
  for (let index = 0; index < 3; index += 1) {
    const hire = f.adapter.reserve(f.ctx, {
      startup: "hire",
      requestId: `wake-cap-${index}`,
      role: "devops",
      additional: 1,
    });
    await f.adapter.activate(
      f.ctx,
      hire.employees.map((employee) => employee.id),
    );
    contexts.push(await f.project(hire.employees[0]!));
  }
  const employees = f.adapter.store
    .snapshot()
    .employees.filter((employee) => employee.role === "devops");
  const running = f.refs.get(contexts[0]!.agent.id)!;
  f.refs.set(running.id, { ...running, status: "running" });
  await f.adapter.send(f.ctx, {
    id: "blocked-send",
    recipient: employees[1]!.id,
    kind: "assignment",
    correlation: "later",
    payload: {},
  });
  expect(f.wakePaths).toHaveLength(0);
  expect(
    f.adapter.store
      .snapshot()
      .messages.find((message) => message.id === "blocked-send")?.status,
  ).toBe("pending");
  expect(f.adapter.staff(f.ctx).deliveries["blocked-send"]).toMatchObject({
    kind: "capacity-blocked",
  });
  await f.adapter.send(f.ctx, {
    id: "running-injection",
    recipient: employees[0]!.id,
    kind: "report",
    correlation: "current",
    payload: {},
  });
  expect(f.wakePaths).toHaveLength(1);
  f.refs.set(running.id, { ...running, status: "idle" });
  f.adapter.store.sendCue({
    sender: f.adapter.store.managerBinding,
    cue: {
      id: "parallel-second",
      recipient: employees[2]!.id,
      kind: "assignment",
      correlation: "later",
      payload: {},
    },
  });
  const deliveries = await f.adapter.dispatch(f.ctx, [
    "blocked-send",
    "parallel-second",
  ]);
  expect(f.wakePaths).toHaveLength(2);
  expect(deliveries[1]).toMatchObject({ kind: "capacity-blocked" });
});

test("activation and wake share one in-flight execution reservation", async () => {
  const f = configuredFixture({ employeeLimit: null, executionLimit: 1 });
  const first = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "admitted-idle",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(f.ctx, [first.employees[0]!.id]);
  await f.project(first.employees[0]!);
  const next = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "activation-held",
    role: "devops",
    additional: 1,
  });
  const releaseCallbacks: (() => void)[] = [];
  const held = new Promise<void>((resolve) => {
    releaseCallbacks.push(resolve);
  });
  const ctx: NativeContext = {
    ...f.ctx,
    invokeTool: async (params) => {
      await held;
      return f.activate(params);
    },
  };
  const activation = f.adapter.activate(ctx, [next.employees[0]!.id]);
  await f.adapter.send(f.ctx, {
    id: "during-activation",
    recipient: first.employees[0]!.id,
    kind: "assignment",
    correlation: "test",
    payload: {},
  });
  expect(f.wakePaths).toHaveLength(0);
  expect(f.adapter.capacity().reserved).toBe(1);
  const release = releaseCallbacks[0];
  if (!release) throw new Error("Fixture release missing");
  release();
  await activation;
  await f.project(next.employees[0]!);
  expect(f.adapter.capacity().available).toBe(1);
});
test("complete-team and outgoing settlement wakes keep excess cues pending", async () => {
  const f = configuredFixture({ employeeLimit: null, executionLimit: 1 });
  f.adapter.recordIntake(f.ctx, {
    eventId: "team-cap",
    input: "raw",
    amendItemIds: [],
  });
  const team = await f.adapter.delegate(f.ctx, {
    startup: "delegate",
    eventId: "team-cap",
    developers: 1,
  });
  const contexts = new Map<string, NativeContext>();
  for (const id of [team.architect, team.qa, ...team.devs]) {
    await f.adapter.activate(f.ctx, [id]);
    contexts.set(
      id,
      await f.project(
        f.adapter.store
          .snapshot()
          .employees.find((employee) => employee.id === id)!,
      ),
    );
  }
  expect(f.wakePaths).toHaveLength(1);
  expect(
    Object.values(f.adapter.staff(f.ctx).deliveries).filter(
      (delivery) =>
        z.object({ kind: z.literal("capacity-blocked") }).safeParse(delivery)
          .success,
    ),
  ).toHaveLength(2);
  f.setStatus(contexts.get(team.architect)!.agent.id, "idle");
  f.setStatus(contexts.get(team.qa)!.agent.id, "running");
  const dev = contexts.get(team.devs[0]!)!;
  const claimed = f.adapter.claim(dev)!;
  await f.adapter.settle(dev, {
    claimId: claimed.claim.id,
    result: {
      id: "capacity-settlement",
      kind: "completed",
      output: {},
      checkpoint: {},
      outgoing: [
        {
          id: "capacity-report",
          recipient: team.architect,
          kind: "report",
          correlation: "team-cap",
          payload: {},
        },
      ],
    },
  });
  expect(
    f.adapter.store
      .snapshot()
      .messages.find((message) => message.id === "capacity-report")?.status,
  ).toBe("pending");
  expect(f.adapter.staff(f.ctx).deliveries["capacity-report"]).toMatchObject({
    kind: "capacity-blocked",
  });
  expect(f.wakePaths).toHaveLength(1);
});
test("ordinary bounded launches cannot bypass active explicit capacity and batch reservations", async () => {
  const f = configuredFixture({ employeeLimit: null, executionLimit: 1 });
  const hire = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "ordinary-parent",
    role: "devops",
    additional: 1,
  });
  await f.adapter.activate(f.ctx, [hire.employees[0]!.id]);
  const child = await f.project(hire.employees[0]!);
  f.setStatus(child.agent.id, "running");
  let calls = 0;
  const parent: NativeContext = {
    ...child,
    invokeTool: async (params) => {
      calls += 1;
      return f.activate(params);
    },
  };
  await expect(
    f.adapter.ordinary(parent, {
      context: "buddy",
      tasks: [{ task: "review", solutionSpace: "bounded" }],
    }),
  ).rejects.toThrow("capacity");
  expect(calls).toBe(0);
  f.setStatus(child.agent.id, "idle");
  await expect(
    f.adapter.ordinary(f.ctx, {
      context: "batch",
      tasks: [{ task: "one" }, { task: "two" }],
    }),
  ).rejects.toThrow("capacity");
  const original = {
    task: "single",
    solutionSpace: "bounded",
    outputSchema: { type: "object" },
  };
  const seen: Record<string, unknown>[] = [];
  const ctx: NativeContext = {
    ...f.ctx,
    invokeTool: async (params) => {
      seen.push(params);
      return { content: [], details: { error: "Native validation rejection" } };
    },
  };
  expect((await f.adapter.ordinary(ctx, original)).details).toEqual({
    error: "Native validation rejection",
  });
  expect(seen[0]).toBe(original);
  expect(f.adapter.capacity().available).toBe(1);
});

test("concurrent root and sibling ordinary launches reserve aggregate slots and release on native evidence", async () => {
  const f = configuredFixture({ employeeLimit: null, executionLimit: 2 });
  const main = f.refs.get("Main")!;
  const path = join(f.root, "ordinary-parent.jsonl");
  writeFileSync(
    path,
    JSON.stringify({
      type: "session",
      id: "ordinary-parent-session",
      parentSession: f.ctx.sessionManager.getSessionFile(),
    }) + "\n",
  );
  const sibling: NativeContext = {
    ...f.ctx,
    agent: { id: "ordinary-parent", kind: "sub", parentId: "Main" },
    sessionManager: {
      getSessionId: () => "ordinary-parent-session",
      getSessionFile: () => path,
    },
  };
  f.refs.set("ordinary-parent", {
    ...main,
    id: "ordinary-parent",
    kind: "sub",
    parentId: "Main",
    status: "idle",
    sessionFile: path,
    session: { ...main.session!, sessionManager: sibling.sessionManager },
  });
  const releases: (() => void)[] = [];
  const invoke = async (
    params: Record<string, unknown>,
  ): Promise<NativeResult> => {
    const index = releases.length;
    await new Promise<void>((resolve) => releases.push(resolve));
    const id = `ordinary-result-${index}`;
    f.refs.set(id, {
      ...main,
      id,
      kind: "sub",
      parentId: index === 0 ? "Main" : "ordinary-parent",
      status: "running",
    });
    return {
      content: [],
      details: {
        progress: [
          {
            index: 0,
            id,
            status: "running",
            agent: "task",
            assignment: JSON.stringify(params),
          },
        ],
      },
    };
  };
  const first = f.adapter.ordinary(
    { ...f.ctx, invokeTool: invoke },
    { task: "one" },
  );
  const second = f.adapter.ordinary(
    { ...sibling, invokeTool: invoke },
    { tasks: [{ task: "two" }] },
  );
  await expect(f.adapter.ordinary(f.ctx, { task: "third" })).rejects.toThrow(
    "capacity",
  );
  expect(f.adapter.capacity().reserved).toBe(2);
  for (const release of releases) release();
  await Promise.all([first, second]);
  expect(f.adapter.capacity().available).toBe(0);
  f.setStatus("ordinary-result-0", "idle");
  expect(f.adapter.capacity().available).toBe(1);
  f.setStatus("ordinary-result-1", "aborted");
  expect(f.adapter.capacity().available).toBe(2);
  const completed: NativeContext = {
    ...f.ctx,
    invokeTool: async () => ({
      content: [],
      details: { results: [{ index: 0, id: "sync-done", exitCode: 0 }] },
    }),
  };
  await f.adapter.ordinary(completed, { task: "sync" });
  expect(f.adapter.capacity().available).toBe(2);
});

test("exact native preflight error shape releases ordinary admission unchanged", async () => {
  const f = configuredFixture({ employeeLimit: null, executionLimit: 1 });
  const result: NativeResult = {
    content: [{ type: "text", text: "Task failed preflight" }],
    details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
  };
  const ctx: NativeContext = { ...f.ctx, invokeTool: async () => result };
  expect(await f.adapter.ordinary(ctx, { task: "native invalid" })).toBe(
    result,
  );
  expect(f.adapter.capacity().available).toBe(1);
});
async function capturedTeam(
  f: ReturnType<typeof fixture>,
  eventId: string,
  itemIds: readonly string[],
) {
  f.adapter.recordIntake(f.ctx, {
    eventId,
    input: "Raw scoped request",
    amendItemIds: [],
  });
  const team = await f.adapter.delegate(f.ctx, {
    startup: "delegate",
    eventId,
    developers: 1,
  });
  const contexts = new Map<string, NativeContext>();
  for (const id of [team.architect, team.qa, ...team.devs])
    contexts.set(
      id,
      await f.project(
        f.adapter.store
          .snapshot()
          .employees.find((employee) => employee.id === id)!,
      ),
    );
  f.adapter.capture(contexts.get(team.architect)!, {
    captureId: `capture-${eventId}`,
    eventId,
    rows: itemIds.map((id) => ({
      id,
      expectedRevision: null,
      fields: {
        request: `Work ${id}`,
        acceptance: ["proof"],
        blocked_on: [],
        status: "QUEUED",
        unknown: { retained: true },
        receipts: ["legacy"],
      },
    })),
    receipt: { captured: true },
  });
  for (const ctx of [f.ctx, ...contexts.values()]) {
    while (true) {
      const claim = f.adapter.store.claimNext({
        employee: f.adapter.caller(ctx),
      });
      if (!claim) break;
      f.adapter.store.settleClaim({
        employee: f.adapter.caller(ctx),
        claimId: claim.claim.id,
        result: {
          id: `bootstrap-${claim.claim.id}`,
          kind: "completed",
          output: {},
          checkpoint: {},
          outgoing: [],
        },
      });
    }
  }
  return { team, contexts };
}
test("captured ready items remain guarded after settled bootstrap and prevent team abandonment", async () => {
  const f = fixture();
  const { team } = await capturedTeam(f, "guarded-items", ["ready-item"]);
  expect(f.adapter.waitGuard()).toContain("ready-item");
  expect(() =>
    f.adapter.finish(f.ctx, { teamId: team.id, evidence: { done: true } }),
  ).toThrow("nonterminal");
});
test("item assignment and role-gated canonical completion preserve revision and replay receipts", async () => {
  const f = fixture();
  const { team, contexts } = await capturedTeam(f, "item-flow", ["item-a"]);
  const architect = contexts.get(team.architect)!;
  const dev = contexts.get(team.devs[0]!)!;
  const qa = contexts.get(team.qa)!;
  const assigned = await f.adapter.item(architect, {
    action: "assign",
    requestId: "assign-a",
    itemId: "item-a",
    expectedRevision: 1,
    employeeId: team.devs[0],
    evidence: { approved: true },
  });
  expect(assigned.status).toBe("EXECUTING");
  expect(assigned.revision).toBe(2);
  await capturedTeam(f, "other-item-flow", ["item-b"]);
  expect(f.adapter.waitGuard()).toContain("item-b");
  await expect(
    f.adapter.item(architect, {
      action: "assign",
      requestId: "stale",
      itemId: "item-a",
      expectedRevision: 1,
      employeeId: team.devs[0],
      evidence: {},
    }),
  ).rejects.toThrow("revision");
  const claim = f.adapter.claim(dev)!;
  await f.adapter.settle(dev, {
    claimId: claim.claim.id,
    result: {
      id: "dev-item-result",
      kind: "completed",
      output: { built: true },
      checkpoint: {},
      outgoing: [],
    },
  });
  await f.adapter.item(dev, {
    action: "review",
    requestId: "review-a",
    itemId: "item-a",
    expectedRevision: 2,
    resultId: "dev-item-result",
    evidence: {},
  });
  await expect(
    f.adapter.item(architect, {
      action: "gate",
      requestId: "no-qa",
      itemId: "item-a",
      expectedRevision: 3,
      verdict: "APPROVE",
      evidence: {},
    }),
  ).rejects.toThrow("QA");
  await f.adapter.item(architect, {
    action: "qa_assign",
    requestId: "qa-assign-a",
    itemId: "item-a",
    expectedRevision: 3,
    evidence: { review: true },
  });
  const qaClaim = f.adapter.claim(qa)!;
  await f.adapter.settle(qa, {
    claimId: qaClaim.claim.id,
    result: {
      id: "qa-item-result",
      kind: "completed",
      output: { proof: "verified" },
      checkpoint: {},
      outgoing: [],
    },
  });
  await f.adapter.item(qa, {
    action: "qa",
    requestId: "qa-a",
    itemId: "item-a",
    expectedRevision: 4,
    resultId: "qa-item-result",
    verdict: "APPROVE",
    proof: { proof: "verified" },
  });
  await f.adapter.item(architect, {
    action: "gate",
    requestId: "gate-a",
    itemId: "item-a",
    expectedRevision: 5,
    verdict: "APPROVE",
    evidence: { shape: "approved" },
  });
  const done = {
    action: "decide",
    requestId: "done-a",
    itemId: "item-a",
    expectedRevision: 6,
    status: "DONE",
    evidence: { accepted: true },
  };
  const completion = await f.adapter.item(f.ctx, done);
  expect(completion.revision).toBe(7);
  expect(await f.adapter.item(f.ctx, done)).toEqual(completion);
  const queue = z
    .array(
      z
        .object({
          id: z.string(),
          status: z.string(),
          unknown: z.unknown(),
          receipts: z.array(z.unknown()),
        })
        .passthrough(),
    )
    .parse(
      JSON.parse(
        readFileSync(
          join(f.root, "home", "startup", "fixture", "queue.json"),
          "utf8",
        ),
      ),
    );
  expect(queue.find((row) => row.id === "item-a")).toMatchObject({
    status: "DONE",
    unknown: { retained: true },
    receipts: ["legacy"],
  });
});

test.each([
  "Fix apps/scan-service/package.json and reject zero verified tasks; implement and test, not review-only.",
  { procedure: "pipeline", request: "Implement the two-file REDO", acceptance: ["changed commit", "zero-task regression"] },
])("item execution delivers current rework directive and architect destination: %j", async (directive) => {
  const f = fixture();
  const { team, contexts } = await capturedTeam(f, "rework-scope", ["rework-item"]);
  await f.adapter.item(contexts.get(team.architect)!, {
    action: "assign", requestId: "rework-assign", itemId: "rework-item",
    expectedRevision: 1, employeeId: team.devs[0], evidence: directive,
  });
  const claim = f.adapter.claim(contexts.get(team.devs[0]!)!)!;
  expect(claim.message.payload).toMatchObject({
    kind: "item-execution", directive, reportTo: team.architect,
  });
  expect(claim.message.payload).toHaveProperty("snapshot.request", "Work rework-item");
});

const itemResultKinds: Result["kind"][] = ["completed", "question", "uncertain"];
test.each(itemResultKinds)("item %s settlement durably reports the exact result to its architect once", async (kind) => {
  const f = fixture();
  const { team, contexts } = await capturedTeam(f, "result-handoff", ["handoff-item"]);
  const dev = contexts.get(team.devs[0]!)!;
  await f.adapter.item(contexts.get(team.architect)!, {
    action: "assign", requestId: "handoff-assign", itemId: "handoff-item",
    expectedRevision: 1, employeeId: team.devs[0], evidence: "Implement bounded rework",
  });
  const claim = f.adapter.claim(dev)!;
  const request = {
    employee: f.adapter.caller(dev),
    result: { id: "handoff-result", kind, output: { commit: "fixed-head", proof: "regression" }, checkpoint: {}, outgoing: [] },
  };
  const settled = f.adapter.store.settleClaim(request);
  expect(settled.messages).toHaveLength(1);
  expect(settled.messages[0]).toMatchObject({
    id: `item-result-${claim.message.id}`, recipient: team.architect, kind: "report", correlation: "handoff-item",
    payload: { kind: "item-result", itemId: "handoff-item", resultId: "handoff-result", outcome: kind, output: request.result.output },
  });
  expect(f.adapter.store.settleClaim(request)).toEqual(settled);
  expect(f.adapter.store.snapshot().messages.filter((message) => message.id === settled.messages[0]!.id)).toHaveLength(1);
  expect(f.adapter.store.snapshot().itemExecutions.find((execution) => execution.itemId === "handoff-item")?.reviewResultId).toBeNull();
});

test("item review and landing continuation stay guarded after reports settle", async () => {
  const f = fixture();
  const { team, contexts } = await capturedTeam(f, "continuation", [
    "continuation-item",
  ]);
  const architect = contexts.get(team.architect)!;
  const dev = contexts.get(team.devs[0]!)!;
  await f.adapter.item(architect, {
    action: "assign",
    requestId: "continuation-assign",
    itemId: "continuation-item",
    expectedRevision: 1,
    employeeId: team.devs[0],
    evidence: {},
  });
  const claim = f.adapter.claim(dev)!;
  await f.adapter.settle(dev, {
    claimId: claim.claim.id,
    result: {
      id: "continuation-result",
      kind: "completed",
      output: {},
      checkpoint: {},
      outgoing: [],
    },
  });
  expect(f.adapter.waitGuard()).toContain("assigned dev review");
  await f.adapter.item(dev, {
    action: "review",
    requestId: "continuation-review",
    itemId: "continuation-item",
    expectedRevision: 2,
    resultId: "continuation-result",
    evidence: {},
  });
  const report = f.adapter.claim(architect)!;
  await f.adapter.settle(architect, {
    claimId: report.claim.id,
    result: {
      id: "consumed-review",
      kind: "completed",
      output: {},
      checkpoint: {},
      outgoing: [],
    },
  });
  expect(f.adapter.waitGuard()).toContain("review/gate continuation");
});
test("unknown item outcome requires reconciliation and explicit resume before redispatch", async () => {
  const f = fixture();
  const { team, contexts } = await capturedTeam(f, "uncertain-item", [
    "uncertain-item",
  ]);
  const dev = contexts.get(team.devs[0]!)!;
  await f.adapter.item(f.ctx, {
    action: "assign",
    requestId: "uncertain-assign",
    itemId: "uncertain-item",
    expectedRevision: 1,
    employeeId: team.devs[0],
    evidence: { authorized: true },
  });
  const claim = f.adapter.claim(dev)!;
  await f.adapter.item(f.ctx, {
    action: "decide",
    requestId: "uncertain-block",
    itemId: "uncertain-item",
    expectedRevision: 2,
    status: "BLOCKED",
    evidence: { unknown: true },
  });
  await expect(
    f.adapter.item(f.ctx, {
      action: "decide",
      requestId: "too-early-resume",
      itemId: "uncertain-item",
      expectedRevision: 3,
      status: "QUEUED",
      evidence: {},
    }),
  ).rejects.toThrow("Reconcile");
  await f.adapter.settle(dev, {
    claimId: claim.claim.id,
    result: {
      id: "unknown-item-result",
      kind: "uncertain",
      output: { unknown: true },
      checkpoint: {},
      outgoing: [],
    },
  });
  f.adapter.reconcile(f.ctx, {
    claimId: claim.claim.id,
    evidence: { verified: true },
  });
  f.adapter.resolve(f.ctx, {
    assignmentId: claim.message.id,
    evidence: { verified: true },
  });
  await f.adapter.item(f.ctx, {
    action: "decide",
    requestId: "explicit-resume",
    itemId: "uncertain-item",
    expectedRevision: 3,
    status: "QUEUED",
    evidence: { verified: true },
  });
  expect(
    f.adapter.store
      .snapshot()
      .results.find((result) => result.result.id === "unknown-item-result")
      ?.result.kind,
  ).toBe("uncertain");
  expect(f.adapter.store.snapshot().itemTransitions).toHaveLength(3);
});
test("new explicitly amended team owns current item revision and old team can close transferred history", async () => {
  const f = fixture();
  const old = await capturedTeam(f, "old-amend", ["shared-item"]);
  const oldArchitect = old.contexts.get(old.team.architect)!;
  await f.adapter.send(f.ctx, {
    id: "clarify-old",
    recipient: old.team.architect,
    kind: "assignment",
    correlation: "old-amend",
    payload: { clarify: true },
  });
  const claim = f.adapter.claim(oldArchitect)!;
  await f.adapter.settle(oldArchitect, {
    claimId: claim.claim.id,
    result: {
      id: "clarify-result",
      kind: "question",
      output: { question: true },
      checkpoint: {},
      outgoing: [],
    },
  });
  f.adapter.recordIntake(f.ctx, {
    eventId: "new-amend",
    input: "Amend pending work",
    amendItemIds: ["shared-item"],
  });
  const next = await f.adapter.delegate(f.ctx, {
    startup: "delegate",
    eventId: "new-amend",
    developers: 1,
  });
  const contexts = new Map<string, NativeContext>();
  for (const id of [next.architect, next.qa, ...next.devs])
    contexts.set(
      id,
      await f.project(
        f.adapter.store
          .snapshot()
          .employees.find((employee) => employee.id === id)!,
      ),
    );
  f.adapter.capture(contexts.get(next.architect)!, {
    captureId: "new-amend-capture",
    eventId: "new-amend",
    rows: [
      {
        id: "shared-item",
        expectedRevision: 1,
        fields: {
          request: "Work shared-item amended",
          acceptance: ["proof"],
          blocked_on: [],
          status: "QUEUED",
        },
      },
    ],
    receipt: { authorized: true },
  });
  await expect(
    f.adapter.item(oldArchitect, {
      action: "assign",
      requestId: "old-stale-team",
      itemId: "shared-item",
      expectedRevision: 2,
      employeeId: old.team.devs[0],
      evidence: {},
    }),
  ).rejects.toThrow("owning team");
  f.adapter.resolve(f.ctx, {
    assignmentId: claim.message.id,
    evidence: { transferred: true },
  });
  while (true) {
    const mail = f.adapter.claim(f.ctx);
    if (!mail) break;
    await f.adapter.settle(f.ctx, {
      claimId: mail.claim.id,
      result: {
        id: `clear-${mail.claim.id}`,
        kind: "completed",
        output: {},
        checkpoint: {},
        outgoing: [],
      },
    });
  }
  expect(
    f.adapter.finish(f.ctx, {
      teamId: old.team.id,
      evidence: { transferred: true },
    }).state,
  ).toBe("finished");
  expect(
    f.adapter.store
      .snapshot()
      .queueRevisions.find((owner) => owner.id === "shared-item"),
  ).toMatchObject({ eventId: "new-amend", revision: 2 });
});
test("item intent recovery replays a canonical replacement once with assignment and receipt", async () => {
  const f = fixture();
  const { team, contexts } = await capturedTeam(f, "journal-item", [
    "journal-item",
  ]);
  const old = f.adapter.store.snapshot();
  const receipt = await f.adapter.item(contexts.get(team.architect)!, {
    action: "assign",
    requestId: "journal-assign",
    itemId: "journal-item",
    expectedRevision: 1,
    employeeId: team.devs[0],
    evidence: {},
  });
  f.adapter.close();
  const db = new Database(
    join(f.root, "home", "startup", "fixture", "staff.sqlite"),
  );
  const intentRow = z
    .object({ payload: z.string() })
    .parse(
      db
        .query(
          "SELECT payload FROM records WHERE kind='intent' AND id='item/journal-assign'",
        )
        .get(),
    );
  const intent = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(intentRow.payload));
  db.query(
    "UPDATE records SET payload=? WHERE kind='intent' AND id='item/journal-assign'",
  ).run(JSON.stringify({ ...intent, state: "pending" }));
  db.query(
    "DELETE FROM records WHERE kind='itemTransition' AND id='journal-assign'",
  ).run();
  db.query(
    "DELETE FROM records WHERE kind='itemExecution' AND id='journal-item'",
  ).run();
  for (const cue of receipt.cues) {
    db.query("DELETE FROM records WHERE kind='message' AND id=?").run(
      cue.cue.id,
    );
    db.query("DELETE FROM records WHERE kind='assignment' AND id=?").run(
      cue.cue.id,
    );
  }
  db.query("UPDATE records SET payload=? WHERE kind='team' AND id=?").run(
    JSON.stringify(old.teams.find((entry) => entry.id === team.id)),
    team.id,
  );
  db.query(
    "UPDATE records SET payload=? WHERE kind='queueOwner' AND id='journal-item'",
  ).run(
    JSON.stringify(
      old.queueRevisions.find((entry) => entry.id === "journal-item"),
    ),
  );
  const audits = z
    .array(z.object({ sequence: z.number(), payload: z.string() }))
    .parse(
      db
        .query(
          "SELECT sequence,payload FROM audit WHERE kind='intent' AND id='item/journal-assign' ORDER BY sequence",
        )
        .all(),
    );
  const pending = audits.find(
    (row) =>
      z.object({ state: z.string() }).parse(JSON.parse(row.payload)).state ===
      "pending",
  )!;
  db.query("DELETE FROM audit WHERE sequence>?").run(pending.sequence);
  db.close();
  const root = f.refs.get("Main")!;
  f.refs.set("Main", { ...root, createdAt: 2 });
  const reopened = createAdapter({
    ctx: f.ctx,
    registry: {
      get: (id) => f.refs.get(id),
      list: () => [...f.refs.values()],
      onChange: () => () => {},
    },
    config: {
      boundRoot: f.ctx.cwd,
      name: "fixture",
      home: join(f.root, "home"),
      skillsRoot: f.root,
      employeeLimit: null,
      executionLimit: null,
      leaseMs: 60000,
    },
    nativeLimit: () => 32,
    nativeBatch: () => true,
    notifyManager: () => {},
    now: Date.now,
  });
  adapters.push(reopened);
  expect(reopened.store.snapshot().itemTransitions).toHaveLength(1);
  expect(
    reopened.store
      .snapshot()
      .queueRevisions.find((owner) => owner.id === "journal-item")?.revision,
  ).toBe(2);
  expect(
    reopened.store
      .snapshot()
      .messages.filter((message) => message.id === receipt.cues[0]!.cue.id),
  ).toHaveLength(1);
  await reopened.projection(contexts.get(team.architect)!);
  expect(
    await reopened.item(contexts.get(team.architect)!, receipt.request),
  ).toEqual(receipt);
  expect(reopened.store.snapshot().itemTransitions).toHaveLength(1);
});

test("item dependency blocks its mapped wake, projection and claim while unrelated work remains ready", async () => {
  const f = fixture();
  const prerequisite = await capturedTeam(f, "prerequisite-event", [
    "prerequisite",
  ]);
  const { team, contexts } = await capturedTeam(f, "dependency-event", []);
  const architect = contexts.get(team.architect)!;
  const dev = contexts.get(team.devs[0]!)!;
  f.adapter.capture(architect, {
    captureId: "dependency-rows",
    eventId: "dependency-event",
    rows: [
      {
        id: "dependent",
        expectedRevision: null,
        fields: {
          request: "D",
          acceptance: [],
          blocked_on: ["prerequisite"],
          status: "QUEUED",
        },
      },
    ],
    receipt: {},
  });
  f.adapter.block(f.ctx, "dependent", {
    kind: "dependency",
    itemId: "prerequisite",
  });
  const before = f.wakePaths.length;
  await f.adapter.item(architect, {
    action: "assign",
    requestId: "dependent-assign",
    itemId: "dependent",
    expectedRevision: 1,
    employeeId: team.devs[0],
    evidence: {},
  });
  expect(f.wakePaths.length).toBe(before);
  expect(f.adapter.claim(dev)).toBeNull();
  expect(await f.adapter.projection(dev)).toContain("STARTUP_CUE=null");
  await capturedTeam(f, "independent-event", ["independent"]);
  expect(f.adapter.waitGuard()).toContain("prerequisite");
  await f.adapter.send(architect, {
    id: "unrelated-own",
    recipient: team.devs[0],
    kind: "assignment",
    correlation: "unrelated",
    payload: { independent: true },
  });
  const unrelated = f.adapter.claim(dev)!;
  expect(unrelated.message.id).toBe("unrelated-own");
  await f.adapter.settle(dev, {
    claimId: unrelated.claim.id,
    result: {
      id: "unrelated-result",
      kind: "completed",
      output: {},
      checkpoint: {},
      outgoing: [],
    },
  });
  const pArchitect = prerequisite.contexts.get(prerequisite.team.architect)!;
  const pDev = prerequisite.contexts.get(prerequisite.team.devs[0]!)!;
  const pQa = prerequisite.contexts.get(prerequisite.team.qa)!;
  await f.adapter.item(pArchitect, {
    action: "assign",
    requestId: "p-assign",
    itemId: "prerequisite",
    expectedRevision: 1,
    employeeId: prerequisite.team.devs[0],
    evidence: {},
  });
  const pDevClaim = f.adapter.claim(pDev)!;
  await f.adapter.settle(pDev, {
    claimId: pDevClaim.claim.id,
    result: {
      id: "p-dev-result",
      kind: "completed",
      output: {},
      checkpoint: {},
      outgoing: [],
    },
  });
  await f.adapter.item(pDev, {
    action: "review",
    requestId: "p-review",
    itemId: "prerequisite",
    expectedRevision: 2,
    resultId: "p-dev-result",
    evidence: {},
  });
  await f.adapter.item(pArchitect, {
    action: "qa_assign",
    requestId: "p-qa-assign",
    itemId: "prerequisite",
    expectedRevision: 3,
    evidence: {},
  });
  const pQaClaim = f.adapter.claim(pQa)!;
  await f.adapter.settle(pQa, {
    claimId: pQaClaim.claim.id,
    result: {
      id: "p-qa-result",
      kind: "completed",
      output: {},
      checkpoint: {},
      outgoing: [],
    },
  });
  await f.adapter.item(pQa, {
    action: "qa",
    requestId: "p-qa",
    itemId: "prerequisite",
    expectedRevision: 4,
    resultId: "p-qa-result",
    verdict: "APPROVE",
    proof: {},
  });
  await f.adapter.item(pArchitect, {
    action: "gate",
    requestId: "p-gate",
    itemId: "prerequisite",
    expectedRevision: 5,
    verdict: "APPROVE",
    evidence: {},
  });
  await f.adapter.item(f.ctx, {
    action: "decide",
    requestId: "p-done",
    itemId: "prerequisite",
    expectedRevision: 6,
    status: "DONE",
    evidence: {},
  });
  expect(f.adapter.waitGuard()).toContain("independent");
  const pending = f.adapter.store
    .snapshot()
    .messages.find((message) => message.correlation === "dependent")!;
  const receipt = await f.adapter.dispatch(f.ctx, [pending.id]);
  expect(receipt).not.toMatchObject([{ kind: "dependency-blocked" }]);
  expect(f.adapter.claim(dev)?.message.id).toBe(pending.id);
});

test("host-only duty binding requires actual loaded source and native root evidence", async () => {
  const f = fixture();
  const receipt = f.adapter.reserve(f.ctx, {
    startup: "hire",
    requestId: "duty",
    role: "devops",
    additional: 1,
  });
  const employee = receipt.employees[0];
  if (!employee) throw new Error("Missing employee");
  expect(f.adapter.dutyBinding(employee.id)).toBeNull();
  await f.adapter.activate(f.ctx, [employee.id]);
  const ctx = await f.project(employee);
  expect(f.adapter.dutyBinding(employee.id)).toEqual(f.adapter.caller(ctx));
  const ref = f.refs.get(ctx.agent.id);
  if (!ref?.sessionFile) throw new Error("Missing native transcript");
  writeFileSync(
    ref.sessionFile,
    JSON.stringify({
      type: "session",
      id: ctx.sessionManager.getSessionId(),
      parentSession: "/different/root",
    }) + "\n",
  );
  expect(() => f.adapter.dutyBinding(employee.id)).toThrow("another root");
});

test("native duty read admission is async-scoped, single-use and root source/lease fenced", async () => {
  for (const ending of ["success", "source", "lease"] as const) {
    const f = configuredFixture({ employeeLimit: null, executionLimit: null });
    const path: string = join(f.ctx.cwd, "health.json");
    const text: string = '{"healthy":true}\n';
    writeFileSync(path, text);
    const manager = f.adapter.store.managerBinding;
    f.adapter.duties.assign(manager, {
      id: "health",
      employeeId: "manager",
      target: path,
      probe: path,
      acceptance: { path: ["healthy"], equals: true },
      repairAuthority: {
        kind: "replace-json",
        payload: { healthy: true },
        verification: { path, acceptance: { path: ["healthy"], equals: true } },
      },
      cadenceMs: 1000,
      nextDue: Date.now() + 3600000,
    });
    f.adapter.duties.authorize(manager, { id: "saved", dutyId: "health" });
    const grant = f.adapter.store.acquireTarget({
      employee: manager,
      grantId: "saved-grant",
      authorizationId: "saved",
    });
    f.adapter.store.markTargetUncertain({
      employee: manager,
      grantId: grant.id,
      evidence: { interrupted: true },
    });
    const entered =
      Promise.withResolvers<
        Readonly<{ id: string; params: Record<string, unknown> }>
      >();
    const release = Promise.withResolvers<void>();
    const root = f.refs.get("Main");
    if (!root?.session) throw new Error("Fixture root absent");
    const originalLoop: string = readFileSync(
      join(f.root, "skills/startup-loop/SKILL.md"),
      "utf8",
    );
    f.refs.set("Main", {
      ...root,
      session: {
        ...root.session,
        getToolByName: () => ({
          execute: async (id, params) => {
            entered.resolve({ id, params });
            await release.promise;
            expect(
              f.adapter.admitDutyRead(
                { ...f.ctx, agent: { id: "other", kind: "main" } },
                "read",
                id,
                params,
              ),
            ).toBe(false);
            expect(
              f.adapter.admitDutyRead(
                { ...f.ctx, agent: { id: "Main", kind: "sub" } },
                "read",
                id,
                params,
              ),
            ).toBe(false);
            if (ending === "source")
              writeFileSync(
                join(f.root, "skills/startup-loop/SKILL.md"),
                "changed while native read awaited",
              );
            if (ending === "lease") f.adapter.store.close();
            expect(f.adapter.admitDutyRead(f.ctx, "read", id, params)).toBe(
              true,
            );
            expect(f.adapter.admitDutyRead(f.ctx, "read", id, params)).toBe(
              false,
            );
            return {
              content: [],
              details: {
                totalLines: 2,
                fileSize: Buffer.byteLength(text),
                displayContent: { text, startLine: 1, lineNumbers: [1, 2] },
                meta: {
                  source: {
                    type: "path",
                    value: z.string().parse(params.path).replace(/:raw$/, ""),
                  },
                },
              },
            };
          },
        }),
      },
    });
    const operation = f.adapter.duties.reconcile(manager, {
      grantId: grant.id,
      evidence: { observed: true },
    });
    const pending = await entered.promise;
    expect(
      f.adapter.admitDutyRead(f.ctx, "read", pending.id, pending.params),
    ).toBe(false);
    const diagnostic = spyOn(process.stderr, "write").mockImplementation(() => true);
    release.resolve();
    try {
      if (ending === "success")
        expect((await operation).state).toBe("released");
      else
        await expect(operation).rejects.toThrow(
          ending === "source" ? "source changed" : "closed",
        );
      expect(
        f.adapter.admitDutyRead(f.ctx, "read", pending.id, pending.params),
      ).toBe(false);
    } finally {
      const diagnostics = diagnostic.mock.calls.map((call) => String(call[0]));
      diagnostic.mockRestore();
      writeFileSync(join(f.root, "skills/startup-loop/SKILL.md"), originalLoop);
      expect(diagnostics).toHaveLength(ending === "success" ? 0 : 1);
      for (const line of diagnostics) expect(JSON.parse(line)).toMatchObject({ level: "warning", component: "startup-duty", operation: "saved-grant-reconcile", attempt: 1, error: ending === "source" ? "Canonical source changed for manager; explicit source reconciliation required" : "Cannot use a closed database" });
    }
  }
});


test("later profile preparation failure leaves all undispatched hires retryable", async () => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, { startup: "hire", requestId: "prepare", role: "devops", additional: 2 });
  const profile = loadProfile({ skillsRoot: f.root, role: "devops", employeeId: hire.employees[1]!.id, generation: 1 });
  const directory = join(f.ctx.cwd, ".omp", "agents");
  mkdirSync(directory, { recursive: true });
  const conflict = join(directory, `${profile.name}.md`);
  writeFileSync(conflict, "foreign profile");
  const ids = hire.employees.map((employee) => employee.id);
  await expect(f.adapter.activate(f.ctx, ids)).rejects.toThrow("ownership conflict");
  rmSync(conflict);
  const retried = await f.adapter.activate(f.ctx, ids);
  expect(z.object({ progress: z.array(z.unknown()) }).parse(retried.native?.details).progress).toHaveLength(2);
});

test("saved idle hire source update is rejected before team reservation and permits explicit refresh", async () => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, { startup: "hire", requestId: "saved-architect", role: "architect", additional: 1 });
  const employee = hire.employees[0]!;
  const path = join(f.root, "skills", "startup-role-architect", "SKILL.md");
  writeFileSync(path, readFileSync(path, "utf8") + "Updated canonical procedure.\n");
  f.adapter.recordIntake(f.ctx, { eventId: "source-preflight", input: "original event", amendItemIds: [] });
  const request = { startup: "delegate", eventId: "source-preflight", developers: 1 };
  await expect(f.adapter.delegate(f.ctx, request)).rejects.toThrow("Canonical role source");
  expect(f.adapter.store.snapshot().teams).toHaveLength(0);
  expect(f.adapter.store.snapshot().employees.find((entry) => entry.id === employee.id)?.assignment).toBeNull();
  f.adapter.refresh(f.ctx, { employeeId: employee.id, evidence: { source: "explicit refresh" } });
  const team = await f.adapter.delegate(f.ctx, request);
  expect(team.architect).toBe(employee.id);
  expect(team.eventId).toBe("source-preflight");
});

for (const failure of ["returned", "thrown"]) {
  test(`single activation preserves successful sibling before later ${failure} failure`, async () => {
    const f = fixture();
    f.setBatch(false);
    const hire = f.adapter.reserve(f.ctx, { startup: "hire", requestId: "single", role: "devops", additional: 3 });
    let calls = 0;
    const ctx: NativeContext = { ...f.ctx, invokeTool: async (params) => {
      calls += 1;
      if (calls === 2) {
        expect(f.adapter.store.snapshot().employees.find((entry) => entry.id === hire.employees[0]!.id)?.nativeHandle).toContain("child-1");
        if (failure === "thrown") throw new Error("native preflight refused");
        return { content: [], isError: true };
      }
      const result = await f.activate({ tasks: [params] });
      if (calls === 1) await f.project(hire.employees[0]!);
      return result;
    } };
    const ids = hire.employees.map((entry) => entry.id);
    if (failure === "thrown") await expect(f.adapter.activate(ctx, ids)).rejects.toThrow("native preflight refused");
    else await f.adapter.activate(ctx, ids);
    const sibling = f.adapter.store.snapshot().employees.find((entry) => entry.id === ids[0])!;
    expect(sibling.error).toBeNull();
    expect(sibling.nativeHandle).toContain("child-1");
    const retryAgents: unknown[] = [];
    await f.adapter.activate({ ...ctx, invokeTool: async (params) => { retryAgents.push(params.agent); return f.activate({ tasks: [params] }); } }, ids);
    expect(retryAgents).toHaveLength(failure === "thrown" ? 2 : 1);
    expect(f.adapter.store.snapshot().employees.find((entry) => entry.id === ids[0])?.nativeHandle).toBe(sibling.nativeHandle);
  });
}

for (const projected of [true, false]) {
  test(`native synchronous results require actual source receipt projected=${projected}`, async () => {
    const f = fixture();
    const hire = f.adapter.reserve(f.ctx, { startup: "hire", requestId: "sync", role: "devops", additional: 1 });
    const employee = hire.employees[0]!;
    const ctx: NativeContext = { ...f.ctx, invokeTool: async (params) => {
      const result = await f.activate(params);
      const progress = z.object({ progress: z.array(z.object({ index: z.number(), id: z.string(), agent: z.string(), assignment: z.string() })) }).parse(result.details).progress;
      if (projected) await f.project(employee);
      return { content: [], details: { results: progress.map((row) => ({ ...row, exitCode: 0, aborted: false })) } };
    } };
    await f.adapter.activate(ctx, [employee.id]);
    const current = f.adapter.store.snapshot().employees.find((entry) => entry.id === employee.id)!;
    if (projected) { expect(current.error).toBeNull(); expect(current.nativeHandle).toContain("child-1"); }
    else { expect(current.nativeHandle).toBeNull(); expect(current.error).toContain("without verified source binding"); }
    expect(f.adapter.capacity().reserved).toBe(0);
  });
}

test("manager discovers interrupted child claim and pending delivery IDs without task bodies", async () => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, { startup: "hire", requestId: "recovery-public", role: "devops", additional: 1 });
  await f.adapter.activate(f.ctx, [hire.employees[0]!.id]);
  const child = await f.project(hire.employees[0]!);
  await f.adapter.send(f.ctx, { id: "public-active", recipient: hire.employees[0]!.id, kind: "assignment", correlation: "public", payload: "PRIVATE_TASK_BODY" });
  const claim = f.adapter.claim(child)!;
  await f.adapter.send(f.ctx, { id: "public-pending", recipient: hire.employees[0]!.id, kind: "assignment", correlation: "public", payload: "PRIVATE_TASK_BODY" });
  const bound = f.adapter.store.snapshot().employees.find((employee) => employee.id === hire.employees[0]!.id)!;
  f.adapter.store.importResources({ manager: f.adapter.store.managerBinding });
  f.adapter.store.authorizeTarget({ manager: f.adapter.store.managerBinding, authorization: { id: "public-authority", employeeId: bound.id, target: "fixture-target", authority: "PRIVATE_AUTHORITY" } });
  f.adapter.store.acquireTarget({ employee: { employeeId: bound.id, generation: bound.generation, nativeHandle: bound.nativeHandle! }, grantId: "public-grant", authorizationId: "public-authority" });
  f.adapter.nativeEnded(child.agent.id, "aborted");
  const recovery = z.object({ recovery: z.object({ claims: z.array(z.object({ id: z.string(), messageId: z.string(), status: z.string() })), assignments: z.array(z.object({ id: z.string() })), pendingMessages: z.array(z.object({ id: z.string() })) }) }).parse(f.adapter.staff(f.ctx)).recovery;
  expect(recovery.claims).toContainEqual(expect.objectContaining({ id: claim.claim.id, messageId: "public-active", status: "reconciliation" }));
  expect(recovery.assignments).toContainEqual(expect.objectContaining({ id: "public-active" }));
  expect(recovery.pendingMessages).toContainEqual(expect.objectContaining({ id: "public-pending" }));
  expect(JSON.stringify(recovery)).not.toContain("PRIVATE_TASK_BODY");
  const alert = f.adapter.store.snapshot().messages.find((message) => message.kind === "alert")!;
  expect(alert.payload).toMatchObject({ claimIds: [claim.claim.id], messageIds: ["public-active"] });
  const grants = z.object({ recovery: z.object({ grants: z.array(z.object({ id: z.string(), state: z.string() })) }) }).parse(f.adapter.staff(f.ctx)).recovery.grants;
  expect(grants).toContainEqual({ id: "public-grant", state: "reconciliation" });
  expect(JSON.stringify(f.adapter.staff(f.ctx).recovery)).not.toContain("PRIVATE_AUTHORITY");
  expect(() => f.adapter.staff(child)).toThrow();
});

for (const phase of ["before-rename", "after-rename"]) {
  for (const retry of ["identical", "conflicting", "different"]) {
    test(`same live item journal ${phase} preserves ${retry} retry`, async () => {
      const f = fixture();
      const { team, contexts } = await capturedTeam(f, "live-journal", ["live-one", "live-two"]);
      const architect = contexts.get(team.architect)!;
      const state = join(f.root, "home/startup/fixture");
      const db = new Database(join(state, "staff.sqlite"));
      const token = z.object({ token: z.string() }).parse(db.query("SELECT token FROM lease").get()).token;
      const pendingPath = join(state, `queue.json.${token}.pending`);
      if (phase === "before-rename") mkdirSync(pendingPath);
      else db.run("CREATE TRIGGER fixture_finalize_failure BEFORE UPDATE ON records WHEN NEW.kind='intent' AND json_extract(NEW.payload,'$.state')='complete' BEGIN SELECT RAISE(ABORT,'fixture finalization failure'); END");
      const request: ItemAction = { action: "assign", requestId: "live-original", itemId: "live-one", expectedRevision: 1, employeeId: team.devs[0]!, evidence: { original: true } };
      await expect(f.adapter.item(architect, request)).rejects.toThrow();
      const readIntent = () => z.object({ payload: z.string() }).parse(db.query("SELECT payload FROM records WHERE kind='intent' AND id='item/live-original'").get()).payload;
      const original = readIntent();
      await expect(f.adapter.item(architect, { ...request, evidence: { conflicting: true } })).rejects.toThrow();
      expect(readIntent()).toBe(original);
      if (phase === "before-rename") rmSync(pendingPath, { recursive: true });
      else db.run("DROP TRIGGER fixture_finalize_failure");
      if (retry === "identical") expect((await f.adapter.item(architect, request)).request).toEqual(request);
      else if (retry === "conflicting") await expect(f.adapter.item(architect, { ...request, evidence: { conflicting: true } })).rejects.toThrow("conflicts with its saved payload");
      else await f.adapter.item(f.ctx, { action: "decide", requestId: "live-next", itemId: "live-two", expectedRevision: 1, status: "NEEDS_DECISION", evidence: { input: "awaited" } });
      const snapshot = f.adapter.store.snapshot();
      expect(snapshot.itemTransitions.find((entry) => entry.request.requestId === "live-original")?.request).toEqual(request);
      expect(JSON.parse(readIntent()).state).toBe("complete");
      expect(snapshot.queueRevisions.find((entry) => entry.id === "live-one")?.revision).toBe(2);
      db.close();
    });
  }
}

test("public recovery pages stay bounded and contain only metadata", () => {
  const f = fixture();
  for (let index = 0; index < 65; index += 1)
    f.adapter.store.sendCue({ sender: f.adapter.store.managerBinding, cue: { id: `paged-${index}`, recipient: "manager", kind: "report", correlation: "bounded", payload: "PRIVATE_BODY" } });
  const first = f.adapter.staff(f.ctx).recovery;
  expect(first.pendingMessages).toHaveLength(64);
  expect(first.nextOffset).toBe(64);
  expect(first.counts.pendingMessages).toBe(65);
  const second = f.adapter.staff(f.ctx, first.nextOffset!).recovery;
  expect(second.pendingMessages).toHaveLength(1);
  expect(second.nextOffset).toBeNull();
  expect(new Set([...first.pendingMessages, ...second.pendingMessages].map((message) => message.id)).size).toBe(65);
  expect(JSON.stringify(first)).not.toContain("PRIVATE_BODY");
  expect(() => f.adapter.staff(f.ctx, -1)).toThrow();
});

test("failed preparation preserves a legitimate earlier in-flight activation", async () => {
  const f = fixture();
  const hire = f.adapter.reserve(f.ctx, { startup: "hire", requestId: "in-flight", role: "devops", additional: 3 });
  await f.adapter.activate(f.ctx, [hire.employees[0]!.id]);
  const profile = loadProfile({ skillsRoot: f.root, role: "devops", employeeId: hire.employees[2]!.id, generation: 1 });
  const conflict = join(f.ctx.cwd, ".omp/agents", profile.name + ".md");
  writeFileSync(conflict, "Owned fixture conflict");
  const ids = hire.employees.map((employee) => employee.id);
  await expect(f.adapter.activate(f.ctx, ids)).rejects.toThrow("ownership conflict");
  rmSync(conflict);
  const retried = await f.adapter.activate(f.ctx, ids);
  const progress = z.object({ progress: z.array(z.object({ id: z.string() })) }).parse(retried.native?.details).progress;
  expect(progress.map((entry) => entry.id)).toEqual(["child-2", "child-3"]);
  await f.project(hire.employees[0]!);
  expect(f.adapter.store.snapshot().employees.find((entry) => entry.id === ids[0])?.nativeHandle).toContain("child-1");
});


test("legacy native manager wake, projection and wait guard share deferred inbox delivery", async () => {
  const f = fixture();
  await f.adapter.send(f.ctx, { id: "deferred-manager-observation", recipient: "manager", kind: "alert", correlation: "old-runtime", payload: { kind: "runtime-observation", state: "idle" } });
  expect(f.managerNotifications).toEqual([]);
  expect(f.adapter.waitGuard()).toBeNull();
  expect(await f.adapter.projection(f.ctx)).toContain("STARTUP_CUE=null");
  expect(f.adapter.store.snapshot().messages.find((m) => m.id === "deferred-manager-observation")?.status).toBe("pending");
});
