# Terminal stream known issues

## Open: history gap with no recovery snapshot

- Recorded: 2026-09-28.
- Status: confirmed in the installed build from `aaca249`; not fixed.
- Priority: high — terminal recovery and additional viewers can be blocked.

### Evidence

A real, newly created Codex PTY session was running through `terminal.stream.v1`.
The existing desktop displayed output and held the control lease. A separate
observer attached with `wantControl: false`, without input, resizing or takeover,
and received:

```json
{"code":"history_gap","message":"The retained output cannot reconstruct this terminal","recoverable":false}
```

The snapshot endpoint returned HTTP 200 with `null`. The output endpoint reported
`latestSeq: 3849`, `floorSeq: 3337`, `resyncRequired: true` for cursor zero, and
`exited: false`. The daemon was healthy with database queue depth zero.

### Impact and diagnosis limits

The existing renderer can continue using output it already holds. A fresh viewer
cannot reconstruct the screen from a retained suffix without a usable snapshot.
Reloading the renderer, reopening the desktop, adding another device, or resuming
from a cursor older than retained history may therefore fail. This does not
establish a PTY crash or loss of project files.

The exact reason the snapshot became unavailable is not established. Do not
attribute it to a particular avt limitation without reproduction. Rejecting
incomplete replay is intentional; the missing reliable recovery path is the
defect. Increasing retention alone only delays the same failure.

### Follow-up and acceptance criteria

1. Expose and reproduce why snapshot generation returns `None`, using real Codex
   TUI output, dimensions and resize history.
2. Ensure a valid recovery base and contiguous subsequent output remain available
   when history is pruned, without silently inventing partial state.
3. Cover long output, pruning, fresh observers, desktop reload and reconnect;
   compare restored screens and subsequent terminal behavior.
4. Preserve controller ownership and PTY dimensions during observer recovery;
   never replay input whose outcome is unknown.

Until fixed, keep an already working viewer open where practical. This is a
temporary precaution, not a recovery solution.
