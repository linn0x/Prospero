import type { HostInfo, SessionInfo } from "@prospero/protocol";

export const REMOTE_TERMINAL_UNAVAILABLE = "此设备尚未确认支持远程终端。";

export function supportsRemoteTerminal(host: Pick<HostInfo, "platform" | "capabilities"> | null | undefined): boolean {
  const platform = host?.platform?.trim().toLowerCase();
  return host?.capabilities?.includes("terminal.remote.v1") === true || ["macos", "darwin", "windows", "win32", "linux"].includes(platform ?? "");
}

export function isShellTerminal(session: SessionInfo | undefined): boolean {
  return session?.agent === "shell" && session.kind === "pty";
}

export function isTerminalEnded(session: Pick<SessionInfo, "status"> | undefined): boolean {
  return session?.status === "done" || session?.status === "died";
}
