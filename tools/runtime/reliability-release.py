import argparse
from contextlib import ExitStack, closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


@contextmanager
def connection(path):
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        yield db
    finally:
        db.close()


def inspect(database):
    with connection(database) as db:
        if db.execute('PRAGMA application_id').fetchone()[0] != 0x50525253:
            raise ValueError('not a Prospero database')
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('database integrity check failed')
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        checks = [('agent_runs', 'active=1'),
                  ('orch_worker_starts', "phase NOT IN ('running','failed','cancelled')"),
                  ('orch_executions', "lower(state) <> 'finalized'"),
                  ('orch_operations_v2', "state NOT IN ('succeeded','failed','cancelled')"),
                  ('orch_result_receipts', "state NOT IN ('accepted','rejected')"),
                  ('orch_host_registry', "state <> 'retired'")]
        for table, predicate in checks:
            if table in tables and db.execute(f'SELECT count(*) FROM {table} WHERE {predicate}').fetchone()[0]:
                raise ValueError(f'{table} has unfinished ownership; drain and reconcile before offline backup/restore')
        if 'agent_runs' in tables:
            columns = {row[1] for row in db.execute('PRAGMA table_info(agent_runs)')}
            if 'execution_unknown' in columns and db.execute('SELECT count(*) FROM agent_runs WHERE execution_unknown=1').fetchone()[0]:
                raise ValueError('agent_runs has unfinished ownership; unknown execution cannot be backed up')
        return db.execute('PRAGMA user_version').fetchone()[0]


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'expected regular file: {path}')


def lock_owner(directory):
    if os.name != 'posix':
        raise ValueError('offline maintenance lock is not verified on this platform')
    import fcntl
    path = directory / 'owner.lock'
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    stream = os.fdopen(fd, 'r+b')
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        stream.close()
        raise ValueError('daemon owns data directory; stop admission and drain before maintenance') from None
    return stream


def seal(directory, manifest):
    manifest['files'] = {}
    for path in sorted(directory.rglob('*')):
        if path.is_file():
            regular(path)
            manifest['files'][str(path.relative_to(directory))] = digest(path)
            os.chmod(path, 0o600)
            with path.open('rb') as stream:
                os.fsync(stream.fileno())
    target = directory / 'manifest.json'
    with target.open('x') as stream:
        json.dump(manifest, stream, sort_keys=True, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(target, 0o600)


def safe_tree(directory, *, ignore_account_caches=False):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError(f'expected real directory: {directory}')
    pending = list(directory.iterdir())
    while pending:
        path = pending.pop()
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError(f'symlink, linked or special file in source: {path}')
        if not path.is_dir():
            continue
        parts = path.relative_to(directory).parts
        if (ignore_account_caches and parts[-2:] == ('tmp', 'arg0')
                and any(parts[index:index + 2] in (('agent-accounts', 'codex'), ('agent-accounts', 'codex-usage'))
                        for index in range(len(parts) - 2))):
            continue
        pending.extend(path.iterdir())


def file_signature(path):
    regular(path)
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def stable_copy(source, target):
    before = file_signature(source)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(source, target)
    if file_signature(source) != before or digest(source) != digest(target):
        raise ValueError(f'source changed during snapshot: {source}')


def sqlite_snapshot(source, target):
    regular(source)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with connection(source) as origin, closing(sqlite3.connect(target)) as snapshot:
        origin.backup(snapshot, pages=256, sleep=0.01)
        snapshot.commit()
        if snapshot.execute('PRAGMA journal_mode=DELETE').fetchone()[0] != 'delete':
            raise ValueError('snapshot could not be sealed without WAL')
    inspect(target)


def snapshot_hosts(source, stage, stack):
    host_root = source / 'execution-hosts'
    if not host_root.exists():
        return []
    safe_tree(host_root, ignore_account_caches=True)
    with connection(stage / 'prospero.sqlite') as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'orch_host_registry', 'orch_executions', 'orch_operations_v2'} <= tables:
            raise ValueError('host journals require a verified drained host snapshot; registry is missing')
        hosts = db.execute('SELECT host_id,host_epoch,state,runtime_digest FROM orch_host_registry').fetchall()
    if not hosts:
        raise ValueError('host journals require a verified drained host snapshot; registry is empty')
    expected = set()
    for host_id, epoch, state, runtime in hosts:
        if state != 'retired' or any(not value or len(value) > 128 or any(not (char.isascii() and (char.isalnum() or char in '-_.')) for char in value) or value in ('.','..') for value in (host_id, epoch)):
            raise ValueError('host identity is not verified retired')
        directory = host_root / host_id / epoch
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError('retired Host directory is missing')
        expected.add((host_id, epoch))
        driver = directory / 'driver-state'
        safe_tree(driver, ignore_account_caches=True)
        stack.enter_context(lock_owner(driver))
        inspect(driver / 'prospero.sqlite')
    actual = set()
    for owner in host_root.iterdir():
        if not owner.is_dir():
            raise ValueError('unexpected file in Host registry tree')
        for epoch_directory in owner.iterdir():
            if not epoch_directory.is_dir():
                raise ValueError('unexpected file in Host identity directory')
            actual.add((owner.name, epoch_directory.name))
    if actual != expected:
        raise ValueError('Host directories differ from authoritative registry')
    snapshots = []
    for host_id, epoch, state, runtime in hosts:
        directory = host_root / host_id / epoch
        relative = Path('execution-hosts') / host_id / epoch
        manifest_path = directory / 'manifest.json'
        signature = file_signature(manifest_path)
        manifest = json.loads(manifest_path.read_text())
        if manifest.get('protocolVersion') != 1 or manifest.get('identity') != {'hostId':host_id,'hostEpoch':epoch} or manifest.get('runtimeDigest') != runtime:
            raise ValueError('Host manifest identity or runtime differs from registry')
        if len(runtime) != 64 or any(char not in '0123456789abcdef' for char in runtime):
            raise ValueError('invalid Host runtime digest')
        journal_name = 'host-journal-' + hashlib.sha256((host_id + '\0' + epoch).encode()).hexdigest() + '.jsonl'
        journal = directory / journal_name
        journal_signature = file_signature(journal)
        if journal_signature[2] > 512 * 1024 * 1024:
            raise ValueError('Host journal exceeds snapshot limit')
        with journal.open() as stream:
            for line in stream:
                json.loads(line)
        runtime_source = source / 'execution-runtimes' / runtime / 'runtime'
        if not runtime_source.exists():
            runtime_source = directory / 'runtime'
        regular(runtime_source)
        if digest(runtime_source) != runtime:
            raise ValueError('Host runtime pin digest differs')
        runtime_relative = Path('execution-runtimes') / runtime / 'runtime'
        if not (stage / runtime_relative).exists():
            stable_copy(runtime_source, stage / runtime_relative)
        stable_copy(manifest_path, stage / relative / 'manifest.json')
        stable_copy(journal, stage / relative / journal_name)
        sqlite_snapshot(directory / 'driver-state/prospero.sqlite', stage / relative / 'driver-state/prospero.sqlite')
        if file_signature(manifest_path) != signature or file_signature(journal) != journal_signature:
            raise ValueError('retired Host changed during snapshot')
        snapshots.append({'identity':manifest['identity'],'runtimeDigest':runtime,'runtimeFile':str(runtime_relative),'directory':str(relative),'journal':str(relative / journal_name)})
    return snapshots


def backup(source, destination, binaries):
    if source.is_symlink() or not source.is_dir() or destination.exists() or destination.is_symlink():
        raise ValueError('source must be a real directory and destination must not exist')
    safe_tree(source, ignore_account_caches=True)
    regular(source / 'prospero.sqlite')
    with lock_owner(source), ExitStack() as stack:
        inspect(source / 'prospero.sqlite')
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.prospero-backup-', dir=destination.parent) as temporary:
            stage = Path(temporary) / 'snapshot'
            stage.mkdir(mode=0o700)
            sqlite_snapshot(source / 'prospero.sqlite', stage / 'prospero.sqlite')
            schema = inspect(stage / 'prospero.sqlite')
            artifacts = stage / 'runtime'
            artifacts.mkdir(mode=0o700)
            for binary in binaries:
                regular(binary)
                if (artifacts / binary.name).exists():
                    raise ValueError('duplicate runtime artifact name')
                stable_copy(binary, artifacts / binary.name)
            hosts = snapshot_hosts(source, stage, stack)
            seal(stage, {'formatVersion': 1, 'schemaVersion': schema, 'mode': 'offline-drained',
                         'restoreRequiresReconciliation': True, 'hosts': hosts})
            os.rename(stage, destination)
    return verify(destination)


def verify(directory):
    safe_tree(directory)
    regular(directory / 'manifest.json')
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('formatVersion') != 1 or manifest.get('mode') != 'offline-drained':
        raise ValueError('unsupported backup format')
    actual = set()
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('symlink in backup')
        if path.is_file() and path != directory / 'manifest.json':
            actual.add(str(path.relative_to(directory)))
    if actual != set(manifest['files']):
        raise ValueError('backup file inventory differs')
    for name, expected in manifest['files'].items():
        path = directory / name
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('invalid manifest path')
        regular(path)
        if digest(path) != expected:
            raise ValueError(f'backup digest differs: {name}')
    schema = inspect(directory / 'prospero.sqlite')
    if schema != manifest['schemaVersion']:
        raise ValueError('backup schema differs')
    for host in manifest.get('hosts', []):
        for reference in (host['runtimeFile'], host['journal'], str(Path(host['directory']) / 'manifest.json'), str(Path(host['directory']) / 'driver-state/prospero.sqlite')):
            if reference not in manifest['files']:
                raise ValueError('unlisted Host snapshot reference')
        runtime = directory / host['runtimeFile']
        if digest(runtime) != host['runtimeDigest']:
            raise ValueError('Host runtime pin differs')
        inspect(directory / host['directory'] / 'driver-state/prospero.sqlite')
    return manifest


def restore(source, destination):
    manifest = verify(source)
    if destination.exists() or destination.is_symlink():
        raise ValueError('restore only accepts a new isolated destination; live data is never replaced')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.prospero-restore-', dir=destination.parent) as temporary:
        stage = Path(temporary) / 'data'
        stage.mkdir(mode=0o700)
        for name, expected in manifest['files'].items():
            target = stage / name
            stable_copy(source / name, target)
            os.chmod(target, 0o700 if Path(name).parts[0] == 'execution-runtimes' else 0o600)
            if digest(target) != expected:
                raise ValueError('backup changed during restore')
        inspect(stage / 'prospero.sqlite')
        marker = stage / 'RESTORE_REQUIRES_RECONCILIATION.json'
        marker.write_text(json.dumps(manifest, indent=2))
        os.chmod(marker, 0o600)
        os.rename(stage, destination)
    return {'restored': str(destination), 'admissionAllowed': False}


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ['backup', 'restore']:
        child = commands.add_parser(command)
        child.add_argument('--source', type=Path, required=True)
        child.add_argument('--destination', type=Path, required=True)
        if command == 'backup':
            child.add_argument('--binary', type=Path, action='append', default=[])
    child = commands.add_parser('verify')
    child.add_argument('directory', type=Path)
    args = parser.parse_args()
    if args.command == 'backup':
        result = backup(args.source, args.destination, args.binary)
    elif args.command == 'restore':
        result = restore(args.source, args.destination)
    else:
        result = verify(args.directory)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
