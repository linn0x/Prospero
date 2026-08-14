import { pino, type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: null,
    redact: {
      paths: [
        "token",
        "hostSecret",
        "authorization",
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.authorization",
      ],
      censor: "[redacted]",
    },
  });
}
