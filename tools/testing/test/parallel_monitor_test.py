import importlib.util
import os
import pathlib
import tempfile
import unittest

MODULE = pathlib.Path(__file__).resolve().parents[1] / 'parallel_monitor.py'
SPEC = importlib.util.spec_from_file_location('parallel_monitor', MODULE)
MONITOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MONITOR)


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='era-memory-test-')
        self.addCleanup(self.temp.cleanup)
        self.proc = pathlib.Path(self.temp.name)
        self.process(100, 1, '10', 2)
        self.memory()
        (self.proc / 'pressure').mkdir()
        self.pressure(10, 1)
        self.monitor = MONITOR.HostMonitor(100, '10', proc_root=self.proc, page_size=4096)

    def process(self, pid, parent, start, pages):
        target = self.proc / str(pid)
        target.mkdir(exist_ok=True)
        parts = ['0'] * 24
        parts[0] = 'S'
        parts[1] = str(parent)
        parts[19] = start
        parts[21] = str(pages)
        (target / 'stat').write_text(str(pid) + ' (owned fixture) ' + ' '.join(parts) + '\n')

    def memory(self, available=4194304, swap_free=1048576):
        (self.proc / 'meminfo').write_text('MemTotal: 8388608 kB\nMemAvailable: ' + str(available) + ' kB\nSwapTotal: 1048576 kB\nSwapFree: ' + str(swap_free) + ' kB\n')

    def pressure(self, some, full):
        (self.proc / 'pressure/memory').write_text('some avg10=0.10 avg60=0.20 avg300=0.30 total=' + str(some) + '\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=' + str(full) + '\n')

    def test_only_verified_root_and_descendants_contribute(self):
        self.process(200, 100, '11', 3)
        self.process(300, 200, '12', 5)
        self.process(400, 999, '13', 1000)
        sample = self.monitor.sample()
        self.assertTrue(sample['validRoot'])
        self.assertEqual(sample['treeRssBytes'], 10 * 4096)
        self.assertEqual(sample['processCount'], 3)
        self.assertTrue(self.monitor.summary()['measurementComplete'])

    def test_peak_headroom_swap_and_pressure_are_sampled_aggregates(self):
        self.process(200, 100, '11', 3)
        self.monitor.sample()
        self.process(200, 100, '11', 10)
        self.memory(3145728, 524288)
        self.pressure(100, 5)
        self.monitor.sample()
        result = self.monitor.summary()
        self.assertEqual(result['peakSampledTreeRssBytes'], 12 * 4096)
        self.assertEqual(result['minHostMemAvailableBytes'], 3 * 1024**3)
        self.assertEqual(result['maxHostSwapUsedBytes'], 512 * 1024**2)
        self.assertEqual(result['maxAdditionalHostSwapBytes'], 512 * 1024**2)
        self.assertEqual(result['memoryPressureSomeDeltaUs'], 90)
        self.assertEqual(result['memoryPressureFullDeltaUs'], 4)

    def test_root_pid_reuse_cannot_measure_another_session(self):
        self.monitor.sample()
        self.process(100, 1, '99', 999999)
        sample = self.monitor.sample()
        self.assertFalse(sample['validRoot'])
        self.assertIsNone(sample['treeRssBytes'])
        self.assertEqual(self.monitor.summary()['peakSampledTreeRssBytes'], 2 * 4096)
        self.assertFalse(self.monitor.summary()['measurementComplete'])

    def test_previously_owned_orphan_remains_counted_but_reused_pid_does_not(self):
        self.process(200, 100, '11', 3)
        self.monitor.sample()
        self.process(200, 1, '11', 4)
        self.assertEqual(self.monitor.sample()['treeRssBytes'], 6 * 4096)
        self.process(200, 999, '99', 1000)
        self.assertEqual(self.monitor.sample()['treeRssBytes'], 2 * 4096)

    def test_missing_host_observations_are_unknown_and_reported(self):
        (self.proc / 'meminfo').write_text('MemTotal: 8388608 kB\n')
        (self.proc / 'pressure/memory').unlink()
        sample = self.monitor.sample()
        self.assertIsNone(sample['memAvailableBytes'])
        self.assertIsNone(sample['swapUsedBytes'])
        self.assertIsNone(sample['memoryPressure'])
        summary = self.monitor.summary()
        self.assertFalse(summary['measurementComplete'])
        self.assertIsNone(summary['minHostMemAvailableBytes'])
        self.assertTrue(summary['errors'])

    def test_malformed_owned_process_record_cannot_silently_improve_a_result(self):
        self.process(200, 100, '11', 3)
        (self.proc / '200/stat').write_text('invalid\n')
        self.monitor.sample()
        self.assertFalse(self.monitor.summary()['measurementComplete'])


if __name__ == '__main__':
    unittest.main()
