import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("secure named-pipe ABI v2 layout", () => {
  it("retains the legacy SID pointer slot while rejecting caller-selected SIDs", () => {
    const header = readFileSync(join(packageRoot, "native", "include", "prospero_windows_native.h"), "utf8");
    const implementation = readFileSync(join(packageRoot, "native", "src", "secure_named_pipe.cc"), "utf8");
    const addon = readFileSync(join(packageRoot, "native", "src", "addon.cc"), "utf8");
    expect(header).toContain("const wchar_t* reserved_legacy_allowed_user_sid;");
    expect(implementation).toContain("prospero_secure_pipe_security must retain the ABI-v2 legacy SID slot");
    expect(implementation).toContain("reserved_legacy_allowed_user_sid != nullptr");
    expect(addon).toContain("options.security.reserved_legacy_allowed_user_sid = nullptr;");
    expect(header).toContain("uint32_t session_id;");
    expect(addon).toContain('SetUint32(env, result, "sessionId", peer.session_id)');
  });

  it("wipes unauthenticated first-read bytes before disconnecting the endpoint", () => {
    const implementation = readFileSync(join(packageRoot, "native", "src", "secure_named_pipe.cc"), "utf8");
    const readStart = implementation.indexOf("extern \"C\" prospero_status prospero_secure_pipe_connection_read(");
    const writeStart = implementation.indexOf("extern \"C\" prospero_status prospero_secure_pipe_connection_write(");
    expect(readStart).toBeGreaterThanOrEqual(0);
    expect(writeStart).toBeGreaterThan(readStart);
    const readImplementation = implementation.slice(readStart, writeStart);
    const failureBlock = readImplementation.slice(readImplementation.indexOf("if (authentication_failed)"));

    expect(implementation).toContain("HMAC framing is an upper-layer protocol concern.");
    expect(implementation).not.toContain("first-frame proof");
    expect(failureBlock).toMatch(
      /const uint32_t bytes_to_clear = \*out_read;\s+SecureZeroMemory\(buffer, bytes_to_clear\);\s+\*out_read = 0;\s+\/\/ Close only after the read lease drains[\s\S]*connection->endpoint->CancelAndDisconnect\(\);/,
    );
  });
});
