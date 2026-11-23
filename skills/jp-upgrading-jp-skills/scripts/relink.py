#!/usr/bin/env python3
"""Link this checkout's skills, jpstack skills and jpstack agents into the standard registries.

jp- skills come from <repo>/skills; jpstack skills come from the vendored copy in
<repo>/jpstack/skills and link unprefixed. Links always point into this checkout,
never into an upstream clone. Retired links that this tool owns are removed: legacy
unprefixed jp links, jp- links whose source directory is gone, and links into a
retired pstack install (any path ending in pstack/.../skills/<name>), which jpstack
replaces.
"""

import argparse
import os
from pathlib import Path
import sys


REGISTRIES = (
    '.claude/skills', '.agents/skills', '.codex/skills',
    '.pi/agent/skills', '.omp/agent/skills',
)
AGENT_REGISTRIES = ('.claude/agents',)


def link_target(link: Path) -> Path:
    target = Path(os.readlink(link))
    return (link.parent / target).resolve(strict=False)


def legacy_target(link: Path) -> Path:
    target = Path(os.readlink(link))
    path = link.parent / target
    # Resolve parent aliases without following the final, possibly foreign component.
    return path.parent.resolve(strict=False) / path.name


def is_pstack_link(entry: Path) -> bool:
    """A link into a retired pstack install: <...>/pstack/<...>/(skills|agents)/<entry name>."""
    target = legacy_target(entry)
    parts = target.parts
    return (target.name == entry.name and len(parts) > 2 and parts[-2] in ('skills', 'agents')
            and 'pstack' in parts[:-2])


def sources(repo: Path):
    skills = repo / 'skills'
    if not (repo / 'VERSION').is_file() or not skills.is_dir():
        raise ValueError(f'not a jp-skills checkout: {repo}')
    jp = sorted(p for p in skills.iterdir() if p.is_dir() and (p / 'SKILL.md').is_file())
    if not jp or any(not p.name.startswith('jp-') or p.is_symlink() for p in jp):
        raise ValueError('expected a nonempty checkout with only jp- skill directories')
    stack_dir = repo / 'jpstack' / 'skills'
    stack = sorted(p for p in stack_dir.iterdir() if p.is_dir() and (p / 'SKILL.md').is_file()) \
        if stack_dir.is_dir() else []
    legacy_names = {p.name[3:] for p in jp}
    for p in stack:
        if p.name.startswith('jp-') or p.name in legacy_names or p.is_symlink():
            raise ValueError(f'jpstack skill name collides with a jp skill: {p.name}')
    agent_dir = repo / 'jpstack' / 'agents'
    agents = sorted(p for p in agent_dir.iterdir() if p.suffix == '.md' and p.is_file()) \
        if agent_dir.is_dir() else []
    skill_links = {p.name: p.resolve(strict=True) for p in jp + stack}
    agent_links = {p.name: p.resolve(strict=True) for p in agents}
    return skills, legacy_names, skill_links, agent_links


def retired(entry: Path, repo: Path, skills: Path, legacy_names, expected) -> bool:
    """True when entry is a link this tool owns and no longer wants."""
    if not entry.is_symlink() or entry.name in expected:
        return False
    target = legacy_target(entry)
    if entry.name.startswith('jp-'):
        return target == skills / entry.name  # a jp skill removed from this checkout
    if target == skills / entry.name or (entry.name in legacy_names and target == repo / entry.name):
        return True
    if target.parent == repo / 'jpstack' / 'skills' or target.parent == repo / 'jpstack' / 'agents':
        return True  # a jpstack skill or agent removed from this checkout
    return is_pstack_link(entry)


def migrate(repo: Path, home: Path) -> None:
    repo = repo.resolve(strict=True)
    skills, legacy_names, skill_links, agent_links = sources(repo)
    plan = [(home / r, skill_links) for r in REGISTRIES]
    if agent_links:
        plan += [(home / r, agent_links) for r in AGENT_REGISTRIES]
    removals = []
    replaced = set()

    # Preflight every destination before changing anything. Never follow a registry link.
    for registry, expected in plan:
        if registry.is_symlink() or (registry.exists() and not registry.is_dir()):
            raise ValueError(f'registry is not a real directory: {registry}')
        if not registry.exists():
            continue
        for name, source in expected.items():
            dest = registry / name
            if dest.is_symlink():
                if link_target(dest) == source:
                    continue
                if is_pstack_link(dest):
                    removals.append((dest, os.readlink(dest)))
                    replaced.add(dest)
                    continue
                raise ValueError(f'foreign or incorrect destination: {dest} -> {os.readlink(dest)}')
            elif dest.exists():
                raise ValueError(f'destination is not a symlink: {dest}')
        for entry in registry.iterdir():
            if retired(entry, repo, skills, legacy_names, expected):
                removals.append((entry, os.readlink(entry)))

    for entry, target in removals:
        if not entry.is_symlink() or os.readlink(entry) != target:
            raise ValueError(f'retired link changed during migration: {entry}')
        entry.unlink()
        print(f'{"replaced" if entry in replaced else "removed"} retired link {entry} -> {target}')
    for registry, expected in plan:
        registry.mkdir(parents=True, exist_ok=True)
        for name, source in expected.items():
            dest = registry / name
            if not dest.is_symlink():
                os.symlink(source, dest)  # fails rather than overwriting a raced destination
                print(f'created {dest} -> {source}')

    for registry, expected in plan:
        for name, source in expected.items():
            dest = registry / name
            if not dest.is_symlink() or link_target(dest) != source:
                raise ValueError(f'link verification failed: {dest}')
        for entry in registry.iterdir():
            if retired(entry, repo, skills, legacy_names, expected):
                raise ValueError(f'retired link remains: {entry}')
    print(f'verified {len(skill_links)} skills in {len(REGISTRIES)} registries'
          + (f' and {len(agent_links)} agents in {len(AGENT_REGISTRIES)}' if agent_links else ''))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--repo', required=True, type=Path, help='jp-skills checkout')
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
