import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type StartupStore } from "../src/store";
import { StoreConflictError } from "../src/contracts";

const roots: string[] = [];
afterEach((): void => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root: string = realpathSync(mkdtempSync(join(tmpdir(), "startup-store-")));
  roots.push(root);
  const home: string = join(root, "home");
  const startupRoot: string = join(home, "startup", "test");
  const boundRoot: string = join(root, "repo");
  mkdirSync(home);
  mkdirSync(boundRoot);
  const scope = {
    skillsHome: home,
    startupRoot,
    boundRoot,
    host: "host",
    name: "test",
    managerSession: "native-manager",
  };
  const owner = { id: "owner", managerGeneration: 1, leaseMs: 1000 };
  const path: string = join(startupRoot, "staff.sqlite");
  const store = openStore({ path, scope, owner, now: (): number => 100 });
  store.bindEmployee({
    manager: store.managerBinding,
    binding: {
      ...store.managerBinding,
      assignment: null,
      source: source("manager"),
    },
  });
  const user = { kind: "user", acceptedEventId: "accepted" } as const;
  return { root, home, startupRoot, scope, owner, path, store, user };
}

test("hire requests are additive, immutable and survive reopening", (): void => {
  const f = fixture();
  const request = {
    requestId: "hire-1",
    role: "devops",
    additional: 6,
    revision: "rev",
  } as const;
  const first = f.store.reserveHire({ authority: f.user, request });
  expect(first.reserved).toBe(6);
  expect(first.ready).toBe(0);
  expect(f.store.reserveHire({ authority: f.user, request })).toEqual(first);
  expect(() =>
    f.store.reserveHire({
      authority: f.user,
      request: { ...request, additional: 7 },
    }),
  ).toThrow();
  f.store.reserveHire({
    authority: f.user,
    request: { ...request, requestId: "hire-2" },
  });
  expect(f.store.snapshot().employees).toHaveLength(13);
  f.store.close();
  const reopened = openStore({
    path: f.path,
    scope: f.scope,
    owner: f.owner,
    now: (): number => 101,
  });
  expect(reopened.snapshot().employees).toHaveLength(13);
  reopened.close();
});

function source(role: string) {
  return {
    rolePath: `/skills/jp-startup-role-${role}/SKILL.md`,
    roleRevision: "rev",
    loopPath: "/skills/jp-startup-loop/SKILL.md",
    loopRevision: "loop-rev",
  };
}
function hire(
  f: ReturnType<typeof fixture>,
  role: "dev" | "qa" | "architect" | "devops" | "pa",
  requestId: string,
  additional: number,
): readonly string[] {
  return f.store
    .reserveHire({
      authority: f.user,
      request: { requestId, role, additional, revision: "rev" },
    })
    .employees.map((employee): string => employee.id);
}
function first(ids: readonly string[]): string {
  const id: string | undefined = ids[0];
  if (id === undefined) throw new Error("Fixture has no employee");
  return id;
}
function bind(
  f: ReturnType<typeof fixture>,
  id: string,
  role: string,
  generation: number,
  assignment: string | null,
) {
  const nativeHandle: string = `native-${id}-${generation}`;
  f.store.bindEmployee({
    manager: f.store.managerBinding,
    binding: {
      employeeId: id,
      generation,
      nativeHandle,
      source: source(role),
      assignment,
    },
  });
  return { employeeId: id, generation, nativeHandle };
}
function reserved(
  f: ReturnType<typeof fixture>,
  eventId: string,
  amendItemIds: readonly string[],
) {
  const architect: string = first(
    hire(f, "architect", `architect-${eventId}`, 1),
  );
  const qa: string = first(hire(f, "qa", `qa-${eventId}`, 1));
  const dev: string = first(hire(f, "dev", `dev-${eventId}`, 1));
  f.store.recordIntake({
    manager: f.store.managerBinding,
    event: { eventId, input: "request", amendItemIds },
  });
  const request = {
    eventId,
    architect,
    qa,
    devs: [dev],
    cues: [architect, qa, dev].map((recipient) => ({
      id: `assignment-${eventId}-${recipient}`,
      recipient,
      kind: "assignment" as const,
      correlation: eventId,
      payload: { request: "request" },
    })),
  };
  const team = f.store.reserveTeam({
    manager: f.store.managerBinding,
    request,
  });
  return { team, request, architect, qa, dev };
}
function active(
  f: ReturnType<typeof fixture>,
  eventId: string,
  amendItemIds: readonly string[],
) {
  const t = reserved(f, eventId, amendItemIds);
  return {
    ...t,
    architectBinding: bind(f, t.architect, "architect", 1, t.team.id),
    qaBinding: bind(f, t.qa, "qa", 1, t.team.id),
    devBinding: bind(f, t.dev, "dev", 1, t.team.id),
  };
}
function cue(
  id: string,
  recipient: string,
  kind: "assignment" | "report" | "question" | "answer",
) {
  return { id, recipient, kind, correlation: "work", payload: "request" };
}
function completed(id: string) {
  return {
    id,
    kind: "completed" as const,
    output: "done",
    checkpoint: null,
    outgoing: [],
  };
}

test("all team members and cues are reserved atomically with partial readiness visible", (): void => {
  const f = fixture();
  const t = reserved(f, "event-1", []);
  expect(f.store.snapshot().teams[0]?.state).toBe("reserved");
  expect(f.store.snapshot().messages).toHaveLength(3);
  expect(
    f.store.reserveTeam({ manager: f.store.managerBinding, request: t.request })
      .id,
  ).toBe(t.team.id);
  const architect = bind(f, t.architect, "architect", 1, t.team.id);
  expect(f.store.claimNext({ employee: architect })).toBeNull();
  bind(f, t.qa, "qa", 1, t.team.id);
  f.store.recordBindingFailure({
    manager: f.store.managerBinding,
    employeeId: t.dev,
    error: "Native admission failed",
  });
  expect(f.store.snapshot().teams[0]?.state).toBe("reserved");
  bind(f, t.dev, "dev", 1, t.team.id);
  expect(f.store.snapshot().teams[0]?.state).toBe("ready");
  expect(f.store.claimNext({ employee: architect })?.message.id).toBe(
    t.request.cues[0]?.id,
  );
  const t2 = reserved(f, "event-2", []);
  expect(t2.team.id).not.toBe(t.team.id);
  expect(
    new Set([t.architect, t.qa, t.dev, t2.architect, t2.qa, t2.dev]).size,
  ).toBe(6);
  f.store.recordIntake({
    manager: f.store.managerBinding,
    event: { eventId: "event-3", input: "request", amendItemIds: [] },
  });
  const before = f.store.snapshot();
  expect(() =>
    f.store.reserveTeam({
      manager: f.store.managerBinding,
      request: { ...t.request, eventId: "event-3" },
    }),
  ).toThrow();
  expect(f.store.snapshot()).toEqual(before);
  f.store.close();
});

test("wrong roles, duplicate members and conflicting cue IDs cannot partially reserve a team", (): void => {
  const f = fixture();
  const t = reserved(f, "first", []);
  const a: string = first(hire(f, "architect", "a2", 1));
  const q: string = first(hire(f, "qa", "q2", 1));
  const d: string = first(hire(f, "dev", "d2", 1));
  f.store.recordIntake({
    manager: f.store.managerBinding,
    event: { eventId: "second", input: "request", amendItemIds: [] },
  });
  const request = {
    eventId: "second",
    architect: a,
    qa: q,
    devs: [d],
    cues: [a, q, d].map((recipient) => ({
      ...cue(`new-${recipient}`, recipient, "assignment"),
      correlation: "second",
    })),
  };
  expect(() =>
    f.store.reserveTeam({
      manager: f.store.managerBinding,
      request: { ...request, qa: d },
    }),
  ).toThrow();
  expect(() =>
    f.store.reserveTeam({
      manager: f.store.managerBinding,
      request: { ...request, devs: [q] },
    }),
  ).toThrow();
  expect(() =>
    f.store.reserveTeam({
      manager: f.store.managerBinding,
      request: { ...request, cues: [] },
    }),
  ).toThrow();
  const existing = t.request.cues[0];
  if (existing === undefined) throw new Error("No fixture cue");
  expect(() =>
    f.store.reserveTeam({
      manager: f.store.managerBinding,
      request: {
        ...request,
        cues: request.cues.map((value, index) =>
          index === 2 ? { ...value, id: existing.id } : value,
        ),
      },
    }),
  ).toThrow();
  expect(f.store.snapshot().teams).toHaveLength(1);
  expect(
    f.store.snapshot().employees.find((value): boolean => value.id === a)
      ?.assignment,
  ).toBeNull();
  f.store.close();
});

test("staff cannot hire, impersonate another generation, capture intake or bypass leader routing", (): void => {
  const f = fixture();
  const t = active(f, "event", []);
  expect(() =>
    f.store.reserveHire({
      authority: { kind: "employee", binding: t.devBinding },
      request: {
        role: "devops",
        additional: 1,
        revision: "rev",
        requestId: "denied",
      },
    }),
  ).toThrow();
  expect(() =>
    f.store.sendCue({
      sender: t.devBinding,
      cue: cue("direct", "manager", "report"),
    }),
  ).toThrow();
  expect(() =>
    f.store.sendCue({
      sender: t.architectBinding,
      cue: cue("wrong", t.qa, "report"),
    }),
  ).toThrow();
  expect(
    f.store.sendCue({
      sender: t.devBinding,
      cue: cue("leader", t.architect, "report"),
    }).recipient,
  ).toBe(t.architect);
  expect(
    f.store.sendCue({
      sender: t.architectBinding,
      cue: cue("manager", "manager", "report"),
    }).recipient,
  ).toBe("manager");
  expect(() =>
    f.store.claimNext({ employee: { ...t.devBinding, generation: 0 } }),
  ).toThrow();
  const capture = {
    captureId: "capture",
    eventId: "event",
    rows: [],
    receipt: "empty intake",
  };
  expect(() =>
    f.store.captureIntake({ architect: f.store.managerBinding, capture }),
  ).toThrow();
  expect(() =>
    f.store.captureIntake({ architect: t.devBinding, capture }),
  ).toThrow();
  f.store.close();
});

test("settlement is atomic and idempotent; questions acknowledge mail but retain waiting assignment", (): void => {
  const f = fixture();
  const t = active(f, "event", []);
  const next = f.store.claimNext({ employee: t.architectBinding });
  if (next === null) throw new Error("No assignment");
  expect(() =>
    f.store.settleClaim({
      employee: t.architectBinding,
      claimId: next.claim.id,
      result: {
        ...completed("invalid"),
        outgoing: [cue("bad", t.qa, "report")],
      },
    }),
  ).toThrow();
  expect(f.store.snapshot().results).toHaveLength(0);
  expect(f.store.snapshot().claims[0]?.status).toBe("active");
  const question = {
    id: "result-question",
    kind: "question" as const,
    output: "Need decision",
    checkpoint: { pending: true },
    outgoing: [cue("question", "manager", "question")],
  };
  const result = f.store.settleClaim({
    employee: t.architectBinding,
    claimId: next.claim.id,
    result: question,
  });
  expect(
    f.store.settleClaim({
      employee: t.architectBinding,
      claimId: next.claim.id,
      result: question,
    }),
  ).toEqual(result);
  expect(
    f.store
      .snapshot()
      .messages.find((value): boolean => value.id === next.message.id)?.status,
  ).toBe("acknowledged");
  expect(
    f.store
      .snapshot()
      .assignments.find((value): boolean => value.id === next.message.id)
      ?.state,
  ).toBe("waiting");
  expect(() =>
    f.store.settleClaim({
      employee: t.architectBinding,
      claimId: next.claim.id,
      result: { ...question, output: "different" },
    }),
  ).toThrow();
  expect(() =>
    f.store.finishTeam({
      manager: f.store.managerBinding,
      teamId: t.team.id,
      evidence: "done",
    }),
  ).toThrow();
  f.store.close();
});

test("a member's team reservation notice settles complete for every result kind while the architect intake can wait", (): void => {
  const f = fixture();
  const t = active(f, "notice", []);
  const settle = (binding: typeof t.devBinding, kind: "question" | "uncertain", recipient: string): string => {
    const next = f.store.claimNext({ employee: binding });
    if (next === null) throw new Error("No reservation cue");
    f.store.settleClaim({ employee: binding, claimId: next.claim.id, result: { id: `notice-${binding.employeeId}`, kind, output: "no item yet", checkpoint: null, outgoing: kind === "question" ? [cue(`ask-${binding.employeeId}`, recipient, "question")] : [] } });
    if (kind === "uncertain") f.store.reconcileClaim({ manager: f.store.managerBinding, claimId: next.claim.id, evidence: "no side effects" });
    return next.message.id;
  };
  const state = (id: string): string | undefined => f.store.snapshot().assignments.find((value): boolean => value.id === id)?.state;
  expect(state(settle(t.devBinding, "question", t.architect))).toBe("complete");
  expect(state(settle(t.qaBinding, "uncertain", t.architect))).toBe("complete");
  expect(state(settle(t.architectBinding, "question", "manager"))).toBe("waiting");
  f.store.close();
});

test("finished crew staff can retire with history preserved while active crews and supervisors remain protected", (): void => {
  const f = fixture();
  const t = active(f, "retire-finished", []);
  const ids = [t.architectBinding.employeeId, t.qaBinding.employeeId, t.devBinding.employeeId];
  expect(() => f.store.retireEmployees({ manager: f.store.managerBinding, employeeIds: ids, evidence: "idle panes" })).toThrow();
  f.store.captureIntake({ architect: t.architectBinding, capture: { captureId: "retire-capture", eventId: "retire-finished", rows: [], receipt: "All intake dispositioned" } });
  for (const binding of [t.architectBinding, t.qaBinding, t.devBinding]) {
    const claimed = f.store.claimNext({ employee: binding });
    if (!claimed) throw new Error("Missing assignment");
    f.store.settleClaim({ employee: binding, claimId: claimed.claim.id, result: completed(`complete-${binding.employeeId}`) });
  }
  f.store.finishTeam({ manager: f.store.managerBinding, teamId: t.team.id, evidence: "Canonical work and mail complete" });
  const before = f.store.snapshot();
  expect(f.store.retireEmployees({ manager: f.store.managerBinding, employeeIds: ids, evidence: "Finished crew cleanup" }).map((e) => e.employment)).toEqual(["retired", "retired", "retired"]);
  const after = f.store.snapshot();
  expect(after.claims).toEqual(before.claims);
  expect(after.results).toEqual(before.results);
  expect(after.messages).toEqual(before.messages);
  expect(after.teams).toEqual(before.teams);
  expect(() => f.store.retireEmployees({ manager: f.store.managerBinding, employeeIds: ["manager"], evidence: "cleanup" })).toThrow();
  f.store.close();
});

test("uncertain mutations require explicit reconciliation and never requeue automatically", (): void => {
  const f = fixture();
  const id = first(hire(f, "devops", "hire", 1));
  const binding = bind(f, id, "devops", 1, null);
  f.store.sendCue({
    sender: f.store.managerBinding,
    cue: cue("assign", id, "assignment"),
  });
  const next = f.store.claimNext({ employee: binding });
  if (next === null) throw new Error("No assignment");
  f.store.settleClaim({
    employee: binding,
    claimId: next.claim.id,
    result: {
      ...completed("uncertain"),
      kind: "uncertain",
      output: "Unknown deploy result",
    },
  });
  expect(() => f.store.claimNext({ employee: binding })).toThrow();
  expect(() =>
    f.store.retireEmployees({
      manager: f.store.managerBinding,
      employeeIds: [id],
      evidence: "idle",
    }),
  ).toThrow();
  f.store.reconcileClaim({
    manager: f.store.managerBinding,
    claimId: next.claim.id,
    evidence: "Verified operation applied once",
  });
  expect(f.store.claimNext({ employee: binding })).toBeNull();
  f.store.resolveAssignment({
    manager: f.store.managerBinding,
    assignmentId: "assign",
    evidence: "Verified complete",
  });
  expect(
    f.store.retireEmployees({
      manager: f.store.managerBinding,
      employeeIds: [id],
      evidence: "idle",
    })[0]?.employment,
  ).toBe("retired");
  expect(f.store.snapshot().results).toHaveLength(1);
  f.store.close();
});

test("one live owner and scoped database; expired owners and native generations are fenced", (): void => {
  const f = fixture();
  expect(() =>
    openStore({
      path: f.path,
      scope: f.scope,
      owner: f.owner,
      now: (): number => 100,
    }),
  ).toThrow();
  expect(() =>
    openStore({
      path: f.path,
      scope: { ...f.scope, host: "other-host" },
      owner: f.owner,
      now: (): number => 2000,
    }),
  ).toThrow();
  const next = openStore({
    path: f.path,
    scope: f.scope,
    owner: { ...f.owner, id: "replacement", managerGeneration: 2 },
    now: (): number => 2000,
  });
  expect(() =>
    f.store.reserveHire({
      authority: f.user,
      request: {
        role: "devops",
        additional: 1,
        revision: "rev",
        requestId: "stale",
      },
    }),
  ).toThrow();
  expect(() =>
    next.recordIntake({
      manager: f.store.managerBinding,
      event: { eventId: "bad", input: "stale manager", amendItemIds: [] },
    }),
  ).toThrow();
  f.store.close();
  next.recordIntake({
    manager: next.managerBinding,
    event: { eventId: "valid", input: "request", amendItemIds: [] },
  });
  next.close();
});

test("SQLite and its sidecars stay under the canonical Startup root and preserve skills-home identity", (): void => {
  const f = fixture();
  f.store.close();
  const linkedRoot = join(f.root, "linked-startup");
  symlinkSync(f.startupRoot, linkedRoot);
  expect(() => openStore({ path: join(linkedRoot, "staff.sqlite"), scope: { ...f.scope, startupRoot: linkedRoot }, owner: f.owner, now: () => 2000 })).toThrow("symlink");
  const foreign = join(f.root, "foreign.sqlite-wal");
  writeFileSync(foreign, "foreign");
  rmSync(`${f.path}-wal`, { force: true });
  symlinkSync(foreign, `${f.path}-wal`);
  expect(() => openStore({ path: f.path, scope: f.scope, owner: { ...f.owner, id: "replacement" }, now: () => 2000 })).toThrow("symlink");
});

test("crashed active claims survive as reconciliation without duplicate delivery", (): void => {
  const f = fixture();
  const id = first(hire(f, "devops", "hire", 1));
  const binding = bind(f, id, "devops", 1, null);
  f.store.sendCue({
    sender: f.store.managerBinding,
    cue: cue("assign", id, "assignment"),
  });
  const next = f.store.claimNext({ employee: binding });
  if (next === null) throw new Error("No assignment");
  const reopened = openStore({
    path: f.path,
    scope: f.scope,
    owner: f.owner,
    now: (): number => 2000,
  });
  expect(reopened.snapshot().claims[0]?.status).toBe("reconciliation");
  expect(() =>
    reopened.settleClaim({
      employee: binding,
      claimId: next.claim.id,
      result: completed("late"),
    }),
  ).toThrow();
  expect(() => reopened.claimNext({ employee: binding })).toThrow();
  f.store.close();
  reopened.close();
});

function fields(request: string) {
  return {
    request,
    acceptance: "Acceptance",
    blocked_on: null,
    status: "QUEUED",
    unusual: { preserved: true },
  };
}
function queuePath(f: ReturnType<typeof fixture>): string {
  return join(f.startupRoot, "queue.json");
}

test("workflow reviews use an owned settled reviewer claim and enforce the manager budget", (): void => {
  const f = fixture();
  const t = active(f, "review-event", []);
  f.store.captureIntake({ architect: t.architectBinding, capture: {
    captureId: "review-capture", eventId: "review-event",
    rows: [{ id: "review-item", expectedRevision: null, fields: fields("Review this change") }], receipt: "captured",
  } });
  for (const binding of [t.architectBinding, t.qaBinding, t.devBinding]) {
    const notice = f.store.claimNext({ employee: binding });
    if (!notice) throw new Error("Missing readiness notice");
    f.store.settleClaim({ employee: binding, claimId: notice.claim.id, result: completed(`notice-${binding.employeeId}`) });
  }
  const request = { action: "reserve", changeId: "review-item", reservationId: "review-1", head: "commit-one", limit: 1, reviewerId: t.qa } as const;
  expect(() => f.store.workflowReview({ employee: t.architectBinding, request })).toThrow();
  const reservedReview = f.store.workflowReview({ employee: f.store.managerBinding, request });
  expect(reservedReview.state).toBe("active");
  expect(f.store.workflowReview({ employee: f.store.managerBinding, request })).toEqual(reservedReview);
  expect(() => f.store.workflowReview({ employee: f.store.managerBinding, request: { action: "settle", reservationId: "review-1", resultId: "missing" } })).toThrow();
  const claim = f.store.claimNext({ employee: t.qaBinding });
  if (!claim) throw new Error("Missing review assignment");
  expect(claim.message.id).toBe("workflow-review-review-1");
  f.store.settleClaim({ employee: t.qaBinding, claimId: claim.claim.id, result: {
    ...completed("review-result"), output: { kind: "workflow-review", reservationId: "review-1", head: "commit-one", verdict: "changes-requested" },
  } });
  expect(f.store.workflowReview({ employee: t.architectBinding, request: { action: "settle", reservationId: "review-1", resultId: "review-result" } }).verdict).toBe("changes-requested");
  expect(() => f.store.workflowReview({ employee: f.store.managerBinding, request: { ...request, reservationId: "review-2", head: "commit-two" } })).toThrow();
  f.store.close();
});

test("workflow review finalizer projects strict core from extensible result output", (): void => {
  function setup(eventId: string) {
    const f = fixture();
    const t = active(f, eventId, []);
    f.store.captureIntake({ architect: t.architectBinding, capture: {
      captureId: `review-receipt-capture-${eventId}`, eventId,
      rows: [{ id: "review-receipt-item", expectedRevision: null, fields: fields("Review this change") }], receipt: "captured",
    } });
    for (const binding of [t.architectBinding, t.qaBinding, t.devBinding]) {
      const notice = f.store.claimNext({ employee: binding });
      if (!notice) throw new Error("Missing readiness notice");
      f.store.settleClaim({ employee: binding, claimId: notice.claim.id, result: completed(`notice-${binding.employeeId}`) });
    }
    return { f, t };
  }
  function storedTriple(store: StartupStore, resultId: string, claimId: string, messageId: string) {
    const snapshot = store.snapshot();
    const resultRecord = snapshot.results.find((entry) => entry.result.id === resultId);
    const claimRecord = snapshot.claims.find((entry) => entry.id === claimId);
    const messageRecord = snapshot.messages.find((entry) => entry.id === messageId);
    if (resultRecord === undefined || claimRecord === undefined || messageRecord === undefined) throw new Error("Missing stored result/claim/message");
    return { resultRecord, claimRecord, messageRecord };
  }
  {
    const { f, t } = setup("review-receipt-match");
    f.store.workflowReview({ employee: f.store.managerBinding, request: { action: "reserve", changeId: "review-receipt-item", reservationId: "receipt-1", head: "commit-one", limit: 1, reviewerId: t.qa } });
    const claim = f.store.claimNext({ employee: t.qaBinding });
    if (!claim) throw new Error("Missing review assignment");
    expect(claim.message.id).toBe("workflow-review-receipt-1");
    f.store.settleClaim({ employee: t.qaBinding, claimId: claim.claim.id, result: {
      ...completed("receipt-result"), output: { kind: "workflow-review", reservationId: "receipt-1", head: "commit-one", verdict: "changes-requested", detail: "extra report metadata", evidence: { lines: 3 } },
    } });
    const before = storedTriple(f.store, "receipt-result", claim.claim.id, claim.message.id);
    expect(before.resultRecord.result.output).toMatchObject({ kind: "workflow-review", reservationId: "receipt-1", head: "commit-one", verdict: "changes-requested", detail: "extra report metadata", evidence: { lines: 3 } });
    const beforeResult = JSON.stringify(before.resultRecord);
    const beforeClaim = JSON.stringify(before.claimRecord);
    const beforeMessage = JSON.stringify(before.messageRecord);
    expect(f.store.workflowReview({ employee: t.architectBinding, request: { action: "settle", reservationId: "receipt-1", resultId: "receipt-result" } }).verdict).toBe("changes-requested");
    const after = storedTriple(f.store, "receipt-result", claim.claim.id, claim.message.id);
    expect(JSON.stringify(after.resultRecord)).toBe(beforeResult);
    expect(JSON.stringify(after.claimRecord)).toBe(beforeClaim);
    expect(JSON.stringify(after.messageRecord)).toBe(beforeMessage);
    f.store.close();
  }
  {
    const { f, t } = setup("review-receipt-wrong-res");
    f.store.workflowReview({ employee: f.store.managerBinding, request: { action: "reserve", changeId: "review-receipt-item", reservationId: "receipt-wrong-res", head: "commit-one", limit: 1, reviewerId: t.qa } });
    const claim = f.store.claimNext({ employee: t.qaBinding });
    if (!claim) throw new Error("Missing review assignment");
    f.store.settleClaim({ employee: t.qaBinding, claimId: claim.claim.id, result: {
      ...completed("receipt-wrong-res"), output: { kind: "workflow-review", reservationId: "receipt-OTHER", head: "commit-one", verdict: "changes-requested", detail: "extra report metadata", evidence: { lines: 3 } },
    } });
    const before = storedTriple(f.store, "receipt-wrong-res", claim.claim.id, claim.message.id);
    expect(before.resultRecord.result.output).toMatchObject({ reservationId: "receipt-OTHER", head: "commit-one", detail: "extra report metadata", evidence: { lines: 3 } });
    const beforeResult = JSON.stringify(before.resultRecord);
    const beforeClaim = JSON.stringify(before.claimRecord);
    const beforeMessage = JSON.stringify(before.messageRecord);
    try {
      f.store.workflowReview({ employee: t.architectBinding, request: { action: "settle", reservationId: "receipt-wrong-res", resultId: "receipt-wrong-res" } });
      throw new Error("Expected StoreConflictError for wrong reservation");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreConflictError);
    }
    const after = storedTriple(f.store, "receipt-wrong-res", claim.claim.id, claim.message.id);
    expect(JSON.stringify(after.resultRecord)).toBe(beforeResult);
    expect(JSON.stringify(after.claimRecord)).toBe(beforeClaim);
    expect(JSON.stringify(after.messageRecord)).toBe(beforeMessage);
    f.store.close();
  }
  {
    const { f, t } = setup("review-receipt-wrong-head");
    f.store.workflowReview({ employee: f.store.managerBinding, request: { action: "reserve", changeId: "review-receipt-item", reservationId: "receipt-wrong-head", head: "commit-one", limit: 1, reviewerId: t.qa } });
    const claim = f.store.claimNext({ employee: t.qaBinding });
    if (!claim) throw new Error("Missing review assignment");
    f.store.settleClaim({ employee: t.qaBinding, claimId: claim.claim.id, result: {
      ...completed("receipt-wrong-head"), output: { kind: "workflow-review", reservationId: "receipt-wrong-head", head: "commit-OTHER", verdict: "changes-requested", detail: "extra report metadata", evidence: { lines: 3 } },
    } });
    const before = storedTriple(f.store, "receipt-wrong-head", claim.claim.id, claim.message.id);
    expect(before.resultRecord.result.output).toMatchObject({ reservationId: "receipt-wrong-head", head: "commit-OTHER", detail: "extra report metadata", evidence: { lines: 3 } });
    const beforeResult = JSON.stringify(before.resultRecord);
    const beforeClaim = JSON.stringify(before.claimRecord);
    const beforeMessage = JSON.stringify(before.messageRecord);
    try {
      f.store.workflowReview({ employee: t.architectBinding, request: { action: "settle", reservationId: "receipt-wrong-head", resultId: "receipt-wrong-head" } });
      throw new Error("Expected StoreConflictError for wrong head");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreConflictError);
    }
    const after = storedTriple(f.store, "receipt-wrong-head", claim.claim.id, claim.message.id);
    expect(JSON.stringify(after.resultRecord)).toBe(beforeResult);
    expect(JSON.stringify(after.claimRecord)).toBe(beforeClaim);
    expect(JSON.stringify(after.messageRecord)).toBe(beforeMessage);
    f.store.close();
  }
});

test.each(["code", "research"])("completion respects review scope for %s items", (kind: string): void => {
  const f = fixture();
  const t = active(f, `completion-${kind}`, []);
  f.store.captureIntake({ architect: t.architectBinding, capture: {
    captureId: `capture-${kind}`, eventId: `completion-${kind}`,
    rows: [{ id: `item-${kind}`, expectedRevision: null, fields: { ...fields("Work"), kind } }], receipt: "captured",
  } });
  for (const binding of [t.architectBinding, t.qaBinding, t.devBinding]) {
    const claim = f.store.claimNext({ employee: binding });
    if (!claim) throw new Error("Missing readiness assignment");
    f.store.settleClaim({ employee: binding, claimId: claim.claim.id, result: completed(`bootstrap-${binding.employeeId}`) });
  }
  const itemId = `item-${kind}`;
  f.store.transitionItem({ employee: t.architectBinding, request: { action: "assign", requestId: "assign", itemId, expectedRevision: 1, employeeId: t.dev, evidence: {} } });
  const devClaim = f.store.claimNext({ employee: t.devBinding });
  if (!devClaim) throw new Error("Missing dev assignment");
  expect(f.store.workflowContext({ employee: t.devBinding, itemId })).toMatchObject({ itemId, claimId: devClaim.claim.id, teamId: t.team.id, employeeId: t.dev });
  expect(() => f.store.workflowContext({ employee: t.qaBinding, itemId })).toThrow();
  f.store.setWorkflowLimit({ manager: f.store.managerBinding, itemId, limit: 2, target: "main" });
  const authority = f.store.createWorkflowAuthority({ employee: t.devBinding, itemId, claimId: devClaim.claim.id, workflow: "pipeline", limit: 2, launchKey: `launch-${kind}`, assertConnection: () => {} });
  expect(authority.view(authority.rootId).scope).toEqual({ kind: "bounded", itemIds: [itemId] });
  const child = authority.reserve(authority.rootId, itemId, "worker");
  expect(() => authority.reserve(authority.rootId, itemId, "worker")).toThrow();
  authority.settle(authority.rootId, child, "completed");
  expect(() => authority.reserve(authority.rootId, itemId, "worker")).toThrow();
  expect(() => authority.nest(authority.rootId, "hotfix", [itemId], 2)).toThrow();
  authority.launchState("accepted", { paneId: "pane" });
  expect(() => f.store.createWorkflowAuthority({ employee: t.devBinding, itemId, claimId: devClaim.claim.id, workflow: "pipeline", limit: 2, launchKey: `launch-${kind}`, assertConnection: () => {} })).toThrow();
  const factory = f.store.createFactoryAuthority({ manager: f.store.managerBinding, itemIds: [itemId], limit: 2, launchKey: `factory-${kind}`, assertConnection: () => {} });
  expect(factory.view(factory.rootId).scope).toEqual({ kind: "bounded", itemIds: [itemId] });
  expect(() => factory.reserve(factory.rootId, itemId, "before-plan")).toThrow();
  const planner = factory.reservePlan(factory.rootId);
  expect(() => factory.completePlan(factory.rootId, planner, { dependencies: { [itemId]: [] }, targets: { [itemId]: ["foreign"] } })).toThrow();
  factory.completePlan(factory.rootId, planner, { dependencies: { [itemId]: [] }, targets: { [itemId]: ["main"] } });
  expect(() => factory.nest(factory.rootId, "pipeline", ["foreign-item"], 2)).toThrow();
  const nested = factory.nest(factory.rootId, "pipeline", [itemId], 2);
  const factoryChild = factory.reserve(nested, itemId, "factory-worker");
  factory.settle(nested, factoryChild, "completed");
  expect(() => factory.reserve(nested, itemId, "factory-worker")).toThrow();
  factory.launchState("accepted", { paneId: "factory-pane" });
  expect(() => f.store.settleClaim({ employee: t.devBinding, claimId: devClaim.claim.id, result: completed("dev-result") })).toThrow();
  const itemHandoff = { itemId, worktree: f.scope.boundRoot, head: "a".repeat(40), prNumber: 123 };
  const handoff = { items: [itemHandoff] };
  expect(() => authority.finishRun(authority.rootId, handoff)).toThrow();
  const boundedNested = authority.nest(authority.rootId, "hotfix", [itemId], 1);
  const noProof = { itemId, role: "architect" } as const;
  for (const [host, scopeId, wrongScope] of [[authority, authority.rootId, boundedNested], [factory, nested, factory.rootId]] as const) {
    const reservation = host.reserve(scopeId, itemId, `invalid-architect-${scopeId}`, { kind: "architect", worktree: itemHandoff.worktree });
    expect(() => host.settleRoleWithoutProof(wrongScope, reservation, noProof)).toThrow();
    expect(() => host.settleRoleWithoutProof(scopeId, reservation, { ...noProof, itemId: "foreign" })).toThrow();
    expect(() => host.settleRoleWithoutProof(scopeId, reservation, { ...noProof, role: "dev" })).toThrow();
    const plain = host.reserve(scopeId, itemId, `plain-${scopeId}`);
    expect(() => host.settleRoleWithoutProof(scopeId, plain, noProof)).toThrow();
    host.settle(scopeId, plain, "failed");
    host.settleRoleWithoutProof(scopeId, reservation, noProof);
    expect(host.view(scopeId).reservations.find((entry) => entry.id === reservation)).toMatchObject({
      state: "completed", role: { kind: "architect", worktree: itemHandoff.worktree }, roleEvidence: "invalid",
    });
    expect(() => host.settleRoleWithoutProof(scopeId, reservation, noProof)).toThrow();
    expect(() => host.reserve(scopeId, itemId, `invalid-architect-${scopeId}`)).toThrow();
    const failed = host.reserve(scopeId, itemId, `failed-architect-${scopeId}`, { kind: "architect", worktree: itemHandoff.worktree });
    host.settle(scopeId, failed, "failed");
    expect(() => host.settleRoleWithoutProof(scopeId, failed, noProof)).toThrow();
  }
  for (const role of ["dev", "qa", "architect"] as const) {
    if (role === "architect") {
      expect(() => authority.finishRun(authority.rootId, handoff)).toThrow();
      expect(() => factory.readyItem(factory.rootId, itemId, itemHandoff)).toThrow();
      expect(() => factory.finishRun(factory.rootId, handoff)).toThrow();
    }
    const reservation = authority.reserve(authority.rootId, itemId, `pipeline-${role}`, { kind: role, worktree: itemHandoff.worktree });
    authority.settleRole(authority.rootId, reservation, { itemId, role, agentId: `pipeline-${role}`, head: itemHandoff.head, evidence: { verified: "yes" } });
    const factoryReservation = factory.reserve(nested, itemId, `factory-${role}`, { kind: role, worktree: itemHandoff.worktree });
    factory.settleRole(nested, factoryReservation, { itemId, role, agentId: `factory-${role}`, head: itemHandoff.head, evidence: { verified: "yes" } });
  }
  const laterBounded = authority.reserve(authority.rootId, itemId, "later-unproved", { kind: "architect", worktree: itemHandoff.worktree });
  authority.settleRoleWithoutProof(authority.rootId, laterBounded, noProof);
  const laterFactory = factory.reserve(nested, itemId, "factory-later-unproved", { kind: "architect", worktree: itemHandoff.worktree });
  factory.settleRoleWithoutProof(nested, laterFactory, noProof);
  authority.finishRun(authority.rootId, handoff);
  factory.readyItem(factory.rootId, itemId, { worktree: itemHandoff.worktree, head: itemHandoff.head, prNumber: itemHandoff.prNumber });
  factory.finishRun(factory.rootId, handoff);
  f.store.settleClaim({ employee: t.devBinding, claimId: devClaim.claim.id, result: completed("dev-result") });
  expect(() => f.store.workflowContext({ employee: t.devBinding, itemId })).toThrow();
  f.store.transitionItem({ employee: t.devBinding, request: { action: "review", requestId: "submit", itemId, expectedRevision: 2, resultId: "dev-result", evidence: {} } });
  f.store.transitionItem({ employee: t.architectBinding, request: { action: "qa_assign", requestId: "qa-assign", itemId, expectedRevision: 3, evidence: {} } });
  const qaClaim = f.store.claimNext({ employee: t.qaBinding });
  if (!qaClaim) throw new Error("Missing QA assignment");
  f.store.settleClaim({ employee: t.qaBinding, claimId: qaClaim.claim.id, result: completed("qa-result") });
  f.store.transitionItem({ employee: t.qaBinding, request: { action: "qa", requestId: "qa", itemId, expectedRevision: 4, resultId: "qa-result", verdict: "APPROVE", proof: "done" } });
  f.store.transitionItem({ employee: t.architectBinding, request: { action: "gate", requestId: "gate", itemId, expectedRevision: 5, verdict: "APPROVE", evidence: {} } });
  const completion = { action: "decide", requestId: "done", itemId, expectedRevision: 6, status: "DONE", evidence: {} } as const;
  if (kind === "code") {
    expect(() => f.store.transitionItem({ employee: f.store.managerBinding, request: completion })).toThrow();
    f.store.workflowReview({ employee: f.store.managerBinding, request: { action: "reserve", changeId: itemId, reservationId: "approval", head: "exact-head", limit: 2, reviewerId: t.qa } });
    const reviewClaim = f.store.claimNext({ employee: t.qaBinding });
    if (!reviewClaim) throw new Error("Missing formal review assignment");
    f.store.settleClaim({ employee: t.qaBinding, claimId: reviewClaim.claim.id, result: { ...completed("formal-result"), output: { kind: "workflow-review", reservationId: "approval", head: "exact-head", verdict: "approve" } } });
    f.store.workflowReview({ employee: f.store.managerBinding, request: { action: "settle", reservationId: "approval", resultId: "formal-result" } });
    expect(f.store.transitionItem({ employee: f.store.managerBinding, request: { ...completion, evidence: { reviewReservationId: "approval", head: "exact-head" } } }).status).toBe("DONE");
  } else {
    expect(f.store.transitionItem({ employee: f.store.managerBinding, request: completion }).status).toBe("DONE");
  }
  f.store.close();
});

test("factory freezes manager targets and waits for independently ready prerequisites", (): void => {
  const f = fixture();
  for (const name of ["first", "second"]) {
    const t = active(f, `event-${name}`, []);
    f.store.captureIntake({ architect: t.architectBinding, capture: {
      captureId: `capture-${name}`, eventId: `event-${name}`,
      rows: [{ id: name, expectedRevision: null, fields: { ...fields(name), kind: "code" } }], receipt: "captured",
    } });
    for (const binding of [t.architectBinding, t.qaBinding, t.devBinding]) {
      const notice = f.store.claimNext({ employee: binding });
      if (!notice) throw new Error("Missing readiness notice");
      f.store.settleClaim({ employee: binding, claimId: notice.claim.id, result: completed(`notice-${name}-${binding.employeeId}`) });
    }
    f.store.transitionItem({ employee: t.architectBinding, request: { action: "assign", requestId: `assign-${name}`, itemId: name, expectedRevision: 1, employeeId: t.dev, evidence: {} } });
    if (!f.store.claimNext({ employee: t.devBinding })) throw new Error("Missing item claim");
    f.store.setWorkflowLimit({ manager: f.store.managerBinding, itemId: name, limit: 2, target: name === "first" ? "main" : "release" });
  }
  const factory = f.store.createFactoryAuthority({ manager: f.store.managerBinding, itemIds: ["first", "second"], limit: 2, launchKey: "factory-graph", assertConnection: () => {} });
  expect(() => factory.reserve(factory.rootId, "first", "early")).toThrow();
  const planner = factory.reservePlan(factory.rootId);
  expect(() => factory.completePlan(factory.rootId, planner, { dependencies: { first: [], second: ["first"] }, targets: { first: ["main"], second: ["wrong"] } })).toThrow();
  factory.completePlan(factory.rootId, planner, { dependencies: { first: [], second: ["first"] }, targets: { first: ["main"], second: ["release"] } });
  expect(() => factory.reserve(factory.rootId, "second", "blocked")).toThrow();
  const proof = { itemId: "first", worktree: f.scope.boundRoot, head: "b".repeat(40), prNumber: 42 };
  for (const role of ["architect", "dev", "qa"] as const) {
    const reservation = factory.reserve(factory.rootId, "first", `first-${role}`, { kind: role, worktree: proof.worktree });
    factory.settleRole(factory.rootId, reservation, { itemId: "first", role, agentId: `agent-${role}`, head: proof.head, evidence: { verified: "yes" } });
  }
  factory.readyItem(factory.rootId, "first", proof);
  const rework = factory.reserve(factory.rootId, "first", "first-rework", { kind: "dev", worktree: proof.worktree });
  expect(() => factory.reserve(factory.rootId, "second", "blocked-during-rework")).toThrow();
  factory.settleRole(factory.rootId, rework, { itemId: "first", role: "dev", agentId: "agent-dev", head: "c".repeat(40), evidence: { verified: "yes" } });
  expect(() => factory.readyItem(factory.rootId, "first", { ...proof, head: "c".repeat(40) })).toThrow();
  expect(() => factory.reserve(factory.rootId, "second", "blocked-before-proof")).toThrow();
  const qa = factory.reserve(factory.rootId, "first", "first-qa-rework", { kind: "qa", worktree: proof.worktree });
  factory.settleRole(factory.rootId, qa, { itemId: "first", role: "qa", agentId: "agent-qa", head: "c".repeat(40), evidence: { verified: "yes" } });
  const architect = factory.reserve(factory.rootId, "first", "first-architect-rework", { kind: "architect", worktree: proof.worktree });
  factory.settleRole(factory.rootId, architect, { itemId: "first", role: "architect", agentId: "agent-architect", head: "c".repeat(40), evidence: { verified: "yes" } });
  factory.readyItem(factory.rootId, "first", { ...proof, head: "c".repeat(40) });
  expect(factory.reserve(factory.rootId, "second", "unblocked")).toBeTruthy();
  f.store.close();
});

test.each(["rows", "items"])("canonical %s queues preserve their container through capture and item transitions", (key: string) => {
  const f = fixture();
  const t = active(f, "shape-event", []);
  const legacy = { id: "legacy", status: "DONE", retained: true };
  writeFileSync(queuePath(f), JSON.stringify({ format: "aspen", unknown: { retained: true }, [key]: [legacy] }));
  expect(f.store.queueItems()).toEqual([legacy]);
  f.store.captureIntake({ architect: t.architectBinding, capture: { captureId: "shape-capture", eventId: "shape-event", rows: [{ id: "new", expectedRevision: null, fields: fields("Preserve queue shape") }], receipt: "captured" } });
  const captured = JSON.parse(readFileSync(queuePath(f), "utf8"));
  expect(captured.format).toBe("aspen");
  expect(captured.unknown).toEqual({ retained: true });
  expect(captured[key]).toHaveLength(2);
  expect(Object.hasOwn(captured, key === "rows" ? "items" : "rows")).toBe(false);
  expect(f.store.queueItems()).toHaveLength(2);
  f.store.transitionItem({ employee: f.store.managerBinding, request: { action: "decide", requestId: "shape-block", itemId: "new", expectedRevision: 1, status: "BLOCKED", evidence: "control proof" } });
  const transitioned = JSON.parse(readFileSync(queuePath(f), "utf8"));
  expect(transitioned[key][0]).toEqual(legacy);
  expect(transitioned[key][1].status).toBe("BLOCKED");
  expect(Object.hasOwn(transitioned, key === "rows" ? "items" : "rows")).toBe(false);
  f.store.close();
});

test("ambiguous queue containers fail without changing either row collection", () => {
  const f = fixture();
  const original = JSON.stringify({ rows: [{ id: "a" }], items: [{ id: "b" }] });
  writeFileSync(queuePath(f), original);
  expect(() => f.store.queueItems()).toThrow("both");
  expect(readFileSync(queuePath(f), "utf8")).toBe(original);
  f.store.close();
});

test("architect capture preserves queue shape, legacy rows, unknown fields and immutable receipts", (): void => {
  const f = fixture();
  const t = active(f, "event", []);
  const legacy = { id: "legacy", status: "DONE", odd: { nested: [1, 2] } };
  writeFileSync(
    queuePath(f),
    JSON.stringify({
      metadata: { v5: true },
      receipts: ["receipt-old"],
      items: [legacy],
    }),
  );
  const capture = {
    captureId: "capture-1",
    eventId: "event",
    rows: [
      { id: "new", expectedRevision: null, fields: fields("First request") },
    ],
    receipt: { part: 1, outcome: "enqueue" },
  };
  const receipt = f.store.captureIntake({
    architect: t.architectBinding,
    capture,
  });
  expect(
    f.store.captureIntake({ architect: t.architectBinding, capture }),
  ).toEqual(receipt);
  expect(JSON.parse(readFileSync(queuePath(f), "utf8"))).toEqual({
    metadata: { v5: true },
    receipts: ["receipt-old"],
    items: [
      legacy,
      { id: "new", ...fields("First request"), intake_refs: ["event"] },
    ],
  });
  expect(() =>
    f.store.captureIntake({
      architect: t.architectBinding,
      capture: { ...capture, receipt: "conflicting" },
    }),
  ).toThrow();
  const amendment = {
    captureId: "capture-2",
    eventId: "event",
    rows: [
      {
        id: "new",
        expectedRevision: 1,
        fields: { request: "First request\nAmendment" },
      },
    ],
    receipt: "amended",
  };
  expect(
    f.store.captureIntake({ architect: t.architectBinding, capture: amendment })
      .items[0]?.revision,
  ).toBe(2);
  expect(() =>
    f.store.captureIntake({
      architect: t.architectBinding,
      capture: { ...amendment, captureId: "stale" },
    }),
  ).toThrow();
  expect(() =>
    f.store.captureIntake({
      architect: t.architectBinding,
      capture: {
        captureId: "unauthorized",
        eventId: "event",
        rows: [
          { id: "legacy", expectedRevision: 0, fields: fields("overwrite") },
        ],
        receipt: "bad",
      },
    }),
  ).toThrow();
  f.store.close();
});

test("new team architect can amend delegated undispatched legacy rows but not active or completed work", (): void => {
  const f = fixture();
  const t = active(f, "event", []);
  writeFileSync(
    queuePath(f),
    JSON.stringify([
      {
        id: "legacy",
        request: "Original",
        status: "NEEDS_DECISION",
        acceptance: null,
        blocked_on: "clarify",
        intake_refs: ["v5/1"],
        unknown: ["keep"],
      },
      { id: "done", ...fields("Done"), status: "DONE" },
      { id: "running", ...fields("Running"), dispatched_at: "2026-10-13" },
    ]),
  );
  const input = {
    eventId: "event",
    input: "request",
    amendItemIds: ["legacy", "done", "running"],
  };
  // The immutable accepted event must carry delegation when first recorded.
  expect(() =>
    f.store.recordIntake({ manager: f.store.managerBinding, event: input }),
  ).toThrow();
  const t2 = reserved(f, "other", ["legacy", "done", "running", "active"]);
  const architect = bind(f, t2.architect, "architect", 1, t2.team.id);
  bind(f, t2.qa, "qa", 1, t2.team.id);
  bind(f, t2.dev, "dev", 1, t2.team.id);
  const captured = f.store.captureIntake({
    architect,
    capture: {
      captureId: "amend",
      eventId: "other",
      rows: [
        {
          id: "legacy",
          expectedRevision: 0,
          fields: {
            request: "Original\nClarification",
            acceptance: "Known",
            blocked_on: null,
            status: "QUEUED",
          },
        },
      ],
      receipt: "amended",
    },
  });
  expect(captured.items[0]?.revision).toBe(1);
  const rows = z
    .array(
      z
        .object({
          id: z.string(),
          intake_refs: z.array(z.string()).optional(),
          unknown: z.array(z.string()).optional(),
        })
        .passthrough(),
    )
    .parse(JSON.parse(readFileSync(queuePath(f), "utf8")));
  expect(rows[0]?.unknown).toEqual(["keep"]);
  expect(rows[0]?.intake_refs).toEqual(["v5/1", "other"]);
  for (const id of ["done", "running"])
    expect(() =>
      f.store.captureIntake({
        architect,
        capture: {
          captureId: id,
          eventId: "other",
          rows: [{ id, expectedRevision: 0, fields: fields("Replacement") }],
          receipt: "bad",
        },
      }),
    ).toThrow();
  f.store.captureIntake({
    architect: t.architectBinding,
    capture: {
      captureId: "active-row",
      eventId: "event",
      rows: [
        { id: "active", expectedRevision: null, fields: fields("Active") },
      ],
      receipt: "new",
    },
  });
  expect(() =>
    f.store.captureIntake({
      architect,
      capture: {
        captureId: "competing",
        eventId: "other",
        rows: [
          {
            id: "active",
            expectedRevision: 1,
            fields: { request: "Active\nAmend" },
          },
        ],
        receipt: "bad",
      },
    }),
  ).toThrow();
  f.store.close();
});

test("capture recovery finalizes an interrupted SQLite commit after the canonical file replacement", (): void => {
  const f = fixture();
  const t = active(f, "event", []);
  const capture = {
    captureId: "capture",
    eventId: "event",
    rows: [{ id: "new", expectedRevision: null, fields: fields("Request") }],
    receipt: "captured",
  };
  f.store.captureIntake({ architect: t.architectBinding, capture });
  f.store.close();
  const database = new Database(f.path);
  database
    .query(
      "UPDATE records SET payload=json_set(payload,'$.state','pending') WHERE kind='intent'",
    )
    .run();
  database
    .query("DELETE FROM records WHERE kind IN ('capture','queueOwner')")
    .run();
  database
    .query(
      "UPDATE records SET payload=json_set(payload,'$.state','ready','$.items',json('[]')) WHERE kind='team'",
    )
    .run();
  database.close();
  const reopened = openStore({
    path: f.path,
    scope: f.scope,
    owner: f.owner,
    now: (): number => 101,
  });
  expect(
    reopened.captureIntake({ architect: t.architectBinding, capture }).items,
  ).toEqual([{ id: "new", revision: 1 }]);
  expect(
    z.array(z.unknown()).parse(JSON.parse(readFileSync(queuePath(f), "utf8"))),
  ).toHaveLength(1);
  reopened.close();
});

test("legacy ambiguous locks block only affected targets, preserve inventory, and require explicit authority", (): void => {
  const f = fixture();
  const ids = hire(f, "devops", "hire", 2);
  const id = first(ids);
  const other = ids[1];
  if (other === undefined) throw new Error("Missing worker");
  const binding = bind(f, id, "devops", 1, null);
  const second = bind(f, other, "devops", 1, null);
  const path: string = join(f.startupRoot, "resources.json");
  const original = {
    inventory: ["server"],
    history: [{ old: true }],
    unknown: 42,
    locks: { production: { "held-by": "old-item", uncertain: true } },
  };
  writeFileSync(path, JSON.stringify(original));
  const locks = f.store.importResources({ manager: f.store.managerBinding });
  expect(locks).toHaveLength(1);
  expect(() =>
    f.store.acquireTarget({
      employee: binding,
      grantId: "missing",
      authorizationId: "missing",
    }),
  ).toThrow();
  f.store.authorizeTarget({
    manager: f.store.managerBinding,
    authorization: {
      id: "prod",
      employeeId: id,
      target: "production",
      authority: "Approved deploy",
    },
  });
  expect(() =>
    f.store.acquireTarget({
      employee: binding,
      grantId: "prod",
      authorizationId: "prod",
    }),
  ).toThrow();
  f.store.authorizeTarget({
    manager: f.store.managerBinding,
    authorization: {
      id: "stage",
      employeeId: id,
      target: "staging",
      authority: "Approved restart",
    },
  });
  const grant = f.store.acquireTarget({
    employee: binding,
    grantId: "stage",
    authorizationId: "stage",
  });
  expect(grant.state).toBe("held");
  f.store.authorizeTarget({
    manager: f.store.managerBinding,
    authorization: {
      id: "stage-2",
      employeeId: other,
      target: "staging",
      authority: "Approved restart",
    },
  });
  expect(() =>
    f.store.acquireTarget({
      employee: second,
      grantId: "conflict",
      authorizationId: "stage-2",
    }),
  ).toThrow();
  const projected = f.store.projectResources({
    manager: f.store.managerBinding,
  });
  expect(projected.inventory).toEqual(original.inventory);
  expect(projected.history).toEqual(original.history);
  expect(projected.unknown).toBe(42);
  expect(() =>
    f.store.retireEmployees({
      manager: f.store.managerBinding,
      employeeIds: [id, other],
      evidence: "scale down",
    }),
  ).toThrow();
  expect(
    f.store.snapshot().employees.find((value): boolean => value.id === other)
      ?.employment,
  ).toBe("hired");
  expect(() =>
    f.store.verifyAndReleaseTarget({
      employee: binding,
      grantId: "stage",
      verification: null,
    }),
  ).toThrow();
  f.store.verifyAndReleaseTarget({
    employee: binding,
    grantId: "stage",
    verification: { health: "verified" },
  });
  expect(() =>
    f.store.acquireTarget({
      employee: binding,
      grantId: "repeat",
      authorizationId: "stage",
    }),
  ).toThrow();
  f.store.reconcileLegacyLock({
    manager: f.store.managerBinding,
    lockId: "legacy-0",
    evidence: "Old owner confirmed release",
  });
  expect(
    f.store.acquireTarget({
      employee: binding,
      grantId: "prod",
      authorizationId: "prod",
    }).state,
  ).toBe("held");
  f.store.close();
});

test("duties coalesce overdue polls, retain pending configuration, fence observations and prevent unsafe retirement", (): void => {
  const f = fixture();
  const id = first(hire(f, "devops", "hire", 1));
  const binding = bind(f, id, "devops", 1, null);
  const duty = {
    id: "monitor",
    employeeId: id,
    assignment: "Watch deployment",
    target: "production",
    probe: "GET health",
    acceptance: "HTTP 200",
    repairAuthority: null,
    cadenceMs: 60,
    nextDue: 1,
  };
  f.store.setDuty({
    manager: f.store.managerBinding,
    duty: { ...duty, id: "pending", probe: null },
  });
  expect(f.store.claimDue({ employee: binding })).toBeNull();
  f.store.setDuty({ manager: f.store.managerBinding, duty });
  const occurrence = f.store.claimDue({ employee: binding });
  if (occurrence === null) throw new Error("No due observation");
  expect(occurrence.scheduledFor).toBe(1);
  expect(occurrence.claimedAt).toBe(100);
  expect(f.store.claimDue({ employee: binding })?.id).toBe(occurrence.id);
  expect(() =>
    f.store.retireEmployees({
      manager: f.store.managerBinding,
      employeeIds: [id],
      evidence: "idle",
    }),
  ).toThrow();
  f.store.observeDuty({
    employee: binding,
    occurrenceId: occurrence.id,
    observation: "HTTP 200",
  });
  expect(f.store.claimDue({ employee: binding })).toBeNull();
  expect(
    f.store
      .snapshot()
      .dutySchedules.find((value): boolean => value.id === "monitor")?.nextDue,
  ).toBe(160);
  f.store.endDuty({
    manager: f.store.managerBinding,
    dutyId: "monitor",
    evidence: "Finished",
  });
  f.store.endDuty({
    manager: f.store.managerBinding,
    dutyId: "pending",
    evidence: "Canceled",
  });
  expect(
    f.store.retireEmployees({
      manager: f.store.managerBinding,
      employeeIds: [id],
      evidence: "idle",
    })[0]?.employment,
  ).toBe("retired");
  expect(f.store.snapshot().occurrences).toHaveLength(1);
  f.store.close();
});

test("finished teams preserve history and reused employees require fresh native contexts", (): void => {
  const f = fixture();
  const t = active(f, "one", []);
  f.store.captureIntake({
    architect: t.architectBinding,
    capture: {
      captureId: "capture",
      eventId: "one",
      rows: [],
      receipt: "No work rows",
    },
  });
  for (const binding of [t.architectBinding, t.qaBinding, t.devBinding]) {
    const next = f.store.claimNext({ employee: binding });
    if (next === null) throw new Error("Missing assignment");
    f.store.settleClaim({
      employee: binding,
      claimId: next.claim.id,
      result: completed(`done-${binding.employeeId}`),
    });
  }
  expect(
    f.store.finishTeam({
      manager: f.store.managerBinding,
      teamId: t.team.id,
      evidence: "Finished",
    }).state,
  ).toBe("finished");
  f.store.recordIntake({
    manager: f.store.managerBinding,
    event: { eventId: "two", input: "New request", amendItemIds: [] },
  });
  const request = {
    ...t.request,
    eventId: "two",
    cues: t.request.cues.map((value) => ({
      ...value,
      id: `two-${value.id}`,
      correlation: "two",
    })),
  };
  const second = f.store.reserveTeam({
    manager: f.store.managerBinding,
    request,
  });
  expect(second.generations[t.dev]).toBe(2);
  expect(() => f.store.claimNext({ employee: t.devBinding })).toThrow();
  expect(() =>
    f.store.bindEmployee({
      manager: f.store.managerBinding,
      binding: {
        ...t.devBinding,
        generation: 2,
        source: source("dev"),
        assignment: second.id,
      },
    }),
  ).toThrow();
  bind(f, t.architect, "architect", 2, second.id);
  bind(f, t.qa, "qa", 2, second.id);
  bind(f, t.dev, "dev", 2, second.id);
  expect(f.store.snapshot().teams.map((team) => team.state)).toEqual([
    "finished",
    "ready",
  ]);
  expect(f.store.snapshot().results).toHaveLength(3);
  f.store.close();
});

test("source mismatch and native failures cannot advertise readiness; recovery advances generation", (): void => {
  const f = fixture();
  const t = active(f, "event", []);
  f.store.recordBindingFailure({
    manager: f.store.managerBinding,
    employeeId: t.dev,
    error: "Hard aborted native handle",
  });
  expect(f.store.snapshot().teams[0]?.state).toBe("reserved");
  expect(() => bind(f, t.dev, "dev", 1, t.team.id)).toThrow();
  const generation = f.store.reserveReplacement({
    manager: f.store.managerBinding,
    employeeId: t.dev,
    evidence: "Native handle terminal; no external operation in flight",
  });
  expect(generation).toBe(2);
  expect(() =>
    f.store.bindEmployee({
      manager: f.store.managerBinding,
      binding: {
        employeeId: t.dev,
        generation,
        nativeHandle: "fresh",
        assignment: t.team.id,
        source: source("qa"),
      },
    }),
  ).toThrow();
  expect(() =>
    f.store.bindEmployee({
      manager: f.store.managerBinding,
      binding: {
        employeeId: t.dev,
        generation,
        nativeHandle: "fresh",
        assignment: t.team.id,
        source: { ...source("dev"), roleRevision: "wrong" },
      },
    }),
  ).toThrow();
  bind(f, t.dev, "dev", generation, t.team.id);
  expect(f.store.snapshot().teams[0]?.state).toBe("ready");
  f.store.close();
});

test("resource projection refuses external edits and unsupported ambiguous lock targets", (): void => {
  const f = fixture();
  const path = join(f.startupRoot, "resources.json");
  writeFileSync(
    path,
    JSON.stringify({
      locks: [{ owner: "unknown", inventory: "unknown target" }],
    }),
  );
  expect(() =>
    f.store.importResources({ manager: f.store.managerBinding }),
  ).toThrow();
  writeFileSync(path, JSON.stringify({ locks: {}, inventory: ["original"] }));
  f.store.importResources({ manager: f.store.managerBinding });
  writeFileSync(
    path,
    JSON.stringify({ locks: {}, inventory: ["external change"] }),
  );
  expect(() =>
    f.store.projectResources({ manager: f.store.managerBinding }),
  ).toThrow();
  expect(JSON.parse(readFileSync(path, "utf8")).inventory).toEqual([
    "external change",
  ]);
  f.store.close();
});

test("SQLite write journal preserves externally changed queue and surfaces recovery conflict", (): void => {
  const f = fixture();
  const t = active(f, "event", []);
  f.store.captureIntake({
    architect: t.architectBinding,
    capture: {
      captureId: "capture",
      eventId: "event",
      rows: [],
      receipt: "No rows",
    },
  });
  f.store.close();
  const database = new Database(f.path);
  database
    .query(
      "UPDATE records SET payload=json_set(payload,'$.state','pending') WHERE kind='intent'",
    )
    .run();
  database.close();
  const external: string = JSON.stringify([{ id: "external", preserve: true }]);
  writeFileSync(queuePath(f), external);
  expect(() =>
    openStore({
      path: f.path,
      scope: f.scope,
      owner: f.owner,
      now: (): number => 101,
    }),
  ).toThrow("conflicts");
  expect(readFileSync(queuePath(f), "utf8")).toBe(external);
});

test("mail and duties block retirement until explicitly resolved; foreign inbox claims are fenced", (): void => {
  const f = fixture();
  const id = first(hire(f, "devops", "hire", 1));
  const binding = bind(f, id, "devops", 1, null);
  f.store.sendCue({ sender: binding, cue: cue("report", "manager", "report") });
  expect(() =>
    f.store.retireEmployees({
      manager: f.store.managerBinding,
      employeeIds: [id],
      evidence: "idle",
    }),
  ).toThrow();
  expect(() =>
    f.store.claimNext({ employee: { ...binding, employeeId: "manager" } }),
  ).toThrow();
  const claimed = f.store.claimNext({ employee: f.store.managerBinding });
  if (claimed === null) throw new Error("Missing report");
  f.store.settleClaim({
    employee: f.store.managerBinding,
    claimId: claimed.claim.id,
    result: completed("receipt"),
  });
  expect(
    f.store.retireEmployees({
      manager: f.store.managerBinding,
      employeeIds: [id],
      evidence: "idle",
    })[0]?.employment,
  ).toBe("retired");
  expect(() =>
    f.store.sendCue({
      sender: binding,
      cue: cue("later", "manager", "report"),
    }),
  ).toThrow();
  f.store.close();
});

test("delegated pending row ownership cannot be reclaimed by a later unrelated capture", (): void => {
  const f = fixture();
  const t = active(f, "one", []);
  f.store.captureIntake({
    architect: t.architectBinding,
    capture: {
      captureId: "first",
      eventId: "one",
      rows: [
        { id: "item", expectedRevision: null, fields: fields("Original") },
      ],
      receipt: "created",
    },
  });
  const claim = f.store.claimNext({ employee: t.architectBinding });
  if (claim === null) throw new Error("Missing intake claim");
  f.store.settleClaim({
    employee: t.architectBinding,
    claimId: claim.claim.id,
    result: { ...completed("waiting"), kind: "question" },
  });
  const second = active(f, "two", ["item"]);
  f.store.captureIntake({
    architect: second.architectBinding,
    capture: {
      captureId: "transfer",
      eventId: "two",
      rows: [
        {
          id: "item",
          expectedRevision: 1,
          fields: { request: "Original\nClarification" },
        },
      ],
      receipt: "amended",
    },
  });
  f.store.captureIntake({
    architect: t.architectBinding,
    capture: {
      captureId: "unrelated",
      eventId: "one",
      rows: [
        { id: "other", expectedRevision: null, fields: fields("Unrelated") },
      ],
      receipt: "created",
    },
  });
  expect(
    f.store.snapshot().queueRevisions.find((row) => row.id === "item"),
  ).toEqual({ id: "item", eventId: "two", revision: 2 });
  f.store.close();
});

test("held-by inventory outside locks cannot silently bypass target exclusion", (): void => {
  const f = fixture();
  const path = join(f.startupRoot, "resources.json");
  writeFileSync(
    path,
    JSON.stringify({
      previews: [{ target: "preview-1", "held-by": "v5-item" }],
      history: [{ "held-by": "old-completed" }],
    }),
  );
  expect(
    f.store
      .importResources({ manager: f.store.managerBinding })
      .map((lock) => lock.target),
  ).toEqual(["preview-1"]);
  f.store.close();
  const other = fixture();
  const otherPath = join(other.startupRoot, "resources.json");
  writeFileSync(
    otherPath,
    JSON.stringify({
      worktrees: [{ "held-by": "unknown", path: "/missing-target" }],
    }),
  );
  expect(() =>
    other.store.importResources({ manager: other.store.managerBinding }),
  ).toThrow("no explicit target");
  other.store.close();
});

test("invalid additive counts cannot allocate staff or corrupt request receipts", (): void => {
  const f = fixture();
  for (const additional of [
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() =>
      f.store.reserveHire({
        authority: f.user,
        request: {
          requestId: "invalid",
          role: "devops",
          additional,
          revision: "rev",
        },
      }),
    ).toThrow();
  }
  expect(f.store.snapshot().employees).toHaveLength(1);
  expect(f.store.snapshot().hires).toHaveLength(0);
  f.store.close();
});

test("manager reconciles a failed employee's held grant before native replacement", (): void => {
  const f = fixture();
  const id = first(hire(f, "devops", "hire", 1));
  const binding = bind(f, id, "devops", 1, null);
  f.store.importResources({ manager: f.store.managerBinding });
  f.store.authorizeTarget({
    manager: f.store.managerBinding,
    authorization: {
      id: "auth",
      employeeId: id,
      target: "production",
      authority: "Approved deploy",
    },
  });
  f.store.acquireTarget({
    employee: binding,
    grantId: "grant",
    authorizationId: "auth",
  });
  f.store.recordBindingFailure({
    manager: f.store.managerBinding,
    employeeId: id,
    error: "Native handle hard-aborted during mutation",
  });
  expect(f.store.snapshot().grants[0]?.state).toBe("reconciliation");
  expect(() =>
    f.store.reserveReplacement({
      manager: f.store.managerBinding,
      employeeId: id,
      evidence: "Replace",
    }),
  ).toThrow();
  expect(
    f.store.verifyAndReleaseTarget({
      employee: f.store.managerBinding,
      grantId: "grant",
      verification:
        "Inspected deployment externally and verified the intended version is healthy",
    }).state,
  ).toBe("released");
  expect(
    f.store.reserveReplacement({
      manager: f.store.managerBinding,
      employeeId: id,
      evidence: "Grant reconciled, native handle terminal",
    }),
  ).toBe(2);
  bind(f, id, "devops", 2, null);
  f.store.close();
});

test("native failure retains claimed inbox work for explicit manager reconciliation", (): void => {
  const f = fixture();
  const id = first(hire(f, "devops", "hire", 1));
  const binding = bind(f, id, "devops", 1, null);
  f.store.sendCue({
    sender: f.store.managerBinding,
    cue: cue("assign", id, "assignment"),
  });
  const claim = f.store.claimNext({ employee: binding });
  if (claim === null) throw new Error("Missing assignment");
  f.store.recordBindingFailure({
    manager: f.store.managerBinding,
    employeeId: id,
    error: "Unexpected native exit",
  });
  expect(f.store.snapshot().claims[0]?.status).toBe("reconciliation");
  expect(f.store.snapshot().messages[0]?.status).toBe("claimed");
  f.store.reconcileClaim({
    manager: f.store.managerBinding,
    claimId: claim.claim.id,
    evidence: "Transcript inspected; no external mutation",
  });
  expect(
    f.store.reserveReplacement({
      manager: f.store.managerBinding,
      employeeId: id,
      evidence: "Continue in new context",
    }),
  ).toBe(2);
  f.store.close();
});

test("failed read-only duty can be reclaimed after replacement without inventing an observation", (): void => {
  const f = fixture();
  const id = first(hire(f, "devops", "hire", 1));
  const binding = bind(f, id, "devops", 1, null);
  f.store.setDuty({
    manager: f.store.managerBinding,
    duty: {
      id: "poll",
      employeeId: id,
      assignment: "Read health",
      target: "production",
      probe: "GET health",
      acceptance: "200",
      repairAuthority: null,
      cadenceMs: 60,
      nextDue: 1,
    },
  });
  const occurrence = f.store.claimDue({ employee: binding });
  if (occurrence === null) throw new Error("Missing due poll");
  f.store.recordBindingFailure({
    manager: f.store.managerBinding,
    employeeId: id,
    error: "Native exit before probe returned",
  });
  expect(
    f.store.reserveReplacement({
      manager: f.store.managerBinding,
      employeeId: id,
      evidence: "Retry read-only observation in new context",
    }),
  ).toBe(2);
  const replacement = bind(f, id, "devops", 2, null);
  expect(f.store.snapshot().occurrences[0]?.observedAt).toBeNull();
  expect(f.store.claimDue({ employee: replacement })?.id).toBe(occurrence.id);
  expect(() =>
    f.store.observeDuty({
      employee: binding,
      occurrenceId: occurrence.id,
      observation: "late",
    }),
  ).toThrow();
  f.store.observeDuty({
    employee: replacement,
    occurrenceId: occurrence.id,
    observation: "Fresh HTTP 200",
  });
  f.store.close();
});

test("failed manager recovery requires a newer fenced owner and preserves failure history", (): void => {
  const f = fixture();
  f.store.recordBindingFailure({
    manager: f.store.managerBinding,
    employeeId: "manager",
    error: "Native root failed",
  });
  f.store.close();
  const sameGeneration = openStore({
    path: f.path,
    scope: f.scope,
    owner: { ...f.owner, id: "same-generation-owner" },
    now: (): number => 101,
  });
  expect(() =>
    sameGeneration.recoverManager({ evidence: "No new native generation" }),
  ).toThrow();
  sameGeneration.close();
  const recovered = openStore({
    path: f.path,
    scope: f.scope,
    owner: { ...f.owner, id: "replacement-owner", managerGeneration: 2 },
    now: (): number => 102,
  });
  expect(() =>
    recovered.bindEmployee({
      manager: recovered.managerBinding,
      binding: {
        ...recovered.managerBinding,
        assignment: null,
        source: source("manager"),
      },
    }),
  ).toThrow();
  expect(
    recovered.recoverManager({
      evidence:
        "Verified replacement root generation 2 through native owner evidence",
    }).error,
  ).toBeNull();
  expect(() =>
    recovered.recordIntake({
      manager: f.store.managerBinding,
      event: { eventId: "stale-manager", input: "Denied", amendItemIds: [] },
    }),
  ).toThrow();
  expect(() => f.store.renewLease()).toThrow();
  recovered.bindEmployee({
    manager: recovered.managerBinding,
    binding: {
      ...recovered.managerBinding,
      assignment: null,
      source: source("manager"),
    },
  });
  recovered.recordIntake({
    manager: recovered.managerBinding,
    event: { eventId: "new-manager", input: "Accepted", amendItemIds: [] },
  });
  const database = new Database(f.path);
  const failures = database
    .query(
      "SELECT payload FROM audit WHERE kind='employee' AND id='manager' AND json_extract(payload,'$.error')='Native root failed'",
    )
    .all();
  expect(failures.length).toBeGreaterThan(0);
  database.close();
  recovered.close();
});

test("standing staff with unreleased grants cannot be reserved into a team", (): void => {
  for (const role of ["architect", "qa", "dev"]) {
    for (const state of ["held", "reconciliation"]) {
      const f = fixture();
      const architect = first(hire(f, "architect", "architect", 1));
      const qa = first(hire(f, "qa", "qa", 1));
      const dev = first(hire(f, "dev", "dev", 1));
      const member =
        role === "architect" ? architect : role === "qa" ? qa : dev;
      const binding = bind(f, member, role, 1, null);
      f.store.importResources({ manager: f.store.managerBinding });
      f.store.authorizeTarget({
        manager: f.store.managerBinding,
        authorization: {
          id: "auth",
          employeeId: member,
          target: "target",
          authority: "Authorized operation",
        },
      });
      f.store.acquireTarget({
        employee: binding,
        grantId: "grant",
        authorizationId: "auth",
      });
      if (state === "reconciliation")
        f.store.recordBindingFailure({
          manager: f.store.managerBinding,
          employeeId: member,
          error: "Unknown native outcome",
        });
      f.store.recordIntake({
        manager: f.store.managerBinding,
        event: { eventId: "event", input: "New task", amendItemIds: [] },
      });
      const request = {
        eventId: "event",
        architect,
        qa,
        devs: [dev],
        cues: [architect, qa, dev].map((recipient) => ({
          ...cue(`assignment-${recipient}`, recipient, "assignment"),
          correlation: "event",
        })),
      };
      const before = f.store.snapshot();
      expect(() =>
        f.store.reserveTeam({ manager: f.store.managerBinding, request }),
      ).toThrow();
      expect(f.store.snapshot()).toEqual(before);
      f.store.verifyAndReleaseTarget({
        employee: state === "held" ? binding : f.store.managerBinding,
        grantId: "grant",
        verification: "Verified the target and resolved the operation",
      });
      expect(
        f.store.reserveTeam({ manager: f.store.managerBinding, request }).state,
      ).toBe("reserved");
      f.store.close();
    }
  }
});

test("team completion and finished-team reuse preserve unreleased target grants", (): void => {
  const f = fixture();
  const t = active(f, "one", []);
  f.store.captureIntake({
    architect: t.architectBinding,
    capture: {
      captureId: "capture",
      eventId: "one",
      rows: [],
      receipt: "No remaining rows",
    },
  });
  for (const binding of [t.architectBinding, t.qaBinding, t.devBinding]) {
    const claimed = f.store.claimNext({ employee: binding });
    if (claimed === null) throw new Error("Missing assignment");
    f.store.settleClaim({
      employee: binding,
      claimId: claimed.claim.id,
      result: completed(`done-${binding.employeeId}`),
    });
  }
  f.store.importResources({ manager: f.store.managerBinding });
  f.store.authorizeTarget({
    manager: f.store.managerBinding,
    authorization: {
      id: "auth",
      employeeId: t.dev,
      target: "target",
      authority: "Authorized operation",
    },
  });
  f.store.acquireTarget({
    employee: t.devBinding,
    grantId: "grant",
    authorizationId: "auth",
  });
  const beforeFinish = f.store.snapshot();
  expect(() =>
    f.store.finishTeam({
      manager: f.store.managerBinding,
      teamId: t.team.id,
      evidence: "Completed assignments",
    }),
  ).toThrow();
  expect(f.store.snapshot()).toEqual(beforeFinish);
  f.store.verifyAndReleaseTarget({
    employee: t.devBinding,
    grantId: "grant",
    verification: "Operation verified",
  });
  expect(
    f.store.finishTeam({
      manager: f.store.managerBinding,
      teamId: t.team.id,
      evidence: "Work and grant complete",
    }).state,
  ).toBe("finished");
  f.store.authorizeTarget({
    manager: f.store.managerBinding,
    authorization: {
      id: "standing-auth",
      employeeId: t.dev,
      target: "target",
      authority: "Authorized subsequent operation",
    },
  });
  f.store.acquireTarget({
    employee: t.devBinding,
    grantId: "standing-grant",
    authorizationId: "standing-auth",
  });
  f.store.recordIntake({
    manager: f.store.managerBinding,
    event: { eventId: "two", input: "Next task", amendItemIds: [] },
  });
  const request = {
    ...t.request,
    eventId: "two",
    cues: t.request.cues.map((value) => ({
      ...value,
      id: `two-${value.id}`,
      correlation: "two",
    })),
  };
  const beforeReuse = f.store.snapshot();
  expect(() =>
    f.store.reserveTeam({ manager: f.store.managerBinding, request }),
  ).toThrow();
  expect(f.store.snapshot()).toEqual(beforeReuse);
  f.store.verifyAndReleaseTarget({
    employee: t.devBinding,
    grantId: "standing-grant",
    verification: "Subsequent operation verified",
  });
  expect(
    f.store.reserveTeam({ manager: f.store.managerBinding, request })
      .generations[t.dev],
  ).toBe(2);
  f.store.close();
});

test("reclaimed read-only occurrence coalesces overdue schedule before the next poll", (): void => {
  const f = fixture();
  const id = first(hire(f, "devops", "reclaim-cadence", 1));
  const employee = bind(f, id, "devops", 1, null);
  f.store.setDuty({
    manager: f.store.managerBinding,
    duty: {
      id: "reclaim",
      employeeId: id,
      assignment: null,
      target: "fixture",
      probe: "read",
      acceptance: "healthy",
      repairAuthority: null,
      cadenceMs: 50,
      nextDue: 100,
    },
  });
  const pending = f.store.claimDue({ employee });
  if (!pending) throw new Error("Expected initial occurrence");
  f.store.close();
  const recovered = openStore({
    path: f.path,
    scope: f.scope,
    owner: f.owner,
    now: () => 1000,
  });
  recovered.bindEmployee({
    manager: recovered.managerBinding,
    binding: {
      ...recovered.managerBinding,
      assignment: null,
      source: source("manager"),
    },
  });
  const reclaimed = recovered.claimDue({ employee });
  expect(reclaimed?.id).toBe(pending.id);
  expect(recovered.snapshot().dutySchedules[0]?.nextDue).toBe(1050);
  recovered.observeDuty({
    employee,
    occurrenceId: pending.id,
    observation: { actualCheckAt: 1000 },
  });
  expect(recovered.claimDue({ employee })).toBeNull();
  expect(recovered.snapshot().occurrences).toHaveLength(1);
  recovered.close();
});

test("crew recovery waits until every uncertain member claim is reconciled", (): void => {
  const f = fixture();
  const t = active(f, "recover-all", []);
  const bindings = [t.architectBinding, t.qaBinding];
  const claims = bindings.map((binding) => {
    const claim = f.store.claimNext({ employee: binding });
    if (claim === null) throw new Error("Missing crew assignment");
    return { binding, claim };
  });
  for (const { binding, claim } of claims)
    f.store.settleClaim({ employee: binding, claimId: claim.claim.id, result: { ...completed(`uncertain-${binding.employeeId}`), kind: "uncertain" } });
  for (const [index, { claim }] of claims.entries()) {
    f.store.reconcileClaim({ manager: f.store.managerBinding, claimId: claim.claim.id, evidence: "Verified metadata outcome" });
    expect(f.store.snapshot().teams[0]?.state).toBe(index === 0 ? "reconciliation" : "waiting");
  }
  const firstClaim = claims[0];
  if (!firstClaim) throw new Error("Missing first claim");
  f.store.resolveAssignment({ manager: f.store.managerBinding, assignmentId: firstClaim.claim.message.id, evidence: "Complete" });
  f.store.reconcileClaim({ manager: f.store.managerBinding, claimId: firstClaim.claim.claim.id, evidence: "Verified metadata outcome" });
  expect(f.store.snapshot().assignments.find((a) => a.id === firstClaim.claim.message.id)?.state).toBe("complete");
  f.store.close();
});


for (const scenario of [
  { name: "missing", patch: {}, target: "missing", code: "claim_not_found" },
  { name: "foreign", patch: { employeeId: "another-employee" }, target: "explicit", code: "claim_not_owned" },
  { name: "generation", patch: { generation: 99 }, target: "current", code: "claim_generation_stale" },
  { name: "epoch", patch: { ownerEpoch: 99 }, target: "current", code: "claim_requires_reconciliation" },
  { name: "reconciliation", patch: { status: "reconciliation" }, target: "current", code: "claim_requires_reconciliation" },
  { name: "settled", patch: { status: "settled" }, target: "explicit", code: "claim_already_settled" },
]) test(`settlement error distinguishes ${scenario.name} and explains recovery`, () => {
  const f = fixture();
  f.store.sendCue({ sender: f.store.managerBinding, cue: cue("report", "manager", "report") });
  const claimed = f.store.claimNext({ employee: f.store.managerBinding });
  if (claimed === null) throw new Error("Missing report");
  const db = new Database(f.path);
  db.query("UPDATE records SET payload=? WHERE kind='claim' AND id=?").run(JSON.stringify({ ...claimed.claim, ...scenario.patch }), claimed.claim.id);
  db.close();
  const claimId = scenario.target === "missing" ? "missing" : scenario.target === "explicit" ? claimed.claim.id : "current";
  let caught: unknown;
  try { f.store.settleClaim({ employee: f.store.managerBinding, claimId, result: completed("result") }); }
  catch (error: unknown) { caught = error; }
  expect(caught).toMatchObject({ recovery: { code: scenario.code, retryable: false, employeeId: "manager", generation: 1, action: expect.any(String) } });
  expect(f.store.snapshot().results).toHaveLength(0);
  f.store.close();
});

test("implicit settlement refuses absent or ambiguous claims and replays uncertain receipts", () => {
  const f = fixture();
  expect(() => f.store.settleClaim({ employee: f.store.managerBinding, result: completed("missing") })).toThrow("no_active_claim");
  f.store.sendCue({ sender: f.store.managerBinding, cue: cue("report", "manager", "report") });
  const claimed = f.store.claimNext({ employee: f.store.managerBinding });
  if (claimed === null) throw new Error("Missing report");
  const db = new Database(f.path);
  db.query("INSERT INTO records(kind,id,payload) VALUES('claim','duplicate',?)").run(JSON.stringify({ ...claimed.claim, id: "duplicate" }));
  expect(() => f.store.settleClaim({ employee: f.store.managerBinding, result: completed("ambiguous") })).toThrow("ambiguous_claim");
  db.query("DELETE FROM records WHERE kind='claim' AND id='duplicate'").run(); db.close();
  const result = { ...completed("uncertain"), kind: "uncertain" as const };
  const saved = f.store.settleClaim({ employee: f.store.managerBinding, result });
  expect(f.store.settleClaim({ employee: f.store.managerBinding, result })).toEqual(saved);
  expect(f.store.snapshot().claims[0]?.status).toBe("reconciliation");
  f.store.close();
});

test("a global result-ID collision does not disclose a foreign claim and a fresh ID can settle own work", () => {
  const f = fixture();
  f.store.sendCue({ sender: f.store.managerBinding, cue: cue("manager-report", "manager", "report") });
  f.store.claimNext({ employee: f.store.managerBinding });
  const managerReceipt = f.store.settleClaim({ employee: f.store.managerBinding, result: completed("shared") });
  const id = first(hire(f, "devops", "hire-collision", 1));
  const binding = bind(f, id, "devops", 1, null);
  f.store.sendCue({ sender: f.store.managerBinding, cue: cue("worker-report", id, "assignment") });
  const own = f.store.claimNext({ employee: binding });
  if (!own) throw new Error("Missing own claim");
  let caught: unknown;
  try { f.store.settleClaim({ employee: binding, result: completed("shared") }); }
  catch (error: unknown) { caught = error; }
  expect(caught).toMatchObject({ recovery: { code: "result_replay_conflict", claimId: null } });
  expect(JSON.stringify(caught)).not.toContain(managerReceipt.claimId);
  expect(f.store.settleClaim({ employee: binding, result: completed("unique") }).claimId).toBe(own.claim.id);
  f.store.close();
});

test("a prior-generation result ID is a replay conflict while fresh current-generation work can settle", () => {
  const f = fixture();
  f.store.sendCue({ sender: f.store.managerBinding, cue: cue("old-report", "manager", "report") });
  f.store.claimNext({ employee: f.store.managerBinding });
  f.store.settleClaim({ employee: f.store.managerBinding, result: completed("shared") });
  f.store.sendCue({ sender: f.store.managerBinding, cue: cue("new-report", "manager", "report") });
  const manager = f.store.snapshot().employees.find((e) => e.id === "manager");
  if (!manager) throw new Error("Missing manager");
  const db = new Database(f.path);
  db.query("UPDATE records SET payload=? WHERE kind='employee' AND id='manager'").run(JSON.stringify({ ...manager, generation: 2, nativeHandle: "new-native" })); db.close();
  const binding = { ...f.store.managerBinding, generation: 2, nativeHandle: "new-native" };
  const own = f.store.claimNext({ employee: binding });
  if (!own) throw new Error("Missing current claim");
  expect(() => f.store.settleClaim({ employee: binding, result: completed("shared") })).toThrow("result_replay_conflict");
  expect(f.store.settleClaim({ employee: binding, result: completed("unique") }).claimId).toBe(own.claim.id);
  f.store.close();
});


test("manager claims technical reports ahead of retained lifecycle backlog", () => {
  const f = fixture();
  const t = active(f, "technical-priority", []);
  for (let index = 0; index < 200; index += 1) f.store.runtimeAlert({
    id: `old-admin-${index}`, correlation: "old-runtime",
    payload: { kind: "runtime-observation", employeeId: t.dev, state: "idle", observedAt: 1, sequence: index },
  });
  f.store.sendCue({ sender: t.architectBinding, cue: { id: "fresh-code-proof", recipient: "manager", kind: "report", correlation: "technical-priority", payload: { kind: "item-architect-gate", itemId: "PR4537", verdict: "APPROVE", head: "new-code" } } });
  expect(f.store.claimNext({ employee: f.store.managerBinding })?.message.id).toBe("fresh-code-proof");
  expect(f.store.snapshot().messages.filter((m) => m.id.startsWith("old-admin-") && m.status === "pending")).toHaveLength(200);
  f.store.close();
});

test("fresh technical reports bypass retained direct-pane oversight notices", () => {
  const f = fixture();
  const t = active(f, "pane-oversight-priority", []);
  for (let index = 0; index < 20; index += 1) f.store.runtimeAlert({
    id: `pane-oversight-${index}`, correlation: "pane-oversight-priority",
    payload: { kind: "direct-pane-input", employeeId: t.dev, text: "Earlier employee control input", observedAt: 1 },
  });
  f.store.sendCue({ sender: t.architectBinding, cue: { id: "fresh-gate-proof", recipient: "manager", kind: "report", correlation: "pane-oversight-priority", payload: "Current exact-head gate proof" } });
  expect(f.store.employeeView("manager").messages[0]?.id).toBe("fresh-gate-proof");
  expect(f.store.claimNext({ employee: f.store.managerBinding })?.message.id).toBe("fresh-gate-proof");
  f.store.settleClaim({ employee: f.store.managerBinding, result: completed("fresh-gate-receipt") });
  expect(f.store.employeeView("manager").messages.map((m) => m.id)).toEqual(Array.from({ length: 20 }, (_, index) => `pane-oversight-${index}`));
  expect(f.store.claimNext({ employee: f.store.managerBinding })?.message.id).toBe("pane-oversight-0");
  f.store.close();
});


test("routine PA reports remain durable summaries while PA alerts and technical reports are claimable", () => {
  const f = fixture();
  const t = active(f, "pa-delivery", []);
  const pa = bind(f, first(hire(f, "pa", "pa-delivery-hire", 1)), "pa", 1, null);
  for (let index = 0; index < 2; index += 1) f.store.sendCue({ sender: pa, cue: { id: `routine-pa-${index}`, recipient: "manager", kind: "report", correlation: "manager-supervision", payload: { managerPresence: "online", scheduledAt: index } } });
  f.store.sendCue({ sender: t.architectBinding, cue: { id: "technical-first", recipient: "manager", kind: "report", correlation: "pa-delivery", payload: "actual code proof" } });
  expect(f.store.claimNext({ employee: f.store.managerBinding })?.message.id).toBe("technical-first");
  f.store.settleClaim({ employee: f.store.managerBinding, result: completed("technical-receipt") });
  f.store.sendCue({ sender: pa, cue: { id: "pa-real-alert", recipient: "manager", kind: "alert", correlation: "manager-supervision", payload: { error: "supervision needs attention" } } });
  expect(f.store.claimNext({ employee: f.store.managerBinding })?.message.id).toBe("pa-real-alert");
  f.store.settleClaim({ employee: f.store.managerBinding, result: completed("alert-receipt") });
  const view = f.store.employeeView("manager");
  expect(view.messages).toEqual([]);
  expect(view.deferredMessageCount).toBe(2);
  expect(view.latestPaReport?.id).toBe("routine-pa-1");
  expect(f.store.claimNext({ employee: f.store.managerBinding })).toBeNull();
  expect(f.store.snapshot().messages.filter((m) => m.id.startsWith("routine-pa-") && m.status === "pending")).toHaveLength(2);
  f.store.close();
});

test("technical priority preserves sequence, exclusions and unresolved-claim fencing", () => {
  const f = fixture();
  const t = active(f, "priority-order", []);
  for (const id of ["proof-one", "proof-two"]) f.store.sendCue({ sender: t.architectBinding, cue: { id, recipient: "manager", kind: "report", correlation: "priority-order", payload: "proof" } });
  expect(f.store.employeeView("manager").messages.map((m) => m.id)).toEqual(["proof-one", "proof-two"]);
  expect(f.store.claimNext({ employee: f.store.managerBinding, excludedMessageIds: ["proof-one"] })?.message.id).toBe("proof-two");
  expect(() => f.store.claimNext({ employee: f.store.managerBinding })).toThrow("unresolved claim");
  f.store.settleClaim({ employee: f.store.managerBinding, result: completed("proof-two-receipt") });
  expect(f.store.claimNext({ employee: f.store.managerBinding })?.message.id).toBe("proof-one");
  f.store.close();
});

test("claim selection does not decode unrelated historical inboxes or claims", () => {
  const f = fixture();
  f.store.runtimeAlert({ id: "real-new-error", correlation: "current", payload: { kind: "boot-failed", employeeId: "unavailable" } });
  const database = new Database(f.path);
  database.query("INSERT INTO records VALUES('message','unrelated-history',?)").run(JSON.stringify({ recipient: "foreign", status: "acknowledged" }));
  database.query("INSERT INTO records VALUES('claim','unrelated-claim',?)").run(JSON.stringify({ employeeId: "foreign", status: "settled" }));
  database.close();
  expect(f.store.claimNext({ employee: f.store.managerBinding })?.message.id).toBe("real-new-error");
  f.store.close();
});

test("manager captures work and reserves a pipeline without a team or PA", () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "direct-event", input: "request", amendItemIds: [] } });
  const capture = { captureId: "direct-capture", eventId: "direct-event", rows: [{ id: "direct-item", expectedRevision: null, fields: fields("Do work") }], receipt: "captured" };
  expect(f.store.captureIntake({ architect: f.store.managerBinding, capture }).teamId).toBeNull();
  expect(f.store.captureIntake({ architect: f.store.managerBinding, capture }).items[0]?.id).toBe("direct-item");
  expect(f.store.managerPendingWork().undelegatedIntake).toBe(false);
  const args = { manager: f.store.managerBinding, itemId: "direct-item", workflow: "pipeline" as const, limit: 2, target: "main", branch: "work-one", launchKey: "direct-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  const run = f.store.reserveManagerRun(args);
  expect(run).toMatchObject({ created: true, run: { launchKey: "direct-run", itemId: "direct-item", state: "starting", limit: 2 } });
  expect(f.store.reserveManagerRun(args)).toEqual({ run: run.run, created: false });
  expect(() => f.store.reserveManagerRun({ ...args, launchKey: "duplicate" })).toThrow();
  expect(() => f.store.reserveManagerRun({ ...args, limit: 3 })).toThrow();
  f.store.close();
});

test("manager run becomes uncertain on restart and cannot be duplicated", () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "restart-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "restart-capture", eventId: "restart-event", rows: [{ id: "restart-item", expectedRevision: null, fields: fields("Do work") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "restart-item", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "restart-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  f.store.close();
  const reopened = openStore({ path: f.path, scope: f.scope, owner: f.owner, now: () => 1200 });
  reopened.bindEmployee({ manager: reopened.managerBinding, binding: { ...reopened.managerBinding, assignment: null, source: source("manager") } });
  expect(reopened.managerRuns()[0]?.state).toBe("uncertain");
  expect(() => reopened.reserveManagerRun({ ...args, manager: reopened.managerBinding, launchKey: "retry" })).toThrow();
  reopened.close();
});

test("manager runs permit distinct worktrees while fencing the same worktree and item", () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "race-event", input: "request", amendItemIds: [] } });
  const capture = { captureId: "race-capture", eventId: "race-event", rows: [{ id: "one", expectedRevision: null, fields: fields("First") }, { id: "two", expectedRevision: null, fields: fields("Second") }, { id: "three", expectedRevision: null, fields: fields("Third") }], receipt: "captured" };
  f.store.captureIntake({ architect: f.store.managerBinding, capture });
  const secondWorktree = join(f.root, "second-worktree");
  const secondRepo = join(f.root, "second-repo");
  mkdirSync(secondWorktree);
  mkdirSync(secondRepo);
  const args = { manager: f.store.managerBinding, itemId: "one", workflow: "pipeline" as const, limit: 2, target: "main", branch: "work-one", launchKey: "one-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  expect(f.store.reserveManagerRun({ ...args, itemId: "two", launchKey: "two-run", branch: "work-two", worktree: secondWorktree }).created).toBe(true);
  expect(() => f.store.reserveManagerRun({ ...args, itemId: "three", launchKey: "same-branch", worktree: secondRepo })).toThrow();
  expect(() => f.store.reserveManagerRun({ ...args, itemId: "three", launchKey: "conflict", repository: secondRepo })).toThrow();
  expect(() => f.store.reserveManagerRun({ ...args, launchKey: "duplicate-other-tree", repository: secondRepo, worktree: secondRepo })).toThrow();
  expect(() => f.store.captureIntake({ architect: f.store.managerBinding, capture: { ...capture, captureId: "race-amend", rows: [{ id: "one", expectedRevision: 1, fields: fields("First changed") }] } })).toThrow();
  expect(() => f.store.acceptManagerRun({ manager: f.store.managerBinding, launchKey: "one-run", location: {} })).toThrow();
  expect(f.store.acceptManagerRun({ manager: f.store.managerBinding, launchKey: "one-run", location: { nativeId: "pane-1" } }).state).toBe("accepted");
  expect(f.store.settleManagerRun({ manager: f.store.managerBinding, launchKey: "one-run", state: "reported", outcome: { claim: "done" } }).state).toBe("accepted");
  expect(() => f.store.reserveManagerRun({ ...args, itemId: "three", launchKey: "still-active-repo", worktree: secondWorktree })).toThrow();
  expect(() => f.store.reserveManagerRun({ ...args, launchKey: "replay" })).toThrow();
  f.store.acceptManagerRun({ manager: f.store.managerBinding, launchKey: "two-run", location: { nativeId: "pane-2" } });
  f.store.settleManagerRun({ manager: f.store.managerBinding, launchKey: "two-run", state: "failed", outcome: { error: "failed after dispatch" } });
  expect(() => f.store.reserveManagerRun({ ...args, itemId: "two", launchKey: "failed-retry", worktree: secondWorktree })).toThrow();
  f.store.close();
});

test("legacy migration transfers only undispatched queued items without changing their team", () => {
  const f = fixture();
  const t = active(f, "legacy-event", []);
  f.store.captureIntake({ architect: t.architectBinding, capture: { captureId: "legacy-capture", eventId: "legacy-event", rows: [
    { id: "ready", expectedRevision: null, fields: fields("Ready") },
    { id: "dispatched", expectedRevision: null, fields: { ...fields("Dispatched"), dispatched_at: 12 } },
    { id: "needs-decision", expectedRevision: null, fields: { ...fields("Waiting"), status: "NEEDS_DECISION" } },
    { id: "terminal", expectedRevision: null, fields: { ...fields("Rejected"), status: "REJECTED" } },
  ], receipt: "captured" } });
  const before = f.store.getTeam(t.team.id);
  const receipt = f.store.migrateManagerQueue({ manager: f.store.managerBinding, migrationId: "migration-one" });
  expect(receipt.migrated).toEqual(["ready"]);
  expect(receipt.blocked).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemId: "dispatched" }),
    expect.objectContaining({ itemId: "needs-decision" }),
    expect.objectContaining({ itemId: "terminal" }),
  ]));
  expect(f.store.migrateManagerQueue({ manager: f.store.managerBinding, migrationId: "migration-one" })).toEqual(receipt);
  expect(f.store.getTeam(t.team.id)).toEqual(before);
  expect(() => f.store.transitionItem({ employee: t.architectBinding, request: { action: "assign", requestId: "old-assign", itemId: "ready", expectedRevision: 1, employeeId: t.dev, evidence: "work" } })).toThrow("manager");
  expect(f.store.reserveManagerRun({ manager: f.store.managerBinding, itemId: "ready", workflow: "pipeline", limit: 2, target: "main", branch: "work-one", launchKey: "legacy-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot }).created).toBe(true);
  f.store.close();
});

test("legacy migration retains review history and remaining review budget", () => {
  const f = fixture();
  const t = active(f, "history-event", []);
  f.store.captureIntake({ architect: t.architectBinding, capture: { captureId: "history-capture", eventId: "history-event", rows: [
    { id: "prior-review", expectedRevision: null, fields: fields("Already reviewed") },
    { id: "uncertain-review", expectedRevision: null, fields: fields("Uncertain review") },
  ], receipt: "captured" } });
  const db = new Database(f.path);
  const insert = db.query("INSERT INTO records(kind,id,payload) VALUES(?,?,?)");
  const review = { changeId: "prior-review", reservationId: "old-review", head: "old-head", reviewerId: t.qa, messageId: "review-msg", limit: 2, state: "completed", verdict: "changes-requested", resultId: "old-result" };
  insert.run("workflowReview", "old-review", JSON.stringify(review));
  insert.run("workflowReview", "uncertain-review", JSON.stringify({ ...review, changeId: "uncertain-review", reservationId: "uncertain-review", state: "uncertain", verdict: null, resultId: null }));
  db.close();
  const receipt = f.store.migrateManagerQueue({ manager: f.store.managerBinding, migrationId: "history-migration" });
  expect(receipt.migrated).toEqual(["prior-review"]);
  expect(receipt.blocked).toContainEqual(expect.objectContaining({ itemId: "uncertain-review" }));
  const args = { manager: f.store.managerBinding, itemId: "prior-review", workflow: "pipeline" as const, limit: 2, target: "main", branch: "work-one", launchKey: "history-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  expect(() => f.store.reserveManagerRun(args)).toThrow("remaining inherited review limit");
  expect(f.store.reserveManagerRun({ ...args, limit: 1 }).run.limit).toBe(1);
  f.store.close();
});

test("verified completion holds its worktree until original worker termination is verified", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "verify-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "verify-capture", eventId: "verify-event", rows: [{ id: "one", expectedRevision: null, fields: fields("One") }, { id: "two", expectedRevision: null, fields: fields("Two") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "one", workflow: "pipeline" as const, limit: 2, target: "main", branch: "work-one", launchKey: "verify-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  const location = { kind: "tern", blockId: "pane-1", pid: 123 };
  f.store.acceptManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, location });
  const head = "a".repeat(40);
  const review = { reviewId: "review-1", launchKey: args.launchKey, head, reviewerId: "reviewer", invocationId: "job-1" };
  f.store.reserveManagerReview({ manager: f.store.managerBinding, launchKey: review.launchKey, reviewId: review.reviewId, head: review.head });
  f.store.bindManagerReview({ manager: f.store.managerBinding, reviewId: review.reviewId, reviewerId: review.reviewerId, invocationId: review.invocationId });
  await f.store.settleManagerReview({ manager: f.store.managerBinding, reviewId: review.reviewId, verify: async () => ({ ...review, verdict: "approve" }) });
  f.store.settleManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, state: "reported", outcome: { claim: "complete" } });
  const evidence = { launchKey: args.launchKey, itemId: args.itemId, location, repository: args.repository, worktree: args.worktree, target: args.target, head, prNumber: 42, prState: "MERGED", prDraft: false, mergeCommit: "c".repeat(40), review: { reviewId: "review-1", reviewerId: "reviewer", invocationId: "job-1", head, verdict: "approve", rounds: 1 } };
  const next = { ...args, itemId: "two", launchKey: "next-run" };
  await expect(f.store.completeManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, verify: async () => null })).rejects.toThrow();
  await expect(f.store.completeManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, verify: async () => ({ ...evidence, location: { ...location, pid: 456 } }) })).rejects.toThrow();
  await expect(f.store.completeManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, verify: async () => ({ ...evidence, review: { ...evidence.review, head: "b".repeat(40) } }) })).rejects.toThrow();
  expect(() => f.store.reserveManagerRun(next)).toThrow();
  const completed = await f.store.completeManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, verify: async () => evidence });
  expect(completed.state).toBe("completed");
  expect(f.store.queueItems().find((item) => item.id === "one")?.status).toBe("MERGED");
  expect(f.store.snapshot().queueRevisions.find((item) => item.id === "one")?.revision).toBe(2);
  expect(() => f.store.reserveManagerRun(next)).toThrow();
  f.store.close();
  const reopened = openStore({ path: f.path, scope: f.scope, owner: f.owner, now: () => 1200 });
  reopened.bindEmployee({ manager: reopened.managerBinding, binding: { ...reopened.managerBinding, assignment: null, source: source("manager") } });
  expect(() => reopened.reserveManagerRun({ ...next, manager: reopened.managerBinding })).toThrow();
  const proof = { launchKey: args.launchKey, itemId: args.itemId, location, status: "terminated", evidence: "native exit record" };
  await expect(reopened.releaseManagerRun({ manager: reopened.managerBinding, launchKey: args.launchKey, verify: async () => ({ ...proof, location: { ...location, pid: 999 } }) })).rejects.toThrow();
  const released = await reopened.releaseManagerRun({ manager: reopened.managerBinding, launchKey: args.launchKey, verify: async () => proof });
  expect(released.state).toBe("completed");
  expect(released.completion).toEqual(completed.completion);
  expect(reopened.reserveManagerRun({ ...next, manager: reopened.managerBinding }).created).toBe(true);
  expect(() => reopened.reserveManagerRun({ ...args, manager: reopened.managerBinding, launchKey: "duplicate-one" })).toThrow();
  reopened.close();
});

test("a verified terminal run releases its repository without approving or replaying the item", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "terminal-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "terminal-capture", eventId: "terminal-event", rows: [{ id: "one", expectedRevision: null, fields: fields("One") }, { id: "two", expectedRevision: null, fields: fields("Two") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "one", workflow: "pipeline" as const, limit: 2, target: "main", branch: "work-one", launchKey: "terminal-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  const location = { kind: "tern", blockId: "pane-1", pid: 123 };
  f.store.acceptManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, location });
  f.store.settleManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, state: "failed", outcome: { reason: "failed" } });
  const proof = { launchKey: args.launchKey, itemId: args.itemId, location, status: "terminated", evidence: "native exit record", outcome: "failed-no-effect" };
  const next = { ...args, itemId: "two", launchKey: "next-run" };
  await expect(f.store.releaseManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, verify: async () => ({ ...proof, location: { ...location, pid: 456 } }) })).rejects.toThrow();
  expect(() => f.store.reserveManagerRun(next)).toThrow();
  const released = await f.store.releaseManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, verify: async () => proof });
  expect(released.state).toBe("released");
  expect(f.store.reserveManagerRun(next).created).toBe(true);
  expect(() => f.store.reserveManagerRun({ ...args, launchKey: "replay" })).toThrow();
  f.store.close();
});

test("completion verification cannot settle a run changed while the verifier was pending", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "verify-race", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "verify-race-capture", eventId: "verify-race", rows: [{ id: "race", expectedRevision: null, fields: fields("Race") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "race", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "race-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  const location = { kind: "tern", blockId: "pane-1", pid: 123 };
  f.store.acceptManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, location });
  const head = "a".repeat(40);
  const evidence = { launchKey: args.launchKey, itemId: args.itemId, location, repository: args.repository, worktree: args.worktree, target: args.target, head, prNumber: 42, prState: "MERGED", prDraft: false, mergeCommit: "c".repeat(40), review: { reviewId: "review-1", reviewerId: "reviewer", invocationId: "job-1", head, verdict: "approve", rounds: 1 } };
  const pending = Promise.withResolvers<unknown>();
  const completion = f.store.completeManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, verify: () => pending.promise });
  f.store.settleManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, state: "uncertain", outcome: "lost" });
  pending.resolve(evidence);
  await expect(completion).rejects.toThrow("changed during completion verification");
  expect(f.store.managerRuns()[0]?.state).toBe("uncertain");
  f.store.close();
});

test("quarantined imported legacy work cannot be resumed by ordinary capture", () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "import-event", input: "legacy", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "import-capture", eventId: "import-event", rows: [{ id: "old", expectedRevision: null, fields: { ...fields("Old"), status: "NEEDS_DECISION", legacy_import: { migrationId: "old", original: { status: "RUNNING" } } } }], receipt: "imported" } });
  expect(() => f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "unsafe-resume", eventId: "import-event", rows: [{ id: "old", expectedRevision: 1, fields: { status: "QUEUED", legacy_import: null } }], receipt: "resume" } })).toThrow("reconciliation");
  expect(f.store.queueItems()[0]?.status).toBe("NEEDS_DECISION");
  f.store.close();
});

test("durable reviews require a correlated verifier and retain budget across restart", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "review-direct", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "review-direct-capture", eventId: "review-direct", rows: [{ id: "item", expectedRevision: null, fields: fields("Review") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "item", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "review-direct-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: f.store.managerBinding, launchKey: args.launchKey, location: { kind: "tern", blockId: "one", pid: 42 } });
  const head = "a".repeat(40);
  const request = { manager: f.store.managerBinding, launchKey: args.launchKey, reviewId: "review-1", head, reviewerId: "reviewer", invocationId: "job-1" };
  expect(f.store.reserveManagerReview(request)).toMatchObject({ state: "active", reviewerId: null, invocationId: null });
  await expect(f.store.settleManagerReview({ manager: f.store.managerBinding, reviewId: request.reviewId, verify: async () => null })).rejects.toThrow("native identity");
  expect(f.store.reserveManagerReview(request).state).toBe("active");
  expect(() => f.store.reserveManagerReview({ ...request, reviewId: "review-2" })).toThrow();
  expect(f.store.bindManagerReview({ manager: f.store.managerBinding, reviewId: request.reviewId, reviewerId: request.reviewerId, invocationId: request.invocationId }).invocationId).toBe("job-1");
  expect(() => f.store.bindManagerReview({ manager: f.store.managerBinding, reviewId: request.reviewId, reviewerId: request.reviewerId, invocationId: "other" })).toThrow();
  const result = { reviewId: request.reviewId, launchKey: args.launchKey, head, reviewerId: request.reviewerId, invocationId: request.invocationId, verdict: "approve" };
  await expect(f.store.settleManagerReview({ manager: f.store.managerBinding, reviewId: request.reviewId, verify: async () => ({ ...result, invocationId: "wrong" }) })).rejects.toThrow();
  expect((await f.store.settleManagerReview({ manager: f.store.managerBinding, reviewId: request.reviewId, verify: async () => result })).verdict).toBe("approve");
  expect(() => f.store.reserveManagerReview({ ...request, reviewId: "review-2" })).toThrow();
  f.store.close();
});


test("verified termination permits retry with the original review budget", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "retry-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "retry-capture", eventId: "retry-event", rows: [{ id: "retry", expectedRevision: null, fields: fields("Retry") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "retry", workflow: "pipeline" as const, limit: 2, target: "main", branch: "work-one", launchKey: "retry-first", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  const location = { kind: "tern", blockId: "first", pid: 1 };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: args.launchKey, location });
  const head = "a".repeat(40);
  f.store.reserveManagerReview({ manager: args.manager, launchKey: args.launchKey, reviewId: "first-review", head });
  f.store.bindManagerReview({ manager: args.manager, reviewId: "first-review", reviewerId: "reviewer", invocationId: "job" });
  await f.store.settleManagerReview({ manager: args.manager, reviewId: "first-review", verify: async () => ({ reviewId: "first-review", launchKey: args.launchKey, head, reviewerId: "reviewer", invocationId: "job", verdict: "changes-requested" }) });
  f.store.settleManagerRun({ manager: args.manager, launchKey: args.launchKey, state: "failed", outcome: "failed" });
  expect(() => f.store.reserveManagerRun({ ...args, launchKey: "retry-second" })).toThrow();
  await f.store.releaseManagerRun({ manager: args.manager, launchKey: args.launchKey, verify: async () => ({ launchKey: args.launchKey, itemId: args.itemId, location, status: "terminated", evidence: "native exit", outcome: "failed-no-effect" }) });
  expect(() => f.store.reserveManagerRun({ ...args, launchKey: "retry-second", target: "other" })).toThrow();
  expect(f.store.reserveManagerRun({ ...args, launchKey: "retry-second" }).created).toBe(true);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: "retry-second", location: { kind: "tern", blockId: "second", pid: 2 } });
  f.store.reserveManagerReview({ manager: args.manager, launchKey: "retry-second", reviewId: "second-review", head });
  f.store.bindManagerReview({ manager: args.manager, reviewId: "second-review", reviewerId: "reviewer-2", invocationId: "job-2" });
  await f.store.settleManagerReview({ manager: args.manager, reviewId: "second-review", verify: async () => ({ reviewId: "second-review", launchKey: "retry-second", head, reviewerId: "reviewer-2", invocationId: "job-2", verdict: "changes-requested" }) });
  expect(() => f.store.reserveManagerReview({ manager: args.manager, launchKey: "retry-second", reviewId: "third-review", head })).toThrow();
  f.store.close();
});


test("migration reports an uncertain manager run as blocked", () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "migration-run-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "migration-run-capture", eventId: "migration-run-event", rows: [{ id: "item", expectedRevision: null, fields: fields("Item") }], receipt: "captured" } });
  f.store.reserveManagerRun({ manager: f.store.managerBinding, itemId: "item", workflow: "pipeline", limit: 2, target: "main", branch: "work-one", launchKey: "migration-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot });
  f.store.settleManagerRun({ manager: f.store.managerBinding, launchKey: "migration-run", state: "uncertain", outcome: "unknown" });
  const receipt = f.store.migrateManagerQueue({ manager: f.store.managerBinding, migrationId: "migration-run-check" });
  expect(receipt.alreadyManaged).not.toContain("item");
  expect(receipt.blocked).toContainEqual(expect.objectContaining({ itemId: "item" }));
  f.store.close();
});


test("termination cannot release a run past a conflicting pending queue write", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "pending-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "pending-capture", eventId: "pending-event", rows: [{ id: "item", expectedRevision: null, fields: fields("Item") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "item", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "pending-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  const location = { pane: "one" };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: args.launchKey, location });
  const db = new Database(f.path);
  db.query("INSERT INTO records(kind,id,payload) VALUES(?,?,?)").run("intent", "conflicting-pending", JSON.stringify({ file: "queue.json", before: "different", after: "also different", state: "pending", capture: null }));
  db.close();
  await expect(f.store.releaseManagerRun({ manager: args.manager, launchKey: args.launchKey, verify: async () => ({ launchKey: args.launchKey, itemId: args.itemId, location, status: "terminated", evidence: "native exit" }) })).rejects.toThrow("conflicts");
  expect(f.store.managerRuns()[0]?.state).toBe("accepted");
  f.store.close();
});


test("progress reports do not stop a live run from reserving and binding review", () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "report-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "report-capture", eventId: "report-event", rows: [{ id: "item", expectedRevision: null, fields: fields("Item") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "item", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "report-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: args.launchKey, location: { pane: "one" } });
  expect(f.store.settleManagerRun({ manager: args.manager, launchKey: args.launchKey, state: "reported", outcome: "working" }).state).toBe("accepted");
  f.store.reserveManagerReview({ manager: args.manager, launchKey: args.launchKey, reviewId: "report-review", head: "a".repeat(40) });
  f.store.settleManagerRun({ manager: args.manager, launchKey: args.launchKey, state: "reported", outcome: "reviewing" });
  expect(f.store.bindManagerReview({ manager: args.manager, reviewId: "report-review", reviewerId: "reviewer", invocationId: "invocation" }).state).toBe("active");
  expect(() => f.store.reserveManagerRun({ ...args, launchKey: "duplicate" })).toThrow();
  f.store.close();
});


test("progress reports do not invalidate in-flight review verification", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "report-race-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "report-race-capture", eventId: "report-race-event", rows: [{ id: "item", expectedRevision: null, fields: fields("Item") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "item", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "report-race-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: args.launchKey, location: { pane: "one" } });
  const head = "a".repeat(40);
  f.store.reserveManagerReview({ manager: args.manager, launchKey: args.launchKey, reviewId: "report-race-review", head });
  f.store.bindManagerReview({ manager: args.manager, reviewId: "report-race-review", reviewerId: "reviewer", invocationId: "invocation" });
  const pending = Promise.withResolvers<unknown>();
  const settlement = f.store.settleManagerReview({ manager: args.manager, reviewId: "report-race-review", verify: () => pending.promise });
  f.store.settleManagerRun({ manager: args.manager, launchKey: args.launchKey, state: "reported", outcome: "still running" });
  pending.resolve({ reviewId: "report-race-review", launchKey: args.launchKey, head, reviewerId: "reviewer", invocationId: "invocation", verdict: "approve" });
  expect((await settlement).verdict).toBe("approve");
  f.store.close();
});

test("manager input reserves once and fences uncertain delivery across restart", () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "input-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "input-capture", eventId: "input-event", rows: [{ id: "item", expectedRevision: null, fields: fields("Item") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "item", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "input-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: args.launchKey, location: { pane: "one" } });
  const input = { manager: args.manager, launchKey: args.launchKey, messageId: "message-1", text: "continue" };
  expect(f.store.reserveManagerInput(input)).toMatchObject({ created: true, receipt: { state: "sending" } });
  expect(f.store.reserveManagerInput(input).created).toBe(false);
  expect(() => f.store.reserveManagerInput({ ...input, text: "other" })).toThrow();
  f.store.close();
  const reopened = openStore({ path: f.path, scope: f.scope, owner: f.owner, now: () => 1200 });
  reopened.bindEmployee({ manager: reopened.managerBinding, binding: { ...reopened.managerBinding, assignment: null, source: source("manager") } });
  expect(reopened.reserveManagerInput({ ...input, manager: reopened.managerBinding })).toMatchObject({ created: false, receipt: { state: "uncertain" } });
  expect(() => reopened.settleManagerInput({ manager: reopened.managerBinding, launchKey: args.launchKey, messageId: input.messageId, state: "delivered" })).toThrow();
  reopened.close();
});

test("manager input delivered receipt is immutable and exact replay never resends", () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "delivered-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "delivered-capture", eventId: "delivered-event", rows: [{ id: "item", expectedRevision: null, fields: fields("Item") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "item", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "delivered-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: args.launchKey, location: { pane: "one" } });
  const input = { manager: args.manager, launchKey: args.launchKey, messageId: "message-1", text: "continue" };
  f.store.reserveManagerInput(input);
  expect(f.store.settleManagerInput({ manager: args.manager, launchKey: args.launchKey, messageId: input.messageId, state: "delivered" }).state).toBe("delivered");
  expect(f.store.reserveManagerInput(input)).toMatchObject({ created: false, receipt: { state: "delivered" } });
  expect(() => f.store.settleManagerInput({ manager: args.manager, launchKey: args.launchKey, messageId: input.messageId, state: "uncertain" })).toThrow();
  f.store.close();
});


test("worker termination releases the repository but not an uncertain item", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "unknown-exit", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "unknown-exit-capture", eventId: "unknown-exit", rows: [{ id: "one", expectedRevision: null, fields: fields("One") }, { id: "two", expectedRevision: null, fields: fields("Two") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "one", workflow: "pipeline" as const, limit: 2, target: "main", branch: "work-one", launchKey: "unknown-exit-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  const location = { pane: "one" };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: args.launchKey, location });
  f.store.settleManagerRun({ manager: args.manager, launchKey: args.launchKey, state: "failed", outcome: "unverified failure report" });
  const stopped = await f.store.releaseManagerRun({ manager: args.manager, launchKey: args.launchKey, verify: async () => ({ launchKey: args.launchKey, itemId: args.itemId, location, status: "terminated", evidence: "native exit" }) });
  expect(stopped.state).toBe("uncertain");
  expect(() => f.store.reserveManagerRun({ ...args, launchKey: "retry" })).toThrow();
  expect(f.store.reserveManagerRun({ ...args, itemId: "two", launchKey: "other" }).created).toBe(true);
  f.store.close();
});

test("unstarted runs release only after verified no-dispatch and process closure", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "not-started-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "not-started-capture", eventId: "not-started-event", rows: [{ id: "item", expectedRevision: null, fields: fields("Item") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "item", workflow: "pipeline" as const, limit: 2, target: "main", branch: "work-one", launchKey: "not-started-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  f.store.settleManagerRun({ manager: args.manager, launchKey: args.launchKey, state: "uncertain", outcome: "startup failure" });
  await expect(f.store.releaseUndispatchedManagerRun({ manager: args.manager, launchKey: args.launchKey, verify: async () => ({ launchKey: "wrong", itemId: args.itemId, status: "not-dispatched", evidence: "closed before prompt" }) })).rejects.toThrow();
  expect(() => f.store.reserveManagerRun({ ...args, launchKey: "retry" })).toThrow();
  const released = await f.store.releaseUndispatchedManagerRun({ manager: args.manager, launchKey: args.launchKey, verify: async () => ({ launchKey: args.launchKey, itemId: args.itemId, status: "not-dispatched", evidence: "original process closed before prompt submission" }) });
  expect(released.state).toBe("released");
  expect(f.store.reserveManagerRun({ ...args, launchKey: "retry" }).created).toBe(true);
  f.store.close();
});

test("invalid correlated terminal review can retry without consuming a round", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "invalid-review-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "invalid-review-capture", eventId: "invalid-review-event", rows: [{ id: "item", expectedRevision: null, fields: fields("Item") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "item", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "invalid-review-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: args.launchKey, location: { pane: "one" } });
  const head = "a".repeat(40);
  const review = { manager: args.manager, launchKey: args.launchKey, reviewId: "invalid-review", head };
  f.store.reserveManagerReview(review);
  f.store.bindManagerReview({ manager: args.manager, reviewId: review.reviewId, reviewerId: "reviewer", invocationId: "invoke-1" });
  const evidence = { reviewId: review.reviewId, launchKey: args.launchKey, head, reviewerId: "reviewer", invocationId: "invoke-1", status: "invalid", evidence: "original terminal transcript malformed" };
  await expect(f.store.failManagerReview({ manager: args.manager, reviewId: review.reviewId, verify: async () => ({ ...evidence, invocationId: "wrong" }) })).rejects.toThrow();
  expect(() => f.store.reserveManagerReview({ ...review, reviewId: "next-review" })).toThrow();
  expect((await f.store.failManagerReview({ manager: args.manager, reviewId: review.reviewId, verify: async () => evidence })).state).toBe("failed");
  expect(() => f.store.reserveManagerReview(review)).toThrow();
  expect(f.store.reserveManagerReview({ ...review, reviewId: "next-review" }).state).toBe("active");
  expect(() => f.store.bindManagerReview({ manager: args.manager, reviewId: "next-review", reviewerId: "reviewer", invocationId: "invoke-1" })).toThrow();
  f.store.close();
});

test("review cancellation requires verified no-dispatch and leaves original key fenced", async () => {
  const f = fixture();
  f.store.recordIntake({ manager: f.store.managerBinding, event: { eventId: "cancel-review-event", input: "request", amendItemIds: [] } });
  f.store.captureIntake({ architect: f.store.managerBinding, capture: { captureId: "cancel-review-capture", eventId: "cancel-review-event", rows: [{ id: "item", expectedRevision: null, fields: fields("Item") }], receipt: "captured" } });
  const args = { manager: f.store.managerBinding, itemId: "item", workflow: "hotfix" as const, limit: 1, target: "main", branch: "work-one", launchKey: "cancel-review-run", repository: f.scope.boundRoot, worktree: f.scope.boundRoot };
  f.store.reserveManagerRun(args);
  f.store.acceptManagerRun({ manager: args.manager, launchKey: args.launchKey, location: { pane: "one" } });
  const review = { manager: args.manager, launchKey: args.launchKey, reviewId: "cancel-review", head: "a".repeat(40) };
  f.store.reserveManagerReview(review);
  await expect(f.store.cancelManagerReview({ manager: args.manager, reviewId: review.reviewId, verify: async () => ({ reviewId: "wrong", launchKey: args.launchKey, status: "not-dispatched", evidence: "no native invocation" }) })).rejects.toThrow();
  expect(() => f.store.reserveManagerReview({ ...review, reviewId: "next-review" })).toThrow();
  expect((await f.store.cancelManagerReview({ manager: args.manager, reviewId: review.reviewId, verify: async () => ({ reviewId: review.reviewId, launchKey: args.launchKey, status: "not-dispatched", evidence: "host rejected before invocation" }) })).state).toBe("cancelled");
  expect(() => f.store.reserveManagerReview(review)).toThrow();
  expect(f.store.reserveManagerReview({ ...review, reviewId: "next-review" }).state).toBe("active");
  f.store.close();
});
