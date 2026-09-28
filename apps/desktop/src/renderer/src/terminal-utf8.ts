import type { Terminal } from "@xterm/xterm";

/**
 * xterm 6's UTF-8 decoder loses an interim continuation byte whose payload is
 * zero (for example E2 80 / 8D, ZWJ). Normalize the byte stream through the
 * browser's streaming decoder so page/chunk boundaries cannot change text.
 * Keep xterm's queued write/callback contract and clear partial UTF-8 on reset.
 */
export function configureTerminalUtf8(terminal: Pick<Terminal, "write" | "reset">): void {
  const write = terminal.write.bind(terminal);
  const reset = terminal.reset.bind(terminal);
  let decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  terminal.write = (data, callback) => {
    if (typeof data === "string") {
      const pending = decoder.decode();
      write(pending + data, callback);
    } else {
      write(decoder.decode(data, { stream: true }), callback);
    }
  };
  terminal.reset = () => {
    decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    reset();
  };
}
