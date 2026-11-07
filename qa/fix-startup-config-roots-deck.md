# fix/startup-config-roots — named StartupConfigError for invalid runtime-config

## Context
- `bun extensions/startup/config.ts list` threw raw `ZodError` (`skillsHome`/`startupRoot` missing + unrecognized `home`) when one saved dir held old-shape `runtime-config.json` (`{name, home}`) with no legacy `binding.json`.
- `isLegacyBinding` keys only on sibling `binding.json` (absent → false), so the record passed the `listStartups` filter into strict `parseRuntimeHostConfig`; `config.ts` catches only `StartupConfigError|RuntimeLaunchError`, so Zod escaped unactionable.
- Classification: trigger = stale legacy persisted content (orphaned/mixed-generation, no current writer emits `home`); defect = code (loader lets raw parse error escape). Fix wraps at `loadConfig` where name+path are in scope.

---

## What changed
- `extensions/startup/src/startup-config.ts` (`loadConfig` only): `parseRuntimeHostConfig(readPrivateJson(path))` wrapped in try/catch; non-`StartupConfigError`/`RuntimeLaunchError` rethrown as `StartupConfigError("Startup <name> saved config is invalid and needs explicit recovery: <path>: <cause>")`. Strict schemas untouched, no migration, no skip, no live-state writes.
- `extensions/startup/tests/startup-config.test.ts`: +2 tests — old-shape without `binding.json` fails as named `StartupConfigError` (not `ZodError`, message names name+path, no `secret` leak) for both `list` and `get`; corrupt JSON fails as named `StartupConfigError` (not `SyntaxError`).
- Untouched: `v7-launch.ts` schemas, `boot.ts` `isLegacyBinding`, `config.ts` catch set (already handles `StartupConfigError`).

---

## Real-data proof
- `bun test extensions/startup/tests/startup-config.test.ts` → 5 pass, 0 fail.
- `bun test extensions/startup/tests` → 768 pass, 0 fail (clean tree; earlier 26/4 on same 2 files was dirty-tree artifact — `bounded_complete` asserts clean worktree while fix was uncommitted; 30/0 after commit `0fa5b36`).
- `bun run --cwd extensions/startup typecheck` → exit 0.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extensions/startup/probes -p 'test_*driver.py'` → 6 OK; `-s tests` → 42 OK.
- Fixture CLI smoke (fixture `$FIX`, never live home):
  - `JP_SKILLS_HOME=$FIX bun extensions/startup/config.ts list` → exit 1, stderr `Startup oldshape saved config is invalid and needs explicit recovery: $FIX/startup/oldshape/runtime-config.json: [...missing skillsHome/startupRoot...unrecognized "home"...]`; stdout empty; no credential dump.
  - `get oldshape profile` → exit 1, same named error, no config dump.
  - `get alpha profile` → exit 0, stdout `"old"`.
- PR: https://github.com/jparr721/jp-skills/pull/14 — head `0fa5b36`, CI `owner` PASS. STOP before merge holds; no tag/release.

---

## Residual risk / follow-ups
- `list` stays fail-closed on one bad record (by constraint: no silent skip, unchanged return type). Partial-list+warning with a real warning contract is the open design question (Splinter dissent) — follow-up, not this PR.
- Same wrap also covers corrupt JSON / strict-schema extras; `isLegacyBinding` corrupt-`binding.json` `SyntaxError` path remains outside this fix — follow-up if needed.
- Release (`jp-config-release`, VERSION bump + tag) is a separate row; not done here.
