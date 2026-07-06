# Agent Harness Portability - Design

**Date**: 2026-07-06
**Status**: Approved design, pre-implementation

## Purpose

Make the skills in this repo usable across agent harnesses, not only Claude Code. The skill bodies should read like portable operating instructions: action-oriented, terse, and independent of any one harness's tool names.

## Goals

- Remove harness-specific execution language from skill bodies where it is not intrinsic to the work.
- Keep each skill's behavior and constraints unchanged.
- Document how to link this repo's skills into Claude, OpenCode, and Codex registries.
- Create symlinks for OpenCode and Codex so the same source files are used everywhere.

## Non-Goals

- Do not rewrite the skills into separate per-harness variants.
- Do not change audit criteria, output schemas, or dark-factory workflow semantics.
- Do not introduce install scripts.
- Do not add support for unknown registries beyond documenting the general linking pattern.

## Design

### Skill Body Language

Skill bodies should use generic operations instead of harness tool names:

- Use `Dispatch all agents in parallel`, not `use the Agent tool`.
- Use `Ask the user`, not a named question tool.
- Use `Create a task`, `Read files`, `Search files`, and `Run commands` only when a workflow step needs that action.
- Keep domain-specific tool names when they are part of the actual workflow, such as Linear MCP, GitHub CLI, `gh`, and `pr-review-toolkit`.

Model names may remain only when they express intended capability or cost tier. If they appear, phrase them as guidance rather than a dependency on a specific harness.

### README Installation Docs

The README should describe the repo as a portable agent skill collection. Installation docs should list registry symlink targets for:

- Claude: `~/.claude/skills/<skill-name>`
- OpenCode: `~/.agents/skills/<skill-name>`
- Codex: `~/.codex/skills/<skill-name>`

The docs should include link, verify, and unlink examples. They should explain that symlinks keep this repo as the single source of truth.

### Linking

Create symlinks for every skill in this repo into:

- `~/.agents/skills/`
- `~/.codex/skills/`

Existing links or directories should not be overwritten blindly. If a target already exists and points somewhere else, leave it untouched and report it.

## Acceptance Criteria

- README no longer presents the collection as Claude-only.
- README includes Claude, OpenCode, and Codex linking instructions.
- Skill bodies avoid harness-specific tool names except where a domain tool is intrinsic to the workflow.
- OpenCode and Codex registries contain links for each repo skill, or conflicts are reported.
- Existing skill behavior remains unchanged.

## Validation

- Search the repo for `Claude Code`, `Agent tool`, `AskUserQuestion`, and direct global registry assumptions.
- Verify created symlinks with directory listings.
- Review the diff to confirm no workflow semantics changed.
