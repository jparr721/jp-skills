# fix/startup-config-roots — legacy-skip + strict-fail, 8.1.8

## Context
- `bun extensions/startup/config.ts list` threw raw `ZodError` when one saved dir held old-shape `runtime-config.json` with no legacy `binding.json`.
- Root cause: `isLegacyBinding` keys only on sibling `binding.json`; legacy runtime-only record passed the `listStartups` filter into strict `parseRuntimeHostConfig`; `config.ts` catches only `StartupConfigError|RuntimeLaunchError`.
- Accepted repair (REDO seq321/seq126): positively-recognized legacy roots are skipped by `list`, refused with actionable `StartupConfigError` on explicit `get`. Malformed current records fail strict, never mistaken for legacy.

## What changed
- `extensions/startup/src/startup-config.ts`: `isLegacyRuntimeConfig` requires full old shape (`home:string` + `stateDirectory/boundRoot/skillsRoot/socketPath/managerSession`, none of `skillsHome/startupRoot/backend/harness`). `skipsLegacy` covers legacy `binding.json` OR full-shape legacy runtime-config; unreadable/malformed stay present so `loadConfig` fails loudly. `loadConfig` refuses legacy with `older format` error; wraps unreadable/malformed parse failures into named `StartupConfigError` (name+path). Strict schemas untouched, no migration, no saved-state writes.
- `extensions/startup/tests/startup-config.test.ts`: 8 tests — marker legacy skip/refuse; full-shape legacy runtime-only skip/refuse; bare `{name,home}` stub strict-fails; partial-current strict-fails; unknown-key strict-fails; corrupt JSON named-fails; redaction + no-secret assertions, no `as` casts.
- `extensions/startup/README.md`: discovery note extended to runtime-only legacy shape.
- `VERSION` 8.1.8 + `CHANGELOG.md` 8.1.8 entry + root `README.md` version ref.
- Untouched: `v7-launch.ts` strict schemas, `boot.ts`, `config.ts` catch set (already handles `StartupConfigError`).

## Real-data proof (head 75c4a42, clean tree)
- `bun test extensions/startup/tests/startup-config.test.ts` → 8 pass, 0 fail.
- `bun test extensions/startup/tests` → 771 pass, 0 fail.
- `bun run --cwd extensions/startup typecheck` → exit 0.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extensions/startup/probes -p 'test_*driver.py'` → 6 OK; `-s tests` → 42 OK.
- 12-case fixture CLI matrix (disposable `$FIX`, never live home): empty home `[]` exit 0; mixed alpha+legacy list returns only alpha exit 0; legacy-only `[]` exit 0; get alpha full redacted exit 0; get alpha profile `"old"` exit 0; get credential refused exit 1; get legacy-nobind legacy refusal exit 1; malformed/stub/unknown-key list strict-fail exit 1 named path; get missing + invalid name errors exit 1; checksums unchanged (no migration); credential leak grep 0.
- Real-home `bun extensions/startup/config.ts list` (read-only, no credentials output) → `[{"name":"sythelabs-tern","harness":"omp","profile":"default"}]` exit 0.
- PR: https://github.com/jparr721/jp-skills/pull/14 — STOP before merge holds; no tag/release (release row separate).

## Residual risk / follow-ups
- `isLegacyBinding` corrupt-`binding.json` `SyntaxError` now wrapped as named invalid-config (binding path); no silent skip.
- Partial-list+warning contract remains out of scope by design (fail-closed on malformed, skip-only on positively-recognized legacy).
