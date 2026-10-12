# Startup kind system (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite 7 landed startup files for the v2 kind system, implementing spec `fcd7104` (Kind system section) verbatim.

**Architecture:** 7 rewrite tasks (full-file, brief carries complete new body — transcription + verify, cheapest tier OK), each one commit in-place on `main`. No new dirs unless a brief breaches ~500 words (then `kinds/*.md` under `startup-role-dev/` — implementer decides, reviewer checks). No VERSION bump (unpublished family; 3.3.0 stays until first real release).

**Tech Stack:** Markdown skills; repo conventions; referenced skills (`pipeline`, `pr-review-toolkit` fight + light variant, `topic-research`, `server-maintenance`, `architect`).

## Global Constraints

- Frontmatter keeps `name` + `description` ONLY.
- Every SKILL.md ends with the Framework tail verbatim.
- Body ≤~550 words (hard gate per file — reviewer rejects over).
- Canonical home chain verbatim wherever state paths appear; NEVER `tmp/`.
- Kind names exact everywhere: `code | research | docs | ops`.
- Architect verdict exact: `APPROVE | REDO:<file-bounded scope>`.
- Outcome field string unchanged: `ticket/status/pr/verify-mode/rounds/verdict/deck/followups/remaining/blocked_on` (`pr:` carries `memo:` handle for research).
- One commit per task, in-place on `main`; no PR.

---

### Task 1: Rewrite `skills/startup-role-dev/SKILL.md` (parameter vessel + 4 kind prompts + buddy)

**Files:**
- Rewrite: `skills/startup-role-dev/SKILL.md`
- Test: `grep -ci 'kind' skills/startup-role-dev/SKILL.md` → `≥6`; `grep -c 'cleanup/SKILL.md'` → `1`; `wc -w` → `≤550`

**Interfaces:**
- Consumes: spec `fcd7104` Kind system (all 4 kind prompts + buddy protocol); `pipeline`, `topic-research`, `server-maintenance`, `pr-review-toolkit` light variant (cited, not re-specified).
- Produces: worker contract consumed by Tasks 4–5 (manager assignment shape, buddy pairing, architect gate handoff).

- [ ] **Step 1: Write the new SKILL.md**

Frontmatter (keep `name: startup-role-dev`; new description):

```markdown
---
name: startup-role-dev
description: Parameter vessel for one queue item of any kind — executes the manager's assigned procedure (code/research/docs/ops) with full rigor, pairs with an adversarial buddy, ends with outcome block. Never chooses its own procedure.
---
```

Body: vessel rule (procedure comes from assignment `{kind, procedure, convention-source, acceptance}` — never infer, never substitute; no-kind in assignment = ask manager, not guess); four kind prompts verbatim from spec (code → pipeline + don't-merge; research → topic-research/internal + synthesis memo with adopt/adapt/build + cited claims; docs → write against named convention source; ops → server-maintenance pattern, stored instructions verbatim); buddy rule (manager-spawned, reports to manager only, worker receives compressed `feedback`); outcome block (same field string; research carries `memo:` handle in `pr:`); park rule unchanged. Framework tail.

- [ ] **Step 2: Verify**

Run: `grep -ci 'kind' skills/startup-role-dev/SKILL.md && grep -c 'cleanup/SKILL.md' skills/startup-role-dev/SKILL.md && wc -w skills/startup-role-dev/SKILL.md`
Expected: `≥6`, `1`, `≤550`.

- [ ] **Step 3: Commit**

```bash
git add skills/startup-role-dev/SKILL.md
git commit -m "feat(startup): generic worker vessel with kind prompts"
```

### Task 2: Rewrite `skills/startup-intake/SKILL.md` (kind field + inference)

**Files:**
- Rewrite: `skills/startup-intake/SKILL.md`
- Test: `grep -ci 'kind' skills/startup-intake/SKILL.md` → `≥4`; `grep -c 'cleanup/SKILL.md'` → `1`

**Interfaces:**
- Consumes: spec Record schema delta; Task 1 kind names.
- Produces: `queue.json` rows with `kind + procedure + convention-source` consumed by manager assignment.

- [ ] **Step 1: Write the new SKILL.md**

Frontmatter keep `name: startup-intake`; description appends kind assignment: `...; assigns kind (code/research/docs/ops) with per-kind acceptance.`

Body: existing criteria + kind assignment per item; record schema gains `kind`, `procedure`, `convention-source` (field names verbatim); inference rule when boss states no kind (code verbs → code; "should we"/prior-art → research; style/accuracy → docs; named host/mutation → ops — record the inference in the row); per-kind acceptance shape (code: behavior + affected + acceptance; research: question + decision it unblocks; docs: scope + convention source; ops: target + mutation + verify cmd). Framework tail.

- [ ] **Step 2: Verify + commit**

```bash
git add skills/startup-intake/SKILL.md
git commit -m "feat(startup): intake assigns kind with inference rule"
```

### Task 3: Rewrite `skills/startup-role-qa/SKILL.md` (per-kind proof)

**Files:**
- Rewrite: `skills/startup-role-qa/SKILL.md`
- Test: `grep -ci 'playwright' skills/startup-role-qa/SKILL.md` → `≥1`; `grep -ci 'cited claims\|verify.*replay' skills/startup-role-qa/SKILL.md` → `≥1`

**Interfaces:**
- Consumes: spec Non-code proof paragraph; `topic-research` brief shape (5 slots + ≥3 queries — cited for research verification).
- Produces: per-kind proof standard enforced by manager merges.

- [ ] **Step 1: Write the new SKILL.md**

Frontmatter keep name; description: `Standing cross-item QA — per-kind proof: Playwright+Storybook for code, cited-claims verification for research, accuracy+style for docs, verify-replay for ops; consumes decks/memos, flags overlap.`

Body: proof table (code: Playwright usability + Storybook edge states, mandatory, missing-either = violation; research: every claim cited, no uncited assertions, memo has verdict+tradeoffs; docs: accuracy vs described code + convention-source compliance; ops: verify command independently replayed); cross-item watch unchanged; never replaces per-item proof. Framework tail.

- [ ] **Step 2: Verify + commit**

```bash
git add skills/startup-role-qa/SKILL.md
git commit -m "feat(startup): QA per-kind proof standard"
```

### Task 4: Rewrite `skills/startup-role-devops/SKILL.md` (per-kind resources)

**Files:**
- Rewrite: `skills/startup-role-devops/SKILL.md`
- Test: `grep -c 'resources.json' skills/startup-role-devops/SKILL.md` → `≥1`

**Interfaces:**
- Consumes: spec Non-code proof + DevOps paragraphs (per-kind resources); Task 1 kinds.

- [ ] **Step 1: Write the new SKILL.md**

Frontmatter keep name; description appends per-kind resources.

Body: existing lock protocol + per-kind resources (code/docs: worktrees per item, deck-verify-before-cleanup; ops: live-target locks in `resources.json`, one mutation at a time per target unless boss overrides, ops-log entry on completion; research: no provisioning — memo-only). Keep boot-cwd context, creds accepted-risk, mesh handling. Framework tail.

- [ ] **Step 2: Verify + commit**

```bash
git add skills/startup-role-devops/SKILL.md
git commit -m "feat(startup): DevOps per-kind resources"
```

### Task 5: Rewrite `skills/startup-role-architect/SKILL.md` (advisory → gate)

**Files:**
- Rewrite: `skills/startup-role-architect/SKILL.md`
- Test: `grep -c 'REDO' skills/startup-role-architect/SKILL.md` → `≥1`

**Interfaces:**
- Consumes: spec Architect merge-gate paragraph (bounded verdict, no veto without scope, batching).
- Produces: gate verdicts consumed by Task 6 manager enforcement.

- [ ] **Step 1: Write the new SKILL.md**

Frontmatter keep name; description: `Merge-gate for every item in any kind — bounded shape/structure/blast-radius screen ending in APPROVE or scoped REDO; never depth re-review, never scopeless veto.`

Body: gate rule (no item closes without architect verdict); verdict exact `APPROVE | REDO:<file-bounded scope>`; per-kind screen (code: shape + red-flag screen; research: memo structure verdict+tradeoffs+recommendation; docs: location + inbound links + no orphan; ops: blast radius mutate/rollback); REDO without scope = rejected, re-screen (no scopeless veto); bounded (shape screen only, buddy owns depth); batching (manager batches, architect never holds more than its screen); keep consult triggers + Phase A/B citation for intake-ambiguity cases. Framework tail.

- [ ] **Step 2: Verify + commit**

```bash
git add skills/startup-role-architect/SKILL.md
git commit -m "feat(startup): architect merge-gate with bounded verdict"
```

### Task 6: Rewrite `skills/startup-role-manager/SKILL.md` (assignment + buddy spawn + gate enforcement)

**Files:**
- Rewrite: `skills/startup-role-manager/SKILL.md`
- Test: `grep -ci 'buddy' skills/startup-role-manager/SKILL.md` → `≥2`; `grep -c 'cleanup/SKILL.md'` → `1`

**Interfaces:**
- Consumes: Tasks 1–5 (assignment shape, buddy protocol, gate verdicts); spec Buddy + Gate paragraphs.

- [ ] **Step 1: Write the new SKILL.md**

Frontmatter keep name; description appends assignment + buddy + gate: `...; assigns {kind, procedure, convention-source}, spawns buddy pairs, merges only on architect APPROVE.`

Body: existing sections + assignment block (every fan-out carries `{kind, procedure, convention-source, acceptance}` — no bare prompts to workers); buddy spawn (one buddy per worker, buddy reports to manager only, width counts pairs); gate enforcement (collect worker outcome + buddy verdict + architect verdict; merge/close only on architect APPROVE; REDO → compressed `feedback` to worker; scopeless REDO → back to architect); keep firewall, async-boss, exit rules; keep PA tick link (7219b93). Framework tail.

- [ ] **Step 2: Verify + commit**

```bash
git add skills/startup-role-manager/SKILL.md
git commit -m "feat(startup): manager assignment, buddy spawn, gate enforcement"
```

### Task 7: Update `skills/startup/SKILL.md` (dispatch + outcome kind/memo)

**Files:**
- Modify: `skills/startup/SKILL.md`
- Test: `grep -ci 'kind' skills/startup/SKILL.md` → `≥2`

**Interfaces:**
- Consumes: Tasks 1–6; spec Record schema delta + research `memo:` handle.

- [ ] **Step 1: Edit the SKILL.md**

Surgical edits (read file first, preserve everything else): dispatch table intake row notes kind inference (`startup-intake` assigns); loop step 4 fan-out carries assignment + buddy pairs, width counts pairs; message schema outcome row notes research `memo:` handle in `pr:` field; merge authority notes architect APPROVE required for all kinds, research closes by filing/returning memo. Keep word count ≤600 (was 548; delta must be net ≤52 words — compress elsewhere if needed).

- [ ] **Step 2: Verify + commit**

Run: `grep -ci 'kind' skills/startup/SKILL.md && wc -w skills/startup/SKILL.md`
Expected: `≥2`, `≤600`.

```bash
git add skills/startup/SKILL.md
git commit -m "feat(startup): orchestrator kind routing and gate"
```

## Self-Review

**1. Spec coverage:** Kind prompts → Task 1. Buddy protocol → Tasks 1, 6. Architect gate (bounded verdict, no scopeless veto, batching) → Tasks 5, 6. Non-code proof → Task 3. Per-kind resources → Task 4. Record delta + inference → Task 2. Orchestrator routing → Task 7. `pr-review-toolkit` light variant for docs-buddy + `topic-research` brief shape for research-buddy cited, not re-specified.

**2. Placeholder scan:** Every step names exact file, exact grep, exact commit message; bodies bounded by word caps + required sentences; verdict strings exact.

**3. Type consistency:** Kind names `code|research|docs|ops` identical Tasks 1–7. Verdict `APPROVE|REDO:<scope>` identical Tasks 5–6. Field names (`kind`, `procedure`, `convention-source`, `memo:`) identical Tasks 1–2, 7. PA tick link preserved in Task 6 rewrite.
