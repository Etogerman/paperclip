import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema, type Issue } from "@paperclipai/shared";
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

describe("TZ Process Engine plugin", () => {
  it("declares the MVP process-engine surfaces", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "paperclipai.plugin-tz-process-engine",
      capabilities: expect.arrayContaining([
        "events.subscribe",
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
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
});
