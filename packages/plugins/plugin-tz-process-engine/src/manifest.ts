import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "TZ Process Engine",
  description: "Deterministic Process Engine MVP for GPT/Claude technical-spec creation cycles.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "local.folders",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.documents.read",
    "issue.documents.write",
    "issue.interactions.read",
    "issue.interactions.create",
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "activity.log.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  database: {
    namespaceSlug: "tz_process_engine",
    migrationsDir: "migrations",
    coreReadTables: ["issues", "agents", "issue_documents", "issue_comments"]
  },
  localFolders: [
    {
      folderKey: "project-repo",
      displayName: "Project repository",
      description: "Read-only project checkout used by TZ Process Engine for code-enforced Repo Inventory and Fact Ledger checks.",
      access: "read",
      requiredDirectories: [],
      requiredFiles: []
    }
  ],
  apiRoutes: [
    {
      routeKey: "start-cycle",
      method: "POST",
      path: "/issues/:issueId/tz-process/start",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "required-for-agent-in-progress",
      companyResolution: { from: "issue", param: "issueId" }
    },
    {
      routeKey: "status",
      method: "GET",
      path: "/issues/:issueId/tz-process",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "issue", param: "issueId" }
    },
    {
      routeKey: "run-readiness-check",
      method: "POST",
      path: "/issues/:issueId/tz-process/readiness-check",
      auth: "board-or-agent",
      capability: "api.routes.register",
      checkoutPolicy: "required-for-agent-in-progress",
      companyResolution: { from: "issue", param: "issueId" }
    }
  ]
};

export default manifest;
