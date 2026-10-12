---
name: startup-intake
description: Intake protocol — feasibility/doability triage for prompts, Linear ids, and screenshot complaints; writes per-item repo/remote/target/merge-strategy rows to queue.json; only enqueue, async-clarify, or reject-with-reason; assigns kind (code/research/docs/ops) with per-kind acceptance.
---

# Startup intake

Repeatable front door for the queue. Every prompt, Linear id, or screenshot complaint passes feasibility/doability triage before it becomes a `queue.json` row. Dispatched from `skill://startup`; rows consumed by `skill://startup-role-manager`.

## Queue-worthy criteria

An item is queue-worthy when it meets one path:

- **Linear id** (e.g. `SYT-xxx`): fetch the ticket; acceptance criteria come from the ticket.
- **Prompt**: must name the behavior + affected area + acceptance (what done looks like). Vague prompts fail triage, not the worker.
- **Screenshot + complaint**: not intake — route to the `stop-doing` interpret path (see `skill://startup-stop-doing`): mesh QA + architect to derive repro, scope, rule.

Feasibility check: repo exists and is reachable, target is known, merge strategy follows that repo's convention. Doability check: acceptance is testable within one pipeline run.

## Kind assignment

Assign exactly one kind per item: `code | research | docs | ops`. Use the boss's stated kind when given. When the boss states no kind, infer from the request and record the inference in the row:

- code verbs (fix, build, add, refactor, implement) → `code`.
- "should we" / prior-art / options questions → `research`.
- style / accuracy / wording corrections against a named source → `docs`.
- named host / mutation (deploy, restart, migrate, rotate) → `ops`.

Ambiguous across two kinds = async-clarify, never guess silently.

## Per-item record

Each enqueued item is one row in `<home>/startup/queue.json` (home chain: `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`; NEVER `tmp/`) with exactly:

`id, source, status, repo, remote, target, merge-strategy, branch, worktree, report-handle, kind, procedure, convention-source`

`merge-strategy: squash|merge per repo convention` — record the repo's convention at intake; the manager merges with it. `branch`/`worktree` are assigned at dispatch; `report-handle` at outcome. `procedure` names the worker procedure for the kind; `convention-source` names the repo convention or doc source the worker writes against (empty only for research/ops with no convention).

Per-kind acceptance shape:

- code: behavior + affected area + acceptance.
- research: question + decision it unblocks.
- docs: scope + convention source.
- ops: target + mutation + verify command.

## Triage outcomes only

Three outcomes, no fourth:

- **enqueue** — criteria met, kind assigned; write the row, confirm in one line.
- **async-clarify** — near-miss or kind-ambiguous; park the item, ask the boss in one batched message, proceed with the rest of the queue.
- **reject-with-reason** — fails feasibility/doability; one line: what was asked, why it fails, what would make it queue-worthy.

No criteria met and no clarifiable shape → one line back to the boss, nothing written. Never enqueue a placeholder row to "fill in later".

## `startup new` interactive setup

`startup new <name> [--dir <path>]` (default dir = cwd). Bounded — never stalls:

1. List repos found in dir; boss confirms/adds/removes.
2. One confirm per repo for move-or-clone (local path vs remote URL); skip allowed, resume on next invoke.
3. Ask local-test command + production/CI verify path once; per-repo override only on deviation.
4. Write `<dir>/.startup/config.md` (name, purpose, repo list, test/verify map) and per-name state `<home>/startup/<name>/` with `binding.json` (`{name, bound_root}`). Seed DevOps `resources.json` locks from the answers.
5. Never write inside repo dirs; repo `.git` stays clean.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
