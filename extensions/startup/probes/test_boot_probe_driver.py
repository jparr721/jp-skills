import ast
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


class BootProbeDriverRegression(unittest.TestCase):
    def test_launch_argv_does_not_change_when_resume_is_added(self) -> None:
        path = Path(__file__).with_name('run-boot-probe.py')
        source = ast.parse(path.read_text(), filename=str(path))
        start = next(node for node in ast.walk(source) if isinstance(node, ast.FunctionDef) and node.name == 'start')
        module = ast.Module(body=[start], type_ignores=[])
        command = ['omp', '--profile', 'isolated', '--mode', 'rpc']
        first = command.copy()
        evidence = {'commands': []}
        def launch(argv, **kwargs):
            self.assertIs(argv, command)
            kwargs['stdout'].close()
            kwargs['stderr'].close()
            return None
        with tempfile.TemporaryDirectory() as directory:
            namespace = {'command': command, 'evidence': evidence, 'env': {}, 'cwd': directory, 'workspace': Path(directory), 'subprocess': SimpleNamespace(Popen=launch, PIPE=-1)}
            exec(compile(module, str(path), 'exec'), namespace)
            namespace['start']()
            command.extend(['--session', '/isolated/session.jsonl'])
            namespace['start']()
        self.assertEqual(evidence['commands'][0]['args'], first)
        self.assertEqual(evidence['commands'][1]['args'], command)
        self.assertIsNot(evidence['commands'][0]['args'], command)


if __name__ == '__main__':
    unittest.main()
