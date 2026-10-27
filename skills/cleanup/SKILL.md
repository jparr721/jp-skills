---
name: cleanup
description: Runs after every other skill runs — clears your own tmp scratch under the canonical home and persists record corrections to the owning record. Terminal skill with no Framework tail.
---

# Cleanup

Runs after every other skill runs. This skill is terminal: it has no Framework tail and no other skill tails into anything else.

## Canonical home

`$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (XDG default; Windows `%APPDATA%\jp-skills`): `config.json` (`repo_path`, `installed_version`, `updated_at`), `storage.json`, `storage/` (private git clone), legacy `servers/`, `tmp/<skill>/`, `worktrees/<repo>/<branch>/`. Server ledgers live in `storage/server-maintenance/ledger/<slug>.json`; local storage configuration/receipts and scratch stay outside git.

## Steps

1. Clear only `tmp/<your-skill-name>/` scratch you made. Other skills' scratch is theirs. Scratch is never committed.
2. Persist corrections into the owning record so the next run inherits them. Server fixes use the timestamped helper’s `put`/`append` into `storage/server-maintenance/ledger/<slug>.json`, never legacy Markdown. Every new fact/event needs a full timezone-qualified timestamp; the helper generates UTC. Never commit credentials, scratch, worktrees or local config.
3. **Mandatory post-run hook:** always execute `python3 <this cleanup skill>/scripts/post-run.py` through the terminal tool (fallback `<jp-skills repo>/skills/cleanup/scripts/post-run.py`) after persistence, including read-only, failed and partial runs. No storage configuration is a safe no-op. Once configured, the hook commits ledger changes, fetches/reconciles current data, pushes and reads back the exact remote SHA. It assumes `gh` exists and is authenticated; do not add installation/login questions. Independent entries survive; overlapping keys use the newest timestamp. See `../server-maintenance/references/private-storage.md` for recovery.
4. A failed sync is **not synchronized**: preserve local changes/commits, report the error and retry after recovery; never hide errors, force-push or claim an older receipt proves this run synced. A hard-killed process cannot execute this procedural hook; the next run must recover pending changes. This tail is portable, not an automatically installed global harness hook.
5. Never touch `VERSION`, `CHANGELOG.md`, or another skill's records during a normal run.
