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
  IssueThreadInteraction,
} from "@paperclipai/shared";
import {
  CLARIFICATION_INTERACTION_KEY,
  CONVERGENCE_CHECK_ARTIFACT_KEY,
  CONVERGENCE_CHECK_ORIGIN_KIND,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_QA_REWORK_LIMIT,
  BLIND_DRAFT_ARTIFACT_KEY,
  BLIND_DRAFT_ORIGIN_KIND,
  PING_PONG_ARTIFACT_KEY,
  PING_PONG_ORIGIN_KIND,
  PROCESS_KEY,
  PROJECT_REPO_FOLDER_KEY,
  QA_REVIEW_ARTIFACT_KEY,
  QA_REVIEW_ORIGIN_KIND,
  READINESS_REPORT_DOCUMENT_KEY,
  SYNTHESIS_ARTIFACT_KEY,
  SYNTHESIS_ORIGIN_KIND,
  TRACE_DOCUMENT_KEY,
  type TzProcessStatus,
} from "./constants.js";

type DraftAuthorRoleKey = "author-codex" | "author-claude";
type QaReviewerRoleKey = "qa-codex" | "qa-claude";

type DraftAuthorDefinition = {
  roleKey: DraftAuthorRoleKey;
  displayName: string;
  adapterType: "codex_local" | "claude_local";
  title: string;
  exactNames: string[];
};

type QaReviewerDefinition = {
  roleKey: QaReviewerRoleKey;
  displayName: string;
  adapterType: "codex_local" | "claude_local";
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

const QA_REVIEWERS: QaReviewerDefinition[] = [
  {
    roleKey: "qa-codex",
    displayName: "QA-Codex",
    adapterType: "codex_local",
    exactNames: ["QA", "QA-Codex", "QA-GPT", "Codex QA", "GPT QA"],
  },
  {
    roleKey: "qa-claude",
    displayName: "QA-Claude",
    adapterType: "claude_local",
    exactNames: ["Claude QA", "QA-Claude", "QA Anthropic", "Anthropic QA"],
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

type ConvergenceCheckTaskResult = DraftTaskResult & {
  roundNumber: number;
  otherAuthor: DraftAuthorDefinition;
};

type SynthesisTaskResult = {
  agent: Agent;
  issue: Issue;
  wakeupRunId: string | null;
  roundNumber: number;
};

type QaReviewTaskResult = {
  reviewer: QaReviewerDefinition;
  agent: Agent;
  issue: Issue;
  wakeupRunId: string | null;
  roundNumber: number;
};

type ParsedConvergenceVerdict = {
  verdict: "converged" | "iterate" | "unknown";
  remainingDeltasEmpty: boolean;
  raw: string;
};

type QaBlockerTarget = "synthesis" | "authors" | "operator";

type ParsedQaVerdict = {
  status: "accepted" | "blocked" | "unknown";
  blockerTargets: QaBlockerTarget[];
  blockerSummaries: string[];
  raw: string;
};

type SelectedIssueDocument = {
  id: string;
  key: string;
  title: string | null;
  latestRevisionId: string | null;
  body: string;
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
  document: SelectedIssueDocument;
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

type FactPredicate =
  | {
      kind: "file_exists";
      path: string;
    }
  | {
      kind: "text_search";
      text: string;
      paths?: string[];
    }
  | {
      kind: "regex_search";
      pattern: string;
      flags?: string;
      paths?: string[];
    };

type FactCheckDefinition = {
  claimKey: string;
  claim: string;
  predicate: FactPredicate;
};

type FactCheckStatus = "confirmed" | "missing" | "error";

type FactCheckResult = FactCheckDefinition & {
  commandLabel: string;
  status: FactCheckStatus;
  evidence: {
    output: string;
    matches: Array<{
      path: string;
      line?: number;
      snippet?: string;
    }>;
    error?: string;
  };
};

type ReadinessCheckInput = {
  companyId: string;
  issueId: string;
  folderKey?: string | null;
  checks?: unknown;
};

type ReadinessCheckResult = {
  issueId: string;
  companyId: string;
  runId: string | null;
  inventoryId: string;
  readinessGateId: string;
  status: "ready" | "blocked";
  folderKey: string;
  fileCount: number;
  truncated: boolean;
  checks: FactCheckResult[];
  blockingCount: number;
  reportDocumentKey: string;
};

let activeContext: PluginContext | null = null;
let startCycle: ((input: StartCycleInput) => Promise<TzProcessStatusResult>) | null = null;
let readStatus: ((companyId: string, issueId: string) => Promise<TzProcessStatusResult>) | null = null;
let runReadinessCheck: ((input: ReadinessCheckInput) => Promise<ReadinessCheckResult>) | null = null;

function tableName(
  ctx: PluginContext,
  table:
    | "tz_process_runs"
    | "tz_process_events"
    | "tz_process_artifacts"
    | "tz_repo_inventories"
    | "tz_fact_checks"
    | "tz_readiness_gates",
) {
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

const DEFAULT_READINESS_CHECKS: FactCheckDefinition[] = [
  {
    claimKey: "actor-context-class",
    claim: "`ActorContext` существует в коде",
    predicate: { kind: "text_search", text: "class ActorContext", paths: ["app", "src", "tests", "database"] },
  },
  {
    claimKey: "access-decision-service-class",
    claim: "`AccessDecisionService` существует в коде",
    predicate: { kind: "text_search", text: "class AccessDecisionService", paths: ["app", "src", "tests", "database"] },
  },
  {
    claimKey: "audit-events-storage",
    claim: "`audit_events` storage существует или создаётся миграцией",
    predicate: { kind: "regex_search", pattern: "audit_events|Schema::create\\(['\\\"]audit_events", paths: ["app", "src", "tests", "database"] },
  },
  {
    claimKey: "mutation-audit-recorder-class",
    claim: "`MutationAuditRecorder` существует в коде",
    predicate: { kind: "text_search", text: "class MutationAuditRecorder", paths: ["app", "src", "tests", "database"] },
  },
  {
    claimKey: "store-inbound-message-action-class",
    claim: "`StoreInboundMessageAction` существует как covered flow",
    predicate: { kind: "text_search", text: "class StoreInboundMessageAction", paths: ["app", "src", "tests"] },
  },
  {
    claimKey: "bitrix-runtime-callback-action-class",
    claim: "`HandleBitrix24RuntimeCallbackAction` существует как covered flow",
    predicate: { kind: "text_search", text: "class HandleBitrix24RuntimeCallbackAction", paths: ["app", "src", "tests"] },
  },
  {
    claimKey: "process-scenario-start-job-class",
    claim: "`ProcessScenarioStartJob` существует как internal queue/service path",
    predicate: { kind: "text_search", text: "class ProcessScenarioStartJob", paths: ["app", "src", "tests"] },
  },
];

const TEXT_FILE_EXTENSIONS = new Set([
  ".php",
  ".blade.php",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sql",
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".xml",
  ".env.example",
]);

function agentIsUsable(agent: Agent) {
  return agent.status !== "terminated" && agent.status !== "paused" && agent.status !== "pending_approval";
}

function normalizeAgentName(value: string) {
  return value.trim().toLowerCase();
}

function normalizeRepoPath(value: string) {
  return value.split(/[\\/]+/).filter(Boolean).join("/");
}

function fileExtension(path: string) {
  const normalized = normalizeRepoPath(path).toLowerCase();
  if (normalized.endsWith(".blade.php")) return ".blade.php";
  if (normalized.endsWith(".env.example")) return ".env.example";
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 ? normalized.slice(dot) : "";
}

function isTextRepoFile(path: string) {
  const normalized = normalizeRepoPath(path);
  if (normalized.includes("/vendor/") || normalized.startsWith("vendor/")) return false;
  if (normalized.includes("/node_modules/") || normalized.startsWith("node_modules/")) return false;
  if (normalized.includes("/.git/") || normalized.startsWith(".git/")) return false;
  return TEXT_FILE_EXTENSIONS.has(fileExtension(normalized));
}

function pathMatchesScope(path: string, scopes: string[] | undefined) {
  if (!scopes || scopes.length === 0) return true;
  const normalized = normalizeRepoPath(path);
  return scopes.some((scope) => {
    const normalizedScope = normalizeRepoPath(scope);
    if (!normalizedScope) return true;
    if (normalized === normalizedScope) return true;
    return normalized.startsWith(`${normalizedScope}/`);
  });
}

function parseFactPredicate(value: unknown): FactPredicate | null {
  const object = jsonObject(value);
  const kind = stringField(object.kind);

  if (kind === "file_exists") {
    const path = stringField(object.path);
    return path ? { kind, path: normalizeRepoPath(path) } : null;
  }

  if (kind === "text_search") {
    const text = typeof object.text === "string" ? object.text : "";
    if (!text) return null;
    const paths = jsonArray(object.paths).map((entry) => stringField(entry)).filter((entry): entry is string => Boolean(entry));
    return { kind, text, paths: paths.length > 0 ? paths : undefined };
  }

  if (kind === "regex_search") {
    const pattern = typeof object.pattern === "string" ? object.pattern : "";
    if (!pattern) return null;
    const flags = stringField(object.flags) ?? undefined;
    const paths = jsonArray(object.paths).map((entry) => stringField(entry)).filter((entry): entry is string => Boolean(entry));
    return { kind, pattern, flags, paths: paths.length > 0 ? paths : undefined };
  }

  return null;
}

function parseFactChecks(value: unknown): FactCheckDefinition[] {
  const entries = jsonArray(value);
  if (entries.length === 0) return DEFAULT_READINESS_CHECKS;

  const parsed = entries.flatMap((entry) => {
    const object = jsonObject(entry);
    const claimKey = stringField(object.claimKey) ?? stringField(object.claim_key);
    const claim = stringField(object.claim);
    const predicate = parseFactPredicate(object.predicate);
    if (!claimKey || !claim || !predicate) return [];
    return [{ claimKey, claim, predicate }];
  });

  return parsed.length > 0 ? parsed : DEFAULT_READINESS_CHECKS;
}

function factCommandLabel(check: FactCheckDefinition) {
  if (check.predicate.kind === "file_exists") {
    return `file_exists ${check.predicate.path}`;
  }

  if (check.predicate.kind === "text_search") {
    const scope = check.predicate.paths?.join(",") ?? "repo";
    return `text_search ${JSON.stringify(check.predicate.text)} in ${scope}`;
  }

  const scope = check.predicate.paths?.join(",") ?? "repo";
  return `regex_search /${check.predicate.pattern}/${check.predicate.flags ?? ""} in ${scope}`;
}

function lineSnippet(line: string) {
  return line.trim().replace(/\s+/g, " ").slice(0, 240);
}

function checkPathExists(files: string[], check: FactCheckDefinition): FactCheckResult {
  if (check.predicate.kind !== "file_exists") {
    throw new Error("checkPathExists requires file_exists predicate");
  }

  const target = normalizeRepoPath(check.predicate.path);
  const found = files.includes(target);
  return {
    ...check,
    commandLabel: factCommandLabel(check),
    status: found ? "confirmed" : "missing",
    evidence: {
      output: found ? target : "0 matches",
      matches: found ? [{ path: target }] : [],
    },
  };
}

async function checkTextSearch(
  ctx: PluginContext,
  input: {
    companyId: string;
    folderKey: string;
    files: string[];
    check: FactCheckDefinition;
  },
): Promise<FactCheckResult> {
  const predicate = input.check.predicate;
  if (predicate.kind !== "text_search" && predicate.kind !== "regex_search") {
    throw new Error("checkTextSearch requires text or regex predicate");
  }

  const matches: FactCheckResult["evidence"]["matches"] = [];
  let regex: RegExp | null = null;
  if (predicate.kind === "regex_search") {
    try {
      regex = new RegExp(predicate.pattern, predicate.flags);
    } catch (err) {
      return {
        ...input.check,
        commandLabel: factCommandLabel(input.check),
        status: "error",
        evidence: {
          output: "invalid regex",
          matches: [],
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  for (const file of input.files) {
    if (!pathMatchesScope(file, predicate.paths)) continue;
    if (!isTextRepoFile(file)) continue;

    let contents = "";
    try {
      contents = await ctx.localFolders.readText(input.companyId, input.folderKey, file);
    } catch {
      continue;
    }

    const lines = contents.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const isMatch = predicate.kind === "text_search"
        ? line.includes(predicate.text)
        : Boolean(regex?.test(line));
      if (!isMatch) continue;
      matches.push({
        path: file,
        line: index + 1,
        snippet: lineSnippet(line),
      });
      if (matches.length >= 20) break;
    }
    if (matches.length >= 20) break;
  }

  return {
    ...input.check,
    commandLabel: factCommandLabel(input.check),
    status: matches.length > 0 ? "confirmed" : "missing",
    evidence: {
      output: matches.length > 0
        ? matches.map((match) => `${match.path}${match.line ? `:${match.line}` : ""}: ${match.snippet ?? ""}`).join("\n")
        : "0 matches",
      matches,
    },
  };
}

function selectAuthorAgent(agents: Agent[], definition: DraftAuthorDefinition): Agent | null {
  const usable = agents.filter((agent) => agentIsUsable(agent) && agent.adapterType === definition.adapterType);
  const exactNames = new Set(definition.exactNames.map(normalizeAgentName));
  return usable.find((agent) => exactNames.has(normalizeAgentName(agent.name)))
    ?? usable.find((agent) => normalizeAgentName(agent.name).includes("автор"))
    ?? usable[0]
    ?? null;
}

function selectCtoAgent(agents: Agent[]): Agent | null {
  const usable = agents.filter(agentIsUsable);
  return usable.find((agent) => normalizeAgentName(agent.name) === "cto")
    ?? usable.find((agent) => normalizeAgentName(agent.name).includes("cto"))
    ?? usable.find((agent) => normalizeAgentName(agent.name).includes("техничес"))
    ?? usable.find((agent) => normalizeAgentName(agent.name).includes("синтез"))
    ?? null;
}

function selectQaAgent(agents: Agent[], definition: QaReviewerDefinition): Agent | null {
  const usable = agents.filter((agent) => agentIsUsable(agent) && agent.adapterType === definition.adapterType);
  const exactNames = new Set(definition.exactNames.map(normalizeAgentName));
  return usable.find((agent) => exactNames.has(normalizeAgentName(agent.name)))
    ?? usable.find((agent) => normalizeAgentName(agent.name).includes("qa"))
    ?? usable[0]
    ?? null;
}

function draftIssueOriginId(runId: string, roleKey: DraftAuthorRoleKey, roundNumber = 0) {
  return `${runId}:${roleKey}:r${roundNumber}`;
}

function pingPongIssueOriginId(runId: string, roleKey: DraftAuthorRoleKey, roundNumber = 1) {
  return `${runId}:${roleKey}:r${roundNumber}`;
}

function convergenceCheckIssueOriginId(runId: string, roleKey: DraftAuthorRoleKey, roundNumber = 1) {
  return `${runId}:${roleKey}:r${roundNumber}`;
}

function synthesisIssueOriginId(runId: string, roundNumber = 1) {
  return `${runId}:cto-synthesis:r${roundNumber}`;
}

function qaReviewIssueOriginId(runId: string, roleKey: QaReviewerRoleKey, roundNumber = 1) {
  return `${runId}:${roleKey}:r${roundNumber}`;
}

function pingPongState(roundNumber: number) {
  return `ping_pong_round_${roundNumber}_dispatched`;
}

function convergenceCheckState(roundNumber: number) {
  return `convergence_check_round_${roundNumber}_dispatched`;
}

function pingPongSelectedAgentsKey(roundNumber: number) {
  return `pingPongRound${roundNumber}`;
}

function convergenceCheckSelectedAgentsKey(roundNumber: number) {
  return `convergenceCheckRound${roundNumber}`;
}

function synthesisSelectedAgentsKey(roundNumber: number) {
  return `synthesisRound${roundNumber}`;
}

function qaSelectedAgentsKey(roundNumber: number) {
  return `qaRound${roundNumber}`;
}

function qaState(roundNumber: number) {
  return `qa_round_${roundNumber}_dispatched`;
}

function authorByRoleKey(roleKey: DraftAuthorRoleKey) {
  return DRAFT_AUTHORS.find((author) => author.roleKey === roleKey);
}

function selectedAgentRecordFrom(value: unknown): SelectedAgentRecord {
  const record = jsonObject(value);
  return {
    agentId: stringField(record.agentId),
    agentName: stringField(record.agentName),
    adapterType: stringField(record.adapterType),
    issueId: stringField(record.issueId),
    issueIdentifier: stringField(record.issueIdentifier),
    wakeupRunId: stringField(record.wakeupRunId),
  };
}

function selectedAgentRecord(run: TzProcessRunSummary, roleKey: DraftAuthorRoleKey): SelectedAgentRecord {
  const selectedAgents = jsonObject(run.selectedAgents);
  return selectedAgentRecordFrom(selectedAgents[roleKey]);
}

function selectedRoundAgentRecord(
  run: TzProcessRunSummary,
  roundKey: string,
  roleKey: DraftAuthorRoleKey,
): SelectedAgentRecord {
  const selectedAgents = jsonObject(run.selectedAgents);
  const round = jsonObject(selectedAgents[roundKey]);
  return selectedAgentRecordFrom(round[roleKey]);
}

function parseConvergenceVerdict(text: string): ParsedConvergenceVerdict {
  const matches = [...text.matchAll(/(?:verdict|вердикт)\s*[:：]\s*`?\**\s*(СОШЛИСЬ|ИТЕРИРУЕМ)/giu)];
  const last = matches[matches.length - 1];
  if (!last?.[1]) {
    return {
      verdict: "unknown",
      remainingDeltasEmpty: false,
      raw: text,
    };
  }
  const tail = text.slice(last.index ?? 0);
  const value = last[1].toUpperCase();
  const remainingDeltasEmpty = /remaining_deltas\s*:\s*\[\s*\]/iu.test(tail)
    || /remaining_deltas\s*:\s*null/iu.test(tail)
    || /remaining_deltas\s*:\s*нет/iu.test(tail)
    || /remaining[_\s-]*deltas[^.\n\r]*(?:пуст|нет|отсутств)/iu.test(tail);
  return {
    verdict: value === "СОШЛИСЬ" ? "converged" : "iterate",
    remainingDeltasEmpty,
    raw: tail,
  };
}

function parseQaVerdict(text: string): ParsedQaVerdict {
  const statusMatches = [...text.matchAll(/qa_status\s*:\s*`?\**\s*(ACCEPTED|BLOCKED)/giu)];
  const lastStatus = statusMatches[statusMatches.length - 1]?.[1]?.toUpperCase();
  const acceptedByText = /(?:вердикт|итоговый вердикт)\s*[:：]\s*(?:\*\*)?\s*ПРИНЯТО/iu.test(text)
    || /блокеров\s+нет/iu.test(text);
  const blockedByText = /(?:вердикт|итоговый вердикт)\s*[:：]\s*(?:\*\*)?\s*(?:ВОЗВРАЩЕНО|BLOCKED|НЕ\s+ПРИНЯТО)/iu.test(text)
    || /нельзя\s+нести\s+на\s+ворота\s+оператора/iu.test(text);
  const status = lastStatus === "ACCEPTED" || (!lastStatus && acceptedByText)
    ? "accepted"
    : lastStatus === "BLOCKED" || (!lastStatus && blockedByText)
      ? "blocked"
      : "unknown";
  const blockerTargets = [...new Set(
    [...text.matchAll(/target\s*:\s*`?\**\s*(synthesis|authors|operator)/giu)]
      .map((match) => match[1]?.toLowerCase())
      .filter((value): value is QaBlockerTarget =>
        value === "synthesis" || value === "authors" || value === "operator"),
  )];
  const blockerSummaries = [...text.matchAll(/summary\s*:\s*["“]?([^"\n”]+)/giu)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return {
    status,
    blockerTargets,
    blockerSummaries,
    raw: text,
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

async function findExistingConvergenceCheckIssue(
  ctx: PluginContext,
  companyId: string,
  run: TzProcessRunSummary,
  author: DraftAuthorDefinition,
  roundNumber: number,
) {
  const existing = await ctx.issues.list({
    companyId,
    originKind: CONVERGENCE_CHECK_ORIGIN_KIND,
    originId: convergenceCheckIssueOriginId(run.id, author.roleKey, roundNumber),
    includePluginOperations: true,
    limit: 1,
  });
  return existing[0] ?? null;
}

async function findExistingSynthesisIssue(
  ctx: PluginContext,
  companyId: string,
  run: TzProcessRunSummary,
  roundNumber: number,
) {
  const existing = await ctx.issues.list({
    companyId,
    originKind: SYNTHESIS_ORIGIN_KIND,
    originId: synthesisIssueOriginId(run.id, roundNumber),
    includePluginOperations: true,
    limit: 1,
  });
  return existing[0] ?? null;
}

async function findExistingQaReviewIssue(
  ctx: PluginContext,
  companyId: string,
  run: TzProcessRunSummary,
  reviewer: QaReviewerDefinition,
  roundNumber: number,
) {
  const existing = await ctx.issues.list({
    companyId,
    originKind: QA_REVIEW_ORIGIN_KIND,
    originId: qaReviewIssueOriginId(run.id, reviewer.roleKey, roundNumber),
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

async function findPingPongIssueForAuthor(
  ctx: PluginContext,
  run: TzProcessRunSummary,
  author: DraftAuthorDefinition,
  roundNumber: number,
) {
  const selected = selectedRoundAgentRecord(run, pingPongSelectedAgentsKey(roundNumber), author.roleKey);
  if (selected.issueId) {
    const selectedIssue = await ctx.issues.get(selected.issueId, run.companyId);
    if (selectedIssue) return selectedIssue;
  }
  return findExistingPingPongIssue(ctx, run.companyId, run, author, roundNumber);
}

async function findConvergenceCheckIssueForAuthor(
  ctx: PluginContext,
  run: TzProcessRunSummary,
  author: DraftAuthorDefinition,
  roundNumber: number,
) {
  const selected = selectedRoundAgentRecord(run, convergenceCheckSelectedAgentsKey(roundNumber), author.roleKey);
  if (selected.issueId) {
    const selectedIssue = await ctx.issues.get(selected.issueId, run.companyId);
    if (selectedIssue) return selectedIssue;
  }
  return findExistingConvergenceCheckIssue(ctx, run.companyId, run, author, roundNumber);
}

async function findSynthesisIssueForRun(
  ctx: PluginContext,
  run: TzProcessRunSummary,
  roundNumber: number,
) {
  const selectedAgents = jsonObject(run.selectedAgents);
  const selected = selectedAgentRecordFrom(jsonObject(selectedAgents[synthesisSelectedAgentsKey(roundNumber)]).cto);
  if (selected.issueId) {
    const selectedIssue = await ctx.issues.get(selected.issueId, run.companyId);
    if (selectedIssue) return selectedIssue;
  }
  return findExistingSynthesisIssue(ctx, run.companyId, run, roundNumber);
}

async function findQaReviewIssueForReviewer(
  ctx: PluginContext,
  run: TzProcessRunSummary,
  reviewer: QaReviewerDefinition,
  roundNumber: number,
) {
  const selectedAgents = jsonObject(run.selectedAgents);
  const selected = selectedAgentRecordFrom(jsonObject(selectedAgents[qaSelectedAgentsKey(roundNumber)])[reviewer.roleKey]);
  if (selected.issueId) {
    const selectedIssue = await ctx.issues.get(selected.issueId, run.companyId);
    if (selectedIssue) return selectedIssue;
  }
  return findExistingQaReviewIssue(ctx, run.companyId, run, reviewer, roundNumber);
}

type CoreIssueCommentRow = {
  id: string;
  body: string;
  created_at: string;
};

function scoreDraftDocument(document: SelectedIssueDocument) {
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

function toSelectedIssueDocument(document: {
  id: string;
  key: string;
  title?: string | null;
  latestRevisionId?: string | null;
  body: string;
}): SelectedIssueDocument {
  return {
    id: document.id,
    key: document.key,
    title: document.title ?? null,
    latestRevisionId: document.latestRevisionId ?? null,
    body: document.body,
  };
}

async function selectDraftDocumentFromCoreTables(
  ctx: PluginContext,
  issue: Issue,
  companyId: string,
): Promise<DraftDocumentSelection | null> {
  const rows = await ctx.db.query<CoreIssueCommentRow>(
    `SELECT id::text AS id,
            body,
            created_at::text AS created_at
       FROM public.issue_comments
      WHERE issue_id = $1
        AND company_id = $2
        AND COALESCE(body, '') <> ''
      ORDER BY created_at DESC
      LIMIT 10`,
    [issue.id, companyId],
  );
  const documents = rows.map((row) => ({
    id: row.id,
    key: `issue-comment-${row.id}`,
    title: `Issue comment ${row.created_at}`,
    latestRevisionId: row.id,
    body: row.body,
  })).filter((document) => document.body.trim().length > 0);
  documents.sort((left, right) => scoreDraftDocument(right) - scoreDraftDocument(left));
  const document = documents[0];
  return document ? { issue, document, body: document.body } : null;
}

async function selectDraftDocument(
  ctx: PluginContext,
  issue: Issue,
  companyId: string,
): Promise<DraftDocumentSelection | null> {
  const summaries = await ctx.issues.documents.list(issue.id, companyId);
  const documents: SelectedIssueDocument[] = [];
  for (const summary of summaries) {
    const document = await ctx.issues.documents.get(issue.id, summary.key, companyId);
    if (document?.body.trim()) documents.push(toSelectedIssueDocument(document));
  }
  documents.sort((left, right) => scoreDraftDocument(right) - scoreDraftDocument(left));
  const document = documents[0];
  return document ? { issue, document, body: document.body } : selectDraftDocumentFromCoreTables(ctx, issue, companyId);
}

async function selectIssueOutputForDecision(
  ctx: PluginContext,
  issue: Issue,
  companyId: string,
): Promise<DraftDocumentSelection | null> {
  const selected = await selectDraftDocument(ctx, issue, companyId);
  const comments = await ctx.db.query<CoreIssueCommentRow>(
    `SELECT id::text AS id,
            body,
            created_at::text AS created_at
       FROM public.issue_comments
      WHERE issue_id = $1
        AND company_id = $2
        AND COALESCE(body, '') <> ''
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 20`,
    [issue.id, companyId],
  );
  const commentBody = comments
    .map((comment) => comment.body.trim())
    .filter(Boolean)
    .join("\n\n");
  if (selected) {
    return {
      ...selected,
      body: [selected.body, commentBody].filter(Boolean).join("\n\n"),
    };
  }
  if (!commentBody) return null;
  return {
    issue,
    document: {
      id: `issue-comments-${issue.id}`,
      key: "issue-comments",
      title: "Issue comments",
      latestRevisionId: null,
      body: commentBody,
    },
    body: commentBody,
  };
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
    `Это раунд согласования ${input.roundNumber} для создания ТЗ.`,
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

function buildConvergenceCheckPrompt(input: {
  issue: Issue;
  run: TzProcessRunSummary;
  author: DraftAuthorDefinition;
  otherAuthor: DraftAuthorDefinition;
  ownPingPong: DraftDocumentSelection;
  otherPingPong: DraftDocumentSelection;
  roundNumber: number;
}) {
  const ownDocument = input.ownPingPong.document;
  const otherDocument = input.otherPingPong.document;
  const nextRoundNumber = input.roundNumber + 1;
  return [
    `Это проверка схождения после раунда согласования ${input.roundNumber}.`,
    "",
    "Цель:",
    "- Дать короткий структурный вердикт для движка процесса.",
    "- Не переписывать всё ТЗ заново.",
    "- Чётко сказать: можно идти к синтезу или нужен следующий раунд.",
    "",
    "Правила решения:",
    "- Если существенных спорных пунктов не осталось, верни `verdict: СОШЛИСЬ` и `remaining_deltas: []`.",
    `- Если остались содержательные расхождения, верни \`verdict: ИТЕРИРУЕМ\` и перечисли точные дельты для round ${nextRoundNumber}.`,
    "- Косметику, стиль и порядок разделов не считай блокером.",
    "- Блокером считай только то, что может сделать финальное ТЗ неверным, неполным или непроверяемым.",
    "",
    "Исходная задача:",
    input.issue.title,
    "",
    `Твой ответ в раунде согласования ${input.roundNumber}:`,
    `Документ: ${ownDocument.title ?? ownDocument.key}`,
    `document_id: ${ownDocument.id}`,
    `revision_id: ${ownDocument.latestRevisionId}`,
    "",
    input.ownPingPong.body,
    "",
    `Ответ ${input.otherAuthor.displayName} в раунде согласования ${input.roundNumber}:`,
    `Документ: ${otherDocument.title ?? otherDocument.key}`,
    `document_id: ${otherDocument.id}`,
    `revision_id: ${otherDocument.latestRevisionId}`,
    "",
    input.otherPingPong.body,
    "",
    "Ответ заверши строго таким структурным блоком:",
    "```yaml",
    "verdict: СОШЛИСЬ",
    "candidate:",
    "  source: merged",
    "  reason: \"Кратко почему можно синтезировать финальное ТЗ\"",
    "remaining_deltas: []",
    `round_${nextRoundNumber}_prompt: null`,
    "```",
    "",
    "Если нужен следующий раунд, используй такой вариант:",
    "```yaml",
    "verdict: ИТЕРИРУЕМ",
    "candidate:",
    "  source: null",
    "  reason: null",
    "remaining_deltas:",
    "  - id: \"delta-1\"",
    "    issue: \"Что именно расходится\"",
    "    why_it_matters: \"Почему это важно для финального ТЗ\"",
    `    suggested_resolution: "Какой вариант проверить в round ${nextRoundNumber}"`,
    `round_${nextRoundNumber}_prompt: |`,
    "  Короткая инструкция автору для следующего раунда.",
    "```",
  ].join("\n");
}

function buildPingPongFollowUpPrompt(input: {
  issue: Issue;
  run: TzProcessRunSummary;
  author: DraftAuthorDefinition;
  otherAuthor: DraftAuthorDefinition;
  ownCheck: DraftDocumentSelection;
  otherCheck: DraftDocumentSelection;
  ownVerdict: ParsedConvergenceVerdict;
  otherVerdict: ParsedConvergenceVerdict;
  roundNumber: number;
}) {
  return [
    `Это раунд согласования ${input.roundNumber} для создания ТЗ.`,
    "",
    "Почему запущен новый раунд:",
    "- После проверки схождения хотя бы один автор вернул `ИТЕРИРУЕМ`.",
    "- Нужно закрыть оставшиеся содержательные дельты, а не переписывать всё с нуля.",
    "",
    "Твоя задача:",
    "1. Изучи свой вердикт проверки схождения.",
    `2. Изучи вердикт ${input.otherAuthor.displayName}.`,
    `3. Закрой спорные пункты, из-за которых round ${input.roundNumber - 1} не был признан завершённым.`,
    "4. Предложи обновлённую лучшую версию ТЗ или точечный патч к ней.",
    "5. В конце снова дай структурный блок для движка процесса.",
    "",
    "Исходная задача:",
    input.issue.title,
    "",
    `Твоя предыдущая проверка схождения, раунд ${input.roundNumber - 1}:`,
    `Распознанный verdict: ${input.ownVerdict.verdict}`,
    `Документ: ${input.ownCheck.document.title ?? input.ownCheck.document.key}`,
    "",
    input.ownCheck.body,
    "",
    `Проверка схождения ${input.otherAuthor.displayName}, раунд ${input.roundNumber - 1}:`,
    `Распознанный verdict: ${input.otherVerdict.verdict}`,
    `Документ: ${input.otherCheck.document.title ?? input.otherCheck.document.key}`,
    "",
    input.otherCheck.body,
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
    "Если после этого раунда спорных пунктов не осталось, оставь remaining_deltas пустым и поставь verdict: СОШЛИСЬ.",
  ].join("\n");
}

function buildSynthesisPrompt(input: {
  issue: Issue;
  run: TzProcessRunSummary;
  codexPingPong: DraftDocumentSelection;
  claudePingPong: DraftDocumentSelection;
  codexCheck: DraftDocumentSelection;
  claudeCheck: DraftDocumentSelection;
  roundNumber: number;
}) {
  return [
    `Авторы сошлись после раунда ${input.roundNumber}. Нужно собрать финальное ТЗ.`,
    "",
    "Задача синтеза:",
    "1. Свести лучшие части версий Автор-Codex и Автор-Claude в один документ.",
    "2. Не выдумывать требования сверх входных материалов.",
    "3. Отдельно показать таблицу расхождений: позиция Codex / позиция Claude / решение / почему.",
    "4. Если остались решения оператора, вынести их в раздел `Открытые вопросы оператору` с вариантами и рекомендацией.",
    "5. Писать по-русски, заголовки тоже по-русски.",
    "",
    "Финальное ТЗ должно содержать:",
    "1. Цель",
    "2. Контекст",
    "3. Границы MVP",
    "4. Функциональные требования",
    "5. Нефункциональные требования",
    "6. Сценарии работы",
    "7. Ограничения и риски",
    "8. Критерии приёмки",
    "9. План проверки",
    "10. Таблица расхождений и решений",
    "11. Открытые вопросы оператору",
    "",
    "Исходная задача:",
    input.issue.title,
    "",
    "Версия/ход Автор-Codex:",
    input.codexPingPong.body,
    "",
    "Версия/ход Автор-Claude:",
    input.claudePingPong.body,
    "",
    "Проверка схождения Автор-Codex:",
    input.codexCheck.body,
    "",
    "Проверка схождения Автор-Claude:",
    input.claudeCheck.body,
    "",
    "В конце добавь короткий блок:",
    "```yaml",
    "synthesis_status: READY_FOR_QA",
    "open_operator_questions_count: 0",
    "```",
  ].join("\n");
}

function buildQaReviewPrompt(input: {
  issue: Issue;
  run: TzProcessRunSummary;
  reviewer: QaReviewerDefinition;
  synthesis: DraftDocumentSelection;
  roundNumber: number;
}) {
  return [
    `Нужно независимо проверить финальное ТЗ после синтеза, раунд ${input.roundNumber}.`,
    "",
    "Задача проверки:",
    "1. Проверить, закрывает ли финальное ТЗ исходную задачу.",
    "2. Найти блокеры: потерянные требования, противоречия, непроверяемые критерии, рискованные допущения.",
    "3. Не переписывать ТЗ целиком. Давать заключение и точечные замечания.",
    "4. Для каждого блокера указать, куда возвращать доработку:",
    "   - `synthesis` — синтезатор потерял или исказил уже согласованное;",
    "   - `authors` — нужна новая договорённость авторов по сути;",
    "   - `operator` — нужно решение человека по скоупу или бизнес-правилу.",
    "5. Писать по-русски, заголовки тоже по-русски.",
    "",
    "Исходная задача:",
    input.issue.title,
    "",
    "Финальное ТЗ для проверки:",
    input.synthesis.body,
    "",
    "Ответ заверши строго таким структурным блоком:",
    "```yaml",
    "qa_status: ACCEPTED",
    "blockers: []",
    "non_blocking_notes:",
    "  - \"...\"",
    "```",
    "",
    "Если есть блокеры, используй `qa_status: BLOCKED` и заполни `blockers` списком объектов с полями `target` и `summary`.",
    "Пример блокера:",
    "```yaml",
    "blockers:",
    "  - target: synthesis",
    "    summary: \"Синтез потерял согласованное требование.\"",
    "```",
  ].join("\n");
}

function buildQaAuthorReworkPrompt(input: {
  issue: Issue;
  run: TzProcessRunSummary;
  author: DraftAuthorDefinition;
  otherAuthor: DraftAuthorDefinition;
  synthesis: DraftDocumentSelection;
  codexQa: DraftDocumentSelection;
  claudeQa: DraftDocumentSelection;
  codexQaVerdict: ParsedQaVerdict;
  claudeQaVerdict: ParsedQaVerdict;
  roundNumber: number;
}) {
  return [
    `Это раунд согласования ${input.roundNumber} после QA-проверки финального ТЗ.`,
    "",
    "Задача:",
    "1. Изучи финальное ТЗ синтезатора.",
    "2. Изучи оба QA-заключения.",
    "3. Закрой блокеры, которые относятся к авторам или требуют пересогласования сути.",
    "4. Предложи обновлённую версию ТЗ со своей стороны.",
    "5. Пиши по-русски, заголовки тоже по-русски.",
    "",
    `Распознанный QA-вердикт Codex: ${input.codexQaVerdict.status}`,
    `Распознанный QA-вердикт Claude: ${input.claudeQaVerdict.status}`,
    "",
    "Финальное ТЗ синтезатора:",
    input.synthesis.body,
    "",
    "QA-Codex:",
    input.codexQa.body,
    "",
    "QA-Claude:",
    input.claudeQa.body,
    "",
    "Ответ заверши строго таким структурным блоком:",
    "```yaml",
    "review_of_qa:",
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
    "Если после доработки спорных пунктов не осталось, оставь remaining_deltas пустым и поставь verdict: СОШЛИСЬ.",
  ].join("\n");
}

function buildQaSynthesisReworkPrompt(input: {
  issue: Issue;
  run: TzProcessRunSummary;
  synthesis: DraftDocumentSelection;
  codexQa: DraftDocumentSelection;
  claudeQa: DraftDocumentSelection;
  roundNumber: number;
}) {
  return [
    `Нужно доработать финальное ТЗ после QA-проверки, раунд ${input.roundNumber}.`,
    "",
    "Задача:",
    "1. Исправить блокеры, которые относятся к синтезу.",
    "2. Не открывать заново спор авторов, если QA не требует этого явно.",
    "3. Сохранить таблицу решений и причины.",
    "4. Писать по-русски, заголовки тоже по-русски.",
    "",
    "Предыдущий синтез:",
    input.synthesis.body,
    "",
    "QA-Codex:",
    input.codexQa.body,
    "",
    "QA-Claude:",
    input.claudeQa.body,
    "",
    "В конце добавь короткий блок:",
    "```yaml",
    "synthesis_status: READY_FOR_QA",
    "open_operator_questions_count: 0",
    "```",
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

async function recordConvergenceCheckIssueArtifact(
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
      CONVERGENCE_CHECK_ARTIFACT_KEY,
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

async function recordSynthesisIssueArtifact(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    roundNumber: number;
    agent: Agent;
    issue: Issue;
    wakeupRunId: string | null;
  },
) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx, "tz_process_artifacts")}
       (id, run_id, company_id, role_key, round_number, artifact_key, visibility, content, metadata)
     VALUES ($1, $2, $3, 'cto', $4, $5, 'public', $6, $7::jsonb)
     ON CONFLICT (run_id, role_key, round_number, artifact_key) DO UPDATE SET
       content = EXCLUDED.content,
       metadata = EXCLUDED.metadata,
       updated_at = now()`,
    [
      randomUUID(),
      input.run.id,
      input.run.companyId,
      input.roundNumber,
      SYNTHESIS_ARTIFACT_KEY,
      input.issue.description ?? "",
      JSON.stringify({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier ?? null,
        issueTitle: input.issue.title,
        agentId: input.agent.id,
        agentName: input.agent.name,
        adapterType: input.agent.adapterType,
        wakeupRunId: input.wakeupRunId,
      }),
    ],
  );
}

async function recordQaReviewIssueArtifact(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    roundNumber: number;
    reviewer: QaReviewerDefinition;
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
      input.reviewer.roleKey,
      input.roundNumber,
      QA_REVIEW_ARTIFACT_KEY,
      input.issue.description ?? "",
      JSON.stringify({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier ?? null,
        issueTitle: input.issue.title,
        reviewer: input.reviewer.displayName,
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

async function activeRunsForPingPongIssue(
  ctx: PluginContext,
  companyId: string,
  pingPongIssueId: string,
): Promise<TzProcessRunSummary[]> {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE company_id = $1
        AND status = 'iterating'
        AND state = ('ping_pong_round_' || current_round::text || '_dispatched')
        AND (
          selected_agents #>> ARRAY['pingPongRound' || current_round::text, 'author-codex', 'issueId'] = $2
          OR selected_agents #>> ARRAY['pingPongRound' || current_round::text, 'author-claude', 'issueId'] = $2
        )
      ORDER BY updated_at ASC
      LIMIT 10`,
    [companyId, pingPongIssueId],
  );
  return rows.map(normalizeRun);
}

async function activeRunsForConvergenceCheckIssue(
  ctx: PluginContext,
  companyId: string,
  convergenceCheckIssueId: string,
): Promise<TzProcessRunSummary[]> {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE company_id = $1
        AND status = 'iterating'
        AND state = ('convergence_check_round_' || current_round::text || '_dispatched')
        AND (
          selected_agents #>> ARRAY['convergenceCheckRound' || current_round::text, 'author-codex', 'issueId'] = $2
          OR selected_agents #>> ARRAY['convergenceCheckRound' || current_round::text, 'author-claude', 'issueId'] = $2
        )
      ORDER BY updated_at ASC
      LIMIT 10`,
    [companyId, convergenceCheckIssueId],
  );
  return rows.map(normalizeRun);
}

async function activeRunsForSynthesisIssue(
  ctx: PluginContext,
  companyId: string,
  synthesisIssueId: string,
): Promise<TzProcessRunSummary[]> {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE company_id = $1
        AND status = 'synthesizing'
        AND state = 'cto_synthesis_dispatched'
        AND selected_agents #>> ARRAY['synthesisRound' || current_round::text, 'cto', 'issueId'] = $2
      ORDER BY updated_at ASC
      LIMIT 10`,
    [companyId, synthesisIssueId],
  );
  return rows.map(normalizeRun);
}

async function activeRunsForQaReviewIssue(
  ctx: PluginContext,
  companyId: string,
  qaIssueId: string,
): Promise<TzProcessRunSummary[]> {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE company_id = $1
        AND status = 'qa'
        AND state = ('qa_round_' || current_round::text || '_dispatched')
        AND (
          selected_agents #>> ARRAY['qaRound' || current_round::text, 'qa-codex', 'issueId'] = $2
          OR selected_agents #>> ARRAY['qaRound' || current_round::text, 'qa-claude', 'issueId'] = $2
        )
      ORDER BY updated_at ASC
      LIMIT 10`,
    [companyId, qaIssueId],
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
    "Этот документ ведёт плагин движка ТЗ. Видимая трасса хранится здесь, а авторитетное состояние процесса живёт в namespace плагина в Postgres.",
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

function readinessReportBody(input: {
  issue: Issue;
  result: ReadinessCheckResult;
}) {
  const checkRows = input.result.checks.map((check) => [
    "|",
    check.status,
    "|",
    check.claimKey,
    "|",
    check.claim.replaceAll("|", "\\|"),
    "|",
    check.commandLabel.replaceAll("|", "\\|"),
    "|",
    check.evidence.output.replaceAll("\n", "<br>").replaceAll("|", "\\|"),
    "|",
  ].join(" "));

  return [
    "# Repo Inventory / Fact Ledger",
    "",
    `Задача: ${input.issue.identifier ?? input.issue.title}`,
    `Статус readiness: ${input.result.status}`,
    `Inventory ID: ${input.result.inventoryId}`,
    `Readiness Gate ID: ${input.result.readinessGateId}`,
    `Папка проекта: ${input.result.folderKey}`,
    `Файлов проверено: ${input.result.fileCount}${input.result.truncated ? " (список усечён)" : ""}`,
    `Блокирующих фактов: ${input.result.blockingCount}`,
    "",
    "Правило: `confirmed` ставит только код после чтения файлов из настроенной read-only папки проекта. Агент может предложить предикат, но не подтверждает факт словом.",
    "",
    "| Статус | Claim key | Утверждение | Check | Реальный вывод |",
    "|---|---|---|---|---|",
    ...checkRows,
  ].join("\n");
}

async function writeReadinessReportDocument(
  ctx: PluginContext,
  input: {
    issue: Issue;
    result: ReadinessCheckResult;
  },
) {
  const existing = await ctx.issues.documents.get(input.issue.id, READINESS_REPORT_DOCUMENT_KEY, input.issue.companyId);
  await ctx.issues.documents.upsert({
    issueId: input.issue.id,
    companyId: input.issue.companyId,
    key: READINESS_REPORT_DOCUMENT_KEY,
    title: "Repo Inventory / Fact Ledger",
    format: "markdown",
    body: readinessReportBody(input),
    changeSummary: "Updated code-enforced readiness checks",
    baseRevisionId: existing?.latestRevisionId ?? null,
  });
}

async function recordReadinessResult(
  ctx: PluginContext,
  input: {
    issue: Issue;
    run: TzProcessRunSummary | null;
    folderKey: string;
    folderPath: string | null;
    fileCount: number;
    truncated: boolean;
    checks: FactCheckResult[];
  },
): Promise<ReadinessCheckResult> {
  const inventoryId = randomUUID();
  const readinessGateId = randomUUID();
  const blockingChecks = input.checks.filter((check) => check.status !== "confirmed");
  const status: ReadinessCheckResult["status"] = blockingChecks.length === 0 ? "ready" : "blocked";

  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx, "tz_repo_inventories")}
       (id, company_id, root_issue_id, run_id, folder_key, status, repo_path, file_count, truncated, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      inventoryId,
      input.issue.companyId,
      input.issue.id,
      input.run?.id ?? null,
      input.folderKey,
      "completed",
      input.folderPath,
      input.fileCount,
      input.truncated,
      JSON.stringify({
        source: "localFolders",
        reportDocumentKey: READINESS_REPORT_DOCUMENT_KEY,
      }),
    ],
  );

  for (const check of input.checks) {
    await ctx.db.execute(
      `INSERT INTO ${tableName(ctx, "tz_fact_checks")}
         (id, inventory_id, company_id, root_issue_id, run_id, claim_key, claim, predicate, command_label, status, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb)`,
      [
        randomUUID(),
        inventoryId,
        input.issue.companyId,
        input.issue.id,
        input.run?.id ?? null,
        check.claimKey,
        check.claim,
        JSON.stringify(check.predicate),
        check.commandLabel,
        check.status,
        JSON.stringify(check.evidence),
      ],
    );
  }

  const summary = status === "ready"
    ? "Все проверяемые факты подтверждены кодом."
    : `Readiness заблокирован: ${blockingChecks.length} факт(ов) не подтверждены кодом.`;

  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx, "tz_readiness_gates")}
       (id, inventory_id, company_id, root_issue_id, run_id, status, blocking_count, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      readinessGateId,
      inventoryId,
      input.issue.companyId,
      input.issue.id,
      input.run?.id ?? null,
      status,
      blockingChecks.length,
      summary,
      JSON.stringify({
        blockingClaimKeys: blockingChecks.map((check) => check.claimKey),
      }),
    ],
  );

  const result: ReadinessCheckResult = {
    issueId: input.issue.id,
    companyId: input.issue.companyId,
    runId: input.run?.id ?? null,
    inventoryId,
    readinessGateId,
    status,
    folderKey: input.folderKey,
    fileCount: input.fileCount,
    truncated: input.truncated,
    checks: input.checks,
    blockingCount: blockingChecks.length,
    reportDocumentKey: READINESS_REPORT_DOCUMENT_KEY,
  };

  await writeReadinessReportDocument(ctx, { issue: input.issue, result });
  await ctx.activity.log({
    companyId: input.issue.companyId,
    message: status === "ready"
      ? "Repo Inventory / Fact Ledger подтверждён кодом"
      : "Repo Inventory / Fact Ledger заблокировал readiness",
    entityType: "issue",
    entityId: input.issue.id,
    metadata: {
      inventoryId,
      readinessGateId,
      status,
      blockingCount: blockingChecks.length,
      reportDocumentKey: READINESS_REPORT_DOCUMENT_KEY,
    },
  });

  if (input.run) {
    await appendEvent(ctx, {
      runId: input.run.id,
      companyId: input.issue.companyId,
      eventType: "repo_fact_readiness_checked",
      payload: {
        issueId: input.issue.id,
        inventoryId,
        readinessGateId,
        status,
        blockingCount: blockingChecks.length,
      },
    });
  }

  return result;
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
    title: `${rootLabel} слепой раунд 0: черновик ТЗ от ${input.author.displayName}`,
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
    title: `${rootLabel} раунд согласования ${input.roundNumber}: ${input.author.displayName} отвечает ${input.otherAuthor.displayName}`,
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

async function createOrReuseConvergenceCheckIssue(
  ctx: PluginContext,
  input: {
    issue: Issue;
    run: TzProcessRunSummary;
    author: DraftAuthorDefinition;
    otherAuthor: DraftAuthorDefinition;
    agent: Agent;
    ownPingPong: DraftDocumentSelection;
    otherPingPong: DraftDocumentSelection;
    roundNumber: number;
  },
) {
  const existing = await findExistingConvergenceCheckIssue(
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
    title: `${rootLabel} проверка схождения, раунд ${input.roundNumber}: ${input.author.displayName} подтверждает схождение`,
    description: buildConvergenceCheckPrompt(input),
    status: "todo",
    priority: input.issue.priority ?? "medium",
    assigneeAgentId: input.agent.id,
    requestDepth: input.issue.requestDepth + 1,
    billingCode: input.issue.billingCode,
    originKind: CONVERGENCE_CHECK_ORIGIN_KIND,
    originId: convergenceCheckIssueOriginId(input.run.id, input.author.roleKey, input.roundNumber),
    originRunId: input.run.id,
  });
}

async function createOrReuseSynthesisIssue(
  ctx: PluginContext,
  input: {
    issue: Issue;
    run: TzProcessRunSummary;
    agent: Agent;
    codexPingPong: DraftDocumentSelection;
    claudePingPong: DraftDocumentSelection;
    codexCheck: DraftDocumentSelection;
    claudeCheck: DraftDocumentSelection;
    roundNumber: number;
  },
) {
  const existing = await findExistingSynthesisIssue(ctx, input.run.companyId, input.run, input.roundNumber);
  if (existing) return existing;

  const rootLabel = input.issue.identifier ?? input.issue.title;
  return ctx.issues.create({
    companyId: input.run.companyId,
    projectId: input.issue.projectId ?? undefined,
    goalId: input.issue.goalId ?? undefined,
    parentId: input.issue.id,
    inheritExecutionWorkspaceFromIssueId: input.issue.id,
    title: `${rootLabel} Синтез финального ТЗ после схождения, раунд ${input.roundNumber}`,
    description: buildSynthesisPrompt(input),
    status: "todo",
    priority: input.issue.priority ?? "medium",
    assigneeAgentId: input.agent.id,
    requestDepth: input.issue.requestDepth + 1,
    billingCode: input.issue.billingCode,
    originKind: SYNTHESIS_ORIGIN_KIND,
    originId: synthesisIssueOriginId(input.run.id, input.roundNumber),
    originRunId: input.run.id,
  });
}

async function createOrReuseQaReviewIssue(
  ctx: PluginContext,
  input: {
    issue: Issue;
    run: TzProcessRunSummary;
    reviewer: QaReviewerDefinition;
    agent: Agent;
    synthesis: DraftDocumentSelection;
    roundNumber: number;
  },
) {
  const existing = await findExistingQaReviewIssue(
    ctx,
    input.run.companyId,
    input.run,
    input.reviewer,
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
    title: `${rootLabel} QA-проверка финального ТЗ, раунд ${input.roundNumber}: ${input.reviewer.displayName}`,
    description: buildQaReviewPrompt(input),
    status: "todo",
    priority: input.issue.priority ?? "medium",
    assigneeAgentId: input.agent.id,
    requestDepth: input.issue.requestDepth + 1,
    billingCode: input.issue.billingCode,
    originKind: QA_REVIEW_ORIGIN_KIND,
    originId: qaReviewIssueOriginId(input.run.id, input.reviewer.roleKey, input.roundNumber),
    originRunId: input.run.id,
  });
}

async function createOrReuseQaAuthorReworkIssue(
  ctx: PluginContext,
  input: {
    issue: Issue;
    run: TzProcessRunSummary;
    author: DraftAuthorDefinition;
    otherAuthor: DraftAuthorDefinition;
    agent: Agent;
    synthesis: DraftDocumentSelection;
    codexQa: DraftDocumentSelection;
    claudeQa: DraftDocumentSelection;
    codexQaVerdict: ParsedQaVerdict;
    claudeQaVerdict: ParsedQaVerdict;
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
    title: `${rootLabel} раунд согласования ${input.roundNumber}: ${input.author.displayName} закрывает QA-блокеры`,
    description: buildQaAuthorReworkPrompt(input),
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

async function createOrReuseQaSynthesisReworkIssue(
  ctx: PluginContext,
  input: {
    issue: Issue;
    run: TzProcessRunSummary;
    agent: Agent;
    synthesis: DraftDocumentSelection;
    codexQa: DraftDocumentSelection;
    claudeQa: DraftDocumentSelection;
    roundNumber: number;
  },
) {
  const existing = await findExistingSynthesisIssue(ctx, input.run.companyId, input.run, input.roundNumber);
  if (existing) return existing;

  const rootLabel = input.issue.identifier ?? input.issue.title;
  return ctx.issues.create({
    companyId: input.run.companyId,
    projectId: input.issue.projectId ?? undefined,
    goalId: input.issue.goalId ?? undefined,
    parentId: input.issue.id,
    inheritExecutionWorkspaceFromIssueId: input.issue.id,
    title: `${rootLabel} Доработка финального ТЗ после QA, раунд ${input.roundNumber}`,
    description: buildQaSynthesisReworkPrompt(input),
    status: "todo",
    priority: input.issue.priority ?? "medium",
    assigneeAgentId: input.agent.id,
    requestDepth: input.issue.requestDepth + 1,
    billingCode: input.issue.billingCode,
    originKind: SYNTHESIS_ORIGIN_KIND,
    originId: synthesisIssueOriginId(input.run.id, input.roundNumber),
    originRunId: input.run.id,
  });
}

async function createOrReuseFollowUpPingPongIssue(
  ctx: PluginContext,
  input: {
    issue: Issue;
    run: TzProcessRunSummary;
    author: DraftAuthorDefinition;
    otherAuthor: DraftAuthorDefinition;
    agent: Agent;
    ownCheck: DraftDocumentSelection;
    otherCheck: DraftDocumentSelection;
    ownVerdict: ParsedConvergenceVerdict;
    otherVerdict: ParsedConvergenceVerdict;
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
    title: `${rootLabel} раунд согласования ${input.roundNumber}: ${input.author.displayName} закрывает дельты`,
    description: buildPingPongFollowUpPrompt(input),
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
      reason: "Движок ТЗ: запустить слепой раунд 0",
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
    message: "Раунд согласования 1 не запущен: не хватает готовых черновиков или документов",
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
      reason: "Движок ТЗ: запустить раунд согласования 1",
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
    message: "Раунд согласования 1 запущен: авторы получили черновики друг друга",
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

async function markRunNeedsOperatorForMissingPingPongOutputs(
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
        AND status = 'iterating'
        AND state = $4`,
    [input.run.id, input.run.companyId, input.reason, input.run.state],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: "convergence_check_blocked_missing_ping_pong_outputs",
    payload: {
      issueId: input.issue.id,
      reason: input.reason,
      ...input.details,
    },
  });
  await ctx.activity.log({
    companyId: input.run.companyId,
    message: "Проверка схождения не запущена: не хватает ответов раунда согласования или документов",
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

async function dispatchConvergenceCheckIfReady(ctx: PluginContext, run: TzProcessRunSummary) {
  const roundNumber = run.currentRound;
  if (run.status !== "iterating" || run.state !== pingPongState(roundNumber)) return;

  const issue = await ctx.issues.get(run.rootIssueId, run.companyId);
  if (!issue) throw new Error(`Issue not found: ${run.rootIssueId}`);

  const codexAuthor = authorByRoleKey("author-codex");
  const claudeAuthor = authorByRoleKey("author-claude");
  if (!codexAuthor || !claudeAuthor) throw new Error("Draft author definitions are incomplete");

  const codexPingPongIssue = await findPingPongIssueForAuthor(ctx, run, codexAuthor, roundNumber);
  const claudePingPongIssue = await findPingPongIssueForAuthor(ctx, run, claudeAuthor, roundNumber);
  if (!codexPingPongIssue || !claudePingPongIssue) {
    await markRunNeedsOperatorForMissingPingPongOutputs(ctx, {
      run,
      issue,
      reason: "missing_ping_pong_issues",
      details: {
        codexPingPongIssueId: codexPingPongIssue?.id ?? null,
        claudePingPongIssueId: claudePingPongIssue?.id ?? null,
      },
    });
    return;
  }

  if (codexPingPongIssue.status !== "done" || claudePingPongIssue.status !== "done") return;

  const codexPingPong = await selectDraftDocument(ctx, codexPingPongIssue, run.companyId);
  const claudePingPong = await selectDraftDocument(ctx, claudePingPongIssue, run.companyId);
  if (!codexPingPong || !claudePingPong) {
    await markRunNeedsOperatorForMissingPingPongOutputs(ctx, {
      run,
      issue,
      reason: "missing_ping_pong_documents",
      details: {
        codexPingPongIssueId: codexPingPongIssue.id,
        claudePingPongIssueId: claudePingPongIssue.id,
        codexDocumentFound: Boolean(codexPingPong),
        claudeDocumentFound: Boolean(claudePingPong),
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

  const checkTasks: ConvergenceCheckTaskResult[] = [];
  const codexIssue = await createOrReuseConvergenceCheckIssue(ctx, {
    issue,
    run,
    author: codexAuthor,
    otherAuthor: claudeAuthor,
    agent: codexAgent,
    ownPingPong: codexPingPong,
    otherPingPong: claudePingPong,
    roundNumber,
  });
  checkTasks.push({
    author: codexAuthor,
    otherAuthor: claudeAuthor,
    agent: codexAgent,
    issue: codexIssue,
    wakeupRunId: null,
    roundNumber,
  });

  const claudeIssue = await createOrReuseConvergenceCheckIssue(ctx, {
    issue,
    run,
    author: claudeAuthor,
    otherAuthor: codexAuthor,
    agent: claudeAgent,
    ownPingPong: claudePingPong,
    otherPingPong: codexPingPong,
    roundNumber,
  });
  checkTasks.push({
    author: claudeAuthor,
    otherAuthor: codexAuthor,
    agent: claudeAgent,
    issue: claudeIssue,
    wakeupRunId: null,
    roundNumber,
  });

  const wakeups = await ctx.issues.requestWakeups(
    checkTasks.map((task) => task.issue.id),
    run.companyId,
    {
      reason: `Движок ТЗ: проверить схождение после раунда согласования ${roundNumber}`,
      contextSource: `tz_process_engine.convergence_check_r${roundNumber}`,
      idempotencyKeyPrefix: `${run.id}:convergence-check-r${roundNumber}`,
    },
  );
  const wakeupByIssueId = new Map(wakeups.map((wakeup) => [wakeup.issueId, wakeup.runId ?? null]));
  for (const task of checkTasks) {
    task.wakeupRunId = wakeupByIssueId.get(task.issue.id) ?? null;
    await recordConvergenceCheckIssueArtifact(ctx, { run, ...task });
  }

  const previousSelectedAgents = jsonObject(run.selectedAgents);
  const convergenceCheckRound = Object.fromEntries(checkTasks.map((task) => [
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
    [convergenceCheckSelectedAgentsKey(roundNumber)]: convergenceCheckRound,
  };
  const nextState = convergenceCheckState(roundNumber);

  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'iterating',
            state = $3,
            current_round = $4,
            selected_agents = $5::jsonb,
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'iterating'
        AND state = $6`,
    [run.id, run.companyId, nextState, roundNumber, JSON.stringify(selectedAgents), pingPongState(roundNumber)],
  );
  await appendEvent(ctx, {
    runId: run.id,
    companyId: run.companyId,
    eventType: `convergence_check_round_${roundNumber}_tasks_created`,
    payload: {
      issueId: run.rootIssueId,
      sourcePingPongIssues: {
        [codexAuthor.roleKey]: codexPingPongIssue.id,
        [claudeAuthor.roleKey]: claudePingPongIssue.id,
      },
      tasks: checkTasks.map((task) => ({
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
    message: `Проверка схождения, раунд ${roundNumber}: авторы должны дать короткий вердикт`,
    entityType: "issue",
    entityId: run.rootIssueId,
    metadata: {
      runId: run.id,
      convergenceCheckIssueIds: checkTasks.map((task) => task.issue.id),
    },
  });
  await writeTraceDocument(ctx, run.rootIssueId, run.companyId, issue.title, {
    ...run,
    status: "iterating",
    state: nextState,
    currentRound: roundNumber,
    selectedAgents,
    updatedAt: new Date().toISOString(),
  });
}

async function markRunNeedsOperatorForConvergenceDecision(
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
        AND status = 'iterating'
        AND state = $4`,
    [input.run.id, input.run.companyId, input.reason, input.run.state],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: "convergence_decision_blocked",
    payload: {
      issueId: input.issue.id,
      reason: input.reason,
      ...input.details,
    },
  });
  await ctx.activity.log({
    companyId: input.run.companyId,
    message: "Движок процесса не смог автоматически принять решение после проверки схождения",
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

async function dispatchFollowUpPingPongFromConvergenceDecision(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    issue: Issue;
    codexAuthor: DraftAuthorDefinition;
    claudeAuthor: DraftAuthorDefinition;
    codexAgent: Agent;
    claudeAgent: Agent;
    codexCheck: DraftDocumentSelection;
    claudeCheck: DraftDocumentSelection;
    codexVerdict: ParsedConvergenceVerdict;
    claudeVerdict: ParsedConvergenceVerdict;
  },
) {
  const previousRoundNumber = input.run.currentRound;
  const roundNumber = previousRoundNumber + 1;
  const pingPongTasks: PingPongTaskResult[] = [];
  const codexIssue = await createOrReuseFollowUpPingPongIssue(ctx, {
    issue: input.issue,
    run: input.run,
    author: input.codexAuthor,
    otherAuthor: input.claudeAuthor,
    agent: input.codexAgent,
    ownCheck: input.codexCheck,
    otherCheck: input.claudeCheck,
    ownVerdict: input.codexVerdict,
    otherVerdict: input.claudeVerdict,
    roundNumber,
  });
  pingPongTasks.push({
    author: input.codexAuthor,
    otherAuthor: input.claudeAuthor,
    agent: input.codexAgent,
    issue: codexIssue,
    wakeupRunId: null,
    roundNumber,
  });

  const claudeIssue = await createOrReuseFollowUpPingPongIssue(ctx, {
    issue: input.issue,
    run: input.run,
    author: input.claudeAuthor,
    otherAuthor: input.codexAuthor,
    agent: input.claudeAgent,
    ownCheck: input.claudeCheck,
    otherCheck: input.codexCheck,
    ownVerdict: input.claudeVerdict,
    otherVerdict: input.codexVerdict,
    roundNumber,
  });
  pingPongTasks.push({
    author: input.claudeAuthor,
    otherAuthor: input.codexAuthor,
    agent: input.claudeAgent,
    issue: claudeIssue,
    wakeupRunId: null,
    roundNumber,
  });

  const wakeups = await ctx.issues.requestWakeups(
    pingPongTasks.map((task) => task.issue.id),
    input.run.companyId,
    {
      reason: `Движок ТЗ: запустить раунд согласования ${roundNumber} по оставшимся дельтам`,
      contextSource: `tz_process_engine.ping_pong_r${roundNumber}`,
      idempotencyKeyPrefix: `${input.run.id}:ping-pong-r${roundNumber}`,
    },
  );
  const wakeupByIssueId = new Map(wakeups.map((wakeup) => [wakeup.issueId, wakeup.runId ?? null]));
  for (const task of pingPongTasks) {
    task.wakeupRunId = wakeupByIssueId.get(task.issue.id) ?? null;
    await recordPingPongIssueArtifact(ctx, { run: input.run, ...task });
  }

  const previousSelectedAgents = jsonObject(input.run.selectedAgents);
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
    [pingPongSelectedAgentsKey(roundNumber)]: pingPongRound,
  };
  const nextState = pingPongState(roundNumber);

  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'iterating',
            state = $3,
            current_round = $4,
            selected_agents = $5::jsonb,
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'iterating'
        AND state = $6`,
    [
      input.run.id,
      input.run.companyId,
      nextState,
      roundNumber,
      JSON.stringify(selectedAgents),
      convergenceCheckState(previousRoundNumber),
    ],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: `ping_pong_round_${roundNumber}_tasks_created`,
    payload: {
      issueId: input.run.rootIssueId,
      decision: {
        codexVerdict: input.codexVerdict.verdict,
        claudeVerdict: input.claudeVerdict.verdict,
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
    companyId: input.run.companyId,
    message: `Раунд согласования ${roundNumber} запущен: после проверки схождения остались дельты`,
    entityType: "issue",
    entityId: input.run.rootIssueId,
    metadata: {
      runId: input.run.id,
      codexVerdict: input.codexVerdict.verdict,
      claudeVerdict: input.claudeVerdict.verdict,
      pingPongIssueIds: pingPongTasks.map((task) => task.issue.id),
    },
  });
  await writeTraceDocument(ctx, input.run.rootIssueId, input.run.companyId, input.issue.title, {
    ...input.run,
    status: "iterating",
    state: nextState,
    currentRound: roundNumber,
    selectedAgents,
    updatedAt: new Date().toISOString(),
  });
}

async function dispatchSynthesisFromConvergenceDecision(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    issue: Issue;
    ctoAgent: Agent;
    codexPingPong: DraftDocumentSelection;
    claudePingPong: DraftDocumentSelection;
    codexCheck: DraftDocumentSelection;
    claudeCheck: DraftDocumentSelection;
    roundNumber: number;
  },
) {
  const synthesisIssue = await createOrReuseSynthesisIssue(ctx, {
    ...input,
    agent: input.ctoAgent,
  });
  const wakeups = await ctx.issues.requestWakeups([synthesisIssue.id], input.run.companyId, {
    reason: "Движок ТЗ: запустить синтез финального ТЗ",
    contextSource: "tz_process_engine.cto_synthesis",
    idempotencyKeyPrefix: `${input.run.id}:cto-synthesis-r${input.roundNumber}`,
  });
  const wakeupRunId = wakeups[0]?.runId ?? null;
  const task: SynthesisTaskResult = {
    agent: input.ctoAgent,
    issue: synthesisIssue,
    wakeupRunId,
    roundNumber: input.roundNumber,
  };
  await recordSynthesisIssueArtifact(ctx, { run: input.run, ...task });

  const previousSelectedAgents = jsonObject(input.run.selectedAgents);
  const selectedAgents = {
    ...previousSelectedAgents,
    [synthesisSelectedAgentsKey(input.roundNumber)]: {
      cto: {
        agentId: input.ctoAgent.id,
        agentName: input.ctoAgent.name,
        adapterType: input.ctoAgent.adapterType,
        issueId: synthesisIssue.id,
        issueIdentifier: synthesisIssue.identifier ?? null,
        wakeupRunId,
      },
    },
  };
  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'synthesizing',
            state = 'cto_synthesis_dispatched',
            selected_agents = $3::jsonb,
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'iterating'
        AND state = $4`,
    [input.run.id, input.run.companyId, JSON.stringify(selectedAgents), convergenceCheckState(input.roundNumber)],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: "cto_synthesis_task_created",
    payload: {
      issueId: input.run.rootIssueId,
      synthesisIssueId: synthesisIssue.id,
      synthesisIssueIdentifier: synthesisIssue.identifier ?? null,
      wakeupRunId,
    },
  });
  await ctx.activity.log({
    companyId: input.run.companyId,
    message: "Синтез финального ТЗ запущен: оба автора подтвердили схождение",
    entityType: "issue",
    entityId: input.run.rootIssueId,
    metadata: {
      runId: input.run.id,
      synthesisIssueId: synthesisIssue.id,
      wakeupRunId,
    },
  });
  await writeTraceDocument(ctx, input.run.rootIssueId, input.run.companyId, input.issue.title, {
    ...input.run,
    status: "synthesizing",
    state: "cto_synthesis_dispatched",
    selectedAgents,
    updatedAt: new Date().toISOString(),
  });
}

async function markRunNeedsOperatorForQaDispatch(
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
        AND status = 'synthesizing'
        AND state = 'cto_synthesis_dispatched'`,
    [input.run.id, input.run.companyId, input.reason],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: "qa_dispatch_blocked",
    payload: {
      issueId: input.issue.id,
      reason: input.reason,
      ...input.details,
    },
  });
  await ctx.activity.log({
    companyId: input.run.companyId,
    message: "QA-проверка не запущена: движку процесса не хватает данных или QA-агентов",
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

async function dispatchQaReviewIfSynthesisReady(ctx: PluginContext, run: TzProcessRunSummary) {
  const roundNumber = run.currentRound;
  if (run.status !== "synthesizing" || run.state !== "cto_synthesis_dispatched") return;

  const issue = await ctx.issues.get(run.rootIssueId, run.companyId);
  if (!issue) throw new Error(`Issue not found: ${run.rootIssueId}`);

  const synthesisIssue = await findSynthesisIssueForRun(ctx, run, roundNumber);
  if (!synthesisIssue) {
    await markRunNeedsOperatorForQaDispatch(ctx, {
      run,
      issue,
      reason: "missing_synthesis_issue_for_qa",
      details: { roundNumber },
    });
    return;
  }
  if (synthesisIssue.status !== "done") return;

  const synthesis = await selectDraftDocument(ctx, synthesisIssue, run.companyId);
  if (!synthesis) {
    await markRunNeedsOperatorForQaDispatch(ctx, {
      run,
      issue,
      reason: "missing_synthesis_document_for_qa",
      details: {
        synthesisIssueId: synthesisIssue.id,
        synthesisIssueIdentifier: synthesisIssue.identifier ?? null,
      },
    });
    return;
  }

  const agents = await ctx.agents.list({ companyId: run.companyId, limit: 200 });
  const selected = QA_REVIEWERS.map((reviewer) => ({
    reviewer,
    agent: selectQaAgent(agents, reviewer),
  }));
  const missingReviewers = selected
    .filter((entry): entry is { reviewer: QaReviewerDefinition; agent: null } => entry.agent === null)
    .map((entry) => entry.reviewer);
  if (missingReviewers.length > 0) {
    await markRunNeedsOperatorForQaDispatch(ctx, {
      run,
      issue,
      reason: "missing_qa_agents",
      details: {
        missingReviewers: missingReviewers.map((reviewer) => ({
          roleKey: reviewer.roleKey,
          displayName: reviewer.displayName,
          adapterType: reviewer.adapterType,
        })),
      },
    });
    return;
  }

  const qaTasks: QaReviewTaskResult[] = [];
  for (const entry of selected) {
    if (!entry.agent) continue;
    const qaIssue = await createOrReuseQaReviewIssue(ctx, {
      issue,
      run,
      reviewer: entry.reviewer,
      agent: entry.agent,
      synthesis,
      roundNumber,
    });
    qaTasks.push({
      reviewer: entry.reviewer,
      agent: entry.agent,
      issue: qaIssue,
      wakeupRunId: null,
      roundNumber,
    });
  }

  const wakeups = await ctx.issues.requestWakeups(
    qaTasks.map((task) => task.issue.id),
    run.companyId,
    {
      reason: `Движок ТЗ: запустить QA-проверку финального ТЗ, раунд ${roundNumber}`,
      contextSource: `tz_process_engine.qa_review_r${roundNumber}`,
      idempotencyKeyPrefix: `${run.id}:qa-review-r${roundNumber}`,
    },
  );
  const wakeupByIssueId = new Map(wakeups.map((wakeup) => [wakeup.issueId, wakeup.runId ?? null]));
  for (const task of qaTasks) {
    task.wakeupRunId = wakeupByIssueId.get(task.issue.id) ?? null;
    await recordQaReviewIssueArtifact(ctx, { run, ...task });
  }

  const previousSelectedAgents = jsonObject(run.selectedAgents);
  const qaRound = Object.fromEntries(qaTasks.map((task) => [
    task.reviewer.roleKey,
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
    [qaSelectedAgentsKey(roundNumber)]: qaRound,
  };
  const nextState = qaState(roundNumber);

  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'qa',
            state = $3,
            selected_agents = $4::jsonb,
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'synthesizing'
        AND state = 'cto_synthesis_dispatched'`,
    [run.id, run.companyId, nextState, JSON.stringify(selectedAgents)],
  );
  await appendEvent(ctx, {
    runId: run.id,
    companyId: run.companyId,
    eventType: `qa_round_${roundNumber}_tasks_created`,
    payload: {
      issueId: run.rootIssueId,
      synthesisIssueId: synthesisIssue.id,
      synthesisIssueIdentifier: synthesisIssue.identifier ?? null,
      tasks: qaTasks.map((task) => ({
        roleKey: task.reviewer.roleKey,
        reviewer: task.reviewer.displayName,
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
    message: `QA-проверка финального ТЗ запущена, раунд ${roundNumber}: назначены QA-Codex и QA-Claude`,
    entityType: "issue",
    entityId: run.rootIssueId,
    metadata: {
      runId: run.id,
      synthesisIssueId: synthesisIssue.id,
      qaIssueIds: qaTasks.map((task) => task.issue.id),
    },
  });
  await writeTraceDocument(ctx, run.rootIssueId, run.companyId, issue.title, {
    ...run,
    status: "qa",
    state: nextState,
    selectedAgents,
    updatedAt: new Date().toISOString(),
  });
}

async function markRunNeedsOperatorForQaDecision(
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
        AND status = 'qa'
        AND state = $4`,
    [input.run.id, input.run.companyId, input.reason, input.run.state],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: "qa_decision_blocked",
    payload: {
      issueId: input.issue.id,
      reason: input.reason,
      ...input.details,
    },
  });
  await ctx.activity.log({
    companyId: input.run.companyId,
    message: "Движок процесса не смог автоматически принять решение после QA-проверки",
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

async function markRunFinalReadyFromQa(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    issue: Issue;
    codexQaVerdict: ParsedQaVerdict;
    claudeQaVerdict: ParsedQaVerdict;
  },
) {
  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'final_ready',
            state = 'operator_gate_ready',
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'qa'
        AND state = $3`,
    [input.run.id, input.run.companyId, input.run.state],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: "final_ready_after_qa",
    payload: {
      issueId: input.issue.id,
      codexQaStatus: input.codexQaVerdict.status,
      claudeQaStatus: input.claudeQaVerdict.status,
    },
  });
  await ctx.activity.log({
    companyId: input.run.companyId,
    message: "Финальное ТЗ готово к воротам оператора: оба QA приняли синтез без блокеров",
    entityType: "issue",
    entityId: input.issue.id,
    metadata: {
      runId: input.run.id,
    },
  });
  await writeTraceDocument(ctx, input.issue.id, input.run.companyId, input.issue.title, {
    ...input.run,
    status: "final_ready",
    state: "operator_gate_ready",
    updatedAt: new Date().toISOString(),
  });
}

async function dispatchAuthorReworkFromQaDecision(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    issue: Issue;
    synthesis: DraftDocumentSelection;
    codexQa: DraftDocumentSelection;
    claudeQa: DraftDocumentSelection;
    codexQaVerdict: ParsedQaVerdict;
    claudeQaVerdict: ParsedQaVerdict;
  },
) {
  const codexAuthor = authorByRoleKey("author-codex");
  const claudeAuthor = authorByRoleKey("author-claude");
  if (!codexAuthor || !claudeAuthor) throw new Error("Draft author definitions are incomplete");
  const codexAgent = await selectedOrFallbackAgent(ctx, input.run, codexAuthor);
  const claudeAgent = await selectedOrFallbackAgent(ctx, input.run, claudeAuthor);
  if (!codexAgent || !claudeAgent) {
    await markRunNeedsOperatorForQaDecision(ctx, {
      run: input.run,
      issue: input.issue,
      reason: "missing_authors_for_qa_rework",
      details: {
        codexAgentFound: Boolean(codexAgent),
        claudeAgentFound: Boolean(claudeAgent),
      },
    });
    return;
  }

  const roundNumber = input.run.currentRound + 1;
  const tasks: PingPongTaskResult[] = [];
  const codexIssue = await createOrReuseQaAuthorReworkIssue(ctx, {
    ...input,
    author: codexAuthor,
    otherAuthor: claudeAuthor,
    agent: codexAgent,
    roundNumber,
  });
  tasks.push({
    author: codexAuthor,
    otherAuthor: claudeAuthor,
    agent: codexAgent,
    issue: codexIssue,
    wakeupRunId: null,
    roundNumber,
  });
  const claudeIssue = await createOrReuseQaAuthorReworkIssue(ctx, {
    ...input,
    author: claudeAuthor,
    otherAuthor: codexAuthor,
    agent: claudeAgent,
    roundNumber,
  });
  tasks.push({
    author: claudeAuthor,
    otherAuthor: codexAuthor,
    agent: claudeAgent,
    issue: claudeIssue,
    wakeupRunId: null,
    roundNumber,
  });

  const wakeups = await ctx.issues.requestWakeups(
    tasks.map((task) => task.issue.id),
    input.run.companyId,
    {
      reason: `Движок ТЗ: запустить раунд согласования ${roundNumber} по QA-блокерам`,
      contextSource: `tz_process_engine.qa_author_rework_r${roundNumber}`,
      idempotencyKeyPrefix: `${input.run.id}:qa-author-rework-r${roundNumber}`,
    },
  );
  const wakeupByIssueId = new Map(wakeups.map((wakeup) => [wakeup.issueId, wakeup.runId ?? null]));
  for (const task of tasks) {
    task.wakeupRunId = wakeupByIssueId.get(task.issue.id) ?? null;
    await recordPingPongIssueArtifact(ctx, { run: input.run, ...task });
  }

  const previousSelectedAgents = jsonObject(input.run.selectedAgents);
  const pingPongRound = Object.fromEntries(tasks.map((task) => [
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
    [pingPongSelectedAgentsKey(roundNumber)]: pingPongRound,
  };
  const nextState = pingPongState(roundNumber);
  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'iterating',
            state = $3,
            current_round = $4,
            selected_agents = $5::jsonb,
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'qa'
        AND state = $6`,
    [input.run.id, input.run.companyId, nextState, roundNumber, JSON.stringify(selectedAgents), input.run.state],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: `qa_author_rework_round_${roundNumber}_tasks_created`,
    payload: {
      issueId: input.run.rootIssueId,
      qaStatuses: {
        codex: input.codexQaVerdict.status,
        claude: input.claudeQaVerdict.status,
      },
      tasks: tasks.map((task) => ({
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
    companyId: input.run.companyId,
    message: `Раунд согласования ${roundNumber} запущен: QA нашла блокеры для авторов`,
    entityType: "issue",
    entityId: input.run.rootIssueId,
    metadata: {
      runId: input.run.id,
      pingPongIssueIds: tasks.map((task) => task.issue.id),
    },
  });
  await writeTraceDocument(ctx, input.run.rootIssueId, input.run.companyId, input.issue.title, {
    ...input.run,
    status: "iterating",
    state: nextState,
    currentRound: roundNumber,
    selectedAgents,
    updatedAt: new Date().toISOString(),
  });
}

async function dispatchSynthesisReworkFromQaDecision(
  ctx: PluginContext,
  input: {
    run: TzProcessRunSummary;
    issue: Issue;
    synthesis: DraftDocumentSelection;
    codexQa: DraftDocumentSelection;
    claudeQa: DraftDocumentSelection;
  },
) {
  const agents = await ctx.agents.list({ companyId: input.run.companyId, limit: 200 });
  const ctoAgent = selectCtoAgent(agents);
  if (!ctoAgent) {
    await markRunNeedsOperatorForQaDecision(ctx, {
      run: input.run,
      issue: input.issue,
      reason: "missing_cto_agent_for_qa_synthesis_rework",
      details: {},
    });
    return;
  }
  const roundNumber = input.run.currentRound + 1;
  const synthesisIssue = await createOrReuseQaSynthesisReworkIssue(ctx, {
    ...input,
    agent: ctoAgent,
    roundNumber,
  });
  const wakeups = await ctx.issues.requestWakeups([synthesisIssue.id], input.run.companyId, {
    reason: `Движок ТЗ: запустить доработку синтеза после QA, раунд ${roundNumber}`,
    contextSource: `tz_process_engine.qa_synthesis_rework_r${roundNumber}`,
    idempotencyKeyPrefix: `${input.run.id}:qa-synthesis-rework-r${roundNumber}`,
  });
  const wakeupRunId = wakeups[0]?.runId ?? null;
  await recordSynthesisIssueArtifact(ctx, {
    run: input.run,
    agent: ctoAgent,
    issue: synthesisIssue,
    wakeupRunId,
    roundNumber,
  });

  const previousSelectedAgents = jsonObject(input.run.selectedAgents);
  const selectedAgents = {
    ...previousSelectedAgents,
    [synthesisSelectedAgentsKey(roundNumber)]: {
      cto: {
        agentId: ctoAgent.id,
        agentName: ctoAgent.name,
        adapterType: ctoAgent.adapterType,
        issueId: synthesisIssue.id,
        issueIdentifier: synthesisIssue.identifier ?? null,
        wakeupRunId,
      },
    },
  };
  await ctx.db.execute(
    `UPDATE ${tableName(ctx, "tz_process_runs")}
        SET status = 'synthesizing',
            state = 'cto_synthesis_dispatched',
            current_round = $3,
            selected_agents = $4::jsonb,
            updated_at = now()
      WHERE id = $1
        AND company_id = $2
        AND status = 'qa'
        AND state = $5`,
    [input.run.id, input.run.companyId, roundNumber, JSON.stringify(selectedAgents), input.run.state],
  );
  await appendEvent(ctx, {
    runId: input.run.id,
    companyId: input.run.companyId,
    eventType: `qa_synthesis_rework_round_${roundNumber}_task_created`,
    payload: {
      issueId: input.run.rootIssueId,
      synthesisIssueId: synthesisIssue.id,
      synthesisIssueIdentifier: synthesisIssue.identifier ?? null,
      wakeupRunId,
    },
  });
  await ctx.activity.log({
    companyId: input.run.companyId,
    message: `Доработка синтеза после QA запущена, раунд ${roundNumber}`,
    entityType: "issue",
    entityId: input.run.rootIssueId,
    metadata: {
      runId: input.run.id,
      synthesisIssueId: synthesisIssue.id,
      wakeupRunId,
    },
  });
  await writeTraceDocument(ctx, input.run.rootIssueId, input.run.companyId, input.issue.title, {
    ...input.run,
    status: "synthesizing",
    state: "cto_synthesis_dispatched",
    currentRound: roundNumber,
    selectedAgents,
    updatedAt: new Date().toISOString(),
  });
}

async function dispatchQaDecisionIfReady(ctx: PluginContext, run: TzProcessRunSummary) {
  const roundNumber = run.currentRound;
  if (run.status !== "qa" || run.state !== qaState(roundNumber)) return;

  const issue = await ctx.issues.get(run.rootIssueId, run.companyId);
  if (!issue) throw new Error(`Issue not found: ${run.rootIssueId}`);

  const codexReviewer = QA_REVIEWERS.find((reviewer) => reviewer.roleKey === "qa-codex");
  const claudeReviewer = QA_REVIEWERS.find((reviewer) => reviewer.roleKey === "qa-claude");
  if (!codexReviewer || !claudeReviewer) throw new Error("QA reviewer definitions are incomplete");

  const codexQaIssue = await findQaReviewIssueForReviewer(ctx, run, codexReviewer, roundNumber);
  const claudeQaIssue = await findQaReviewIssueForReviewer(ctx, run, claudeReviewer, roundNumber);
  if (!codexQaIssue || !claudeQaIssue) {
    await markRunNeedsOperatorForQaDecision(ctx, {
      run,
      issue,
      reason: "missing_qa_review_issues",
      details: {
        codexQaIssueId: codexQaIssue?.id ?? null,
        claudeQaIssueId: claudeQaIssue?.id ?? null,
      },
    });
    return;
  }
  if (codexQaIssue.status !== "done" || claudeQaIssue.status !== "done") return;

  const synthesisIssue = await findSynthesisIssueForRun(ctx, run, roundNumber);
  const synthesis = synthesisIssue ? await selectIssueOutputForDecision(ctx, synthesisIssue, run.companyId) : null;
  const codexQa = await selectIssueOutputForDecision(ctx, codexQaIssue, run.companyId);
  const claudeQa = await selectIssueOutputForDecision(ctx, claudeQaIssue, run.companyId);
  if (!synthesis || !codexQa || !claudeQa) {
    await markRunNeedsOperatorForQaDecision(ctx, {
      run,
      issue,
      reason: "missing_qa_decision_documents",
      details: {
        synthesisIssueFound: Boolean(synthesisIssue),
        synthesisFound: Boolean(synthesis),
        codexQaFound: Boolean(codexQa),
        claudeQaFound: Boolean(claudeQa),
      },
    });
    return;
  }

  const codexQaVerdict = parseQaVerdict(codexQa.body);
  const claudeQaVerdict = parseQaVerdict(claudeQa.body);
  if (codexQaVerdict.status === "unknown" || claudeQaVerdict.status === "unknown") {
    await markRunNeedsOperatorForQaDecision(ctx, {
      run,
      issue,
      reason: "unparseable_qa_verdict",
      details: {
        codexQaStatus: codexQaVerdict.status,
        claudeQaStatus: claudeQaVerdict.status,
      },
    });
    return;
  }

  const allTargets = [...new Set([...codexQaVerdict.blockerTargets, ...claudeQaVerdict.blockerTargets])];
  const hasBlocked = codexQaVerdict.status === "blocked" || claudeQaVerdict.status === "blocked";
  if (!hasBlocked && allTargets.length === 0) {
    await markRunFinalReadyFromQa(ctx, { run, issue, codexQaVerdict, claudeQaVerdict });
    return;
  }
  if (allTargets.includes("authors")) {
    await dispatchAuthorReworkFromQaDecision(ctx, {
      run,
      issue,
      synthesis,
      codexQa,
      claudeQa,
      codexQaVerdict,
      claudeQaVerdict,
    });
    return;
  }
  if (allTargets.includes("synthesis")) {
    await dispatchSynthesisReworkFromQaDecision(ctx, { run, issue, synthesis, codexQa, claudeQa });
    return;
  }
  await markRunNeedsOperatorForQaDecision(ctx, {
    run,
    issue,
    reason: "qa_blockers_need_operator",
    details: {
      codexQaStatus: codexQaVerdict.status,
      claudeQaStatus: claudeQaVerdict.status,
      blockerTargets: allTargets,
      blockerSummaries: [...codexQaVerdict.blockerSummaries, ...claudeQaVerdict.blockerSummaries],
    },
  });
}

async function dispatchConvergenceDecisionIfReady(ctx: PluginContext, run: TzProcessRunSummary) {
  const roundNumber = run.currentRound;
  if (run.status !== "iterating" || run.state !== convergenceCheckState(roundNumber)) return;

  const issue = await ctx.issues.get(run.rootIssueId, run.companyId);
  if (!issue) throw new Error(`Issue not found: ${run.rootIssueId}`);

  const codexAuthor = authorByRoleKey("author-codex");
  const claudeAuthor = authorByRoleKey("author-claude");
  if (!codexAuthor || !claudeAuthor) throw new Error("Draft author definitions are incomplete");

  const codexCheckIssue = await findConvergenceCheckIssueForAuthor(ctx, run, codexAuthor, roundNumber);
  const claudeCheckIssue = await findConvergenceCheckIssueForAuthor(ctx, run, claudeAuthor, roundNumber);
  if (!codexCheckIssue || !claudeCheckIssue) {
    await markRunNeedsOperatorForConvergenceDecision(ctx, {
      run,
      issue,
      reason: "missing_convergence_check_issues",
      details: {
        codexCheckIssueId: codexCheckIssue?.id ?? null,
        claudeCheckIssueId: claudeCheckIssue?.id ?? null,
      },
    });
    return;
  }
  if (codexCheckIssue.status !== "done" || claudeCheckIssue.status !== "done") return;

  const codexCheck = await selectDraftDocument(ctx, codexCheckIssue, run.companyId);
  const claudeCheck = await selectDraftDocument(ctx, claudeCheckIssue, run.companyId);
  if (!codexCheck || !claudeCheck) {
    await markRunNeedsOperatorForConvergenceDecision(ctx, {
      run,
      issue,
      reason: "missing_convergence_check_documents",
      details: {
        codexCheckIssueId: codexCheckIssue.id,
        claudeCheckIssueId: claudeCheckIssue.id,
        codexDocumentFound: Boolean(codexCheck),
        claudeDocumentFound: Boolean(claudeCheck),
      },
    });
    return;
  }

  const codexVerdict = parseConvergenceVerdict(codexCheck.body);
  const claudeVerdict = parseConvergenceVerdict(claudeCheck.body);
  if (codexVerdict.verdict === "unknown" || claudeVerdict.verdict === "unknown") {
    await markRunNeedsOperatorForConvergenceDecision(ctx, {
      run,
      issue,
      reason: "unparseable_convergence_verdict",
      details: {
        codexVerdict: codexVerdict.verdict,
        claudeVerdict: claudeVerdict.verdict,
      },
    });
    return;
  }

  const agents = await ctx.agents.list({ companyId: run.companyId, limit: 200 });
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

  const bothConverged = codexVerdict.verdict === "converged" && claudeVerdict.verdict === "converged";
  if (!bothConverged) {
    if (run.currentRound >= run.maxRounds) {
      await markRunNeedsOperatorForConvergenceDecision(ctx, {
        run,
        issue,
        reason: "max_rounds_reached_after_convergence_check",
        details: {
          codexVerdict: codexVerdict.verdict,
          claudeVerdict: claudeVerdict.verdict,
          currentRound: run.currentRound,
          maxRounds: run.maxRounds,
        },
      });
      return;
    }
    await dispatchFollowUpPingPongFromConvergenceDecision(ctx, {
      run,
      issue,
      codexAuthor,
      claudeAuthor,
      codexAgent,
      claudeAgent,
      codexCheck,
      claudeCheck,
      codexVerdict,
      claudeVerdict,
    });
    return;
  }

  const ctoAgent = selectCtoAgent(agents);
  if (!ctoAgent) {
    await markRunNeedsOperatorForConvergenceDecision(ctx, {
      run,
      issue,
      reason: "missing_cto_agent_for_synthesis",
      details: {
        codexVerdict: codexVerdict.verdict,
        claudeVerdict: claudeVerdict.verdict,
      },
    });
    return;
  }

  const codexPingPongIssue = await findPingPongIssueForAuthor(ctx, run, codexAuthor, roundNumber);
  const claudePingPongIssue = await findPingPongIssueForAuthor(ctx, run, claudeAuthor, roundNumber);
  const codexPingPong = codexPingPongIssue ? await selectDraftDocument(ctx, codexPingPongIssue, run.companyId) : null;
  const claudePingPong = claudePingPongIssue ? await selectDraftDocument(ctx, claudePingPongIssue, run.companyId) : null;
  if (!codexPingPong || !claudePingPong) {
    await markRunNeedsOperatorForConvergenceDecision(ctx, {
      run,
      issue,
      reason: "missing_ping_pong_documents_for_synthesis",
      details: {
        codexPingPongIssueId: codexPingPongIssue?.id ?? null,
        claudePingPongIssueId: claudePingPongIssue?.id ?? null,
        codexDocumentFound: Boolean(codexPingPong),
        claudeDocumentFound: Boolean(claudePingPong),
      },
    });
    return;
  }

  await dispatchSynthesisFromConvergenceDecision(ctx, {
    run,
    issue,
    ctoAgent,
    codexPingPong,
    claudePingPong,
    codexCheck,
    claudeCheck,
    roundNumber,
  });
}

async function collectRepoFiles(ctx: PluginContext, companyId: string, folderKey: string) {
  const listing = await ctx.localFolders.list(companyId, folderKey, {
    recursive: true,
    maxEntries: 5_000,
  });
  const files = listing.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => normalizeRepoPath(entry.path))
    .sort((a, b) => a.localeCompare(b));
  return {
    files,
    truncated: listing.truncated,
  };
}

async function executeFactCheck(
  ctx: PluginContext,
  input: {
    companyId: string;
    folderKey: string;
    files: string[];
    check: FactCheckDefinition;
  },
): Promise<FactCheckResult> {
  try {
    if (input.check.predicate.kind === "file_exists") {
      return checkPathExists(input.files, input.check);
    }

    return await checkTextSearch(ctx, input);
  } catch (err) {
    return {
      ...input.check,
      commandLabel: factCommandLabel(input.check),
      status: "error",
      evidence: {
        output: "check failed",
        matches: [],
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function handleReadinessCheck(ctx: PluginContext, input: ReadinessCheckInput): Promise<ReadinessCheckResult> {
  const issue = await ctx.issues.get(input.issueId, input.companyId);
  if (!issue) throw new Error(`Issue not found: ${input.issueId}`);

  const folderKey = input.folderKey ?? PROJECT_REPO_FOLDER_KEY;
  const run = await latestRunForIssue(ctx, input.companyId, input.issueId);
  const folderStatus = await ctx.localFolders.status(input.companyId, folderKey);
  if (!folderStatus.configured || !folderStatus.healthy || !folderStatus.readable) {
    const missingFolderCheck: FactCheckResult = {
      claimKey: "project-repo-folder-configured",
      claim: "Read-only папка проекта настроена для Repo Inventory / Fact Ledger",
      predicate: { kind: "file_exists", path: "." },
      commandLabel: `local_folder_status ${folderKey}`,
      status: "missing",
      evidence: {
        output: folderStatus.problems.map((problem) => problem.message).join("\n") || "Local folder is not configured",
        matches: [],
      },
    };
    return recordReadinessResult(ctx, {
      issue,
      run,
      folderKey,
      folderPath: folderStatus.path,
      fileCount: 0,
      truncated: false,
      checks: [missingFolderCheck],
    });
  }

  const { files, truncated } = await collectRepoFiles(ctx, input.companyId, folderKey);
  const checks = parseFactChecks(input.checks);
  const results: FactCheckResult[] = [];

  for (const check of checks) {
    results.push(await executeFactCheck(ctx, {
      companyId: input.companyId,
      folderKey,
      files,
      check,
    }));
  }

  return recordReadinessResult(ctx, {
    issue,
    run,
    folderKey,
    folderPath: folderStatus.path,
    fileCount: files.length,
    truncated,
    checks: results,
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

async function resumeReadyConvergenceCheckRuns(ctx: PluginContext) {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE status = 'iterating'
        AND state = ('ping_pong_round_' || current_round::text || '_dispatched')
      ORDER BY updated_at ASC
      LIMIT 20`,
  );
  for (const row of rows) {
    const run = normalizeRun(row);
    try {
      await dispatchConvergenceCheckIfReady(ctx, run);
    } catch (err) {
      await appendEvent(ctx, {
        runId: run.id,
        companyId: run.companyId,
        eventType: "convergence_check_dispatch_failed",
        payload: {
          issueId: run.rootIssueId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      ctx.logger.error("Failed to resume TZ convergence check dispatch", {
        runId: run.id,
        issueId: run.rootIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function resumeReadyConvergenceDecisionRuns(ctx: PluginContext) {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE status = 'iterating'
        AND state = ('convergence_check_round_' || current_round::text || '_dispatched')
      ORDER BY updated_at ASC
      LIMIT 20`,
  );
  for (const row of rows) {
    const run = normalizeRun(row);
    try {
      await dispatchConvergenceDecisionIfReady(ctx, run);
    } catch (err) {
      await appendEvent(ctx, {
        runId: run.id,
        companyId: run.companyId,
        eventType: "convergence_decision_dispatch_failed",
        payload: {
          issueId: run.rootIssueId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      ctx.logger.error("Failed to resume TZ convergence decision dispatch", {
        runId: run.id,
        issueId: run.rootIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function resumeReadyQaReviewRuns(ctx: PluginContext) {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE status = 'synthesizing'
        AND state = 'cto_synthesis_dispatched'
      ORDER BY updated_at ASC
      LIMIT 20`,
  );
  for (const row of rows) {
    const run = normalizeRun(row);
    try {
      await dispatchQaReviewIfSynthesisReady(ctx, run);
    } catch (err) {
      await appendEvent(ctx, {
        runId: run.id,
        companyId: run.companyId,
        eventType: "qa_review_dispatch_failed",
        payload: {
          issueId: run.rootIssueId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      ctx.logger.error("Failed to resume TZ QA review dispatch", {
        runId: run.id,
        issueId: run.rootIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function resumeReadyQaDecisionRuns(ctx: PluginContext) {
  const rows = await ctx.db.query<TzProcessRunRow>(
    `SELECT id, company_id, root_issue_id, process_key, status, state, current_round, max_rounds,
            qa_rework_limit, idempotency_key, operator_input, selected_agents,
            started_at, updated_at, completed_at
       FROM ${tableName(ctx, "tz_process_runs")}
      WHERE status = 'qa'
        AND state = ('qa_round_' || current_round::text || '_dispatched')
      ORDER BY updated_at ASC
      LIMIT 20`,
  );
  for (const row of rows) {
    const run = normalizeRun(row);
    try {
      await dispatchQaDecisionIfReady(ctx, run);
    } catch (err) {
      await appendEvent(ctx, {
        runId: run.id,
        companyId: run.companyId,
        eventType: "qa_decision_dispatch_failed",
        payload: {
          issueId: run.rootIssueId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      ctx.logger.error("Failed to resume TZ QA decision dispatch", {
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
  const runsById = new Map<string, TzProcessRunSummary>();
  for (const run of await activeRunsForDraftIssue(ctx, event.companyId, issueId)) {
    runsById.set(run.id, run);
  }
  for (const run of await activeRunsForPingPongIssue(ctx, event.companyId, issueId)) {
    runsById.set(run.id, run);
  }
  for (const run of await activeRunsForConvergenceCheckIssue(ctx, event.companyId, issueId)) {
    runsById.set(run.id, run);
  }
  for (const run of await activeRunsForSynthesisIssue(ctx, event.companyId, issueId)) {
    runsById.set(run.id, run);
  }
  for (const run of await activeRunsForQaReviewIssue(ctx, event.companyId, issueId)) {
    runsById.set(run.id, run);
  }
  const runs = [...runsById.values()];
  for (const run of runs) {
    try {
      await dispatchPingPongRoundOneIfReady(ctx, run);
      await dispatchConvergenceCheckIfReady(ctx, run);
      await dispatchConvergenceDecisionIfReady(ctx, run);
      await dispatchQaReviewIfSynthesisReady(ctx, run);
      await dispatchQaDecisionIfReady(ctx, run);
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

function readReadinessInput(
  params: Record<string, unknown>,
  context?: PluginPerformActionContext,
): ReadinessCheckInput {
  const companyId = stringField(params.companyId) ?? context?.companyId ?? null;
  const issueId = stringField(params.issueId);
  if (!companyId || !issueId) throw new Error("companyId and issueId are required");
  return {
    companyId,
    issueId,
    folderKey: stringField(params.folderKey),
    checks: params.checks,
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    activeContext = ctx;

    startCycle = async (input) => handleStart(ctx, input);
    readStatus = async (companyId, issueId) => buildStatus(ctx, companyId, issueId);
    runReadinessCheck = async (input) => handleReadinessCheck(ctx, input);

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

    ctx.actions.register("run-readiness-check", async (params, context) => {
      return handleReadinessCheck(ctx, readReadinessInput(params, context));
    });

    await resumeReadyDraftingRuns(ctx);
    await resumeReadyPingPongRuns(ctx);
    await resumeReadyConvergenceCheckRuns(ctx);
    await resumeReadyConvergenceDecisionRuns(ctx);
    await resumeReadyQaReviewRuns(ctx);
    await resumeReadyQaDecisionRuns(ctx);
  },

  async onApiRequest(input: PluginApiRequestInput) {
    if (!activeContext || !startCycle || !readStatus || !runReadinessCheck) {
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

    if (input.routeKey === "run-readiness-check") {
      const body = jsonObject(input.body);
      return {
        status: 201,
        body: await runReadinessCheck({
          ...readReadinessInput({
            ...body,
            companyId: input.companyId,
            issueId: input.params.issueId,
          }),
        }),
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
