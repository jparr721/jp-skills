import { afterEach, expect, test } from "bun:test";
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
import type { Employee } from "../src/contracts";
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

  const wake = async (
    _id: string,
    params: Record<string, unknown>,
  ): Promise<NativeResult> => ({
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
  });
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
  const adapter = createAdapter({
    ctx,
    registry: {
      get: (id) => refs.get(id),
      list: () => [...refs.values()],
      onChange: () => () => {},
    },
    config: {
      name: "fixture",
      home,
      skillsRoot: root,
      employeeLimit: limits.employeeLimit,
      executionLimit: limits.executionLimit,
      leaseMs: 60000,
    },
    nativeLimit: () => 32,
    nativeBatch: () => true,
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
  return { adapter, ctx, refs, root, activate, project, managerNotifications };
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
