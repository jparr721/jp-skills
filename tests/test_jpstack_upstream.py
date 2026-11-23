"""Contracts for jpstack upstream reconciliation, using a local fake upstream."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'jpstack/scripts/upstream.py'


def git(cwd, *argv):
    return subprocess.run(['git', '-C', str(cwd), *argv], check=True, capture_output=True,
                          text=True).stdout.strip()


class JpstackUpstreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.upstream = base / 'upstream'
        self.jpstack = base / 'jpstack'
        self.clone = base / 'clone'
        git(base, 'init', '-q', '-b', 'main', str(self.upstream))
        git(self.upstream, 'config', 'user.email', 't@example.com')
        git(self.upstream, 'config', 'user.name', 't')
        self.write('pstack/skills/why/SKILL.md', 'one\ntwo\nthree\nfour\nfive\n')
        self.write('pstack/skills/setup-pstack/SKILL.md', 'setup\n')
        self.write('pstack/skills/make-bot-ui/SKILL.md', 'bot\n')
        self.write('pstack/automations/x.md', 'auto\n')
        self.pinned = self.commit()
        self.jpstack.mkdir()
        (self.jpstack / 'UPSTREAM.json').write_text(json.dumps({
            'repo': str(self.upstream), 'branch': 'main', 'path': 'pstack', 'commit': self.pinned,
            'synced_at': '', 'include': ['skills'],
            'exclude': {'skills/make-bot-ui': 'cursor only'},
            'rename': {'skills/setup-pstack': 'skills/setup-jpstack'},
        }))
        self.assertEqual(self.run_tool('fetch').returncode, 0)
        self.assertEqual(self.run_tool('import').returncode, 0)

    def write(self, rel, text):
        path = self.upstream / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self):
        git(self.upstream, 'add', '-A')
        git(self.upstream, 'commit', '-qm', 'c')
        return git(self.upstream, 'rev-parse', 'HEAD')

    def run_tool(self, *argv):
        return subprocess.run([sys.executable, str(SCRIPT), '--jpstack', str(self.jpstack),
                               '--clone', str(self.clone), *argv], capture_output=True, text=True)

    def test_import_applies_policy(self):
        self.assertTrue((self.jpstack / 'skills/why/SKILL.md').is_file())
        self.assertTrue((self.jpstack / 'skills/setup-jpstack/SKILL.md').is_file())
        self.assertFalse((self.jpstack / 'skills/make-bot-ui').exists())
        self.assertFalse((self.jpstack / 'automations').exists())

    def test_merge_keeps_local_edits_and_takes_upstream_changes(self):
        local = self.jpstack / 'skills/why/SKILL.md'
        local.write_text('ONE local\ntwo\nthree\nfour\nfive\n')
        self.write('pstack/skills/why/SKILL.md', 'one\ntwo\nthree\nfour\nFIVE upstream\n')
        self.write('pstack/skills/new/SKILL.md', 'new\n')
        self.write('pstack/skills/make-bot-ui/SKILL.md', 'bot v2\n')
        head = self.commit()
        self.assertEqual(self.run_tool('fetch').returncode, 0)
        status = self.run_tool('status')
        self.assertIn('REVIEW-ONLY', status.stdout)
        merged = self.run_tool('merge')
        self.assertEqual(merged.returncode, 0, merged.stdout + merged.stderr)
        self.assertEqual(local.read_text(), 'ONE local\ntwo\nthree\nfour\nFIVE upstream\n')
        self.assertEqual((self.jpstack / 'skills/new/SKILL.md').read_text(), 'new\n')
        self.assertFalse((self.jpstack / 'skills/make-bot-ui').exists())
        self.assertEqual(self.run_tool('pin', head).returncode, 0)
        self.assertEqual(json.loads((self.jpstack / 'UPSTREAM.json').read_text())['commit'], head)

    def test_conflict_leaves_markers_that_check_rejects(self):
        (self.jpstack / 'skills/why/SKILL.md').write_text('one\nlocal two\nthree\nfour\nfive\n')
        self.write('pstack/skills/why/SKILL.md', 'one\nupstream two\nthree\nfour\nfive\n')
        self.commit()
        self.run_tool('fetch')
        self.assertEqual(self.run_tool('merge').returncode, 1)
        check = self.run_tool('check')
        self.assertEqual(check.returncode, 1)
        self.assertIn('skills/why/SKILL.md', check.stdout)

    def test_check_flags_cursor_residue(self):
        (self.jpstack / 'skills/why/SKILL.md').write_text('Write ~/.cursor/rules/x.mdc\n')
        self.assertEqual(self.run_tool('check').returncode, 1)
        (self.jpstack / 'skills/why/SKILL.md').write_text('Write <home>/jpstack/models.md\n')
        (self.jpstack / 'skills/setup-jpstack/SKILL.md').write_text('setup\n')
        self.assertEqual(self.run_tool('check').returncode, 0, self.run_tool('check').stdout)


if __name__ == '__main__':
    unittest.main()
