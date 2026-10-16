# Startup V7 acceptance - 2026-10-15

Merged into local `main` and installed in the named OMP profile `startup-v7`. New Startup `V7Live` runs in the owned Herdr session `startup-v7-live-20261015`, bound to `/Users/jarredparr/Projects/startup-v7-live`. The package entry is `v7.ts`. The live proof preceded the collection release. The subsequent release is 7.0.0; it does not migrate V6 state.

## 7.0.1 compatibility patch

Startup now tries the installed binaries and checks capabilities instead of release numbers. Regression fixtures cover OMP 18.10.4 and newer major versions, capable Herdr 0.9.4 and newer majors, protocol/schema metadata changes, and managed integration revisions around v10. Missing native abort and missing/incompatible Herdr APIs still block with concrete diagnostics.

The patch passes 254 tests (1316 assertions), TypeScript checking, six driver tests and all eight native guard checks. A version-reporting wrapper reproduced a native-probe failure caused solely by its version label while every behavioral check passed; the corrected probe passes that same run. The refreshed native artifact records the actual installed executable and its version.

The live snapshots and source hashes below retain the original 7.0.0 run; they are not relabeled as a live run on other OMP/Herdr releases.

## 7.0.0 live baseline

| Check | Result |
| --- | --- |
| `bun test extensions/startup/tests` | 242 passed, 0 failed, 1279 assertions across 12 files |
| `bun run --cwd extensions/startup typecheck` | Passed |
| `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extensions/startup/probes -p 'test_*driver.py'` | 6 passed |
| Compiled OMP 18.8.9 guard probe | 8/8 passed; source and executable hashes rechecked current |
| Live Herdr/OMP acceptance | 18 computed checks passed; actual provider calls, no fixture provider |
| Diff whitespace and added text ASCII checks | Passed |

[Live machine-readable evidence](live-acceptance.json) records source hashes, actual Herdr session locators, immutable team membership, selected canonical snapshots, fault timings and computed checks. [Screenshot deck](../slides/startup-v7-live-2026-10-15.html) contains browser captures of a labeled read-only evidence viewer. Native Herdr TUI capture was unavailable; these are not presented as native TUI screenshots. [Native guard evidence](../../extensions/startup/probes/v7-native-guards.json) separately proves native enforcement with an offline provider and a guard-removal negative control.

## Live hierarchy and progress

- Two complete crews: each has an owning architect, QA and dev. Each crew occupies its own Herdr tab with three independently interactive OMP panes.
- Manager and permanent PA have separate panes. All eight roots have distinct native transcript and pane identities, canonical role/loop source binding, and fresh authenticated control polling.
- Direct input in an architect pane produced a durable message to manager. Role and crew membership did not change.
- Periodic PA checks produced repeated settled reports to manager. The PA remains resident between checks; continuous inference is not required.
- Crew one reached canonical DONE at revision 9 after dev result, independent QA approval, architect gate and manager decision. Crew two reached canonical DONE at revision 11 after explicit recovery and independent QA. The evidence artifact retains exact observed revisions/statuses; idle/done observations do not substitute for acceptance.

## Faults and recovery

| Experiment | Observed result |
| --- | --- |
| SIGSTOP one architect for 325 seconds | Real five-minute semantic deadline produced `stale-progress` TO manager while Herdr still appeared working |
| Other crew during that pause | Advanced from revision 1 QUEUED to revision 6 EXECUTING |
| SIGSTOP PA for 45 seconds | Real 30-second control deadline produced `pa-offline` TO manager |
| Resume PA | Same employee and generation recovered fresh polling and subsequent periodic reports |
| Explicit native root resumes | Original profile, cwd, Herdr integration, generated employee bootstrap and native transcript retained; no duplicate employees or generations |
| Coordinator restart | Preserved uncertain claims; manager explicitly reconciled their saved receipts without replaying technical mutations |
| Idle native recap/side requests | Released execution reservations rather than starving the next crew |

Both injected fault alerts were acknowledged by the real manager. Historical alerts and failed attempts remain in the audit history. Three duplicate test-harness intake receipts remain unassigned and retained; this report does not claim the entire intake queue drained.

The live run exposed and fixed registration-before-runtime, worker import aliases, transitional Herdr wire fields, native XD tool dispatch, global sequence misinterpretation, working-state inbox noise, idle root capacity retention and crew recovery state. Each bug fix has a standalone commit and regression coverage. Explicit same-process `/startup select` now checks/restarts a provably dead coordinator before polling its existing client; its regression test passes. Live manual cold resumes are the recovery path established by this run.

## Limits

- This is bounded evidence of hierarchy, useful work, supervision, deadline detection and explicit recovery. It cannot establish that every future run always makes progress.
- Automatic Herdr/native restore retaining all required flags remains unverified. Bare `omp --resume` is insufficient.
- Coordinator death/host reboot have no automatically restarted OS service. Explicit recovery is required.
- V6 state migration and filesystem duty/repair parity remain unsupported. Existing V6 ownership/duties are refused, not imported or discarded.
- Shipping restrictions follow explicit user instructions. Repository credential isolation is not a V7 requirement. Canonical QA, architect gate and manager completion records retain their role checks.

## Interact with the live run

```sh
herdr session attach startup-v7-live-20261015
```

Manager: `w1:p5`. PA: `w1:p6`. Crew one: `w1:p7`, `w1:p8`, `w1:p9`. Crew two: `w1:pA`, `w1:pB`, `w1:pC`. In the manager pane, `/startup status` reads the canonical roster and recovery metadata.

## 7.0.5 Aspen supervision recovery

[Machine-readable Aspen proof](aspen-supervision-acceptance.json) records the final release source hashes, native identities, settled PA receipts, health samples, read-fault adapter and cleanup. Release [7.0.5](https://github.com/jparr721/jp-skills/releases/tag/v7.0.5) is published and installed on Aspen through Ansible.

- Preserved the original 68 employees, 20 crew hierarchies, 60 snapshotted employee processes, manager and PA processes, native transcript bindings, 136 launch files and exact queue bytes. Private online SQLite backups remain on Aspen. Existing interrupted claims are retained for explicit reconciliation.
- A separate native OMP manager and mandatory PA ran in actual Herdr panes against real SQLite and the production runtime factory. The PA settled two scheduled checks with reports to manager during queue read failures and two during observation collection failures. Both fault alerts were acknowledged by the manager.
- During each failure, health truthfully returned HTTP 503 with its diagnostic while supervision and PA scheduling continued. It returned HTTP 200 after each fault cleared without restarting the probe coordinator. No false manager-offline duties were created.
- The live sythelabs Startup stayed HTTP 200 throughout the fault proof, advancing from 13 to 19 PA reports. After the final coordinator update, a separate 110-second observation recorded two more settled PA checks, fresh polling and HTTP 200 in all 12 samples, with 1-40 ms health response times.
- Stopped only the three isolated proof processes and their two Herdr tabs; removed their temporary harness files. The live Startup, crews and original manager/PA processes remain running.

Validation: 281 tests, 1414 assertions and TypeScript checking pass. The unchanged native employee bridge also passed six driver tests and eight installed-OMP guard checks during this patch series. This is bounded fault-recovery evidence, not a guarantee against future host or provider failures.
