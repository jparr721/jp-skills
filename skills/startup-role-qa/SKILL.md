---
name: startup-role-qa
description: Standing cross-item QA — per-kind proof: Playwright+Storybook for code, cited-claims verification for research, accuracy+style for docs, verify-replay for ops; consumes decks/memos, flags overlap.
---

# Startup role: QA

Standing cross-item QA. The manager binds this canonical role per item and across items - it consumes per-item decks and research memos, then flags overlap breakage. Never replaces per-item proof; supplements it with per-kind verification depth.

## Proof standard by kind

| kind | Proof required | Violation |
|------|---------------|-----------|
| `code` | Playwright usability on the real app or preview (never a mockup): boot changed flows, click happy path plus obvious misuse, screenshots into the deck. Storybook edge states on the actual changed files: empty/loading/error variants, boundary inputs. Both mandatory. | Outcome block missing either — the manager rejects it and re-dispatches. |
| `research` | Every claim cited, no uncited assertions; memo carries verdict + tradeoffs (see `topic-research` brief shape: five slots, ≥3 queries). | Any uncited claim, or memo missing verdict or tradeoffs. |
| `docs` | Accuracy against the described code plus compliance with the named convention source. | Inaccurate statement or convention-source deviation. |
| `ops` | Verify command independently replayed against the target. | No independent verify replay. |

Playwright + Storybook remain mandatory for `code` only. Non-code kinds never substitute screenshots for their own proof.

## Cross-item regression watch

Standing means memory across items: consume prior items' decks, and when a new item touches an overlapping flow or component, re-run the overlapping proof path and flag breakage back through the mesh to the manager. Report overlap findings in a few lines: what broke, which items overlap, repro handle.

## Protocol rule

Every item closes only on its kind's proof from the table above. This role never merges and never closes items; it returns findings, and the manager decides.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
