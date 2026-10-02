# Code Quality + Architecture v2 Design

Date: 2026-10-02. Status: design approved in session (§1–§3); implementation via writing-plans next.

## Decisions

- v2 layout is breaking → `VERSION` 2.0.0. `git mv <skill> skills/<skill>` for all 10 existing skills; new skills live only under `skills/<name>/SKILL.md`. Root keeps `VERSION`, `CHANGELOG.md`, `README.md`, `docs/`.
- `skills/cleanup/SKILL.md` promoted from tail text to a real terminal skill. Header states it runs after every other skill runs. No Framework tail on itself (self-reference). All other skills end with tail pointing at `../cleanup/SKILL.md` (fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`). `shared/cleanup.md` stays as archival pointer only, not live.
- Full replacement for code-quality audits: single `skills/code-quality-audit/SKILL.md` replaces `nextjs-code-quality-audit`, `elysia-code-quality-audit`, `vite-tauri-code-quality-audit` (dirs deleted, not archived). REJECT hybrid (generic + stack-specific) and shim options: triple maintenance, overlapping findings.
- Code-quality intake is scout → focus menu → 6-lens fan-out → merge → prioritize/stop. Focus is weighting, not subset: all six lenses always run (max agents); chosen focus gets Critical weight, others drop to Moderate+.
- Stack Scout output gates lens prompts:
  ```
  stack: <next.js | elysia | vite-tauri | rust | django | rails | spring | dotnet | unknown>
  gui: <none | react-ssr | react-spa | tauri | other>
  dominant_libs: [<top 3-5 by import count>]
  stack_concerns: [<2-4 architectural bullets>]
  mixed: <true/false + slice candidates>
  ```
  If `mixed: true` (e.g. `apps/` + `src-tauri/` + `Cargo.toml`), scout recommends slice candidates and intake requires the user to pick a single module/slice. No multi-slice single pass.
- Focus menu (blocking): UI bugs / Code bugs / Cleanup-slop / Full audit (default Full) + severity threshold (default Moderate+) + scope confirm + emphasize/skip free-text. User's three examples map directly: UI bugs, code bugs, cleanup.
- Six code-quality lenses share a composition preamble: functional units doing one thing well; stateless inner + stateful wrapper (hooks together); hooks as module behind provider/adapter; route as thin adapter → service; composition over multi-thing modules; Unix-philosophy splits. Canonical bad shape: 10 components in one React file → split to composable stateless units.
  1. Composition & single-purpose (slop core). 2. Concern placement (via scout `stack_concerns`). 3. DRY / slop (duplication, repeated preamble/query/schema). 4. Correctness & bugs (null/empty/error, tenant leaks, `where`-less mutations, secret-shaped `VITE_*`, overbroad allowlists = Critical). 5. Tests & seams. 6. Readability & comments (naming, >~40-line fns, >3 nesting, WHAT-not-WHY/verbose/stale comments, dead code, `any`).
- Rules carried over: no behavior change; file:lines + WHY per finding; group related; drop Minors past 50; direction-is-shape, no diffs.
- `architecture-audit` v2 keeps 5 lenses + subsystem intake + scout/discovery parallel + confirm gate + `>=2 agree` consensus + Critical-single-agent exception + TDD Red/Green/Refactor per finding + stop after prioritize. Only change: functional-unit addon appended to all five lens prompts (boundaries = wrapper/component/service splits; data flow = state lives vs mutates across wrapper/hook/provider chain; dependency = god modules/high in-edges; testability = isolated-unit test tomorrow; complexity = parallel hierarchies/feature envy/unearned abstractions). REJECT rebuild-around-units and whole-codebase variants.
- `upgrading-jp-skills` v2 block: detect pre-v2 (no `skills/` dir) → `git pull --ff-only` (refused → `git status --short`, STOP) → delete stale root symlinks in all five registries (`~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.pi/agent/skills/`, `~/.omp/agent/skills/`) → relink from `skills/*/SKILL.md` → stamp `installed_version`. Restart `omp` after relink.
- README retarget: category tables point at `skills/<name>/SKILL.md`; Link Everything loops `for d in skills/*/`. CHANGELOG `2.0.0` logs breaking moves + replacement + arch-audit framing.

## Scope

- New/move files: `skills/*` relocations, `skills/cleanup/SKILL.md`, `skills/code-quality-audit/SKILL.md`, `architecture-audit` lens-prompt edits, `upgrading-jp-skills` v2 block, tail-path rewrites, README/CHANGELOG/VERSION at implementation time.
- This spec authorizes design only. REJECT: implementation without writing-plans; preserving per-stack audits as shims; multi-slice single audit pass.
- Next step is the writing-plans skill for the implementation plan, per the brainstorming terminal state.

## Self-review

- Placeholder scan: none — all gates concrete (scout fields, 4-way focus, 6 lenses, consensus rule, symlink registries ×5).
- Consistency: full-replacement matches VERSION 2.0.0 breaking; cleanup-terminal matches no-self-tail advisory; mixed→single-slice matches scout contract; focus-as-weighting matches "as many agents as it can".
- Scope: repo restructure + one new skill + two skill edits + upgrade-skill block; no caller migration beyond symlink swap.
