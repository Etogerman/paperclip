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
- scoped API routes:
  - `POST /issues/:issueId/tz-process/start`
  - `GET /issues/:issueId/tz-process`
- plugin actions/data:
  - `start-cycle`
  - `status`
- trace issue document: `tz-process-trace`
- event listener for issue thread interaction resolutions

## Not In This Skeleton Yet

- GPT/Claude agent session calls
- author ping-pong rounds
- convergence detection
- synthesis
- cross-vendor QA
- operator gate UI

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
