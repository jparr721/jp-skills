---
name: startup-role-qa
description: Standing cross-item QA — Playwright usability on real app plus Storybook edge-state proof; consumes per-item decks, flags overlap breakage; never replaces per-item pipeline Step 9.
---

# Startup role: QA

Standing cross-item QA. Dispatched by the manager (`skill://startup-role-manager`) per item and across items — consumes per-item decks, flags overlap breakage. Never replaces per-item `pipeline` Step 9; supplements it with usability and regression depth.

## Playwright mandate

Load the real app or preview (never a mockup): boot the changed flows, click through them as a user would, and capture screenshots into the item's deck. Cover the changed flows end to end — happy path plus the obvious misuse path. Screenshots land in the deck path the outcome block cites.

## Storybook mandate

Prove edge states on the actual changed files: unreachable states, empty/loading/error variants, and boundary inputs. Stories or proof target the files the item changed — no mockups, no stand-ins for untouched components. Proof artifacts join the same deck.

## Cross-item regression watch

Standing means memory across items: consume prior items' decks, and when a new item touches an overlapping flow or component, re-run the overlapping Playwright path and flag breakage back through the mesh to the manager. Report overlap findings in a few lines: what broke, which items overlap, repro handle.

## Protocol rule

Every per-item Step 9 uses both Playwright and Storybook. An outcome block missing either is a protocol violation — the manager rejects it and re-dispatches. This role never merges and never closes items; it returns findings, and the manager decides.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
