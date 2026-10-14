#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import uuid


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    workspace = args.workspace.resolve()
    evidence = {'status': 'FAIL', 'checks': {}, 'commands': [], 'processes': []}
    process = None
    installed = False
    env = None
    profile = 'startup-cold-' + uuid.uuid4().hex[:10]

    def save() -> None:
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.evidence.with_name(args.evidence.name + '.tmp')
        with gzip.open(temporary, 'wt') as file:
            json.dump(evidence, file)
        temporary.replace(args.evidence)

    save()
    try:
        if workspace.exists() or workspace.is_relative_to(repo) or workspace == Path.home():
            raise ValueError('Cold proof requires a fresh explicitly owned fixture outside the repository')
        workspace.mkdir(parents=True, exist_ok=False)
        (workspace / '.startup-proof-owner.json').write_text(json.dumps({'profile': profile, 'repo': str(repo), 'kind': 'cold', 'version': 1}))
        env = {key: value for key, value in os.environ.items() if key in {'PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'SHELL', 'USER', 'LOGNAME'}}
        env.update({'PI_CONFIG_DIR': '.omp-' + profile, 'XDG_DATA_HOME': str(workspace / 'data'), 'XDG_STATE_HOME': str(workspace / 'state'), 'XDG_CACHE_HOME': str(workspace / 'cache'), 'JP_SKILLS_HOME': str(workspace / 'home'), 'STARTUP_EXECUTION_LIMIT': '1', 'STARTUP_ADAPTER_EVENTS': str(workspace / 'events.jsonl'), 'STARTUP_ADAPTER_REPORT': str(workspace / 'report.json'), 'STARTUP_COLD_CHECKPOINT': str(workspace / 'checkpoint.json'), 'STARTUP_COLD_PHASE': 'A'})
        for kind in ['data', 'state', 'cache']:
            (workspace / kind / 'omp/profiles' / profile).mkdir(parents=True)
        cwd = workspace / 'bound'
        cwd.mkdir()
        (cwd / 'AGENTS.md').write_text('Existing fixture instructions.\n')
        config = workspace / 'config.yml'
        config.write_text('task:\n  batch: true\n  agentIdleTtlMs: 0\n  speculativeLaunch: false\nasync:\n  enabled: true\nproviders:\n  cacheWarming: false\nmemories:\n  enabled: false\nmcp:\n  enableProjectConfig: false\n')
        paths = [repo / 'extensions/startup/index.ts', repo / 'extensions/startup/install.ts', repo / 'extensions/startup/package.json', *sorted((repo / 'extensions/startup/src').glob('*.ts')), *sorted((repo / 'skills').glob('startup*/**/*.md')), repo / 'skills/hire/SKILL.md', Path(__file__), Path(__file__).with_name('native-cold.ts'), Path(__file__).with_name('native-adapter.ts')]
        evidence['sourceHashes'] = {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
        evidence['environment'] = {key: value for key, value in env.items() if key not in {'PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'SHELL', 'USER', 'LOGNAME'}}
        omp = shutil.which('omp')
        if omp is None:
            raise FileNotFoundError('Installed compiled OMP required')
        evidence['installedVersion'] = subprocess.check_output([omp, '--version'], env=env, text=True).strip()

        def run(command: list[str]) -> None:
            result = subprocess.run(command, env=env, cwd=cwd, text=True, capture_output=True)
            evidence['commands'].append({'args': command.copy(), 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
            save()
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)

        run(['bun', str(repo / 'extensions/startup/install.ts'), 'install', profile])
        installed = True
        command = [omp, '--profile', profile, '--mode', 'rpc', '--no-ui', '--cwd', str(cwd), '--session-dir', str(workspace / 'sessions'), '--config', str(config), '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--no-title', '--tools', 'task,read,write', '--extension', str(Path(__file__).with_name('native-cold.ts')), '--model', 'startup-adapter/offline', '--thinking', 'off', '--auto-approve']

        def start(argv: list[str]) -> subprocess.Popen:
            proc = subprocess.Popen(argv, env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=(workspace / 'stdout.jsonl').open('a'), stderr=(workspace / 'stderr.txt').open('a'), text=True)
            evidence['processes'].append({'phase': env['STARTUP_COLD_PHASE'], 'argv': argv.copy(), 'pid': proc.pid, 'startedAt': time.time()})
            save()
            return proc

        def send(message: str) -> None:
            process.stdin.write(json.dumps({'type': 'prompt', 'id': uuid.uuid4().hex, 'message': message}) + '\n')
            process.stdin.flush()

        def records() -> list:
            path = workspace / 'events.jsonl'
            return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

        def wait(predicate, label: str) -> None:
            deadline = time.monotonic() + 75
            while time.monotonic() < deadline:
                if predicate():
                    return
                if (workspace / 'report.json').exists():
                    report = json.loads((workspace / 'report.json').read_text())
                    if report['status'] == 'FAIL':
                        raise RuntimeError(report['error'])
                if process.poll() is not None:
                    raise RuntimeError('Native process exited during ' + label)
                time.sleep(.05)
            raise TimeoutError(label)

        def database() -> dict:
            db = sqlite3.connect('file:' + str(workspace / 'home/startup/cold-proof/staff.sqlite') + '?mode=ro', uri=True)
            try:
                lease = dict(zip(['token', 'epoch', 'generation', 'expires'], db.execute('SELECT token,epoch,generation,expires FROM lease WHERE singleton=1').fetchone()))
                rows = [{'kind': kind, 'id': identity, 'payload': json.loads(payload)} for kind, identity, payload in db.execute('SELECT kind,id,payload FROM records')]
                return {'lease': lease, 'records': rows}
            finally:
                db.close()

        process = start(command)
        wait(lambda: any(row['kind'] == 'cold-session-start' for row in records()), 'initial native startup')
        send('/startup new cold-proof')
        wait(lambda: (workspace / 'home/startup/cold-proof/staff.sqlite').exists(), 'bound native boot')
        send('/startup-cold-proof')
        wait(lambda: (workspace / 'checkpoint.json').exists(), 'actual interrupted checkpoint')
        saved = json.loads((workspace / 'checkpoint.json').read_text())
        evidence['checkpoint'] = saved
        evidence['beforeKill'] = database()
        evidence['checks']['realUncertainWrite'] = json.loads((cwd / 'config.json').read_text()) == {'enabled': True} and any(grant['state'] == 'reconciliation' for grant in saved['grants'])
        evidence['checks']['pendingBeforeKill'] = any(message['id'] == 'cold-saved-pending' and message['status'] == 'pending' for message in saved['messages'])
        evidence['checks']['capacityBlocked'] = saved['staff']['deliveries']['cold-saved-pending']['kind'] == 'capacity-blocked'
        evidence['targetBeforeKill'] = {'sha256': hashlib.sha256((cwd / 'config.json').read_bytes()).hexdigest(), 'mtimeNs': (cwd / 'config.json').stat().st_mtime_ns}
        evidence['processes'][-1]['killAt'] = time.time()
        process.kill()
        evidence['processes'][-1]['exit'] = process.wait(timeout=10)
        evidence['processes'][-1]['exitedAt'] = time.time()
        process = None
        evidence['afterKill'] = database()
        save()
        expires = evidence['afterKill']['lease']['expires']
        wait_started = time.time()
        while time.time() * 1000 <= expires + 50:
            time.sleep(min(.25, max(.001, (expires + 51 - time.time() * 1000) / 1000)))
        evidence['leaseWait'] = {'expires': expires, 'startedAt': wait_started, 'endedAt': time.time(), 'elapsedSeconds': time.time() - wait_started, 'defaultLeaseMs': 60000}
        evidence['beforeResume'] = database()
        env['STARTUP_COLD_PHASE'] = 'B'
        process = start(command + ['--resume', saved['rootFile']])
        wait(lambda: sum(row['kind'] == 'cold-session-start' and row['phase'] == 'B' for row in records()) > 0, 'resumed native startup')
        send('/startup-cold-proof')
        wait(lambda: (workspace / 'report.json').exists(), 'cold recovery completion')
        report = json.loads((workspace / 'report.json').read_text())
        evidence['report'] = report
        if report['status'] != 'COMPLETE':
            raise AssertionError(report)
        evidence['afterResume'] = database()
        process.stdin.close()
        evidence['processes'][-1]['exit'] = process.wait(timeout=15)
        evidence['processes'][-1]['exitedAt'] = time.time()
        process = None
        events = records()
        reopened = next(row for row in events if row['kind'] == 'cold-reopened')
        dispatch = next(row for row in events if row['kind'] == 'cold-dispatch-after')
        before_epoch = evidence['afterKill']['lease']['epoch']
        checks = evidence['checks']
        recovery = next(row['recovery'] for row in events if row['kind'] == 'cold-public-recovery')
        public_grants = {grant['id'] for grant in recovery['grants']}
        public_claims = {claim['id'] for claim in recovery['claims']}
        public_assignments = {assignment['id'] for assignment in recovery['assignments']}
        public_pending = {message['id'] for message in recovery['pendingMessages']}
        recovery_calls = [row for row in events if row['kind'] == 'cold-admin' and row['name'] in {'startup_reconcile', 'startup_resolve', 'startup_dispatch', 'startup_repair_reconcile'}]
        checks['publicRecoveryIdsOnly'] = bool(recovery_calls) and all(row['params']['grantId'] in public_grants if row['name'] == 'startup_repair_reconcile' else row['params']['claimId'] in public_claims if row['name'] == 'startup_reconcile' else row['params']['assignmentId'] in public_assignments if row['name'] == 'startup_resolve' else bool(row['params']['messageIds']) and all(identifier in public_pending for identifier in row['params']['messageIds']) for row in recovery_calls)
        checks['publicChildRecoveryDiscovered'] = any(claim['employeeId'] == saved['workerId'] and claim['status'] == 'reconciliation' for claim in recovery['claims'])
        checks['sameCanonicalRoot'] = reopened['rootSession'] == saved['rootSession'] and reopened['rootFile'] == saved['rootFile']
        checks['newGenerationEpoch'] = reopened['createdAt'] > saved['createdAt'] and evidence['afterResume']['lease']['epoch'] == before_epoch + 1
        checks['sigkillRealLeaseWait'] = evidence['processes'][0]['exit'] == -9 and evidence['leaseWait']['endedAt'] * 1000 > expires and evidence['beforeResume']['lease'] == evidence['afterKill']['lease']
        provider_results = [message for row in events if row['kind'] == 'provider' for message in row['context']['messages'] if message['role'] == 'toolResult']
        checks['recoveryGuard'] = reopened['staff']['mode'] == 'recovery' and any(row.get('toolCallId') == 'cold-recovery-denial' and row.get('isError') for row in provider_results)
        checks['nativeColdRevived'] = dispatch['staff']['deliveries']['cold-saved-pending']['outcome'] == 'revived'
        checks['savedCueNewEpoch'] = any(claim['messageId'] == 'cold-saved-pending' and claim['ownerEpoch'] == before_epoch + 1 and claim['status'] == 'settled' for claim in report['claims'])
        checks['oldClaimDenied'] = any(row.get('toolCallId') == 'cold-old-claim' and row.get('isError') for row in provider_results)
        checks['noWriteReplay'] = hashlib.sha256((cwd / 'config.json').read_bytes()).hexdigest() == evidence['targetBeforeKill']['sha256'] and (cwd / 'config.json').stat().st_mtime_ns == evidence['targetBeforeKill']['mtimeNs']
        checks['verifiedRelease'] = any(grant['id'] == saved['grantId'] and grant['state'] == 'released' for grant in report['grants'])
        checks['completed'] = evidence['processes'][-1]['exit'] == 0
        resumed_index = next(index for index, row in enumerate(events) if row['kind'] == 'cold-session-start' and row['phase'] == 'B')
        projections = [message['content'] for row in events[resumed_index:] if row['kind'] == 'provider' for message in row['context']['messages'] if message['role'] == 'developer' and isinstance(message['content'], str) and message['content'].startswith('STARTUP_BINDING=')]
        for employee in report['employees']:
            owned = [text for text in projections if json.loads(text.split('\n')[0].removeprefix('STARTUP_BINDING='))['employeeId'] == employee['id']]
            checks['freshFullSource_' + employee['id']] = bool(owned) and all(Path(employee['source']['rolePath']).read_text() in text and Path(employee['source']['loopPath']).read_text() in text for text in owned)
        checks['retainedEmployeeHandles'] = all(any(current['id'] == employee['id'] and current['generation'] == employee['generation'] and current['nativeHandle'] == employee['nativeHandle'] for current in report['employees']) for employee in saved['employees'] if employee['role'] != 'manager')
        child_starts = [row for row in events if row['kind'] == 'cold-session-start' and row['phase'] == 'B' and row.get('parent') == 'Main']
        checks['persistedChildHeaders'] = len(child_starts) == 2 and all(any(row.get('type') == 'session' and row.get('id') == child['sessionId'] and row.get('parentSession') == saved['rootFile'] for row in map(json.loads, Path(child['file']).read_text().splitlines())) for child in child_starts)
        checks['noOfflineObservations'] = evidence['afterKill']['records'] == evidence['beforeResume']['records']
        checks['currentSourceHashes'] = all(hashlib.sha256((repo/path).read_bytes()).hexdigest() == digest for path, digest in evidence['sourceHashes'].items())
        if not all(checks.values()):
            raise AssertionError(checks)
        evidence['status'] = 'PASS'
        return 0
    except BaseException as error:
        evidence['failure'] = {'kind': type(error).__name__, 'message': str(error)}
        raise
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            evidence['processes'][-1]['exit'] = process.wait(timeout=10)
            evidence['processes'][-1]['exitedAt'] = time.time()
        if workspace.exists():
            evidence['events'] = [json.loads(line) for line in (workspace / 'events.jsonl').read_text().splitlines()] if (workspace / 'events.jsonl').exists() else []
            evidence['stderr'] = (workspace / 'stderr.txt').read_text() if (workspace / 'stderr.txt').exists() else ''
            evidence['stdout'] = (workspace / 'stdout.jsonl').read_text() if (workspace / 'stdout.jsonl').exists() else ''
            evidence['transcripts'] = {str(path.relative_to(workspace)): path.read_text() for path in (workspace / 'sessions').rglob('*.jsonl')}
        save()
        if installed:
            result = subprocess.run(['bun', str(repo / 'extensions/startup/install.ts'), 'uninstall', profile], env=env, text=True, capture_output=True)
            evidence['cleanup'] = {'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
            save()
            if result.returncode:
                raise RuntimeError('Owned fixture uninstall failed: ' + result.stderr)
        print(json.dumps({'status': evidence['status'], 'checks': evidence['checks'], 'failure': evidence.get('failure'), 'workspace': str(workspace)}))


if __name__ == '__main__':
    raise SystemExit(main())
