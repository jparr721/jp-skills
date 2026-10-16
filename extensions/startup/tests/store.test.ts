import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store";

const roots: string[] = [];
afterEach((): void => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root: string = mkdtempSync(join(tmpdir(), "startup-store-"));
  roots.push(root);
  const home: string = join(root, "home");
  const boundRoot: string = join(root, "repo");
  mkdirSync(boundRoot);
  const scope = {
    home,
    boundRoot,
    host: "host",
    name: "test",
    managerSession: "native-manager",
  };
  const owner = { id: "owner", managerGeneration: 1, leaseMs: 1000 };
  const path: string = join(home, "startup", "test", "staff.sqlite");
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
  return { root, home, scope, owner, path, store, user };
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
    rolePath: `/skills/startup-role-${role}/SKILL.md`,
    roleRevision: "rev",
    loopPath: "/skills/startup-loop/SKILL.md",
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
  const next = f.store.claimNext({ employee: t.devBinding });
  if (next === null) throw new Error("No assignment");
  expect(() =>
    f.store.settleClaim({
      employee: t.devBinding,
      claimId: next.claim.id,
      result: {
        ...completed("invalid"),
        outgoing: [cue("bad", "manager", "report")],
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
    outgoing: [cue("question", t.architect, "question")],
  };
  const result = f.store.settleClaim({
    employee: t.devBinding,
    claimId: next.claim.id,
    result: question,
  });
  expect(
    f.store.settleClaim({
      employee: t.devBinding,
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
      employee: t.devBinding,
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
  return join(f.home, "startup", "test", "queue.json");
}

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
  const path: string = join(f.home, "startup", "test", "resources.json");
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
  const path = join(f.home, "startup", "test", "resources.json");
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
  const path = join(f.home, "startup", "test", "resources.json");
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
  const otherPath = join(other.home, "startup", "test", "resources.json");
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
