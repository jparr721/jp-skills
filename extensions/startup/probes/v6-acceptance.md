# Startup V6 local candidate acceptance

- Candidate: 6.0.0. Product correction head: `eaa3626`. Publication is separate; 5.0.1 remains the previously released version.
- Current verification: 142 behavioral tests, 736 assertions, TypeScript check and 6 Python driver tests passed. Raw output is [v6-checks.txt](v6-checks.txt).
- Sixteen current artifacts contain 158 passing checks. [v6-manifest.json](v6-manifest.json) records exact bytes, SHA256, counts and source freshness. Every recorded product/provider/driver/canonical hash in these artifacts matches this candidate.
- Required final independent candidate/whole-branch review remains controller-owned. No shared push, release, normal-profile install or production mutation occurred.

## Gate matrix

| Contract | Current evidence | Checks |
| --- | --- | ---: |
| Complete distinct teams, additive1+6/retry/+6, held BUILD with independent AGENTS, successive clarification and multi-request intake, coordination through manager to DevOps, actual question/waiting/resolution/new attempt, idle scale-down and retained employment | `native-integrated-evidence.json.gz` | 21 |
| Full canonical native role/loop projection, initial and later wakes, parked employee and aborted manager recovery, exact phase hierarchy and native transcript correlation | `native-adapter-evidence.json.gz` | 14 |
| Explicit1/native32 capacity, aggregate descendants, persisted blocked delivery, running injection, batch rejection and no retry spin | `native-capacity-evidence.json.gz` | 10 |
| Actual human capture before lookup/final, bounded history/projection, scoped raw text/image access and fresh complete team | `native-input-evidence.json.gz` | 10 |
| Source refresh, fresh actual native context, retained mail and stale-context fence | `native-refresh-evidence.json.gz` | 5 |
| Ordinary batch:false, caller-specific default scout, native rejection and no employee identity | `native-single-evidence.json.gz` | 5 |
| Canonical dev generic helper completes; actual PA child-spawn denial; helpers remain outside employee roster | `native-canonical-helper-pass.json.gz` | 4 |
| Root-owned and child-owned terminal helper refusal release only their reservation; batch slot reuse completes | `native-ordinary-root-pass.json.gz`, `native-ordinary-child-pass.json.gz` | 4 each |
| Actual QA pre-executor refusal, no partial readiness, saved-ID retry and successful sibling/source retention | `native-partial-focused-pass.json.gz` | 6 |
| Actual raw native JSON read metadata and display | `native-duty-read-evidence.json.gz` | 4 |
| Canonical sources, quiet duty/later wake, authorized repair, failed verification without replay, fresh reconciliation and return to duty | `native-duty-monitor-evidence.json.gz` | 9 |
| Same-root graceful resume, preserved employee, unknown initial health and new-owner observation | `native-duty-resume-evidence.json.gz` | 7 |
| Installed native discovery, known OMP without companion, sibling boot/preserved instructions, nine images plus full paged input, restart/limit/failure guards and owned uninstall | `native-boot-evidence.json.gz` | 21 |
| Same-transcript actual SIGKILL/default lease expiry/new epoch, saved native children and source rebind, original cue dispatch/settlement, old-epoch denial, verified reconciliation and no offline observations/write replay | `native-cold-restart-evidence.json.gz` | 20 |
| Actual Codex prompt-only two complete canonical teams; independent AGENTS DONE while BUILD needs a decision; actual capacity rejection/retry, hierarchical reports and preserved legacy input | `prompt-only-evidence.json` | 14 |

The integrated wait check is an actual provider `wait` call rejected by the native hook while AGENTS is undispatched. Its early final is attempted by that provider; the fixture additionally records the actual native extension runner's stop-hook continuation result in the same root. After ready work dispatch, a native `wait` succeeds while the genuinely held BUILD job remains pending. Complete source checks cover manager, dev, QA, architect, DevOps and PA. Deterministic provider replies exercise runtime mechanics and ordering; they do not establish model reasoning quality or execution of a complete application pipeline.

The absent-companion case starts actual OMP18.8.9 without the plugin and records native metadata, missing registered Startup tools and the canonical blocked-install guidance. Its disposition is fixture-recorded against that guidance, not a claim that an absent plugin can enforce runtime guards.

## Reused current component contracts

The coherent behavioral suite covers the accepted contracts below directly; each is paired with relevant current native composition above. It is not necessary to fabricate foreign native identities or repeat every negative as a separate process:

- Store: V5 queue shape, existing row/receipt/unknown-field preservation; architect-only scoped capture; immutable receipts; safe amendment; complete team cardinality; independent busy membership; questions retain waiting assignments; atomic result/ack/outgoing messages; conservative ambiguous locks; unresolved mail/duty/grant retirement refusal.
- Adapter: outsiders, foreign-root transcripts and late generations rejected; actual owner/source/lease fences; concrete resource/dependency/capacity blockers; dependent work withheld while unrelated work stays ready; ordinary helper authority and stale token isolation.
- Duties: same-target aliases serialize grants; hard links, retargeting, substituted callers and unsupported probes rejected; failed verification retains grants; host close releases timer ownership and history remains history.
- Installer: accepted `native-install-recovery-evidence.json.gz` PASS6 retains actual native partial-link permission failure and preservation/uninstall proof. Installer source is unchanged. Only its driver portability/initialized-FAIL handling changed; the historical driver hash remains historical. No redundant native installer failure run is claimed.
- Stage0 `native-feasibility-evidence.json.gz` remains historical OMP18.8.9 capability proof, superseded for final canonical contexts by the current artifacts above. Its portable driver now reads the committed shared loop and uses fresh owned workspace validation.

## Reproduce in owned fixtures

Requirements: Bun, Python3 and compiled `omp/18.8.9`. Install repository dependencies using the lockfile. Each fresh workspace below must not already exist and must be outside the repository. Drivers write an ownership marker, isolate profile/state/config, initialize FAIL evidence and preserve evidence on interruption. Only `resume` accepts its exact previously owned duty workspace. `--sources product` is the adapter default; `--sources fixture` exists for bounded component exploration and does not discharge canonical-source acceptance.

```sh
bun install --cwd extensions/startup --frozen-lockfile
bun run --cwd extensions/startup test
bun run --cwd extensions/startup typecheck
python3 -m unittest discover -s extensions/startup/probes -p 'test_*py'
python3 extensions/startup/probes/run-adapter-probe.py --scenario integrated --workspace /tmp/my-v6-integrated --evidence /tmp/my-v6-integrated.json.gz
python3 extensions/startup/probes/run-adapter-probe.py --scenario full --workspace /tmp/my-v6-full --evidence /tmp/my-v6-full.json.gz
python3 extensions/startup/probes/run-adapter-probe.py --scenario capacity --workspace /tmp/my-v6-capacity --evidence /tmp/my-v6-capacity.json.gz
python3 extensions/startup/probes/run-adapter-probe.py --scenario input --workspace /tmp/my-v6-input --evidence /tmp/my-v6-input.json.gz
python3 extensions/startup/probes/run-adapter-probe.py --scenario refresh --workspace /tmp/my-v6-refresh --evidence /tmp/my-v6-refresh.json.gz
python3 extensions/startup/probes/run-adapter-probe.py --scenario single --workspace /tmp/my-v6-single --evidence /tmp/my-v6-single.json.gz
python3 extensions/startup/probes/run-adapter-probe.py --scenario helper --workspace /tmp/my-v6-helper --evidence /tmp/my-v6-helper.json.gz
python3 extensions/startup/probes/run-adapter-probe.py --scenario ordinary-root --workspace /tmp/my-v6-root-helper --evidence /tmp/my-v6-root-helper.json.gz
python3 extensions/startup/probes/run-adapter-probe.py --scenario ordinary-child --workspace /tmp/my-v6-child-helper --evidence /tmp/my-v6-child-helper.json.gz
python3 extensions/startup/probes/run-adapter-probe.py --scenario partial --workspace /tmp/my-v6-partial --evidence /tmp/my-v6-partial.json.gz
python3 extensions/startup/probes/run-duties-probe.py --scenario raw --workspace /tmp/my-v6-raw --evidence /tmp/my-v6-raw.json.gz
python3 extensions/startup/probes/run-duties-probe.py --scenario monitor --workspace /tmp/my-v6-monitor --evidence /tmp/my-v6-monitor.json.gz
python3 extensions/startup/probes/run-duties-probe.py --scenario resume --workspace /tmp/my-v6-monitor --evidence /tmp/my-v6-resume.json.gz
python3 extensions/startup/probes/run-boot-probe.py --workspace /tmp/my-v6-boot --evidence /tmp/my-v6-boot.json.gz
python3 extensions/startup/probes/run-cold-probe.py --workspace /tmp/my-v6-cold --evidence /tmp/my-v6-cold.json.gz
```

The cold driver installs into an explicitly owned isolated named profile, uses actual `/startup new`, kills that process, waits the saved unchanged default60000ms lease and starts B with `--resume <original-manager.jsonl>` under the same profile/environment. The boot probe separately proves `--session <saved-file>`. New-root `startup select` is not same-session recovery. Current owner reconciliation, manager binding and explicit saved-message dispatch are required; the probe neither edits clocks/SQL/native IDs nor infers readiness from job completion.

Prompt-only evidence is a separate controller-run actual Codex collaboration fixture, not replayed by these OMP drivers. Six real actors received complete literal canonical sources in two teams. Host-encrypted rollout strings are retained as encrypted-message hashes alongside actual call metadata/output, controller-recorded literal source blocks and recipient comparisons; no automatic plaintext extraction or decryption claim is made. Its original SHA256 is `271ec4b2b265a014f0b5b22e42777bb9350261d1db1f985129f9005c62794ece`.

## Limits and retained failure history

- Monitoring runs only during a live owner host. No observations occur during downtime. The implemented connector is bounded local JSON filesystem verification/repair, not a deployment or service-health system.
- Prompt-only mode has no native persistence/monitoring guarantee. It supplies actual canonical dispatch/coordination evidence separately from native recovery.
- Generated generic task capability proves the required supervisor primitive. Actual application pipeline execution, external integrations and production deployment are outside this acceptance fixture.
- Original cold nested-read, partial-activation, ordinary root/child admission and canonical-helper FAIL artifacts are retained unchanged. Standalone fixes: `8a153c8`, `07980b0`, `551cff5`, `eaa3626`.
- A transient host ENOSPC interrupted three attempted probe starts before native launch. Two owned intermediate raw event logs were compressed without loss; all final listed artifacts subsequently passed. No unrelated host files were removed.
- Manual remaining actions: independent final Task6/whole-branch review, resolve any resulting findings, then obtain separate publication authorization. Release/tag/push and normal-profile installation have not occurred.
