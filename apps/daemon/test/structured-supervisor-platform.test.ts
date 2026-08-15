import { describe, expect, it } from "vitest";
import {
  hasPrivateSupervisorDirectoryMode,
  hasPrivateSupervisorFileMode,
  isStructuredSupervisorEndpoint,
  structuredSupervisorPlatformGate,
  structuredSupervisorRunnerEnvironment,
  structuredSupervisorTransport,
} from "../src/structured-supervisor-platform.js";

describe("structured supervisor platform boundary", () => {
  it("fails closed on Windows until a native security boundary is selected and implemented", () => {
    expect(structuredSupervisorPlatformGate("win32"))
      .toMatch(/native Win32 security boundary has not been selected and implemented/);
    expect(structuredSupervisorTransport("win32")).toBeNull();
  });

  it("keeps the Unix owner-only socket boundary and a credential-minimizing runner environment", () => {
    expect(structuredSupervisorPlatformGate("linux")).toBeNull();
    expect(structuredSupervisorTransport("linux")).toBe("unix_socket");
    expect(isStructuredSupervisorEndpoint("/tmp/prospero/s.sock", "unix_socket")).toBe(true);
    expect(isStructuredSupervisorEndpoint("\\\\.\\pipe\\prospero-supervisor", "unix_socket")).toBe(false);
    expect(hasPrivateSupervisorFileMode(0o600)).toBe(true);
    expect(hasPrivateSupervisorFileMode(0o644)).toBe(false);
    expect(hasPrivateSupervisorDirectoryMode(0o700)).toBe(true);
    expect(hasPrivateSupervisorDirectoryMode(0o755)).toBe(false);

    const environment = structuredSupervisorRunnerEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/ada",
      LANG: "en_US.UTF-8",
      SECRET_TOKEN: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
    });
    expect(environment).toEqual(expect.objectContaining({
      PATH: "/usr/bin",
      HOME: "/Users/ada",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      SHELL: "/bin/sh",
      TERM: "xterm-256color",
    }));
    expect(environment).not.toHaveProperty("SECRET_TOKEN");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
});
