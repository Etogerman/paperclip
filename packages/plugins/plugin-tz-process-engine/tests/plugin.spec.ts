import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema, type Agent, type Issue } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { CLARIFICATION_INTERACTION_KEY, PROCESS_KEY, TRACE_DOCUMENT_KEY } from "../src/constants.js";

function issue(input: Partial<Issue> & Pick<Issue, "id" | "companyId" | "title">): Issue {
  const now = new Date();
  const { id, companyId, title, ...rest } = input;
  return {
    id,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "todo",
    priority: "medium",
    workMode: "standard",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

function agent(input: Partial<Agent> & Pick<Agent, "id" | "companyId" | "name" | "adapterType">): Agent {
  const now = new Date();
  return {
    id: input.id,
    companyId: input.companyId,
    name: input.name,
    urlKey: input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    role: input.role ?? "pm",
    title: input.title ?? null,
    icon: input.icon ?? null,
    status: input.status ?? "idle",
    reportsTo: input.reportsTo ?? null,
    capabilities: input.capabilities ?? null,
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig ?? {},
    runtimeConfig: input.runtimeConfig ?? {},
    defaultEnvironmentId: input.defaultEnvironmentId ?? null,
    budgetMonthlyCents: input.budgetMonthlyCents ?? 0,
    spentMonthlyCents: input.spentMonthlyCents ?? 0,
    pauseReason: input.pauseReason ?? null,
    pausedAt: input.pausedAt ?? null,
    errorReason: input.errorReason ?? null,
    permissions: input.permissions ?? {},
    lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  } as Agent;
}

describe("TZ Process Engine plugin", () => {
  it("declares the MVP process-engine surfaces", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "paperclipai.plugin-tz-process-engine",
      capabilities: expect.arrayContaining([
        "events.subscribe",
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
        "issues.create",
        "issues.wakeup",
        "issue.interactions.read",
        "issue.interactions.create",
        "agent.sessions.send",
      ]),
      database: {
        namespaceSlug: "tz_process_engine",
        migrationsDir: "migrations",
      },
      apiRoutes: [
        expect.objectContaining({ routeKey: "start-cycle" }),
        expect.objectContaining({ routeKey: "status" }),
      ],
    });
  });

  it("starts a process run, asks operator clarifying questions, and writes trace state", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: issueId,
          companyId,
          title: "Create a technical specification",
        }),
      ],
    });
    await harness.ctx.issues.requestConfirmation(
      issueId,
      {
        title: "Old unrelated confirmation",
        idempotencyKey: "old-confirmation",
        continuationPolicy: "none",
        payload: {
          version: 1,
          prompt: "Use an old flow?",
          allowDeclineReason: true,
        },
      },
      companyId,
    );

    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{
      run: { id: string; status: string; state: string; processKey: string; maxRounds: number } | null;
      pendingInteractions: Array<{ id: string; kind: string; title: string | null }>;
    }>("start-cycle", {
      companyId,
      issueId,
      task: "Create a deterministic TЗ process",
      maxRounds: 6,
      idempotencyKey: "tz-cycle:test",
    });

    expect(result.run).toMatchObject({
      status: "clarifying",
      state: "waiting_operator_clarification",
      processKey: PROCESS_KEY,
      maxRounds: 6,
    });
    expect(result.pendingInteractions).toEqual([
      expect.objectContaining({
        kind: "ask_user_questions",
        title: "Уточнить задачу перед созданием ТЗ",
      }),
    ]);
    expect(result.pendingInteractions[0]?.id).toBeTruthy();
    expect(harness.dbExecutes.some((entry) => entry.sql.includes(".tz_process_runs"))).toBe(true);
    expect(harness.dbExecutes.some((entry) => entry.sql.includes(".tz_process_events"))).toBe(true);
    expect(harness.dbQueries.some((entry) => entry.sql.includes(".tz_process_runs"))).toBe(true);
    expect(harness.activity).toEqual([
      expect.objectContaining({
        message: "Процесс создания ТЗ ожидает уточнений оператора",
        entityType: "issue",
        entityId: issueId,
      }),
    ]);
    const interactions = await harness.ctx.issues.interactions.list(issueId, companyId, { status: "pending" });
    const clarification = interactions.find((entry) => entry.kind === "ask_user_questions");
    expect(clarification).toMatchObject({
      kind: "ask_user_questions",
      idempotencyKey: `${result.run?.id}:${CLARIFICATION_INTERACTION_KEY}`,
      payload: expect.objectContaining({
        title: "Уточняющие вопросы для цикла создания ТЗ",
        questions: expect.arrayContaining([
          expect.objectContaining({ id: "task_ready" }),
          expect.objectContaining({ id: "context_sources" }),
          expect.objectContaining({ id: "final_tz_focus" }),
        ]),
      }),
    });

    const docs = await harness.ctx.issues.documents.list(issueId, companyId);
    expect(docs).toEqual([
      expect.objectContaining({
        key: TRACE_DOCUMENT_KEY,
        title: "TZ Process Trace",
      }),
    ]);
  });

  it("dispatches scoped API start through the same process path", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: issueId,
          companyId,
          title: "Scoped API TZ root",
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(plugin.definition.onApiRequest?.({
      routeKey: "start-cycle",
      method: "POST",
      path: `/issues/${issueId}/tz-process/start`,
      params: { issueId },
      query: {},
      body: { task: "Create final TZ", idempotencyKey: "tz-cycle:api" },
      actor: {
        actorType: "user",
        actorId: "board",
        userId: "board",
        agentId: null,
        runId: null,
      },
      companyId,
      headers: {},
    })).resolves.toMatchObject({
      status: 201,
      body: {
        run: expect.objectContaining({
          status: "clarifying",
          processKey: PROCESS_KEY,
        }),
      },
    });
  });

  it("accepts operator interaction events without taking over routing decisions", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: issueId,
          companyId,
          title: "Operator answer event",
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.emit("issue.thread_interaction.answered", {
      interactionId: randomUUID(),
      interactionKind: "ask_user_questions",
      interactionStatus: "answered",
    }, {
      companyId,
      entityType: "issue",
      entityId: issueId,
      actorType: "user",
      actorId: "board",
    })).resolves.toBeUndefined();
  });

  it("creates blind draft child tasks for Codex and Claude after operator answers", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const codexAgentId = randomUUID();
    const claudeAgentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: issueId,
          companyId,
          title: "Create blind draft children",
          projectId: "project-1",
        }),
      ],
      agents: [
        agent({
          id: codexAgentId,
          companyId,
          name: "Автор-Codex",
          adapterType: "codex_local",
        }),
        agent({
          id: claudeAgentId,
          companyId,
          name: "Автор-Claude",
          adapterType: "claude_local",
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{
      run: {
        id: string;
        companyId: string;
        rootIssueId: string;
        processKey: string;
        status: string;
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
      } | null;
      pendingInteractions: Array<{ id: string; kind: string; title: string | null }>;
    }>("start-cycle", {
      companyId,
      issueId,
      task: "Create a deterministic TЗ process",
      context: "Use Paperclip issues/documents/interactions.",
      projectId: "project-1",
      idempotencyKey: "tz-cycle:draft-test",
    });
    const run = result.run;
    expect(run).toBeTruthy();
    const interactionId = result.pendingInteractions[0]?.id;
    expect(interactionId).toBeTruthy();

    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes(".tz_process_runs") && sql.includes("status NOT IN")) {
        return [{
          id: run!.id,
          company_id: companyId,
          root_issue_id: issueId,
          process_key: run!.processKey,
          status: "clarifying",
          state: "waiting_operator_clarification",
          current_round: 0,
          max_rounds: 6,
          qa_rework_limit: 2,
          idempotency_key: run!.idempotencyKey,
          operator_input: run!.operatorInput,
          selected_agents: {},
          started_at: run!.startedAt,
          updated_at: run!.updatedAt,
          completed_at: null,
        }] as T[];
      }
      return originalQuery(sql, params);
    };

    await harness.emit("issue.thread_interaction.answered", {
      interactionId,
      interactionKind: "ask_user_questions",
      interactionStatus: "answered",
    }, {
      companyId,
      entityType: "issue",
      entityId: issueId,
      actorType: "user",
      actorId: "board",
    });

    const draftIssues = await harness.ctx.issues.list({
      companyId,
      originKindPrefix: `plugin:${manifest.id}:blind-draft`,
      includePluginOperations: true,
      limit: 10,
    });
    expect(draftIssues).toHaveLength(2);
    expect(draftIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parentId: issueId,
        assigneeAgentId: codexAgentId,
        status: "todo",
        originId: `${run!.id}:author-codex:r0`,
      }),
      expect.objectContaining({
        parentId: issueId,
        assigneeAgentId: claudeAgentId,
        status: "todo",
        originId: `${run!.id}:author-claude:r0`,
      }),
    ]));
    expect(draftIssues.map((draft) => draft.description).join("\n")).toContain("Это слепой раунд 0 создания ТЗ");
    expect(harness.dbExecutes.some((entry) =>
      entry.sql.includes("state = 'blind_draft_tasks_dispatched'"))).toBe(true);
    expect(harness.dbExecutes.some((entry) =>
      entry.sql.includes(".tz_process_artifacts"))).toBe(true);
    expect(harness.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Слепой раунд 0 запущен: созданы задачи для Автор-Codex и Автор-Claude",
        entityId: issueId,
      }),
    ]));
  });
});
