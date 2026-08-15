/**
 * Platform boundary for detached structured supervisors.
 *
 * The durable supervisor protocol currently depends on a Unix-domain socket
 * protected by its owner-only directory and file modes.  Do not substitute a
 * default Windows DACL, a random named pipe, a capability token, or a PID for
 * that native boundary: Windows stays explicitly disabled until an equivalent
 * Win32 boundary is deliberately selected and implemented.
 */

export type StructuredSupervisorTransport = "unix_socket";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

export function structuredSupervisorPlatformGate(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32") return null;
  return "Windows structured supervisor is disabled: a native Win32 security boundary has not been selected and implemented";
}

/** Returns the transport only after the platform has passed its security gate. */
export function structuredSupervisorTransport(
  platform: NodeJS.Platform = process.platform,
): StructuredSupervisorTransport | null {
  return structuredSupervisorPlatformGate(platform) ? null : "unix_socket";
}

export function isStructuredSupervisorEndpoint(
  value: string,
  transport: StructuredSupervisorTransport,
): boolean {
  return transport === "unix_socket" && value.length > 0 && !value.startsWith(WINDOWS_PIPE_PREFIX);
}

export function hasPrivateSupervisorFileMode(mode: number): boolean {
  return (mode & 0o777) === 0o600;
}

export function hasPrivateSupervisorDirectoryMode(mode: number): boolean {
  return (mode & 0o777) === 0o700;
}

const UNIX_RUNNER_ENV = [
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER", "TERM", "COLORTERM",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "SSH_AUTH_SOCK",
] as const;

/**
 * The runner must not inherit ambient credentials. These runtime variables
 * are sufficient for Unix-native children; account/session values travel in
 * the protected bootstrap file and are applied by StructuredSession.
 */
export function structuredSupervisorRunnerEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    PATH: source["PATH"] ?? "",
    HOME: source["HOME"] ?? "",
    TMPDIR: source["TMPDIR"] ?? "/tmp",
    LANG: source["LANG"] ?? "en_US.UTF-8",
    LC_ALL: source["LC_ALL"] ?? "",
    SHELL: source["SHELL"] ?? "/bin/sh",
    USER: source["USER"] ?? "",
    TERM: source["TERM"] ?? "xterm-256color",
    COLORTERM: source["COLORTERM"] ?? "truecolor",
    ...Object.fromEntries(
      UNIX_RUNNER_ENV.slice(9)
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, source[key]!]),
    ),
  };
}
