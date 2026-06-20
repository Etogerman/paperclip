# TZ Process Engine

Paperclip plugin MVP for deterministic GPT/Claude technical-spec creation cycles.

This package is intentionally a small process-engine skeleton, not the full
agent loop yet. It establishes the installable plugin shape and the persistent
state model that the full process will use.

## Current MVP Scope

- plugin manifest and installable worker package
- plugin-owned Postgres namespace
- `tz_process_runs` authoritative state table
- `tz_process_events` append-only trace table
- `tz_process_artifacts` private/staged artifact table for blind drafts
- `tz_repo_inventories`, `tz_fact_checks`, and `tz_readiness_gates` for code-enforced Repo Inventory / Fact Ledger checks
- read-only local folder declaration `project-repo` for repository scanning
- scoped API routes:
  - `POST /issues/:issueId/tz-process/start`
  - `GET /issues/:issueId/tz-process`
  - `POST /issues/:issueId/tz-process/readiness-check`
- plugin actions/data:
  - `start-cycle`
  - `status`
  - `run-readiness-check`
- trace issue document: `tz-process-trace`
- readiness report issue document: `tz-readiness-report`
- event listener for issue thread interaction resolutions

## Not In This Skeleton Yet

- GPT/Claude agent session calls
- author ping-pong rounds
- convergence detection
- synthesis
- cross-vendor QA
- operator gate UI

## Repo Inventory / Fact Ledger

`run-readiness-check` verifies code claims through plugin code, not through an agent's prose.

The operator configures the `project-repo` local folder for the company. The plugin then reads that folder through the Paperclip SDK and evaluates fact predicates such as:

- `file_exists`
- `text_search`
- `regex_search`

Only this code path can write `confirmed` facts into `tz_fact_checks`. Missing matches remain `missing`, and the readiness gate is `blocked` until every required fact is confirmed.

Those layers should be added on top of this package after the plugin can be
installed and the start/status flow is verified in a real Paperclip instance.

## Development

```bash
pnpm --filter @paperclipai/plugin-tz-process-engine typecheck
pnpm --filter @paperclipai/plugin-tz-process-engine test
pnpm --filter @paperclipai/plugin-tz-process-engine build
```

## Local Install

Use an absolute local path during development:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip/packages/plugins/plugin-tz-process-engine","isLocalPath":true}'
```
