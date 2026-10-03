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
