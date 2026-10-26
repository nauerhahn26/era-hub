"""Owned fixtures only: these checks never invoke SSH or a QA provider."""
import hashlib
import importlib.util
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


process = module("windows_process", "windows-process.py")
transport = module("windows_transport", "windows-transport.py")


def ident(pid, start="10", command="a"):
    return {"pid": pid, "start": start, "cmd": command * 64}


class ProcessTests(unittest.TestCase):
    def record(self):
        return {"version": 1, "identity": ident(321),
                "launcher": ident(320), "specHash": "d" * 64}

    def test_capture_refuses_a_process_outside_its_direct_parent(self):
        records = {320: ident(320), 321: ident(321)}
        with self.assertRaises(process.Refusal):
            process.capture_child(321, 320, identify=records.get, parent_of=lambda _: 999)

    def test_capture_refuses_parent_reuse_during_enrollment(self):
        calls = 0
        def identify(pid):
            nonlocal calls
            if pid == 320:
                calls += 1
                return ident(pid, "10" if calls == 1 else "11")
            return ident(pid)
        with self.assertRaises(process.Refusal):
            process.capture_child(321, 320, identify=identify, parent_of=lambda _: 320)

    def test_pidfd_signal_only_after_identity_and_parent_checks(self):
        events = []
        records = {320: ident(320), 321: ident(321)}
        result = process.signal_owned(self.record(), signal.SIGTERM,
            identify=records.get, parent_of=lambda _: 320,
            opener=lambda pid: events.append(("open", pid)) or 41,
            sender=lambda fd, sig: events.append(("send", fd, sig)),
            closer=lambda fd: events.append(("close", fd)))
        self.assertTrue(result)
        self.assertEqual(events, [("open", 321), ("send", 41, signal.SIGTERM), ("close", 41)])

    def test_reused_pid_or_changed_command_never_signaled(self):
        for current in [ident(321, "11"), ident(321, command="b")]:
            events = []
            with self.assertRaises(process.Refusal):
                process.signal_owned(self.record(), signal.SIGTERM,
                    identify=lambda pid: current if pid == 321 else ident(320),
                    parent_of=lambda _: 320, opener=lambda _: 41,
                    sender=lambda *args: events.append(args), closer=lambda _: None)
            self.assertEqual(events, [])

    def test_identity_change_after_pidfd_open_refuses_signal(self):
        events = []
        changed = False
        def opener(_):
            nonlocal changed
            changed = True
            return 41
        def identify(pid):
            return ident(pid, "11" if changed and pid == 321 else "10")
        with self.assertRaises(process.Refusal):
            process.signal_owned(self.record(), signal.SIGTERM, identify=identify,
                parent_of=lambda _: 320, opener=opener,
                sender=lambda *args: events.append(args), closer=lambda _: None)
        self.assertEqual(events, [])

    def test_unrelated_current_parent_refused(self):
        with self.assertRaises(process.Refusal):
            process.signal_owned(self.record(), signal.SIGTERM,
                identify=lambda pid: ident(pid), parent_of=lambda _: 999,
                opener=lambda _: self.fail("Must refuse before opening a signal handle"))

    def test_gone_launcher_allows_only_reparenting_to_init(self):
        events = []
        process.signal_owned(self.record(), signal.SIGTERM,
            identify=lambda pid: ident(321) if pid == 321 else None,
            parent_of=lambda _: 1, opener=lambda _: 41,
            sender=lambda *args: events.append(args), closer=lambda _: None)
        self.assertEqual(events, [(41, signal.SIGTERM)])

    def test_unsafe_pid_refused(self):
        for pid in [0, -1, 1, True, "321"]:
            record = self.record(); record["identity"]["pid"] = pid
            with self.assertRaises(process.Refusal):
                process.signal_owned(record, signal.SIGTERM,
                    opener=lambda _: self.fail("Unsafe PID opened"))

    def test_real_owned_stand_in_survives_wrong_record_then_stops_by_pidfd(self):
        with tempfile.TemporaryDirectory() as directory:
            record = pathlib.Path(directory) / "process.json"
            spec = {"argv": [sys.executable, "-c", "import time; time.sleep(60)"]}
            saved = process.start(record, spec)
            try:
                wrong = json.loads(json.dumps(saved)); wrong["identity"]["start"] = "0"
                with self.assertRaises(process.Refusal):
                    process.signal_owned(wrong, signal.SIGTERM)
                self.assertIsNotNone(process.identity(saved["identity"]["pid"]))
                self.assertTrue(process.stop(record, timeout=1)["stopped"])
                self.assertIsNone(process.identity(saved["identity"]["pid"]))
            finally:
                if record.exists():
                    process.stop(record, timeout=1)

    def test_record_symlink_never_overwritten_or_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "foreign.json"; target.write_text("preserve")
            record = pathlib.Path(directory) / "process.json"; record.symlink_to(target)
            with self.assertRaises(process.Refusal):
                process.start(record, {"argv": [sys.executable, "-c", "raise SystemExit(0)"]})
            self.assertEqual(target.read_text(), "preserve")

    def test_listener_is_owned_by_the_captured_child(self):
        with tempfile.TemporaryDirectory() as directory:
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0)); port = reservation.getsockname()[1]
            record = pathlib.Path(directory) / 'listener.json'
            code = ('import socket,time; s=socket.socket(); '
                    's.bind(("127.0.0.1",' + str(port) + ')); s.listen(); time.sleep(60)')
            saved = process.start(record, {'argv': [sys.executable, '-c', code], 'port': port})
            try:
                self.assertTrue(process.listener_owned(saved['identity']['pid'], port))
            finally:
                process.stop(record, timeout=1)

    def test_occupied_listener_is_left_running_and_cannot_be_borrowed(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as foreign:
            foreign.bind(('127.0.0.1', 0)); foreign.listen(); port = foreign.getsockname()[1]
            record = pathlib.Path(directory) / 'listener.json'
            with self.assertRaises(process.Refusal):
                process.start(record, {'argv': [sys.executable, '-c', 'import time; time.sleep(60)'], 'port': port})
            self.assertEqual(foreign.getsockname()[1], port)
            saved = process.start(record, {'argv': [sys.executable, '-c', 'import time; time.sleep(60)']})
            try:
                self.assertFalse(process.listener_owned(saved['identity']['pid'], port))
            finally:
                process.stop(record, timeout=1)

    def test_cli_child_is_still_owned_after_its_short_lived_launcher_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'process.json'
            args = [sys.executable, '-B', str(ROOT / 'windows-process.py')]
            started = subprocess.run([*args, 'start', str(file)], input=json.dumps({
                'argv': [sys.executable, '-c', 'import time; time.sleep(60)']}),
                text=True, capture_output=True, timeout=5)
            self.assertEqual(started.returncode, 0, started.stderr)
            stopped = subprocess.run([*args, 'stop', str(file)], text=True, capture_output=True, timeout=5)
            self.assertEqual(stopped.returncode, 0, stopped.stderr)
            self.assertTrue(json.loads(stopped.stdout)['stopped'])

    def test_stop_keeps_receipt_and_fails_if_verified_child_has_not_exited(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'process.json'
            process.write_record(file, self.record())
            with patch.object(process, 'identity', return_value=ident(321)), \
                    patch.object(process, 'signal_owned', return_value=True), \
                    patch.object(process.os, 'waitpid', side_effect=ChildProcessError):
                with self.assertRaises(process.Refusal): process.stop(file, timeout=0)
            self.assertTrue(file.exists(), 'Unfinished cleanup must retain its owned process receipt')


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.job = pathlib.Path(self.temp.name) / "job-one"; self.job.mkdir(mode=0o700)
        self.private = self.job / "private"; self.private.mkdir(mode=0o700)
        self.context = self.private / "vm.env"
        self.key = self.private / "key"; self.key.write_text("fixture-key"); self.key.chmod(0o600)
        self.secret = "fixture pass; $(never-execute)"
        self.values = {"QA_RUN_ID": "fixture-one", "QA_JOB_DIR": str(self.job),
            "QA_OWNER_PID": str(os.getpid()), "QA_OWNER_START_TICKS": process.identity(os.getpid())["start"],
            "QA_KNOWN_HOSTS": str(self.private / "known_hosts"),
            "QA_REMOTE_DIR": "/root/era-qa-runs/fixture-one", "VM_DROPLET": "qa.example.invalid",
            "VM_SSH_KEY": str(self.key), "VM_GUEST_USER": "qa", "VM_GUEST_PASS": self.secret,
            "VM_GUEST_SSH_PORT": "2222", "VM_CDP_PORT": "8511", "VM_FEED_PORT": "8427",
            "QA_LEASE_TOKEN": "e" * 64, "VM_DROPLET_ID": "4242", "QA_SLOT": "managed",
            "QA_LEASE_DIR": str(self.job / 'leases')}
        self.write_context()
        self.calls = []
        self.feed = self.job / "feed.py"; self.feed.write_text("# synthetic feed\n")
        self.env = {"WINDOWS_JOB_DIR": str(self.job), "QA_CONTEXT_FILE": str(self.context),
            "VM_CDP_PORT": "8511", "VM_FEED_PORT": "8427", "VM_FEED_SOURCE": str(self.feed)}

    def write_context(self):
        import shlex
        self.context.write_text("".join(key + "=" + shlex.quote(value) + "\n" for key, value in self.values.items()))
        self.context.chmod(0o600)
        self.authority = self.private / 'resource.json'
        authority = {'version': 1, 'runId': self.values['QA_RUN_ID'],
            'jobDir': str(self.job), 'contextFile': str(self.context), 'status': 'ready',
            'owner': {'pid': int(self.values['QA_OWNER_PID']), 'startTicks': self.values['QA_OWNER_START_TICKS'], 'uid': os.getuid()},
            'token': self.values['QA_LEASE_TOKEN'], 'resourceId': self.values['VM_DROPLET_ID'],
            'contextSha256': hashlib.sha256(self.context.read_bytes()).hexdigest(),
            'slot': self.values['QA_SLOT'], 'leaseDir': self.values['QA_LEASE_DIR'],
            'managedTag': 'era-qa-managed', 'vmLock': None, 'canonicalLease': None}
        if self.values['QA_SLOT'] == 'legacy':
            holder = 'vm-e2e-' + self.values['QA_OWNER_PID']
            authority.update(managedTag='era-qa-legacy-managed',
                vmLock={'path': '/tmp/era-vm-e2e.lock', 'fd': int(self.values.get('QA_VM_LOCK_FD', '6')),
                    'device': '1', 'inode': '2'},
                canonicalLease={'directory': self.values['QA_LEASE_DIR'], 'holder': holder,
                    'path': str(pathlib.Path(self.values['QA_LEASE_DIR']) / self.values['VM_DROPLET_ID'] / holder),
                    'device': '1', 'inode': '3'})
        self.authority.write_text(json.dumps(authority))
        self.authority.chmod(0o600)

    def fake(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        output = '{"pidfd":true,"directChildOwnership":true}' if argv[-1].endswith(' capabilities') else '{}'
        return subprocess.CompletedProcess(argv, 0, output + "\n", "")

    def client(self, **kwargs):
        return transport.Transport.from_environment(self.env, runner=kwargs.get("runner", self.fake))

    def test_context_is_parsed_without_shell_expansion(self):
        client = self.client()
        self.assertEqual(client.context["VM_GUEST_PASS"], self.secret)
        self.assertEqual(client.run_id, "fixture-one")

    def test_context_alias_public_mode_and_changed_owner_refused(self):
        self.context.chmod(0o644)
        with self.assertRaises(transport.Refusal): self.client()
        self.context.chmod(0o600)
        self.values["QA_OWNER_START_TICKS"] = "0"; self.write_context()
        with self.assertRaises(transport.Refusal): self.client()
        self.values["QA_OWNER_START_TICKS"] = process.identity(os.getpid())["start"]; self.write_context()
        alias = self.private / "alias.env"; alias.symlink_to(self.context)
        with self.assertRaises(transport.Refusal):
            transport.Transport.from_environment({**self.env, "QA_CONTEXT_FILE": str(alias)}, runner=self.fake)

    def test_reserved_or_drifted_cdp_ports_refused(self):
        for port in ["9222", "8499", "8600", "0", "8512"]:
            with self.assertRaises(transport.Refusal):
                transport.Transport.from_environment({**self.env, "VM_CDP_PORT": port}, runner=self.fake)

    def test_bootstrap_password_only_in_stdin_and_known_hosts_owned(self):
        client = self.client(); client.bootstrap()
        commands = json.dumps([argv for argv, _ in self.calls])
        self.assertNotIn(self.secret, commands)
        self.assertTrue(any(kwargs.get("input") == self.secret for _, kwargs in self.calls))
        for argv, _ in self.calls:
            if pathlib.Path(argv[0]).name in ["ssh", "scp"]:
                self.assertIn("UserKnownHostsFile=" + self.values["QA_KNOWN_HOSTS"], argv)
        self.assertIn("guest.pass", (self.job / "transport" / "askpass.sh").read_text())

    def test_feed_and_forwards_use_unique_helper_and_distinct_host_ports(self):
        client = self.client(); client.bootstrap(); self.calls.clear()
        client.feed(); client.local(); client.cdp()
        payloads = [json.loads(k["input"]) for _, k in self.calls if (k.get("input") or "").startswith("{")]
        self.assertTrue(any(p.get("port") == 8511 for p in payloads))
        self.assertTrue(any(p.get("port") == 9223 for p in payloads))
        self.assertTrue(any(p.get("port") == 8427 and "/root/qa/feed" in p["argv"] for p in payloads))
        arguments = json.dumps([p.get("argv", []) for p in payloads])
        self.assertIn("127.0.0.1:8511:127.0.0.1:9223", arguments)
        self.assertIn("127.0.0.1:9223:127.0.0.1:9222", arguments)
        self.assertNotIn(self.secret, json.dumps(self.calls))

    def test_bootstrap_failure_propagates_without_starting_a_process(self):
        def failed(argv, **kwargs):
            self.calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 7, "", self.secret)
        with self.assertRaises(transport.Refusal) as caught:
            self.client(runner=failed).bootstrap()
        self.assertNotIn(self.secret, str(caught.exception))
        self.assertFalse((self.job / "transport" / "bootstrap.json").exists())

    def test_local_refuses_missing_bootstrap(self):
        with self.assertRaises(transport.Refusal): self.client().local()

    def test_changed_context_refused_after_bootstrap(self):
        client = self.client(); client.bootstrap()
        self.values["VM_DROPLET"] = "other.example.invalid"; self.write_context()
        with self.assertRaises(transport.Refusal): self.client().local()

    def test_cleanup_attempts_all_recorded_resources_and_propagates_refusal(self):
        client = self.client(); client.bootstrap(); self.calls.clear()
        def failed(argv, **kwargs):
            self.calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 6, "", "private diagnostics")
        client.runner = failed
        with self.assertRaises(transport.Refusal): client.cleanup()
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(all("stop" in " ".join(argv) for argv, _ in self.calls))

    def test_missing_remote_pidfd_capability_refused_before_bootstrap_receipt(self):
        def incomplete(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 0, '{}', '')
        with self.assertRaises(transport.Refusal): self.client(runner=incomplete).bootstrap()
        self.assertFalse((self.job / 'transport/bootstrap.json').exists())

    def test_guest_forward_failure_stops_only_its_recorded_forward(self):
        client = self.client(); client.bootstrap(); self.calls.clear()
        def failed_probe(argv, **kwargs):
            self.calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 9 if 'curl' in argv[-1] else 0, '{}', '')
        client.runner = failed_probe
        with self.assertRaises(transport.Refusal): client.cdp()
        self.assertEqual(len(self.calls), 3)
        self.assertIn('stop', self.calls[-1][0][-1])
        self.assertIn('guest-forward.json', self.calls[-1][0][-1])

    def test_feed_source_must_match_immutable_context(self):
        self.values['VM_FEED_SOURCE'] = str(self.feed); self.write_context()
        client = self.client(); client.bootstrap()
        other = self.job / 'other-feed.py'; other.write_text('# another fixture\n')
        client.env['VM_FEED_SOURCE'] = str(other)
        with self.assertRaises(transport.Refusal): client.feed()

    def test_missing_or_changed_resource_authority_refused_before_ssh(self):
        self.authority.unlink()
        with self.assertRaises(transport.Refusal): self.client()
        self.write_context()
        authority = json.loads(self.authority.read_text()); authority['contextSha256'] = '0' * 64
        self.authority.write_text(json.dumps(authority))
        with self.assertRaises(transport.Refusal): self.client()
        self.assertEqual(self.calls, [])

    def test_resource_token_and_resource_identity_must_match_context(self):
        for field, value in [('token', 'f' * 64), ('resourceId', '9999'), ('runId', 'other-run')]:
            self.write_context(); authority = json.loads(self.authority.read_text()); authority[field] = value
            self.authority.write_text(json.dumps(authority))
            with self.assertRaises(transport.Refusal): self.client()

    def test_hardlinked_context_is_not_a_private_owned_input(self):
        duplicate = self.private / 'duplicate.env'; os.link(self.context, duplicate)
        with self.assertRaises(transport.Refusal): self.client()

    def test_legacy_slot_accepts_pinned_metadata_without_lock_or_lease_operations(self):
        self.values.update(QA_SLOT='legacy', QA_VM_LOCK_FD='6'); self.write_context()
        opened = []
        real_open = os.open
        def owned_open(file, *args, **kwargs):
            opened.append(str(file))
            self.assertNotEqual(str(file), '/tmp/era-vm-e2e.lock')
            self.assertFalse(str(file).startswith(self.values['QA_LEASE_DIR']))
            return real_open(file, *args, **kwargs)
        with patch.object(os, 'open', side_effect=owned_open):
            client = self.client(); client.bootstrap()
        self.assertTrue(opened)

    def test_slot_or_lock_caller_drift_refused_before_ssh(self):
        self.values.update(QA_SLOT='legacy', QA_VM_LOCK_FD='6'); self.write_context()
        for key, value in [('QA_SLOT', 'managed'), ('QA_VM_LOCK_FD', '7'), ('QA_LEASE_DIR', '/tmp/other-leases')]:
            with self.assertRaises(transport.Refusal):
                transport.Transport.from_environment({**self.env, key: value}, runner=self.fake)
        self.assertEqual(self.calls, [])

    def test_invalid_legacy_lock_and_foreign_lease_metadata_refused(self):
        self.values.update(QA_SLOT='legacy', QA_VM_LOCK_FD='6'); self.write_context()
        for field in ['vmLock', 'canonicalLease']:
            self.write_context(); authority = json.loads(self.authority.read_text()); authority[field] = None
            self.authority.write_text(json.dumps(authority))
            with self.assertRaises(transport.Refusal): self.client()
        self.write_context(); authority = json.loads(self.authority.read_text())
        authority['canonicalLease']['holder'] = 'vm-e2e-other'
        self.authority.write_text(json.dumps(authority))
        with self.assertRaises(transport.Refusal): self.client()

    def test_resource_metadata_cannot_change_after_bootstrap(self):
        client = self.client(); client.bootstrap()
        authority = json.loads(self.authority.read_text()); authority['createdAt'] = 'changed'
        self.authority.write_text(json.dumps(authority))
        with self.assertRaises(transport.Refusal): self.client().local()


if __name__ == "__main__":
    unittest.main()
