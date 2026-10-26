#!/usr/bin/env python3
"""Capture direct children and stop only their verified individual PID handles."""
import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile
import time

_children = {}


class Refusal(RuntimeError):
    pass


def need(value, message):
    if not value:
        raise Refusal(message)


def identity(pid):
    if type(pid) is not int or pid <= 1:
        return None
    try:
        root = pathlib.Path('/proc') / str(pid)
        before = (root / 'stat').read_text()
        fields = before[before.rfind(')') + 2:].split()
        command = (root / 'cmdline').read_bytes()
        after = (root / 'stat').read_text()
        other = after[after.rfind(')') + 2:].split()
        if fields[0] == 'Z' or other[0] == 'Z':
            return None
        need(fields[19] == other[19] and fields[1] == other[1], 'Process changed during capture')
        return {'pid': pid, 'start': fields[19], 'cmd': hashlib.sha256(command).hexdigest()}
    except (FileNotFoundError, ProcessLookupError):
        return None


def parent_pid(pid):
    stat = (pathlib.Path('/proc') / str(pid) / 'stat').read_text()
    return int(stat[stat.rfind(')') + 2:].split()[1])


def capture_child(pid, launcher=None, *, identify=identity, parent_of=parent_pid):
    launcher = os.getpid() if launcher is None else launcher
    owner = identify(launcher)
    child = identify(pid)
    need(owner is not None and child is not None and pid != launcher, 'Owned child disappeared')
    need(parent_of(pid) == launcher, 'Process is not a direct child of its launcher')
    need(identify(launcher) == owner and identify(pid) == child and parent_of(pid) == launcher,
         'Parent or child changed during capture')
    return {'version': 1, 'identity': child, 'launcher': owner}


def validate_owner(record, *, identify=identity, parent_of=parent_pid):
    need(record.get('version') == 1, 'Unknown process receipt version')
    child, launcher = record['identity'], record['launcher']
    for item in (child, launcher):
        need(type(item.get('pid')) is int and item['pid'] > 1, 'Unsafe PID in process receipt')
        need(isinstance(item.get('start'), str) and item['start'].isdigit(), 'Invalid process start identity')
        need(isinstance(item.get('cmd'), str) and len(item['cmd']) == 64 and
             all(c in '0123456789abcdef' for c in item['cmd']), 'Invalid process command identity')
    actual = identify(child['pid'])
    if actual is None:
        return False
    need(actual == child, 'PID identity mismatch; refusing signal')
    parent = parent_of(child['pid'])
    if parent == launcher['pid']:
        need(identify(parent) == launcher, 'Launcher identity mismatch; refusing signal')
    else:
        # A short-lived start command exits after recording its direct child.
        # Only init may adopt that unchanged child; another parent is not ours.
        need(parent == 1 and identify(launcher['pid']) != launcher,
             'Process parent is outside the captured ownership relationship')
    return True


def signal_owned(record, sig, *, identify=identity, parent_of=parent_pid,
                 opener=None, sender=None, closer=os.close):
    if not validate_owner(record, identify=identify, parent_of=parent_of):
        return False
    opener = opener or getattr(os, 'pidfd_open', None)
    sender = sender or getattr(signal, 'pidfd_send_signal', None)
    need(opener is not None and sender is not None, 'PID-safe signaling is unavailable')
    try:
        descriptor = opener(record['identity']['pid'])
    except ProcessLookupError:
        return False
    try:
        if not validate_owner(record, identify=identify, parent_of=parent_of):
            return False
        sender(descriptor, sig)
        return True
    finally:
        closer(descriptor)


def secure_directory(directory):
    directory = pathlib.Path(directory)
    need(directory.is_absolute() and directory.resolve() == directory, 'Process directory is aliased')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.stat()
    need(info.st_uid == os.getuid() and not info.st_mode & 0o077, 'Process directory must be private and owned')
    return directory


def read_record(file):
    file = pathlib.Path(file)
    need(not file.is_symlink(), 'Aliased process receipt refused')
    if not file.exists():
        return None
    info = file.stat()
    need(file.is_file() and info.st_uid == os.getuid() and not info.st_mode & 0o077,
         'Process receipt must be a private owned file')
    return json.loads(file.read_text())


def write_record(file, value):
    file = pathlib.Path(file)
    need(not file.is_symlink(), 'Aliased process receipt refused')
    descriptor, temporary = tempfile.mkstemp(prefix='.' + file.name + '-', dir=file.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, sort_keys=True)
            output.write('\n')
        os.replace(temporary, file)
    finally:
        pathlib.Path(temporary).unlink(missing_ok=True)


@contextlib.contextmanager
def record_lock(file):
    file = pathlib.Path(file)
    secure_directory(file.parent)
    need(not file.is_symlink(), 'Aliased process receipt refused')
    lock = pathlib.Path(str(file) + '.lock')
    descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        need(info.st_uid == os.getuid() and not info.st_mode & 0o077, 'Unowned process lock refused')
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def listener_owned(pid, port):
    own = set()
    try:
        for entry in (pathlib.Path('/proc') / str(pid) / 'fd').iterdir():
            try:
                target = os.readlink(entry)
                if target.startswith('socket:['):
                    own.add(target[8:-1])
            except (FileNotFoundError, ProcessLookupError):
                pass
        listening = set()
        for family in ['tcp', 'tcp6']:
            for row in (pathlib.Path('/proc/self/net') / family).read_text().splitlines()[1:]:
                fields = row.split()
                if fields[3] == '0A' and int(fields[1].rsplit(':', 1)[1], 16) == port:
                    listening.add(fields[9])
        return bool(listening) and listening <= own
    except (FileNotFoundError, ProcessLookupError):
        return False


def child_environment(extra):
    result = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(pathlib.Path.home()),
              'PYTHONDONTWRITEBYTECODE': '1'}
    need(isinstance(extra, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in extra.items()),
         'Invalid child environment')
    result.update(extra)
    result['PYTHONDONTWRITEBYTECODE'] = '1'
    return result


def capabilities():
    need(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'PID-safe signaling unavailable')
    descriptor = os.pidfd_open(os.getpid())
    os.close(descriptor)
    return {'pidfd': True, 'directChildOwnership': True}


def start(file, spec):
    file = pathlib.Path(file)
    argv = spec.get('argv')
    need(isinstance(argv, list) and argv and all(isinstance(v, str) and '\0' not in v for v in argv), 'Invalid command')
    fingerprint = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    port = spec.get('port')
    need(port is None or type(port) is int and 0 < port < 65536, 'Invalid listener port')
    capabilities()
    with record_lock(file):
        previous = read_record(file)
        if previous and identity(previous['identity']['pid']) is not None:
            need(previous.get('specHash') == fingerprint, 'Existing command specification differs')
            validate_owner(previous)
            need(port is None or listener_owned(previous['identity']['pid'], port), 'Owned transport has no owned listener')
            return previous
        if port:
            with socket.socket() as probe:
                try:
                    probe.bind(('127.0.0.1', port))
                except OSError as error:
                    raise Refusal('Transport port is occupied or unavailable') from error
        log_path = pathlib.Path(str(file) + '.log')
        descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        child = None
        saved = None
        try:
            with os.fdopen(descriptor, 'ab', buffering=0) as output:
                child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                         env=child_environment(spec.get('env', {})), start_new_session=True)
            saved = capture_child(child.pid)
            saved['specHash'] = fingerprint
            write_record(file, saved)
            deadline = time.monotonic() + spec.get('readyTimeout', 15)
            while True:
                need(child.poll() is None and validate_owner(saved), 'Owned transport exited before readiness')
                if port is None or listener_owned(child.pid, port):
                    _children[child.pid] = child
                    return saved
                need(time.monotonic() < deadline, 'Owned transport listener did not become ready')
                time.sleep(0.05)
        except Exception:
            if saved is not None:
                signal_owned(saved, signal.SIGTERM)
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    signal_owned(saved, signal.SIGKILL)
                    child.wait(timeout=1)
            raise


def stop(file, timeout=3):
    file = pathlib.Path(file)
    with record_lock(file):
        saved = read_record(file)
        if saved is None:
            return {'stopped': False}
        stopped = signal_owned(saved, signal.SIGTERM)
        if stopped:
            def exited():
                actual = identity(saved['identity']['pid'])
                if actual is None or actual['start'] != saved['identity']['start']:
                    return True
                # The kernel can clear cmdline before it exposes the zombie.
                # Polling does not authorize a signal; escalation below checks
                # the complete captured identity again through its PID handle.
                return False
            def wait_exit():
                deadline = time.monotonic() + timeout
                while not exited() and time.monotonic() < deadline:
                    time.sleep(0.02)
                return exited()
            if not wait_exit():
                signal_owned(saved, signal.SIGKILL)
            need(wait_exit(), 'Owned child has not exited; process receipt retained')
            try:
                child = _children.pop(saved['identity']['pid'], None)
                if child is not None:
                    child.wait(timeout=1)
                else:
                    os.waitpid(saved['identity']['pid'], 0)
            except ChildProcessError:
                pass
        file.unlink(missing_ok=True)
        return {'stopped': stopped}


def main():
    operation = sys.argv[1]
    if operation == 'capabilities':
        print(json.dumps(capabilities()))
        return
    need(len(sys.argv) == 3, 'Expected operation and private process receipt')
    file = pathlib.Path(sys.argv[2])
    if operation == 'start':
        result = start(file, json.load(sys.stdin))
    elif operation == 'stop':
        result = stop(file)
    else:
        raise Refusal('Unknown process operation')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (Refusal, OSError, ValueError, KeyError, IndexError):
        print('REFUSED: owned Windows transport process operation failed', file=sys.stderr)
        sys.exit(1)
