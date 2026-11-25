import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { AgentModel, AgentModelCatalog } from "../../../shared/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { useLocale } from "../locale";
import { reportError } from "../state";
import { AgyModelPicker } from "./AgyModelPicker";

export type LaunchCatalogAgent = "codex" | "claude" | "agy" | "deepseek" | "opencode" | "pi";

const CATALOG_FETCH_AGENTS = new Set<string>(["codex", "claude", "agy", "deepseek", "pi"]);

/** Picks the best matching `(model, effort)` pair from a fetched launch catalog. */
export function resolveCatalogSelection(
  catalog: AgentModelCatalog,
  currentModel?: string,
  currentEffort?: string,
): { model?: string; effort?: string } {
  const models = catalog.models ?? [];
  const preferred = currentModel
    ? models.find((candidate) => candidate.id === currentModel)
    : undefined;
  const chosen =
    preferred ??
    (catalog.currentModel
      ? models.find((candidate) => candidate.id === catalog.currentModel)
      : undefined) ??
    models.find((candidate) => candidate.isDefault) ??
    models[0];
  if (!chosen) return {};

  const effort =
    (preferred && currentEffort && chosen.supportedEfforts.includes(currentEffort)
      ? currentEffort
      : undefined) ??
    (chosen.id === catalog.currentModel &&
    catalog.currentEffort &&
    chosen.supportedEfforts.includes(catalog.currentEffort)
      ? catalog.currentEffort
      : undefined) ??
    chosen.defaultEffort ??
    chosen.supportedEfforts[0];

  return effort ? { model: chosen.id, effort } : { model: chosen.id };
}

export type UseLaunchModelsOptions = {
  enabled: boolean;
  agent: string;
  accountId?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  cacheKeyExtra?: string | undefined;
  onResolved?: (
    resolved: { model?: string; effort?: string },
    catalog: AgentModelCatalog,
    meta: { agent: LaunchCatalogAgent; accountId?: string | undefined },
  ) => void;
  onError?: (
    message: string,
    meta: { agent: LaunchCatalogAgent; accountId?: string | undefined },
  ) => void;
};

/** Loads and deduplicates launch model catalogs across launch and config dialogs. */
export function useLaunchModels({
  enabled,
  agent,
  accountId,
  model,
  effort,
  cacheKeyExtra,
  onResolved,
  onError,
}: UseLaunchModelsOptions): {
  models: AgentModel[];
  loading: boolean;
  error: string | undefined;
  retry: () => void;
} {
  const [models, setModels] = useState<AgentModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [retrySeq, setRetrySeq] = useState(0);
  const dedupKey = useRef<string | undefined>(undefined);

  const modelRef = useRef(model);
  modelRef.current = model;
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const canFetch =
    enabled &&
    CATALOG_FETCH_AGENTS.has(agent) &&
    typeof window.prospero?.getLaunchModels === "function";

  useEffect(() => {
    if (!canFetch) {
      dedupKey.current = undefined;
      setModels([]);
      setLoading(false);
      setError(undefined);
      return;
    }

    const catalogAgent = agent as LaunchCatalogAgent;
    const key = JSON.stringify([catalogAgent, accountId, cacheKeyExtra, retrySeq]);
    if (dedupKey.current === key) return;

    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void window.prospero
      .getLaunchModels(catalogAgent, accountId)
      .then((catalog) => {
        if (cancelled) return;
        dedupKey.current = key;
        const nextModels = catalog.models ?? [];
        setModels(nextModels);
        const resolved = resolveCatalogSelection(
          catalog,
          modelRef.current,
          effortRef.current,
        );
        onResolvedRef.current?.(resolved, catalog, {
          agent: catalogAgent,
          accountId,
        });
      })
      .catch((reason) => {
        if (cancelled) return;
        const message = reportError(reason);
        setModels([]);
        setError(message);
        onErrorRef.current?.(message, { agent: catalogAgent, accountId });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, agent, cacheKeyExtra, canFetch, retrySeq]);

  const retry = useCallback(() => {
    dedupKey.current = undefined;
    setRetrySeq((seq) => seq + 1);
  }, []);

  return { models, loading, error, retry };
}

export type LaunchModelFieldsProps = {
  agent: string;
  models: AgentModel[];
  model?: string | undefined;
  effort?: string | undefined;
  loading?: boolean | undefined;
  disabled?: boolean | undefined;
  effortDisabled?: boolean | undefined;
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
  onModelChange: (modelId: string | undefined, effort: string | undefined) => void;
  onEffortChange: (effort: string | undefined) => void;
  modelSelectId?: string | undefined;
  effortSelectId?: string | undefined;
  alwaysShowModelField?: boolean | undefined;
  showDescriptions?: boolean | undefined;
  showEmptyEffortPlaceholder?: boolean | undefined;
  showModelIdInOption?: boolean | undefined;
  emptyOptionLabel?: string | undefined;
  customModel?: string | undefined;
  onCustomModelChange?: ((value: string) => void) | undefined;
  customModelIdAttr?: string | undefined;
  customModelPlaceholder?: string | undefined;
};

/**
 * Shared model and reasoning-effort selector for launch and config forms.
 * For Antigravity (`agy`), delegates both model/planner and effort selection to
 * `AgyModelPicker` without rendering a duplicate standalone effort dropdown.
 */
export function LaunchModelFields({
  agent,
  models,
  model,
  effort,
  loading = false,
  disabled = false,
  effortDisabled = false,
  error,
  onRetry,
  onModelChange,
  onEffortChange,
  modelSelectId = "launch-model-select",
  effortSelectId = "launch-effort-select",
  alwaysShowModelField = false,
  showDescriptions = false,
  showEmptyEffortPlaceholder = false,
  showModelIdInOption = false,
  emptyOptionLabel,
  customModel,
  onCustomModelChange,
  customModelIdAttr = "launch-custom-model-input",
  customModelPlaceholder,
}: LaunchModelFieldsProps) {
  const { t } = useLocale();
  const isAgy = agent === "agy";
  const selectedModel = models.find((candidate) => candidate.id === model);
  const showCatalog =
    agent !== "opencode" &&
    (models.length > 0 || (isAgy && loading) || alwaysShowModelField || Boolean(error));
  const showEffortSelect =
    !isAgy &&
    (Boolean(selectedModel?.supportedEfforts.length) || showEmptyEffortPlaceholder);
  const hasCustomSupport = Boolean(onCustomModelChange);
  const hasCustomOverride = Boolean(customModel?.trim());
  const [customExpanded, setCustomExpanded] = useState(hasCustomOverride);

  useEffect(() => {
    if (hasCustomOverride) setCustomExpanded(true);
  }, [hasCustomOverride]);

  if (!showCatalog && !hasCustomSupport) return null;

  const modelControl = isAgy ? (
    <AgyModelPicker
      id={modelSelectId}
      models={models}
      value={model}
      effort={effort}
      loading={loading}
      disabled={disabled || loading || models.length === 0}
      ariaInvalid={Boolean(error)}
      ariaDescribedBy={error ? `${modelSelectId}-error` : undefined}
      onChange={(nextModelId, nextEffort) => onModelChange(nextModelId, nextEffort)}
    />
  ) : (
    <NativeSelect
      id={modelSelectId}
      value={model ?? ""}
      disabled={disabled || loading || models.length === 0}
      aria-label={t("模型", "Model")}
      aria-busy={loading}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? `${modelSelectId}-error` : undefined}
      onChange={(event) => {
        const next = models.find((item) => item.id === event.target.value);
        onModelChange(
          next?.id,
          next?.defaultEffort ?? next?.supportedEfforts[0],
        );
      }}
    >
      {models.length === 0 && (
        <NativeSelectOption value={alwaysShowModelField && !loading ? "" : (model ?? "")} disabled={alwaysShowModelField}>
          {loading
            ? t("读取模型中…", "Loading models…")
            : emptyOptionLabel ?? model ?? t("没有可用模型", "No models available")}
        </NativeSelectOption>
      )}
      {models.map((item) => (
        <NativeSelectOption key={item.id} value={item.id}>
          {showModelIdInOption ? `${item.label} (${item.id})` : item.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );

  const effortControl = (
    <NativeSelect
      id={effortSelectId}
      value={effort ?? ""}
      disabled={disabled || effortDisabled || !selectedModel?.supportedEfforts.length}
      aria-label={t("推理强度", "Reasoning effort")}
      onChange={(event) => onEffortChange(event.target.value || undefined)}
    >
      {(!selectedModel?.supportedEfforts.length || !effort) && (
        <NativeSelectOption value="" disabled>
          {t("使用模型默认值", "Use model default")}
        </NativeSelectOption>
      )}
      {selectedModel?.supportedEfforts.map((level) => (
        <NativeSelectOption key={level} value={level}>
          {level}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );

  return (
    <div className="grid gap-3">
      {showCatalog && (
        <div className={showEffortSelect ? "grid gap-4 sm:grid-cols-2" : "grid gap-3"}>
          {showDescriptions ? (
            <Field>
              <FieldLabel htmlFor={modelSelectId}>{t("模型", "Model")}</FieldLabel>
              {modelControl}
              <FieldDescription
                id={error ? `${modelSelectId}-error` : undefined}
                role={error ? "alert" : undefined}
              >
                {error ??
                  selectedModel?.description ??
                  t("目录随所选订阅账号实时读取。", "Catalog loaded for the selected subscription.")}
              </FieldDescription>
              {!loading && (error || models.length === 0) && onRetry && (
                <Button
                  className="session-retry-models w-fit"
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRetry}
                >
                  <RefreshCw />
                  {error ? t("重试读取模型", "Retry loading models") : t("刷新模型列表", "Refresh model list")}
                </Button>
              )}
            </Field>
          ) : (
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor={modelSelectId}>
                {t("模型", "Model")}
              </label>
              {modelControl}
            </div>
          )}

          {showEffortSelect &&
            (showDescriptions ? (
              <Field>
                <FieldLabel htmlFor={effortSelectId}>{t("推理强度", "Reasoning effort")}</FieldLabel>
                {effortControl}
                <FieldDescription>
                  {selectedModel?.supportedEfforts.length
                    ? t("只显示该模型支持的档位。", "Only efforts supported by this model are shown.")
                    : t("当前模型没有可选档位。", "This model has no selectable effort levels.")}
                </FieldDescription>
              </Field>
            ) : (
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor={effortSelectId}>
                  {t("推理强度", "Reasoning effort")}
                </label>
                {effortControl}
              </div>
            ))}
        </div>
      )}

      {hasCustomSupport && (
        <details
          open={customExpanded}
          onToggle={(event) => setCustomExpanded(event.currentTarget.open)}
          className="rounded-lg border border-border/70 bg-[var(--surface-1)] px-3 py-2 text-xs"
        >
          <summary className="flex cursor-pointer items-center justify-between gap-2 font-medium text-muted-foreground select-none hover:text-foreground">
            <span>{t("高级：自定义模型 ID（可选覆盖）", "Advanced: Custom model ID (optional override)")}</span>
            {hasCustomOverride && (
              <Badge variant="secondary" className="max-w-44 truncate font-mono text-[10px]">
                {customModel}
              </Badge>
            )}
          </summary>
          <div className="mt-2.5 flex items-center gap-2">
            <Input
              id={customModelIdAttr}
              value={customModel ?? ""}
              disabled={disabled}
              placeholder={customModelPlaceholder ?? model ?? t("留空则使用上方所选模型", "Leave empty to use selected model")}
              onChange={(event) => onCustomModelChange?.(event.target.value)}
            />
            {hasCustomOverride && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={t("清除自定义模型 ID", "Clear custom model ID")}
                onClick={() => onCustomModelChange?.("")}
              >
                <X />
              </Button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
