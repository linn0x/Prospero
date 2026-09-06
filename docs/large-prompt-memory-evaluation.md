# Large prompt memory evaluation

Date: 2026-09-06. Scope: Prospero transport, daemon persistence, and mobile/desktop history rendering. No real prompts were read or sent during this evaluation.

## Decision

Adopt SQLite as a staged persistence upgrade, together with byte-bounded history pages and on-demand large bodies. Replacing JSON files with a database while still loading all rows into one snapshot will retain the main OOM risks.

A concrete allocation problem in the shared Base64 codec is fixed in this change. The user's exact failing platform and action (opening history, pasting/sending one prompt, or the underlying agent process) have not yet been confirmed. The isolated reproduction below establishes a transport hotspot, not the complete cause of every reported OOM.

## Reproduced issue and immediate fix

`packages/protocol/src/b64.ts` previously appended tiny strings repeatedly across the entire payload. Large encodings accumulated excessive string/rope allocation overhead. The replacement joins bounded 16,384-character scratch chunks and reuses decoding scratch space. The encrypted wire format and full prompt contents are unchanged; no input is silently truncated.

The codec is on the real encrypted path: `SecureChannel.seal()` in `packages/protocol/src/crypto.ts` serializes the message, encodes UTF-8, encrypts, Base64-encodes, then serializes the outer frame. Receive performs the reverse transformations.

Synthetic isolated Node v24.16.0 processes on macOS arm64 used `--expose-gc --max-old-space-size=128`, with core dumps disabled. Each test encoded and decoded a binary payload and checked the result. Values below are single measurements, not timing percentiles. The heap limit constrains V8 old space, not total process RSS.

| Payload | Original result | Fixed result | Original / fixed encoding heap | Original / fixed peak RSS |
| --- | --- | --- | --- | --- |
| 1 MiB | Passed, 36 ms | Passed, 39 ms | 43.5 / 10.7 MiB | 137.6 / 66.3 MiB |
| 4 MiB | Aborted: heap OOM | Passed, 134 ms | Unavailable / 21.8 MiB | Unavailable / 93.6 MiB |

The evidence supports reduced allocation and survival of the 4 MiB case. It does not establish a speedup, Hermes/iPhone memory usage, or an end-to-end supported prompt size. In particular, current IPC limits still prevent claiming that a 4 MiB user prompt can be sent successfully to an agent.

Codec tests compare against the platform's standard encoding across chunk boundaries and a 4 MiB input, exercise URL-safe/unpadded forms and malformed input, and retain encryption/QR/relay regression coverage. A separate constrained-process regression protects against bringing back the allocation failure.

The complete `SecureChannel.seal()`/`open()` round trip also passed for a synthetic 4 MiB ASCII prompt with a 256 MiB heap limit: 282 ms and 141.8 MiB peak RSS in one run. This still leaves substantial allocation beyond the codec. Reproduce the current codec and encrypted-path cases with `npm run build -w @prospero/protocol` followed by `node tools/base64-memory-regression.mjs`; `packages/protocol/test/b64-memory.test.ts` tests the current source in an isolated 128 MiB child process without relying on built output.

## Remaining allocation paths

Source references below describe the implementation at evaluation time.

| Area | Current behavior and consequence | Relevant source |
| --- | --- | --- |
| Daemon event history | Keeps 4,000 events by count; a single user message can still be very large. Tool output is capped at 200,000 characters per entry, with about 200 retained entries, which is still substantial aggregate text. | `apps/daemon/src/structured-session.ts`: limits near line 46, `persistentState()`, `transportSnapshot()` |
| Persistence | The owner serializes the complete session state to `session.json`; restoring a read-only session parses the complete file before keeping its event window. Looking up one saved tool output also parses the complete session file. | `structured-supervisor-runner.ts`: `privateWrite()`, `persist()`; `structured-supervisor-client.ts`: `loadReadonlyCache()`, `toolOutput()` |
| Recovery journal | Recovery reads the complete journal and splits it into lines. Journal compaction happens at selected state boundaries, so a long turn can accumulate a large file. | `apps/daemon/src/structured-supervisor.ts`: `loadJournal()`, `compactJournal()` |
| Attach/reconnect | An initial attach or cursor gap sends the complete retained `chat.snapshot` in one encrypted frame. Incremental events are emitted synchronously; structured chat lacks the PTY path's corresponding flow control. | `apps/daemon/src/ws-server.ts`: `attachChat()`, near lines 925–1055 |
| Input limits | Protocol text fields have no size limit. WebSocket has a 16 MiB incoming frame limit, while supervisor IPC accepts only 1 MiB per incoming line. Those limits measure different representations and do not bound outgoing snapshots. Oversized input can allocate through decryption/JSON parsing before the later IPC boundary rejects it. | `packages/protocol/src/schemas.ts`: `C2SChatSendSchema`, user message schema; `ws-server.ts`: `maxPayload`; `structured-supervisor.ts`: `MAX_LINE_BYTES` |
| Queue metadata | A queue of at most 50 items still includes each item's full `displayText` in session metadata. Client metadata deduplication serializes that data again. The status-file preview limit does not bound the other paths. | `structured-session.ts`: `info()`; `structured-supervisor-client.ts`: metadata comparison; `status-file.ts`: queue preview |
| Mobile history | `ChatView` reduces a complete snapshot into memory. FlatList virtualizes rows but retains all message bodies in state. One huge user bubble or Markdown message can still be expensive to parse and render. | `apps/mobile/src/components/ChatView.tsx`, `Markdown.tsx`; `apps/mobile/src/lib/chat-model.ts` |
| Mobile caches/drafts | Markdown's global cache is capped at 8 entries, not bytes. Draft saves serialize complete text through a promise chain; rapid saves can retain several pending versions. | `apps/mobile/src/lib/markdown.ts`: stream cache; `composer-draft-store.ts`: `serialize()`, `save()` |
| Desktop | Existing protection includes a 2,000-item retained timeline, a visible window, and a 20,000-character persisted draft limit. These do not bound one message body or the full server snapshot. | `apps/desktop/src/renderer/src/chat-events.ts`, `ChatPane.tsx` |

Not all objects mean duplicate text: owner-side event arrays can share references. Cross-process serialization/parse and encrypted transformations do create separate representations. Images in persisted history already use references, so moving image history out of JSON is not a missing first step.

## Proposed rollout

### 1. Establish byte budgets and identify the failing process

- Record sizes/counts and process heap/RSS around load, encode, decrypt, parse, and render, without prompt text, keys, or credentials. Separate daemon, detached owner, Electron renderer, iOS JavaScript/native memory, and the actual Codex/Claude process.
- Align user-visible input validation with the smallest downstream limit, including UTF-8, JSON escaping, encryption and Base64 overhead. A character count is insufficient for Unicode. Reject unsupported input clearly before expensive conversions; preserve the user's draft and never silently truncate model input.
- Coalesce mobile draft persistence to the latest pending value, with explicit flush/clear ordering so a late autosave cannot restore a sent draft. Bound Markdown caches by bytes and avoid caching an oversized message.
- Separate short queue/session previews from full prompt bodies. Keep the original body recoverable and preserve permission/question state independently of ordinary display history.

### 2. Bound loading and rendering before changing storage

- Introduce a capability-negotiated history page API with an event sequence cursor, `hasMore`, an item count cap, and a serialized byte cap. Fetch the newest page first, then older pages on demand. Byte caps must account for the encrypted frame as well as decoded JSON.
- Represent large bodies with an ID, byte length and preview. Transfer/read body chunks only when needed. One oversized event must not defeat the page budget or prevent cursor progress.
- Keep a bounded in-memory timeline and use a chunked detail reader for large messages. Virtualizing the outer list alone is insufficient. Preserve complete model input separately from its UI preview.
- Bound outgoing queues and yield between batches so a slow phone/reconnect cannot enqueue an entire history faster than it can consume it.
- Replace full-session tool-output reads with direct body lookup and full-journal recovery with streaming legacy import.

Initial candidate budgets for measurement, not implemented product guarantees: 100 items and 256 KiB decoded content per history page; a 4–8 MiB decoded timeline window; 64 KiB previews with chunked full-text access; a 2 MiB Markdown cache. Measure serialized and native costs on the target iPhone before fixing release thresholds.

### 3. Introduce SQLite without coupling agent lifetime to the desktop

Use one authoritative session database inside each detached owner's private directory, with the owner as its single writer. Keep the desktop/daemon outside the owner's lifetime dependency. A daemon-wide summary/search index can be rebuilt; it must not be required for an already-running agent to continue.

Suggested logical tables:

| Data | Purpose |
| --- | --- |
| `events(session_id, seq, type, body_id, preview, byte_length)` | Indexed cursor pagination without decoding older bodies |
| `body_chunks(body_id, chunk_index, data)` | Bounded retrieval of complete large text; select individual chunks rather than one giant TEXT value |
| `tool_outputs(call_id, body_id, truncated)` | Direct lookup without loading session history |
| `queue(message_id, body_id, state, created_at)` | Full queued input separate from short session metadata |
| `checkpoints(adapter, seq, state)` | Adapter recovery state and local replay boundary |

A local transaction can atomically update event sequence, queue state, and checkpoint references. An external model request is not inside that transaction; do not claim exactly-once execution across crashes.

SQLite WAL supports concurrent readers and a writer, but each database still has one writer. Use short read transactions, bounded busy waits, and checkpoint monitoring; long readers can hold back checkpoints. Keep the database, `-wal`, and `-shm` files private. See [SQLite WAL concurrency](https://sqlite.org/wal.html#concurrency) and [transaction semantics](https://sqlite.org/lang_transaction.html).

For mobile, Expo SDK 57's `expo-sqlite` is a suitable bounded local history cache. It supports persistent storage, async access, prepared statements and iterative reads. Avoid `getAllAsync()` across entire histories. SQLCipher is optional and requires native configuration/rebuilding; adopting SQLite alone does not encrypt local data. Device-side cache ownership and cleanup should follow host/session removal and existing privacy expectations. See [Expo SQLite SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/).

For daemon/desktop, validate the actual bundled Node version before choosing the SQLite binding. A synchronous binding on the UI or daemon event loop can still cause stalls; put database work behind an asynchronous owner/worker boundary. The desktop renderer should consume paged IPC, not gain filesystem access. See [Node SQLite documentation](https://nodejs.org/api/sqlite.html).

### 4. Migrate with active-session continuity

- Version the storage format in the owner manifest. New sessions can use SQLite; active legacy owners continue running their existing code and JSON storage until they naturally finish.
- Keep dual readers during migration. Stream terminal/finished legacy sessions into a temporary database, verify sequence continuity, record counts and body hashes, then atomically mark the new storage as ready. Interrupted import must resume safely or restart without altering the source.
- Preserve session IDs, pending approvals/questions, queues and adapter checkpoints. Do not replay queued prompts, restart detached owners, or force-migrate them during a desktop upgrade.
- Keep legacy files for rollback until data validation and recovery tests pass. Cleanup should be a separate explicit retention policy.

## Acceptance evidence still needed

Use synthetic fixtures for one large prompt, many small messages, many large tool results, Unicode, long unbroken lines, reconnect and interrupted recovery. Include cursor gaps, an oversized single event, pending permissions, cancelled sends, and draft saves during background/foreground transitions.

Measure cold-open and next-page p50/p95, event-loop stalls, peak JS heap and native RSS, and retained memory after leaving the session. At a fixed page/window size, increasing total history from 10 MiB to 100 MiB should not make initial-load memory scale with total history. Verify complete body hashes before/after transport and migration. Existing active owner PIDs/epochs and session IDs must survive the desktop restart.

Run final UI memory measurements on the actual iPhone using Hermes/native instrumentation. The Node codec regression and RN-web layout checks cannot stand in for that measurement. If the reported OOM is inside the underlying coding agent's model context handling, Prospero's history database does not by itself solve that separate problem.

Status: codec allocation fix implemented; SQLite, paged history, body references, draft coalescing, and device memory profiling remain proposed follow-up work.
