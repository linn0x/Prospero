import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentModel, AgentModelCatalog, SessionInfo } from "../src/shared/types";
import {
  AgyModelPicker,
  agyOrchestratorPlannerLabel,
  agySelectionDisplay,
  formatAgyEffortLabel,
  groupAgyModels,
  isAgyOrchestratorModelId,
} from "../src/renderer/src/workspace/AgyModelPicker";
import { LaunchModelFields, resolveCatalogSelection } from "../src/renderer/src/workspace/LaunchModelFields";
import { ModelSwitcher } from "../src/renderer/src/workspace/ModelSwitcher";

vi.mock("../src/renderer/src/locale", () => ({
  useLocale: () => ({
    language: "zh" as const,
    t: (zh: string) => zh,
    status: (s: string) => s,
  }),
}));

const sampleModels: AgentModel[] = [
  {
    id: "gemini-4-neon",
    label: "Gemini 4 Neon",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    isDefault: true,
  },
  {
    id: "gemini-4-carbon",
    label: "Gemini 4 Carbon",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  {
    id: "gemini-pro-orchestrator-neon",
    label: "Orchestrator · Gemini 4 Neon",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
  },
  {
    id: "gemini-pro-orchestrator",
    label: "Orchestrator · Gemini 4 Carbon",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gemini-pro-orchestrator-argon",
    label: "Orchestrator · Gemini 4 Argon",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gemini-pro-orchestrator-claude-opus-5-5",
    label: "Orchestrator · Claude Opus 5.5",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-oss-120b",
    label: "GPT-OSS 120B",
    supportedEfforts: ["medium"],
    defaultEffort: "medium",
  },
];

describe("AgyModelPicker", () => {
  it("formats official Antigravity reasoning effort labels including Extra High", () => {
    expect(formatAgyEffortLabel("low")).toBe("Low");
    expect(formatAgyEffortLabel("medium")).toBe("Medium");
    expect(formatAgyEffortLabel("high")).toBe("High");
    expect(formatAgyEffortLabel("xhigh")).toBe("Extra High");
    expect(formatAgyEffortLabel("max")).toBe("Max");
  });

  it("collapses all Orchestrator planners into a single top-level entry matching the 9-row menu", () => {
    const grouped = groupAgyModels(sampleModels);
    expect(grouped).toHaveLength(9);
    expect(grouped[0]).toMatchObject({ kind: "model", model: { id: "gemini-4-neon" } });
    expect(grouped[4]).toMatchObject({ kind: "orchestrator" });
    const orch = grouped[4]!;
    if (orch.kind !== "orchestrator") throw new Error("expected orchestrator group");
    expect(orch.planners.map((item) => agyOrchestratorPlannerLabel(item))).toEqual([
      "Gemini 4 Neon",
      "Gemini 4 Carbon",
      "Gemini 4 Argon",
      "Claude Opus 5.5",
    ]);
    expect(isAgyOrchestratorModelId("gemini-pro-orchestrator-claude-opus-5-5")).toBe(true);
    expect(isAgyOrchestratorModelId("gemini-4-neon")).toBe(false);
  });

  it("formats trigger selection display for standalone and Orchestrator planner + effort", () => {
    expect(agySelectionDisplay(sampleModels, undefined, undefined)).toEqual({
      primary: "Gemini 4 Neon",
      secondary: "Medium",
    });
    expect(agySelectionDisplay(sampleModels, "gemini-4-neon", "xhigh")).toEqual({
      primary: "Gemini 4 Neon",
      secondary: "Extra High",
    });
    expect(
      agySelectionDisplay(sampleModels, "gemini-pro-orchestrator-neon", "xhigh"),
    ).toEqual({
      primary: "Orchestrator",
      secondary: "Gemini 4 Neon Extra High",
    });
    expect(
      agySelectionDisplay(
        sampleModels,
        "gemini-pro-orchestrator-claude-opus-5-5",
        "high",
      ),
    ).toEqual({
      primary: "Orchestrator",
      secondary: "Claude Opus 5.5 High",
    });
  });

  it("renders trigger button cleanly for standalone and Orchestrator selections", () => {
    const html = renderToStaticMarkup(
      <AgyModelPicker
        id="session-model"
        models={sampleModels}
        value="gemini-pro-orchestrator-neon"
        effort="xhigh"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('id="session-model"');
    expect(html).toContain("Orchestrator");
    expect(html).toContain("Gemini 4 Neon Extra High");
  });

  it("resolves preferred, catalog-current, default, and empty catalog selections", () => {
    const catalog: AgentModelCatalog = {
      models: sampleModels,
      currentModel: "gemini-4-carbon",
      currentEffort: "high",
    };

    expect(resolveCatalogSelection(catalog, "gemini-4-neon", "xhigh")).toEqual({
      model: "gemini-4-neon",
      effort: "xhigh",
    });
    expect(resolveCatalogSelection(catalog, "gemini-4-argon", "xhigh")).toEqual({
      model: "gemini-4-argon",
      effort: "medium",
    });
    expect(resolveCatalogSelection(catalog, undefined, undefined)).toEqual({
      model: "gemini-4-carbon",
      effort: "high",
    });
    expect(resolveCatalogSelection({ models: sampleModels })).toEqual({
      model: "gemini-4-neon",
      effort: "medium",
    });
    expect(resolveCatalogSelection({ models: [] }, "missing", "high")).toEqual({});
  });

  it("hides duplicate effort select for agy and keeps custom model override collapsed until used", () => {
    const agyHtml = renderToStaticMarkup(
      <LaunchModelFields
        agent="agy"
        models={sampleModels}
        model="gemini-pro-orchestrator-neon"
        effort="xhigh"
        modelSelectId="agy-model"
        effortSelectId="agy-effort"
        customModel=""
        onCustomModelChange={() => {}}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />,
    );
    expect(agyHtml).toContain('id="agy-model"');
    expect(agyHtml).not.toContain('id="agy-effort"');
    expect(agyHtml).not.toContain("推理强度");
    expect(agyHtml).toContain("<details");
    expect(agyHtml).not.toContain("<details open");

    const codexHtml = renderToStaticMarkup(
      <LaunchModelFields
        agent="codex"
        models={[
          {
            id: "gpt-6-astra",
            label: "GPT-6-Astra",
            supportedEfforts: ["low", "medium", "high", "xhigh"],
            defaultEffort: "high",
            isDefault: true,
          },
        ]}
        model="gpt-6-astra"
        effort="high"
        modelSelectId="codex-model"
        effortSelectId="codex-effort"
        customModel="custom-override-id"
        onCustomModelChange={() => {}}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />,
    );
    expect(codexHtml).toContain('id="codex-model"');
    expect(codexHtml).toContain('id="codex-effort"');
    expect(codexHtml).toContain("推理强度");
    expect(codexHtml).toMatch(/<details\b[^>]*\bopen(?:=""|(?=\s|>))/);
  });

  it("renders inline AgyModelPicker chip directly for agy sessions in ModelSwitcher", () => {
    const agySession: SessionInfo = {
      id: "sess-agy-1",
      cwd: "/repo",
      agent: "agy",
      kind: "structured",
      title: "AGY Session",
      status: "idle",
      model: "gemini-4-neon",
      effort: "medium",
      agentControls: {
        model: true,
        mode: true,
        compact: false,
        currentModel: "gemini-4-neon",
        currentEffort: "medium",
      },
    };
    const agySwitcherHtml = renderToStaticMarkup(
      <ModelSwitcher session={agySession} account={undefined} />,
    );
    expect(agySwitcherHtml).toContain("session-model-chip");
    expect(agySwitcherHtml).toContain('aria-label="切换模型"');
    expect(agySwitcherHtml).not.toContain("session-model-dialog");

    const codexSession: SessionInfo = {
      ...agySession,
      id: "sess-codex-1",
      agent: "codex",
      model: "gpt-6-astra",
      agentControls: {
        model: true,
        mode: false,
        compact: false,
        currentModel: "gpt-6-astra",
      },
    };
    const codexSwitcherHtml = renderToStaticMarkup(
      <ModelSwitcher session={codexSession} account={undefined} />,
    );
    expect(codexSwitcherHtml).toContain("session-model-chip");
    expect(codexSwitcherHtml).toContain("gpt-6-astra");
  });
});
