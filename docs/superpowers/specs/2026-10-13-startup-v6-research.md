# Startup V6: Oh My Pi research

**Status:** Source research and an isolated interface probe on installed OMP 18.8.9. No persistent runtime implementation, installation, upgrade, or model-backed probe was performed.

## Answer

Use an OMP companion extension for durable staffing, inboxes, scheduling, and lifecycle receipts. Keep the existing skills as canonical persona and procedure sources. Reuse native task dispatch, yield, parked sessions, and revival. A prompt that repeatedly says "loop" cannot supply durable delivery or keep an exited host running.

## Version provenance

| Surface | Observed version/source |
|---|---|
| Executable returned by `command -v omp` | `/Users/jarredparr/.bun/bin/omp`, a compiled executable |
| `omp --version` | `omp/18.8.9` |
| Exact v18.8.9 source | `fa5ff4a3a977a28b93d025f4cf50f046e019f18c` |
| Upstream main inspected | `687892d1046ecaf18829b45f5b86928a308258f4`, version 18.10.4 |
| Separate global npm source package | `@oh-my-pi/pi-coding-agent` 17.4.1 |
| jp-skills baseline | V5.0.1, `c9b89bd6e4fc4bd06feaad747ddddbf121b3e8bc` |

The global npm package is not evidence for the compiled binary's API. Extensions can access the running build's injected namespace through their factory argument's `pi.pi`. The probe below confirmed that the imported lifecycle manager uses the running build's registry. A future implementation should pin type dependencies and retain this compatibility check. [Extension API type](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/extensibility/extensions/types.ts#L1377), [loader injection](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/extensibility/extensions/loader.ts#L451)

## Installed interface probe: 2026-10-13

The installed CLI exposes embedded documentation through `omp read omp://tools/task.md`, `omp read omp://tools/wait.md`, and `omp read omp://extensions.md`. `omp agents` exposes agent-definition unpacking, not a dedicated hiring command. No custom profiles were found in this repository's `.omp/agent/agents` directory.

Read-only `omp config get <key> --json` returned:

| Setting | Installed value | Meaning |
|---|---|---|
| `task.batch` | `true` | One native call can create multiple agents, one per task item. |
| `async.enabled` | `true` | Task agents can run in the background. |
| `task.maxConcurrency` | `32` | Execution capacity, not a durable staff count. |
| `task.agentIdleTtlMs` | `420000` | Idle agents park after seven minutes and can revive when messaged/resumed. Zero disables idle parking; it does not survive host exit. |

An isolated RPC process loaded a temporary extension with an offline custom provider whose stream function throws on any model request. It used a separate agent-data directory and empty working directory, disabled automatic extensions, skills, rules, LSP, memory, cache warming, and titles, and did not modify the normal OMP profile. The probe invoked its own slash command instead of asking a model to act.

Inside that command, the extension accessed the real root session through injected `pi.pi.AgentRegistry`. It executed its registered `task` wrapper, which delegated through `ctx.invokeTool` with an intentionally invalid empty batch. Native validation rejected the batch before spawning. It then awaited a managed timeout and two interval ticks, cleared the interval, wrote the report, and requested shutdown. The driver kept RPC stdin open until the report existed, then closed it. The final process exited with code 0 and empty stderr.

Observed report:

```json
{
  "version": "18.8.9",
  "actor": {"kind": "main", "id": "Main", "name": "main", "depth": 0},
  "ctxSessionId": "01a136fa-5d69-76a8-9cca-af7bd15c04cf",
  "registrySessionId": "01a136fa-5d69-76a8-9cca-af7bd15c04cf",
  "namespace": {
    "AgentRegistry": "function",
    "TaskTool": "function",
    "createAgentSession": "function",
    "runSubprocess": "function",
    "runSubagentFollowUpTurn": "function"
  },
  "lifecycle": {
    "ensureLive": "function",
    "park": "function",
    "ensurePersistedRoster": "function",
    "usesNativeRegistry": true
  },
  "context": {
    "setInterval": "function",
    "setTimeout": "function",
    "rootAgentsSpawn": "undefined",
    "timerFired": true,
    "intervalTicks": 2
  },
  "nativeTaskWrapper": {
    "wrapperExecuted": true,
    "delegateAvailable": true,
    "nativeValidation": "Missing `tasks`. Provide at least one task item ({ name?, agent?, task })."
  },
  "modelCalls": 0
}
```

This proves that the compiled binary exposes the proposed integration seam and that same-name delegation, managed timers, and native registry identity work in a running extension. It does not prove valid task-schema compatibility, six successful hires, canonical role loading, actual yield/park/revival, crash recovery, or a deployment monitoring duty. Stage 0 remains open for those operational checks. The temporary extension and isolated profile were removed after recording this evidence.

## Runtime findings

| Finding | Consequence for V6 |
|---|---|
| Native task children finish a turn through `yield`, remain registered, and can park/revive. | Persistence should span bounded turns. Yield is not employee retirement. |
| Native `write agent://<id>` can wake an idle agent or revive a parked one. | Reuse native addressing after storing the durable cue. |
| `read agent://<id>` reads output, not a canonical inbox. | Do not document a nonexistent native inbox URL. |
| Native IRC buffering is process-local, bounded, and distinct from successful context injection. | Own durable messages, claims, and acknowledgements in Startup. |
| `wait()` has no configurable interval and needs an actual wake source. | A repeated wait prompt is not a deployment scheduler. |
| Managed extension timers are session scoped, unref'ed, and cleared on shutdown. | Checks run while the OMP host lives; restarting requires recovery. |
| `session_stop` applies to the main session, not task/subagent sessions. | A root stop hook cannot make every specialist persistent. |
| Native `workpool()` closes on its first complete drain. | It is useful for bounded batches, not the permanent staff roster. |
| OMP can ignore unknown autoload skill names. | Validate source loading and binding, not just the profile's declaration. |

Sources: [native task lifecycle](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/tools/task.md), [IRC bus](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/irc/bus.ts), [write addressing](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/tools/write.md), [native wait](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/tools/wait.md), [managed timers](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/extensibility/extensions/managed-timers.ts), [session lifecycle hooks](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/extensions.md#prompt-and-turn-lifecycle), [workpool contract](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/tools/eval.md#workpool), [agent discovery](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/task-agent-discovery.md)

## Candidates and ranking

These are integration choices within the existing OMP dependency. Repository metadata observed on 2026-10-13: MIT license, 35,313 stars, 3,849 forks, and a same-day upstream version commit. Downloads, dependent counts, maintainer count, and response-time metrics were not verified. Those missing metrics do not distinguish these three options, which use the same project. Existing deployment fit and actual lifecycle semantics determine the ranking. [Repository](https://github.com/can1357/oh-my-pi)

| Rank | Candidate | Verdict |
|---|---|---|
| 1 | Native task dispatch and lifecycle with a durable Startup extension | **Adapt.** Preserve OMP's spawn policy, task capacity, role discovery, and transcript ownership; add staffing and reliable mail. |
| 2 | Programmatic SDK/executor supervisor inside the existing OMP process | **Defer.** Public executor functions exist, but direct calls skip parts of task policy, admission, isolation orchestration, and root observability. |
| 3 | Native eval `workpool()` as the staff primitive | **Reject for staffing.** Full drain closes the pool; its queue is process-local and creation does not mean hire exactly six durable employees. |

The two independent architect candidates agreed on durable employee IDs, bounded wake turns, idempotent hiring, and explicit host lifetime. The native candidate preserves more of the existing harness contract. The SDK candidate's deterministic claim/result transaction is retained in the inbox design; its separate execution path is not selected.

## The hiring integration seam

`ctx.invokeTool` delegates only to the native tool with the same name as the extension tool being executed. A new tool named `hire` cannot use it to invoke `task`. A proposed native integration can re-register `task`, accept a typed Startup hire request, derive ordinary native batch parameters, and delegate to the original task implementation. Existing task requests must remain compatible. The installed interface probe demonstrated delegation into native task validation; a complete hire request and ordinary valid task compatibility remain untested. [Same-tool delegation](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/extensions.md#delegating-to-a-native-built-in-ctxinvoketool)

The cleaner dedicated extension spawn facade, `ctx.agents.spawn`, is still an open upstream proposal. Do not write a V6 prompt as though it exists. [OMP issue 2574](https://github.com/can1357/oh-my-pi/issues/2574)

`runSubprocess` and `runSubagentFollowUpTurn` are actual exports through the injected namespace. Their existence alone does not establish drop-in task parity. In particular, direct executor use does not supply the task-level semaphore, dispatch hook, and workspace orchestration. `RPC steer_subagent` also rejects completed or parked entries, so it is not the general resident wake endpoint. [Executor exports](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/task/executor.ts#L3487), [native task dispatch](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/task/structured-subagent.ts), [RPC subagent steering](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/docs/rpc.md#steering-subagents)

After a crash, activating an employee that never obtained a native handle requires another authorized native task invocation. Scheduling a manager turn alone does not guarantee it will dispatch that task. The V6 scope therefore makes automatic unbound-hire recovery a separate native-dispatch feasibility gate, rather than claiming universal autonomous recovery.

## Context findings

- Keep the employee's logical identity stable while native sessions idle, park, or rotate. Persistent staffing does not require an endlessly growing context window.
- Load the complete canonical persona and the shared loop contract, then only that employee's active cue, compact checkpoint, and required artifact references.
- Preserve fresh item execution contexts and native worktree handling for code. Keep the manager's code/log firewall and source-tagged assignment overrides.
- A native isolation workspace can be cleaned or become unavailable, preventing revival. The employee record can persist while its next assignment uses a new recorded native generation. [Persisted revival constraints](https://github.com/can1357/oh-my-pi/blob/fa5ff4a3a977a28b93d025f4cf50f046e019f18c/packages/coding-agent/src/task/persisted-revive.ts)

## Research record and scope deltas

- Providers: `web__run` search, official GitHub source retrieval through `curl`, read-only `gh api` metadata, installed `omp read`/`config`, and an isolated compiled-extension interface probe.
- Queries: `oh-my-pi persistent agents inbox loop task background`; `site:github.com/can1357/oh-my-pi extensions createAgentSession before_subagent_spawn task`; `site:github.com/can1357/oh-my-pi swarm team inbox agent resume`.
- Confidence: high for inspected versioned source and observed installed interfaces; operational hiring, role binding, and persistent-duty compatibility remain unproved until the remaining feasibility gates run.
- Required delta from skills-only V5: an OMP companion extension and transactional local state. No additional agent framework is proposed.
- Scope boundary: initial V6 targets the existing OMP execution host. Monitoring after that host exits requires an explicitly operated host service; the prompts and extension alone cannot supply it.

The proposed contracts, hiring semantics, and release gates are in [the V6 design](2026-10-13-startup-v6-design.md).
