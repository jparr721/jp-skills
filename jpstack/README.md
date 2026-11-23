# jpstack

jpstack is a harness-neutral fork of [pstack](https://github.com/cursor/plugins/tree/main/pstack) by [poteto](https://x.com/poteto) (Lauren Tan), MIT licensed (see `LICENSE`). pstack is built for Cursor. jpstack keeps its skills, playbooks and principles, swaps Cursor tools, paths and features for neutral ones (`docs/harness.md`), and wires them into jp-skills.

> if you want to go fast, go deep first. — poteto

## Install and update

jpstack ships inside jp-skills. `jp-upgrading-jp-skills` installs and updates it:

- `skills/jp-upgrading-jp-skills/scripts/relink.py` links every `jpstack/skills/<name>` unprefixed into `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`, `~/.omp/agent/skills` and `~/.pi/agent/skills`, and `jpstack/agents/*.md` into `~/.claude/agents`. It replaces links into an old pstack install.
- On every upgrade, `scripts/upstream.py` fetches upstream into a read-only reference clone (`<home>/cache/jpstack-upstream`) and three-way merges upstream changes since the commit pinned in `UPSTREAM.json`. The upgrading agent then removes any new Cursor-specific text until `upstream.py check` is clean, pins the new commit and commits. The procedure is in `skills/jp-upgrading-jp-skills/references/jpstack-upstream.md`.

Nothing links into the reference clone, so pulling it never changes an installed skill. Only reviewed, committed files in this folder are installed.

Run `/setup-jpstack` once to pick models per role. It writes `<home>/jpstack/models.md` (`<home>` is the jp-skills home, `~/.config/jp-skills` by default).

## Start here

Use `/poteto-mode` for any task that needs rigor. It picks a playbook and runs the other skills as its steps need them. `/poteto-help` answers questions about which skill fits. The guide in `docs/guide/` walks through a first real task.

## What differs from upstream

| Upstream | jpstack |
| --- | --- |
| `setup-pstack` writes `~/.cursor/rules/pstack-models.mdc` | `setup-jpstack` writes `<home>/jpstack/models.md` |
| Cursor `Task` fields, cloud agents, Custom Modes, `/loop` | Neutral names mapped per harness in `docs/harness.md` |
| `correct`, `typescript-best-practices` | Dropped. `jp-correct` and `jp-typescript-best-practices` carry their improvements. |
| `make-bot-ui`, `automations/` | Dropped (Cursor Automations only) |
| `deslop`, `control-ui`, `control-cli`, `create-skill` from other Cursor plugins | `jp-code-simplifier` and **unslop**, `verify-<app>` or `jp-smoke-test`, `superpowers:writing-skills` |
| No planning skill | `superpowers:writing-plans` plans, and the new poteto-mode **Plan execution** playbook runs the plan |

`architect` is upstream's. It replaced `jp-architect` in v10.

## How it fits with jp-skills and superpowers

| Need | Plan with | Execute with | Ship with |
| --- | --- | --- | --- |
| One ticket or feature, end to end | `superpowers:brainstorming` → `superpowers:writing-plans`, or `jp-pipeline`'s party plan | poteto-mode **Plan execution** (jp-pipeline Step 3 always runs it) | `jp-pipeline` review, simplify, merge, QA |
| Rigorous work without a pipeline | poteto-mode **Feature** / **Multi-phase plan**, or a superpowers plan | poteto-mode **Plan execution** | poteto-mode **Opening a PR** → **Babysit** → **Shipping** |
| Scoped bug | — | `jp-hotfix` / `jp-ohfuck` with **principle-fix-root-causes** and **why** | Their own landing |
| Design before code | `architect`, with **arena** for contested designs; **interrogate** to attack it | — | — |
| Ship verdict on a diff | — | — | `jp-pr-review-toolkit` (canonical); **interrogate** for a multi-model second opinion |
| Repeated agent mistakes | `jp-correct` (repo) / **reflect** (skills) | — | — |
| TypeScript | **principle-type-system-discipline** → `jp-typescript-best-practices` | — | — |

**reflect** and **automate-me** edit the vendored copy here. The next upstream merge keeps those edits.
