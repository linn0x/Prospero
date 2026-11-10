import { useEffect, useRef, useState } from 'react';
import { ArchiveRestore } from 'lucide-react';
import type { SessionInfo } from '../../shared/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { useLocale } from './locale';
import { sessionLabel } from './workspace/session-presentation';
import { reportError } from './state';
import { NativeSessionBindingDialog, needsNativeBinding } from './NativeSessionBindingDialog';

export function ArchivedChatsDialog({ ids, onClose, onOpen }: { ids: string[]; onClose: () => void; onOpen: (id: string, session: SessionInfo) => void }) {
  const { t } = useLocale();
  const [items, setItems] = useState<SessionInfo[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [binding, setBinding] = useState<SessionInfo>();
  const [retry, setRetry] = useState(0);
  const key = ids.join(",");
  const previousKey = useRef(key);
  useEffect(() => {
    const keyChanged = previousKey.current !== key;
    previousKey.current = key;
    if (keyChanged && cursor !== undefined) {
      setCursor(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true); setError(undefined);
    void window.prospero.listSessions({ terminal: true, ...(cursor ? {cursor} : {}), limit: 100 }).then(page => {
      if (cancelled) return;
      setItems(current => cursor ? [...new Map([...current, ...page.items].map(item => [item.id, item])).values()] : page.items);
      setNext(page.nextCursor);
    }).catch(error => { if (!cancelled) setError(reportError(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key, cursor, retry]);
  if (binding) return <NativeSessionBindingDialog session={binding} archived={false} onClose={() => setBinding(undefined)} onDone={session => { onOpen(session.id, session); onClose(); }} />;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="sm:max-w-xl" showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{t('已归档聊天', 'Archived chats')}</DialogTitle><DialogDescription>{t('归档会释放运行资源并保留历史。查看历史不会启动任务；点击继续对话可恢复原生上下文。', 'Archived chats release runtime resources and retain history. Viewing history does not start a task; resume to continue its native context.')}</DialogDescription></DialogHeader>
    {error && <div role="alert">{error}<Button variant="ghost" disabled={loading} onClick={() => setRetry(value => value + 1)}>{t('重试', 'Retry')}</Button></div>}
    {!loading && !items.length && !error && <p>{t('没有已归档聊天', 'No archived chats')}</p>}
    {items.filter(session => session.archived !== false).map(session => <div key={session.id} className="archived-chat-row">
      <div><strong>{sessionLabel(session)}</strong><small title={session.cwd}>{session.cwd}</small></div>
      <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => { onOpen(session.id, session); onClose(); }}>{t('查看历史', 'View history')}</Button>
      <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => {
        if (needsNativeBinding(session)) { setBinding(session); return; }
        setBusy(session.id); setError(undefined);
        void window.prospero.setSessionArchived(session.id, false).then(snapshot => { onOpen(session.id, snapshot.daemon.sessions.find(item => item.id === session.id) ?? { ...session, archived: false }); onClose(); })
          .catch(error => setError(reportError(error))).finally(() => setBusy(undefined));
      }}><ArchiveRestore />{t('继续对话', 'Resume')}</Button>
    </div>)}
    {loading && <p role="status">{t('正在读取…', 'Loading…')}</p>}
    {next && <Button variant="ghost" disabled={loading || Boolean(busy)} onClick={() => setCursor(next)}>{t('显示更多', 'Show more')}</Button>}
  </DialogContent></Dialog>;
}
