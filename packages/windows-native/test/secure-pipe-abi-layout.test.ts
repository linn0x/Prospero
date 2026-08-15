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
  });
});
