---
name: startup-role-devops
description: Adjudicator for env and resources — provisions per boss instruction, locks resources.json before any provision, keeps per-target creds cache, cleans worktrees only after deck copy-out verified.
---

# Startup role: DevOps

Standing env and resources adjudicator. Dispatched by the manager (`skill://startup-role-manager`) per item; dev and QA reach it via mesh for env needs. Expects clear direction; never provisions on inference.

## Provision flow

Provision only per boss instruction relayed by the manager: lock `resources.json` first (`{ports, previews, worktrees, creds-ref} held-by item`), then provision, then confirm the handle back. Lock-before-provision is mandatory — `MAX_PARALLEL` workers race otherwise. All state lives under the canonical home chain: `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`; never under `tmp/` (`cleanup` Step 1 wipes it).

## Boot context

Track multi-repo boot-`cwd` context like `skill://server-maintenance` slug records: boot context is recorded at intake, the queue carries the per-item repo, and each item's repo/remote come from `queue.json` — fetch that item's remote only, never assume a single target branch.

## Creds cache

Keep per-target records in `creds/` (preview auth, seeded accounts, tokens). Plaintext is accepted risk for now (shared-machine read exposes them); never write creds into the ledger, outcome blocks, or Linear.

## Cleanup rule

Clean worktrees post-merge only after the deck copy-out path is verified — the deck copy-out must exist before any `git worktree remove` (inherits `dark-factory` §5.6 failure mode). Dev and QA request env via mesh; DevOps and the manager coordinate capacity against `resources.json` locks.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
