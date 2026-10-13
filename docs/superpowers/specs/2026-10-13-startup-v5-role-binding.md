# Startup v5 role binding

**Date:** 2026-10-13
**Status:** Implemented in v5.0.0

## Problem

Startup already has canonical manager, worker, architect, QA, DevOps, and PA role skills. Its manager assignment carries task fields, but the dispatch contract only says to use `skill://` references and the repo's harness notes leave role loading to local interpretation. A coding harness can therefore spawn a generic child and give it a newly authored persona prompt. That breaks the role procedures precisely where the manager delegates work. The v5 change makes role identity and task data separate, preserves manager ownership of intake and merges, and ensures an explicit request to coordinate with DevOps survives intake and is carried out before worker fan-out.

## Grounded constraints

- `startup-role-manager` is the sole boss contact and owns intake, queue orchestration, fan-out, outcome enforcement, and merges.
- `startup-intake` owns feasibility and kind-assignment rules but does not need a separate persona or agent.
- Workers are fresh, never merge, and execute one of four procedures under the single `startup-role-dev` persona.
- Architect is a required merge gate. QA and DevOps have separate procedures and triggers.
- Queue state is persistent and used by older installations. Adding an optional `requested_roles` field must not require rewriting existing queue rows.
- Existing role override content is manager-resolved and item-scoped. It cannot replace canonical role behavior.
- The skills repo has five harness registries but no runtime adapter that can guarantee a single spawn API across them.

## Candidates and red-flag screen

### Candidate A: named native role registry

Create named role profiles for every supported harness and pass only structured assignments at dispatch. The source skills stay canonical, and harness profiles bind them by preloading or generated content.

This gives the strongest runtime role identity when a harness has a real named-agent selector. It also creates a five-harness registry, install/update behavior, generated-artifact synchronization, and a per-harness conformance obligation. Codex, Pi, and other dispatch surfaces do not share one guaranteed registration and selection API. A static registry table would become a hand-synced list unless the release added generators and validators.

### Candidate B: portable role-binding contract

Keep the existing skill family and define one binding rule: use a native profile/preload when it actually loads the canonical source; otherwise pass the complete source verbatim in a distinct role-instructions block, with the assignment separate. Persist a dispatch receipt and block if the source cannot be bound.

This fits the repo's one-source-of-truth and harness-neutral design. The dispatch adapter is a skill-level procedure, not a new runtime or fictional API. It makes the current behavior actionable without claiming identical capabilities across harnesses.

### Red flags

- Candidate A risks shallow infrastructure: five adapter registries would expose harness mechanics without a runtime to hide them. It also introduces hand-synced role lists and generated persona drift.
- Candidate B would be shallow if it shipped only a named `dispatchRole` method that no skill runtime implements. The v5 implementation therefore records operational steps in the Startup dispatch reference and does not claim to ship an executable adapter.
- Both candidates must preserve role source as the existing skill. A second handwritten role prompt or per-kind persona is rejected as split ownership.

## Synthesis

Use Candidate B as the base. Adopt Candidate A's stable role IDs and data-only assignment. Keep `startup-role-*.md` as the only persona sources; make native role/profile selection the preferred binding and exact source inclusion the portable fallback. The assignment never supplies persona text. If neither binding works, dispatch is blocked. Do not add five harness configuration trees or a new runtime adapter in a skills-only repository.

Intake remains a manager-owned procedure. New queue rows persist explicit built-in role requests in `requested_roles`; older rows missing the field behave as empty. The manager performs a requested DevOps coordination dispatch after intake and before worker fan-out. DevOps returns `READY`, `NEEDS_INPUT`, or `NO_ACTION`; coordination does not authorize provisioning.

## Research and framework lessons

- Claude Code's subagent configuration supports stable named agents and skill preloading into the subagent context. Lesson: selecting a child and loading its procedure are distinct; a skill name in task text is not equivalent to preload. [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- OpenCode distinguishes named subagent profiles, whose bodies configure the agent, from skills loaded through its skill tool. Lesson: profile selection and skill loading can be separate, so the dispatch contract must verify actual loading rather than discoverability. [OpenCode agents](https://opencode.ai/docs/agents/), [OpenCode skills](https://docs.opencode.ai/docs/skills/)
- LangChain's supervisor/subagent pattern keeps routing in the supervisor and sends bounded task inputs to named specialists. Lesson: the Startup manager should retain intake and merge authority while specialist tasks remain bounded. [LangChain subagents](https://docs.langchain.com/oss/python/langchain/multi-agent/subagents)
- OpenAI's Agents SDK separates agents-as-tools, where the manager remains in control, from handoffs, where the specialist takes over. Lesson: Startup uses the manager-retains-control pattern because its queue and merge authority stay singular. [OpenAI agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)
- Oh My Pi agent definitions can preload named skills before the first child prompt. Lesson: the binding receipt should name the mechanism used, and discovery alone must not be treated as a successful load. [Oh My Pi task agent discovery](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md)

These are framework patterns, not claims that their APIs are interchangeable. The repo ships no runtime adapter, so harness capability is checked at the dispatch point.

## Acceptance criteria

1. Every Startup entry binds `startup-role-manager` before queue handling.
2. Intake runs in the manager context and uses the canonical `startup-intake` procedure.
3. Every specialist dispatch loads the exact canonical role source before task work begins.
4. The task assignment contains no persona rewrite and remains distinct from the role source.
5. Missing or unbindable role instructions block dispatch; there is no unbound generic-agent fallback.
6. Explicit built-in role requests persist on new rows and are all dispatched before being reported complete.
7. Explicit DevOps coordination runs after intake and before worker fan-out; `NO_ACTION` is valid and does not imply provisioning authorization.
8. Each dispatch and result or blocked reason is recorded in the ledger without credentials.
9. Old queue rows lacking `requested_roles` remain valid and require no migration.
10. README, role skills, changelog, and `VERSION` describe the same v5 behavior.

## Validation boundary

The v5 source change is validated by a read-through of the dispatch contract, cross-checks between the manager/intake/DevOps/status instructions, version/changelog consistency, and repository diff checks. No cross-harness runtime evaluation is claimed by this release; each harness must be checked in the active session using its available native binding or the verbatim source path.
