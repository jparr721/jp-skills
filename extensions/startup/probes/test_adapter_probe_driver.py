import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class AdapterProbeDriverTest(unittest.TestCase):
    def test_rejected_workspace_replaces_stale_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory) / 'evidence.json.gz'
            with gzip.open(evidence, 'wt') as target:
                json.dump({'status': 'PASS'}, target)
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('run-adapter-probe.py')), '--scenario', 'input', '--workspace', directory, '--evidence', str(evidence)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            with gzip.open(evidence, 'rt') as source:
                actual = json.load(source)
            self.assertEqual(actual['status'], 'FAIL')
            self.assertIn('fresh explicitly owned fixture', actual['failure']['message'])


    def test_other_drivers_initialize_fail_before_rejected_workspace(self):
        for driver, extra in [('run-boot-probe.py', []), ('run-install-recovery-probe.py', []), ('run-native-probe.py', []), ('run-duties-probe.py', ['--scenario', 'raw'])]:
            with self.subTest(driver=driver), tempfile.TemporaryDirectory() as directory:
                evidence=Path(directory)/'evidence.json.gz'
                evidence.write_bytes(gzip.compress(b'{"status":"PASS"}'))
                result=subprocess.run([sys.executable,str(Path(__file__).with_name(driver)),*extra,'--workspace',directory,'--evidence',str(evidence)],capture_output=True,text=True)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(json.loads(gzip.decompress(evidence.read_bytes()))['status'],'FAIL')


if __name__ == '__main__':
    unittest.main()
