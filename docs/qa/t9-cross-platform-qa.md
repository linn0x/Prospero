# T9 cross-platform QA matrix

Date: 2026-08-14.  Baseline: `7042994e844d5269ee42d3f78ce40c3c7d20daf3` (the T6 integration result).
All commands below ran in the isolated `worker-task_c346dc0fb1b2-mssqtdum` worktree.  No pairing credential, relay ticket, or secret is included in this record.

## Environment and native smoke

| Surface | Version / isolated target | Result | Evidence |
| --- | --- | --- | --- |
| iOS simulator | macOS 26.5.2; Xcode 26.6 (17F113); iOS 26.5; temporary `Prospero T9 iPhone 17` | Debug and Release simulator builds passed.  Release app installed, cold-launched, terminated and relaunched; the empty-host view and the labelled QR-pairing entry were visually checked. | `/tmp/prospero-t9-ios-release-home.png`; iOS result bundles under `/tmp/prospero-t9-ios-build.*/debug.xcresult` and `release.xcresult` |
| Android emulator | Android SDK 36.0.0; Emulator 36.6.11; API 35 Google APIs arm64 temporary `Prospero_T9_API_35` | Debug/Release APK builds and `apksigner verify` passed.  Release APK (`com.linn0x.prospero` 0.0.12) installed and cold-started in 1.859 s.  Home/background/hot-return kept PID `6209`; Wi-Fi and cellular disable/enable kept the process alive; crash log was empty. | `/tmp/prospero-t9-android-release-home.png`; APKs under `apps/mobile/android/app/build/outputs/apk/{debug,release}/` |
| macOS Shell | Swift 6.3.3; Xcode 26.6 | `swift test` passed 8 relay-settings tests; Debug and Release `ProsperoShell` builds passed.  Static UI review confirms accessible relay controls; tests verify public-only CLI commands and redaction. | `apps/shell/Tests/ProsperoShellTests/RelaySettingsTests.swift` |

The temporary simulator and AVD were shut down and deleted after capture.  `adb devices -l` was empty and `simctl list devices` no longer contained the created UDID.  The pre-existing `FundWatch_API_35` AVD was not opened or changed.

## Functional matrix

| Journey / contract | Result and reproducible coverage |
| --- | --- |
| Legacy direct QR and older daemon | Pass: protocol QR compatibility tests accept the legacy-v7 no-relay shape; mobile defaults a no-relay pairing to `direct`; Shell parses a status with missing relay fields. |
| New QR, mode persistence and switching | Pass: a relay QR defaults to `auto`, while explicit direct/relay/auto mode remains user-selected through re-pairing.  Host storage tests cover atomic writes and rollback. |
| Direct, relay, auto and relay-only | Pass: candidate tests verify all direct addresses, relay-only emits no LAN candidate, auto starts both classes together, and a missing relay ticket does not silently turn relay-only into direct. |
| First complete E2E `hello.ok` wins / path | Pass: race tests close all losers only after the first E2E success; the real-process test races direct and relay, asserts a `hello.ok` winner, and verifies opaque E2E frames on every path.  `HostSummary` maps the winning `activePath` to `直连` or `中继`; this display mapping was source-reviewed (a paired native screen remains a residual risk). |
| Pair, re-pair, delete and revoke | Pass: secure-store migration, deletion, relay re-pair rollback and direct-only protection are covered in mobile tests; protocol/relay tests cover credential replacement and revocation. |
| Background/foreground and network recovery | Pass for Android process smoke as above; mobile liveness tests run in the suite.  The temporary devices had no safe live pairing, so recovery of an active native session is a residual risk. |
| Relay diagnostics | Pass: mobile diagnosis tests cover offline, auth, rate-limit, overload, version, TLS, revoked device, and daemon identity mismatch with actionable messages.  Relay unit tests exercise rate limiting and revoked credentials. |
| Daemon relay operations | Pass: daemon relay tests cover enable/disable, URL override before deployment default, rotate-key, restart generations, and no direct-daemon restart on config change.  The deployment default is injected through `PROSPERO_DEFAULT_RELAY_URL`. |
| Production URL policy | Pass: protocol, daemon and Shell tests reject non-loopback `ws://`; loopback `ws://` requires explicit development mode.  Release build retains the production default relay URL path. |
| Shell accessibility and secrets | Pass: `RelaySettingsTests` checks the public relay CLI action shapes and that redaction removes host secret, device token, relay credential and generic secret values.  `Dashboard.swift` gives relay controls names/hints instead of rendering credentials. |

## Commands run

```sh
npm test --workspace @prospero/mobile                 # 32 files, 201 tests passed
npx tsc --noEmit -p apps/mobile/tsconfig.json
npm run lint --workspace @prospero/mobile
npm test --workspace @prospero/protocol               # 6 files, 53 tests passed
npm test --workspace @prospero/daemon -- relay.test.ts # 17 tests passed
npm test --workspace @prospero/relay                  # 23 passed, 2 integration-gated skipped
npm run test:e2e --workspace @prospero/relay           # real process: 1 passed, 15.28 s

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --scratch-path /tmp/prospero-t9-swift
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift build -c debug --product ProsperoShell --scratch-path /tmp/prospero-t9-swift-debug
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift build -c release --product ProsperoShell --scratch-path /tmp/prospero-t9-swift-release
```

Native build commands were also run directly with the installed SDK/Xcode, `CODE_SIGNING_ALLOWED=NO` for the simulator, and `apksigner verify` for both Android APKs.  The iOS build initially found stale generated CocoaPods header symlinks pointing at a different checkout and reported duplicate Expo interfaces.  Running the existing clean Expo prebuild (`EXPO_NO_GIT_STATUS=1 npx expo prebuild -p ios --clean`) regenerated only ignored local iOS artifacts; both configurations then passed.  This was a generated-workspace repair, not a tracked source change.

## Remaining risk

* No physical iOS or Android device was connected or used; these are simulator/emulator results only.
* No safe live QR credential was supplied to a native app, so camera permission, a physical-device network handoff, and native active-session reconnect were not asserted end to end.  Real-process relay E2E and the mobile suites cover the protocol behaviour separately.
* iOS simulator smoke covered launch/relaunch and visual UI, not a simulator-driven Wi-Fi/cellular toggle.  Production TLS was policy-tested, not exercised against an external production certificate.
