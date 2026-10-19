# Prospero Progress

Historical record for commit `6115e3a`; repository, deployment, and schema status below are not a statement of the current environment.

## Historical Checkpoint

- Repository: `.`
- Primary branch: `master`
- Recorded commit: `6115e3a feat(agent): manage cross-model child sessions`
- Remote state at the checkpoint: `origin/master` is aligned with local `master`
- Local app: `/Applications/Prospero.app`
- Runtime backend: Rust daemon
- Daemon database schema at the checkpoint: `29`
- Deployment status at the checkpoint: deployed locally and health checked after the schema 29 migration

## Operating Rule

- Treat `.` on `master` as the primary local working tree.
- Keep `../Prospero-rust-re` only as the old `exp/rust-re` worktree/reference unless explicitly needed.
- Future Prospero Rust + TS desktop changes should land on `master`.
- Do not leave new Prospero work only on `exp/rust-re`.

## Work Completed at This Checkpoint

- Hardened Rust daemon cleanup for Codex `app-server` processes and isolated `CODEX_HOME` state:
  - daemon-owned app-server process groups are terminated on close/startup failure/shutdown
  - stale app-server leases are swept during daemon recovery
  - stale current-thread writer locks are removed only for owned or stale-recovered Codex threads
  - cleanup state stays under daemon-controlled isolated Codex homes and rejects symlinked state directories
- Promoted the Rust + TS desktop line into `master`.
- Synchronized `.` to `6115e3a`.
- Built and deployed a fresh local `/Applications/Prospero.app`.
- Confirmed daemon health:
  - `backend=rust`
  - database alive
  - database queue depth `0`
  - relay online
- Migrated local daemon database to schema `29`.

## Cross-Model Child Agent Capabilities

Cross-model child management commands recorded as implemented and deployed at this checkpoint:

- `prospero child list`
- `prospero child get`
- `prospero child logs`
- `prospero child result`
- `prospero child message`
- `prospero child cancel`
- `prospero child redeliver`
- `prospero child ack`
- `prospero child check`

Behavior recorded at this checkpoint:

- Cross-model children are independent structured sessions bound to model source routes.
- Children run YOLO/auto-approved.
- Completed children fan in incrementally.
- A final fan-in marks all requested children complete.
- Completed children can be reused through `follow-up`.
- Running children can receive live guidance through `message`.
- Running children can be stopped through `cancel`.
- Missed or unprocessed results can be found with `list --pending-result`, re-delivered with `redeliver`, and marked handled with `ack`.
- `result` returns full final answer text plus turn-end diffs.
- `logs` returns the child session timeline events.

## Verification Recorded at This Checkpoint

- `cargo test -p prosperod-rs --test agent_runtime codex_close_kills_app_server_group_and_cleans_thread_lock`
- `cargo test -p prosperod-rs --test agent_runtime recovery_kills_stale_codex_app_server_lease_and_thread_lock`
- `cargo test -p prosperod-rs --test agent_runtime codex_structured_turn_streams_into_timeline`
- `cargo test -p prosperod-rs agent::codex::tests::owned_codex_home`
- `cargo check -p prosperod-rs`
- `cargo fmt`
- `git diff --check`
- `cargo check --locked -p prosperod-rs`
- `cargo test --locked -p prosperod-rs agent::store::tests --lib`
- `cargo test --locked -p prosperod-rs child_cli_help_exposes_management_commands --test cli`
- `cargo test --locked -p prosperod-rs cross_model_child_management_routes_expose_empty_lists --test orchestration_http`
- `cargo test --locked -p prosperod-rs model_contract_exposes_completed_child_follow_up --lib`
- `npm run rust:types`
- `npm run typecheck -w @prospero/desktop`
- `git diff --check`
- packaged Rust desktop smoke test passed before local replacement

## Follow-Ups Listed at This Checkpoint

- Add frontend controls on cross-model child cards:
  - open child details
  - send live guidance
  - cancel child
  - redeliver result
  - ack processed result
- Add continuous child checks:
  - repeat every N minutes
  - stop automatically when all children are terminal
  - only wake the parent on state change, failure, or suspected stalling
- Add richer dispatch context:
  - selected parent messages
  - files and attachments
  - explicit acceptance criteria
  - optional parent session summary
- Add source preflight and resource controls:
  - recent validation state
  - tool support
  - route availability
  - source-level concurrency limits
  - fallback source policy

## Deployment Notes

- `npm run dist:mac -w @prospero/desktop` at this checkpoint produced the local arm64 app but failed at the later x64 packaging stage unless an x64 `prosperod-rs` release binary exists.
- This is expected for local arm64 deployment. Use:
  - `dist/desktop/mac-arm64/Prospero.app`
  - replace `/Applications/Prospero.app`
  - restart the app
  - verify `/v1/health`
  - verify SQLite `PRAGMA user_version`
