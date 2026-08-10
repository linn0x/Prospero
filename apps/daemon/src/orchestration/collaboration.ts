/**
 * 编排邮箱的运行时语义。
 *
 * Store 只负责持久化消息；这里负责唤醒等待者。这样 daemon 重启不丢审计记录，
 * 但 agent 也不会为了等一条消息反复调用 CLI、空烧 token。
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Message } from "./model.js";
import { OrchestrationStore } from "./store.js";

export class CollaborationError extends Error {
  constructor(
    message: string,
    readonly code: "thread_not_found" | "not_thread_recipient" | "wait_aborted",
  ) {
    super(message);
  }
}

export interface CollaborationEvents {
  message: [message: Message];
}

export interface MailInput {
  runId: string;
  from: string;
  to: string;
  type: Message["type"];
  subject: string;
  body: string;
  threadId?: string | null;
  taskId?: string | null;
}

export interface CheckInput {
  recipient: string;
  runId?: string | undefined;
  wait?: boolean;
  signal?: AbortSignal | undefined;
}

export interface AskInput {
  runId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  taskId?: string | null;
  wait?: boolean;
  signal?: AbortSignal | undefined;
}

export interface ReplyInput {
  runId: string;
  from: string;
  to: string;
  threadId: string;
  subject: string;
  body: string;
  taskId?: string | null;
}

export class CollaborationService extends EventEmitter<CollaborationEvents> {
  constructor(private readonly store: OrchestrationStore) {
    super();
  }

  send(input: MailInput): Message {
    const message = this.store.postMessage(input);
    this.emit("message", message);
    return message;
  }

  /**
   * 读取收件箱，并把本次返回的消息标为已读。没有新消息时只有 wait:true
   * 才挂起；它在消息到达或 client 断开时立刻结束。
   */
  async check(input: CheckInput): Promise<Message[]> {
    const take = (): Message[] => this.store.unreadFor(input.recipient, input.runId);
    let messages = take();
    if (messages.length === 0 && input.wait === true) {
      messages = await this.waitUntil(
        () => {
          const next = take();
          return next.length > 0 ? next : null;
        },
        input.signal,
      );
    }
    if (messages.length > 0) this.store.markRead(messages.map((message) => message.id));
    return messages;
  }

  /** 发问后可原地等待同一 thread 的 reply，不需要发问 agent 自己轮询。 */
  async ask(input: AskInput): Promise<{ ask: Message; reply: Message | null }> {
    const threadId = `thread_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const ask = this.send({
      runId: input.runId,
      from: input.from,
      to: input.to,
      type: "ask",
      subject: input.subject,
      body: input.body,
      threadId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
    if (input.wait === false) return { ask, reply: null };
    const reply = await this.waitUntil(
      () => this.findReply(input.runId, input.from, threadId),
      input.signal,
    );
    // ask 的返回值本身就是回复已投递给调用者，不能再让下一次 check 重复报一遍。
    this.store.markRead([reply.id]);
    this.store.markAnswered(ask.id);
    return { ask, reply };
  }

  reply(input: ReplyInput): Message {
    const ask = this.store.listMessages(input.runId).find(
      (message) => message.threadId === input.threadId && message.type === "ask",
    );
    if (!ask) {
      throw new CollaborationError(`找不到提问线程 ${input.threadId}`, "thread_not_found");
    }
    if (ask.to !== input.from) {
      throw new CollaborationError("只有提问的收件人可以回复这个线程", "not_thread_recipient");
    }
    if (ask.from !== input.to) {
      throw new CollaborationError("reply 必须回给原提问者", "not_thread_recipient");
    }
    const reply = this.send({
      runId: input.runId,
      from: input.from,
      to: input.to,
      type: "reply",
      subject: input.subject,
      body: input.body,
      threadId: input.threadId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
    this.store.markAnswered(ask.id);
    return reply;
  }

  private findReply(runId: string, recipient: string, threadId: string): Message | null {
    return this.store.listMessages(runId).find(
      (message) =>
        message.type === "reply" &&
        message.threadId === threadId &&
        message.to === recipient,
    ) ?? null;
  }

  private waitUntil<T>(read: () => T | null, signal?: AbortSignal): Promise<T> {
    const immediate = read();
    if (immediate !== null) return Promise.resolve(immediate);
    if (signal?.aborted) {
      return Promise.reject(new CollaborationError("等待消息已取消", "wait_aborted"));
    }
    return new Promise<T>((resolve, reject) => {
      const finish = (result: T | null, error?: Error): void => {
        this.off("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else if (result !== null) resolve(result);
      };
      // 同一个 daemon 里可能同时有几十个 worker 等信；别人的消息不能把当前
      // waiter 从事件队列里摘掉，否则它会永远等不到真正属于自己的那一封。
      const onMessage = (): void => {
        const match = read();
        if (match !== null) finish(match);
      };
      const onAbort = (): void => finish(null, new CollaborationError("等待消息已取消", "wait_aborted"));
      this.on("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
      // `read()` 和 `on()` 之间可能正好有一条消息落库；再查一次堵住这条缝。
      const raced = read();
      if (raced !== null) finish(raced);
    });
  }
}
