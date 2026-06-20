import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginEvent,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import type {
  Agent,
  Issue,
  IssueDocument,
  IssueThreadInteraction,
} from "@paperclipai/shared";
import {
  CLARIFICATION_INTERACTION_KEY,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_QA_REWORK_LIMIT,
  BLIND_DRAFT_ARTIFACT_KEY,
  BLIND_DRAFT_ORIGIN_KIND,
  PING_PONG_ARTIFACT_KEY,
  PING_PONG_ORIGIN_KIND,
  PROCESS_KEY,
  TRACE_DOCUMENT_KEY,
  type TzProcessStatus,
} from "./constants.js";

type DraftAuthorRoleKey = "author-codex" | "author-claude";

type DraftAuthorDefinition = {
  roleKey: DraftAuthorRoleKey;
  displayName: string;
  adapterType: "codex_local" | "claude_local";
  title: string;
  exactNames: string[];
};

const DRAFT_AUTHORS: DraftAuthorDefinition[] = [
  {
    roleKey: "author-codex",
    displayName: "Автор-Codex",
    adapterType: "codex_local",
    title: "Автор-Codex",
    exactNames: ["Автор-Codex", "Автор-GPT", "Author-Codex", "Author-GPT"],
  },
  {
    roleKey: "author-claude",
    displayName: "Автор-Claude",
    adapterType: "claude_local",
    title: "Автор-Claude",
    exactNames: ["Автор-Claude", "Author-Claude"],
  },
];

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

type DraftTaskResult = {
  author: DraftAuthorDefinition;
  agent: Agent;
  issue: Issue;
  wakeupRunId: string | null;
};

type PingPongTaskResult = DraftTaskResult & {
  roundNumber: number;
  otherAuthor: DraftAuthorDefinition;
};

type SelectedAgentRecord = {
  agentId: string | null;
  agentName: string | null;
  adapterType: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  wakeupRunId: string | null;
};

type DraftDocumentSelection = {
  issue: Issue;
  document: IssueDocument;
  body: string;
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

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function agentIsUsable(agent: Agent) {
  return agent.status !== "terminated" && agent.status !== "paused" && agent.status !== "pending_approval";
}

function normalizeAgentName(value: string) {
  return value.trim().toLowerCase();
}

function selectAuthorAgent(agents: Agent[], definition: DraftAuthorDefinition): Agent | null {
  const usable = agents.filter((agent) => agentIsUsable(agent) && agent.adapterType === definition.adapterType);
  const exactNames = new Set(definition.exactNames.map(normalizeAgentName));
  return usable.find((agent) => exactNames.has(normalizeAgentName(agent.name)))
    ?? usable.find((agent) => normalizeAgentName(agent.name).includes("автор"))
    ?? usable[0]
    ?? null;
}

function draftIssueOriginId(runId: string, roleKey: DraftAuthorRoleKey, roundNumber = 0) {
  return `${runId}:${roleKey}:r${roundNumber}`;
}

function pingPongIssueOriginId(runId: string, roleKey: DraftAuthorRoleKey, roundNumber = 1) {
  return `${runId}:${roleKey}:r${roundNumber}`;
}

function authorByRoleKey(roleKey: DraftAuthorRoleKey) {
  return DRAFT_AUTHORS.find((author) => author.roleKey === roleKey);
}

function selectedAgentRecord(run: TzProcessRunSummary, roleKey: DraftAuthorRoleKey): SelectedAgentRecord {
  const selectedAgents = jsonObject(run.selectedAgents);
  const record = jsonObject(selectedAgents[roleKey]);
  return {
    agentId: stringField(record.agentId),
    agentName: stringField(record.agentName),
    adapterType: stringField(record.adapterType),
    issueId: stringField(record.issueId),
    issueIdentifier: stringField(record.issueIdentifier),
    wakeupRunId: stringField(record.wakeupRunId),
  };
}

function operatorAnswerSummary(interaction: IssueThreadInteraction | null) {
  const result = jsonObject(interaction?.result);
  const answers = jsonArray(result.answers);
  if (answers.length === 0) return "Оператор не дал дополнительных уточнений.";

  return answers.map((answer, index) => {
    const record = jsonObject(answer);
    const questionId = stringField(record.questionId) ?? `question_${index + 1}`;
    const optionIds = jsonArray(record.optionIds)
      .map((item) => typeof item === "string" ? item : null)
      .filter((item): item is string => Boolean(item));
    const otherText = stringField(record.otherText);
    const parts = [
      optionIds.length > 0 ? `варианты: ${optionIds.join(", ")}` : null,
      otherText ? `текст: ${otherText}` : null,
    ].filter((part): part is string => Boolean(part));
    return `- ${questionId}: ${parts.length > 0 ? parts.join("; ") : "без ответа"}`;
  }).join("\n");
}

function buildBlindDraftPrompt(input: {
  issue: Issue;
  run: TzProcessRunSummary;
  author: DraftAuthorDefinition;
  clarificationInteraction: IssueThreadInteraction | null;
}) {
  const operatorInput = jsonObject(input.run.operatorInput);
  const task = stringField(operatorInput.task) ?? input.issue.title;
  const context = stringField(operatorInput.context) ?? input.issue.description ?? "Дополнительный контекст не указан.";
  const projectId = stringField(operatorInput.projectId) ?? input.issue.projectId ?? "не указан";
  const answers = operatorAnswerSummary(input.clarificationInteraction);

  return [
    `Ты ${input.author.title}. Это слепой раунд 0 создания ТЗ.`,
    "",
    "Правила:",
    "- Пиши свою независимую версию ТЗ.",
    "- Не запрашивай и не используй черновик второго автора.",
    "- Пиши по-русски, заголовки тоже по-русски.",
    "- Не меняй код и не деплой ничего. Сейчас нужна только версия ТЗ.",
    "- Если данных не хватает, явно вынеси открытые вопросы оператору.",
    "",
    "Исходная задача:",
    task,
    "",
    "Контекст:",
    context,
    "",
    `Проект: ${projectId}`,
    "",
    "Ответы оператора на уточняющие вопросы:",
    answers,
    "",
    "Сформируй документ ТЗ со структурой:",
    "1. Цель",
    "2. Контекст",
    "3. Границы MVP",
    "4. Функциональные требования",
    "5. Нефункциональные требования",
    "6. Сценарии работы",
    "7. Ограничения и риски",
    "8. Критерии приёмки",
    "9. План проверки",
    "10. Открытые вопросы",
    "",
    "В конце добавь короткий блок:",
    "Вердикт: ГОТОВ К ПИНГ-ПОНГУ",
  ].join("\n");
}

async function findClarificationInteraction(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  runId: string,
) {
  const interactions = await ctx.issues.interactions.list(issueId, companyId, {
    kind: "ask_user_questions",
    limit: 20,
  });
  return interactions.find((interaction) =>
    interaction.idempotencyKey === clarificationInteractionIdempotencyKey(runId)) ?? null;
}

async function findExistingDraftIssue(
  ctx: PluginContext,
  companyId: string,
  run: TzProcessRunSummary,
  author: DraftAuthorDefinition,
) {
  const existing = await ctx.issues.list({
    companyId,
    originKind: BLIND_DRAFT_ORIGIN_KIND,
    originId: draftIssueOriginId(run.id, author.roleKey),
    includePluginOperations: true,
    limit: 1,
  });
  return existing[0] ?? null;
}

async function findExistingPingPongIssue(
  ctx: PluginContext,
  companyId: string,
  run: TzProcessRunSummary,
  author: DraftAuthorDefinition,
  roundNumber: number,
) {
  const existing = await ctx.issues.list({
    companyId,
    originKind: PING_PONG_ORIGIN_KIND,
    originId: pingPongIssueOriginId(run.id, author.roleKey, roundNumber),
    includePluginOperations: true,
    limit: 1,
  });
  return existing[0] ?? null;
}

async function findDraftIssueForAuthor(
  ctx: PluginContext,
  run: TzProcessRunSummary,
  author: DraftAuthorDefinition,
) {
  const selected = selectedAgentRecord(run, author.roleKey);
  if (selected.issueId) {
    const selectedIssue = await ctx.issues.get(selected.issueId, run.companyId);
    if (selectedIssue) return selectedIssue;
  }
  return findExistingDraftIssue(ctx, run.companyId, run, author);
}

function scoreDraftDocument(document: IssueDocument) {
  const key = document.key.toLowerCase();
  const title = (document.title ?? "").toLowerCase();
  let score = 0;
  if (key === TRACE_DOCUMENT_KEY || key.includes("trace") || key.includes("summary")) score -= 100;
  if (key.includes("tz") || key.includes("тз") || title.includes("tz") || title.includes("тз")) score += 20;
  if (key.includes("draft") || key.includes("черновик") || title.includes("draft") || title.includes("черновик")) score += 10;
  if (key === "plan") score += 5;
  if (document.body.trim().length > 0) score += 1;
  return score;
}

async function selectDraftDocument(
  ctx: PluginContext,
  issue: Issue,
  companyId: string,
): Promise<DraftDocumentSelection | null> {
  const summaries = await ctx.issues.documents.list(issue.id, companyId);
  const documents: IssueDocument[] = [];
  for (const summary of summaries) {
    const document = await ctx.issues.documents.get(issue.id, summary.key, companyId);
    if (document?.body.trim()) documents.push(document);
  }
  documents.sort((left, right) => scoreDraftDocument(right) - scoreDraftDocument(left));
  const document = documents[0];
  return document ? { issue, document, body: document.body } : null;
}

async function selectedOrFallbackAgent(
  ctx: PluginContext,
  run: TzProcessRunSummary,
  author: DraftAuthorDefinition,
) {
  const selected = selectedAgentRecord(run, author.roleKey);
  if (selected.agentId) {
    const agent = await ctx.agents.get(selected.agentId, run.companyId);
    if (agent && agentIsUsable(agent)) return agent;
  }
  const agents = await ctx.agents.list({ companyId: run.companyId, limit: 200 });
  return selectAuthorAgent(agents, author);
}

function buildPingPongPrompt(input: {
  issue: Issue;
  run: TzProcessRunSummary;
  author: DraftAuthorDefinition;
  otherAuthor: DraftAuthorDefinition;
  ownDraft: DraftDocumentSelection;
  otherDraft: DraftDocumentSelection;
  roundNumber: number;
}) {
  const ownDocument = input.ownDraft.document;
  const otherDocument = input.otherDraft.document;
  return [
    `Ты ${input.author.title}. Это ping-pong round ${input.roundNumber} создания ТЗ.`,
    "",
    "Твоя задача:",
    "1. Критически изучи свой черновик R0.",
    `2. Критически изучи черновик ${input.otherAuthor.displayName} R0.`,
    "3. Прими сильные пункты чужой версии, отклони слабые и явно выпиши спорные пункты.",
    "4. Предложи новую лучшую версию своего ТЗ.",
    "5. Пиши по-русски, заголовки тоже по-русски.",
    "6. Не меняй код и не деплой ничего. Сейчас нужна только работа с ТЗ.",
    "",
    "Исходная задача:",
    input.issue.title,
    "",
    "Твой черновик R0:",
    `Документ: ${ownDocument.title ?? ownDocument.key}`,
    `document_id: ${ownDocument.id}`,
    `revision_id: ${ownDocument.latestRevisionId}`,
    "",
    input.ownDraft.body,
    "",
    `Черновик ${input.otherAuthor.displayName} R0:`,
    `Документ: ${otherDocument.title ?? otherDocument.key}`,
    `document_id: ${otherDocument.id}`,
    `revision_id: ${otherDocument.latestRevisionId}`,
    "",
    input.otherDraft.body,
    "",
    "Ответ заверши строго таким структурным блоком:",
    "```yaml",
    "review_of_other:",
    "  - \"...\"",
    "accepted_points:",
    "  - \"...\"",
    "rejected_points:",
    "  - \"...\"",
    "remaining_deltas:",
    "  - \"...\"",
    "new_own_version: |",
    "  ...",
    "verdict: ИТЕРИРУЕМ",
    "named_version:",
    `  author: ${input.author.roleKey}`,
    `  round: ${input.roundNumber}`,
    "  document_id: null",
    "  revision_id: null",
    "```",
    "",
    "Если ты считаешь, что спорных пунктов уже нет, оставь remaining_deltas пустым и поставь verdict: СОШЛИСЬ.",
  ].join("\n");
}

async function recordDraftIssueArtifact(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    author: DraftAuthorDefinition;
    agent: Agent;
    issue: Issue;
    wakeupRunId: string | null;
  },
) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx, "tz_process_artifacts")}
       (id, run_id, company_id, role_key, round_number, artifact_key, visibility, content, metadata)
     VALUES ($1, $2, $3, $4, 0, $5, 'public', $6, $7::jsonb)
     ON CONFLICT (run_id, role_key, round_number, artifact_key) DO UPDATE SET
       content = EXCLUDED.content,
       metadata = EXCLUDED.metadata,
       updated_at = now()`,
    [
      randomUUID(),
      input.run.id,
      input.run.companyId,
      input.author.roleKey,
      BLIND_DRAFT_ARTIFACT_KEY,
      input.issue.description ?? "",
      JSON.stringify({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier ?? null,
        issueTitle: input.issue.title,
        author: input.author.displayName,
        agentId: input.agent.id,
        agentName: input.agent.name,
        adapterType: input.agent.adapterType,
        wakeupRunId: input.wakeupRunId,
      }),
    ],
  );
}

async function recordPingPongIssueArtifact(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    roundNumber: number;
    author: DraftAuthorDefinition;
    otherAuthor: DraftAuthorDefinition;
    agent: Agent;
    issue: Issue;
    wakeupRunId: string | null;
  },
) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx, "tz_process_artifacts")}
       (id, run_id, company_id, role_key, round_number, artifact_key, visibility, content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'public', $7, $8::jsonb)
     ON CONFLICT (run_id, role_key, round_number, artifact_key) DO UPDATE SET
       content = EXCLUDED.content,
       metadata = EXCLUDED.metadata,
       updated_at = now()`,
    [
      randomUUID(),
      input.run.id,
      input.run.companyId,
      input.author.roleKey,
      input.roundNumber,
      PING_PONG_ARTIFACT_KEY,
      input.issue.description ?? "",
      JSON.stringify({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier ?? null,
        issueTitle: input.issue.title,
        author: input.author.displayName,
        otherAuthor: input.otherAuthor.displayName,
        agentId: input.agent.id,
        agentName: input.agent.name,
        adapterType: input.agent.adapterType,
        wakeupRunId: input.wakeupRunId,
      }),
    ],
  );
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

async function activeRunsForDraftIssue(
  ctx: PluginContext,
  companyId: string,
  draftIssueId: string,
): Promise<TzProcessRunSummary[]> {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE company_id = $1
        AND status = 'drafting'
        AND state = 'blind_draft_tasks_dispatched'
        AND (
          selected_agents->'author-codex'->>'issueId' = $2
          OR selected_agents->'author-claude'->>'issueId' = $2
        )
      ORDER BY updated_at ASC
      LIMIT 10`,
    [companyId, draftIssueId],
  );
  return rows.map(normalizeRun);
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

async function markRunNeedsOperatorForMissingAuthors(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    issue: Issue;
    missingAuthors: DraftAuthorDefinition[];
  },
) {
  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'needs_operator',
            state = 'missing_required_author_agents',
            updated_at = now()
      WHERE id = $1 AND company_id = $2`,
    [input.run.id, input.run.companyId],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: "drafting_blocked_missing_agents",
    payload: {
      issueId: input.issue.id,
      missingAuthors: input.missingAuthors.map((author) => ({
        roleKey: author.roleKey,
        displayName: author.displayName,
        adapterType: author.adapterType,
      })),
    },
  });
  await ctx.activity.log({
    companyId: input.run.companyId,
    message: "Процесс создания ТЗ остановлен: не найдены обязательные авторы",
    entityType: "issue",
    entityId: input.issue.id,
    metadata: {
      runId: input.run.id,
      missingAuthors: input.missingAuthors.map((author) => author.displayName),
    },
  });
  await writeTraceDocument(ctx, input.issue.id, input.run.companyId, input.issue.title, {
    ...input.run,
    status: "needs_operator",
    state: "missing_required_author_agents",
    updatedAt: new Date().toISOString(),
  });
}

async function createOrReuseDraftIssue(
  ctx: PluginContext,
  input: {
    issue: Issue;
    run: TzProcessRunSummary;
    author: DraftAuthorDefinition;
    agent: Agent;
    clarificationInteraction: IssueThreadInteraction | null;
  },
) {
  const existing = await findExistingDraftIssue(ctx, input.run.companyId, input.run, input.author);
  if (existing) return existing;

  const rootLabel = input.issue.identifier ?? input.issue.title;
  return ctx.issues.create({
    companyId: input.run.companyId,
    projectId: input.issue.projectId ?? undefined,
    goalId: input.issue.goalId ?? undefined,
    parentId: input.issue.id,
    inheritExecutionWorkspaceFromIssueId: input.issue.id,
    title: `${rootLabel} blind round 0: черновик ТЗ от ${input.author.displayName}`,
    description: buildBlindDraftPrompt(input),
    status: "todo",
    priority: input.issue.priority ?? "medium",
    assigneeAgentId: input.agent.id,
    requestDepth: input.issue.requestDepth + 1,
    billingCode: input.issue.billingCode,
    originKind: BLIND_DRAFT_ORIGIN_KIND,
    originId: draftIssueOriginId(input.run.id, input.author.roleKey),
    originRunId: input.run.id,
  });
}

async function createOrReusePingPongIssue(
  ctx: PluginContext,
  input: {
    issue: Issue;
    run: TzProcessRunSummary;
    author: DraftAuthorDefinition;
    otherAuthor: DraftAuthorDefinition;
    agent: Agent;
    ownDraft: DraftDocumentSelection;
    otherDraft: DraftDocumentSelection;
    roundNumber: number;
  },
) {
  const existing = await findExistingPingPongIssue(
    ctx,
    input.run.companyId,
    input.run,
    input.author,
    input.roundNumber,
  );
  if (existing) return existing;

  const rootLabel = input.issue.identifier ?? input.issue.title;
  return ctx.issues.create({
    companyId: input.run.companyId,
    projectId: input.issue.projectId ?? undefined,
    goalId: input.issue.goalId ?? undefined,
    parentId: input.issue.id,
    inheritExecutionWorkspaceFromIssueId: input.issue.id,
    title: `${rootLabel} ping-pong round ${input.roundNumber}: ${input.author.displayName} отвечает ${input.otherAuthor.displayName}`,
    description: buildPingPongPrompt(input),
    status: "todo",
    priority: input.issue.priority ?? "medium",
    assigneeAgentId: input.agent.id,
    requestDepth: input.issue.requestDepth + 1,
    billingCode: input.issue.billingCode,
    originKind: PING_PONG_ORIGIN_KIND,
    originId: pingPongIssueOriginId(input.run.id, input.author.roleKey, input.roundNumber),
    originRunId: input.run.id,
  });
}

async function reopenRootIssueForDrafting(ctx: PluginContext, issue: Issue, run: TzProcessRunSummary) {
  if (issue.status !== "done") return issue;
  const nextStatus = issue.assigneeAgentId || issue.assigneeUserId ? "in_progress" : "todo";
  const updated = await ctx.issues.update(issue.id, { status: nextStatus }, run.companyId);
  await appendEvent(ctx, {
    runId: run.id,
    companyId: run.companyId,
    eventType: "root_issue_reopened_for_drafting",
    payload: {
      issueId: issue.id,
      previousStatus: issue.status,
      nextStatus,
    },
  });
  return updated;
}

async function dispatchBlindDraftTasks(ctx: PluginContext, run: TzProcessRunSummary) {
  if (run.status !== "drafting" || run.state !== "ready_for_blind_drafting") return;

  const issue = await ctx.issues.get(run.rootIssueId, run.companyId);
  if (!issue) throw new Error(`Issue not found: ${run.rootIssueId}`);

  const agents = await ctx.agents.list({ companyId: run.companyId, limit: 200 });
  const selected = DRAFT_AUTHORS.map((author) => ({
    author,
    agent: selectAuthorAgent(agents, author),
  }));
  const missingAuthors = selected
    .filter((entry): entry is { author: DraftAuthorDefinition; agent: null } => entry.agent === null)
    .map((entry) => entry.author);
  if (missingAuthors.length > 0) {
    await markRunNeedsOperatorForMissingAuthors(ctx, { run, issue, missingAuthors });
    return;
  }

  const activeIssue = await reopenRootIssueForDrafting(ctx, issue, run);
  const clarificationInteraction = await findClarificationInteraction(ctx, run.rootIssueId, run.companyId, run.id);
  const draftTasks: DraftTaskResult[] = [];

  for (const entry of selected) {
    if (!entry.agent) continue;
    const draftIssue = await createOrReuseDraftIssue(ctx, {
      issue: activeIssue,
      run,
      author: entry.author,
      agent: entry.agent,
      clarificationInteraction,
    });
    draftTasks.push({
      author: entry.author,
      agent: entry.agent,
      issue: draftIssue,
      wakeupRunId: null,
    });
  }

  const wakeups = await ctx.issues.requestWakeups(
    draftTasks.map((task) => task.issue.id),
    run.companyId,
    {
      reason: "TZ Process Engine: запустить слепой раунд 0",
      contextSource: "tz_process_engine.blind_draft_r0",
      idempotencyKeyPrefix: `${run.id}:blind-draft-r0`,
    },
  );
  const wakeupByIssueId = new Map(wakeups.map((wakeup) => [wakeup.issueId, wakeup.runId ?? null]));
  for (const task of draftTasks) {
    task.wakeupRunId = wakeupByIssueId.get(task.issue.id) ?? null;
    await recordDraftIssueArtifact(ctx, { run, ...task });
  }

  const selectedAgents = Object.fromEntries(draftTasks.map((task) => [
    task.author.roleKey,
    {
      agentId: task.agent.id,
      agentName: task.agent.name,
      adapterType: task.agent.adapterType,
      issueId: task.issue.id,
      issueIdentifier: task.issue.identifier ?? null,
      wakeupRunId: task.wakeupRunId,
    },
  ]));
  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'drafting',
            state = 'blind_draft_tasks_dispatched',
            selected_agents = $3::jsonb,
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'drafting'
        AND state = 'ready_for_blind_drafting'`,
    [run.id, run.companyId, JSON.stringify(selectedAgents)],
  );
  await appendEvent(ctx, {
    runId: run.id,
    companyId: run.companyId,
    eventType: "blind_draft_tasks_created",
    payload: {
      issueId: run.rootIssueId,
      tasks: draftTasks.map((task) => ({
        roleKey: task.author.roleKey,
        author: task.author.displayName,
        agentId: task.agent.id,
        agentName: task.agent.name,
        adapterType: task.agent.adapterType,
        issueId: task.issue.id,
        issueIdentifier: task.issue.identifier ?? null,
        wakeupRunId: task.wakeupRunId,
      })),
    },
  });
  await ctx.activity.log({
    companyId: run.companyId,
    message: "Слепой раунд 0 запущен: созданы задачи для Автор-Codex и Автор-Claude",
    entityType: "issue",
    entityId: run.rootIssueId,
    metadata: {
      runId: run.id,
      draftIssueIds: draftTasks.map((task) => task.issue.id),
    },
  });
  await writeTraceDocument(ctx, run.rootIssueId, run.companyId, activeIssue.title, {
    ...run,
    status: "drafting",
    state: "blind_draft_tasks_dispatched",
    selectedAgents,
    updatedAt: new Date().toISOString(),
  });
}

async function markRunNeedsOperatorForMissingDrafts(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    issue: Issue;
    reason: string;
    details: Record<string, unknown>;
  },
) {
  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'needs_operator',
            state = $3,
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'drafting'
        AND state = 'blind_draft_tasks_dispatched'`,
    [input.run.id, input.run.companyId, input.reason],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: "ping_pong_blocked_missing_blind_drafts",
    payload: {
      issueId: input.issue.id,
      reason: input.reason,
      ...input.details,
    },
  });
  await ctx.activity.log({
    companyId: input.run.companyId,
    message: "Ping-pong round 1 не запущен: не хватает готовых черновиков или документов",
    entityType: "issue",
    entityId: input.issue.id,
    metadata: {
      runId: input.run.id,
      reason: input.reason,
      ...input.details,
    },
  });
  await writeTraceDocument(ctx, input.issue.id, input.run.companyId, input.issue.title, {
    ...input.run,
    status: "needs_operator",
    state: input.reason,
    updatedAt: new Date().toISOString(),
  });
}

async function dispatchPingPongRoundOneIfReady(ctx: PluginContext, run: TzProcessRunSummary) {
  if (run.status !== "drafting" || run.state !== "blind_draft_tasks_dispatched") return;

  const issue = await ctx.issues.get(run.rootIssueId, run.companyId);
  if (!issue) throw new Error(`Issue not found: ${run.rootIssueId}`);

  const codexAuthor = authorByRoleKey("author-codex");
  const claudeAuthor = authorByRoleKey("author-claude");
  if (!codexAuthor || !claudeAuthor) throw new Error("Draft author definitions are incomplete");

  const codexDraftIssue = await findDraftIssueForAuthor(ctx, run, codexAuthor);
  const claudeDraftIssue = await findDraftIssueForAuthor(ctx, run, claudeAuthor);
  if (!codexDraftIssue || !claudeDraftIssue) {
    await markRunNeedsOperatorForMissingDrafts(ctx, {
      run,
      issue,
      reason: "missing_blind_draft_issues",
      details: {
        codexDraftIssueId: codexDraftIssue?.id ?? null,
        claudeDraftIssueId: claudeDraftIssue?.id ?? null,
      },
    });
    return;
  }

  if (codexDraftIssue.status !== "done" || claudeDraftIssue.status !== "done") return;

  const codexDraft = await selectDraftDocument(ctx, codexDraftIssue, run.companyId);
  const claudeDraft = await selectDraftDocument(ctx, claudeDraftIssue, run.companyId);
  if (!codexDraft || !claudeDraft) {
    await markRunNeedsOperatorForMissingDrafts(ctx, {
      run,
      issue,
      reason: "missing_blind_draft_documents",
      details: {
        codexDraftIssueId: codexDraftIssue.id,
        claudeDraftIssueId: claudeDraftIssue.id,
        codexDocumentFound: Boolean(codexDraft),
        claudeDocumentFound: Boolean(claudeDraft),
      },
    });
    return;
  }

  const codexAgent = await selectedOrFallbackAgent(ctx, run, codexAuthor);
  const claudeAgent = await selectedOrFallbackAgent(ctx, run, claudeAuthor);
  if (!codexAgent || !claudeAgent) {
    await markRunNeedsOperatorForMissingAuthors(ctx, {
      run,
      issue,
      missingAuthors: [
        ...(!codexAgent ? [codexAuthor] : []),
        ...(!claudeAgent ? [claudeAuthor] : []),
      ],
    });
    return;
  }

  const roundNumber = 1;
  const pingPongTasks: PingPongTaskResult[] = [];
  const codexIssue = await createOrReusePingPongIssue(ctx, {
    issue,
    run,
    author: codexAuthor,
    otherAuthor: claudeAuthor,
    agent: codexAgent,
    ownDraft: codexDraft,
    otherDraft: claudeDraft,
    roundNumber,
  });
  pingPongTasks.push({
    author: codexAuthor,
    otherAuthor: claudeAuthor,
    agent: codexAgent,
    issue: codexIssue,
    wakeupRunId: null,
    roundNumber,
  });

  const claudeIssue = await createOrReusePingPongIssue(ctx, {
    issue,
    run,
    author: claudeAuthor,
    otherAuthor: codexAuthor,
    agent: claudeAgent,
    ownDraft: claudeDraft,
    otherDraft: codexDraft,
    roundNumber,
  });
  pingPongTasks.push({
    author: claudeAuthor,
    otherAuthor: codexAuthor,
    agent: claudeAgent,
    issue: claudeIssue,
    wakeupRunId: null,
    roundNumber,
  });

  const wakeups = await ctx.issues.requestWakeups(
    pingPongTasks.map((task) => task.issue.id),
    run.companyId,
    {
      reason: "TZ Process Engine: запустить ping-pong round 1",
      contextSource: "tz_process_engine.ping_pong_r1",
      idempotencyKeyPrefix: `${run.id}:ping-pong-r1`,
    },
  );
  const wakeupByIssueId = new Map(wakeups.map((wakeup) => [wakeup.issueId, wakeup.runId ?? null]));
  for (const task of pingPongTasks) {
    task.wakeupRunId = wakeupByIssueId.get(task.issue.id) ?? null;
    await recordPingPongIssueArtifact(ctx, { run, ...task });
  }

  const previousSelectedAgents = jsonObject(run.selectedAgents);
  const pingPongRound = Object.fromEntries(pingPongTasks.map((task) => [
    task.author.roleKey,
    {
      agentId: task.agent.id,
      agentName: task.agent.name,
      adapterType: task.agent.adapterType,
      issueId: task.issue.id,
      issueIdentifier: task.issue.identifier ?? null,
      wakeupRunId: task.wakeupRunId,
    },
  ]));
  const selectedAgents = {
    ...previousSelectedAgents,
    pingPongRound1: pingPongRound,
  };

  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'iterating',
            state = 'ping_pong_round_1_dispatched',
            current_round = 1,
            selected_agents = $3::jsonb,
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'drafting'
        AND state = 'blind_draft_tasks_dispatched'`,
    [run.id, run.companyId, JSON.stringify(selectedAgents)],
  );
  await appendEvent(ctx, {
    runId: run.id,
    companyId: run.companyId,
    eventType: "ping_pong_round_1_tasks_created",
    payload: {
      issueId: run.rootIssueId,
      sourceDraftIssues: {
        [codexAuthor.roleKey]: codexDraftIssue.id,
        [claudeAuthor.roleKey]: claudeDraftIssue.id,
      },
      tasks: pingPongTasks.map((task) => ({
        roleKey: task.author.roleKey,
        author: task.author.displayName,
        otherAuthor: task.otherAuthor.displayName,
        agentId: task.agent.id,
        agentName: task.agent.name,
        adapterType: task.agent.adapterType,
        issueId: task.issue.id,
        issueIdentifier: task.issue.identifier ?? null,
        wakeupRunId: task.wakeupRunId,
      })),
    },
  });
  await ctx.activity.log({
    companyId: run.companyId,
    message: "Ping-pong round 1 запущен: авторы получили черновики друг друга",
    entityType: "issue",
    entityId: run.rootIssueId,
    metadata: {
      runId: run.id,
      pingPongIssueIds: pingPongTasks.map((task) => task.issue.id),
    },
  });
  await writeTraceDocument(ctx, run.rootIssueId, run.companyId, issue.title, {
    ...run,
    status: "iterating",
    state: "ping_pong_round_1_dispatched",
    currentRound: 1,
    selectedAgents,
    updatedAt: new Date().toISOString(),
  });
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
    const draftingRun = {
      ...run,
      status: "drafting",
      state: "ready_for_blind_drafting",
      updatedAt: new Date().toISOString(),
    } satisfies TzProcessRunSummary;
    await writeTraceDocument(ctx, issueId, event.companyId, issue.title, draftingRun);
    await dispatchBlindDraftTasks(ctx, draftingRun);
  }
}

async function resumeReadyDraftingRuns(ctx: PluginContext) {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE status = 'drafting'
        AND state = 'ready_for_blind_drafting'
      ORDER BY updated_at ASC
      LIMIT 20`,
  );
  for (const row of rows) {
    const run = normalizeRun(row);
    try {
      await dispatchBlindDraftTasks(ctx, run);
    } catch (err) {
      await appendEvent(ctx, {
        runId: run.id,
        companyId: run.companyId,
        eventType: "blind_draft_dispatch_failed",
        payload: {
          issueId: run.rootIssueId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      ctx.logger.error("Failed to resume TZ blind draft dispatch", {
        runId: run.id,
        issueId: run.rootIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function resumeReadyPingPongRuns(ctx: PluginContext) {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE status = 'drafting'
        AND state = 'blind_draft_tasks_dispatched'
      ORDER BY updated_at ASC
      LIMIT 20`,
  );
  for (const row of rows) {
    const run = normalizeRun(row);
    try {
      await dispatchPingPongRoundOneIfReady(ctx, run);
    } catch (err) {
      await appendEvent(ctx, {
        runId: run.id,
        companyId: run.companyId,
        eventType: "ping_pong_round_1_dispatch_failed",
        payload: {
          issueId: run.rootIssueId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      ctx.logger.error("Failed to resume TZ ping-pong round 1 dispatch", {
        runId: run.id,
        issueId: run.rootIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function handleIssueProgressEvent(ctx: PluginContext, event: PluginEvent) {
  const issueId = typeof event.entityId === "string" ? event.entityId : null;
  if (!issueId) return;
  const runs = await activeRunsForDraftIssue(ctx, event.companyId, issueId);
  for (const run of runs) {
    try {
      await dispatchPingPongRoundOneIfReady(ctx, run);
    } catch (err) {
      await appendEvent(ctx, {
        runId: run.id,
        companyId: run.companyId,
        eventType: "issue_progress_dispatch_failed",
        payload: {
          eventId: event.eventId,
          rawEventType: event.eventType,
          issueId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      ctx.logger.error("Failed to handle TZ issue progress event", {
        runId: run.id,
        issueId,
        eventType: event.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    ctx.events.on("issue.updated", async (event) => handleIssueProgressEvent(ctx, event));

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

    await resumeReadyDraftingRuns(ctx);
    await resumeReadyPingPongRuns(ctx);
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
