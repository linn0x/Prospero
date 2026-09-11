import { useEffect, useRef, useState } from "react";
import type { TimelineTextPage } from "@prospero/protocol/rust-daemon";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./components/ui/dialog";
import { Spinner } from "./components/ui/spinner";
import { useLocale } from "./locale";
import { pageRequest } from "./page-request";

export function TimelineBodyDialog({ sessionId, recordId, title, onClose }: { sessionId: string; recordId: string; title: string; onClose: () => void }) {
  const { t } = useLocale();
  const [page, setPage] = useState<TimelineTextPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const read = async (part: number, generation: number | null): Promise<void> => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true); setError(false);
    try {
      const result = await pageRequest(window.prospero, request.signal, id => window.prospero.readTimelineText(sessionId, recordId, { part, generation }, id));
      if (!request.signal.aborted) setPage(result);
    } catch { if (!request.signal.aborted) setError(true); }
    finally { if (!request.signal.aborted) setLoading(false); }
  };
  useEffect(() => { void read(0, null); return () => controller.current?.abort(); }, [sessionId, recordId]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="sm:max-w-3xl">
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{t("正文按页读取，完整内容保存在本机。", "Content is read one page at a time; the complete body is stored locally.")}</DialogDescription></DialogHeader>
    {error && <p role="alert">{t("内容可能已更新或暂时无法读取。", "Content may have changed or is temporarily unavailable.")}<Button variant="ghost" size="sm" onClick={() => void read(0, null)}>{t("重新读取", "Reload")}</Button></p>}
    {loading ? <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Spinner />{t("正在读取…", "Loading…")}</div> : <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">{page?.text}</pre>}
    <DialogFooter>
      {page && <span className="mr-auto self-center text-sm text-muted-foreground">{t(`第 ${page.part + 1} 页`, `Page ${page.part + 1}`)}</span>}
      <Button variant="outline" disabled={loading} onClick={() => void read(page?.part ?? 0, page?.generation ?? null)}>{t("刷新", "Refresh")}</Button>
      {page?.previousPart !== null && page?.previousPart !== undefined && <Button variant="outline" disabled={loading} onClick={() => void read(page.previousPart!, page.generation)}>{t("上一页", "Previous page")}</Button>}
      {page?.nextPart !== null && page?.nextPart !== undefined && <Button variant="outline" disabled={loading} onClick={() => void read(page.nextPart!, page.generation)}>{t("下一页", "Next page")}</Button>}
      <Button variant="outline" onClick={onClose}>{t("关闭", "Close")}</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}
