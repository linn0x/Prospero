import type { DesktopApi } from "../../shared/types";
import { RequestQueue } from "./request-queue";

export const desktopPageRequests = new RequestQueue();

export async function pageRequest<T>(api: Pick<DesktopApi, "cancelSessionPage">, signal: AbortSignal, operation: (id: string) => Promise<T>, queue = desktopPageRequests): Promise<T> {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  let started = false;
  const cancel = (): void => { if (started) void api.cancelSessionPage(id).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try { return await queue.run(signal, () => { signal.throwIfAborted(); started = true; return operation(id); }); }
  finally { signal.removeEventListener("abort", cancel); }
}
