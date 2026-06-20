export const PLUGIN_ID = "paperclipai.plugin-tz-process-engine";
export const PROCESS_KEY = "tz_creation_cycle";
export const TRACE_DOCUMENT_KEY = "tz-process-trace";
export const CLARIFICATION_INTERACTION_KEY = "clarification-r0";
export const DEFAULT_MAX_ROUNDS = 6;
export const DEFAULT_QA_REWORK_LIMIT = 2;

export const ACTIVE_RUN_STATUSES = [
  "intake",
  "clarifying",
  "drafting",
  "iterating",
  "needs_operator",
  "synthesizing",
  "qa",
  "reworking",
  "final_ready",
] as const;

export const TERMINAL_RUN_STATUSES = [
  "accepted",
  "returned",
  "cancelled",
  "failed",
] as const;

export type TzProcessStatus =
  | (typeof ACTIVE_RUN_STATUSES)[number]
  | (typeof TERMINAL_RUN_STATUSES)[number];
