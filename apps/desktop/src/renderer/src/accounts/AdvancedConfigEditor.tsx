import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentAccountConfig, AgentAccountFeatureError, AgentReasoningEffort } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { DesktopIcon } from "../design-system/icons";
import { useLocale } from "../locale";
import { featureErrorText } from "./feature-errors";
import { AccountRequestGate, configDraftChanged, configEffortSupported } from "./account-request-state";

export function AdvancedConfigEditor({ accountId, name, onClose, onSaved }: { accountId: string; name: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useLocale();
  const [storedConfig, setConfig] = useState<AgentAccountConfig>();
  const [documentId, setDocumentId] = useState("");
  const [content, setContent] = useState("");
  const [effort, setEffort] = useState("");
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState<"load" | "save">();
  const [error, setError] = useState<AgentAccountFeatureError>();
  const [saved, setSaved] = useState(false);
  const [discard, setDiscard] = useState<"close" | "reload">();
  const [conflicted, setConflicted] = useState(false);
  const [requests] = useState(() => new AccountRequestGate());
  const phase = useRef<"load" | "save" | undefined>(undefined);
  const currentAccount = useRef(accountId);
  currentAccount.current = accountId;
  const errorRef = useRef<HTMLDivElement>(null);
  const config = storedConfig?.accountId === accountId ? storedConfig : undefined;
  const selected = config?.documents.find(document => document.id === documentId);
  const dirty = configDraftChanged(config, documentId, content, effort);
  const invalidEffort = Boolean(config && !configEffortSupported(config, effort));
  const apply = (next: AgentAccountConfig, preferredDocument = documentId) => {
    const document = next.documents.find(item => item.id === preferredDocument) ?? next.documents[0];
    setConfig(next);
    setDocumentId(document?.id ?? "");
    setContent(document?.content ?? "");
    setEffort(next.defaultEffort ?? "");
    setConflicted(false);
  };
  const load = async (preferredDocument = documentId) => {
    const token = requests.begin();
    if (token === undefined) return;
    phase.current = "load";
    setBusy("load"); setError(undefined); setSaved(false);
    try {
      if (typeof window.prospero.getAccountConfig !== "function") {
        setError({ code: "unsupported", message: "Configuration unavailable" });
        return;
      }
      const result = await window.prospero.getAccountConfig(accountId);
      if (!requests.current(token) || currentAccount.current !== accountId) return;
      if (!result.ok || !result.config) setError(result.error ?? { code: "unsupported", message: "Configuration unavailable" });
      else if (result.config.accountId !== accountId) setError({ code: "invalid_config", message: "Configuration account mismatch" });
      else apply(result.config, preferredDocument);
    } catch {
      if (requests.current(token) && currentAccount.current === accountId) setError({ code: "network", message: "Configuration unavailable" });
    } finally {
      if (requests.finish(token)) { phase.current = undefined; setBusy(undefined); }
    }
  };
  useLayoutEffect(() => {
    requests.invalidate();
    phase.current = undefined;
    setConfig(undefined); setDocumentId(""); setContent(""); setEffort("");
    setError(undefined); setSaved(false); setDiscard(undefined); setRaw(false); setConflicted(false);
    void load("");
    return () => { requests.invalidate(); phase.current = undefined; };
  }, [accountId, requests]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const save = async () => {
    if (!selected?.writable || !dirty || conflicted || invalidEffort) return;
    const token = requests.begin();
    if (token === undefined) return;
    phase.current = "save";
    setBusy("save"); setError(undefined); setSaved(false);
    try {
      if (typeof window.prospero.setAccountConfig !== "function") {
        setError({ code: "unsupported", message: "Configuration saving unavailable" });
        return;
      }
      const result = await window.prospero.setAccountConfig({
        accountId, documentId: selected.id, revision: selected.revision,
        ...(content !== selected.content ? { content } : {}),
        ...(effort !== (config?.defaultEffort ?? "") ? { defaultEffort: effort ? effort as AgentReasoningEffort : null } : {}),
      });
      if (!requests.current(token) || currentAccount.current !== accountId) return;
      if (!result.ok || !result.config) {
        setError(result.error ?? { code: "storage", message: "Save failed" });
        if (result.error?.code === "conflict") setConflicted(true);
      }
      else if (result.config.accountId !== accountId) setError({ code: "invalid_config", message: "Configuration account mismatch" });
      else { apply(result.config); setSaved(true); onSaved(); }
    } catch {
      if (requests.current(token) && currentAccount.current === accountId) setError({ code: "network", message: "Save failed" });
    } finally {
      if (requests.finish(token)) { phase.current = undefined; setBusy(undefined); }
    }
  };
  const close = () => {
    if (phase.current === "save") return;
    requests.invalidate(); phase.current = undefined; setBusy(undefined);
    dirty ? setDiscard("close") : onClose();
  };
  return <>
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className="account-config-dialog" showCloseButton={busy !== "save"} closeLabel={t("关闭", "Close")} aria-busy={Boolean(busy)}>
        <DialogHeader><DialogTitle>{t("高级配置", "Advanced configuration")} · {name}</DialogTitle><DialogDescription>{t("修改账号支持的启动配置，新会话生效。", "Edit supported account startup settings. Changes apply to new sessions.")}</DialogDescription></DialogHeader>
        {busy === "load" && <p className="account-feature-state" role="status"><DesktopIcon name="refresh" className="daemon-spinner" />{t("读取配置中…", "Loading configuration…")}</p>}
        {config && <div className="account-config-fields">
          {!config.documents.length && <p role="status">{t("这个账号没有可编辑的配置文档。", "This account does not expose any configuration documents.")}</p>}
          <Field><FieldLabel htmlFor="account-config-document">{t("配置文档", "Configuration document")}</FieldLabel>
            <NativeSelect id="account-config-document" value={documentId} disabled={Boolean(busy) || dirty} onChange={event => {
              const document = config.documents.find(item => item.id === event.target.value);
              if (document) { setDocumentId(document.id); setContent(document.content); setSaved(false); }
            }}>{config.documents.map(document => <NativeSelectOption key={document.id} value={document.id}>{document.label} · {document.format.toUpperCase()}</NativeSelectOption>)}</NativeSelect>
          </Field>
          {selected && <>
            <Field><FieldLabel htmlFor="account-default-effort">{t("默认推理强度", "Default reasoning effort")}</FieldLabel>
              <NativeSelect id="account-default-effort" value={effort} aria-invalid={invalidEffort} aria-describedby={invalidEffort ? "account-config-effort-warning" : undefined} disabled={Boolean(busy) || !selected.writable} onChange={event => { setEffort(event.target.value); setSaved(false); }}>
                <NativeSelectOption value="">{t("使用模型默认值", "Use model default")}</NativeSelectOption>
                {invalidEffort && <NativeSelectOption value={effort} disabled>{effort} · {t("已过期", "No longer supported")}</NativeSelectOption>}
                {config.supportedEfforts.map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
              </NativeSelect>
              {invalidEffort && <FieldDescription id="account-config-effort-warning">{t("已保存的强度不再受当前模型支持。保存前请选择其他强度，或使用模型默认值以清除。", "The saved effort is no longer supported by this model. Choose another value or use the model default to clear it before saving.")}</FieldDescription>}
              {!config.supportedEfforts.length && <FieldDescription>{t("当前模型或引擎未声明可选推理强度，使用模型默认值。API 模型可在模型能力中声明支持范围。", "No effort options are declared for this model or engine. API models can declare supported values in model capabilities.")}</FieldDescription>}
            </Field>
            <details open={raw} onToggle={event => setRaw(event.currentTarget.open)}>
              <summary>{t("编辑配置源文件", "Edit configuration source")} · {selected.format.toUpperCase()}</summary>
              <FieldDescription>{t("仅允许编辑：", "Editable fields: ")}{selected.editableKeys.join(", ")}{selected.generated && t(" · 由 Prospero 管理", " · Managed by Prospero")}</FieldDescription>
              <textarea className="account-config-source" aria-label={t("高级配置内容", "Advanced configuration source")} aria-invalid={Boolean(error)} aria-describedby={error ? "account-config-error" : undefined} value={content} maxLength={16_384} disabled={Boolean(busy) || !selected.writable} spellCheck={false} onChange={event => { setContent(event.target.value); setSaved(false); }} />
            </details>
            {!selected.writable && <p role="status">{t("此文档为只读预览。", "This document is a read-only preview.")}</p>}
          </>}
          <p className="account-config-effect">{t("保存后仅对新会话生效，现有会话保持当前配置。", "Saved settings apply only to new sessions; existing sessions keep their configuration.")}{config.activeSessions > 0 && t(" 当前有 " + config.activeSessions + " 个活动会话。", " Active sessions: " + config.activeSessions + ".")}</p>
        </div>}
        {error && <div ref={errorRef} id="account-config-error" className="account-inline-error" role="alert" tabIndex={-1}>{featureErrorText(error, t)}<Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => { if (dirty) setDiscard("reload"); else void load(); }}>{dirty ? t("重新加载并丢弃草稿", "Reload and discard draft") : t("重新加载", "Reload")}</Button></div>}
        {saved && <p role="status">{t("配置已保存，将用于新会话。", "Configuration saved for new sessions.")}</p>}
        <DialogFooter><Button variant="outline" disabled={busy === "save"} onClick={close}>{t("关闭", "Close")}</Button><Button disabled={Boolean(busy) || !selected?.writable || !dirty || conflicted || invalidEffort} onClick={() => void save()}>{busy === "save" && <DesktopIcon name="refresh" className="daemon-spinner" />}{busy === "save" ? t("保存中…", "Saving…") : t("保存配置", "Save configuration")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(discard)} onOpenChange={open => { if (!open) setDiscard(undefined); }}><DialogContent closeLabel={t("关闭", "Close")}><DialogHeader><DialogTitle>{t("放弃未保存的更改？", "Discard unsaved changes?")}</DialogTitle><DialogDescription>{discard === "reload" ? t("成功读取最新配置后，将替换当前草稿。", "The draft will be replaced after the latest configuration loads successfully.") : t("账号已保存的配置不会改变。", "The saved account configuration will stay unchanged.")}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscard(undefined)}>{t("继续编辑", "Keep editing")}</Button><Button onClick={() => { const action = discard; setDiscard(undefined); if (action === "reload") void load(); else onClose(); }}>{discard === "reload" ? t("重新加载", "Reload") : t("放弃更改", "Discard")}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
