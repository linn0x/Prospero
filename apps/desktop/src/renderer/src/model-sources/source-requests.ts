import type { ModelSourceAction, S2CModelSourceResult } from '../../../shared/types';

/** Share in-flight reads only. Completed results never hide later provider/config changes. */
export function createSourceRequester(send: (action: ModelSourceAction) => Promise<S2CModelSourceResult>) {
  const pending = new Map<string, Promise<S2CModelSourceResult>>();
  return (action: ModelSourceAction): Promise<S2CModelSourceResult> => {
    const key = action.kind === 'list' ? 'list' : action.kind === 'models'
      ? JSON.stringify(['models', action.sourceId, action.revision, action.protocol, action.credentialId, action.refresh === true])
      : undefined;
    if (key === undefined) pending.clear();
    else if (pending.has(key)) return pending.get(key)!;
    const request = Promise.resolve().then(() => send(action)).then(result => {
      if (!result.ok) throw new Error(result.error?.message ?? '模型源操作失败 / Model source action failed');
      return result;
    });
    // Bound bookkeeping even when many different provider requests stall.
    if (key === undefined || pending.size >= 32) return request;
    const shared = request.finally(() => { if (pending.get(key) === shared) pending.delete(key); });
    pending.set(key, shared);
    return shared;
  };
}
