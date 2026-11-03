# Service access and synchronization diagnosis

## 1. Pin the client path before widening the investigation

Record the affected device, configured URL including scheme/port, action and visible error. Check that device's required VPN connection; do not substitute the agent machine's working connection for this check. A tailnet-only proxy is intentionally unreachable off the tailnet even when the application and host are healthy.

Connect only through the owning server record. Read `docker compose ls`, `docker ps -a` and `systemctl --failed` as applicable to discover the real deployment; do not assume repository paths are live configuration.

## 2. Compare application and proxy boundaries

On the server, probe a known application health endpoint and frontend locally. The examples use Immich's health route; substitute the deployed application's actual route for other services:

```sh
curl -sS --max-time 10 -i "$local_app_url/api/server/ping"
curl -sS --max-time 10 -o /dev/null -w 'HTTP %{http_code}\n' "$local_app_url/"
```

For a Tailscale Serve deployment, read `tailscale serve status` to establish which port and backend actually serve the application. Test its configured HTTPS hostname and port from the client side with certificate verification enabled:

```sh
curl -sS --max-time 15 -i "$client_app_url/api/server/ping"
```

Use `curl -v` only when handshake or routing details matter. Keep ordinary HTTP/HTTPS tests separate from SSH target resolution; do not invent alternate SSH addresses. Never infer a certificate fault from a single diagnostic runtime's trust store when the intended client's verified HTTPS request succeeds.

## 3. Distinguish the stages of a sync failure

| Evidence | What it establishes | What remains unproven |
|---|---|---|
| Healthy containers and HTTP ping | Application currently responds | Authenticated sync and upload |
| Session activity and metadata acknowledgment | Client received/acknowledged server changes | Device indexing, backup eligibility, file transfer |
| Recent persisted asset rows | Server accepted new assets | Entire device backup completion |
| Processing jobs or thumbnail/transcode logs | Assets reached processing | All requested files uploaded successfully |
| Empty processing queues | No work currently waiting there | Whether client attempted an upload |

Inspect only necessary database fields with read-only queries. Discover table/column names before querying; keep password hashes, tokens, API keys and private photo contents out of output. For Immich, recent `asset.createdAt` values distinguish new uploads from old assets whose processing or sync state changed. Schema and protocol support must be checked against the deployed version.

## 4. Observe a controlled attempt

Start a bounded watcher immediately before the user triggers the failing action:

```sh
timeout 90 docker logs --follow --since 3m --timestamps "$app_container"
docker logs --since 5m --tail 60 --timestamps "$database_container"
```

Use the remote host's timeout facility when available. Routine logs may omit successful requests. If a request capture is justified, retain only method, query-stripped path, HTTP status and relevant client version; never print authorization headers, cookies, bodies or raw packets. Request absence proves little unless the user confirmed the attempt occurred during the capture window.

If storage remains a plausible blocker, test only with a uniquely named disposable probe under the actual upload mount, verify write/readback/rename/timestamp behavior, and remove only that probe in a guaranteed cleanup path. Never test by modifying an existing photo or clearing app state.

## 5. Close at the right evidence level

After the access prerequisite is corrected, look for a new accepted asset or corresponding upload-processing activity. Stop diagnostic watchers on cancellation. Report what was verified and whether any server state changed; do not keep pursuing a speculative server fix after the user identifies a missing client VPN connection.
