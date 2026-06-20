import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema, type Agent, type Issue } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  BLIND_DRAFT_ORIGIN_KIND,
  CONVERGENCE_CHECK_ARTIFACT_KEY,
  CONVERGENCE_CHECK_ORIGIN_KIND,
  PING_PONG_ARTIFACT_KEY,
  CLARIFICATION_INTERACTION_KEY,
  PING_PONG_ORIGIN_KIND,
  PROCESS_KEY,
  SYNTHESIS_ARTIFACT_KEY,
  SYNTHESIS_ORIGIN_KIND,
  TRACE_DOCUMENT_KEY,
} from "../src/constants.js";

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

  it("creates ping-pong round 1 tasks after both blind drafts are done", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const codexAgentId = randomUUID();
    const claudeAgentId = randomUUID();
    const codexDraftIssueId = randomUUID();
    const claudeDraftIssueId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: rootIssueId,
          companyId,
          title: "GER-118 root task",
          identifier: "GER-118",
          projectId: "project-1",
          status: "in_progress",
        }),
        issue({
          id: codexDraftIssueId,
          companyId,
          title: "GER-118 blind round 0: черновик ТЗ от Автор-Codex",
          identifier: "GER-149",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: codexAgentId,
          originKind: BLIND_DRAFT_ORIGIN_KIND,
          originId: `${runId}:author-codex:r0`,
          originRunId: runId,
          requestDepth: 1,
        }),
        issue({
          id: claudeDraftIssueId,
          companyId,
          title: "GER-118 blind round 0: черновик ТЗ от Автор-Claude",
          identifier: "GER-150",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: claudeAgentId,
          originKind: BLIND_DRAFT_ORIGIN_KIND,
          originId: `${runId}:author-claude:r0`,
          originRunId: runId,
          requestDepth: 1,
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
    await harness.ctx.issues.documents.upsert({
      issueId: codexDraftIssueId,
      companyId,
      key: "tz-codex-r0",
      title: "Черновик ТЗ Автор-Codex R0",
      body: "Codex draft body with acceptance criteria.",
    });
    await harness.ctx.issues.documents.upsert({
      issueId: claudeDraftIssueId,
      companyId,
      key: "plan",
      title: "ТЗ GER-118 — черновик Автор-Claude (раунд 0)",
      body: "Claude draft body with risk analysis.",
    });

    const runRow = {
      id: runId,
      company_id: companyId,
      root_issue_id: rootIssueId,
      process_key: PROCESS_KEY,
      status: "drafting",
      state: "blind_draft_tasks_dispatched",
      current_round: 0,
      max_rounds: 6,
      qa_rework_limit: 2,
      idempotency_key: "tz-cycle:ping-pong-test",
      operator_input: {
        task: "Create final TZ",
        context: "Use existing project code as read-only context.",
        projectId: "project-1",
      },
      selected_agents: {
        "author-codex": {
          agentId: codexAgentId,
          agentName: "Автор-Codex",
          adapterType: "codex_local",
          issueId: codexDraftIssueId,
          issueIdentifier: "GER-149",
          wakeupRunId: null,
        },
        "author-claude": {
          agentId: claudeAgentId,
          agentName: "Автор-Claude",
          adapterType: "claude_local",
          issueId: claudeDraftIssueId,
          issueIdentifier: "GER-150",
          wakeupRunId: null,
        },
      },
      started_at: now,
      updated_at: now,
      completed_at: null,
    };
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes(".tz_process_runs") && sql.includes("blind_draft_tasks_dispatched")) {
        return [runRow] as T[];
      }
      return originalQuery(sql, params);
    };

    await harness.emit("issue.updated", {}, {
      companyId,
      entityType: "issue",
      entityId: claudeDraftIssueId,
      actorType: "agent",
      actorId: claudeAgentId,
    });

    const pingPongIssues = await harness.ctx.issues.list({
      companyId,
      originKindPrefix: PING_PONG_ORIGIN_KIND,
      includePluginOperations: true,
      limit: 10,
    });
    expect(pingPongIssues).toHaveLength(2);
    expect(pingPongIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parentId: rootIssueId,
        assigneeAgentId: codexAgentId,
        status: "todo",
        originKind: PING_PONG_ORIGIN_KIND,
        originId: `${runId}:author-codex:r1`,
      }),
      expect.objectContaining({
        parentId: rootIssueId,
        assigneeAgentId: claudeAgentId,
        status: "todo",
        originKind: PING_PONG_ORIGIN_KIND,
        originId: `${runId}:author-claude:r1`,
      }),
    ]));
    const descriptions = pingPongIssues.map((entry) => entry.description).join("\n");
    expect(descriptions).toContain("Это ping-pong round 1 создания ТЗ");
    expect(descriptions).toContain("Codex draft body with acceptance criteria.");
    expect(descriptions).toContain("Claude draft body with risk analysis.");
    expect(descriptions).toContain("review_of_other:");
    expect(harness.dbExecutes.some((entry) =>
      entry.sql.includes("state = 'ping_pong_round_1_dispatched'"))).toBe(true);
    expect(harness.dbExecutes.some((entry) =>
      entry.sql.includes(".tz_process_artifacts") && entry.params?.includes(PING_PONG_ARTIFACT_KEY))).toBe(true);
    expect(harness.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Ping-pong round 1 запущен: авторы получили черновики друг друга",
        entityId: rootIssueId,
      }),
    ]));
  });

  it("creates convergence check tasks after both ping-pong round 1 tasks are done", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const codexAgentId = randomUUID();
    const claudeAgentId = randomUUID();
    const codexPingPongIssueId = randomUUID();
    const claudePingPongIssueId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: rootIssueId,
          companyId,
          title: "GER-118 root task",
          identifier: "GER-118",
          projectId: "project-1",
          status: "in_progress",
        }),
        issue({
          id: codexPingPongIssueId,
          companyId,
          title: "GER-118 ping-pong round 1: Автор-Codex отвечает Автор-Claude",
          identifier: "GER-156",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: codexAgentId,
          originKind: PING_PONG_ORIGIN_KIND,
          originId: `${runId}:author-codex:r1`,
          originRunId: runId,
          requestDepth: 1,
        }),
        issue({
          id: claudePingPongIssueId,
          companyId,
          title: "GER-118 ping-pong round 1: Автор-Claude отвечает Автор-Codex",
          identifier: "GER-157",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: claudeAgentId,
          originKind: PING_PONG_ORIGIN_KIND,
          originId: `${runId}:author-claude:r1`,
          originRunId: runId,
          requestDepth: 1,
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
    await harness.ctx.issues.documents.upsert({
      issueId: codexPingPongIssueId,
      companyId,
      key: "pingpong-codex-r1",
      title: "Ping-pong Автор-Codex R1",
      body: "Codex ping-pong response with remaining deltas.",
    });
    await harness.ctx.issues.documents.upsert({
      issueId: claudePingPongIssueId,
      companyId,
      key: "plan",
      title: "ТЗ GER-118 — Автор-Claude (пинг-понг раунд 1)",
      body: "Claude ping-pong response with convergence notes.",
    });

    const runRow = {
      id: runId,
      company_id: companyId,
      root_issue_id: rootIssueId,
      process_key: PROCESS_KEY,
      status: "iterating",
      state: "ping_pong_round_1_dispatched",
      current_round: 1,
      max_rounds: 6,
      qa_rework_limit: 2,
      idempotency_key: "tz-cycle:convergence-check-test",
      operator_input: {
        task: "Create final TZ",
        context: "Use existing project code as read-only context.",
        projectId: "project-1",
      },
      selected_agents: {
        "author-codex": {
          agentId: codexAgentId,
          agentName: "Автор-Codex",
          adapterType: "codex_local",
          issueId: "codex-draft-issue",
          issueIdentifier: "GER-149",
          wakeupRunId: null,
        },
        "author-claude": {
          agentId: claudeAgentId,
          agentName: "Автор-Claude",
          adapterType: "claude_local",
          issueId: "claude-draft-issue",
          issueIdentifier: "GER-150",
          wakeupRunId: null,
        },
        pingPongRound1: {
          "author-codex": {
            agentId: codexAgentId,
            agentName: "Автор-Codex",
            adapterType: "codex_local",
            issueId: codexPingPongIssueId,
            issueIdentifier: "GER-156",
            wakeupRunId: null,
          },
          "author-claude": {
            agentId: claudeAgentId,
            agentName: "Автор-Claude",
            adapterType: "claude_local",
            issueId: claudePingPongIssueId,
            issueIdentifier: "GER-157",
            wakeupRunId: null,
          },
        },
      },
      started_at: now,
      updated_at: now,
      completed_at: null,
    };
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes(".tz_process_runs") && sql.includes("ping_pong_round_1_dispatched")) {
        return [runRow] as T[];
      }
      return originalQuery(sql, params);
    };

    await harness.emit("issue.updated", {}, {
      companyId,
      entityType: "issue",
      entityId: claudePingPongIssueId,
      actorType: "agent",
      actorId: claudeAgentId,
    });

    const checkIssues = await harness.ctx.issues.list({
      companyId,
      originKindPrefix: CONVERGENCE_CHECK_ORIGIN_KIND,
      includePluginOperations: true,
      limit: 10,
    });
    expect(checkIssues).toHaveLength(2);
    expect(checkIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parentId: rootIssueId,
        assigneeAgentId: codexAgentId,
        status: "todo",
        originKind: CONVERGENCE_CHECK_ORIGIN_KIND,
        originId: `${runId}:author-codex:r1`,
      }),
      expect.objectContaining({
        parentId: rootIssueId,
        assigneeAgentId: claudeAgentId,
        status: "todo",
        originKind: CONVERGENCE_CHECK_ORIGIN_KIND,
        originId: `${runId}:author-claude:r1`,
      }),
    ]));
    const descriptions = checkIssues.map((entry) => entry.description).join("\n");
    expect(descriptions).toContain("Это проверка схождения после ping-pong round 1");
    expect(descriptions).toContain("Codex ping-pong response with remaining deltas.");
    expect(descriptions).toContain("Claude ping-pong response with convergence notes.");
    expect(descriptions).toContain("verdict: СОШЛИСЬ");
    expect(descriptions).toContain("remaining_deltas: []");
    expect(harness.dbExecutes.some((entry) =>
      entry.sql.includes("state = 'convergence_check_round_1_dispatched'"))).toBe(true);
    expect(harness.dbExecutes.some((entry) =>
      entry.sql.includes(".tz_process_artifacts") && entry.params?.includes(CONVERGENCE_CHECK_ARTIFACT_KEY))).toBe(true);
    expect(harness.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Проверка схождения round 1 запущена: авторы должны дать короткий вердикт",
        entityId: rootIssueId,
      }),
    ]));
  });

  it("creates ping-pong round 2 tasks when any convergence verdict says iterate", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const codexAgentId = randomUUID();
    const claudeAgentId = randomUUID();
    const codexCheckIssueId = randomUUID();
    const claudeCheckIssueId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: rootIssueId,
          companyId,
          title: "GER-118 root task",
          identifier: "GER-118",
          projectId: "project-1",
          status: "in_progress",
        }),
        issue({
          id: codexCheckIssueId,
          companyId,
          title: "GER-118 convergence check round 1: Автор-Codex подтверждает схождение",
          identifier: "GER-160",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: codexAgentId,
          originKind: CONVERGENCE_CHECK_ORIGIN_KIND,
          originId: `${runId}:author-codex:r1`,
          originRunId: runId,
          requestDepth: 1,
        }),
        issue({
          id: claudeCheckIssueId,
          companyId,
          title: "GER-118 convergence check round 1: Автор-Claude подтверждает схождение",
          identifier: "GER-161",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: claudeAgentId,
          originKind: CONVERGENCE_CHECK_ORIGIN_KIND,
          originId: `${runId}:author-claude:r1`,
          originRunId: runId,
          requestDepth: 1,
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
    await harness.ctx.issues.documents.upsert({
      issueId: codexCheckIssueId,
      companyId,
      key: "continuation-summary",
      title: "Continuation Summary",
      body: [
        "Инструкция выше содержит пример `verdict: СОШЛИСЬ`.",
        "Фактический итог ниже.",
        "Вердикт: `ИТЕРИРУЕМ`.",
        "remaining_deltas:",
        "- Нужно закрыть транзакционность аудита.",
      ].join("\n"),
    });
    await harness.ctx.issues.documents.upsert({
      issueId: claudeCheckIssueId,
      companyId,
      key: "continuation-summary",
      title: "Continuation Summary",
      body: [
        "verdict: СОШЛИСЬ",
        "candidate:",
        "  source: merged",
        "remaining_deltas: []",
      ].join("\n"),
    });

    const runRow = {
      id: runId,
      company_id: companyId,
      root_issue_id: rootIssueId,
      process_key: PROCESS_KEY,
      status: "iterating",
      state: "convergence_check_round_1_dispatched",
      current_round: 1,
      max_rounds: 6,
      qa_rework_limit: 2,
      idempotency_key: "tz-cycle:round-two-test",
      operator_input: {},
      selected_agents: {
        "author-codex": {
          agentId: codexAgentId,
          agentName: "Автор-Codex",
          adapterType: "codex_local",
          issueId: "codex-draft-issue",
          issueIdentifier: "GER-149",
          wakeupRunId: null,
        },
        "author-claude": {
          agentId: claudeAgentId,
          agentName: "Автор-Claude",
          adapterType: "claude_local",
          issueId: "claude-draft-issue",
          issueIdentifier: "GER-150",
          wakeupRunId: null,
        },
        convergenceCheckRound1: {
          "author-codex": {
            agentId: codexAgentId,
            agentName: "Автор-Codex",
            adapterType: "codex_local",
            issueId: codexCheckIssueId,
            issueIdentifier: "GER-160",
            wakeupRunId: null,
          },
          "author-claude": {
            agentId: claudeAgentId,
            agentName: "Автор-Claude",
            adapterType: "claude_local",
            issueId: claudeCheckIssueId,
            issueIdentifier: "GER-161",
            wakeupRunId: null,
          },
        },
      },
      started_at: now,
      updated_at: now,
      completed_at: null,
    };
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes(".tz_process_runs") && sql.includes("convergence_check_round_1_dispatched")) {
        return [runRow] as T[];
      }
      return originalQuery(sql, params);
    };

    await harness.emit("issue.updated", {}, {
      companyId,
      entityType: "issue",
      entityId: claudeCheckIssueId,
      actorType: "agent",
      actorId: claudeAgentId,
    });

    const roundTwoIssues = await harness.ctx.issues.list({
      companyId,
      originKindPrefix: PING_PONG_ORIGIN_KIND,
      includePluginOperations: true,
      limit: 10,
    });
    expect(roundTwoIssues).toHaveLength(2);
    expect(roundTwoIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parentId: rootIssueId,
        assigneeAgentId: codexAgentId,
        status: "todo",
        originKind: PING_PONG_ORIGIN_KIND,
        originId: `${runId}:author-codex:r2`,
      }),
      expect.objectContaining({
        parentId: rootIssueId,
        assigneeAgentId: claudeAgentId,
        status: "todo",
        originKind: PING_PONG_ORIGIN_KIND,
        originId: `${runId}:author-claude:r2`,
      }),
    ]));
    const descriptions = roundTwoIssues.map((entry) => entry.description).join("\n");
    expect(descriptions).toContain("Это ping-pong round 2 создания ТЗ");
    expect(descriptions).toContain("Распознанный verdict: iterate");
    expect(descriptions).toContain("Распознанный verdict: converged");
    expect(harness.dbExecutes.some((entry) =>
      entry.sql.includes("state = 'ping_pong_round_2_dispatched'"))).toBe(true);
    expect(harness.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Ping-pong round 2 запущен: после проверки схождения остались дельты",
        entityId: rootIssueId,
      }),
    ]));
  });

  it("creates a CTO synthesis task when both convergence verdicts agree", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const codexAgentId = randomUUID();
    const claudeAgentId = randomUUID();
    const ctoAgentId = randomUUID();
    const codexPingPongIssueId = randomUUID();
    const claudePingPongIssueId = randomUUID();
    const codexCheckIssueId = randomUUID();
    const claudeCheckIssueId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: rootIssueId,
          companyId,
          title: "GER-118 root task",
          identifier: "GER-118",
          projectId: "project-1",
          status: "in_progress",
        }),
        issue({
          id: codexPingPongIssueId,
          companyId,
          title: "GER-118 ping-pong round 1: Автор-Codex отвечает Автор-Claude",
          identifier: "GER-156",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: codexAgentId,
          originKind: PING_PONG_ORIGIN_KIND,
          originId: `${runId}:author-codex:r1`,
          originRunId: runId,
          requestDepth: 1,
        }),
        issue({
          id: claudePingPongIssueId,
          companyId,
          title: "GER-118 ping-pong round 1: Автор-Claude отвечает Автор-Codex",
          identifier: "GER-157",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: claudeAgentId,
          originKind: PING_PONG_ORIGIN_KIND,
          originId: `${runId}:author-claude:r1`,
          originRunId: runId,
          requestDepth: 1,
        }),
        issue({
          id: codexCheckIssueId,
          companyId,
          title: "GER-118 convergence check round 1: Автор-Codex подтверждает схождение",
          identifier: "GER-160",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: codexAgentId,
          originKind: CONVERGENCE_CHECK_ORIGIN_KIND,
          originId: `${runId}:author-codex:r1`,
          originRunId: runId,
          requestDepth: 1,
        }),
        issue({
          id: claudeCheckIssueId,
          companyId,
          title: "GER-118 convergence check round 1: Автор-Claude подтверждает схождение",
          identifier: "GER-161",
          parentId: rootIssueId,
          projectId: "project-1",
          status: "done",
          assigneeAgentId: claudeAgentId,
          originKind: CONVERGENCE_CHECK_ORIGIN_KIND,
          originId: `${runId}:author-claude:r1`,
          originRunId: runId,
          requestDepth: 1,
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
        agent({
          id: ctoAgentId,
          companyId,
          name: "CTO",
          adapterType: "codex_local",
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.issues.documents.upsert({
      issueId: codexPingPongIssueId,
      companyId,
      key: "pingpong-codex-r1",
      title: "Ping-pong Автор-Codex R1",
      body: "Codex agreed technical specification material.",
    });
    await harness.ctx.issues.documents.upsert({
      issueId: claudePingPongIssueId,
      companyId,
      key: "plan",
      title: "ТЗ GER-118 — Автор-Claude (пинг-понг раунд 1)",
      body: "Claude agreed technical specification material.",
    });
    for (const checkIssueId of [codexCheckIssueId, claudeCheckIssueId]) {
      await harness.ctx.issues.documents.upsert({
        issueId: checkIssueId,
        companyId,
        key: "continuation-summary",
        title: "Continuation Summary",
        body: [
          "verdict: СОШЛИСЬ",
          "candidate:",
          "  source: merged",
          "remaining_deltas: []",
        ].join("\n"),
      });
    }

    const runRow = {
      id: runId,
      company_id: companyId,
      root_issue_id: rootIssueId,
      process_key: PROCESS_KEY,
      status: "iterating",
      state: "convergence_check_round_1_dispatched",
      current_round: 1,
      max_rounds: 6,
      qa_rework_limit: 2,
      idempotency_key: "tz-cycle:synthesis-test",
      operator_input: {},
      selected_agents: {
        "author-codex": {
          agentId: codexAgentId,
          agentName: "Автор-Codex",
          adapterType: "codex_local",
          issueId: "codex-draft-issue",
          issueIdentifier: "GER-149",
          wakeupRunId: null,
        },
        "author-claude": {
          agentId: claudeAgentId,
          agentName: "Автор-Claude",
          adapterType: "claude_local",
          issueId: "claude-draft-issue",
          issueIdentifier: "GER-150",
          wakeupRunId: null,
        },
        pingPongRound1: {
          "author-codex": {
            agentId: codexAgentId,
            agentName: "Автор-Codex",
            adapterType: "codex_local",
            issueId: codexPingPongIssueId,
            issueIdentifier: "GER-156",
            wakeupRunId: null,
          },
          "author-claude": {
            agentId: claudeAgentId,
            agentName: "Автор-Claude",
            adapterType: "claude_local",
            issueId: claudePingPongIssueId,
            issueIdentifier: "GER-157",
            wakeupRunId: null,
          },
        },
        convergenceCheckRound1: {
          "author-codex": {
            agentId: codexAgentId,
            agentName: "Автор-Codex",
            adapterType: "codex_local",
            issueId: codexCheckIssueId,
            issueIdentifier: "GER-160",
            wakeupRunId: null,
          },
          "author-claude": {
            agentId: claudeAgentId,
            agentName: "Автор-Claude",
            adapterType: "claude_local",
            issueId: claudeCheckIssueId,
            issueIdentifier: "GER-161",
            wakeupRunId: null,
          },
        },
      },
      started_at: now,
      updated_at: now,
      completed_at: null,
    };
    const originalQuery = harness.ctx.db.query.bind(harness.ctx.db);
    harness.ctx.db.query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes(".tz_process_runs") && sql.includes("convergence_check_round_1_dispatched")) {
        return [runRow] as T[];
      }
      return originalQuery(sql, params);
    };

    await harness.emit("issue.updated", {}, {
      companyId,
      entityType: "issue",
      entityId: claudeCheckIssueId,
      actorType: "agent",
      actorId: claudeAgentId,
    });

    const synthesisIssues = await harness.ctx.issues.list({
      companyId,
      originKindPrefix: SYNTHESIS_ORIGIN_KIND,
      includePluginOperations: true,
      limit: 10,
    });
    expect(synthesisIssues).toHaveLength(1);
    expect(synthesisIssues[0]).toEqual(expect.objectContaining({
      parentId: rootIssueId,
      assigneeAgentId: ctoAgentId,
      status: "todo",
      originKind: SYNTHESIS_ORIGIN_KIND,
      originId: `${runId}:cto-synthesis:r1`,
    }));
    expect(synthesisIssues[0]?.description).toContain("Ты CTO. Авторы сошлись после round 1");
    expect(synthesisIssues[0]?.description).toContain("Codex agreed technical specification material.");
    expect(synthesisIssues[0]?.description).toContain("Claude agreed technical specification material.");
    expect(harness.dbExecutes.some((entry) =>
      entry.sql.includes("state = 'cto_synthesis_dispatched'"))).toBe(true);
    expect(harness.dbExecutes.some((entry) =>
      entry.sql.includes(".tz_process_artifacts") && entry.params?.includes(SYNTHESIS_ARTIFACT_KEY))).toBe(true);
    expect(harness.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "CTO-синтез запущен: оба автора подтвердили схождение",
        entityId: rootIssueId,
      }),
    ]));
  });
});
