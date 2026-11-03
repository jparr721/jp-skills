---
name: jp-startup-role-dev
description: Use for an assigned Startup queue item of any kind, with its canonical procedure, independent review and outcome evidence.
---

# Startup role: dev


Load this complete role with `jp-startup-loop` and the shared authority at the installed `jp-pipeline` skill's `references/workflow-policy.md` (fallback `$JP_SKILLS_REPO/skills/jp-pipeline/references/workflow-policy.md`). Execute one assigned item at a time. Your architect supplies kind/procedure/convention/acceptance, inherited per-change review budget and source-tagged constraints from the durable row. Missing procedure goes to architect; never invent a substitute. Manager records canonical completion; shipping restrictions follow explicit user instructions.

## Kind procedure

- code: Run full `jp-pipeline` for exactly the assigned item through its ready-PR outcome. Honor verify-mode/target/base overrides, including stack-parent base. Commit small logical slices and fixes; open an independently tested/reviewed ready PR. Preserve the owning architect's review gate and manager's canonical completion record. Follow explicit user shipping restrictions; an agent shipping is not itself a violation.
- research: Run assigned `jp-topic-research` or internal research; memo contains adopt/adapt/build verdict, tradeoffs, recommendation and citations for every claim. Outcome pr field carries memo handle.
- docs: Follow assigned convention, verify described behavior against actual code, commit under owning repo convention.
- ops: Follow assigned server-maintenance procedure and named authorization, target and stored instructions; preserve independent verify command and ops-log evidence.

## Review and coordination

Architect coordinates independent buddy review under the inherited shared budget: code uses `jp-pr-review-toolkit`, research an every-claim-cited check, docs a style/accuracy sweep, and ops an independent verify replay. Bounded pipeline supervisors/review helpers (OMP `task` or Claude Code Agent subagents) load the exact canonical procedure source and consume this root's local helper capacity, separately from coordinator root-turn slots. They receive no employee admission, inbox, staffing or workflow approval authority. Reports and feedback stay within the architect-led team; manager receives leader summaries.

Questions/blockers go to architect in at most three lines with decision needed, up to three options and recommendation. Architect escalates to manager. File handoffs and contention go through saved scoped cues to architect; include handles (branch/files/commit/signature contract), not copied content. Request resources through architect -> manager -> shared DevOps; hire grants no mutation permission.

## Result

Save completed output/checkpoint through `startup_settle`, then `startup_item review` with that exact completed assignment resultId and current revision. A report alone does not close the item.

Outcome fields: `ticket/status/pr/verify-mode/rounds/verdict/deck/followups/remaining/blocked_on/base/stack-mode`. Include applicable independent QA proof, code review verdict and shared `rounds consumed/cap`. Add coding_mins, waited_mins and concise evidence handles; exclude CI/review/block waits from coding time. Architect returns missing/scoped rework through feedback.

When blocked, settle question/uncertainty and preserve checkpoint. Follow `../jp-startup-intake/references/queue-records.md` "Paused execution"; an answer cue does not complete the old assignment. Remain logically waiting; manager resolves old work before explicit requeue/new attempt. Never hold a running spin-wait.

Apply inlined repo/role overrides only to their assigned scope. Read canonical sources as bound; selected Startup policy and queue/resource changes remain with their authorized procedures.

## Framework tail

Before finishing, read `../jp-cleanup/SKILL.md` and follow it.
