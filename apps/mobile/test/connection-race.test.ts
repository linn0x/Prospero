import { describe, expect, it } from "vitest";
import { raceFirstSuccessful, type ManagedAttempt } from "../src/lib/connection-race";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: string): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: string) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("connection race", () => {
  it("closes and detaches every loser after the first E2E success", async () => {
    const direct = deferred<string>();
    const relay = deferred<string>();
    let directAborted = 0;
    let relayAborted = 0;
    const attempts: ManagedAttempt<string>[] = [
      { label: "direct", promise: direct.promise, abort: () => { directAborted += 1; } },
      { label: "relay", promise: relay.promise, abort: () => { relayAborted += 1; } },
    ];

    const raced = raceFirstSuccessful(attempts);
    relay.resolve("relay hello.ok");
    await expect(raced).resolves.toBe("relay hello.ok");
    expect(directAborted).toBe(1);
    expect(relayAborted).toBe(0);

    // A late success from the direct socket is still cleaned up and cannot
    // replace the winner.
    direct.resolve("late direct hello.ok");
    await Promise.resolve();
    expect(directAborted).toBe(2);
  });

  it("does not reject auto while another path is still pending", async () => {
    const direct = deferred<string>();
    const relay = deferred<string>();
    const raced = raceFirstSuccessful([
      { label: "direct", promise: direct.promise, abort: () => {} },
      { label: "relay", promise: relay.promise, abort: () => {} },
    ]);
    direct.reject("LAN unavailable");
    relay.resolve("relay hello.ok");
    await expect(raced).resolves.toBe("relay hello.ok");
  });
});
