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
  CLARIFICATION_INTERACTION_KEY,
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
    "# Трасса процесса создания ТЗ",
    "",
    `Задача: ${input.issueTitle}`,
    `Run ID: ${input.run.id}`,
    `Статус: ${input.run.status}`,
    `Состояние: ${input.run.state}`,
    `Раунд: ${input.run.currentRound}`,
    `Лимит раундов: ${input.run.maxRounds}`,
    `Лимит QA-доработок: ${input.run.qaReworkLimit}`,
    "",
    "Этот документ ведёт плагин TZ Process Engine. Видимая трасса хранится здесь, а авторитетное состояние процесса живёт в namespace плагина в Postgres.",
  ].join("\n");
}

async function writeTraceDocument(ctx: PluginContext, issueId: string, companyId: string, issueTitle: string, run: TzProcessRunSummary) {
  const existing = await ctx.issues.documents.get(issueId, TRACE_DOCUMENT_KEY, companyId);
  await ctx.issues.documents.upsert({
    issueId,
    companyId,
    key: TRACE_DOCUMENT_KEY,
    title: "TZ Process Trace",
    format: "markdown",
    body: traceDocumentBody({ issueTitle, run }),
    changeSummary: "Recorded TZ process run state",
    baseRevisionId: existing?.latestRevisionId ?? null,
  });
}

function clarificationInteractionIdempotencyKey(runId: string) {
  return `${runId}:${CLARIFICATION_INTERACTION_KEY}`;
}

async function createClarificationInteraction(ctx: PluginContext, issueId: string, companyId: string, run: TzProcessRunSummary) {
  return ctx.issues.askUserQuestions(issueId, {
    idempotencyKey: clarificationInteractionIdempotencyKey(run.id),
    title: "Уточнить задачу перед созданием ТЗ",
    summary: "Ответьте один раз. После этого оба автора получат одинаковый пакет уточнений и смогут начинать слепой раунд.",
    continuationPolicy: "wake_assignee",
    payload: {
      version: 1,
      title: "Уточняющие вопросы для цикла создания ТЗ",
      submitLabel: "Ответить и продолжить",
      questions: [
        {
          id: "task_ready",
          prompt: "Описание задачи уже достаточно полное, чтобы авторам начинать черновики ТЗ?",
          helpText: "Если нужно что-то добавить, выберите второй вариант и впишите детали в поле ответа.",
          selectionMode: "single",
          required: true,
          options: [
            {
              id: "ready",
              label: "Да, можно начинать",
              description: "Авторы сразу перейдут к слепому раунду после фиксации ответа.",
            },
            {
              id: "needs_details",
              label: "Нужно уточнить",
              description: "Добавьте недостающие вводные в свободном тексте ответа.",
            },
          ],
        },
        {
          id: "context_sources",
          prompt: "Какой контекст авторам нужно учитывать перед черновиками?",
          selectionMode: "multi",
          required: true,
          options: [
            {
              id: "issue_context",
              label: "Текущую задачу",
              description: "Использовать описание, комментарии, документы и текущую историю задачи.",
            },
            {
              id: "code_readonly",
              label: "Код read-only",
              description: "Сверять требования с репозиторием без права записи.",
            },
            {
              id: "paperclip_context",
              label: "Контекст Paperclip",
              description: "Учитывать текущие сущности Paperclip: issues, documents, interactions, agents.",
            },
            {
              id: "no_extra_context",
              label: "Без доп. контекста",
              description: "Достаточно текста задачи.",
            },
          ],
        },
        {
          id: "final_tz_focus",
          prompt: "На что особенно обратить внимание в финальном ТЗ?",
          selectionMode: "multi",
          required: true,
          options: [
            {
              id: "acceptance_criteria",
              label: "Критерии приёмки",
              description: "Сделать результат проверяемым.",
            },
            {
              id: "risks",
              label: "Риски и ограничения",
              description: "Отдельно зафиксировать слабые места и границы MVP.",
            },
            {
              id: "implementation_steps",
              label: "План реализации",
              description: "Добавить понятную последовательность работ.",
            },
            {
              id: "questions",
              label: "Открытые вопросы",
              description: "Явно вынести всё, что требует решения оператора.",
            },
          ],
        },
      ],
    },
  }, companyId);
}

async function buildStatus(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  knownRun?: TzProcessRunSummary | null,
): Promise<TzProcessStatusResult> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);
  const run = knownRun === undefined ? await latestRunForIssue(ctx, companyId, issueId) : knownRun;
  const allPendingInteractions = await ctx.issues.interactions.list(issueId, companyId, {
    status: "pending",
    limit: 20,
  });
  const processInteractionPrefix = run ? `${run.id}:` : null;
  const pendingInteractions = processInteractionPrefix
    ? allPendingInteractions.filter((interaction) => interaction.idempotencyKey?.startsWith(processInteractionPrefix))
    : allPendingInteractions;
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
    `INSERT INTO ${tableName(ctx, "tz_process_runs")} AS runs
       (id, company_id, root_issue_id, process_key, status, state, current_round,
        max_rounds, qa_rework_limit, idempotency_key, operator_input, selected_agents)
     VALUES ($1, $2, $3, $4, 'clarifying', 'waiting_operator_clarification', 0, $5, $6, $7, $8::jsonb, $9::jsonb)
     ON CONFLICT (company_id, idempotency_key) DO UPDATE SET
       operator_input = EXCLUDED.operator_input,
       max_rounds = EXCLUDED.max_rounds,
       qa_rework_limit = EXCLUDED.qa_rework_limit,
       status = CASE WHEN runs.status = 'intake' THEN 'clarifying' ELSE runs.status END,
       state = CASE WHEN runs.state = 'intake' THEN 'waiting_operator_clarification' ELSE runs.state END,
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
    status: "clarifying",
    state: "waiting_operator_clarification",
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
  const clarificationInteraction = await createClarificationInteraction(ctx, input.issueId, input.companyId, run);
  await appendEvent(ctx, {
    runId: run.id,
    companyId: input.companyId,
    eventType: "clarification_requested",
    payload: {
      issueId: input.issueId,
      interactionId: clarificationInteraction.id,
      idempotencyKey: clarificationInteraction.idempotencyKey ?? clarificationInteractionIdempotencyKey(run.id),
    },
  });

  await writeTraceDocument(ctx, input.issueId, input.companyId, issue.title, run);
  await ctx.activity.log({
    companyId: input.companyId,
    message: "Процесс создания ТЗ ожидает уточнений оператора",
    entityType: "issue",
    entityId: input.issueId,
    metadata: {
      runId: run.id,
      processKey: PROCESS_KEY,
      state: run.state,
      interactionId: clarificationInteraction.id,
    },
  });

  const status = await buildStatus(ctx, input.companyId, input.issueId, run);
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

  const interactionId = stringField(payload.interactionId);
  if (event.eventType !== "issue.thread_interaction.answered" || !interactionId) return;

  const interaction = await ctx.issues.interactions.get(interactionId, event.companyId);
  if (interaction?.idempotencyKey !== clarificationInteractionIdempotencyKey(run.id)) return;

  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'drafting',
            state = 'ready_for_blind_drafting',
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'clarifying'`,
    [run.id, event.companyId],
  );
  await appendEvent(ctx, {
    runId: run.id,
    companyId: event.companyId,
    eventType: "clarification_answered",
    payload: {
      issueId,
      interactionId,
      result: interaction.result ?? null,
    },
  });

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (issue) {
    await writeTraceDocument(ctx, issueId, event.companyId, issue.title, {
      ...run,
      status: "drafting",
      state: "ready_for_blind_drafting",
      updatedAt: new Date().toISOString(),
    });
  }
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
