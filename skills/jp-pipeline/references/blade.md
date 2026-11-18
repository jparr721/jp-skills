# Reviews and CI on Blade

Some repositories are hosted on Blade, not GitHub. A repository is on Blade when its `origin` is an HTTP(S) URL whose path
is `/sythe3.git` (for example `https://aspen.geep-mirzam.ts.net/sythe3.git`); `bl` applies the same rule. On such a
repository every `gh` step in a skill uses the `bl` equivalent below, and nothing goes to GitHub: GitHub holds only a
read-only mirror of Blade's `main`. Every other repository stays on `gh`.

## Setup

- Install: `curl -fsS <blade-url>/v1/download/install | sh` (needs Node.js 24 or later; puts `bl` in `~/.local/bin`).
- A person: `bl login --host <blade-url>`, then confirm the code in a signed-in browser.
- An agent never logs in. Its environment carries `BLADE_TOKEN` (an agent token an admin minted in Blade's Settings);
  `bl whoami` must answer `<name> (agent)`. Never print the token.
- `git push` and `git fetch` to Blade authenticate through `bl git-credential` (set up by `bl login`, or by
  `BLADE_TOKEN` when origin is Blade).

## What is different

- A review is a **change**, numbered per repository, not a pull request. `bl upload` pushes the current branch and
  creates the change (or a new revision of the branch's change); the branch remembers its change number.
- Every change targets `main`. There are no stacked changes, no drafts, no base branch to set or retarget, and no
  approvals: a stack-parent `target` is not supported on Blade, so land the parent first and branch from the new `main`.
- Merging is **submit**. Blade lands a change when its latest candidate is green on the current `main` (it rebases the
  candidate itself; there is no squash-or-merge choice). Agents may submit.
- There is no rate limit budget to share and no merge queue to pause.

## Command map

| GitHub step | Blade step |
|---|---|
| `gh pr create` / push to open a PR | `bl upload --message "<description>"` (first line is the subject; `--json` gives `change`, `revision`, `commitSha`); `bl upload --submit` uploads and requests the submit at once |
| `gh pr ready` | not needed (no drafts) |
| `gh pr edit --base <b>` | not supported (every change targets `main`) |
| `gh pr view --json number,state,headRefOid,baseRefName,url,mergeCommit` | `bl change view <n> --json`: `number`; `state` open/landed/abandoned (OPEN/MERGED/CLOSED); `latestRevision.commitSha` (head); `baseSha`; base is always `main`; `url`; `landedCommit` (merge commit); `canSubmit.ok` (mergeable) |
| `gh pr list` | `bl change list --json` |
| `gh pr checks <n>` / `--watch` | `bl checks <n> --json` / `bl checks <n> --watch` (exit 0 only when green) |
| `gh run view <run> --log-failed` | `bl checks <n> --json` names each job and its state; `bl logs <job>` prints that job's log (`--follow` while it runs) |
| `gh run rerun` | `bl rerun <job>` (or `bl recheck <n>` for a fresh run on the current `main`) |
| `gh run download` (artifacts) | none: Blade keeps job logs, not artifacts. Write evidence a job must hand over into its log. |
| `gh pr merge --squash/--merge --match-head-commit <h>` | first check `bl change view <n> --json` has `latestRevision.commitSha` equal to `<h>`, then `bl submit <n> --watch` (exit 0 once landed; non-zero when refused, for example `submit_disabled` while Blade follows GitHub, or when the change needs `bl sync`) |
| rebase onto the new base | `bl sync` (fetches `main` and rebases the branch), then `bl upload` |
| review comment | `bl comment <n> --file <path> --line <line> --body <text>`; `bl lgtm <n>` |
| `gh run list --commit <sha>` after merge | `bl deploys --json` (what each Worker runs, from which commit) and `bl status --json` |
| close a PR | `bl change abandon <n>` |

After a submit, read back `bl change view <n> --json` (`state: "landed"`, `landedCommit`) and check the commit is on
`origin/main` with `git fetch origin main && git merge-base --is-ancestor <landedCommit> origin/main`.
