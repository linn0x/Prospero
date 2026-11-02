import { useCallback, useRef, useState } from "react";
import { fromB64, toB64, utf8Decode } from "@prospero/protocol";
import type { HostConnection } from "./connection";
import type { DeliveryResult } from "./outbound-queue";
import { NO_TERMINAL_MODIFIERS, terminalKeySequence, type TerminalModifiers } from "./keys";
import { useFocusedSessionEffect } from "./use-focused-session-effect";

export function useTerminalKeyboard(conn: HostConnection | null, sid: string, enabled: boolean) {
  const [modifiers, setModifiers] = useState(NO_TERMINAL_MODIFIERS);
  const current = useRef(NO_TERMINAL_MODIFIERS);
  const active = useRef(false);
  const reset = useCallback(() => { current.current = NO_TERMINAL_MODIFIERS; setModifiers(NO_TERMINAL_MODIFIERS); }, []);
  useFocusedSessionEffect(useCallback(() => {
    active.current = enabled && conn !== null && sid.length > 0;
    reset();
    return () => { active.current = false; reset(); };
  }, [conn, sid, enabled, reset]));
  const toggleModifier = (key: keyof TerminalModifiers): void => {
    if (!enabled || !active.current) return;
    current.current = { ...current.current, [key]: !current.current[key] };
    setModifiers(current.current);
  };
  const send = (text: string): DeliveryResult => {
    if (!conn || !enabled || !active.current) return { accepted: false, reason: "offline" };
    return conn.inputText(sid, text);
  };
  const sendKey = (text: string): DeliveryResult => {
    const result = send(terminalKeySequence(text, current.current));
    if (result.accepted) reset();
    return result;
  };
  const paste = (text: string): DeliveryResult => {
    const result = send(text);
    if (result.accepted) reset();
    return result;
  };
  const pasteB64 = (data: string): DeliveryResult => {
    if (!conn || !enabled || !active.current) return { accepted: false, reason: "offline" };
    // The Rust terminal accepts at most 8192 bytes per input frame. Slice
    // bytes, not JavaScript characters, so UTF-8 and paste markers survive.
    const bytes = fromB64(data);
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      const result = conn.inputB64(sid, toB64(bytes.subarray(offset, offset + 8192)));
      if (!result.accepted) {
        if (offset > 0) { reset(); return { accepted: false, reason: "partial" }; }
        return result;
      }
    }
    reset();
    return { accepted: true, disposition: "sent" };
  };
  const inputB64 = (data: string): DeliveryResult => {
    if (!conn || !enabled || !active.current) return { accepted: false, reason: "offline" };
    // System keyboard paste also arrives through xterm's ordinary input event.
    if (data.length >= 10_924) return pasteB64(data);
    if (!current.current.ctrl && !current.current.option) return conn.inputB64(sid, data);
    return sendKey(utf8Decode(fromB64(data)));
  };
  return { modifiers, toggleModifier, sendKey, paste, pasteB64, inputB64 };
}
