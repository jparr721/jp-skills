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
