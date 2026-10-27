"""Offline storage tests; Git integration uses real local bare remotes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/cleanup/scripts/storage.py'


def load_storage():
    if not SCRIPT.exists():
        raise AssertionError('timestamped private storage helper has not been implemented')
    spec = importlib.util.spec_from_file_location('storage', SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def document(fields=None, events=None):
    return {'schema': 1, 'fields': fields or {}, 'events': events or {}}


def field(value, at):
    return {'value': value, 'updated_at': at}


class MergeTests(unittest.TestCase):
    def test_merge_preserves_independent_information_and_uses_latest_instant(self):
        s = load_storage()
        left = document({'ssh_target': field('old', '2026-10-26T10:00:00Z'),
                         'port': field(22, '2026-10-26T11:00:00Z')},
                        {'left': field('first operation', '2026-10-26T11:00:00Z')})
        right = document({'ssh_target': field('new', '2026-10-26T07:00:00-06:00')},
                         {'right': field('second operation', '2026-10-26T13:00:00Z')})
        merged = s.merge_documents(left, right)
        self.assertEqual(merged['fields']['ssh_target']['value'], 'new')
        self.assertEqual(merged['fields']['port']['value'], 22)
        self.assertEqual(set(merged['events']), {'left', 'right'})
        self.assertEqual(merged, s.merge_documents(right, left))


    def test_merge_rejects_missing_or_naive_timestamps_and_converges_on_ties(self):
        s = load_storage()
        at = '2026-10-26T00:00:00Z'
        left = document({'setting': field('a', at)})
        right = document({'setting': field('b', at)})
        self.assertEqual(s.merge_documents(left, right), s.merge_documents(right, left))
        for bad in ({'value': 'missing'}, field('naive', '2026-10-26T00:00:00')):
            with self.assertRaises(ValueError):
                s.merge_documents(document({'bad': bad}), left)


class WriteTests(unittest.TestCase):
    def test_timestamped_fields_and_independent_events(self):
        s = load_storage()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            s.write_entry(root, 'server-maintenance', 'aspen', 'ssh_target', 'jsp@aspen')
            first = s.write_entry(root, 'server-maintenance', 'aspen', None, {'change': 'restart'})
            second = s.write_entry(root, 'server-maintenance', 'aspen', None, {'change': 'upgrade'})
            saved = json.loads((root / 'server-maintenance/ledger/aspen.json').read_text())
            self.assertEqual(saved['fields']['ssh_target']['value'], 'jsp@aspen')
            self.assertNotEqual(first, second)
            self.assertEqual(len(saved['events']), 2)
            s.validate(saved)
            for group in ('fields', 'events'):
                for entry in saved[group].values():
                    self.assertIsNotNone(s.instant(entry['updated_at']))

    def test_paths_cannot_escape_storage(self):
        s = load_storage()
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                s.write_entry(Path(tmp), '../escape', 'aspen', 'a', 'b')


class GitSyncTests(unittest.TestCase):
    def test_divergent_clones_reconcile_latest_fields_and_keep_both_operations(self):
        s = load_storage()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            remote, a, b = (base / name for name in ('origin.git', 'a', 'b'))
            def git(root, *args):
                result = subprocess.run(['git', '-C', str(root), *args], check=True,
                                        capture_output=True, text=True)
                return result.stdout.strip()
            subprocess.run(['git', 'init', '--bare', '--initial-branch=main', str(remote)],
                           check=True, capture_output=True)
            for clone in (a, b):
                subprocess.run(['git', 'clone', str(remote), str(clone)], check=True, capture_output=True)
                git(clone, 'config', 'user.name', 'Storage test')
                git(clone, 'config', 'user.email', 'test@example.invalid')
            s.write_entry(a, 'server-maintenance', 'aspen', 'ssh_target', 'original', '2026-10-26T01:00:00Z')
            with patch.object(s, 'check_private'):
                s.sync(a, 'example/private', 'main')
            git(b, 'pull', '--ff-only', 'origin', 'main')
            s.write_entry(a, 'server-maintenance', 'aspen', 'ssh_target', 'newest', '2026-10-26T03:00:00Z')
            s.write_entry(a, 'server-maintenance', 'aspen', None, 'operation a')
            s.write_entry(b, 'server-maintenance', 'aspen', 'ssh_target', 'stale', '2026-10-26T02:00:00Z')
            s.write_entry(b, 'server-maintenance', 'aspen', None, 'operation b')
            with patch.object(s, 'check_private'):
                s.sync(a, 'example/private', 'main')
                s.sync(b, 'example/private', 'main')
                s.sync(a, 'example/private', 'main')
            doc = json.loads((a / 'server-maintenance/ledger/aspen.json').read_text())
            self.assertEqual(doc['fields']['ssh_target']['value'], 'newest')
            self.assertEqual({e['value'] for e in doc['events'].values()}, {'operation a', 'operation b'})
            self.assertEqual(git(a, 'rev-parse', 'HEAD'), git(b, 'rev-parse', 'HEAD'))
            before = git(a, 'rev-parse', 'HEAD')
            with patch.object(s, 'check_private'):
                s.sync(a, 'example/private', 'main')
            self.assertEqual(before, git(a, 'rev-parse', 'HEAD'))
            self.assertEqual(git(a, 'status', '--porcelain'), '')


class SetupMigrationTests(unittest.TestCase):
    def test_setup_uses_gh_private_create_and_verifies_before_saving(self):
        s = load_storage()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            remote = base / 'remote.git'
            subprocess.run(['git', 'init', '--bare', '--initial-branch=main', str(remote)],
                           check=True, capture_output=True)
            original_run = s.run
            calls = []
            created = False
            def fake_run(*args, **kwargs):
                nonlocal created
                if args[0] != 'gh':
                    return original_run(*args, **kwargs)
                calls.append(args)
                if args[1:3] == ('repo', 'view'):
                    return subprocess.CompletedProcess(args, 0, json.dumps({
                        'nameWithOwner': 'test/jp-skills-storage', 'isPrivate': True,
                        'defaultBranchRef': {'name': 'main'}}), '')
                if args[1:3] == ('api', 'repos/test/jp-skills-storage') and not created:
                    return subprocess.CompletedProcess(args, 1, '', 'HTTP 404')
                if args[1:3] == ('repo', 'create'):
                    created = True
                if args[1:3] == ('repo', 'clone'):
                    original_run('git', 'clone', str(remote), args[4])
                    original_run('git', '-C', args[4], 'remote', 'set-url', 'origin',
                                 'git@github.com:test/jp-skills-storage.git')
                return subprocess.CompletedProcess(args, 0, '', '')
            with patch.object(s, 'run', side_effect=fake_run):
                config = s.setup(base / 'home', 'test/jp-skills-storage')
            create = next(call for call in calls if call[1:3] == ('repo', 'create'))
            self.assertIn('--private', create)
            self.assertIn('--add-readme', create)
            self.assertEqual(config['repo'], 'test/jp-skills-storage')
            self.assertTrue((base / 'home/storage/server-maintenance/ledger').is_dir())
            self.assertEqual(json.loads((base / 'home/storage.json').read_text()), config)
            self.assertTrue(config['updated_at'].endswith('Z'))

    def test_migration_preserves_sources_and_is_idempotent(self):
        s = load_storage()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source, root = base / 'servers', base / 'storage'
            source.mkdir()
            record = source / 'aspen.md'
            body = '# Aspen\n- ssh_target: jsp@aspen\n- port: 22\n## Troubleshooting\n- port: 2222\n'
            record.write_text(body)
            (source / 'aspen.ops.md').write_text('## 2020-01-01 — restart\n- change: restarted nginx\n')
            s.write_entry(root, 'server-maintenance', 'aspen', 'ssh_target', 'newer', '2099-01-01T00:00:00Z')
            self.assertEqual(s.migrate(root, [source]), 2)
            self.assertEqual(s.migrate(root, [source]), 0)
            doc = json.loads((root / 'server-maintenance/ledger/aspen.json').read_text())
            self.assertEqual(doc['fields']['ssh_target']['value'], 'newer')
            self.assertEqual(doc['fields']['port']['value'], '22')
            self.assertEqual(len(doc['events']), 2)
            self.assertEqual(record.read_text(), body)
            s.validate(doc)


class SafetyTests(unittest.TestCase):
    def test_post_run_without_configuration_is_a_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(['python3', str(SCRIPT.with_name('post-run.py'))],
                                    env={**os.environ, 'JP_SKILLS_HOME': str(Path(tmp)/'unused')},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((Path(tmp)/'unused').exists())

    def test_lock_prevents_concurrent_storage_writers(self):
        s = load_storage()
        with tempfile.TemporaryDirectory() as tmp:
            with s.locked(Path(tmp)):
                with self.assertRaises(RuntimeError):
                    with s.locked(Path(tmp)):
                        self.fail('second writer acquired the lock')
            self.assertFalse((Path(tmp)/'.storage.lock').exists())

    def test_public_repository_is_refused(self):
        s = load_storage()
        result = subprocess.CompletedProcess([], 0, json.dumps({
            'nameWithOwner':'test/storage', 'isPrivate':False, 'defaultBranchRef':{'name':'main'}}), '')
        with patch.object(s, 'run', return_value=result):
            with self.assertRaises(ValueError):
                s.check_private('test/storage')

    def test_pre_staged_nonledger_content_cannot_be_published(self):
        s = load_storage()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            s.run('git', 'init', '--initial-branch=main', str(root))
            s.git(root, 'config', 'user.name', 'Storage test')
            s.git(root, 'config', 'user.email', 'test@example.invalid')
            note = root / 'README.md'
            note.write_text('original')
            s.git(root, 'add', 'README.md')
            s.git(root, 'commit', '-m', 'initialize')
            note.write_text('staged unrelated content')
            s.git(root, 'add', 'README.md')
            note.write_text('original')  # HEAD diff cancels out, but index is dirty.
            s.write_entry(root, 'server-maintenance', 'aspen', 'port', 22)
            with self.assertRaises(ValueError):
                s.commit_ledgers(root, 'must not include staged unrelated content')


class ReviewRegressionTests(unittest.TestCase):
    def setUp(self):
        self.s = load_storage()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.remote = self.base / 'origin.git'
        self.s.run('git', 'init', '--bare', '--initial-branch=main', str(self.remote))
        self.a, self.b = self.base / 'a', self.base / 'b'
        for root in (self.a, self.b):
            self.s.run('git', 'clone', str(self.remote), str(root))
            self.s.git(root, 'config', 'user.name', 'Storage test')
            self.s.git(root, 'config', 'user.email', 'test@example.invalid')

    def test_private_fetch_origin_with_public_pushurl_is_refused(self):
        s = self.s
        s.git(self.a, 'remote', 'set-url', 'origin', 'git@github.com:test/private.git')
        s.git(self.a, 'config', 'remote.origin.pushurl', 'git@github.com:test/public.git')
        original_run = s.run
        def with_gh(*args, **kwargs):
            if args[0] == 'gh':
                return subprocess.CompletedProcess(args, 0, json.dumps({
                    'nameWithOwner': 'test/private', 'isPrivate': True}), '')
            return original_run(*args, **kwargs)
        with patch.object(s, 'run', side_effect=with_gh):
            with self.assertRaises(ValueError):
                s.check_private('test/private', self.a)

    def test_staged_only_newer_ledger_fact_is_retained(self):
        s = self.s
        s.write_entry(self.a, 'server-maintenance', 'aspen', 'port', 22, '2026-10-26T01:00:00Z')
        s.commit_ledgers(self.a, 'initialize')
        path = self.a / 'server-maintenance/ledger/aspen.json'
        before = path.read_text()
        s.write_entry(self.a, 'server-maintenance', 'aspen', 'port', 2222, '2026-10-26T02:00:00Z')
        s.git(self.a, 'add', '--', str(path))
        path.write_text(before)
        s.commit_ledgers(self.a, 'preserve staged information')
        self.assertEqual(json.loads(path.read_text())['fields']['port']['value'], 2222)

    def test_ignored_ledger_causes_visible_failure_not_false_receipt(self):
        s = self.s
        (self.a / '.git/info/exclude').write_text('*.json\n')
        s.write_entry(self.a, 'server-maintenance', 'aspen', 'port', 22)
        with patch.object(s, 'check_private'):
            with self.assertRaisesRegex(ValueError, 'ignored'):
                s.sync(self.a, 'test/private', 'main')

    def test_hook_cannot_silently_add_unrelated_content_to_storage_commit(self):
        if os.name == 'nt':
            self.skipTest('POSIX shell hook fixture')
        s = self.s
        s.write_entry(self.a, 'server-maintenance', 'aspen', 'port', 22)
        hook = self.a / '.git/hooks/pre-commit'
        hook.write_text('#!/bin/sh\nprintf "unrelated" > accidental.txt\ngit add accidental.txt\n')
        hook.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'hook'):
            s.commit_ledgers(self.a, 'must detect unexpected hook changes')
        with patch.object(s, 'check_private'):
            with self.assertRaisesRegex(ValueError, 'blocked'):
                s.sync(self.a, 'test/private', 'main')

    def test_two_empty_origin_writers_reconcile_without_losing_either(self):
        s = self.s
        for root, operation in ((self.a, 'first'), (self.b, 'second')):
            s.write_entry(root, 'server-maintenance', 'aspen', None, operation)
        with patch.object(s, 'check_private'):
            s.sync(self.a, 'test/private', 'main')
            s.sync(self.b, 'test/private', 'main')
            s.sync(self.a, 'test/private', 'main')
        doc = json.loads((self.a / 'server-maintenance/ledger/aspen.json').read_text())
        self.assertEqual({e['value'] for e in doc['events'].values()}, {'first', 'second'})
        self.assertEqual(s.git(self.a, 'rev-parse', 'HEAD').stdout, s.git(self.b, 'rev-parse', 'HEAD').stdout)


if __name__ == '__main__':
    unittest.main()
