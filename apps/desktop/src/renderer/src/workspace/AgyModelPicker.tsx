import { Check, ChevronDown, RefreshCw } from "lucide-react";
import type { AgentModel } from "../../../shared/types";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Spinner } from "../components/ui/spinner";
import { useLocale } from "../locale";

/** Formats Antigravity reasoning effort slugs to match the official CLI/app labels. */
export function formatAgyEffortLabel(effort: string | undefined): string {
  switch (effort?.trim().toLowerCase()) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return effort?.trim() ?? "";
  }
}

/** Returns true when a model id represents an Antigravity Orchestrator planner entry. */
export function isAgyOrchestratorModelId(id: string | undefined): boolean {
  return Boolean(id && id.startsWith("gemini-pro-orchestrator"));
}

/** Extracts the concise planner name (e.g. `Gemini 4 Neon`) from an Orchestrator model entry. */
export function agyOrchestratorPlannerLabel(model: AgentModel): string {
  const trimmed = model.label.trim();
  const bulletPrefix = "Orchestrator · ";
  if (trimmed.startsWith(bulletPrefix)) {
    return trimmed.slice(bulletPrefix.length).trim();
  }
  const parenMatch = /^Orchestrator\s*\(([^)]+)\)$/i.exec(trimmed);
  if (parenMatch?.[1]) {
    const inner = parenMatch[1].trim();
    if (inner === "Neon" || inner === "Carbon" || inner === "Argon") {
      return `Gemini 4 ${inner}`;
    }
    return inner;
  }
  return trimmed || model.id;
}

export type AgyModelMenuEntry =
  | { kind: "model"; model: AgentModel }
  | { kind: "orchestrator"; planners: AgentModel[] };

/** Groups flat Orchestrator planner entries into one top-level `Orchestrator` submenu entry. */
export function groupAgyModels(models: AgentModel[]): AgyModelMenuEntry[] {
  const entries: AgyModelMenuEntry[] = [];
  let orchestratorsIndex: number | undefined;
  const planners: AgentModel[] = [];

  for (const model of models) {
    if (isAgyOrchestratorModelId(model.id)) {
      if (orchestratorsIndex === undefined) {
        orchestratorsIndex = entries.length;
      }
      planners.push(model);
    } else {
      entries.push({ kind: "model", model });
    }
  }

  if (planners.length > 0 && orchestratorsIndex !== undefined) {
    entries.splice(orchestratorsIndex, 0, { kind: "orchestrator", planners });
  }
  return entries;
}

function resolveDisplayedEffort(
  model: AgentModel,
  selectedId: string | undefined,
  selectedEffort: string | undefined,
): string | undefined {
  if (
    model.id === selectedId &&
    selectedEffort &&
    model.supportedEfforts.includes(selectedEffort)
  ) {
    return selectedEffort;
  }
  return model.defaultEffort ?? model.supportedEfforts[0];
}

/** Formats the trigger button's primary and secondary labels for the active `(modelId, effort)`. */
export function agySelectionDisplay(
  models: AgentModel[],
  modelId?: string,
  effort?: string,
): { primary: string; secondary?: string } {
  const active =
    models.find((candidate) => candidate.id === modelId) ??
    models.find((candidate) => candidate.isDefault) ??
    models[0];
  if (!active) {
    return { primary: "" };
  }
  const effectiveEffort = resolveDisplayedEffort(active, modelId, effort);
  const effortLabel = formatAgyEffortLabel(effectiveEffort);
  if (isAgyOrchestratorModelId(active.id)) {
    const planner = agyOrchestratorPlannerLabel(active);
    return {
      primary: "Orchestrator",
      secondary: effortLabel ? `${planner} ${effortLabel}` : planner,
    };
  }
  return {
    primary: active.label || active.id,
    ...(effortLabel ? { secondary: effortLabel } : {}),
  };
}

function standaloneItemLabel(model: AgentModel): string {
  const label = model.label || model.id;
  if (model.supportedEfforts.length === 1) {
    const onlyEffort = formatAgyEffortLabel(model.supportedEfforts[0]);
    if (onlyEffort && !label.includes(`(${onlyEffort})`)) {
      return `${label} (${onlyEffort})`;
    }
  }
  return label;
}

/** Cascading Antigravity (`agy`) model + reasoning-effort selector mirroring the official CLI/App menu. */
export function AgyModelPicker({
  id,
  models,
  value,
  effort,
  loading = false,
  saving = false,
  disabled = false,
  allowEmptyOpen = false,
  triggerSize = "default",
  triggerAriaLabel,
  triggerTitle,
  error,
  ariaInvalid = false,
  ariaDescribedBy,
  onOpenChange,
  onRefresh,
  onChange,
  className,
}: {
  id?: string | undefined;
  models: AgentModel[];
  value?: string | undefined;
  effort?: string | undefined;
  loading?: boolean | undefined;
  saving?: boolean | undefined;
  disabled?: boolean | undefined;
  allowEmptyOpen?: boolean | undefined;
  triggerSize?: "default" | "sm" | undefined;
  triggerAriaLabel?: string | undefined;
  triggerTitle?: string | undefined;
  error?: string | undefined;
  ariaInvalid?: boolean | undefined;
  ariaDescribedBy?: string | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  onRefresh?: (() => void) | undefined;
  onChange: (modelId: string, effort: string | undefined) => void;
  className?: string | undefined;
}) {
  const { t } = useLocale();
  const entries = groupAgyModels(models);
  const display = agySelectionDisplay(models, value, effort);
  const fallbackText = loading
    ? t("读取模型中…", "Loading models…")
    : value || t("没有可用模型", "No models available");
  const isDisabled = disabled || saving || (!allowEmptyOpen && (loading || models.length === 0));
  const compact = triggerSize === "sm";

  return (
    <DropdownMenu modal={false} {...(onOpenChange ? { onOpenChange } : {})}>
      <DropdownMenuTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            size={compact ? "sm" : "default"}
            disabled={isDisabled}
            aria-busy={loading || saving}
            aria-label={triggerAriaLabel}
            aria-invalid={ariaInvalid}
            aria-describedby={ariaDescribedBy}
            title={triggerTitle}
            className={cn(
              compact
                ? "justify-between font-normal"
                : "h-8 w-full justify-between px-2.5 font-normal text-sm dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
              className,
            )}
          />
        }
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <span className={cn("truncate", compact ? "font-medium" : "font-medium text-foreground")}>
            {display.primary || fallbackText}
          </span>
          {display.primary && display.secondary && (
            <span className={cn("truncate text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
              {display.secondary}
            </span>
          )}
        </span>
        {saving ? (
          <Spinner className={cn("shrink-0 text-muted-foreground", compact ? "size-3" : "size-3.5")} />
        ) : (
          <ChevronDown className={cn("shrink-0 text-muted-foreground", compact ? "size-3" : "size-4")} />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-72 min-w-[260px] z-[60]"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center justify-between gap-2">
            <span>Model</span>
            {onRefresh && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={loading || saving}
                aria-label={t("刷新模型", "Refresh models")}
                title={t("刷新模型", "Refresh models")}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onRefresh();
                }}
              >
                <RefreshCw className={loading ? "animate-spin" : undefined} />
              </Button>
            )}
          </DropdownMenuLabel>
          {error && (
            <div
              role="alert"
              className="mx-1.5 mb-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
            >
              {error}
            </div>
          )}
          {loading && models.length === 0 ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 px-2 py-4 text-xs text-muted-foreground"
            >
              <Spinner className="size-3.5" />
              <span>{t("正在加载模型…", "Loading models…")}</span>
            </div>
          ) : models.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {onRefresh
                ? t("没有可用模型，点击右上角刷新重试。", "No models available. Click refresh above to retry.")
                : t("没有可用模型", "No models available")}
            </div>
          ) : (
            entries.map((entry) => {
              if (entry.kind === "orchestrator") {
                const planners = entry.planners;
                if (planners.length === 1 && planners[0]!.supportedEfforts.length === 0) {
                  const fixed = planners[0]!;
                  const active = value === fixed.id;
                  return (
                    <DropdownMenuItem
                      key="orchestrator"
                      disabled={saving}
                      onClick={() => onChange(fixed.id, undefined)}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {fixed.label || "Orchestrator"}
                      </span>
                      <Check
                        className={cn(
                          "ml-auto size-4 shrink-0",
                          active ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </DropdownMenuItem>
                  );
                }

                const activePlanner = planners.find((candidate) => candidate.id === value);
                const previewPlanner = activePlanner ?? planners[0]!;
                const previewEffort = resolveDisplayedEffort(
                  previewPlanner,
                  value,
                  effort,
                );
                const previewEffortLabel = formatAgyEffortLabel(previewEffort);
                const previewText = previewEffortLabel
                  ? `${agyOrchestratorPlannerLabel(previewPlanner)} ${previewEffortLabel}`
                  : agyOrchestratorPlannerLabel(previewPlanner);

                return (
                  <DropdownMenuSub key="orchestrator">
                    <DropdownMenuSubTrigger data-slot="agy-orchestrator-trigger">
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <span className="shrink-0 font-medium">Orchestrator</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {previewText}
                        </span>
                      </span>
                      {activePlanner && (
                        <Check className="mr-1 size-3.5 shrink-0 text-foreground" />
                      )}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-64 min-w-[230px] z-[60]">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Orchestrator Planner</DropdownMenuLabel>
                        {planners.map((planner) => {
                          const plannerActive = value === planner.id;
                          const plannerLabel = agyOrchestratorPlannerLabel(planner);
                          const plannerEffort = resolveDisplayedEffort(
                            planner,
                            value,
                            effort,
                          );
                          const plannerEffortLabel = formatAgyEffortLabel(plannerEffort);

                          if (planner.supportedEfforts.length === 0) {
                            return (
                              <DropdownMenuItem
                                key={planner.id}
                                disabled={saving}
                                onClick={() => onChange(planner.id, undefined)}
                              >
                                <span className="min-w-0 flex-1 truncate">
                                  {plannerLabel}
                                </span>
                                <Check
                                  className={cn(
                                    "ml-auto size-4 shrink-0",
                                    plannerActive ? "opacity-100" : "opacity-0",
                                  )}
                                />
                              </DropdownMenuItem>
                            );
                          }

                          return (
                            <DropdownMenuSub key={planner.id}>
                              <DropdownMenuSubTrigger>
                                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                  <span className="truncate">{plannerLabel}</span>
                                  {plannerEffortLabel && (
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                      {plannerEffortLabel}
                                    </span>
                                  )}
                                </span>
                                {plannerActive && (
                                  <Check className="mr-1 size-3.5 shrink-0 text-foreground" />
                                )}
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="w-40 min-w-[150px] z-[60]">
                                {planner.supportedEfforts.map((level) => {
                                  const levelActive =
                                    plannerActive && plannerEffort === level;
                                  return (
                                    <DropdownMenuItem
                                      key={level}
                                      disabled={saving}
                                      onClick={() => onChange(planner.id, level)}
                                    >
                                      <span className="flex-1 truncate">
                                        {formatAgyEffortLabel(level)}
                                      </span>
                                      <Check
                                        className={cn(
                                          "ml-auto size-4 shrink-0",
                                          levelActive ? "opacity-100" : "opacity-0",
                                        )}
                                      />
                                    </DropdownMenuItem>
                                  );
                                })}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          );
                        })}
                      </DropdownMenuGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              }

              const { model } = entry;
              const modelActive = value === model.id;
              const currentEffort = resolveDisplayedEffort(model, value, effort);
              const currentEffortLabel = formatAgyEffortLabel(currentEffort);

              if (model.supportedEfforts.length <= 1) {
                const singleEffort =
                  model.defaultEffort ?? model.supportedEfforts[0];
                return (
                  <DropdownMenuItem
                    key={model.id}
                    disabled={saving}
                    onClick={() => onChange(model.id, singleEffort)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {standaloneItemLabel(model)}
                    </span>
                    <Check
                      className={cn(
                        "ml-auto size-4 shrink-0",
                        modelActive ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </DropdownMenuItem>
                );
              }

              return (
                <DropdownMenuSub key={model.id}>
                  <DropdownMenuSubTrigger>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="truncate">{model.label || model.id}</span>
                      {currentEffortLabel && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {currentEffortLabel}
                        </span>
                      )}
                    </span>
                    {modelActive && (
                      <Check className="mr-1 size-3.5 shrink-0 text-foreground" />
                    )}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-40 min-w-[150px] z-[60]">
                    {model.supportedEfforts.map((level) => {
                      const levelActive = modelActive && currentEffort === level;
                      return (
                        <DropdownMenuItem
                          key={level}
                          disabled={saving}
                          onClick={() => onChange(model.id, level)}
                        >
                          <span className="flex-1 truncate">
                            {formatAgyEffortLabel(level)}
                          </span>
                          <Check
                            className={cn(
                              "ml-auto size-4 shrink-0",
                              levelActive ? "opacity-100" : "opacity-0",
                            )}
                          />
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
