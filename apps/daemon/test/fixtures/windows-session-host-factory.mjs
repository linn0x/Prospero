export async function createWindowsSessionHostHandler(context) {
  await context.appendEvent({ source: "factory", output: "daemon-offline" });
  await context.emit({ source: "factory", output: "second" });
  return {
    async handleCommand() { return { ok: true, result: { ready: true } }; },
    snapshotState() { return { factory: true }; },
  };
}
