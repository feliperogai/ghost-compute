-- ghost control plane: initial schema

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Humans ---------------------------------------------------------------------

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,
  role         text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz
);

CREATE TABLE api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Workers --------------------------------------------------------------------

CREATE TABLE workers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  owner_user_id         uuid REFERENCES users(id),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  state                 text NOT NULL DEFAULT 'offline'
                          CHECK (state IN ('offline', 'waiting', 'available', 'running', 'paused', 'stopped')),
  secret_hash           bytea NOT NULL,
  max_concurrent_tasks  integer NOT NULL DEFAULT 1 CHECK (max_concurrent_tasks BETWEEN 1 AND 256),
  hardware              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_usage            jsonb,
  agent_version         text,
  last_seen_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  revoked_reason        text
);

CREATE INDEX workers_state_idx ON workers (status, state);

CREATE TABLE enrollment_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         bytea NOT NULL UNIQUE,
  created_by         uuid NOT NULL REFERENCES users(id),
  note               text,
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,
  used_by_worker_id  uuid REFERENCES workers(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Jobs & tasks ---------------------------------------------------------------

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  module_name      text NOT NULL,
  module_version   text NOT NULL,
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,
  requirements     jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority         integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  max_retries      integer NOT NULL DEFAULT 3 CHECK (max_retries BETWEEN 0 AND 20),
  status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total_tasks      integer NOT NULL,
  succeeded_tasks  integer NOT NULL DEFAULT 0,
  failed_tasks     integer NOT NULL DEFAULT 0,
  cancelled_tasks  integer NOT NULL DEFAULT 0,
  cancel_reason    text,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

CREATE INDEX jobs_history_idx ON jobs (created_at DESC, id DESC);
CREATE INDEX jobs_status_idx ON jobs (status);

CREATE TABLE tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx            integer NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
  input          jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts       integer NOT NULL DEFAULT 0,
  progress       real NOT NULL DEFAULT 0,
  last_error     text,
  output         jsonb,
  output_sha256  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  UNIQUE (job_id, idx)
);

CREATE INDEX tasks_job_status_idx ON tasks (job_id, status);
CREATE INDEX tasks_pending_idx ON tasks (status) WHERE status = 'pending';

CREATE TABLE leases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id    uuid NOT NULL REFERENCES workers(id),
  status       text NOT NULL DEFAULT 'offered'
                 CHECK (status IN ('offered', 'running', 'succeeded', 'failed', 'preempted',
                                   'expired', 'rejected', 'cancelled')),
  progress     real NOT NULL DEFAULT 0,
  stage        text,
  error        text,
  offered_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,
  expires_at   timestamptz NOT NULL,
  finished_at  timestamptz
);

-- At most one live lease per task.
CREATE UNIQUE INDEX leases_one_active_per_task ON leases (task_id) WHERE status IN ('offered', 'running');
CREATE INDEX leases_worker_active_idx ON leases (worker_id) WHERE status IN ('offered', 'running');
CREATE INDEX leases_expiry_idx ON leases (expires_at) WHERE status IN ('offered', 'running');

CREATE TABLE task_events (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_id     uuid REFERENCES tasks(id) ON DELETE CASCADE,
  lease_id    uuid REFERENCES leases(id) ON DELETE SET NULL,
  worker_id   uuid REFERENCES workers(id),
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_events_job_idx ON task_events (job_id, id);

-- Audit ----------------------------------------------------------------------

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'worker', 'system')),
  actor_id     uuid,
  action       text NOT NULL,
  target_type  text,
  target_id    uuid,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
