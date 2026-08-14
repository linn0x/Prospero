/** Goal 协调者首提示的持久化、至少一次投递。 */
import { OrchestrationStore } from "./store.js";

export interface GoalPromptSessionManager {
  chatSend(sid: string, text: string): Promise<void>;
}

export type GoalCoordinatorPrompt = (runId: string, objective: string) => string;

/**
 * Run 在投递提示前就记为 pending。若 daemon 在 send 的确认前退出，下一次启动会
 * 重投这条首提示：可能重复一次，但绝不把一个已经创建的 Goal 永久饿死。
 */
export class GoalInitializationService {
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly store: OrchestrationStore,
    private readonly sessions: GoalPromptSessionManager,
    private readonly promptFor: GoalCoordinatorPrompt,
  ) {}

  async deliver(runId: string): Promise<boolean> {
    const running = this.inFlight.get(runId);
    if (running) return running;
    const delivery = this.deliverOnce(runId).finally(() => this.inFlight.delete(runId));
    this.inFlight.set(runId, delivery);
    return delivery;
  }

  /** daemon 启动恢复、定时重试都走同一条幂等路径。 */
  async retryPending(): Promise<void> {
    const pending = this.store.pendingCoordinatorPrompts();
    if (pending.length === 0) return;
    const results = await Promise.all(pending.map((run) => this.deliver(run.id)));
    if (results.some((delivered) => !delivered)) this.scheduleRetry();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async deliverOnce(runId: string): Promise<boolean> {
    const run = this.store.getRun(runId);
    if (
      run.status !== "active" ||
      run.coordinatorSessionId === null ||
      run.coordinatorPrompt?.state !== "pending"
    ) {
      return false;
    }

    this.store.recordCoordinatorPromptAttempt(runId);
    // 首提示是新建 Goal 唯一的启动指令。真正交给 agent 前先同步落盘 pending，
    // 即使进程随后在 RPC 中崩溃，下次启动也会知道必须再投一次。
    this.store.persistNow();
    try {
      await this.sessions.chatSend(run.coordinatorSessionId, this.promptFor(run.id, run.objective));
      this.store.markCoordinatorPromptDelivered(runId);
      this.store.persistNow();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.markCoordinatorPromptFailed(runId, message);
      this.store.persistNow();
      console.error(`[prosperod] Goal ${run.id} 的协调者提示投递失败，稍后重试:`, error);
      this.scheduleRetry();
      return false;
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    // 失败细节已落盘；短延迟处理瞬态后端重连，重启则会立即再试。
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.retryPending();
    }, 1_000);
    this.retryTimer.unref?.();
  }
}
