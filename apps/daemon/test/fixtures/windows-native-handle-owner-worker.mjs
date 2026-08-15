import { parentPort } from "node:worker_threads";
import { loadWindowsNative } from "@prospero/windows-native";

if (parentPort === null) throw new Error("native handle-owner fixture requires a parent port");

const native = loadWindowsNative();
let job = null;

function activeJob() {
  if (job === null) throw new Error("fixture Job Object is not active");
  return job;
}

parentPort.on("message", (message) => {
  try {
    let token;
    switch (message?.op) {
      case "create":
        if (job !== null) throw new Error("fixture Job Object already exists");
        job = native.createJobObject({ killOnClose: true });
        token = job;
        break;
      case "foreignTerminate":
        native.terminateJobObject(message.token, 0);
        break;
      case "probe":
        // An empty Job accepts termination. This proves the other worker's
        // cleanup neither closed nor removed this environment's token.
        native.terminateJobObject(activeJob(), 0);
        break;
      case "close":
        native.closeJobObject(activeJob());
        job = null;
        break;
      default:
        throw new Error("unknown fixture operation");
    }
    parentPort.postMessage({ id: message?.id, ok: true, token });
  } catch (error) {
    parentPort.postMessage({
      id: message?.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
