import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginEvent,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_QA_REWORK_LIMIT,
  PROCESS_KEY,
  TRACE_DOCUMENT_KEY,
  type TzProcessStatus,
} from "./constants.js";

type TzProcessRunRow = {
  id: string;
  company_id: string;
  root_issue_id: string;
  process_key: string;
  status: TzProcessStatus;
  state: string;
  current_round: number;
  max_rounds: number;
  qa_rework_limit: number;
  idempotency_key: string;
  operator_input: unknown;
  selected_agents: unknown;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
};

type TzProcessRunSummary = {
  id: string;
  companyId: string;
  rootIssueId: string;
  processKey: string;
  status: TzProcessStatus;
  state: string;
  currentRound: number;
  maxRounds: number;
  qaReworkLimit: number;
  idempotencyKey: string;
  operatorInput: unknown;
  selectedAgents: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type TzProcessStatusResult = {
  issueId: string;
  companyId: string;
  databaseNamespace: string;
  run: TzProcessRunSummary | null;
  pendingInteractions: Array<{
    id: string;
    kind: string;
    status: string;
    title?: string | null;
    summary?: string | null;
  }>;
};

type StartCycleInput = {
  companyId: string;
  issueId: string;
  task?: string | null;
  context?: string | null;
  projectId?: string | null;
  idempotencyKey?: string | null;
  maxRounds?: number | null;
  qaReworkLimit?: number | null;
  source?: string | null;
};

let activeContext: PluginContext | null = null;
let startCycle: ((input: StartCycleInput) => Promise<TzProcessStatusResult>) | null = null;
let readStatus: ((companyId: string, issueId: string) => Promise<TzProcessStatusResult>) | null = null;

function tableName(ctx: PluginContext, table: "tz_process_runs" | "tz_process_events" | "tz_process_artifacts") {
  return `${ctx.db.namespace}.${table}`;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeRun(row: TzProcessRunRow): TzProcessRunSummary {
  return {
    id: row.id,
    companyId: row.company_id,
    rootIssueId: row.root_issue_id,
    processKey: row.process_key,
    status: row.status,
    state: row.state,
    currentRound: row.current_round,
    maxRounds: row.max_rounds,
    qaReworkLimit: row.qa_rework_limit,
    idempotencyKey: row.idempotency_key,
    operatorInput: row.operator_input,
    selectedAgents: row.selected_agents,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function latestRunForIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<TzProcessRunSummary | null> {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE company_id = $1 AND root_issue_id = $2
      ORDER BY started_at DESC
      LIMIT 1`,
    [companyId, issueId],
  );
  return rows[0] ? normalizeRun(rows[0]) : null;
}

async function activeRunForIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<TzProcessRunSummary | null> {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE company_id = $1
        AND root_issue_id = $2
        AND status NOT IN ('accepted', 'returned', 'cancelled', 'failed')
      ORDER BY started_at DESC
      LIMIT 1`,
    [companyId, issueId],
  );
  return rows[0] ? normalizeRun(rows[0]) : null;
}

async function runByIdempotencyKey(ctx: PluginContext, companyId: string, idempotencyKey: string): Promise<TzProcessRunSummary | null> {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE company_id = $1 AND idempotency_key = $2
      LIMIT 1`,
    [companyId, idempotencyKey],
  );
  return rows[0] ? normalizeRun(rows[0]) : null;
}

async function appendEvent(
  ctx: PluginContext,
  input: { runId: string; companyId: string; eventType: string; payload?: Record<string, unknown> },
) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx, "tz_process_events")} (id, run_id, company_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      randomUUID(),
      input.runId,
      input.companyId,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

function traceDocumentBody(input: { issueTitle: string; run: TzProcessRunSummary }) {
  return [
    "# TZ Process Trace",
    "",
    `Issue: ${input.issueTitle}`,
    `Run ID: ${input.run.id}`,
    `Status: ${input.run.status}`,
    `State: ${input.run.state}`,
    `Round: ${input.run.currentRound}`,
    `Max rounds: ${input.run.maxRounds}`,
    `QA rework limit: ${input.run.qaReworkLimit}`,
    "",
    "This document is owned by the TZ Process Engine plugin. It records the visible process state; authoritative state lives in the plugin database namespace.",
  ].join("\n");
}

async function writeTraceDocument(ctx: PluginContext, issueId: string, companyId: string, issueTitle: string, run: TzProcessRunSummary) {
  await ctx.issues.documents.upsert({
    issueId,
    companyId,
    key: TRACE_DOCUMENT_KEY,
    title: "TZ Process Trace",
    format: "markdown",
    body: traceDocumentBody({ issueTitle, run }),
    changeSummary: "Recorded TZ process run state",
  });
}

async function buildStatus(ctx: PluginContext, companyId: string, issueId: string): Promise<TzProcessStatusResult> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);
  const run = await latestRunForIssue(ctx, companyId, issueId);
  const pendingInteractions = await ctx.issues.interactions.list(issueId, companyId, {
    status: "pending",
    limit: 20,
  });
  return {
    issueId,
    companyId,
    databaseNamespace: ctx.db.namespace,
    run,
    pendingInteractions: pendingInteractions.map((interaction) => ({
      id: interaction.id,
      kind: interaction.kind,
      status: interaction.status,
      title: interaction.title ?? null,
      summary: interaction.summary ?? null,
    })),
  };
}

async function handleStart(ctx: PluginContext, input: StartCycleInput): Promise<TzProcessStatusResult> {
  const issue = await ctx.issues.get(input.issueId, input.companyId);
  if (!issue) throw new Error(`Issue not found: ${input.issueId}`);

  const runId = randomUUID();
  const maxRounds = positiveInt(input.maxRounds, DEFAULT_MAX_ROUNDS);
  const qaReworkLimit = positiveInt(input.qaReworkLimit, DEFAULT_QA_REWORK_LIMIT);
  const idempotencyKey = input.idempotencyKey ?? `${PROCESS_KEY}:${input.issueId}`;
  const operatorInput = {
    task: input.task ?? issue.title,
    context: input.context ?? null,
    projectId: input.projectId ?? issue.projectId ?? null,
    source: input.source ?? "plugin",
  };

  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx, "tz_process_runs")}
       (id, company_id, root_issue_id, process_key, status, state, current_round,
        max_rounds, qa_rework_limit, idempotency_key, operator_input, selected_agents)
     VALUES ($1, $2, $3, $4, 'intake', 'intake', 0, $5, $6, $7, $8::jsonb, $9::jsonb)
     ON CONFLICT (company_id, idempotency_key) DO UPDATE SET
       operator_input = EXCLUDED.operator_input,
       max_rounds = EXCLUDED.max_rounds,
       qa_rework_limit = EXCLUDED.qa_rework_limit,
       updated_at = now()`,
    [
      runId,
      input.companyId,
      input.issueId,
      PROCESS_KEY,
      maxRounds,
      qaReworkLimit,
      idempotencyKey,
      JSON.stringify(operatorInput),
      JSON.stringify({}),
    ],
  );

  const run = await runByIdempotencyKey(ctx, input.companyId, idempotencyKey) ?? {
    id: runId,
    companyId: input.companyId,
    rootIssueId: input.issueId,
    processKey: PROCESS_KEY,
    status: "intake",
    state: "intake",
    currentRound: 0,
    maxRounds,
    qaReworkLimit,
    idempotencyKey,
    operatorInput,
    selectedAgents: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  } satisfies TzProcessRunSummary;

  await appendEvent(ctx, {
    runId: run.id,
    companyId: input.companyId,
    eventType: "run_started",
    payload: {
      issueId: input.issueId,
      processKey: PROCESS_KEY,
      source: input.source ?? "plugin",
    },
  });

  await writeTraceDocument(ctx, input.issueId, input.companyId, issue.title, run);
  await ctx.activity.log({
    companyId: input.companyId,
    message: "TZ creation process started",
    entityType: "issue",
    entityId: input.issueId,
    metadata: {
      runId: run.id,
      processKey: PROCESS_KEY,
      state: run.state,
    },
  });

  const status = await buildStatus(ctx, input.companyId, input.issueId);
  return {
    ...status,
    run: status.run ?? run,
  };
}

async function recordInteractionResolution(ctx: PluginContext, event: PluginEvent) {
  const issueId = typeof event.entityId === "string" ? event.entityId : null;
  if (!issueId) return;
  const run = await activeRunForIssue(ctx, event.companyId, issueId);
  if (!run) return;

  const payload = jsonObject(event.payload);
  await appendEvent(ctx, {
    runId: run.id,
    companyId: event.companyId,
    eventType: event.eventType.replace("issue.thread_interaction.", "operator_interaction_"),
    payload: {
      eventId: event.eventId,
      interactionId: stringField(payload.interactionId),
      interactionKind: stringField(payload.interactionKind),
      interactionStatus: stringField(payload.interactionStatus),
      rawEventType: event.eventType,
    },
  });
}

function readStartInput(
  params: Record<string, unknown>,
  context?: PluginPerformActionContext,
): StartCycleInput {
  const companyId = stringField(params.companyId) ?? context?.companyId ?? null;
  const issueId = stringField(params.issueId);
  if (!companyId || !issueId) throw new Error("companyId and issueId are required");
  return {
    companyId,
    issueId,
    task: stringField(params.task),
    context: stringField(params.context),
    projectId: stringField(params.projectId),
    idempotencyKey: stringField(params.idempotencyKey),
    maxRounds: typeof params.maxRounds === "number" ? params.maxRounds : null,
    qaReworkLimit: typeof params.qaReworkLimit === "number" ? params.qaReworkLimit : null,
    source: stringField(params.source),
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    activeContext = ctx;

    startCycle = async (input) => handleStart(ctx, input);
    readStatus = async (companyId, issueId) => buildStatus(ctx, companyId, issueId);

    for (const eventName of [
      "issue.thread_interaction.accepted",
      "issue.thread_interaction.rejected",
      "issue.thread_interaction.answered",
      "issue.thread_interaction.cancelled",
      "issue.thread_interaction.expired",
    ] as const) {
      ctx.events.on(eventName, async (event) => recordInteractionResolution(ctx, event));
    }

    ctx.data.register("status", async (params) => {
      const companyId = stringField(params.companyId);
      const issueId = stringField(params.issueId);
      if (!companyId || !issueId) {
        return {
          status: "missing_scope",
          databaseNamespace: ctx.db.namespace,
        };
      }
      return buildStatus(ctx, companyId, issueId);
    });

    ctx.actions.register("start-cycle", async (params, context) => {
      return handleStart(ctx, readStartInput(params, context));
    });

    ctx.actions.register("status", async (params, context) => {
      const companyId = stringField(params.companyId) ?? context.companyId;
      const issueId = stringField(params.issueId);
      if (!companyId || !issueId) throw new Error("companyId and issueId are required");
      return buildStatus(ctx, companyId, issueId);
    });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    if (!activeContext || !startCycle || !readStatus) {
      throw new Error("TZ Process Engine is not ready");
    }

    if (input.routeKey === "start-cycle") {
      const body = jsonObject(input.body);
      return {
        status: 201,
        body: await startCycle({
          ...readStartInput({
            ...body,
            companyId: input.companyId,
            issueId: input.params.issueId,
          }),
          source: "api",
        }),
      };
    }

    if (input.routeKey === "status") {
      return {
        body: await readStatus(input.companyId, input.params.issueId),
      };
    }

    return {
      status: 404,
      body: { error: `Unknown TZ Process Engine route: ${input.routeKey}` },
    };
  },

  async onHealth() {
    return {
      status: "ok",
      message: "TZ Process Engine plugin worker is running",
      details: {
        databaseNamespace: activeContext?.db.namespace ?? null,
        processKey: PROCESS_KEY,
        traceDocumentKey: TRACE_DOCUMENT_KEY,
      },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
