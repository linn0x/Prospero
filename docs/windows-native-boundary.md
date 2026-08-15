# Windows N-API native boundary

`@prospero/windows-native` is a prebuilt Node-API C ABI boundary for Windows x64 and arm64. It is intentionally separate from the daemon and does **not** enable production Windows durable sessions. A higher layer must keep that feature disabled until this package loads successfully and its individual operations have production implementations.

## Contract and source ownership

The only JavaScript/TypeScript contract is `packages/windows-native/src/contract.ts`; the only native contract is `packages/windows-native/native/include/prospero_windows_native.h`. Both have ABI version 2 and target Node-API 8. A FILETIME crosses the JS boundary as an unsigned decimal string, paired with its PID, so callers never identify a reused PID alone. `getProcessIdentity(pid)` obtains both values, and `matchesProcessIdentity()` must reopen the PID and compare the FILETIME exactly before a process-sensitive action.

The native work is intentionally split into independently editable units:

- identity/IPC slice: `native/src/process_identity.cc` and `native/src/secure_named_pipe.cc`;
- process/terminal slice: `native/src/job_object.cc`, `native/src/detached_host.cc`, and `native/src/conpty.cc`.

`native/src/addon.cc` is a thin stable Node-API C bridge. Changes to exported names, JavaScript option shapes, or C ABI structs require an ABI version change and joint review; the slices above can otherwise advance in parallel.

The secure pipe API accepts an explicit self-relative security descriptor and permitted SID. An implementation must reject null/empty descriptors, use `PIPE_REJECT_REMOTE_CLIENTS`, derive peer identity from the accepted client connection's token plus PID/FILETIME, and must not use a default DACL. A server handle is not a connection: `acceptSecureNamedPipeConnection()` produces a distinct connection handle with read, write, peer-identity, disconnect, and close operations.

The DPAPI API exposes only current-user `CryptProtectData`/`CryptUnprotectData` (never machine scope). State persistence is a separate capability: opening a state directory must walk it handle-by-handle with `FILE_FLAG_OPEN_REPARSE_POINT`, reject every reparse point, and apply/verify an explicit current-user-only DACL. Manifest and journal recovery use `readSecureStateFile()` plus `listSecureStateEntries()`, and acknowledged cleanup uses `removeSecureStateFile()`. Read, write, and delete accept only one non-empty relative filename segment: dot segments, separators, NTFS ADS colons, reserved DOS device names, and any reparse traversal are rejected. Atomic writes are restricted to that same validated directory: the temporary file is created there, flushed, reparse-checked, and write-through replaced without re-resolving an attacker-controlled path.

Process-tree termination must use Job Object semantics; `taskkill` is not an acceptable replacement. `getParentJobCompatibility()` checks whether the parent Job permits breakaway. Detached launch is specified around `CreateProcessW`, never a command shell, and returns `parent_job_prevents_detach` rather than claiming a child is detached when the enclosing Job prevents it.

All APIs except `getAbiInfo()` are synchronous and can block. The loader's trusted wrapper rejects them on Node's main thread; callers must use a scheduler-owned dedicated worker thread.

## Prebuild release format

Release artifacts live at:

```
prebuilds/win32-x64/prospero_windows_native.node
prebuilds/win32-x64/manifest.json
prebuilds/win32-arm64/prospero_windows_native.node
prebuilds/win32-arm64/manifest.json
```

Each `manifest.json` has schema version 2 and this shape:

```json
{
  "schemaVersion": 2,
  "platform": "win32",
  "arch": "x64",
  "artifact": {
    "file": "prospero_windows_native.node",
    "sha256": "64 lowercase-or-uppercase hexadecimal characters"
  },
  "native": {
    "abiVersion": 2,
    "napiVersion": 8,
    "capabilities": {
      "processIdentity": true,
      "secureNamedPipe": true,
      "jobObject": true,
      "parentJobCompatibility": true,
      "detachedHost": true,
      "conPty": true,
      "dpapiCurrentUser": true,
      "secureStateDirectory": true
    }
  },
  "authenticode": {
    "status": "valid",
    "thumbprintSha1": "40 hexadecimal characters"
  }
}
```

The committed manifests are deliberately unsigned placeholders: all capabilities are false and their checksum is zero. They cannot load. A release job must build with `node-gyp`, Authenticode-sign the exact `.node`, calculate its SHA-256, replace the metadata, and run `npm run verify:prebuilds`. The loader validates platform, x64/arm64 selection, host Node-API level, manifest shape, bytes hash, Authenticode status and signer thumbprint before `require()` loads the binary. Its default verifier invokes only the inbox PowerShell below a validated absolute `SystemRoot` path, never a `powershell.exe` discovered through `PATH`; a missing or failed verifier is rejected. It then requires the addon’s unsigned ABI self-description to agree and to have every required capability, and wraps it in a frozen trusted binding where `signatureVerified: true` is generated by the loader. Addons have no `signatureVerified` field and cannot self-attest. Any error, missing binary, untrusted signer, ABI mismatch, or partial capability set throws `NativeLoadError`; there is no JS, source-build, or partial-feature fallback.

The signer data in a manifest is adjacent release metadata, not an independent trust root: it is accepted only after the binary hash and live Authenticode verification agree. Before a production release, maintainers must pin a signer-policy allowlist (including rotation procedure) in the release workflow and enforce npm package integrity and provenance for the published tarball. Do not treat a repository manifest thumbprint by itself as authorization to load an artifact.

`npm run build:native` and `npm run test:native` explicitly fail outside Windows. The regular TypeScript test suite uses injected mock loader runtimes, so it can verify this policy on macOS and Linux without loading a Windows binary.
