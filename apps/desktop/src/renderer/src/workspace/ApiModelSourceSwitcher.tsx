import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { JsonObject, ModelSourceRoute, SessionInfo } from "../../../shared/types";
import { accountEngine } from "../../../shared/account-capabilities";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Field, FieldLabel } from "../components/ui/field";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { useLocale } from "../locale";
import { SourceSelector } from "../model-sources/SourceSelector";
import { defaultSourceSelection, selectedSourceRoute, type SourceRuntimeAgent, type SourceSelection } from "../model-sources/source-state";
import { useModelSources } from "../model-sources/use-model-sources";
import { reportError } from "../state";

const ENGINE_LABELS: Record<SourceRuntimeAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  agy: "Antigravity (agy)",
};

export function compatibleEnginesForProtocol(protocol: ModelSourceRoute["protocol"], isPty = false): SourceRuntimeAgent[] {
  if (protocol === "anthropic") return ["claude", "pi"];
  if (protocol === "openai_responses") return ["codex", "pi"];
  return isPty ? ["pi", "agy"] : ["opencode", "pi", "agy"];
}

function normalizeEngine(value: string | undefined): SourceRuntimeAgent {
  if (value === "claude" || value === "codex" || value === "opencode" || value === "pi" || value === "agy") {
    return value;
  }
  return "codex";
}

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function resolveRouteEffort(route: ModelSourceRoute, candidate: string | undefined, fallbackToDefault: boolean): string | undefined {
  if (route.protocol === "openai_chat_completions") return undefined;
  const supported = route.modelCapabilities?.supportedEfforts ?? [];
  if (candidate && supported.some((level) => level === candidate)) return candidate;
  return fallbackToDefault ? route.defaultEffort : undefined;
}

export function ApiModelSourceSwitcher({ session, account, triggerSize = "sm" }: { session: SessionInfo; account: JsonObject | undefined; triggerSize?: "sm" | "xs" }) {
  const { t } = useLocale();
  const isPty = session.kind === "pty";
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<SourceSelection | undefined>();
  const currentEngine = normalizeEngine(account ? accountEngine(account) : session.agent);
  const [targetAgent, setTargetAgent] = useState<SourceRuntimeAgent>(currentEngine);
  const [effort, setEffort] = useState<string | undefined>(session.agentControls?.currentEffort || session.effort);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const initializedForOpen = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const sourceState = useModelSources(open);
  const sourceMeta = record(account?.["modelSource"]);
  const boundSourceId = typeof sourceMeta["sourceId"] === "string" ? sourceMeta["sourceId"] : undefined;
  const boundRouteId = typeof sourceMeta["routeId"] === "string" ? sourceMeta["routeId"] : undefined;
  const boundSourceName = typeof sourceMeta["sourceName"] === "string" ? sourceMeta["sourceName"] : undefined;
  const boundRouteName = typeof sourceMeta["routeName"] === "string" ? sourceMeta["routeName"] : undefined;
  const boundCredentialId = typeof sourceMeta["credentialId"] === "string" ? sourceMeta["credentialId"] : undefined;
  const boundCredentialName = typeof sourceMeta["credentialName"] === "string" ? sourceMeta["credentialName"] : undefined;
  const multiCredential = sourceMeta["multiCredential"] === true;

  const currentModel = session.agentControls?.currentModel || session.model;
  const chipLabel = useMemo(() => {
    const baseLabel = currentModel?.split("/").at(-1) || boundRouteName || t("模型源", "Model source");
    return multiCredential && boundCredentialName ? `${baseLabel} · ${boundCredentialName}` : baseLabel;
  }, [boundCredentialName, boundRouteName, currentModel, multiCredential, t]);
  const triggerTitle = useMemo(() => {
    const parts = [
      boundSourceName && boundRouteName ? `${boundSourceName} / ${boundRouteName}` : undefined,
      boundCredentialName,
      currentModel,
      ENGINE_LABELS[currentEngine],
    ].filter(Boolean);
    return parts.join(" · ") || t("切换模型源 / 模型", "Switch model source / model");
  }, [boundCredentialName, boundRouteName, boundSourceName, currentEngine, currentModel, t]);

  const unavailable = isPty
    ? session.status === "starting"
    : session.status === "starting" || ["failed", "cancelled", "exited", "stopped"].includes(session.status);
  const sessionBusy = !isPty && ["running", "waiting_approval", "waiting_input"].includes(session.status);

  useEffect(() => {
    if (!open || sourceState.loading || initializedForOpen.current) return;
    initializedForOpen.current = true;
    const matchedSource = boundSourceId ? sourceState.sources.find((item) => item.id === boundSourceId) : undefined;
    const matchedRoute = matchedSource && boundRouteId ? matchedSource.routes.find((item) => item.id === boundRouteId) : undefined;
    const initialCredentialId = matchedSource && matchedRoute && boundCredentialId
      && boundCredentialId !== matchedRoute.credentialId
      && matchedSource.credentials.some((item) => item.id === boundCredentialId)
      ? boundCredentialId
      : undefined;
    const initialSelection = matchedSource && matchedRoute && matchedSource.enabled && matchedRoute.enabled && matchedRoute.modelCapabilities?.tools !== false
      ? { sourceId: matchedSource.id, routeId: matchedRoute.id, revision: matchedSource.revision, ...(initialCredentialId ? { credentialId: initialCredentialId } : {}) }
      : defaultSourceSelection(sourceState.sources, boundSourceId && boundRouteId ? { sourceId: boundSourceId, routeId: boundRouteId, ...(boundCredentialId ? { credentialId: boundCredentialId } : {}) } : undefined);
    setSelection(initialSelection);
    if (initialSelection) {
      const choice = selectedSourceRoute(sourceState.sources, initialSelection);
      if (choice) {
        const compatible = compatibleEnginesForProtocol(choice.route.protocol, isPty);
        const nextAgent = compatible.includes(currentEngine) ? currentEngine : compatible[0]!;
        setTargetAgent(nextAgent);
        const activeEffort = session.agentControls?.currentEffort || session.effort;
        setEffort(resolveRouteEffort(choice.route, activeEffort, true));
      }
    }
  }, [boundCredentialId, boundRouteId, boundSourceId, currentEngine, isPty, open, session.agentControls?.currentEffort, session.effort, sourceState.loading, sourceState.sources]);

  const choice = selectedSourceRoute(sourceState.sources, selection);
  const compatibleEngines = useMemo(
    () => choice ? compatibleEnginesForProtocol(choice.route.protocol, isPty) : [currentEngine],
    [choice, currentEngine, isPty],
  );
  const activeEngine = compatibleEngines.includes(targetAgent) ? targetAgent : compatibleEngines[0]!;
  const engineSupportsEffort = activeEngine !== "opencode" && activeEngine !== "agy";
  const isSameEngine = activeEngine === currentEngine;
  const hasNativeMigration = isSameEngine && (activeEngine === "claude" || activeEngine === "pi" || activeEngine === "agy");

  const handleSelectionChange = (next: SourceSelection | undefined) => {
    setSelection(next);
    setError(undefined);
    if (!next) return;
    const nextChoice = selectedSourceRoute(sourceState.sources, next);
    if (!nextChoice) return;
    const compatible = compatibleEnginesForProtocol(nextChoice.route.protocol, isPty);
    const nextAgent = compatible.includes(activeEngine)
      ? activeEngine
      : compatible.includes(currentEngine)
        ? currentEngine
        : compatible[0]!;
    setTargetAgent(nextAgent);
    setEffort((previous) => resolveRouteEffort(nextChoice.route, previous, true));
  };

  const apply = async (): Promise<void> => {
    if (!selection || !choice || saving || unavailable || sessionBusy) return;
    setSaving(true);
    setError(undefined);
    try {
      const effectiveEffort = engineSupportsEffort ? resolveRouteEffort(choice.route, effort, false) : undefined;
      const result = await window.prospero.switchAgentModelSource(session.id, {
        sourceId: selection.sourceId,
        routeId: selection.routeId,
        revision: selection.revision,
        ...(selection.credentialId ? { credentialId: selection.credentialId } : {}),
        agent: activeEngine,
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      });
      if (!mounted.current) return;
      setNotice(
        isPty
          ? t("已切换模型源并重启终端", "Model source switched and terminal restarted")
          : result.handoffMode === "timeline_handoff"
            ? t("已切换模型源，下一轮将携带上下文接续", "Model source switched; next turn will continue with handoff context")
            : t("模型源已切换，下一轮生效", "Model source switched for the next turn"),
      );
      setOpen(false);
    } catch (reason) {
      if (mounted.current) setError(reportError(reason));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const openDialog = () => {
    initializedForOpen.current = false;
    setError(undefined);
    setNotice(undefined);
    setTargetAgent(currentEngine);
    setEffort(session.agentControls?.currentEffort || session.effort);
    setOpen(true);
  };

  return <>
    <Button
      className="session-model-chip"
      variant="outline"
      size={triggerSize}
      disabled={unavailable}
      aria-label={t("切换模型源或模型", "Switch model source or model")}
      title={triggerTitle}
      onClick={openDialog}
    >
      <span>{chipLabel}</span>
      <ChevronDown />
    </Button>
    {notice && <span className="sr-only" role="status">{notice}</span>}
    <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
      <DialogContent className="session-model-dialog sm:max-w-xl" showCloseButton={!saving} closeLabel={t("关闭", "Close")} aria-busy={sourceState.loading || saving}>
        <DialogHeader>
          <DialogTitle>{t("切换模型源 / 模型", "Switch model source / model")}</DialogTitle>
          <DialogDescription>
            {isPty
              ? t("可切换为同引擎或跨引擎的 API 模型源路由；确认后将原地重启 TUI 终端生效。", "Switch to any enabled same-engine or cross-engine API model source route; the TUI terminal restarts in-place.")
              : t("可切换为同引擎或跨引擎的 API 模型源路由，下一轮生效。", "Switch to any enabled same-engine or cross-engine API model source route for the next turn.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <SourceSelector
            sources={sourceState.sources}
            loading={sourceState.loading}
            error={sourceState.error}
            value={selection}
            effort={engineSupportsEffort ? effort : undefined}
            onEffortChange={engineSupportsEffort ? setEffort : undefined}
            onChange={handleSelectionChange}
            onRefresh={() => void sourceState.refresh()}
            disabled={saving}
          />
          {choice && (
            <Field>
              <FieldLabel htmlFor="session-source-engine">{t("执行引擎", "Execution engine")}</FieldLabel>
              <NativeSelect
                id="session-source-engine"
                value={activeEngine}
                disabled={saving || sourceState.loading}
                aria-label={t("执行引擎", "Execution engine")}
                onChange={(event) => setTargetAgent(normalizeEngine(event.target.value))}
              >
                {compatibleEngines.map((engine) => (
                  <NativeSelectOption key={engine} value={engine}>
                    {ENGINE_LABELS[engine]}{engine === currentEngine ? t("（当前引擎）", " (current)") : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          {sessionBusy ? (
            <div className="workspace-action-error" role="alert">
              {t("当前轮仍在运行，请等待当前轮结束或中断后再切换模型源。", "A turn is currently running. Wait for it to finish or interrupt before switching model sources.")}
            </div>
          ) : choice && (
            <p className="text-xs text-muted-foreground" role="note">
              {isPty
                ? hasNativeMigration
                  ? t("同引擎切换将重启终端并保留原生上下文。", "Same-engine switch will restart the terminal and preserve native context.")
                  : t("切换将原地重启终端并以新上下文继续。", "Switching will restart the terminal in-place with a fresh session context.")
                : hasNativeMigration
                  ? t("同引擎切换，保留原生上下文，下一轮生效。", "Same-engine switch: preserves native transcript for the next turn.")
                  : isSameEngine
                    ? t("同引擎切换，将携带当前会话历史上下文接续，下一轮生效。", "Same-engine switch: continues with session history handoff on the next turn.")
                    : t(
                        `跨引擎切换（${ENGINE_LABELS[currentEngine]} → ${ENGINE_LABELS[activeEngine]}），将携带当前会话历史上下文无缝接续，下一轮生效。`,
                        `Cross-engine switch (${ENGINE_LABELS[currentEngine]} → ${ENGINE_LABELS[activeEngine]}): continues seamlessly with session history handoff on the next turn.`,
                      )}
            </p>
          )}
          {error && <div className="workspace-action-error" role="alert">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button disabled={saving || sourceState.loading || !choice || !selection || unavailable || sessionBusy} onClick={() => void apply()}>
            {saving
              ? t("正在切换…", "Switching…")
              : isPty
                ? t("切换并重启终端", "Switch & restart terminal")
                : t("应用到下一轮", "Apply to next turn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
