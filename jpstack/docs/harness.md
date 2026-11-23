# jpstack harness map

jpstack is a harness-neutral fork of poteto's [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT). Skills use neutral names. Read this file once per session when a skill names a tool, a subagent field, a model, or a storage path, then map it with the tables below. `<jpstack>` is the folder that holds `skills/`, `agents/` and `docs/` (inside the jp-skills checkout). If a field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

## Storage

jpstack keeps user state in the jp-skills canonical home, never in a harness folder. `<home>` is `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`.

| What | Where |
| --- | --- |
| Per-role model choices from **setup-jpstack** | `<home>/jpstack/models.md`. Skills read it when they pick a model. Missing file or missing role line → the skill's default. |
| jpstack scratch (renders, temporary clones, ketchup videos) | `<home>/tmp/jpstack/` |
| Upstream reference clone (read-only, never linked) | `<home>/cache/jpstack-upstream/` |
| Edits to a jpstack skill (**reflect**, **automate-me**) | The vendored copy, `<jpstack>/skills/<skill>/`. It is our fork, so edit it in place; the upgrade's three-way merge keeps the edit when upstream changes. |
| Project-local skills (`verify-<app>`, formal verification, `<handle>-mode`) | `.claude/skills/<name>/` in Claude Code, `.agents/skills/<name>/` elsewhere. Use the folder the repo already has; prefer `.agents/skills/` when both are absent and the repo is shared across harnesses. |
| Personal skills | `~/.claude/skills/` (Claude Code), `~/.agents/skills/` or `~/.codex/skills/` (Codex), `~/.omp/agent/skills/` (OMP), `~/.pi/agent/skills/` (Pi) |

## Transcripts

Read only the active workspace's transcripts. Never glob across workspaces; that reads unrelated private chats.

| Harness | Location |
| --- | --- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl`. The slug is the workspace path with each `/` and `.` turned into `-` (`/Users/you/proj` → `-Users-you-proj`). The newest `.jsonl` there is the current session; `<session>/subagents/` holds subagent transcripts. |
| Codex | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`. Filter by the `cwd` recorded in each file's first lines. |
| OMP / Pi | `~/.omp/agent/sessions/` or `~/.pi/agent/sessions/`. Filter by working directory. |
| Unknown | Ask the harness for the session path once; if none exists, say the audit was skipped. |

## Tools

| Neutral name in a skill | Claude Code | Elsewhere |
| --- | --- | --- |
| Subagent tool (spawn a subagent) | `Agent` | The harness's subagent/task tool. With none, do the work inline and say so. |
| Ask the user (structured question) | `AskUserQuestion`; in `-p` mode ask in plain text | Plain text |
| Todo list | `TodoWrite` / task tools if offered, else a list in the reply updated each phase | Same |
| Run another jpstack skill (`/name` or "the **name** skill") | The `Skill` tool when it lists the skill, else `Read <jpstack>/skills/<name>/SKILL.md` | Read the SKILL.md |
| Wake later / loop | `/loop`, `ScheduleWakeup`, or `Monitor` for an event | The harness's scheduler; with none, poll with a bounded background watcher |
| Search | `Grep`/`Glob`, else `rg` | `rg` |

## Subagent fields

| Neutral | Claude Code |
| --- | --- |
| General-purpose subagent | `subagent_type: "general-purpose"` |
| `poteto-agent`, `comment-sicko` | `subagent_type: "poteto-agent"` / `"comment-sicko"` (relink installs `<jpstack>/agents/*.md` into `~/.claude/agents/`). Elsewhere spawn a general subagent whose brief starts `Read <jpstack>/agents/<name>.md and follow it.` |
| Read-only subagent | `subagent_type: "Explore"`. It keeps `Bash`, so the brief says "do not edit files" and you check `git status` after. |
| Isolated worker (its own checkout) | `isolation: "worktree"`. Name the branch or commit it starts from. Elsewhere create a `git worktree` under `<home>/worktrees/<repo>/<branch>` and give the path. |
| Worker starting from a pushed branch | Tell the worker to check out that branch first. |
| Background | Subagents run in the background and notify on completion; omit the field. |
| Resume a subagent | `SendMessage` to its id when the harness keeps it; else spawn fresh and paste the prior report. |
| Attach files | List the paths in the brief. |

## Models

Skills name models by slug, such as `claude-opus-5-5-xhigh-fast`. The last token before an optional `-fast` is the effort.

| Slug or value | Claude Code `Agent` call |
| --- | --- |
| `claude-<family>-<version>-<effort>[-fast]` | `model: "<family>"` (`opus`, `sonnet`, `haiku`, `fable`) and `effort: "<effort>"`. Drop `-fast`. |
| A non-Claude slug (`gemini-*`, `gpt-*`, `grok-*`) | Omit `model` so the seat runs on the session model, and say so. A panel then loses vendor diversity; vary the seat's prompt instead. |
| `auto` or `inherit-parent` | Omit `model`. |
| A `models.md` value `<model> <effort>` (`opus high`) | `model: "opus"`, `effort: "high"` |

In Codex, OMP and Pi, pass the slug the harness accepts for that family, or omit the model and say so.

## Features with no neutral equivalent

Some upstream steps assumed a product feature: hosted automations and webhooks, hosted review bots that start on request, hosted cloud agents, or a built-in PR tool. When a step needs one, put one line in your reply, `Skipped: <step>. <reason>.`, then continue. Do not stop, ask, or retry. A built-in PR tool maps to the forge CLI the step names, such as `gh pr create`; that is not a skip.

Review-bot comments on a PR are ordinary review threads. Triage them by the Babysit playbook whatever bot wrote them.

## Companion skills

| Upstream companion | jpstack / jp-skills equivalent |
| --- | --- |
| `deslop` (slop strip before commit) | **unslop** for prose, `jp-code-simplifier` for code |
| `control-ui`, `control-cli` (drive the real app) | The project's `verify-<app>` skill (**create-verification-skill**), else `jp-smoke-test` for a deployed URL |
| `create-skill` (authoring SKILL.md) | `superpowers:writing-skills` when installed, else the **Authoring a skill** playbook |
| A plan-mode / planning skill | `superpowers:writing-plans` when installed; poteto-mode's **Plan execution** playbook runs the result |
| Built-in babysit | poteto-mode's **Babysit** playbook |
