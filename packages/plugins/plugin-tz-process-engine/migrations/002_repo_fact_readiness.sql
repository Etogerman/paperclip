CREATE TABLE plugin_tz_process_engine_0d111659b9.tz_repo_inventories (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  root_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  run_id uuid REFERENCES plugin_tz_process_engine_0d111659b9.tz_process_runs(id) ON DELETE SET NULL,
  folder_key text NOT NULL,
  status text NOT NULL,
  repo_path text,
  file_count integer NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tz_repo_inventories_issue_created_idx
  ON plugin_tz_process_engine_0d111659b9.tz_repo_inventories (company_id, root_issue_id, created_at DESC);

CREATE TABLE plugin_tz_process_engine_0d111659b9.tz_fact_checks (
  id uuid PRIMARY KEY,
  inventory_id uuid NOT NULL REFERENCES plugin_tz_process_engine_0d111659b9.tz_repo_inventories(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  root_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  run_id uuid REFERENCES plugin_tz_process_engine_0d111659b9.tz_process_runs(id) ON DELETE SET NULL,
  claim_key text NOT NULL,
  claim text NOT NULL,
  predicate jsonb NOT NULL DEFAULT '{}'::jsonb,
  command_label text NOT NULL,
  status text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inventory_id, claim_key)
);

CREATE INDEX tz_fact_checks_issue_status_idx
  ON plugin_tz_process_engine_0d111659b9.tz_fact_checks (company_id, root_issue_id, status);

CREATE TABLE plugin_tz_process_engine_0d111659b9.tz_readiness_gates (
  id uuid PRIMARY KEY,
  inventory_id uuid NOT NULL REFERENCES plugin_tz_process_engine_0d111659b9.tz_repo_inventories(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  root_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  run_id uuid REFERENCES plugin_tz_process_engine_0d111659b9.tz_process_runs(id) ON DELETE SET NULL,
  status text NOT NULL,
  blocking_count integer NOT NULL DEFAULT 0,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tz_readiness_gates_issue_created_idx
  ON plugin_tz_process_engine_0d111659b9.tz_readiness_gates (company_id, root_issue_id, created_at DESC);
