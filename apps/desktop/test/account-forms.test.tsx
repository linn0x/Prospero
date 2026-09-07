import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountCreateForm } from "../src/renderer/src/accounts/AccountCreateForm";
import { ModelCapabilitiesFields } from "../src/renderer/src/ModelCapabilitiesFields";
import { modelCapabilityDraft } from "../src/renderer/src/account-profile-form";

vi.mock("../src/renderer/src/locale", () => ({ useLocale: () => ({ t: (_zh: string, en: string) => en }) }));

describe("account form presentation", () => {
  it("starts with an accessible CLI form and a separate API profile tab", () => {
    const html = renderToStaticMarkup(<AccountCreateForm disabled={false} onCreateManaged={async () => true} onCreateApi={async () => true} />);
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("Create and sign in");
    expect(html).toContain("API Profile");
    expect(html).not.toContain('type="password"');
  });

  it("disables creation during parent mutations and exposes retry errors near the action", () => {
    const html = renderToStaticMarkup(<AccountCreateForm disabled busy="managed-create" error="Try again" onCreateManaged={async () => true} onCreateApi={async () => true} />);
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain('role="alert" tabindex="-1"');
    expect(html).toContain("Try again");
    expect(html).toContain("Working…");
  });

  it("shows effort declarations only when supported and explains the OpenCode limitation", () => {
    const draft = modelCapabilityDraft({ supportedEfforts: ["low", "high"] });
    const current = renderToStaticMarkup(<ModelCapabilitiesFields value={draft} onChange={() => {}} disabled={false} protocol="openai_chat_completions" effortSupported />);
    expect(current).toContain("Supported reasoning efforts");
    expect(current).toContain('value="low, high"');
    expect(current).toContain("does not apply reasoning effort");
    const legacy = renderToStaticMarkup(<ModelCapabilitiesFields value={draft} onChange={() => {}} disabled={false} protocol="openai_responses" />);
    expect(legacy).not.toContain("Supported reasoning efforts");
  });
});
