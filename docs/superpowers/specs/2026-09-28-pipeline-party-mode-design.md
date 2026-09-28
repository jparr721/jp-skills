# Pipeline Party Mode Design

Date: 2026-09-28. Status: approved by user in session; implemented in `pipeline/SKILL.md` (uncommitted).

## Decisions

- Overkill ships as opt-in mode, not a replacement. Trigger words: `party mode` / `overkill`.
  Default path behaviorally unchanged: review cap 2, same termination, same report shape.
- Planning follows the user's pick: per-slice plans + cross-review (not competing full plans,
  not one-plan-N-critics). Each slice agent owns its detailed todo + exact file set.
- Review scale follows the user's pick: min 3 / cap 5 in party mode. Early stop only when a
  round is clean AND 3 rounds have completed. Cap-open path stops and reports; never merges
  past open Critical findings.
- Deliberation copies BMAD party mode: subagent mode (one agent per persona per substantive
  round), Anti-Consensus Club always present (Wildcard, Level, Killjoy, Splinter), fresh
  session with no memory, not a voting body — orchestrator decides, human retains final control.
- Consensus gate is internal: the party reports a consensus summary at the phase boundary and
  auto-proceeds to Step 3. The user never steps through the todo list.

## Scope

- `pipeline/SKILL.md` only. No new skill files.
- Edits: frontmatter description, overview variant paragraph, two override-table rows
  (`party mode` / `overkill`, `N review rounds` party clause), Step 2b (party deliberation),
  Step 6 party termination paragraph, default-path scoping of cap-2 language (constraint 2,
  termination list, at-cap paragraph, graph labels, report `rounds` + `unreviewed` lines,
  three review-loop mistakes), three party-mode mistakes.
- REJECT: full BMAD artifact chain (`brief.md`, `prd.md`, `SPEC.md`, `ARCHITECTURE-SPINE.md`,
  `stories.yaml`, `sprint-status.yaml`) — max traceability but heaviest tokens and slowest;
  rejected for a skill-file change. REJECT: debate-swarm without the club — converges on the
  first plausible plan, which is what the club prevents.

## Sources

- https://docs.bmad-method.org/explanation/party-mode/
- https://docs.bmad-method.org/customize/run-multi-agent-discussions/
- https://github.com/bmad-code-org/BMAD-METHOD/pull/2530

## Self-review

- Placeholder scan: none — all counts concrete (2 debate rounds, min 3 / cap 5, 4 club lenses).
- Consistency: every default-path cap statement scoped (`default path`, `the round cap`,
  `to cap: 2; party 5`); party termination states its own stop/cap/report rules; report block
  carries both caps.
- Scope: single-file skill edit; no implementation-plan step (writing-plans skipped — the
  approved compact design above IS the complete plan for a markdown-only change; stated per
  the pipeline skill's own plan-skip rule).
