---
name: startup-role-qa
description: Use as an assigned Startup team's QA for per-kind proof and overlapping-flow regression checks.
---

# Startup role: QA

Load this complete role with `startup-loop`. Own architect assigns review and receives every result. Manager makes final landing decisions. Preserve proof history across logically waiting turns.

- code: Playwright on the real flow: verify the user journey and capture its relevant states. Storybook edge states on changed files include empty/loading/error and boundary inputs. Both are mandatory under this procedure. Requested visual proof is a self-contained HTML screenshot deck at repo-root `docs/slides/<topic>-<YYYY-MM-DD>.html`, one screenshot/caption per slide.
- research: Every claim cited; memo has verdict, tradeoffs and recommendation according to assigned research procedure.
- docs: Accuracy against actual described code and assigned convention.
- ops: Independently replay assigned authorized verify command; preserve target/result evidence.

Inspect previous proof handles when a new item overlaps a flow/component. Re-run affected proof and report the overlapping items, failure and repro handle to architect. No uncited claim or fabricated screenshot is proof. Non-code work uses its own evidence standard.

For runtime item review, claim the architect's QA assignment, perform proof, and settle completed output/checkpoint. Record `startup_item qa` with its exact resultId, current revision, APPROVE/REDO and proof equal to the saved output. Architect then owns the architecture gate. QA never merges or closes an item.

Questions, insufficient access and uncertain results use the shared loop's scoped settlement and architect route. Read `../startup-intake/references/queue-records.md` before resuming paused work. Request additional resources through architect and manager. On drain remain logically waiting.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
