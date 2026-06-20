CREATE TABLE plugin_tz_process_engine_0d111659b9.tz_process_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  root_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  process_key text NOT NULL,
  status text NOT NULL DEFAULT 'intake',
  state text NOT NULL DEFAULT 'intake',
  current_round integer NOT NULL DEFAULT 0,
  max_rounds integer NOT NULL DEFAULT 6,
  qa_rework_limit integer NOT NULL DEFAULT 2,
  idempotency_key text NOT NULL,
  operator_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_agents jsonb NOT NULL DEFAULT '{}'::jsonb,
  lock_owner text,
  lock_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (company_id, idempotency_key)
);

CREATE UNIQUE INDEX tz_process_runs_active_root_uq
  ON plugin_tz_process_engine_0d111659b9.tz_process_runs (company_id, root_issue_id)
  WHERE status NOT IN ('accepted', 'returned', 'cancelled', 'failed');

CREATE TABLE plugin_tz_process_engine_0d111659b9.tz_process_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES plugin_tz_process_engine_0d111659b9.tz_process_runs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tz_process_events_run_created_idx
  ON plugin_tz_process_engine_0d111659b9.tz_process_events (run_id, created_at);

CREATE TABLE plugin_tz_process_engine_0d111659b9.tz_process_artifacts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES plugin_tz_process_engine_0d111659b9.tz_process_runs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  role_key text NOT NULL,
  round_number integer NOT NULL DEFAULT 0,
  artifact_key text NOT NULL,
  visibility text NOT NULL DEFAULT 'private',
  content text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, role_key, round_number, artifact_key)
);

CREATE INDEX tz_process_artifacts_run_round_idx
  ON plugin_tz_process_engine_0d111659b9.tz_process_artifacts (run_id, round_number, role_key);
