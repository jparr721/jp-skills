# Smoke Test — Design

Date: 2026-10-03. Approach: hybrid sweep + browser (approach 3 of 3).

## Problem

After a deploy ("we just deployed to production"), no skill verifies the
live app. `hotfix` VERIFY re-checks one fix; `code-quality-audit` reads
static source only; `server-maintenance` checks hosts, not apps. Nothing
loads every page, watches console/network, or exercises functionality
against a live deployment.

## Goal

New `smoke-test` skill: given a base URL (+ auth), enumerate every route
from the repo in cwd, HTTP-sweep all of them, browser-pass the survivors
for render/console/network/interaction, and report a per-page checklist
with an overall PASS / PASS WITH GAPS / FAIL verdict.

## Non-goals

- No load/stress/perf testing, no synthetic traffic beyond one pass.
- No mutating flows: no POST/PUT/PATCH/DELETE that persists, no
  persisting form submits, no touching real user data.
- No static-only review (use `code-quality-audit`); no fixing
  (failures become `hotfix`/`pipeline` follow-ups).
- No external-link checking; only the given base-URL host.

## Design

### 1. Identity

- `skills/smoke-test/SKILL.md`, ~400 words, Audits & review category.
- Frontmatter `description`: `Use when verifying a live deployment —
  loading every page, checking console/network errors, exercising
  read-only functionality against a deployed base URL`.
- Trigger: user says "smoke test" + names a live deployment.
- Run starts in the app's repo directory; stack/routes/flows come from
  cwd source. Effect: read-only against the live app, non-mutating.

### 2. Intake

User supplies: base URL + auth (if needed) + scope (default: everything
discovered). Auth held session-only, passed via env, recorded as
`provided (redacted)` — never in files, logs, or report (same hygiene
as `hotfix` constraint 6).

### 3. DISCOVER

1. Scout cwd: stack, router shape (file-based `app/`/`pages`/Astro/
   SvelteKit vs declared React Router/Express/Rails/Django), auth
   shape, critical read-only flows.
2. Enumerate every reachable route into a check list. Dynamic routes
   (`/users/[id]`) need one concrete seed each: fixtures/seed data/
   source constants first, else ask the user once.
3. Present check list + per-page read-only flows; user confirms scope
   before any live hit.

### 4. SWEEP (HTTP, all routes)

`GET` each route against the base URL. Record status, redirect chain,
response sanity (empty body, error text with 200 status, content-type
mismatching the route's expected type). Dead pages (non-2xx after
following redirects, timeout) verdict FAIL immediately — no browser
retry. Survivors advance.

### 5. BROWSER (rendered pages only)

Load each survivor in a real browser via harness-native tab/page tooling
(skill stays harness-generic, no named tool). Observe: renders
non-blank, zero console errors, zero failed same-origin requests,
no framework error overlay. Read-only interactions on key flows only:
login-view, search, filter, sort, paginate, navigate. Pin failures to
router/component file:lines where source explains them.

### 6. VERDICT

Per-page table: route | sweep | render | console | network |
interaction | result. Rules: console warnings advisory-only, never FAIL;
third-party request failures advisory-only; auth-gated pages without
creds are `SKIPPED (no auth)`, never PASS. Overall: `PASS` (zero FAIL,
zero SKIP) / `PASS WITH GAPS` (zero FAIL, some SKIP) / `FAIL` (any
FAIL). Ends with failure pins as `hotfix`/`pipeline` fuel, then the
Framework tail (`../cleanup/SKILL.md`).

### 7. Safety (non-negotiable)

Non-mutating only. Sequential hits, no flood/parallel sweep; stop on
rate-limit or 5xx-storm. Source reads unlimited; live writes zero.

## Verification

- Prose-only skill; verification = spec self-review + user spec review,
  then implementation via writing-plans.
- Post-implementation: fresh-context agent given a fixture app + base
  URL enumerates all routes, reports the table + verdict, mutates
  nothing, and pins an injected failure to file:lines.
