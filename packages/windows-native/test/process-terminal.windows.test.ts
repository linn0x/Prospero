import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const addonPath = resolve(process.cwd(), "build", "Release", "prospero_windows_native.node");

type NativeProcessTerminalBinding = {
  getAbiInfo(): { capabilities: Record<string, boolean> };
  getParentJobCompatibility(): {
    parentJobDetected: boolean;
    breakawayAllowed: boolean;
    detachedLaunchAllowed: boolean;
  };
  createJobObject(options: { killOnClose: boolean; activeProcessLimit?: number }): bigint;
  assignProcessToJob(job: bigint, process: { pid: number; creationTime100ns: string }): void;
  isProcessInJob(job: bigint, process: { pid: number; creationTime100ns: string }): boolean;
  closeJobObject(job: bigint): void;
  terminateProcessIfIdentity(identity: { pid: number; creationTime100ns: string }, exitCode: number, timeoutMs: number): boolean;
  launchDetachedHost(options: {
    executablePath: string;
    arguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
    job?: bigint;
  }):
    | { status: "launched"; process: { pid: number; creationTime100ns: string } }
    | {
        status: "parent_job_prevents_detach";
        parentJob: { parentJobDetected: boolean; detachedLaunchAllowed: boolean };
      };
  spawnConPty(options: {
    executablePath: string;
    arguments: string[];
    columns: number;
    rows: number;
    environment?: Record<string, string>;
    job?: bigint;
  }): bigint;
  resizeConPty(terminal: bigint, columns: number, rows: number): void;
  readConPty(terminal: bigint, maxBytes: number): Uint8Array;
  writeConPty(terminal: bigint, data: Uint8Array): number;
  killConPty(terminal: bigint, exitCode: number): void;
  closeConPty(terminal: bigint): void;
};

const native = process.platform === "win32"
  ? require(addonPath) as NativeProcessTerminalBinding
  : undefined as unknown as NativeProcessTerminalBinding;
const uncheckedNative = native as unknown as {
  createJobObject(options: unknown): bigint;
  assignProcessToJob(job: bigint, process: unknown): void;
  isProcessInJob(job: bigint, process: unknown): boolean;
  spawnConPty(options: unknown): bigint;
};
const encoder = new TextEncoder();
const describeWindows = process.platform === "win32" ? describe : describe.skip;
// writeConPty is the raw ConPTY terminal-byte boundary. Windows terminal
// Enter is CR; the default cooked console read below then reports that line to
// the provider as CRLF. Any product-facing cross-platform input facade must
// select the platform terminal byte before it reaches this native API.
const WINDOWS_TERMINAL_ENTER = "\r";

function providerDataCallbackMarker(data: string): string {
  // JSON preserves CR and LF visibly in the terminal output. A marker emitted
  // from the provider's data callback cannot be confused with ConPTY's local
  // echo of input bytes.
  return `PROVIDER_DATA:${JSON.stringify(data)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function drainUntil(terminal: bigint, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for (let attempt = 0; attempt < 100; ++attempt) {
    output += decoder.decode(native.readConPty(terminal, 16 * 1024), { stream: true });
    if (output.includes(marker)) return output;
    await delay(50);
  }
  return output + decoder.decode();
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; ++attempt) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`process ${pid} still exists after Job termination`);
}

async function isProcessInAnyJob(pid: number): Promise<boolean> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("SystemRoot is required for the Windows Job smoke check");
  const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$signature = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class ProsperoJobProbe {",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $signature -ErrorAction Stop",
    `$processHandle = [ProsperoJobProbe]::OpenProcess(0x1000, $false, ${pid})`,
    "if ($processHandle -eq [IntPtr]::Zero) { throw 'OpenProcess failed' }",
    "$inJob = $false",
    "try {",
    "  if (-not [ProsperoJobProbe]::IsProcessInJob($processHandle, [IntPtr]::Zero, [ref]$inJob)) { throw 'IsProcessInJob failed' }",
    "  if ($inJob) { Write-Output 'true' } else { Write-Output 'false' }",
    "} finally {",
    "  [void][ProsperoJobProbe]::CloseHandle($processHandle)",
    "}",
  ].join("\n");
  const { stdout } = await execFileAsync(powerShell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  const result = stdout.trim();
  if (result !== "true" && result !== "false") {
    throw new Error(`unexpected IsProcessInJob result: ${result}`);
  }
  return result === "true";
}

describeWindows.sequential("Windows N-API Job Object, detached host, and ConPTY smoke", () => {
  it("reports the merged native surface and rejects forged handles", () => {
    const report = native.getAbiInfo();
    expect(report.capabilities).toMatchObject({
      jobObject: true,
      parentJobCompatibility: true,
      detachedHost: true,
      conPty: true,
      processIdentity: true,
      secureNamedPipe: true,
      dpapiCurrentUser: true,
      secureStateDirectory: true,
    });
    expect(() => native.closeJobObject(987654321n)).toThrow(/unknown or closed/i);

    const parent = native.getParentJobCompatibility();
    expect(typeof parent.parentJobDetected).toBe("boolean");
    expect(typeof parent.detachedLaunchAllowed).toBe("boolean");

    const job = native.createJobObject({ killOnClose: true });
    try {
      // Windows returns ERROR_INVALID_PARAMETER for this nonzero nonexistent
      // PID. The Job boundary must report the recoverable stale-PID outcome,
      // not an opaque system error.
      expect(() => native.assignProcessToJob(job, {
        pid: 0x7fff_fffe,
        creationTime100ns: "1",
      })).toThrow(/not found/i);
      expect(() => native.isProcessInJob(job, {
        pid: 0x7fff_fffe,
        creationTime100ns: "1",
      })).toThrow(/not found/i);
    } finally {
      native.closeJobObject(job);
    }
    expect(() => native.closeJobObject(job)).toThrow(/unknown or closed/i);
  });

  it("never rolls back a detached host by PID alone", async () => {
    expect(native.terminateProcessIfIdentity({
      pid: 0x7fff_fffe,
      creationTime100ns: "1",
    }, 1, 100)).toBe(false);

    const launch = native.launchDetachedHost({
      executablePath: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
    });
    if (launch.status === "parent_job_prevents_detach") {
      expect(launch.parentJob.detachedLaunchAllowed).toBe(false);
      return;
    }
    expect(native.terminateProcessIfIdentity(launch.process, 0xC000013A, 5_000)).toBe(true);
    await waitForExit(launch.process.pid);
    // The same numeric PID with a different creation FILETIME is never a
    // target, including after the original host has exited.
    expect(native.terminateProcessIfIdentity({
      ...launch.process,
      creationTime100ns: "1",
    }, 1, 100)).toBe(false);
  });

  it("fails closed for missing or mistyped N-API launch and identity properties", () => {
    const processLaunch = {
      executablePath: process.execPath,
      arguments: [],
      columns: 80,
      rows: 24,
    };

    // Omitted optional workingDirectory, environment, and job are exercised by
    // the successful ConPTY smoke below. These malformed variants must fail
    // while parsing JavaScript options, before any child process is created.
    expect(() => uncheckedNative.spawnConPty({
      executablePath: process.execPath,
      columns: 80,
      rows: 24,
    })).toThrow(/arguments array is missing/i);
    expect(() => uncheckedNative.spawnConPty({
      executablePath: process.execPath,
      arguments: [],
      rows: 24,
    })).toThrow(/require columns and rows/i);
    expect(() => uncheckedNative.spawnConPty({ ...processLaunch, columns: "80" }))
      .toThrow(/unsigned 32-bit integer/i);
    expect(() => uncheckedNative.spawnConPty({ ...processLaunch, arguments: [80] }))
      .toThrow(/expected a string/i);
    expect(() => uncheckedNative.spawnConPty({ ...processLaunch, workingDirectory: 42 }))
      .toThrow(/expected a string/i);
    expect(() => uncheckedNative.spawnConPty({ ...processLaunch, environment: "not-an-object" }))
      .toThrow(/environment must be an object/i);
    expect(() => uncheckedNative.spawnConPty({ ...processLaunch, job: 42 }))
      .toThrow(/opaque native bigint handle/i);
    expect(() => uncheckedNative.createJobObject({})).toThrow(/required boolean option is missing/i);
    expect(() => uncheckedNative.createJobObject({ killOnClose: true, activeProcessLimit: "1" }))
      .toThrow(/unsigned 32-bit integer/i);

    const job = native.createJobObject({ killOnClose: true });
    try {
      expect(() => uncheckedNative.assignProcessToJob(job, {}))
        .toThrow(/pid and creationTime100ns/i);
      expect(() => uncheckedNative.assignProcessToJob(job, {
        pid: "1",
        creationTime100ns: "1",
      })).toThrow(/unsigned 32-bit integer/i);
      expect(() => uncheckedNative.assignProcessToJob(job, {
        pid: 1,
        creationTime100ns: 1,
      })).toThrow(/expected a string/i);
    } finally {
      native.closeJobObject(job);
    }
  });

  it("keeps a launched detached host alive after its launcher exits when parent Job policy permits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prospero-native-host-"));
    const marker = join(directory, "host-survived.txt");
    const unicodeArgument = "参数 with spaces, quote \" and trailing slash\\";
    const hostSource = [
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv0: process.argv0, argv: process.argv }));`,
      "setTimeout(() => process.exit(0), 3000);",
    ].join(" ");
    const helperSource = [
      "const { createRequire } = require('node:module');",
      `const native = createRequire(${JSON.stringify(join(directory, "launcher.cjs"))})(${JSON.stringify(addonPath)});`,
      `const result = native.launchDetachedHost({ executablePath: process.execPath, arguments: ['-e', ${JSON.stringify(hostSource)}, ${JSON.stringify(unicodeArgument)}], workingDirectory: ${JSON.stringify(directory)} });`,
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n");
    try {
      const { stdout } = await execFileAsync(process.execPath, ["-e", helperSource], {
        windowsHide: true,
      });
      const result = JSON.parse(stdout) as ReturnType<NativeProcessTerminalBinding["launchDetachedHost"]>;
      if (result.status === "parent_job_prevents_detach") {
        expect(result.parentJob.parentJobDetected).toBe(true);
        expect(result.parentJob.detachedLaunchAllowed).toBe(false);
        return;
      }
      expect(result.process.pid).toBeGreaterThan(0);
      expect(result.process.creationTime100ns).toMatch(/^\d+$/);
      for (let attempt = 0; attempt < 60; ++attempt) {
        try {
          await access(marker);
          expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
            argv0: process.execPath,
            argv: [process.execPath, unicodeArgument],
          });
          // A successful response is valid only if the suspended child really
          // escaped every inherited Job before it was resumed.
          expect(await isProcessInAnyJob(result.process.pid)).toBe(false);
          return;
        } catch {
          await delay(50);
        }
      }
      throw new Error("detached host did not survive launcher exit long enough to write its marker");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("round-trips argv0 and Unicode arguments through ConPTY before terminal lifecycle work", async () => {
    // CI previously received ConPTY's VT/title stream but not the -e script
    // output; the capture-boundary case below shows why. Keep argv parsing
    // independent of resize, input, and Job-tree assertions so it identifies
    // a command-line regression once terminal stdio is correctly isolated.
    const multipleBackslashesBeforeOrdinaryCharacter = "multiple" + "\\".repeat(3) + "ordinary text";
    const emptyArgument = "";
    const backslashesBeforeQuote = "slashes before " + "\\".repeat(2) + "\"quote\" after";
    const trailingBackslashes = "trailing backslashes " + "\\".repeat(3);
    const unicodeArgument = "参数 with spaces, quote \" and trailing slash\\";
    const childSource = [
      "const payload = {",
      "  argv0: process.argv0,",
      "  argv: process.argv,",
      "  stdinIsTty: process.stdin.isTTY === true,",
      "  stdoutIsTty: process.stdout.isTTY === true,",
      "  stderrIsTty: process.stderr.isTTY === true,",
      "};",
      "process.stdout.write(`PROSPERO_ARGV_ROUND_TRIP:${JSON.stringify(payload)}\\n`);",
    ].join("\n");
    const terminal = native.spawnConPty({
      executablePath: process.execPath,
      arguments: [
        "-e",
        childSource,
        multipleBackslashesBeforeOrdinaryCharacter,
        emptyArgument,
        backslashesBeforeQuote,
        trailingBackslashes,
        unicodeArgument,
      ],
      columns: 80,
      rows: 24,
    });
    try {
      const output = await drainUntil(terminal, "PROSPERO_ARGV_ROUND_TRIP:");
      const match = output.match(/PROSPERO_ARGV_ROUND_TRIP:(.+)\r?\n/);
      expect(match).not.toBeNull();
      expect(JSON.parse(match?.[1] ?? "")).toEqual({
        argv0: process.execPath,
        argv: [
          process.execPath,
          multipleBackslashesBeforeOrdinaryCharacter,
          emptyArgument,
          backslashesBeforeQuote,
          trailingBackslashes,
          unicodeArgument,
        ],
        stdinIsTty: true,
        stdoutIsTty: true,
        stderrIsTty: true,
      });
    } finally {
      native.closeConPty(terminal);
    }
  });

  it("keeps ConPTY output in its drain when the parent stdout and stderr are redirected", async () => {
    // Run the native spawn inside an execFile child, whose stdout/stderr are
    // capture pipes. That reproduces the GitHub runner condition: before the
    // STARTF_USESTDHANDLES+NULL fix, these markers escaped into `stdout` and
    // `stderr`, while readConPty saw only conhost's VT/title sequences.
    const marker = "PROSPERO_CONPTY_CAPTURE_BOUNDARY";
    const childSource = [
      `process.stdout.write(${JSON.stringify(`${marker}:stdout\\n`)});`,
      `process.stderr.write(${JSON.stringify(`${marker}:stderr\\n`)});`,
    ].join("\n");
    const helperSource = [
      "const native = require(process.argv[1]);",
      `const marker = ${JSON.stringify(marker)};`,
      `const childSource = ${JSON.stringify(childSource)};`,
      "(async () => {",
      "  const terminal = native.spawnConPty({",
      "    executablePath: process.execPath,",
      "    arguments: ['-e', childSource],",
      "    columns: 80,",
      "    rows: 24,",
      "  });",
      "  const decoder = new TextDecoder();",
      "  let output = '';",
      "  try {",
      "    for (let attempt = 0; attempt < 100; ++attempt) {",
      "      output += decoder.decode(native.readConPty(terminal, 16 * 1024), { stream: true });",
      "      if (output.includes(`${marker}:stdout`) && output.includes(`${marker}:stderr`)) break;",
      "      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));",
      "    }",
      "    output += decoder.decode();",
      "  } finally {",
      "    native.closeConPty(terminal);",
      "  }",
      "  process.stdout.write(JSON.stringify({ output }) + '\\n');",
      "})().catch((error) => {",
      "  process.stderr.write(error.stack || String(error));",
      "  process.exitCode = 1;",
      "});",
    ].join("\n");
    const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", helperSource, addonPath], {
      windowsHide: true,
    });

    // The helper writes exactly one JSON line. A raw marker here would prove
    // that a child inherited its parent's capture pipes instead of ConPTY.
    const stdoutLines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
    expect(stdoutLines).toHaveLength(1);
    expect(stderr).toBe("");
    const result = JSON.parse(stdoutLines[0]) as { output: string };
    expect(result.output).toContain(`${marker}:stdout`);
    expect(result.output).toContain(`${marker}:stderr`);
  });

  it("delivers Windows Enter input to the provider, resizes, and Job-kills the provider tree", async () => {
    const providerSource = [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(`PIDS:${process.pid}:${grandchild.pid}\\n你好🙂\\n`);",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (data) => process.stdout.write(`PROVIDER_DATA:${JSON.stringify(data)}\\n`));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const terminal = native.spawnConPty({
      executablePath: process.execPath,
      arguments: ["-e", providerSource],
      columns: 80,
      rows: 24,
    });
    try {
      native.resizeConPty(terminal, 120, 40);
      let output = await drainUntil(terminal, "你好");
      expect(output).toContain("你好");
      const providerInput = `hello${WINDOWS_TERMINAL_ENTER}`;
      const providerCallback = providerDataCallbackMarker("hello\r\n");
      const written = native.writeConPty(terminal, encoder.encode(providerInput));
      expect(written).toBeGreaterThan(0);
      output += await drainUntil(terminal, providerCallback);
      expect(output).toContain(providerCallback);

      const match = output.match(/PIDS:(\d+):(\d+)/);
      expect(match).not.toBeNull();
      native.killConPty(terminal, 42);
      await waitForExit(Number(match?.[1]));
      await waitForExit(Number(match?.[2]));
    } finally {
      native.closeConPty(terminal);
    }
  });

  it("rolls back an invalid ConPTY launch without returning a terminal handle", () => {
    expect(() => native.spawnConPty({
      executablePath: "C:\\definitely-missing-prospero-native.exe",
      arguments: [],
      columns: 80,
      rows: 24,
    })).toThrow();
  });

  it("uses explicit Unicode environment blocks and safely probes an empty block", async () => {
    const inheritedProbe = "PROSPERO_NATIVE_ENV_INHERIT_PROBE";
    const priorValue = process.env[inheritedProbe];
    process.env[inheritedProbe] = "must-not-inherit";
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error("SystemRoot is required for the Windows environment smoke check");
    const terminal = native.spawnConPty({
      executablePath: process.execPath,
      arguments: ["-e", `process.stdout.write(process.env.${inheritedProbe} === undefined ? 'ISOLATED_ENV' : 'INHERITED_ENV')`],
      columns: 80,
      rows: 24,
      // Node 22's CSPRNG initialization needs Windows' system-directory
      // variables. Keep the production bootstrap minimal and explicit rather
      // than treating its initialization abort as an empty-block failure.
      environment: {
        SystemRoot: systemRoot,
        WINDIR: process.env.WINDIR ?? systemRoot,
      },
    });
    try {
      expect(await drainUntil(terminal, "ENV")).toContain("ISOLATED_ENV");
    } finally {
      native.closeConPty(terminal);
      if (priorValue === undefined) delete process.env[inheritedProbe];
      else process.env[inheritedProbe] = priorValue;
    }

    // The API still represents {} as an explicit double-NUL block. Use an
    // absolute system command processor rather than Node, whose empty
    // environment startup aborts before user code can observe the block.
    const emptyEnvironmentMarker = "PROSPERO_EMPTY_ENVIRONMENT_BLOCK";
    const commandProcessor = join(systemRoot, "System32", "cmd.exe");
    const emptyEnvironmentTerminal = native.spawnConPty({
      executablePath: commandProcessor,
      arguments: ["/d", "/s", "/c", `echo ${emptyEnvironmentMarker}`],
      columns: 80,
      rows: 24,
      environment: {},
    });
    try {
      expect(await drainUntil(emptyEnvironmentTerminal, emptyEnvironmentMarker))
        .toContain(emptyEnvironmentMarker);
    } finally {
      native.closeConPty(emptyEnvironmentTerminal);
    }

    expect(() => native.spawnConPty({
      executablePath: process.execPath,
      arguments: [],
      columns: 80,
      rows: 24,
      environment: { Path: "one", PATH: "two" },
    })).toThrow(/unique without regard to case/i);
    expect(() => native.spawnConPty({
      executablePath: process.execPath,
      arguments: [],
      columns: 80,
      rows: 24,
      environment: { PROSPERO_OVERSIZED: "x".repeat(32767) },
    })).toThrow(/CreateProcessW UTF-16 limit/i);
  });

  it("rolls back a post-launch Job assignment failure while the original terminal still reaches its provider", async () => {
    const job = native.createJobObject({ killOnClose: true, activeProcessLimit: 1 });
    const providerSource = [
      "process.stdout.write('READY\\n');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (data) => process.stdout.write(`PROVIDER_DATA:${JSON.stringify(data)}\\n`));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const first = native.spawnConPty({
      executablePath: process.execPath,
      arguments: ["-e", providerSource],
      columns: 80,
      rows: 24,
      job,
    });
    try {
      expect(await drainUntil(first, "READY")).toContain("READY");
      expect(() => native.spawnConPty({
        executablePath: process.execPath,
        arguments: ["-e", providerSource],
        columns: 80,
        rows: 24,
        job,
      })).toThrow();
      const providerInput = `still-alive${WINDOWS_TERMINAL_ENTER}`;
      const providerCallback = providerDataCallbackMarker("still-alive\r\n");
      expect(native.writeConPty(first, encoder.encode(providerInput))).toBeGreaterThan(0);
      expect(await drainUntil(first, providerCallback)).toContain(providerCallback);
    } finally {
      native.closeConPty(first);
      native.closeJobObject(job);
    }
  });
});
