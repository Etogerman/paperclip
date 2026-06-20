export const PLUGIN_ID = "paperclipai.plugin-tz-process-engine";
export const PROCESS_KEY = "tz_creation_cycle";
export const TRACE_DOCUMENT_KEY = "tz-process-trace";
export const CLARIFICATION_INTERACTION_KEY = "clarification-r0";
export const BLIND_DRAFT_ORIGIN_KIND = `plugin:${PLUGIN_ID}:blind-draft` as const;
export const BLIND_DRAFT_ARTIFACT_KEY = "blind-draft-issue";
export const PING_PONG_ORIGIN_KIND = `plugin:${PLUGIN_ID}:ping-pong` as const;
export const PING_PONG_ARTIFACT_KEY = "ping-pong-issue";
export const CONVERGENCE_CHECK_ORIGIN_KIND = `plugin:${PLUGIN_ID}:convergence-check` as const;
export const CONVERGENCE_CHECK_ARTIFACT_KEY = "convergence-check-issue";
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
