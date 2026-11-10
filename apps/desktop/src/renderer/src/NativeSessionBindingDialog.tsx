import { useEffect, useState } from "react";
import type { ResumableConversation } from "@prospero/protocol/rust-daemon";
import type { SessionInfo } from "../../shared/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { reportError } from "./state";
import { useLocale } from "./locale";

import { needsNativeBinding } from "../../shared/session-state";

export { needsNativeBinding };

export function NativeSessionBindingDialog({ session, archived, onClose, onDone }: { session: SessionInfo; archived: boolean; onClose(): void; onDone(session: SessionInfo): void }) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ResumableConversation[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true); setError(undefined); setSelected(undefined);
      void window.prospero.nativeConversationCandidates(session.id, query).then(items => { if (!cancelled) setItems(items); })
        .catch(error => { if (!cancelled) setError(reportError(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [session.id, query]);
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{t("绑定原生对话", "Link native conversation")}</DialogTitle>
      <DialogDescription>{t("旧终端没有记录对话 ID。请选择正在使用的那条对话，系统会保留它的历史供以后继续。", "This older terminal has no conversation ID. Select its conversation to preserve its history for resuming.")}</DialogDescription></DialogHeader>
    <Input aria-label={t("搜索原生对话", "Search native conversations")} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} placeholder={t("搜索标题或粘贴对话 ID", "Search title or paste conversation ID")} />
    <div className="max-h-64 overflow-y-auto space-y-2">{items.map(item => <Button key={item.id} variant={selected === item.id ? "secondary" : "outline"} className="h-auto w-full justify-start whitespace-normal text-left" disabled={busy} onClick={() => setSelected(item.id)}>
      <span><strong>{item.title}</strong><small className="block text-muted-foreground">{item.id}</small><small className="block">{item.preview?.slice(0, 160)}</small></span>
    </Button>)}</div>
    {loading && <p role="status">{t("正在读取…", "Loading…")}</p>}
    {!loading && !items.length && <p>{t("没有匹配的对话。可粘贴原生对话 ID 重新查询。", "No matching conversation. Try its native ID.")}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-2 justify-end">
      <Button variant="outline" disabled={busy || loading} onClick={() => {
        setBusy(true); setError(undefined);
        void window.prospero.setSessionArchived(session.id, archived).then(snapshot => onDone(snapshot.daemon.sessions.find(item => item.id === session.id) ?? { ...session, archived })).catch(error => setError(reportError(error))).finally(() => setBusy(false));
      }}>{archived ? t("不绑定，直接归档", "Archive without linking") : t("不绑定，直接恢复", "Resume without linking")}</Button>
      <Button disabled={!selected || busy || loading} onClick={() => {
        setBusy(true); setError(undefined);
        void window.prospero.setSessionArchived(session.id, archived, selected).then(snapshot => onDone(snapshot.daemon.sessions.find(item => item.id === session.id) ?? { ...session, archived })).catch(error => setError(reportError(error))).finally(() => setBusy(false));
      }}>{busy ? t("正在处理…", "Working…") : archived ? t("确认绑定，停止并归档", "Link, stop and archive") : t("确认绑定，继续对话", "Link and resume")}</Button>
    </div>
  </DialogContent></Dialog>;
}
