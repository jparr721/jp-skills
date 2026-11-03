"""Contracts for v8 registry migration, using isolated homes and checkouts."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = (Path(__file__).resolve().parents[1] /
          'skills/jp-upgrading-jp-skills/scripts/relink.py')
REGISTRIES = ('.claude/skills', '.agents/skills', '.codex/skills',
              '.pi/agent/skills', '.omp/agent/skills')


class UpgradeRegistryMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'
        self.home = self.base / 'home'
        self.skills = self.repo / 'skills'
        self.skills.mkdir(parents=True)
        (self.repo / 'VERSION').write_text('8.0.0\n')
        for name in ('jp-alpha', 'jp-beta'):
            source = self.skills / name
            source.mkdir()
            (source / 'SKILL.md').write_text(name)
        self.registries = [self.home / path for path in REGISTRIES]
        for registry in self.registries:
            registry.mkdir(parents=True)

    def relink(self):
        return subprocess.run([sys.executable, str(SCRIPT), '--repo', str(self.repo),
                               '--home', str(self.home)], capture_output=True, text=True)

    def test_migrates_dangling_legacy_links_and_is_idempotent(self):
        for registry in self.registries:
            (registry / 'alpha').symlink_to(self.skills / 'alpha')
            (registry / 'beta').symlink_to(os.path.relpath(self.repo / 'beta', registry))
            (registry / 'retired').symlink_to(self.skills / 'retired')
        # Foreign dangling links and nested entries are never removed.
        foreign = self.registries[0] / 'foreign'
        foreign.symlink_to(self.base / 'missing')
        nested = self.registries[1] / 'local'
        nested.mkdir()
        (nested / 'alpha').symlink_to(self.skills / 'alpha')
        first = self.relink()
        self.assertEqual(first.returncode, 0, first.stderr)
        for registry in self.registries:
            for old in ('alpha', 'beta', 'retired'):
                self.assertFalse((registry / old).is_symlink())
            for name in ('jp-alpha', 'jp-beta'):
                self.assertEqual((registry / name).resolve(), (self.skills / name).resolve())
        self.assertTrue(foreign.is_symlink())
        self.assertTrue((nested / 'alpha').is_symlink())
        second = self.relink()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertNotIn('created ', second.stdout)
        self.assertNotIn('removed ', second.stdout)

    def test_foreign_or_real_destination_aborts_before_any_mutation(self):
        for kind in ('file', 'directory', 'link'):
            with self.subTest(kind=kind):
                registry = self.registries[-1]
                dest = registry / 'jp-alpha'
                if kind == 'file':
                    dest.write_text('local')
                elif kind == 'directory':
                    dest.mkdir()
                else:
                    dest.symlink_to(self.base / 'missing')
                old = self.registries[0] / 'alpha'
                old.symlink_to(self.skills / 'alpha')
                result = self.relink()
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(old.is_symlink())
                self.assertFalse((self.registries[0] / 'jp-alpha').is_symlink())
                if kind == 'directory':
                    self.assertEqual(list(dest.iterdir()), [])
                    dest.rmdir()
                else:
                    dest.unlink()
                old.unlink()

    def test_registry_symlink_is_rejected_without_touching_its_target(self):
        registry = self.registries[0]
        registry.rmdir()
        outside = self.base / 'outside'
        outside.mkdir()
        registry.symlink_to(outside, target_is_directory=True)
        self.assertNotEqual(self.relink().returncode, 0)
        self.assertEqual(list(outside.iterdir()), [])

    def test_legacy_link_to_foreign_target_is_preserved(self):
        legacy = self.registries[0] / 'alpha'
        legacy.symlink_to(self.base / 'elsewhere')
        result = self.relink()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.readlink(legacy), str(self.base / 'elsewhere'))


if __name__ == '__main__':
    unittest.main()
