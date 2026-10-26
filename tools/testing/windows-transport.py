#!/usr/bin/env python3
"""Per-job Windows QA transport; allocation and publication belong to callers."""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shlex
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('windows_owned_process', HERE / 'windows-process.py')
process = importlib.util.module_from_spec(spec)
spec.loader.exec_module(process)


class Refusal(RuntimeError):
    pass


def need(value, message):
    if not value:
        raise Refusal(message)


def digest(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


def private_file(file, *, create=False):
    file = pathlib.Path(file)
    need(file.is_absolute() and file.parent.resolve() == file.parent and not file.is_symlink(),
         'Private input path is aliased')
    if create and not file.exists():
        descriptor = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
    try:
        info = file.stat()
    except FileNotFoundError as error:
        raise Refusal('Private input file is missing') from error
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid() and not info.st_mode & 0o077,
         'Private input must be an owned private regular file')
    return file


def read_context(file):
    values = {}
    for line in private_file(file).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:]
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
        need(match is not None, 'Unsupported context assignment')
        key, raw = match.groups()
        need(key not in values, 'Duplicate context field')
        words = shlex.split(raw, comments=True)
        need(len(words) <= 1, 'Context value must be a quoted scalar')
        values[key] = words[0] if words else ''
    return values


def atomic_json(file, value):
    file = pathlib.Path(file)
    need(not file.is_symlink(), 'Aliased transport receipt refused')
    descriptor, temporary = tempfile.mkstemp(prefix='.' + file.name, dir=file.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, sort_keys=True)
            output.write('\n')
        os.replace(temporary, file)
    finally:
        pathlib.Path(temporary).unlink(missing_ok=True)


class Transport:
    @classmethod
    def from_environment(cls, env=None, *, runner=subprocess.run, cleanup=False):
        env = dict(os.environ if env is None else env)
        job_value = env.get('WINDOWS_JOB_DIR') or env.get('QA_JOB_DIR')
        need(job_value is not None and env.get('QA_CONTEXT_FILE'), 'Per-job directory and context are required')
        job = pathlib.Path(job_value)
        need(job.is_absolute() and job.resolve() == job and job.is_dir(), 'Per-job directory is missing or aliased')
        info = job.stat()
        need(info.st_uid == os.getuid() and not info.st_mode & 0o077, 'Per-job directory must be private and owned')
        file = pathlib.Path(env['QA_CONTEXT_FILE'])
        need(file.is_relative_to(job), 'Context must be inside its job')
        context = read_context(file)
        run_id = context.get('QA_RUN_ID', '')
        need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', run_id) is not None, 'Invalid run identity')
        need(not env.get('QA_RUN_ID') or env['QA_RUN_ID'] == run_id, 'Run identity differs from context')
        need(context.get('QA_JOB_DIR') == str(job), 'Context belongs to another job')
        authority_file = private_file(file.with_name('resource.json'))
        authority = json.loads(authority_file.read_text())
        need(authority.get('version') == 1 and authority.get('status') == 'ready', 'Resource authority is not ready')
        need(authority.get('runId') == run_id and authority.get('jobDir') == str(job) and
             authority.get('contextFile') == str(file), 'Resource authority belongs to another run')
        need(authority.get('contextSha256') == digest(file), 'Private context integrity mismatch')
        need(re.fullmatch(r'[0-9a-f]{64}', authority.get('token', '')) is not None and
             authority['token'] == context.get('QA_LEASE_TOKEN'), 'Resource lease token mismatch')
        need(str(authority.get('resourceId', '')) == context.get('VM_DROPLET_ID') and
             str(authority.get('resourceId', '')).isdigit(), 'Resource identity mismatch')
        owner_receipt = authority.get('owner', {})
        need(str(owner_receipt.get('pid', '')) == context.get('QA_OWNER_PID') and
             str(owner_receipt.get('startTicks', '')) == context.get('QA_OWNER_START_TICKS') and
             owner_receipt.get('uid') == os.getuid(), 'Resource owner identity mismatch')
        slot = context.get('QA_SLOT')
        lease_dir = context.get('QA_LEASE_DIR', '')
        need(slot in ('managed', 'legacy') and authority.get('slot') == slot, 'Resource slot mismatch')
        need(pathlib.Path(lease_dir).is_absolute() and authority.get('leaseDir') == lease_dir,
             'Canonical lease directory mismatch')
        for name in ['QA_SLOT', 'QA_VM_LOCK_FD', 'QA_LEASE_DIR']:
            need(name not in env or env[name] == context.get(name), 'Caller changed the frozen slot context')
        if slot == 'managed':
            need(authority.get('managedTag') == 'era-qa-managed' and authority.get('vmLock') is None and
                 authority.get('canonicalLease') is None and 'QA_VM_LOCK_FD' not in context,
                 'Managed slot cannot inherit a legacy lock or lease')
        else:
            lock, lease = authority.get('vmLock'), authority.get('canonicalLease')
            need(isinstance(lock, dict) and isinstance(lease, dict), 'Legacy lock and lease metadata are required')
            need(authority.get('managedTag') == 'era-qa-legacy-managed' and
                 lock.get('path') == '/tmp/era-vm-e2e.lock' and type(lock.get('fd')) is int and lock['fd'] >= 3 and
                 str(lock['fd']) == context.get('QA_VM_LOCK_FD'), 'Legacy lock identity mismatch')
            for metadata in [lock, lease]:
                need(all(isinstance(metadata.get(key), str) and metadata[key].isdigit() for key in ['device', 'inode']) and
                     int(metadata['inode']) > 0, 'Legacy resource inode metadata is invalid')
            holder = 'vm-e2e-' + context['QA_OWNER_PID']
            need(lease.get('directory') == lease_dir and lease.get('holder') == holder and
                 lease.get('path') == str(pathlib.Path(lease_dir) / str(authority['resourceId']) / holder),
                 'Legacy canonical lease belongs to another owner or resource')
        for name in ['VM_DROPLET', 'VM_SSH_KEY', 'VM_GUEST_USER', 'VM_GUEST_PASS', 'VM_GUEST_SSH_PORT',
                     'QA_OWNER_PID', 'QA_OWNER_START_TICKS']:
            need(context.get(name), 'Required private context field is missing')
        need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:-]*', context['VM_DROPLET']) is not None, 'Invalid host identity')
        need(re.fullmatch(r'[A-Za-z0-9_.-]+', context['VM_GUEST_USER']) is not None, 'Invalid guest account')
        owner = process.identity(int(context['QA_OWNER_PID']))
        # Cleanup may follow a dead wrapper, but a reused owner is never adopted.
        need(cleanup or owner is not None and owner['start'] == context['QA_OWNER_START_TICKS'],
             'Job owner is missing or its start identity changed')
        key = pathlib.Path(context['VM_SSH_KEY'])
        need(key.is_absolute() and key.is_file(), 'SSH identity file is missing')
        cdp = int(env.get('VM_CDP_PORT') or context.get('VM_CDP_PORT', '0'))
        feed = int(env.get('VM_FEED_PORT') or context.get('VM_FEED_PORT', '8427'))
        guest_port = int(context['VM_GUEST_SSH_PORT'])
        need(8500 <= cdp <= 8599, 'Local CDP port must be 8500-8599')
        need(context.get('VM_CDP_PORT') == str(cdp), 'Local CDP port differs from frozen context')
        need(0 < feed < 65536 and feed not in (9222, 9223), 'Invalid remote feed port')
        need(not context.get('VM_FEED_PORT') or context['VM_FEED_PORT'] == str(feed), 'Feed port differs from frozen context')
        need(0 < guest_port < 65536, 'Invalid guest SSH port')
        remote = '/root/era-qa-runs/' + run_id
        need(not context.get('QA_REMOTE_DIR') or context['QA_REMOTE_DIR'] == remote, 'Remote job path differs from its run')
        known = pathlib.Path(context.get('QA_KNOWN_HOSTS', str(job / 'private' / 'known_hosts')))
        need(known.is_relative_to(job) and known.parent.is_dir(), 'Known-hosts file must belong to this job')
        private_file(known, create=True)
        return cls(job, file, context, cdp, feed, known, env, runner)

    def __init__(self, job, context_file, context, cdp, feed_port, known_hosts, env, runner):
        self.job, self.context_file, self.context = job, context_file, context
        self.run_id, self.cdp_port, self.feed_port = context['QA_RUN_ID'], cdp, feed_port
        self.remote = '/root/era-qa-runs/' + self.run_id
        self.authority_file = context_file.with_name('resource.json')
        self.directory = process.secure_directory(job / 'transport')
        self.known_hosts, self.env, self.runner = known_hosts, env, runner
        self.host = 'root@' + context['VM_DROPLET']

    def ssh_options(self):
        return ['-F', '/dev/null', '-i', self.context['VM_SSH_KEY'], '-o', 'IdentitiesOnly=yes',
                '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
                '-o', 'UserKnownHostsFile=' + str(self.known_hosts), '-o', 'GlobalKnownHostsFile=/dev/null']

    def call(self, argv, *, payload=None, raw=None, allow_failure=False):
        result = self.runner(argv, input=json.dumps(payload) if payload is not None else raw,
            text=True, capture_output=True, timeout=45, env=process.child_environment({}))
        if result.returncode and not allow_failure:
            # Child output can include private transport diagnostics. It stays
            # private; exceptions and public receipts contain no argument dump.
            raise Refusal('Owned transport command failed (exit ' + str(result.returncode) + ')')
        return result

    def remote_call(self, argv, **kwargs):
        return self.call(['ssh', *self.ssh_options(), self.host, shlex.join(argv)], **kwargs)

    def copy(self, source, destination):
        return self.call(['scp', *self.ssh_options(), '--', str(source), self.host + ':' + destination])

    def manager(self, operation, name, *, payload=None, remote=True, allow_failure=False):
        if remote:
            return self.remote_call(['python3', '-B', self.remote + '/windows-process.py', operation,
                                     self.remote + '/' + name + '.json'], payload=payload, allow_failure=allow_failure)
        return self.call([sys.executable, '-B', str(HERE / 'windows-process.py'), operation,
                          str(self.directory / (name + '.json'))], payload=payload, allow_failure=allow_failure)

    def require_bootstrap(self):
        receipt = private_file(self.directory / 'bootstrap.json')
        value = json.loads(receipt.read_text())
        need(value == {'runId': self.run_id, 'contextSha256': digest(self.context_file),
                       'authoritySha256': digest(self.authority_file), 'remote': self.remote},
             'Context changed after transport bootstrap')

    def bootstrap(self):
        receipt = self.directory / 'bootstrap.json'
        if receipt.exists():
            self.require_bootstrap()
            return {'ok': True, 'operation': 'bootstrap', 'runId': self.run_id}
        self.remote_call(['mkdir', '-p', '--', self.remote])
        self.remote_call(['chmod', '700', '--', self.remote])
        self.copy(HERE / 'windows-process.py', self.remote + '/windows-process.py')
        askpass = self.directory / 'askpass.sh'
        need(not askpass.is_symlink(), 'Aliased askpass helper refused')
        askpass.write_text('#!/bin/sh\nexec cat -- "$(dirname -- "$0")/guest.pass"\n')
        askpass.chmod(0o700)
        self.copy(askpass, self.remote + '/askpass.sh')
        writer = ('import os,pathlib,stat,sys\np=pathlib.Path(sys.argv[1]); data=sys.stdin.buffer.read()\n'
                  'if p.exists() or p.is_symlink():\n'
                  ' s=p.lstat(); assert stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and not s.st_mode&0o077\n'
                  ' assert p.read_bytes()==data\n'
                  'else:\n'
                  ' fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n'
                  ' with os.fdopen(fd,"wb") as out: out.write(data)\n')
        self.remote_call(['python3', '-B', '-c', writer, self.remote + '/guest.pass'], raw=self.context['VM_GUEST_PASS'])
        self.remote_call(['chmod', '700', '--', self.remote + '/askpass.sh'])
        response = self.remote_call(['python3', '-B', self.remote + '/windows-process.py', 'capabilities'])
        capability = json.loads(response.stdout)
        need(capability.get('pidfd') is True and capability.get('directChildOwnership') is True,
             'Remote process ownership safeguards are unavailable')
        atomic_json(receipt, {'runId': self.run_id, 'contextSha256': digest(self.context_file),
                             'authoritySha256': digest(self.authority_file), 'remote': self.remote})
        return {'ok': True, 'operation': 'bootstrap', 'runId': self.run_id}

    def feed(self):
        self.require_bootstrap()
        source = pathlib.Path(self.env.get('VM_FEED_SOURCE') or self.context.get('VM_FEED_SOURCE', ''))
        need(not self.context.get('VM_FEED_SOURCE') or str(source) == self.context['VM_FEED_SOURCE'],
             'Feed source differs from frozen context')
        need(source.is_absolute() and source.is_file() and not source.is_symlink(), 'Feed source must be an explicit regular file')
        need(self.env.get('VM_FEED_DIR', '/root/qa/feed') == '/root/qa/feed', 'Feed data must use the dedicated host fixture directory')
        self.copy(source, self.remote + '/feed.py')
        self.manager('start', 'feed', payload={'argv': ['python3', '-B', self.remote + '/feed.py',
            '/root/qa/feed', str(self.feed_port)], 'port': self.feed_port})
        return {'ok': True, 'operation': 'feed', 'runId': self.run_id}

    def local(self):
        self.require_bootstrap()
        argv = ['ssh', *self.ssh_options(), '-N', '-L',
                '127.0.0.1:' + str(self.cdp_port) + ':127.0.0.1:9223',
                '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', self.host]
        self.manager('start', 'tunnel', payload={'argv': argv, 'port': self.cdp_port}, remote=False)
        return {'ok': True, 'operation': 'local', 'runId': self.run_id, 'port': self.cdp_port}

    def cdp(self):
        self.require_bootstrap()
        argv = ['ssh', '-F', '/dev/null', '-p', self.context['VM_GUEST_SSH_PORT'],
                '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + self.remote + '/guest-known_hosts',
                '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ExitOnForwardFailure=yes',
                '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
                '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no',
                '-L', '127.0.0.1:9223:127.0.0.1:9222', self.context['VM_GUEST_USER'] + '@127.0.0.1',
                'ping -n 86400 127.0.0.1 >nul']
        self.manager('start', 'guest-forward', payload={'argv': argv, 'port': 9223,
            'env': {'SSH_ASKPASS': self.remote + '/askpass.sh', 'SSH_ASKPASS_REQUIRE': 'force', 'DISPLAY': ':0'}})
        result = self.remote_call(['curl', '-sf', '-m', '5', 'http://127.0.0.1:9223/json/version'], allow_failure=True)
        if result.returncode:
            self.manager('stop', 'guest-forward')
            raise Refusal('Owned guest forward is not ready')
        return {'ok': True, 'operation': 'cdp', 'runId': self.run_id}

    def cleanup(self):
        errors = []
        operations = [(False, 'tunnel')]
        try:
            self.require_bootstrap()
            operations.extend([(True, 'guest-forward'), (True, 'feed')])
        except (Refusal, OSError, ValueError):
            if (self.directory / 'bootstrap.json').exists():
                errors.append('context')
        for remote, name in operations:
            try:
                self.manager('stop', name, remote=remote)
            except (Refusal, OSError, subprocess.SubprocessError):
                errors.append(name)
        need(not errors, 'Some owned transport cleanup was refused')
        return {'ok': True, 'operation': 'cleanup', 'runId': self.run_id}


def main():
    need(len(sys.argv) == 2 and sys.argv[1] in ['bootstrap', 'feed', 'local', 'cdp', 'cleanup'], 'Unknown transport operation')
    client = Transport.from_environment(cleanup=sys.argv[1] == 'cleanup')
    result = getattr(client, sys.argv[1])()
    if sys.argv[1] == 'cdp':
        print('cdp forwarded')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (Refusal, process.Refusal, OSError, ValueError, KeyError, subprocess.SubprocessError):
        print('REFUSED: per-job Windows transport operation failed', file=sys.stderr)
        sys.exit(1)
