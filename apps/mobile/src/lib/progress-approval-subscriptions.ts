import type { S2CAgentEvent, S2CChatSnapshot } from "@prospero/protocol";

import type { HostConnection } from "./connection";

type ProgressConnection = Pick<HostConnection, "events" | "attach" | "isConnected">;

interface HostSubscription {
  connection: ProgressConnection;
  targets: ReadonlySet<string>;
  attached: Set<string>;
  dispose(): void;
}

/** Only the Android background overlay needs approval bodies, never the status notification. */
export function needsProgressApprovalSubscription(
  platform: string,
  backgroundProgressEnabled: boolean,
  overlayProgressEnabled: boolean,
  appState: string,
  canDisplayOverlay: boolean,
): boolean {
  return platform === "android" && backgroundProgressEnabled && overlayProgressEnabled &&
    appState !== "active" && canDisplayOverlay;
}

/** Keep each pending session attached once per connection, without replaying its peers. */
export class ProgressApprovalSubscriptions {
  private readonly hosts = new Map<string, HostSubscription>();

  constructor(private readonly handlers: {
    snapshot(hostId: string, message: S2CChatSnapshot): void;
    event(hostId: string, message: S2CAgentEvent): void;
  }) {}

  update(
    targets: ReadonlyMap<string, ReadonlySet<string>>,
    getConnection: (hostId: string) => ProgressConnection | null,
  ): void {
    for (const [hostId, subscription] of this.hosts) {
      if (!targets.get(hostId)?.size || getConnection(hostId) !== subscription.connection) {
        subscription.dispose();
        this.hosts.delete(hostId);
      }
    }
    for (const [hostId, sessions] of targets) {
      if (!sessions.size) continue;
      const connection = getConnection(hostId);
      if (!connection) continue;
      let subscription = this.hosts.get(hostId);
      if (!subscription) {
        let disposed = false;
        const off: (() => void)[] = [];
        const created: HostSubscription = {
          connection,
          targets: sessions,
          attached: new Set(),
          dispose() {
            disposed = true;
            for (const unsubscribe of off) unsubscribe();
          },
        };
        off.push(connection.events.on("chatSnapshot", (message) => {
          if (!disposed && created.targets.has(message.sid)) this.handlers.snapshot(hostId, message);
        }));
        off.push(connection.events.on("agentEvent", (message) => {
          if (disposed || !created.targets.has(message.sid)) return;
          if (
            message.body.kind === "permission.request" ||
            message.body.kind === "permission.resolved" ||
            message.body.kind === "permission.auto"
          ) this.handlers.event(hostId, message);
        }));
        off.push(connection.events.on("connected", () => {
          if (disposed) return;
          created.attached.clear();
          this.attachMissing(created);
        }));
        this.hosts.set(hostId, created);
        subscription = created;
      }
      subscription.targets = sessions;
      for (const sid of subscription.attached) {
        if (!sessions.has(sid)) subscription.attached.delete(sid);
      }
      this.attachMissing(subscription);
    }
  }

  dispose(): void {
    for (const subscription of this.hosts.values()) subscription.dispose();
    this.hosts.clear();
  }

  private attachMissing(subscription: HostSubscription): void {
    if (!subscription.connection.isConnected) return;
    for (const sid of subscription.targets) {
      if (subscription.attached.has(sid)) continue;
      subscription.attached.add(sid);
      subscription.connection.attach(sid);
    }
  }
}
