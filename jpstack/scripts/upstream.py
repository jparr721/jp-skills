#!/usr/bin/env python3
"""Reconcile the vendored jpstack copy against upstream pstack.

jpstack is a plain copy of upstream prompts inside jp-skills. Nothing links to the
upstream checkout: it is a read-only reference clone under the jp-skills home that
this tool diffs against. The agent running jp-upgrading-jp-skills resolves what the
tool reports, then pins the new upstream commit.

Commands:
  fetch   create or update the reference clone and print upstream HEAD
  status  list upstream changes since the pinned commit, mapped to jpstack paths
  merge   three-way merge upstream changes into jpstack (base = pinned commit)
  check   fail on Cursor-specific residue or merge conflict markers in jpstack
  pin     record a new upstream commit in UPSTREAM.json
  import  copy every mapped file at the pinned commit (initial fork only)
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

JPSTACK = Path(__file__).resolve().parents[1]

# Files allowed to name Cursor: provenance and the harness map itself.
CHECK_ALLOW = {'README.md', 'LICENSE', 'UPSTREAM.json', 'docs/harness.md', 'scripts/upstream.py'}
# Residue patterns. Markdown gets the full list; code and scripts only the path/product ones.
CODE_PATTERNS = [
    r'\.cursor/', r'\.cursor-plugin', r'cursor-team-kit', r'cursor\.(sh|com)',
    r'pstack-models\.mdc', r'@cursor-skill', r'setup-pstack',
]
MD_PATTERNS = CODE_PATTERNS + [
    r'\bCursor\b', r'AskQuestion', r'generalPurpose', r'\bBugbot\b', r'[Cc]loud agents?\b',
    r'environment: "(cloud|local)"', r'cloud_base_branch', r'file_attachments',
    r'agent-transcripts', r'Custom Modes?', r'\bpstack\b', r'/add-plugin',
]
CONFLICT = re.compile(r'^(<<<<<<<|>>>>>>>) ', re.M)
TEXT_SUFFIXES = {'.md', '.sh', '.ts', '.json', '.tsv', '.mjs', '.js', ''}


def manifest() -> dict:
    return json.loads((JPSTACK / 'UPSTREAM.json').read_text())


def home() -> Path:
    if os.environ.get('JP_SKILLS_HOME'):
        return Path(os.environ['JP_SKILLS_HOME'])
    base = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    return Path(base) / 'jp-skills'


def clone_dir(args) -> Path:
    return Path(args.clone) if args.clone else home() / 'cache' / 'jpstack-upstream'


def git(clone: Path, *argv: str, check=True) -> subprocess.CompletedProcess:
    return subprocess.run(['git', '-C', str(clone), *argv], capture_output=True, check=check)


def map_path(m: dict, upstream_rel: str):
    """Upstream path relative to m['path'] -> jpstack path, or None when not vendored."""
    if not any(upstream_rel == inc or upstream_rel.startswith(inc + '/') for inc in m['include']):
        return None
    if any(upstream_rel == ex or upstream_rel.startswith(ex + '/') for ex in m['exclude']):
        return None
    for src, dst in m['rename'].items():
        if upstream_rel == src or upstream_rel.startswith(src + '/'):
            return dst + upstream_rel[len(src):]
    return upstream_rel


def excluded_hit(m: dict, upstream_rel: str):
    for ex, why in m['exclude'].items():
        if upstream_rel == ex or upstream_rel.startswith(ex + '/'):
            return why
    return None


def show(clone: Path, rev: str, path: str):
    r = git(clone, 'show', f'{rev}:{path}', check=False)
    return r.stdout if r.returncode == 0 else None


def head(clone: Path, m: dict) -> str:
    return git(clone, 'rev-parse', f'origin/{m["branch"]}').stdout.decode().strip()


def changes(clone: Path, m: dict, target: str):
    out = git(clone, 'diff', '--name-status', '--no-renames', m['commit'], target, '--', m['path']).stdout
    prefix = m['path'] + '/'
    for line in out.decode().splitlines():
        status, path = line.split('\t', 1)
        yield status, path[len(prefix):]


def cmd_fetch(args) -> int:
    m, clone = manifest(), clone_dir(args)
    if not (clone / '.git').exists():
        clone.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout', '--branch', m['branch'],
                        m['repo'], str(clone)], check=True, capture_output=True)
    git(clone, 'fetch', '--quiet', 'origin', m['branch'])
    print(f'clone {clone}\npinned {m["commit"]}\nupstream {head(clone, m)}')
    return 0


def cmd_status(args) -> int:
    m, clone = manifest(), clone_dir(args)
    target = args.to or head(clone, m)
    rows = 0
    for status, rel in changes(clone, m, target):
        dst = map_path(m, rel)
        why = excluded_hit(m, rel)
        if dst:
            print(f'{status}\t{rel}\t-> jpstack/{dst}')
        elif why:
            print(f'{status}\t{rel}\tREVIEW-ONLY ({why})')
        else:
            continue
        rows += 1
    print(f'{rows} upstream change(s) between {m["commit"][:12]} and {target[:12]}')
    return 0


def merge_one(ours: Path, base, theirs) -> str:
    """Returns 'clean', 'conflict', 'deleted', or 'unchanged'."""
    current = ours.read_bytes() if ours.exists() else None
    if theirs is None:  # deleted upstream
        if current is None:
            return 'unchanged'
        if current == base:
            ours.unlink()
            return 'deleted'
        return 'conflict-delete'
    if current is None:
        if base is None:  # added upstream
            ours.parent.mkdir(parents=True, exist_ok=True)
            ours.write_bytes(theirs)
            return 'clean'
        return 'conflict-local-delete'  # we removed a file upstream still edits
    if current == theirs:
        return 'unchanged'
    if current == (base or b''):
        ours.write_bytes(theirs)
        return 'clean'
    if b'\0' in current or b'\0' in theirs:
        return 'conflict-binary'
    with tempfile.TemporaryDirectory() as tmp:
        b, t = Path(tmp) / 'base', Path(tmp) / 'theirs'
        b.write_bytes(base or b'')
        t.write_bytes(theirs)
        r = subprocess.run(['git', 'merge-file', '-L', 'jpstack', '-L', 'pinned', '-L', 'upstream',
                            str(ours), str(b), str(t)], capture_output=True)
    return 'clean' if r.returncode == 0 else 'conflict'


def cmd_merge(args) -> int:
    m, clone = manifest(), clone_dir(args)
    target = args.to or head(clone, m)
    conflicts = 0
    for status, rel in changes(clone, m, target):
        dst = map_path(m, rel)
        if not dst:
            if excluded_hit(m, rel):
                print(f'review-only\t{rel}')
            continue
        src = f'{m["path"]}/{rel}'
        result = merge_one(JPSTACK / dst, show(clone, m['commit'], src), show(clone, target, src))
        conflicts += result.startswith('conflict')
        print(f'{result}\tjpstack/{dst}')
    print(f'merged to {target}; {conflicts} conflict(s). Resolve, run check, then pin {target}.')
    return 1 if conflicts else 0


def cmd_import(args) -> int:
    m, clone = manifest(), clone_dir(args)
    rev = m['commit']
    listed = git(clone, 'ls-tree', '-r', '--name-only', rev, '--', m['path']).stdout.decode().splitlines()
    count = 0
    for path in listed:
        rel = path[len(m['path']) + 1:]
        dst = map_path(m, rel)
        if not dst:
            continue
        target = JPSTACK / dst
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(show(clone, rev, path))
        mode = git(clone, 'ls-tree', rev, path).stdout.decode().split()[0]
        if mode == '100755':
            target.chmod(0o755)
        count += 1
    print(f'imported {count} files at {rev}')
    return 0


def cmd_check(args) -> int:
    root = Path(args.root) if args.root else JPSTACK
    md = re.compile('|'.join(MD_PATTERNS))
    code = re.compile('|'.join(CODE_PATTERNS))
    hits = 0
    for path in sorted(p for p in root.rglob('*') if p.is_file()):
        rel = path.relative_to(root).as_posix()
        if rel in CHECK_ALLOW or path.suffix not in TEXT_SUFFIXES or '/test/' in f'/{rel}':
            continue
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue
        pattern = md if path.suffix == '.md' else code
        for n, line in enumerate(text.splitlines(), 1):
            if CONFLICT.match(line) or pattern.search(line):
                print(f'{rel}:{n}: {line.strip()[:160]}')
                hits += 1
    print(f'{hits} Cursor-specific or conflict line(s)' if hits else 'jpstack is clean')
    return 1 if hits else 0


def cmd_pin(args) -> int:
    m = manifest()
    m['commit'] = args.commit
    m['synced_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    (JPSTACK / 'UPSTREAM.json').write_text(json.dumps(m, indent=2) + '\n')
    print(f'pinned {args.commit}')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--jpstack', type=Path, help='vendored tree (default: this script\'s jpstack/)')
    parser.add_argument('--clone', help='reference clone path (default <jp-skills home>/cache/jpstack-upstream)')
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('fetch').set_defaults(fn=cmd_fetch)
    for name, fn in (('status', cmd_status), ('merge', cmd_merge)):
        p = sub.add_parser(name)
        p.add_argument('--to', help='upstream commit (default origin HEAD)')
        p.set_defaults(fn=fn)
    p = sub.add_parser('check')
    p.add_argument('--root', help='tree to scan (default jpstack/)')
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser('pin')
    p.add_argument('commit')
    p.set_defaults(fn=cmd_pin)
    sub.add_parser('import').set_defaults(fn=cmd_import)
    args = parser.parse_args()
    if args.jpstack:
        global JPSTACK
        JPSTACK = args.jpstack.resolve()
    try:
        return args.fn(args)
    except subprocess.CalledProcessError as exc:
        print(f'git failed: {exc.stderr.decode(errors="replace") if exc.stderr else exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
