/**
 * Portable completion reducer for the native secure-pipe smoke client.
 *
 * A named pipe server is allowed to disconnect immediately after it has read
 * the client's ACK.  Windows can surface that proven peer disconnect as a
 * socket EPIPE rather than an `end` event.  EPIPE is not itself success: it
 * is orderly EOF only after every duplex protocol fact below is true.
 */
export type SecurePipeTerminal = Readonly<{
  type: string;
  acknowledged?: unknown;
}>;

export type SecurePipeRoundTripOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "response"; readonly data: Uint8Array; readonly orderlyEpipe: boolean }
  | { readonly kind: "error"; readonly error: Error };

function pipeFailure(stage: string, cause?: unknown): Error {
  const socketError = cause && typeof cause === "object" ? cause as NodeJS.ErrnoException : undefined;
  const code = typeof socketError?.code === "string" ? socketError.code : undefined;
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  const error = new Error(`Named pipe ${stage}${code ? ` (${code})` : ""}${detail}`);
  if (code) Object.assign(error, { code });
  return error;
}

/**
 * This is deliberately event-order tolerant.  The worker's terminal message
 * and Node's socket events cross different queues, so a real server-complete
 * EPIPE can arrive before the worker message reaches the test thread.  The
 * reducer holds that one candidate, then accepts it only after the complete
 * protocol evidence has arrived.  Every other socket error remains fatal.
 */
export class SecurePipeRoundTripState {
  private response = new Uint8Array();
  private echoComplete = false;
  private acknowledgementFlushed = false;
  private terminalAcknowledged = false;
  private expectedClose = false;
  private sawEpipe = false;
  private outcomeValue: SecurePipeRoundTripOutcome = { kind: "pending" };

  constructor(private readonly expectedEcho: Uint8Array) {}

  get outcome(): SecurePipeRoundTripOutcome { return this.outcomeValue; }

  /** Returns true once, when the complete valid echo makes ACK eligible. */
  receiveEcho(data: Uint8Array): boolean {
    if (this.outcomeValue.kind !== "pending") return false;
    if (this.echoComplete) {
      this.fail("received data after the complete roundtrip response");
      return false;
    }
    const merged = new Uint8Array(this.response.byteLength + data.byteLength);
    merged.set(this.response);
    merged.set(data, this.response.byteLength);
    this.response = merged;
    if (this.response.byteLength > this.expectedEcho.byteLength ||
      !this.expectedEcho.subarray(0, this.response.byteLength).every((byte, index) => byte === this.response[index])) {
      this.fail("returned an invalid roundtrip response");
      return false;
    }
    if (this.response.byteLength !== this.expectedEcho.byteLength) return false;
    this.echoComplete = true;
    return true;
  }

  acknowledgementFinished(): void {
    if (this.outcomeValue.kind !== "pending") return;
    if (!this.echoComplete) {
      this.fail("finished the acknowledgement before the complete roundtrip response");
      return;
    }
    this.acknowledgementFlushed = true;
    this.evaluate();
  }

  serverTerminal(terminal: SecurePipeTerminal): void {
    if (this.outcomeValue.kind !== "pending") return;
    if (terminal.type !== "complete" || terminal.acknowledged !== true) {
      this.fail("server did not complete an acknowledged roundtrip");
      return;
    }
    this.terminalAcknowledged = true;
    this.evaluate();
  }

  socketEnded(): void {
    if (this.outcomeValue.kind !== "pending") return;
    this.expectedClose = true;
    this.evaluate();
  }

  socketClosed(): void {
    if (this.outcomeValue.kind !== "pending") return;
    this.expectedClose = true;
    this.evaluate();
  }

  socketError(error: Error): void {
    if (this.outcomeValue.kind !== "pending") return;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPIPE") {
      this.fail("socket error", error);
      return;
    }
    if (!this.echoComplete) {
      // A disconnect before the complete echo can never be the ordered
      // server close.  Fail it now instead of allowing a later event to
      // accidentally make an early EPIPE look benign.
      this.fail("socket error", error);
      return;
    }
    // Do not ignore EPIPE.  It becomes an expected close only in evaluate(),
    // after the echoed bytes, ACK finish, and server acknowledgement exist.
    this.sawEpipe = true;
    this.expectedClose = true;
    this.evaluate();
  }

  timedOut(timeoutMs: number): void {
    if (this.outcomeValue.kind === "pending") {
      this.fail(`roundtrip timed out after ${timeoutMs}ms`);
    }
  }

  private evaluate(): void {
    if (!this.echoComplete || !this.acknowledgementFlushed || !this.terminalAcknowledged || !this.expectedClose) return;
    this.outcomeValue = {
      kind: "response",
      data: this.response,
      orderlyEpipe: this.sawEpipe,
    };
  }

  private fail(stage: string, cause?: unknown): void {
    if (this.outcomeValue.kind === "pending") this.outcomeValue = { kind: "error", error: pipeFailure(stage, cause) };
  }
}
