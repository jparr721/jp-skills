"""Offline contract checks for the hand-invoked, read-only discussion mode."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AskSkillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.content = (ROOT / 'skills/ask/SKILL.md').read_text()
        _, cls.frontmatter, cls.body = cls.content.split('---', 2)

    def test_frontmatter_is_portable_and_hand_invoked(self):
        self.assertTrue(self.content.startswith('---\n'))
        self.assertIn('\nname: ask\n', self.frontmatter)
        self.assertIn('\ndisable-model-invocation: true\n', self.frontmatter)
        self.assertIn('platforms: [linux, macos, windows]', self.frontmatter)
        description = next(line.removeprefix('description: ') for line in
                           self.frontmatter.splitlines() if line.startswith('description: '))
        self.assertLessEqual(len(description), 60)
        self.assertTrue(description.endswith('.'))
        self.assertNotIn('/Users/', self.content)
        self.assertNotIn('/home/', self.content)

    def test_bare_invocation_and_follow_up_mode(self):
        self.assertIn('reply `ask mode on`', self.body)
        self.assertIn('Stay in this mode across follow-up questions', self.body)
        self.assertIn('explicitly requests implementation', self.body)
        self.assertIn('“How would we change this?”', self.body)

    def test_discussion_forbids_mutations_and_execution(self):
        for rule in ('do not edit files', 'write plans or reports', 'install packages',
                     'run builds, tests or migrations', 'create tickets',
                     'commit, push, or open PRs', 'dispatch implementation'):
            with self.subTest(rule=rule):
                self.assertIn(rule, self.body)
        self.assertIn('not a tool sandbox', self.body)
        self.assertIn('get authorization first', self.body)

    def test_answers_require_source_evidence(self):
        for rule in ('`read_file`', 'definitions and relevant callers', '`path:line`',
                     'label unverified runtime claims', 'never read credential files'):
            with self.subTest(rule=rule):
                self.assertIn(rule, self.body)

    def test_repo_framework_and_catalog(self):
        for heading in ('## Herdr preflight', '## When to Use', '## Procedure',
                        '## Pitfalls', '## Verification', '## Framework tail'):
            self.assertIn(heading, self.body)
        self.assertIn('../cleanup/SKILL.md', self.body)
        self.assertIn('When the user ends the mode', self.body)
        readme = (ROOT / 'README.md').read_text()
        self.assertEqual(readme.count('[`ask`](skills/ask/SKILL.md)'), 1)

    def test_upgrade_includes_selected_hermes_profile(self):
        upgrade = (ROOT / 'skills/upgrading-jp-skills/SKILL.md').read_text()
        for registry in ('~/.claude/skills/', '~/.agents/skills/', '~/.codex/skills/',
                         '~/.pi/agent/skills/', '~/.omp/agent/skills/',
                         '${HERMES_HOME:-~/.hermes}/skills/'):
            self.assertIn(registry, upgrade)
        for rule in ('never modify another profile implicitly',
                     'preserve real files/directories', 'skills.external_dirs',
                     'Local Hermes skills take precedence',
                     'Verify actual discovery with Hermes', '/reload-skills'):
            self.assertIn(rule, upgrade)

    def test_documented_link_commands_preserve_existing_entries_on_repeat(self):
        readme = (ROOT / 'README.md').read_text()
        for heading in ('Link A Skill', 'Link Everything'):
            with self.subTest(heading=heading), tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp)
                repo = base / 'repo'
                source = repo / 'skills/ask'
                source.mkdir(parents=True)
                (source / 'SKILL.md').write_text('fixture')
                home = base / 'home'
                selected = home / '.hermes/profiles/selected'
                registries = [home / name for name in
                              ('.claude/skills', '.agents/skills', '.codex/skills',
                               '.pi/agent/skills', '.omp/agent/skills')]
                registries.append(selected / 'skills')
                for registry in registries:
                    registry.mkdir(parents=True)
                local = registries[0] / 'ask'
                local.mkdir()
                (local / 'keep').write_text('user skill')
                (registries[1] / 'ask').symlink_to(source, target_is_directory=True)
                (registries[2] / 'ask').symlink_to(base / 'missing')
                (registries[3] / 'ask').write_text('user file')
                section = readme.split('## ' + heading + '\n', 1)[1]
                match = re.search(r'```bash\n(.*?)```', section, re.S)
                assert match is not None, heading
                command = match.group(1)
                command = command.replace("skill='<skill-name>'", "skill='ask'")
                env = dict(os.environ, HOME=str(home), HERMES_HOME=str(selected))
                for _ in range(2):
                    subprocess.run(['bash', '-c', command], cwd=repo, env=env,
                                   check=True, capture_output=True, text=True)
                self.assertEqual((local / 'keep').read_text(), 'user skill')
                self.assertEqual(sorted(p.name for p in local.iterdir()), ['keep'])
                self.assertEqual(sorted(p.name for p in source.iterdir()), ['SKILL.md'])
                self.assertEqual((registries[2] / 'ask').readlink(), base / 'missing')
                self.assertEqual((registries[3] / 'ask').read_text(), 'user file')
                for registry in (registries[1], registries[4], registries[5]):
                    self.assertEqual((registry / 'ask').resolve(), source.resolve())
                self.assertFalse((home / '.hermes/skills').exists())


if __name__ == '__main__':
    unittest.main()
