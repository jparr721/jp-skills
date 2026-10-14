import json
from pathlib import Path


def create_workspace(workspace: Path, repo: Path, kind: str) -> None:
    if workspace.exists() or workspace.is_relative_to(repo) or workspace == Path.home():
        raise ValueError('Probe requires a fresh explicitly owned fixture outside the repository')
    workspace.mkdir(parents=True, exist_ok=False)
    (workspace / '.startup-proof-owner.json').write_text(json.dumps({'repo': str(repo), 'kind': kind, 'version': 1}))


def resume_workspace(workspace: Path, repo: Path, kind: str) -> None:
    expected = {'repo': str(repo), 'kind': kind, 'version': 1}
    if workspace.is_relative_to(repo) or json.loads((workspace / '.startup-proof-owner.json').read_text()) != expected:
        raise ValueError('Resume requires the exact owned native fixture')
