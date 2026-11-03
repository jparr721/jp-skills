#!/usr/bin/env python3
"""Private jp-skills storage. Python stdlib; git and gh are runtime CLIs."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def instant(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamps must include a timezone')
    return parsed.astimezone(timezone.utc)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + '\n'


def validate(document):
    if set(document) != {'schema', 'fields', 'events'} or document['schema'] != 1:
        raise ValueError('unsupported ledger schema')
    for group in ('fields', 'events'):
        if not isinstance(document[group], dict):
            raise ValueError(f'{group} must be an object')
        for entry in document[group].values():
            if set(entry) != {'value', 'updated_at'}:
                raise ValueError('every piece of information needs value and updated_at')
            instant(entry['updated_at'])
    return document


def merge_documents(left, right):
    """Union independent facts/events; newest timestamp wins per stable key.

    Equal-time disagreements converge via canonical JSON ordering, not merge side.
    Git retains earlier versions; a null value is a timestamped tombstone.
    """
    validate(left)
    validate(right)
    merged = {'schema': 1, 'fields': {}, 'events': {}}
    for group in ('fields', 'events'):
        for key in left[group].keys() | right[group].keys():
            candidates = [doc[group][key] for doc in (left, right) if key in doc[group]]
            merged[group][key] = max(candidates, key=lambda e: (instant(e['updated_at']), canonical(e)))
    return merged


def home():
    if os.environ.get('JP_SKILLS_HOME'):
        return Path(os.environ['JP_SKILLS_HOME']).expanduser()
    base = os.environ.get('XDG_CONFIG_HOME')
    if not base and os.name == 'nt':
        base = os.environ.get('APPDATA')
    return (Path(base).expanduser() if base else Path.home() / '.config') / 'jp-skills'


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_text(canonical(value), encoding='utf-8')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def ledger_path(root, namespace, slug):
    for token in (namespace, slug):
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', token):
            raise ValueError('namespace and slug must be lowercase hyphenated identifiers')
    path = root / namespace / 'ledger' / (slug + '.json')
    if any(p.is_symlink() for p in (root, root / namespace, path.parent, path)):
        raise ValueError('symlinked ledger paths are forbidden')
    return path


def write_entry(root, namespace, slug, key, value, at=None):
    path = ledger_path(root, namespace, slug)
    doc = validate(json.loads(path.read_text(encoding='utf-8'))) if path.exists() else {
        'schema': 1, 'fields': {}, 'events': {}}
    entry = {'updated_at': at or timestamp(), 'value': value}
    instant(entry['updated_at'])
    identifier = key if key is not None else str(uuid.uuid4())
    group = 'fields' if key is not None else 'events'
    incoming = {'schema': 1, 'fields': {}, 'events': {}}
    incoming[group][identifier] = entry
    save_json(path, merge_documents(doc, incoming))
    return identifier


def run(*args, cwd=None, check=True):
    result = subprocess.run(list(args), cwd=cwd, text=True, capture_output=True,
                            timeout=90, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr.strip()}')
    return result


def git(root, *args, check=True):
    return run('git', '-C', str(root), *args, check=check)


def check_private(repo, root=None):
    info = json.loads(run('gh', 'repo', 'view', repo, '--json',
                          'nameWithOwner,isPrivate,defaultBranchRef').stdout)
    if not info['isPrivate'] or info['nameWithOwner'].lower() != repo.lower():
        raise ValueError('storage must be the selected PRIVATE repository')
    if root is not None:
        remotes = git(root, 'remote', 'get-url', '--all', 'origin').stdout.splitlines()
        remotes += git(root, 'remote', 'get-url', '--push', '--all', 'origin').stdout.splitlines()
        allowed = {f'git@github.com:{repo}.git', f'https://github.com/{repo}.git',
                   f'https://github.com/{repo}', f'ssh://git@github.com/{repo}.git'}
        if not remotes or any(remote.lower() not in {url.lower() for url in allowed} for remote in remotes):
            raise ValueError('every effective fetch/push URL must match the configured private GitHub repository')
    return info


def is_ledger(path):
    return re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*/ledger/[a-z0-9]+(?:-[a-z0-9]+)*\.json', path) is not None


def snapshot(root, revision=None):
    if revision:
        names = git(root, 'ls-tree', '-rz', '--name-only', revision).stdout.split('\0')
    else:
        names = git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').stdout.split('\0')
        # Discover ledger files independently of repo/global ignore rules. Never
        # issue a success receipt for information excluded from the Git index.
        for path in root.glob('*/ledger/*.json'):
            name = path.relative_to(root).as_posix()
            if is_ledger(name):
                if git(root, 'check-ignore', '--quiet', '--', name, check=False).returncode == 0:
                    raise ValueError(f'ledger is ignored by Git; correct the ignore rule before syncing: {name}')
                names.append(name)
    docs = {}
    for name in set(filter(is_ledger, names)):
        if revision:
            text = git(root, 'show', f'{revision}:{name}').stdout
        else:
            path = root / name
            ledger_path(root, path.parts[-3], path.stem)
            if not path.exists():
                raise ValueError('use timestamped null tombstones, not file deletions')
            text = path.read_text(encoding='utf-8')
        docs[name] = validate(json.loads(text))
    return docs


def checked_commit(root, message):
    staged_tree = git(root, 'write-tree').stdout.strip()
    git(root, 'commit', '-m', message)
    changed = git(root, 'diff', '--name-only', '-z', staged_tree, 'HEAD').stdout.split('\0')
    try:
        if any(name and not is_ledger(name) for name in changed):
            raise ValueError('a repository hook changed unrelated content; local commit retained, refusing publication')
        snapshot(root, 'HEAD')  # Validate timestamp/schema changes made by normal hooks.
    except (ValueError, TypeError, OSError) as error:
        marker = Path(git(root, 'rev-parse', '--git-path', 'jp-skills-storage-blocked.json').stdout.strip())
        if not marker.is_absolute():
            marker = root / marker
        save_json(marker, {'updated_at': timestamp(), 'commit': git(root, 'rev-parse', 'HEAD').stdout.strip(),
                           'reason': str(error)})
        raise


def commit_ledgers(root, message):
    docs = snapshot(root)
    staged = git(root, 'diff', '--cached', '--name-only', '-z').stdout.split('\0')
    for name in filter(is_ledger, staged):
        indexed = git(root, 'show', f':{name}', check=False)
        if indexed.returncode or name not in docs:
            raise ValueError('use timestamped null tombstones, not staged file deletions')
        docs[name] = merge_documents(docs[name], validate(json.loads(indexed.stdout)))
    dirty = git(root, 'diff', '--name-only', '-z', 'HEAD', check=False).stdout.split('\0')
    dirty += git(root, 'diff', '--cached', '--name-only', '-z').stdout.split('\0')
    dirty += git(root, 'ls-files', '-z', '--others', '--exclude-standard').stdout.split('\0')
    if any(name and not is_ledger(name) for name in dirty):
        raise ValueError('unrelated storage edits need an explicit commit; refusing to stage them')
    for name, doc in docs.items():
        save_json(root / name, doc)
        git(root, 'add', '--', name)
    if git(root, 'diff', '--cached', '--quiet', check=False).returncode:
        checked_commit(root, message)


def sync(root, repo, branch, attempts=5):
    """Commit, fetch, semantic merge, push, and read back; never force-push."""
    root = Path(root)
    check_private(repo, root)
    if git(root, 'branch', '--show-current').stdout.strip() != branch:
        raise ValueError('storage checkout is on the wrong branch')
    git(root, 'check-ref-format', '--branch', branch)
    for marker in ('jp-skills-storage-blocked.json', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'):
        location = Path(git(root, 'rev-parse', '--git-path', marker).stdout.strip())
        if not location.is_absolute():
            location = root / location
        if location.exists():
            raise ValueError(f'storage requires explicit recovery before sync: {marker}')
    commit_ledgers(root, f'storage: record changes at {timestamp()}')
    for _ in range(attempts):
        # Explicit refspec refreshes only the configured branch. Empty origins are supported.
        fetched = git(root, 'fetch', 'origin', f'refs/heads/{branch}', check=False)
        if fetched.returncode and "couldn't find remote ref" not in fetched.stderr:
            raise RuntimeError(f'storage fetch failed: {fetched.stderr.strip()}')
        if not fetched.returncode:
            local = snapshot(root)
            remote = snapshot(root, 'FETCH_HEAD')
            merged = {name: merge_documents(local[name], remote[name])
                      if name in local and name in remote else (local.get(name) or remote[name])
                      for name in local.keys() | remote.keys()}
            merge_args = ['merge', '--no-commit']
            common = git(root, 'merge-base', 'HEAD', 'FETCH_HEAD', check=False)
            if common.returncode == 1:
                # Only the private, validated same-origin ledger histories may
                # bootstrap independently. Unknown files still hit conflict gates.
                for revision in ('HEAD', 'FETCH_HEAD'):
                    names = git(root, 'ls-tree', '-rz', '--name-only', revision).stdout.split('\0')
                    if any(name and not is_ledger(name) for name in names):
                        raise ValueError('unrelated non-ledger histories require explicit reconciliation')
                merge_args.append('--allow-unrelated-histories')
            elif common.returncode:
                raise RuntimeError(f'could not compare storage histories: {common.stderr.strip()}')
            result = git(root, *merge_args, 'FETCH_HEAD', check=False)
            conflicts = git(root, 'diff', '--name-only', '--diff-filter=U', '-z').stdout.split('\0')
            if result.returncode and not any(conflicts):
                raise RuntimeError(f'storage merge failed: {result.stderr.strip()}')
            if any(name and not is_ledger(name) for name in conflicts):
                git(root, 'merge', '--abort')
                raise ValueError('non-ledger conflict needs explicit reconciliation; no data discarded')
            for name, doc in merged.items():
                path = root / name
                ledger_path(root, path.parts[-3], path.stem)
                save_json(path, doc)
                git(root, 'add', '--', name)
            merge_head = git(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD', check=False)
            if not merge_head.returncode or git(root, 'diff', '--cached', '--quiet', check=False).returncode:
                checked_commit(root, f'storage: reconcile latest information at {timestamp()}')
        check_private(repo, root)  # Recheck effective push URLs immediately before publication.
        snapshot(root)  # Hooks must not leave malformed or ignored ledgers behind.
        pushed = git(root, 'push', '--porcelain', 'origin', f'HEAD:refs/heads/{branch}', check=False)
        if pushed.returncode:
            if any(word in pushed.stderr + pushed.stdout for word in ('[rejected]', 'fetch first', 'non-fast-forward')):
                continue
            raise RuntimeError(f'storage push failed; local commits retained: {pushed.stderr.strip()}')
        remote_head = git(root, 'ls-remote', '--exit-code', 'origin', f'refs/heads/{branch}').stdout.split()[0]
        local_head = git(root, 'rev-parse', 'HEAD').stdout.strip()
        if local_head == remote_head:
            docs = snapshot(root)
            tracked = set(git(root, 'ls-files', '-z').stdout.split('\0'))
            if not set(docs).issubset(tracked):
                raise RuntimeError('a ledger was not committed; no successful sync receipt')
            if git(root, 'status', '--porcelain').stdout.strip():
                raise RuntimeError('storage changed during sync; run the hook again')
            return {'updated_at': timestamp(), 'commit': local_head, 'repo': repo, 'branch': branch}
    raise RuntimeError('storage kept changing remotely; local commits retained, retry sync')


@contextmanager
def locked(base):
    base.mkdir(parents=True, exist_ok=True)
    lock = base / '.storage.lock'
    try:
        lock.mkdir()
    except FileExistsError:
        raise RuntimeError(f'storage is locked: {lock}; check its owner before recovery') from None
    try:
        (lock / 'owner.json').write_text(canonical({'pid': os.getpid(), 'created_at': timestamp()}))
        yield
    finally:
        (lock / 'owner.json').unlink(missing_ok=True)
        lock.rmdir()


def configuration(base):
    path = base / 'storage.json'
    if not path.exists():
        raise ValueError('storage is not configured; ask for repository name (default jp-skills-storage), then run setup')
    config = json.loads(path.read_text(encoding='utf-8'))
    if Path(config['clone_path']).resolve() != (base / 'storage').resolve():
        raise ValueError('storage clone must live under the canonical home')
    return config


def setup(base, repo):
    # The calling agent obtains the user's choice before supplying --repo.
    if not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?', repo):
        raise ValueError('expected a repository name or OWNER/REPO, not a URL')
    # gh is installed and authenticated by the caller's environment.
    if '/' not in repo:
        owner = run('gh', 'api', 'user', '--jq', '.login').stdout.strip()
        repo = f'{owner}/{repo}'
    if (base / 'storage.json').exists():
        existing = configuration(base)
        if existing['repo'].lower() != repo.lower():
            raise ValueError('storage is already configured for another repo; no automatic switching')
    lookup = run('gh', 'api', f'repos/{repo}', check=False)
    if lookup.returncode:
        if '404' not in lookup.stderr:
            raise RuntimeError(f'repository lookup failed: {lookup.stderr.strip()}')
        run('gh', 'repo', 'create', repo, '--private', '--add-readme', '--description',
            'Private timestamped state and ledgers for jp-skills')
    info = check_private(repo)  # Read back even after a successful create.
    root = base / 'storage'
    if root.is_symlink():
        raise ValueError('storage clone must not be a symlink')
    if not root.exists():
        run('gh', 'repo', 'clone', repo, str(root))
    check_private(repo, root)
    branch_info = info.get('defaultBranchRef')
    branch = branch_info['name'] if branch_info else 'main'
    if git(root, 'branch', '--show-current').stdout.strip() != branch:
        raise ValueError('existing storage checkout is on a different branch')
    (root / 'server-maintenance' / 'ledger').mkdir(parents=True, exist_ok=True)
    if not ledger_path(root, 'server-maintenance', 'ledger').exists():
        write_entry(root, 'server-maintenance', 'ledger', 'purpose',
                    'Timestamped server connection records and operations ledger')
    config = {'repo': repo, 'clone_path': str(root.resolve()), 'branch': branch,
              'updated_at': timestamp()}
    save_json(base / 'storage.json', config)
    return config


def migrate(root, sources):
    """Import full legacy bytes once; file mtime is provenance, not operation time."""
    count = 0
    for source in sources:
        for path in sorted(Path(source).glob('*.md')):
            if path.is_symlink():
                raise ValueError(f'review symlinked legacy source manually: {path}')
            slug = path.name.removesuffix('.ops.md') if path.name.endswith('.ops.md') else path.stem
            target = ledger_path(root, 'server-maintenance', slug)
            doc = json.loads(target.read_text(encoding='utf-8')) if target.exists() else {
                'schema': 1, 'fields': {}, 'events': {}}
            validate(doc)
            content = path.read_text(encoding='utf-8')
            event_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'jp-skills:legacy:{path.name}:{content}'))
            if event_id in doc['events']:
                continue
            at = timestamp()
            modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
            if not path.name.endswith('.ops.md'):
                # Explicit source fields retain their original file's time and never
                # displace a later observed fact. The complete original is kept below.
                header = re.split(r'^##[ \t]', content, maxsplit=1, flags=re.MULTILINE)[0]
                for key, value in re.findall(r'^- ([a-z_]+):[ \t]*(.*)$', header, flags=re.MULTILINE):
                    incoming = {'schema': 1, 'fields': {
                        key: {'value': value, 'updated_at': modified}}, 'events': {}}
                    doc = merge_documents(doc, incoming)
            doc['events'][event_id] = {'updated_at': at, 'value': {
                'kind': 'legacy-import', 'source_name': path.name, 'content': content,
                'source_modified_at': modified, 'occurred_at': None,
                'timestamp_basis': 'Import time; field times use source file mtime, not verified observation time. Original dates remain in content.'}}
            save_json(target, doc)
            count += 1
    return count


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    setup_cmd = commands.add_parser('setup', help='create/clone a private GitHub repo after user choice')
    setup_cmd.add_argument('--repo')
    for name in ('sync', 'post-run', 'migrate', 'status'):
        commands.add_parser(name)
    for name in ('put', 'append'):
        command = commands.add_parser(name)
        command.add_argument('--namespace', default='server-maintenance')
        command.add_argument('--server', required=True)
        if name == 'put':
            command.add_argument('--key', required=True)
        command.add_argument('--value-json', required=True, help='JSON value; use null as a field tombstone')
    args = parser.parse_args(argv)
    base = home()
    if args.command == 'post-run' and not (base / 'storage.json').exists():
        return 0  # No implicit opt-in or remote side effects during unrelated skill runs.
    with locked(base):
        if args.command == 'setup':
            selected = args.repo
            if selected is None:
                if not sys.stdin.isatty():
                    raise ValueError('ask the user to choose a repo, then supply --repo (default jp-skills-storage)')
                selected = input('Private storage repository [jp-skills-storage]: ').strip() or 'jp-skills-storage'
            print(canonical(setup(base, selected)), end='')
            return 0
        config = configuration(base)
        root = Path(config['clone_path'])
        if args.command in ('sync', 'post-run'):
            receipt = sync(root, config['repo'], config['branch'])
            save_json(base / 'storage-last-sync.json', receipt)
            print(canonical(receipt), end='')
        elif args.command == 'status':
            print(canonical(config), end='')
        elif args.command == 'migrate':
            sources = [base / 'servers', Path.home() / '.local/share/server-maintenance/servers']
            count = migrate(root, sources)
            print(canonical({'imported_files': count, 'updated_at': timestamp()}), end='')
        else:
            identifier = write_entry(root, args.namespace, args.server,
                                     args.key if args.command == 'put' else None,
                                     json.loads(args.value_json))
            print(canonical({'id': identifier, 'updated_at': timestamp()}), end='')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f'storage: {error}', file=sys.stderr)
        sys.exit(1)
