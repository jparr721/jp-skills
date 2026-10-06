---
name: architect
description: Use when designing before implementing — sketching types, signatures, and module structure for non-trivial work where jumping to code would lock in the wrong shape. Synthesizes parallel candidate designs, implements against the chosen sketch, scraps it when implementation proves it wrong.
---

# Architect

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
