import type { AgentAccountFeatureError as FeatureError } from "@prospero/protocol";

export class AgentAccountFeatureError extends Error {
  constructor(readonly code: FeatureError["code"], message: string, readonly line?: number, readonly column?: number) {
    super(message);
    this.name = "AgentAccountFeatureError";
  }

  toJSON(): FeatureError {
    return { code: this.code, message: this.message, ...(this.line ? { line: this.line } : {}), ...(this.column ? { column: this.column } : {}) };
  }
}
