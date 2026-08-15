/**
 * A deliberately small stand-in for the daemon process used by the real
 * Windows acceptance test. It uses the normal Session Host client, then
 * either exits cleanly or remains attached until the test terminates its
 * exact PID+FILETIME through the native boundary.
 */
const clientModule = process.env.PROSPERO_SESSION_HOST_CLIENT_MODULE;
const manifestJson = process.env.PROSPERO_SESSION_HOST_MANIFEST;
const operation = process.env.PROSPERO_SESSION_HOST_DAEMON_OPERATION;
const exitMode = process.env.PROSPERO_SESSION_HOST_DAEMON_EXIT_MODE;

if (typeof clientModule !== "string" || typeof manifestJson !== "string" ||
  (operation !== "send" && operation !== "observe") ||
  (exitMode !== "graceful" && exitMode !== "hold")) {
  throw new Error("Windows Session Host daemon probe configuration is invalid");
}

const { attachWindowsSessionHost } = await import(clientModule);
const manifest = JSON.parse(manifestJson);
const client = await attachWindowsSessionHost(manifest);

let result = null;
if (operation === "send") {
  await client.acquireMutationLease();
  result = await client.command("structured.send", { text: "fake agent is waiting offline" }, true, "daemon-send-once");
} else {
  const replay = await client.replay(0);
  result = { lastSeq: replay.lastSeq, events: replay.events.length };
}

process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, result })}\n`);
if (exitMode === "graceful") {
  await client.dispose();
  process.exit(0);
}

setInterval(() => {}, 1_000);
