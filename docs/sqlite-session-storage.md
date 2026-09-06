# SQLite session storage

Implemented 2026-09-06. This migration removes whole-history JSON parsing at daemon startup and whole-history JSON rewrites during session persistence. It does not yet replace the mobile/desktop chat snapshot protocol.

## Authoritative stores

| Location, relative to the Prospero home | Contents |
| --- | --- |
| `sessions.sqlite` | In-process structured session metadata/checkpoints, ordered events, complete queued messages, tool outputs |
| `structured-supervisor/<id>/session.sqlite` | The same state for a new detached owner; its manifest has `storageVersion: 2` |
| `structured-supervisor/<id>/supervisor.sqlite` | Supervisor lifecycle, replay cursor, and durable replay journal |

Each detached owner remains independent of the daemon and desktop lifetime. Session and supervisor replay cursors have separate responsibilities. A replay write failure fences subsequent events and commands so a later event cannot take the failed event's sequence. These two databases do not provide an atomic transaction across an external model operation or an exactly-once execution guarantee.

Session metadata excludes event bodies, tool bodies, and queued messages. Events are inserted by sequence; a later retained 4,000-event window never deletes older stored events. Queue replacement and adapter checkpoint updates are transactional. Tool output is stored in bounded BLOB chunks and retrieved by call ID. Read-only archive lists use separately indexed queue summaries instead of reading full queued prompts. In-process restoration reads complete queue bodies where needed to preserve execution semantics.

New SQLite owner connections subscribe atomically at the current replay cursor without loading existing event bodies. Metadata and pending interaction summaries load separately. Explicit compatibility snapshots still load the retained full history window; opening a very large conversation can therefore still have a substantial allocation peak.

## Migration and recovery

- Original `structured-sessions.json`, owner `session.json`, and supervisor `state.json`/`events.jsonl` remain intact. Migration parses JSON incrementally, writes a private staging database, validates identity/cursors and strict end-of-file, then publishes without replacing an existing database. Duplicate object keys and malformed input fail migration.
- Existing live legacy owners continue using their original immutable runner and JSON files. An upgrade never relaunches them or replays their queued prompts. Dead legacy owner migration runs in the background, guarded by process-death proof and repeated PID, epoch, directory identity, and deletion checks.
- An existing SQLite database is authoritative. Incompatible/corrupt databases are reported rather than replaced with stale JSON. A `storageVersion: 2` owner with a missing database also remains an explicit storage error.
- Failure in the daemon's central store does not prevent independent owners from reconnecting. Central storage writes fail visibly until the storage problem is resolved.
- A process interruption may leave an unpublished `.import-*` file. It is not selected as authoritative on restart; the original JSON remains available for a fresh import. Completed imports remove their own staging files.

The retained JSON is a **migration-time** backup. After SQLite receives new writes, those JSON files are stale. Do not downgrade by deleting SQLite and reopening old JSON. Preserve the current databases and sidecars before recovery; a live database backup must use a SQLite-consistent backup/checkpoint procedure, not copy only the main file while a writer is active. Legacy owners and new owners may coexist for as long as the old processes remain alive.

## Bounded history API

The authenticated loopback control API exposes:

```text
GET /_prospero/control/session/:id/history?beforeSeq=123&limit=200&maxBytes=524288
```

`beforeSeq` is exclusive. Results contain `{ events: [{seq, body}], lastSeq, oldestSeq, hasMore, oversized? }`. Events are returned in ascending order within a page selected from newest backwards. Limits are 200 events and 512 KiB of stored event JSON per page; envelope overhead is additional. An individual oversized event produces `{seq, bytes}` without reading its body. A caller can continue before that sequence, but must not present the skipped body as loaded. This release does not yet include an event-body chunk endpoint or a mobile/desktop paging UI.

Tool output reads retain the existing default 200,000 UTF-16 character response limit and explicit `truncated` flag; complete new tool bodies remain durable. Explicit internal `maxBytes` reads are bounded by bytes. None of these display budgets truncate the prompt sent to the coding agent.

## Runtime and privacy

The daemon requires Node **22.13.0 or newer** and uses built-in `node:sqlite`, with no additional native SQLite binding. Verified runtimes: Node 24.16.0 / SQLite 3.53.0 and Node 22.13.1 / SQLite 3.47.2. Node 22.13 still labels this API experimental, though no experimental command-line flag is required.

Database directories use mode 0700 and files/sidecars use 0600 on POSIX. Symlink/unsafe-owner checks apply, extensions are disabled, and connections use a 2 MiB page cache, no mmap, a bounded busy wait, and full synchronous durability. WAL is enabled only on versions containing the [SQLite WAL-reset fix](https://sqlite.org/wal.html#walresetbug); older SQLite versions use DELETE journaling. SQLite does not encrypt local data.

## Memory evidence

Reproduce after building the daemon:

```sh
node tools/session-sqlite-memory-regression.mjs
```

Synthetic 32 KiB messages, isolated Node 24.16.0 macOS arm64 children, 64 MiB V8 old-space limit, core dumps disabled. Both histories were imported without an OOM. Each read process loaded metadata and at most one 512 KiB history page. These are single measurements, not percentiles; RSS includes native memory beyond the JS heap limit.

| History | Import time | Import peak RSS | Metadata + page time | Read peak RSS |
| --- | --- | --- | --- | --- |
| 10 MiB | 117 ms | 86.7 MiB | 3 ms | 57.5 MiB |
| 100 MiB | 672 ms | 89.1 MiB | 3 ms | 57.3 MiB |

The import retains approximately one selected JSON record at a time. A single huge event/string can still exceed that bound; event body references and chunked parsing/rendering remain follow-up work. These measurements establish bounded storage startup/page behavior, not an iPhone memory guarantee, a supported maximum prompt size, or a fix for OOM inside Codex/Claude itself.

## Regression verification

The daemon suite passed 805 tests (24 platform-specific skips); the desktop suite passed 142 tests. Recovery acceptance includes real daemon/owner processes with synthetic adapters, SIGTERM/SIGKILL, pending approvals/questions, ordered replay, and immutable runtime upgrades. Fault injection verifies that failed event/tool writes remain fenced after the disk starts accepting writes again, and late callbacks cannot grow the pending event buffer.

A read-only copy of this installation's legacy data was migrated separately: 101 sessions and 104,845 events across 102 input files. Ordered event-body SHA-256 checks matched before and after migration. This verifies the captured copy; live legacy owners remain on their original storage until exit.
