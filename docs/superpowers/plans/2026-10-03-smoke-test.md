# Smoke Test Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `smoke-test` skill and release it as VERSION 2.1.0 on main.

**Architecture:** One new `skills/smoke-test/SKILL.md` following the `hotfix`/`server-maintenance` prose shape (frontmatter + Overview/When-to-Use/Flow/Safety/Framework tail), plus the repo's coordinated metadata change (README row + CHANGELOG + VERSION). No supporting files, no code, no test suite in this repo.

**Tech Stack:** Markdown prose only. Verification via grep gates and file-existence checks.

## Global Constraints

- Skill file lives at exactly `skills/smoke-test/SKILL.md`; frontmatter `name: smoke-test` matches the directory name.
- Skill ends with the Framework tail: read `../cleanup/SKILL.md` (fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it. Never a self-tail on anything else.
- Auth/creds hygiene: session-only, passed via env, recorded as `provided (redacted)` — never in files, logs, or report.
- Non-mutating against the live app: GETs/navigation/read-only interactions only; zero live writes.
- Work is committed in-place on `main` — no worktree, no branch, no PR (repo convention: push directly to main).
- Release = coordinated verified metadata change: `VERSION`, `CHANGELOG.md`, and `README.md` must agree at 2.1.0.
- Minor bump (2.0.0 → 2.1.0): new skill is additive, backward-compatible; precedent is `hotfix` shipping as Added under 1.2.0.

---

### Task 1: Write `skills/smoke-test/SKILL.md`

**Files:**
- Create: `skills/smoke-test/SKILL.md`
- Test: none (no test suite in repo); verification = grep gates below run against the created file.

**Interfaces:**
- Consumes: spec `docs/superpowers/specs/2026-10-03-smoke-test-design.md` (§1–§7); shape precedent `skills/hotfix/SKILL.md` (flow + non-negotiable constraints + common mistakes) and `skills/server-maintenance/SKILL.md` (canonical-home-agnostic, no scratch persistence needed here).
- Produces: `skills/smoke-test/SKILL.md` — Task 2 links it from README/CHANGELOG.

Exact file content to write (no placeholders, ~400 words):

```markdown
---
name: smoke-test
description: Use when verifying a live deployment — loading every page, checking console/network errors, exercising read-only functionality against a deployed base URL
---

# Smoke Test

## Overview

Post-deploy verification of a live app. Given a base URL (+ auth), enumerate every route from the repo in the working directory, HTTP-sweep all of them, browser-pass the survivors for render/console/network/interaction, and report a per-page checklist with an overall verdict. Source explains what the browser shows; the live app is never written to.

## When to Use

- User says "smoke test" plus a live deployment ("we just deployed to production", staging URL, preview deploy).
- Run starts in the app's repo directory: stack, routes, and flows come from working-directory source.
- When NOT to use: load/stress testing; mutating flows (creates, deletes, purchases, persisting form submits); static-only review (use `code-quality-audit`); fixing failures (use `hotfix`/`pipeline` on the pins this skill reports).

## Non-negotiable constraints

1. **Never mutate the live app.** GETs, navigation, search/filter/sort/paginate, login-view only. No POST/PUT/PATCH/DELETE that persists, no persisting form submits, no touching real user data.
2. **Creds stay session-only.** Base-URL auth is held in memory and passed via env, never baked into files, never printed in logs or the report — record only `auth: provided (redacted)`. Same hygiene as `hotfix`.
3. **Prod etiquette.** Sequential hits, no flood/parallel sweep; stop on rate-limit or 5xx-storm. Only the given base-URL host — external links are never checked.
4. **Never report PASS on skipped coverage.** Auth-gated pages without creds are `SKIPPED (no auth)`, never PASS.

## Flow

### Step 1 - INTAKE

Ask for base URL + auth (if needed) + scope (default: everything discovered). Record auth as `provided (redacted)`.

### Step 2 - DISCOVER

1. Scout the working directory: stack, router shape (file-based `app/`/`pages`/Astro/SvelteKit vs declared React Router/Express/Rails/Django), auth shape, critical read-only flows.
2. Enumerate every reachable route into a check list. Dynamic routes (`/users/[id]`) need one concrete seed each: fixtures/seed data/source constants first, else ask the user once.
3. Present check list + per-page read-only flows; user confirms scope before any live hit.

### Step 3 - SWEEP (HTTP, all routes)

`GET` each route against the base URL. Record status, redirect chain, response sanity (empty body, error text with 200 status, content-type mismatching the route's expected type). Dead pages (non-2xx after following redirects, timeout) verdict FAIL immediately — no browser retry. Survivors advance.

### Step 4 - BROWSER (rendered pages only)

Load each survivor in a real browser via harness-native tab/page tooling (this skill stays harness-generic, no named tool). Observe: renders non-blank, zero console errors, zero failed same-origin requests, no framework error overlay. Read-only interactions on key flows only. Pin failures to router/component file:lines where source explains them.

### Step 5 - VERDICT

Per-page table — route | sweep | render | console | network | interaction | result — plus overall `PASS` (zero FAIL, zero SKIP) / `PASS WITH GAPS` (zero FAIL, some SKIP) / `FAIL` (any FAIL). Console warnings and third-party request failures are advisory-only, never FAIL. End with failure pins as `hotfix`/`pipeline` fuel.

## Common mistakes

- Browser-loading every route without the cheap HTTP sweep first.
- Marking auth-gated pages PASS without creds instead of `SKIPPED (no auth)`.
- Failing a page over a console warning or a third-party request — both advisory-only.
- Mutating live data (submitting, creating, deleting) instead of staying read-only.
- Baking base-URL creds into files, logs, or the report instead of `provided (redacted)`.
- Checking external links or flooding prod with parallel hits.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
```

- [ ] **Step 1: Write the skill file**

Write the content above verbatim to `skills/smoke-test/SKILL.md` via the `write` tool (new file, not `edit`).

- [ ] **Step 2: Run gates to verify it passes**

Run:
```bash
test -f skills/smoke-test/SKILL.md && grep -c '^name: smoke-test$' skills/smoke-test/SKILL.md && grep -c 'provided (redacted)' skills/smoke-test/SKILL.md && grep -c 'SKIPPED (no auth)' skills/smoke-test/SKILL.md && grep -c 'cleanup/SKILL.md' skills/smoke-test/SKILL.md && wc -w < skills/smoke-test/SKILL.md
```
Expected: file exists; `name:` count 1; `provided (redacted)` count ≥ 2 (constraint + flow + mistakes); `SKIPPED (no auth)` count ≥ 2 (constraint + verdict); tail count ≥ 1; word count 350–500.

- [ ] **Step 3: Commit**

```bash
git add skills/smoke-test/SKILL.md
git commit -m "feat: add smoke-test skill for live deployment verification"
```

---

### Task 2: Wire metadata and release 2.1.0 on main

**Files:**
- Modify: `README.md` (Audits & review table — one row after the `code-quality-audit` row, line 34 area)
- Modify: `CHANGELOG.md` (new `## [2.1.0] - 2026-10-03` section above `## [2.0.0]`)
- Modify: `VERSION` (content `2.1.0`)
- Test: none; verification = grep gates + agreement check below.

**Interfaces:**
- Consumes: `skills/smoke-test/SKILL.md` from Task 1 (must exist; README row links `skills/smoke-test/SKILL.md`).
- Produces: pushed `main` at VERSION 2.1.0 with README + CHANGELOG + VERSION agreeing. Nothing downstream.

- [ ] **Step 1: Confirm Task 1 output exists**

Run: `test -f skills/smoke-test/SKILL.md && echo OK`
Expected: `OK`. If missing, stop — do not proceed without the skill file.

- [ ] **Step 2: Add the README row**

Via `edit`, insert after the `code-quality-audit` table row:
```markdown
| [`smoke-test`](skills/smoke-test/SKILL.md) | Verifying a live deployment — every page loads, console/network clean, read-only flows work against a base URL. | Read-only against live app, non-mutating |
```

- [ ] **Step 3: Add the CHANGELOG entry**

Via `edit`, insert above the `## [2.0.0]` line:
```markdown
## [2.1.0] - 2026-10-03

### Added

- `smoke-test` skill: post-deploy verification of a live app — DISCOVER routes from working-directory source (user confirms scope), HTTP SWEEP over all routes (dead pages FAIL fast), BROWSER pass on survivors (render, console errors, same-origin network, read-only interactions), per-page checklist with PASS / PASS WITH GAPS / FAIL verdict. Strictly non-mutating with session-only auth hygiene (`provided (redacted)`); auth-gated pages without creds report `SKIPPED (no auth)`, never PASS.
```

- [ ] **Step 4: Bump VERSION**

Via `edit` (or `write` for whole-file replace — file is one line): content becomes `2.1.0` (trailing newline preserved).

- [ ] **Step 5: Run agreement gates**

Run:
```bash
cat VERSION && grep -c 'smoke-test' README.md && grep -c '2.1.0' CHANGELOG.md && git status --short
```
Expected: `VERSION` prints `2.1.0`; README count ≥ 2 (row + link target both contain the name — row text contains it twice, so ≥ 2); CHANGELOG count ≥ 1; `git status` shows exactly the three modified files (plus nothing else unexpected — the committed spec and skill file must NOT reappear).

- [ ] **Step 6: Commit and push to main**

```bash
git add README.md CHANGELOG.md VERSION
git commit -m "release: smoke-test skill (2.1.0)"
git push origin main
git log --oneline -3 && git status --short
```
Expected: log shows the release commit on top, then the skill commit, then the spec commit; final `git status --short` clean. Confirm on `main` via `git branch --show-current` before pushing. Done means pushed to `main`, not just committed.
```

## Self-Review

**1. Spec coverage:** Problem (no live-app verifier) → Task 1 skill file. Goal (enumerate + sweep + browser + verdict table) → Steps 2–5 of the skill content. Non-goals (no load, no mutating, no static-only, no external links) → When-NOT-to-use + constraints 1/3. Intake hygiene → constraint 2 + Step 1. DISCOVER/SWEEP/BROWSER/VERDICT → Steps 2–5 verbatim. Safety → constraints 1–4. Skill shape (~400 words, tail, Audits & review, no supporting files) → content + Task 2 README row. Verification (fresh-context agent scenario) → not implementable as a repo test (NO_TEST_SUITE); covered by prose gates instead. No gaps.

**2. Placeholder scan:** No TBD/TODO/later; every step has exact commands and expected outputs; no "similar to Task N" (Task 2's edit targets quote exact anchor lines); no undefined references.

**3. Type consistency:** No code, no signatures. File paths consistent across tasks (`skills/smoke-test/SKILL.md` in both). Version string `2.1.0` identical in CHANGELOG, VERSION, gates.
