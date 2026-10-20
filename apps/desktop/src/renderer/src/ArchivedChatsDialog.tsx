import { useEffect, useState } from 'react';
import { ArchiveRestore } from 'lucide-react';
import type { SessionInfo } from '../../shared/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { useLocale } from './locale';
import { sessionLabel } from './workspace/session-presentation';
import { reportError } from './state';

export function ArchivedChatsDialog({ ids, onClose, onOpen }: { ids: string[]; onClose: () => void; onOpen: (id: string, session: SessionInfo) => void }) {
  const { t } = useLocale();
  const [items, setItems] = useState<SessionInfo[]>([]);
  const [page, setPage] = useState({ key: "", offset: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify(ids);
  const offset = page.key === key ? page.offset : 0;
  useEffect(() => {
    let cancelled = false;
    if (!ids.length) { setItems([]); setLoading(false); return; }
    setLoading(true); setError(undefined);
    void window.prospero.listSessions({ ids: ids.slice(offset, offset + 100), limit: 100 }).then(page => {
      if (cancelled) return;
      setItems(current => offset ? [...new Map([...current, ...page.items].map(item => [item.id, item])).values()] : page.items);
    }).catch(reason => { if (!cancelled) setError(reportError(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key, offset, retry]);
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="sm:max-w-xl" showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{t('已归档聊天', 'Archived chats')}</DialogTitle><DialogDescription>{t('归档只收起聊天，不会结束任务或删除历史。恢复后可继续打开。', 'Archiving hides chats without stopping tasks or deleting history. Restore a chat to continue.')}</DialogDescription></DialogHeader>
    {error && <div role="alert">{error}<Button variant="ghost" disabled={loading} onClick={() => setRetry(value => value + 1)}>{t('重试', 'Retry')}</Button></div>}
    {!loading && !items.length && !error && <p>{t('没有已归档聊天', 'No archived chats')}</p>}
    {items.filter(item => ids.includes(item.id)).map(session => <div key={session.id} className="archived-chat-row">
      <div><strong>{sessionLabel(session)}</strong><small title={session.cwd}>{session.cwd}</small></div>
      <Button size="sm" variant="outline" disabled={Boolean(busy)} aria-label={t(`恢复 ${sessionLabel(session)}`, `Restore ${sessionLabel(session)}`)} onClick={() => {
        setBusy(session.id); setError(undefined);
        void window.prospero.setSessionArchived(session.id, false).then(() => { onOpen(session.id, session); onClose(); })
          .catch(reason => setError(reportError(reason))).finally(() => setBusy(undefined));
      }}><ArchiveRestore />{t('恢复聊天', 'Restore chat')}</Button>
    </div>)}
    {loading && <p role="status">{t('正在读取…', 'Loading…')}</p>}
    {offset + 100 < ids.length && <Button variant="ghost" disabled={loading || Boolean(busy)} onClick={() => setPage({ key, offset: offset + 100 })}>{t('显示更多', 'Show more')}</Button>}
  </DialogContent></Dialog>;
}
