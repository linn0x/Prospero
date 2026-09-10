import type { HostInfo, SessionInfo } from "@prospero/protocol";

export const MAC_TERMINAL_ONLY = "远程终端暂时只支持 macOS 设备。";

export function supportsMacTerminal(host: Pick<HostInfo, "platform"> | null | undefined): boolean {
  const platform = host?.platform?.trim().toLowerCase();
  return platform === "macos" || platform === "darwin";
}

export function isShellTerminal(session: SessionInfo | undefined): boolean {
  return session?.agent === "shell" && session.kind === "pty";
}

export function isTerminalEnded(session: Pick<SessionInfo, "status"> | undefined): boolean {
  return session?.status === "done" || session?.status === "died";
}
