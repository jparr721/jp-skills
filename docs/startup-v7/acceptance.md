# Startup V7 candidate acceptance - 2026-10-15

Implemented on `codex/startup-v7`, in an isolated worktree. No normal-profile installation, live Herdr control, publication, release or VERSION change occurred.

## Verified

| Check | Result |
| --- | --- |
| `bun test tests` from `extensions/startup` | 231 passed, 0 failed, 1250 assertions across 12 files |
| `bun run typecheck` from `extensions/startup` | Passed, including V7 entry and detached runtime |
| `python3 -m unittest discover -s extensions/startup/probes -p 'test_*driver.py'` | 6 passed |
| Compiled OMP 18.8.9 guard probe | 8/8 passed; [machine-readable evidence](../../extensions/startup/probes/v7-native-guards.json) |
| Native negative control | Removing the root bridge preflight guard permits both write and bash mutation artifacts |
| Diff whitespace and changed skill ASCII checks | Passed |

Real SQLite/Unix-socket tests establish complete crew admission, manager/architect routing, generation/epoch fencing, source binding, exact retained input/images and existing item approval gates. New regressions cover incomplete-crew direct turns, slow launch isolation, uncertain layout effects, stranded unadmitted recovery, live identity duplication denial, PA supervision, failed Herdr observation, lifecycle gaps, missed launch deadlines, and item-specific staleness that unrelated activity cannot reset. Progress timestamps commit with queue revisions and survive reopen; exact replay does not refresh them.

The native probe loads the production employee client into the installed compiled OMP with isolated offline fixtures. It proves complete role/loop projection, actual helper denial, native write/bash denial after lost admission/connection, and zero provider calls after denied context admission. It does not exercise the entire Herdr launch path. The artifact records executable/source hashes and exact stages.

## Remaining acceptance gates

- Live Herdr crew creation, direct human pane interaction, observer failure/recovery and process loss in a real selected workspace.
- Native restore retaining the named profile, Herdr integration, generated employee bootstrap, cwd and original root transcript.
- Explicit V6 state migration and filesystem duty/repair parity. V7 refuses existing V6 ownership/duties instead of silently importing or dropping them.
- Deployment supervision for coordinator death/host reboot. The detached coordinator survives manager loss; it is not an automatically restarted OS service.

The installed Herdr skill requires `HERDR_ENV=1` for live pane control. This Codex session is outside Herdr; its tests used owned isolated fixtures. No requested live deployment was represented as complete.

## Shipping policy clarification

The user removed strict merge control as a requirement. Shipping restrictions must be explicit user instructions. Repository credential isolation is not an acceptance gate. Existing QA, architect and manager tool permissions still govern canonical review/completion records; those records are separate from which agent executes a repository merge.
