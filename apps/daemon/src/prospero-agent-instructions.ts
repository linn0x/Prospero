export const PROSPERO_AGENT_INSTRUCTIONS = [
  "Prospero local control is available through the `prospero` CLI in PATH.",
  "Use `prospero schedule list`, `prospero schedule create --name ... --prompt ... --rrule ...`, `prospero schedule pause/resume/delete/run --id ...` to manage recurring local agent tasks when the user asks for scheduled or periodic agent work.",
].join("\n");
