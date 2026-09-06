# iOS native navigation and responsiveness verification — 2026-09-06

## Confirmed native failures and fixes

- Opening host details crashed the Release app with `Couldn't find a navigation object`. `HostScreen` imported `useIsFocused` from an external React Navigation package. It now uses `expo-router`, and mobile lint rejects external `@react-navigation/*` imports. Expo 57 vendors navigation: see [the migration guidance](https://docs.expo.dev/router/migrate/sdk-55-to-56/) and [Router API](https://docs.expo.dev/versions/v57.0.0/sdk/router/).
- A long live chat could open or jump to an old position because `scrollToEnd` depended on estimated heights of unrendered Markdown rows. The display projection is now reversed in an inverted FlatList, so the latest edge is offset zero. Chronological model, folding, retry and search inputs remain unchanged.
- Follow state now distinguishes user drags from programmatic movement. Native drag testing held the visible history marker at sequence 19936 while new events arrived. Tapping “查看新内容” reached sequence 20784 and continued following through 20936, with the working indicator visible.

## Work reduced

- Host lists virtualize individual top-level session rows instead of mounting every session in an expanded project as one cell. Project collapse and contextual actions are preserved; nested goal/subagent rows remain inside their parent.
- Recent-session activity updates publish at most once per 250 ms window; opening a session remains immediate. A synthetic 122-session / 3,000-update replay reduced notifications from 3,000 to 231. This is a store benchmark, not a device latency measurement.
- iOS does not mount the Android progress notification subscription tree. Android approval-history subscriptions only run when the background overlay needs them and are deduplicated.
- Chat and terminal listeners stop on route blur or app inactivity. Pending chat deltas flush before releasing the cursor; terminal output flushes before pausing. Subagent history polling and terminal metrics also stop while inactive. This does not add a server-side detach protocol.
- Session queue display text is capped at 1,000 UTF-16 code units, with an explicit summary marker and surrogate-safe truncation. Durable queue contents, SQLite history, and actual agent input retain the complete prompt. A synthetic 4 MiB queued prompt produced a 1,303-byte display state frame. Existing live queues were small, so this is preventive hardening, not the confirmed cause of this incident.

## Validation and delivery

- Native Release app, iPhone 17 Pro Simulator, iOS 26.5. An isolated daemon exercised 122 sessions, 12 projects and two streams at 100 ms intervals through the real encrypted protocol, without model or CLI calls.
- Verified native home/project session entry, host details entry, long-history latest positioning, history drag stability, return-to-latest follow, file navigation and back navigation. Existing real-daemon PTY and structured history were opened read-only.
- Mobile: 58 test files / 430 tests passed, TypeScript and scoped lint passed. Daemon queue, control-session view, message queue, SQLite and capability regression checks passed. Desktop typecheck/build and existing UI tests passed.
- Phone: installed and launched `com.linn0x.prospero.remote2`, version 0.0.20, build 20. The final signed phone app uses the same Release Hermes bundle verified in Simulator: SHA-256 `598f4bd539a4b2dd8aaa3c0213fb056c5fc623f51e6ca3a5d012bb3659391494`. Existing application identifier and keychain entitlements are preserved.
- Desktop: signed package installed and launched after a rollback backup. Verified all 123 existing session IDs, 27 live supervisor owners and their epochs, two PTY owners, orchestration run states and host identity survived restart. New daemon build and health checks passed.

Simulator interaction and automated tests establish the paths above. They do not establish a universal frame-rate improvement or complete physical-device responsiveness; the installed phone build is ready for direct user inspection.
