# Current-claim settlement

A mistyped UUID made manager retry a PA-report settlement three times. The store reported a missing claim as a native-generation mismatch. The model-facing interface required identity coordination that the authenticated runtime already owned.

## Usage

```ts
startup_claim({});
startup_settle({
  result: {
    id: "observed-report",
    kind: "completed",
    output: "Observed",
    checkpoint: null,
    outgoing: [],
  },
});
```

Retry the original result ID and payload after a lost response. The saved receipt wins even when another claim is now active. Never regenerate a completed result under a different ID.

## Shape and synthesis

The transactional store owns selection: authenticated employee, saved result replay, then the single unresolved own claim. It validates claim ownership and generation before returning a saved result. Fresh settlement additionally requires the current coordinator epoch and active state. Missing, foreign, stale, settled, ambiguous and reconciliation claims have distinct recovery codes. It never picks a different claim to repair an explicit bad ID.

Two candidates were compared: server selection from existing claim/result records, and an opaque native claim cursor with a durable client journal. Server selection is the base because it retains one lifecycle authority and needs no second journal or claim-request protocol. The native candidate contributed the deterministic command latch and stop-continuation guard. An in-memory cursor was rejected because response loss and process restart lose the binding.

The public tool accepts only result. The existing explicit wire request remains an adapter for running old clients; the literal claimId="current" lets those clients avoid copying UUIDs before their next resume. Runtime projection supplies the updated instruction without changing canonical role/loop hashes and fencing all live crews. A stable own-claim state marker inside the existing projection string lets new clients observe recovery while preserving old clients' strict poll schema.

HTTP failures retain error/message and add recovery metadata with retryable=false and a corrective action. The coordinator emits one durable settlement-blocked alert TO manager per failure identity. The native client remembers deterministic rejected requests, independent of polling/re-admission. A duplicate aborts the native turn before another HTTP write, and the bridge suppresses automatic stop/cue wakeups until corrected settlement or observed claim-state change. Result-ID changes alone do not evade rejection; a result replay conflict is the exception because correcting an ID collision can be meaningful. Transport/connection failures are not classified as deterministic settlement rejection.

## Accepted tradeoffs

- Implicit selection relies on one unresolved claim per employee. Violations require explicit recovery, never arbitrary selection.
- Exact replay still requires stable result IDs and payloads; a changed result is a different operation.
- Running legacy clients retain their wire contract. The local abort guard requires loading the new client, so deployment resumes native roots in their original panes and transcripts.
- Rejected-request memory is per native process. A native restart may expose the error once again, while durable manager alerts remain deduplicated.
