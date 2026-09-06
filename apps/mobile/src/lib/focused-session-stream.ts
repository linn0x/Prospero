import type { AgentEventBody, S2CTermOutput, S2CTermSnapshot, S2CToolOutput } from "@prospero/protocol";
import type { HostConnection } from "./connection";

/** A focused route still stops doing work while the native app is inactive. */
export function subscribeWhileAppActive(
  source: { currentState: string; onChange(listener: (state: string) => void): () => void },
  start: () => () => void,
): () => void {
  let active = true;
  let cleanup: (() => void) | undefined;
  const change = (state: string) => {
    if (!active) return;
    if (state === "active") cleanup ??= start();
    else { cleanup?.(); cleanup = undefined; }
  };
  const unsubscribe = source.onChange(change);
  change(source.currentState);
  return () => {
    if (!active) return;
    active = false;
    unsubscribe(); cleanup?.(); cleanup = undefined;
  };
}

/** Flush before releasing focus so the resume cursor never skips undisplayed deltas. */
export function subscribeFocusedChat(options: {
  conn: Pick<HostConnection, "events" | "attach" | "isConnected">;
  sid: string;
  cursor: { current: number };
  snapshot(events: AgentEventBody[]): void;
  events(events: AgentEventBody[]): void;
  toolOutput(message: S2CToolOutput): void;
  unread(): void;
}): () => void {
  const { conn, sid, cursor } = options;
  let active = true;
  let queued: AgentEventBody[] = [];
  let receivedSeq = cursor.current;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!queued.length) return;
    const batch = queued;
    queued = [];
    options.events(batch);
    cursor.current = receivedSeq;
  };
  const offSnapshot = conn.events.on("chatSnapshot", (message) => {
    if (!active || message.sid !== sid) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    queued = [];
    options.snapshot(message.events);
    receivedSeq = cursor.current = message.evSeq;
  });
  const offEvent = conn.events.on("agentEvent", (message) => {
    if (!active || message.sid !== sid || message.evSeq <= receivedSeq) return;
    receivedSeq = message.evSeq;
    queued.push(message.body);
    if (timer === null) timer = setTimeout(flush, 32);
    options.unread();
  });
  const offOutput = conn.events.on("toolOutput", (message) => {
    if (!active || message.sid !== sid) return;
    flush();
    options.toolOutput(message);
  });
  const attach = () => {
    if (!active) return;
    flush();
    conn.attach(sid, cursor.current || undefined);
  };
  const offConnected = conn.events.on("connected", attach);
  if (conn.isConnected) attach();
  return () => {
    if (!active) return;
    active = false;
    offSnapshot(); offEvent(); offOutput(); offConnected();
    flush();
  };
}

/** A response from a previous focus/session may finish, but cannot update the current view. */
export function pollFocusedSubagent(options: {
  conn: Pick<HostConnection, "events" | "isConnected" | "supportsSubagentHistory" | "subagentHistory">;
  sid: string;
  subagentId: string;
  receive(events: AgentEventBody[]): void;
}): () => void {
  let active = true;
  let loading = false;
  const refresh = async () => {
    if (!active || loading || !options.conn.isConnected || !options.conn.supportsSubagentHistory) return;
    loading = true;
    try {
      const events = await options.conn.subagentHistory(options.sid, options.subagentId);
      if (active) options.receive(events);
    } catch {
      // Keep the last visible history; a later focused poll can retry.
    }
    loading = false;
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 1_200);
  const offConnected = options.conn.events.on("connected", () => void refresh());
  return () => { active = false; clearInterval(timer); offConnected(); };
}

/** Keep the retained terminal buffer and resume cursor aligned when leaving the route. */
export function subscribeFocusedTerminal(options: {
  conn: Pick<HostConnection, "events" | "ack">;
  sid: string;
  cursor: { current: number };
  snapshot(message: S2CTermSnapshot): void;
  output(message: S2CTermOutput): void;
  flush(): void;
  attach(): void;
}): () => void {
  let active = true;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  const offSnapshot = options.conn.events.on("snapshot", (message) => {
    if (!active || message.sid !== options.sid) return;
    options.snapshot(message);
    options.cursor.current = message.seq;
  });
  const offOutput = options.conn.events.on("output", (message) => {
    if (!active || message.sid !== options.sid || message.seq <= options.cursor.current) return;
    options.output(message);
    options.cursor.current = message.seq;
    if (ackTimer === null) ackTimer = setTimeout(() => {
      ackTimer = null;
      options.conn.ack(options.sid, options.cursor.current);
    }, 500);
  });
  const attach = () => { if (active) options.attach(); };
  const offConnected = options.conn.events.on("connected", attach);
  attach();
  return () => {
    if (!active) return;
    active = false;
    offSnapshot(); offOutput(); offConnected();
    options.flush();
    if (ackTimer !== null) {
      clearTimeout(ackTimer);
      ackTimer = null;
      options.conn.ack(options.sid, options.cursor.current);
    }
  };
}
