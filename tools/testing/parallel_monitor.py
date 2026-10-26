"""Read-only host observations for one verified worker and its descendants.

RSS is sampled and shared pages may count once per process. These observations
are neither an enforced memory cap nor an exact high-water mark between samples.
"""
import math
import os
import pathlib
import re
import time


class HostMonitor:
    def __init__(self, root_pid, root_start_ticks, proc_root='/proc', page_size=None):
        if not isinstance(root_pid, int) or root_pid < 1 or not re.fullmatch(r'\d+', str(root_start_ticks)):
            raise ValueError('An exact host worker PID and start time are required')
        self.root_pid = root_pid
        self.root_start = str(root_start_ticks)
        self.proc = pathlib.Path(proc_root)
        self.page_size = page_size or os.sysconf('SC_PAGE_SIZE')
        if not isinstance(self.page_size, int) or self.page_size <= 0:
            raise ValueError('A valid host page size is required')
        self.uid = os.getuid()
        self.known = {root_pid: self.root_start}
        self.samples = []
        self.errors = set()

    def _process(self, pid):
        directory = self.proc / str(pid)
        try:
            if directory.stat().st_uid != self.uid:
                return None
            text = (directory / 'stat').read_text()
        except (FileNotFoundError, ProcessLookupError):
            return None
        closing = text.rfind(')')
        if closing < 0 or text.split(' ', 1)[0] != str(pid):
            raise ValueError('Malformed owned process identity')
        fields = text[closing + 2:].split()
        if len(fields) < 22 or not re.fullmatch(r'\d+', fields[19]):
            raise ValueError('Malformed owned process counters')
        parent, pages = int(fields[1]), int(fields[21])
        if parent < 0 or pages < 0:
            raise ValueError('Invalid owned process counters')
        return {'pid': pid, 'parent': parent, 'start': fields[19], 'state': fields[0], 'rss': pages * self.page_size}

    def _root_matches(self):
        record = self._process(self.root_pid)
        return bool(record and record['start'] == self.root_start and record['state'] not in ['Z', 'X', 'x'])

    def _memory(self):
        text = (self.proc / 'meminfo').read_text()
        values = {}
        for name in ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']:
            matches = re.findall(r'^' + name + r':\s+(\d+) kB\s*$', text, re.MULTILINE)
            if len(matches) != 1:
                raise ValueError('Host memory or swap observation is missing or ambiguous')
            values[name] = int(matches[0]) * 1024
        if values['MemAvailable'] > values['MemTotal'] or values['SwapFree'] > values['SwapTotal']:
            raise ValueError('Host memory or swap counters are inconsistent')
        return values['MemAvailable'], values['SwapTotal'] - values['SwapFree']

    def _pressure(self):
        result = {}
        for line in (self.proc / 'pressure/memory').read_text().splitlines():
            fields = line.split()
            if not fields or fields[0] not in ['some', 'full']:
                continue
            if fields[0] in result:
                raise ValueError('Ambiguous host memory pressure')
            values = dict(part.split('=', 1) for part in fields[1:])
            row = {name: float(values[name]) for name in ['avg10', 'avg60', 'avg300']}
            row['total'] = int(values['total'])
            if any(not math.isfinite(value) or value < 0 for value in row.values()):
                raise ValueError('Invalid host memory pressure counter')
            result[fields[0]] = row
        if set(result) != {'some', 'full'}:
            raise ValueError('Host memory pressure observation is incomplete')
        return result

    def sample(self):
        sample = {'atMonotonic': time.monotonic(), 'validRoot': False, 'treeRssBytes': None,
                  'processCount': None, 'memAvailableBytes': None, 'swapUsedBytes': None,
                  'memoryPressure': None, 'errors': []}
        try:
            if not self._root_matches():
                raise ValueError('Host worker identity no longer matches')
            records = {}
            for entry in self.proc.iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    record = self._process(int(entry.name))
                    if record:
                        records[record['pid']] = record
                except (OSError, ValueError):
                    sample['errors'].append('An owned process could not be measured')
            selected = {pid for pid, record in records.items() if self.known.get(pid) == record['start']}
            changed = True
            while changed:
                changed = False
                for pid, record in records.items():
                    parent = records.get(record['parent'])
                    if pid not in selected and parent and parent['pid'] in selected and int(record['start']) >= int(parent['start']):
                        selected.add(pid)
                        changed = True
            if not self._root_matches():
                raise ValueError('Host worker identity changed while measuring')
            for pid in selected:
                self.known[pid] = records[pid]['start']
            sample.update(validRoot=True, treeRssBytes=sum(records[pid]['rss'] for pid in selected), processCount=len(selected))
        except (OSError, ValueError) as error:
            sample['errors'].append(str(error))
        try:
            sample['memAvailableBytes'], sample['swapUsedBytes'] = self._memory()
        except (OSError, ValueError) as error:
            sample['errors'].append(str(error))
        try:
            sample['memoryPressure'] = self._pressure()
        except (OSError, ValueError, KeyError) as error:
            sample['errors'].append(str(error))
        self.errors.update(sample['errors'])
        self.samples.append(sample)
        return sample

    def summary(self):
        rss = [sample['treeRssBytes'] for sample in self.samples if sample['treeRssBytes'] is not None]
        available = [sample['memAvailableBytes'] for sample in self.samples if sample['memAvailableBytes'] is not None]
        swap = [sample['swapUsedBytes'] for sample in self.samples if sample['swapUsedBytes'] is not None]
        pressures = [sample['memoryPressure'] for sample in self.samples if sample['memoryPressure'] is not None]
        def pressure_delta(kind):
            if not pressures:
                return None
            values = [row[kind]['total'] for row in pressures]
            if any(later < earlier for earlier, later in zip(values, values[1:])):
                self.errors.add('Host memory pressure counter moved backwards')
            return max(values) - values[0]
        some_delta, full_delta = pressure_delta('some'), pressure_delta('full')
        return {
            'sampleCount': len(self.samples),
            'validRootSamples': sum(sample['validRoot'] for sample in self.samples),
            'measurementComplete': bool(self.samples) and not self.errors,
            'peakSampledTreeRssBytes': max(rss) if rss else None,
            'peakObservedProcesses': max((sample['processCount'] or 0 for sample in self.samples), default=0),
            'minHostMemAvailableBytes': min(available) if available else None,
            'maxHostSwapUsedBytes': max(swap) if swap else None,
            'maxAdditionalHostSwapBytes': max(swap) - swap[0] if swap else None,
            'memoryPressureSomeDeltaUs': some_delta,
            'memoryPressureFullDeltaUs': full_delta,
            'maxMemoryPressureSomeAvg10': max(row['some']['avg10'] for row in pressures) if pressures else None,
            'maxMemoryPressureFullAvg10': max(row['full']['avg10'] for row in pressures) if pressures else None,
            'elapsedObservationSeconds': round(self.samples[-1]['atMonotonic'] - self.samples[0]['atMonotonic'], 3) if self.samples else 0,
            'errors': sorted(self.errors)[:16],
            'scope': 'Sampled root and verified descendants, including previously observed orphans; RSS may count shared pages per process',
            'memoryBudgetEnforced': False,
        }
