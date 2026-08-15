# Windows N-API native boundary

`@prospero/windows-native` is a prebuilt Node-API C ABI boundary for Windows x64 and arm64. It is intentionally separate from the daemon and does **not** enable production Windows durable sessions. A higher layer must keep that feature disabled until this package loads successfully and its individual operations have production implementations.

## Contract and source ownership

The only JavaScript/TypeScript contract is `packages/windows-native/src/contract.ts`; the only native contract is `packages/windows-native/native/include/prospero_windows_native.h`. Both have ABI version 1 and target Node-API 8. A FILETIME crosses the JS boundary as an unsigned decimal string, paired with its PID, so callers never identify a reused PID alone.

The native work is intentionally split into independently editable units:

- identity/IPC slice: `native/src/process_identity.cc` and `native/src/secure_named_pipe.cc`;
- process/terminal slice: `native/src/job_object.cc`, `native/src/detached_host.cc`, and `native/src/conpty.cc`.

`native/src/addon.cc` is a thin stable Node-API C bridge. Changes to exported names, JavaScript option shapes, or C ABI structs require an ABI version change and joint review; the slices above can otherwise advance in parallel.

The secure pipe API accepts an explicit self-relative security descriptor and permitted SID. An implementation must reject null/empty descriptors, derive peer identity from the client token plus PID/FILETIME, and must not use a default DACL. Process-tree termination must use Job Object semantics; `taskkill` is not an acceptable replacement. Detached launch is specified around `CreateProcessW`, never a command shell.

## Prebuild release format

Release artifacts live at:

```
prebuilds/win32-x64/prospero_windows_native.node
prebuilds/win32-x64/manifest.json
prebuilds/win32-arm64/prospero_windows_native.node
prebuilds/win32-arm64/manifest.json
```

Each `manifest.json` has schema version 1 and this shape:

```json
{
  "schemaVersion": 1,
  "platform": "win32",
  "arch": "x64",
  "artifact": {
    "file": "prospero_windows_native.node",
    "sha256": "64 lowercase-or-uppercase hexadecimal characters"
  },
  "native": {
    "abiVersion": 1,
    "napiVersion": 8,
    "capabilities": {
      "processIdentity": true,
      "secureNamedPipe": true,
      "jobObject": true,
      "detachedHost": true,
      "conPty": true
    }
  },
  "authenticode": {
    "status": "valid",
    "thumbprintSha1": "40 hexadecimal characters"
  }
}
```

The committed manifests are deliberately unsigned placeholders: all capabilities are false and their checksum is zero. They cannot load. A release job must build with `node-gyp`, Authenticode-sign the exact `.node`, calculate its SHA-256, replace the metadata, and run `npm run verify:prebuilds`. The loader validates platform, x64/arm64 selection, host Node-API level, manifest shape, bytes hash, Authenticode status and signer thumbprint before `require()` loads the binary. It then requires the addon’s self-report to agree and to have every required capability. Any error, missing binary, untrusted signer, ABI mismatch, or partial capability set throws `NativeLoadError`; there is no JS, source-build, or partial-feature fallback.

`npm run build:native` and `npm run test:native` explicitly fail outside Windows. The regular TypeScript test suite uses injected mock loader runtimes, so it can verify this policy on macOS and Linux without loading a Windows binary.
