# Startup V6 native feasibility gate

- Status: **PASS**
- Gate version: `1`
- Observed: `2026-10-13`
- Runtime: `/Users/jarredparr/.bun/bin/omp`, `omp/18.8.9`
- Official source: `fa5ff4a3a977a28b93d025f4cf50f046e019f18c`
- Process exit: `0`; stderr: empty

## Required checks

| Check | Result |
|---|---|
| `native_completion` | PASS |
| `ordinary_batch_delegation` | PASS |
| `six_actual_child_bindings` | PASS |
| `native_root_correlation` | PASS |
| `canonical_initial_preload` | PASS |
| `canonical_synthetic_context` | PASS |
| `canonical_revived_and_followup_context` | PASS |
| `native_yield_and_idle` | PASS |
| `native_park_and_same_child_revival` | PASS |
| `native_wake_receipts` | PASS |
| `restricted_health_reads` | PASS |
| `unsupported_mutation_and_delegation_denied` | PASS |
| `registry_singleton` | PASS |
| `managed_timers` | PASS |
| `bun_sqlite` | PASS |

## Observed identities

| Native fact | Observed value |
|---|---|
| Root session | `01a1372f-3203-779e-ad6a-b5eae9c90798` |
| Child revived | `gate-2` |
| Child session before and after revival | `01a1372f-328c-76d1-9d6b-6d24915c5dbe` |
| Revival object identity | New live AgentSession, same native AgentRef |
| Native children | `gate-2`, `gate-3`, `gate-5`, `gate-1`, `gate-6`, `gate-4` |
| Provider requests | 41 offline requests; zero network model requests |
| Role source SHA-256 | `61a151335978a596415ffa16c8f3c8d1ba7defc8184fd90641fdee4b17df1d2d` |
| Shared loop SHA-256 | `161269e951d0e63fccddda75641f2abc89a429faa17dd037cb51a90188395bad` |

## Reproduce

```sh
python3 extensions/startup/probes/run-native-probe.py \
  --workspace .superpowers/sdd/2026-10-13-startup-v6/native-scratch/new-run \
  --evidence extensions/startup/probes/native-feasibility-evidence.json.gz
```

- Use a fresh workspace path. The driver keeps RPC stdin open until completion, strips credential/provider environment variables, and uses an isolated agent-data directory and fixture cwd.
- The registered `startup-offline` API emits deterministic provider events. Six ordinary native task items create actual child sessions. The first child response omits `yield`, causing a real native reminder. Subsequent native reads, denied tool calls, and yields occur in child transcripts.
- The canonical DevOps role is loaded from its complete source into the generated project profile. The context hook projects the complete role and the proposed shared loop as developer content on every child provider request. The verifier compares captured context text against the role file and the approved design loop, byte for byte.
- A native lifecycle park detaches one actual session. Native `write agent://<id>` revives it; another native write wakes its idle replacement. Both turns finish through actual `yield`, with native acceptance milestones.
- The root wrapper is re-registered in each child by native extension rebinding. Explicit profile tools alone initially exposed `task`; `session_start` now applies `pi.setActiveTools(["read", "yield"])` to each child, including revival. Actual calls to `write` and nested `task` return `Tool write not found` and `Tool task not found`.

## Evidence

- [Complete captured evidence](../../../extensions/startup/probes/native-feasibility-evidence.json.gz): gzip JSON containing command, checks, full provider contexts, registry events, tool results, six native JSONL transcripts, transcript hashes/headers, and RPC output.
- Evidence SHA-256: `a68b743acafc3ac7f301549484897ea3b144225d34c814102291fb7610365b5b`
- The actual child session headers reference the actual root transcript through `parentSession`; native `parentId` agrees with the runtime actor.
- Registry identity is established by injected `pi.pi.AgentRegistry.global()` plus `AgentLifecycleManager.global().manages(registry) === true`.
- Managed timeouts execute; a managed interval ticks at least twice and is cleared. `bun:sqlite` executes `select 1 as value` and returns `{"value":1}` inside the compiled runtime.

## Scope and limitations

- This gate proves native execution transport, contexts, lifecycle, root correlation, and the local read-only duty path. Deterministic output does not prove model reasoning, role adherence, real deployment connector behavior, durable inbox semantics, crash recovery, or every product role/team composition.
- The fixture preloads the existing DevOps role and proposed shared loop. Product loop skills and persistent Startup runtime remain separate tasks.
- Park/revival preserves the native transcript/session UUID while replacing the live session object. Startup owner epochs and logical employee generations must be owned and fenced by its state layer.
- The successful ordinary batch is the tested task schema shape. Conditional schema arms, Startup hire conversion, and broader task compatibility remain product adapter obligations.
- Explicitly retain restricted catalogs when an extension re-registers a built-in tool. This gate proves the selected `read`/`yield` path and blocks unsupported delegation as well as direct mutation.
