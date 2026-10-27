# SSH stalls and post-reboot host-pressure diagnosis

## 1. Establish the failing boundary

Use the recorded DNS target and a harmless command:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 "$target" 'hostname; uptime'
ssh -vv -o BatchMode=yes -o ConnectTimeout=10 "$target" true
```

Apply an outer tool timeout to both probes. Check the local VPN state and hostname resolution, then TCP port reachability with the platform's supported bounded `nc` options. An online tailnet peer proves neither a healthy SSH daemon nor a working user session.

Read verbose SSH output by boundary: TCP established, server banner, key exchange, key accepted/authenticated, session channel opened, command output. Authentication followed by a stalled session moves the investigation toward resource pressure, PAM/logind/user-manager health or shell startup. Do not change keys merely because login never produces a prompt. Preserve intermittent results separately rather than treating one successful TCP probe as sustained health.

## 2. Recover the failed boot's evidence first

After access returns, run read-only checks. Discover boot IDs before assuming `-1` is the incident boot; repeated restarts can move it farther back.

```sh
hostname; uptime
free -h
df -h / /tmp
df -i / /tmp
sudo -n journalctl --list-boots --no-pager
systemctl --failed --no-pager
```

Select the incident boot ID as `$boot`, and a bounded UTC incident interval as `$start` / `$end`:

```sh
sudo -n journalctl -b "$boot" -k -p warning --no-pager -n 200
sudo -n journalctl -b "$boot" --no-pager -n 150
sudo -n journalctl -b "$boot" -u ssh --since "$start" --until "$end" --no-pager -n 100
sudo -n journalctl -b "$boot" -k --since "$start" --until "$end" -o json --no-pager
```

Capture the bounded JSON kernel export to an owned evidence file and reduce it programmatically; do not flood the conversation with repeated task tables and stack traces. Retain the export in the canonical server evidence area if needed after scratch cleanup. Look for global versus cgroup OOM, swap exhaustion, blocked tasks, filesystem/I/O faults and the last recorded shutdown events. If the journal did not persist the failed boot, state that historical attribution is unavailable rather than inferring it from current health.

## 3. Attribute pressure without blaming the victim

For OOM records, collect:

1. First/last kill timestamp, killed task and PID, and `oom-kill:` constraint/cgroup fields.
2. One complete task-table snapshot near the first event and, when useful, one near the last event. Count and aggregate RSS by process name within each snapshot in code; never add repeated dumps together.
3. Largest individual resident consumers, system-wide shared-memory figures, free swap and kernel/slab indicators.
4. Service/session identity from `task_memcg`, then matching journal records for that unit or session.

Interpret `global_oom` as host-wide exhaustion, not a container-only limit. The task invoking allocation and the task selected for killing are not necessarily the largest consumer or the initiating cause: OOM scores affect victim selection. An SSH session cgroup is different from a runner service cgroup even when both run under the same Unix UID. Resolve session opening times and service logs before assigning workload ownership.

Read the task-table header before parsing columns; kernel formats vary. Convert RSS and swap entries using the recorded host's page size, not the analyst machine's page size. Treat virtual address space separately from resident memory. Combined RSS is an approximate footprint and can double-count shared pages; system-wide shmem can overlap process RSS and must not be blindly added to it. Large shmem suggests tmpfs/shared-memory pressure, but does not identify `/tmp` specifically.

If installed historical sysstat data exists, correlate the incident interval with `sar -r ALL` and `sar -S` against the appropriate daily archive. Swap may already have been full before the final workload surge, so distinguish a pre-existing condition from the trigger. Fresh `findmnt -t tmpfs -o TARGET,SIZE,USED,AVAIL` establishes current mount limits, not pre-reboot contents.

## 4. Identify the command only when evidence survives

Use bounded, incident-window searches of relevant shell history, runner diagnostics or agent transcripts. Filter locally and return only necessary command/ownership evidence; never dump environment files, credentials or whole private conversations. Inspect transcript record shapes first: commands may be in custom tool-call `input` rather than function-call `arguments`. Session files can be filed under their creation date while containing later events; filter event timestamps rather than searching only today's directory.

Stop once the failure mechanism is established and further attribution has no surviving evidence. Report the exact initiating command or tmpfs owner as unknown when unproven; process names alone do not establish a particular test lane or orchestrator.

## 5. Close with cause, recovery and prevention separated

Re-run the original harmless SSH command and check current resources/services. Report the confirmed mechanism first, a small set of measured contributors second, and the current recovery state last. Label hypotheses explicitly. A reboot restoring access is recovery, not proof that the pressure source was fixed.

Recommend concurrency/memory bounds or tmpfs investigation only after the evidence points there. Do not alter workloads, restart healthy services, delete caches or change limits as part of a read-only investigation. Apply any separately authorized durable host changes through the owning server's required configuration-management path.
