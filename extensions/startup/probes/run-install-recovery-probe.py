#!/usr/bin/env python3
"""Isolated native link failure after symlink creation, before lock persistence."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--workspace', type=Path, required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
workspace = args.workspace.resolve()
if not workspace.is_relative_to(repo / '.superpowers/sdd/2026-10-13-startup-v6/native-scratch'):
    raise ValueError('Recovery proof requires plan scratch isolation')
workspace.mkdir(parents=True, exist_ok=False)
profile = 'startup-recovery-' + uuid.uuid4().hex[:10]
env = {key: value for key, value in os.environ.items() if key in {'PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'SHELL', 'USER', 'LOGNAME'}}
env.update({'PI_CONFIG_DIR': '.omp-' + profile, 'XDG_DATA_HOME': str(workspace / 'data'), 'XDG_STATE_HOME': str(workspace / 'state'), 'XDG_CACHE_HOME': str(workspace / 'cache')})
for kind in ['data', 'state', 'cache']:
    (workspace / kind / 'omp/profiles' / profile).mkdir(parents=True)
plugins = workspace / 'data/omp/profiles' / profile / 'plugins'
plugins.mkdir()
lock = plugins / 'omp-plugins.lock.json'
prior = b'{"plugins": {}, "settings": {"user-plugin": {"keep": true}}}\r\n'
lock.write_bytes(prior)
lock.chmod(0o640)
user = plugins / 'user-owned.txt'
user.write_bytes(b'Unrelated user bytes\r\n')
dependency = plugins / 'package.json'
dependency.write_bytes(b'{"dependencies":{"other-plugin":"1.0.0"}}\n')
preserved = {path: (path.read_bytes(), path.stat().st_mode & 0o777) for path in [lock, user, dependency]}
wrapper = workspace / 'omp-partial-link'
wrapper.write_text('#!/usr/bin/env python3\nimport os, subprocess, sys\nfrom pathlib import Path\nlock=Path(' + repr(str(lock)) + ')\ncommand=[' + repr(shutil.which('omp')) + ']+sys.argv[1:]\nif sys.argv[1:]==["--version"]:\n    sys.exit(subprocess.run(command).returncode)\nlock.chmod(0o400)\ntry:\n    result=subprocess.run(command)\nfinally:\n    lock.chmod(0o640)\nsys.exit(result.returncode)\n')
wrapper.chmod(0o700)
env['OMP_BINARY'] = str(wrapper)
installer = repo / 'extensions/startup/install.ts'
link = plugins / 'node_modules/@jp-skills/startup'
receipt = plugins / 'jp-skills-startup.install.json'
evidence = {'status': 'FAIL', 'profile': profile, 'commands': [], 'checks': {}}
try:
    install = ['bun', str(installer), 'install', profile]
    result = subprocess.run(install, env=env, cwd=workspace, capture_output=True, text=True)
    evidence['commands'].append({'args': install.copy(), 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
    checks = evidence['checks']
    checks['nativePartialLink'] = result.returncode != 0 and link.is_symlink() and link.resolve() == installer.parent and lock.read_bytes() == prior
    checks['nativePermissionFailure'] = 'EACCES' in result.stderr or 'Permission denied' in result.stderr
    checks['writeAheadReceipt'] = receipt.is_file() and json.loads(receipt.read_text())['before'].encode() == prior
    checks['mutexReleasedAfterFailure'] = not (plugins / '.jp-skills-startup.install.lock').exists()
    if not all(checks.values()):
        raise AssertionError(checks)
    uninstall = ['bun', str(installer), 'uninstall', profile]
    result = subprocess.run(uninstall, env=env, cwd=workspace, capture_output=True, text=True)
    evidence['commands'].append({'args': uninstall.copy(), 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
    checks['ownedPartialEffectsRemoved'] = result.returncode == 0 and not link.is_symlink() and not receipt.exists()
    checks['unrelatedBytesAndModesPreserved'] = all(path.read_bytes() == data and path.stat().st_mode & 0o777 == mode for path, (data, mode) in preserved.items())
    evidence['preserved'] = {str(path.relative_to(workspace)): {'sha256': hashlib.sha256(data).hexdigest(), 'mode': oct(mode)} for path, (data, mode) in preserved.items()}
    if not all(checks.values()):
        raise AssertionError(checks)
    evidence['status'] = 'PASS'
finally:
    evidence['sourceHashes'] = {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest() for path in [installer, Path(__file__)]}
    with gzip.open(args.evidence, 'wt') as file:
        json.dump(evidence, file)
    print(json.dumps({'status': evidence['status'], 'checks': evidence['checks']}))
