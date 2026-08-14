import { pino, type DestinationStream, type Logger } from "pino";

const REDACT_PATHS: string[] = [
  "token",
  "hostSecret",
  "credentialDigest",
  "ticket",
  "authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "*.token",
  "*.hostSecret",
  "*.credentialDigest",
  "*.ticket",
] as const;

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: null,
    redact: {
      paths: REDACT_PATHS,
      censor: "[redacted]",
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
