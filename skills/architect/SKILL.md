---
name: architect
description: Use when designing before implementing — sketching types, signatures, and module structure for non-trivial work where jumping to code would lock in the wrong shape. Synthesizes parallel candidate designs, implements against the chosen sketch, scraps it when implementation proves it wrong.
---

# Architect

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), then continue with this skill's in-process path. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.

Design before implementing. Sketch types, function signatures, class shapes, and module boundaries with `not implemented` bodies and pseudocode. Synthesize across multiple candidate perspectives, then fill in code against the chosen sketch. If implementation proves the sketch wrong, throw it out and redesign. Complements `topic-research` (prior-art input to Phase B), `code-quality-audit` and `architecture-audit` (grounding evidence for Phase A), and `pr-review-toolkit` (adversarial pressure in Phase C).

## Start

Open a todolist with one entry per phase before starting.

1. Ground
2. Sketch
3. Agree
4. Implement
5. Scrap

## Phase A: Ground the problem

Build a real mental model of every system the new code touches. Read the relevant subsystems and trace them: entry points, data flow, ownership, invariants.

Naming a file isn't grounding. Produce the traced model. If the design redefines ownership or layering, also record the existing shape's rationale as a constraint, not a guess.

Skip Phase A only when the work is genuinely greenfield with no surrounding system to integrate.

## Planning-only engagements

When the requested deliverable is a plan rather than implementation, stop after grounding, comparing alternatives, and synthesizing the rollout; do not create scaffolds, edit the repository, or run tests/builds/generators unless separately authorized. Still compare structurally distinct approaches, but use independent delegated candidates only when the task's scope and tools permit; otherwise state the candidates and trade-offs directly rather than implying independent review occurred.

**Answer "how much work is this" with the lift, never a duration.** This owner rejects timeframes outright —
"stop giving me timeframes, I just want to know what the lift is". Give the change sites, each site's class
(drop / rewrite / new), the count of them per area, the blockers, and what one vertical slice would prove; a
week/day estimate in that answer is noise and reads as avoidance. If a schedule is genuinely asked for, say
what has to be true first and let them do the arithmetic.

**Keep one decision file, and rewrite it in place.** Locked choices go to a single `decisions.md` the lanes
read (platform, identity, network surface, data encodings, background work, toolchain, delivery, repo shape,
and an explicit "still open" list). When a decision changes, replace the sentence — never leave a
"superseded" note beside the old text, because the next agent reads the description as current state and
inherits the contradiction. Every brief handed to a coding lane points at that file so settled ground cannot
be re-litigated mid-run.

Ground every status claim in evidence you can actually read. Verify PR metadata through an authenticated GitHub/API read; if only a local branch or `refs/pull/<n>/head` is accessible, report only that ref and head hash, not title, open state, author, base, or CI. Label meeting notes and user-provided statements as such, and separate unverified topology, runtime, traffic, and release assumptions from repository facts. Before handing off a plan, copy it from temporary scratch to a durable path outside the working tree, verify the copy, and confirm the repository remains unchanged.

**Scope from evidence, not from the tracker's state column.** A ticket marked In Progress can have no branch, no
code and no deployed resource behind it, and its parent epic can be closed Done while none of it exists. Read the
epic, its spec sibling, its children and its comments for the intended shape, then settle each claimed deliverable
against the repos (`gh pr list`, branch existence, the files actually on the default branch) and against the
provider census in `deployment-verification`. Report claimed-but-absent work as its own line: it changes the plan,
not the prose.

**Settle liveness before you estimate a migration.** One four-layer status census decides whether the work contains
data motion at all. With no deployed resource there is no backfill, no dual-run, no freeze window and no cutover:
build the new schema fresh from the domain model and delete those packages outright. This check usually removes the
largest planned cost, so it runs first, not as a footnote.

**Refresh the checkout before you read it as evidence.** A clone can sit hundreds of commits behind its remote, and
every grep against it then describes the past: a module that looks like an empty skeleton grows a full route table
one `git merge --ff-only` later. Check `git status -sb` or `git rev-list --count HEAD..@{u}` first, refresh, re-read,
and only then say what a repo does or does not contain.

**Shape the breakdown as packages with a lift, not a narrative.** One table: package, lift (S/M/L or change-site
counts, never durations), dependencies, and what it unblocks. Sequence so the thinnest vertical slice unblocks the
dependent application first, then parallelize the rest. Close with the decisions only the owner can settle (repo
shape, MVP surface, what deliberately stays on a different runtime) and the risks that would change the design.

## Phase B: Sketch

Dispatch at least two parallel `task` subagents (fresh sessions, no shared memory). Each produces one candidate design package shaped per `references/rationale-template.md`, prompted with `references/runner-prompt.md` plus the Phase A grounding artifacts. Give each runner an isolated working directory — a git worktree when available, otherwise a per-runner subdirectory. When prior art could settle a shape decision, run `topic-research` first and feed its verdicts in as candidate-screening input.

Design it twice. Require at least two structurally distinct candidates before synthesis, even when the first looks sufficient. Whole-shape alternatives, not point fixes inside one shape.

Screen every candidate against `references/design-red-flags.md` before synthesis. Assume the next contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repo.

Compare viable candidates on interface depth. Prefer the design that hides more complexity behind a smaller, simpler public surface. A rich interface can keep call chains short by concentrating capability instead of scattering it across layers.

Synthesize the candidates into one design package. The synthesis decision populates the rationale's "Synthesis decision" section.

## Phase C: Agree (opt-in)

Default: proceed directly to implementation with the synthesized design. No human checkpoint.

Opt in to a checkpoint when the invoker explicitly asks ("with checkpoint", "stop and show me before implementing", or similar). Then surface the synthesized design and pause for sign-off.

The synthesis can ship as its own scaffold-first commit either way; planned, scoped breakage during fill-in is fine. For adversarial pressure on the design before implementing, run the `pr-review-toolkit` fight protocol with scope set to the sketch (angles plus club to verdict, findings mapped to design risk).

If the human pushes back on the shape (in a checkpoint or after the fact), treat that as Phase A evidence. Re-ground and re-run Phase B before writing more code.

## Phase D: Implement against the sketch

Replace `not implemented` bodies with code, pseudocode with logic. The synthesized sketch is the contract.

Deviations from the sketch are signal worth surfacing, not friction to absorb silently. If a function needs a parameter the sketch didn't anticipate, ask whether the sketch was wrong, the requirement was missed, or the implementation is overreaching.

## Phase E: Scrap when the architecture is wrong

If implementation keeps producing friction the sketch can't absorb, throw the sketch out. Don't bolt fixes onto a wrong design — fix the root shape.

The signal is a *pattern*, not single instances. Tells:

- The same shape of workaround appearing repeatedly across unrelated code.
- Multiple unrelated edge cases that all need special-case branches.
- Types that need escape hatches (`any`, casts, optional fields always set in practice) to compile.
- The "we need a lock" reflex when the sketch said the state wasn't shared.
- Callers having to know the abstraction's internal rules to use it.
- Two or more independent Phase D deviations of the same shape across the implementation.

Use judgment. A few edge cases don't condemn an architecture. Some problems are legitimately complex. Complexity in the data is not complexity in the design.

When you scrap:

1. Re-trace what's been built (Phase A over the new code).
2. Redesign as if the new constraints had been day-one assumptions.
3. Subtract before adding. The new sketch should be smaller than the old one before it grows.
4. Return to Phase B and re-sketch.

## Outputs

The caller's usage is written first and the type sketch derived from it. One file with new types and signatures for small changes. Module map plus type definitions for larger work. The rationale ships alongside, shaped per `references/rationale-template.md`, including the usage sketch and the synthesis decision.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
