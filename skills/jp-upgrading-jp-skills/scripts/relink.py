#!/usr/bin/env python3
"""Migrate this checkout's skill links in the five standard registries."""

import argparse
import os
from pathlib import Path
import sys


REGISTRIES = (
    '.claude/skills', '.agents/skills', '.codex/skills',
    '.pi/agent/skills', '.omp/agent/skills',
)


def link_target(link: Path) -> Path:
    target = Path(os.readlink(link))
    return (link.parent / target).resolve(strict=False)


def legacy_target(link: Path) -> Path:
    target = Path(os.readlink(link))
    path = link.parent / target
    # Resolve parent aliases without following the final, possibly foreign component.
    return path.parent.resolve(strict=False) / path.name


def migrate(repo: Path, home: Path) -> None:
    repo = repo.resolve(strict=True)
    skills = repo / 'skills'
    if not (repo / 'VERSION').is_file() or not skills.is_dir():
        raise ValueError(f'not a jp-skills checkout: {repo}')
    sources = sorted(p for p in skills.iterdir() if p.is_dir() and (p / 'SKILL.md').is_file())
    if not sources or any(not p.name.startswith('jp-') or p.is_symlink() for p in sources):
        raise ValueError('expected a nonempty v8 checkout with only jp- skill directories')
    expected = {p.name: p.resolve(strict=True) for p in sources}
    legacy_names = {name[3:] for name in expected}
    registries = [home / path for path in REGISTRIES]
    removals = []

    # Preflight every destination before changing anything. Never follow a registry link.
    for registry in registries:
        if registry.is_symlink() or (registry.exists() and not registry.is_dir()):
            raise ValueError(f'registry is not a real directory: {registry}')
        if not registry.exists():
            continue
        for name, source in expected.items():
            dest = registry / name
            if dest.is_symlink():
                if link_target(dest) != source:
                    raise ValueError(f'foreign or incorrect destination: {dest} -> {os.readlink(dest)}')
            elif dest.exists():
                raise ValueError(f'destination is not a symlink: {dest}')
        for entry in registry.iterdir():
            if not entry.is_symlink() or entry.name.startswith('jp-'):
                continue
            target = legacy_target(entry)
            # Targets may be dangling after the pull; compare paths, not existence.
            old_skill = skills / entry.name
            old_root = repo / entry.name
            if target == old_skill or (entry.name in legacy_names and target == old_root):
                removals.append((entry, os.readlink(entry)))

    for registry in registries:
        registry.mkdir(parents=True, exist_ok=True)
        for name, source in expected.items():
            dest = registry / name
            if not dest.is_symlink():
                os.symlink(source, dest)  # fails rather than overwriting a raced destination
                print(f'created {dest} -> {source}')
    for registry in registries:
        for name, source in expected.items():
            dest = registry / name
            if not dest.is_symlink() or link_target(dest) != source:
                raise ValueError(f'link verification failed: {dest}')
    for entry, target in removals:
        if not entry.is_symlink() or os.readlink(entry) != target:
            raise ValueError(f'legacy link changed during migration: {entry}')
        entry.unlink()
        print(f'removed legacy link {entry} -> {target}')

    for registry in registries:
        for name, source in expected.items():
            dest = registry / name
            if not dest.is_symlink() or link_target(dest) != source:
                raise ValueError(f'link verification failed: {dest}')
        for entry in registry.iterdir():
            if entry.is_symlink() and not entry.name.startswith('jp-'):
                target = legacy_target(entry)
                if target == skills / entry.name or (
                    entry.name in legacy_names and target == repo / entry.name
                ):
                    raise ValueError(f'legacy link remains: {entry}')
    print(f'verified {len(expected)} skills in {len(registries)} registries')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, type=Path, help='v8 jp-skills checkout')
    parser.add_argument('--home', type=Path, default=Path.home(), help='user home containing registries')
    args = parser.parse_args()
    try:
        migrate(args.repo, args.home)
    except (OSError, ValueError) as exc:
        print(f'relink failed: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
