import hashlib
import json
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('reliability-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.db = sqlite3.connect(self.source / 'prospero.sqlite')
        self.addCleanup(self.db.close)
        self.db.executescript('PRAGMA journal_mode=WAL; PRAGMA application_id=1347572307; PRAGMA user_version=34; CREATE TABLE agent_runs(active INTEGER); CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES (\'retained\');')
        self.db.commit()
        self.snapshot = self.root / 'backup'

    def test_codex_ephemeral_links_are_ignored_but_never_backed_up(self):
        cache = self.source / 'agent-accounts/codex-usage/native-codex/home/tmp/arg0'
        cache.mkdir(parents=True)
        (cache / 'applypatch').symlink_to('/does-not-exist')
        manifest = release.backup(self.source, self.snapshot, [])
        self.assertFalse(any('agent-accounts' in path for path in manifest['files']))
        restored = self.root / 'restored'
        self.assertFalse(release.restore(self.snapshot, restored)['admissionAllowed'])

    def test_codex_cache_root_link_is_rejected(self):
        cache = self.source / 'agent-accounts/codex/account/tmp/arg0'
        cache.parent.mkdir(parents=True)
        cache.symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, 'linked or special'):
            release.backup(self.source, self.snapshot, [])

    def test_other_account_links_still_rejected(self):
        cache = self.source / 'agent-accounts/claude/account/tmp/arg0'
        cache.mkdir(parents=True)
        (cache / 'unknown').symlink_to('/does-not-exist')
        with self.assertRaisesRegex(ValueError, 'linked or special'):
            release.backup(self.source, self.snapshot, [])

    def test_wal_snapshot_restore_and_pin(self):
        binary = self.root / 'prosperod'
        binary.write_bytes(b'pinned-runtime')
        manifest = release.backup(self.source, self.snapshot, [binary])
        self.assertEqual(manifest['schemaVersion'], 34)
        self.assertIn('runtime/prosperod', manifest['files'])
        self.db.execute("UPDATE evidence SET value='newer'")
        self.db.commit()
        restored = self.root / 'restored'
        self.assertFalse(release.restore(self.snapshot, restored)['admissionAllowed'])
        with sqlite3.connect(restored / 'prospero.sqlite') as db:
            self.assertEqual(db.execute('SELECT value FROM evidence').fetchone()[0], 'retained')
        self.assertTrue((restored / 'RESTORE_REQUIRES_RECONCILIATION.json').exists())

    def test_active_execution_refused(self):
        self.db.execute('INSERT INTO agent_runs VALUES (1)')
        self.db.commit()
        with self.assertRaisesRegex(ValueError, 'unfinished ownership'):
            release.backup(self.source, self.snapshot, [])
        self.assertFalse(self.snapshot.exists())

    def test_owner_lock_refused(self):
        with release.lock_owner(self.source):
            with self.assertRaisesRegex(ValueError, 'daemon owns'):
                release.backup(self.source, self.snapshot, [])

    def test_digest_tamper_refused(self):
        release.backup(self.source, self.snapshot, [])
        with (self.snapshot / 'prospero.sqlite').open('ab') as stream:
            stream.write(b'tamper')
        with self.assertRaisesRegex(ValueError, 'digest differs'):
            release.verify(self.snapshot)

    def test_live_destination_never_overwritten(self):
        release.backup(self.source, self.snapshot, [])
        with self.assertRaisesRegex(ValueError, 'new isolated'):
            release.restore(self.snapshot, self.source)
        self.assertEqual(self.db.execute('SELECT value FROM evidence').fetchone()[0], 'retained')

    def test_extra_or_linked_files_refused(self):
        release.backup(self.source, self.snapshot, [])
        extra = self.snapshot / 'extra'
        extra.write_bytes(b'unknown')
        with self.assertRaisesRegex(ValueError, 'inventory differs'):
            release.verify(self.snapshot)
        extra.unlink()
        extra.symlink_to(self.source / 'prospero.sqlite')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            release.verify(self.snapshot)

    def retired_host(self):
        runtime_bytes = b'isolated-retired-host-runtime'
        runtime = hashlib.sha256(runtime_bytes).hexdigest()
        self.db.executescript("CREATE TABLE orch_host_registry(host_id TEXT,host_epoch TEXT,state TEXT,runtime_digest TEXT); CREATE TABLE orch_executions(state TEXT); CREATE TABLE orch_operations_v2(state TEXT); CREATE TABLE orch_result_receipts(state TEXT); INSERT INTO orch_executions VALUES('finalized'); INSERT INTO orch_operations_v2 VALUES('succeeded'); INSERT INTO orch_result_receipts VALUES('accepted');")
        self.db.execute("INSERT INTO orch_host_registry VALUES('host-test','epoch-test','retired',?)",(runtime,))
        self.db.commit()
        directory = self.source / 'execution-hosts/host-test/epoch-test'
        driver = directory / 'driver-state'
        driver.mkdir(parents=True)
        identity = {'hostId':'host-test','hostEpoch':'epoch-test'}
        (directory / 'manifest.json').write_text(json.dumps({'protocolVersion':1,'identity':identity,'socketPath':'/tmp/isolated-retired-host/control.sock','runtimeDigest':runtime,'pid':None}))
        (directory / 'token').write_text('private-capability-never-backed-up')
        journal_name = 'host-journal-' + hashlib.sha256(b'host-test\0epoch-test').hexdigest() + '.jsonl'
        journal = directory / journal_name
        journal.write_text(json.dumps({'recordType':'event','event':{'identity':{'host':identity,'attemptId':'attempt-test','executionEpoch':1},'sequence':1,'kind':'exit_confirmed','payload':'{}'}}) + '\n')
        driver_db = sqlite3.connect(driver / 'prospero.sqlite')
        self.addCleanup(driver_db.close)
        driver_db.executescript("PRAGMA journal_mode=WAL; PRAGMA application_id=1347572307; PRAGMA user_version=35; CREATE TABLE agent_runs(active INTEGER,execution_unknown INTEGER); INSERT INTO agent_runs VALUES(0,0); CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('drained-driver-output');")
        driver_db.commit()
        pin = self.source / 'execution-runtimes' / runtime / 'runtime'
        pin.parent.mkdir(parents=True)
        pin.write_bytes(runtime_bytes)
        return directory, journal, driver_db, pin

    def test_retired_host_journal_driver_snapshot_and_runtime_pin_are_preserved(self):
        directory, journal, driver, pin = self.retired_host()
        manifest = release.backup(self.source, self.snapshot, [])
        self.assertEqual(len(manifest['hosts']),1)
        self.assertIn(str(journal.relative_to(self.source)),manifest['files'])
        self.assertIn(str(pin.relative_to(self.source)),manifest['files'])
        self.assertIn('execution-hosts/host-test/epoch-test/manifest.json',manifest['files'])
        self.assertFalse(any(name.endswith(('/token','-wal','-shm','owner.lock')) for name in manifest['files']))
        with sqlite3.connect(self.snapshot / directory.relative_to(self.source) / 'driver-state/prospero.sqlite') as snapshot:
            self.assertEqual(snapshot.execute('SELECT value FROM evidence').fetchone()[0],'drained-driver-output')
        driver.execute("UPDATE evidence SET value='after-backup'")
        driver.commit()
        restored = self.root / 'restored-host'
        self.assertFalse(release.restore(self.snapshot,restored)['admissionAllowed'])
        self.assertEqual((restored / journal.relative_to(self.source)).read_text(),journal.read_text())
        self.assertFalse((restored / directory.relative_to(self.source) / 'token').exists())
        with sqlite3.connect(restored / directory.relative_to(self.source) / 'driver-state/prospero.sqlite') as snapshot:
            self.assertEqual(snapshot.execute('SELECT value FROM evidence').fetchone()[0],'drained-driver-output')

    def test_host_metadata_cannot_reference_files_outside_inventory(self):
        self.retired_host()
        release.backup(self.source,self.snapshot,[])
        path = self.snapshot / 'manifest.json'
        manifest = json.loads(path.read_text())
        manifest['hosts'][0]['runtimeFile'] = '../outside-inventory'
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'unlisted Host snapshot reference'):
            release.verify(self.snapshot)

    def test_retired_host_still_holding_driver_owner_lock_is_refused(self):
        directory, _, _, _ = self.retired_host()
        with release.lock_owner(directory / 'driver-state'):
            with self.assertRaisesRegex(ValueError,'daemon owns'):
                release.backup(self.source,self.snapshot,[])
        self.assertFalse(self.snapshot.exists())

    def test_active_or_unregistered_host_cannot_be_backed_up(self):
        directory, _, _, _ = self.retired_host()
        self.db.execute("UPDATE orch_host_registry SET state='active'")
        self.db.commit()
        with self.assertRaisesRegex(ValueError,'unfinished ownership'):
            release.backup(self.source,self.snapshot,[])
        self.db.execute("UPDATE orch_host_registry SET state='retired'")
        self.db.commit()
        (directory.parent / 'unregistered-epoch').mkdir()
        with self.assertRaisesRegex(ValueError,'authoritative registry'):
            release.backup(self.source,self.snapshot,[])

    def test_retired_host_links_mutations_and_changed_pins_are_refused(self):
        directory, journal, _, pin = self.retired_host()
        pin.write_bytes(b'changed-runtime')
        with self.assertRaisesRegex(ValueError,'pin digest differs'):
            release.backup(self.source,self.snapshot,[])
        pin.write_bytes(b'isolated-retired-host-runtime')
        linked = directory / 'linked-file'
        linked.symlink_to(self.source / 'prospero.sqlite')
        with self.assertRaisesRegex(ValueError,'linked or special'):
            release.backup(self.source,self.snapshot,[])
        linked.unlink()
        original = release.shutil.copyfile
        def mutate(source,target):
            result = original(source,target)
            if source == journal:
                with journal.open('a') as stream:
                    stream.write('{}\n')
            return result
        with mock.patch.object(release.shutil,'copyfile',side_effect=mutate):
            with self.assertRaisesRegex(ValueError,'changed during snapshot'):
                release.backup(self.source,self.snapshot,[])
        self.assertFalse(self.snapshot.exists())

    def test_host_journals_require_verified_snapshot(self):
        (self.source / 'execution-hosts').mkdir()
        with self.assertRaisesRegex(ValueError, 'verified drained host snapshot'):
            release.backup(self.source, self.snapshot, [])
        self.assertFalse(self.snapshot.exists())


if __name__ == '__main__':
    unittest.main()
