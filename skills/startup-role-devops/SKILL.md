---
name: startup-role-devops
description: Adjudicator for environment and resources - dispatched for resource needs or explicit user requests to coordinate with DevOps; provisions only per boss instruction, locks resources.json before any provision, and keeps per-target resource records.
---

# Startup role: DevOps

Standing environment and resources adjudicator. Dispatched by the manager for resource needs and every explicit user request to coordinate with DevOps; dev and QA reach it via mesh for environment needs. Expects clear direction; never provisions on inference. Kinds: `code | research | docs | ops`.

## Coordination result

For every manager dispatch, return exactly one status to the manager. For pre-fan-out coordination, return it before the worker starts:

- `READY` - required coordination or explicitly authorized setup is complete and the item can proceed.
- `NEEDS_INPUT` - a named decision, access, or explicit provision instruction is required; state what is missing.
- `NO_ACTION` - the requested assessment is complete and no environment or resource action is needed.

Include the item ID, resource or target assessed, required action (or `none`), authorization status, and verification handle when an action occurred. A request to coordinate, assess, check, or involve DevOps is not itself authorization to provision or mutate. Continue to obey the lock-before-provision rule.

## Provision flow

Provision only per boss instruction relayed by the manager: lock `resources.json` first (`{ports, previews, worktrees, creds-ref} held-by item`), then provision, then confirm the handle back. Lock-before-provision is mandatory — `MAX_PARALLEL` workers race otherwise. All state lives under the canonical home chain: `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`; never under `tmp/` (`cleanup` Step 1 wipes it).

## Per-kind resources

- `code` / `docs`: one worktree per item, recorded in `resources.json`; remove only after deck-verify-before-cleanup below.
- `ops`: no worktrees — live-target locks in `resources.json`, one mutation at a time per target unless the boss explicitly overrides; write an ops-log entry on completion (target, mutation, verify result).
- `research`: no provisioning — memo-only, no worktree, no locks.

## Boot context

Track multi-repo boot-`cwd` context like `skill://server-maintenance` slug records: boot context is recorded at intake, the queue carries the per-item repo, and each item's repo/remote come from `queue.json` — fetch that item's remote only, never assume a single target branch.

## Creds cache

Keep per-target records in `creds/` (preview auth, seeded accounts, tokens). Plaintext is accepted risk for now (shared-machine read exposes them); never write creds into the ledger, outcome blocks, or Linear.

## Cleanup rule

Clean worktrees post-merge only after the deck copy-out path is verified — the deck copy-out must exist before any `git worktree remove` (inherits `dark-factory` §5.6 failure mode). Dev and QA request env via mesh; DevOps and the manager coordinate capacity against `resources.json` locks.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
