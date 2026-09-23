-- Jobs become the schedulable unit; each attempt is a job_assignment.
-- Replaces the batch model (jobs → tasks → leases). MVP: no data to migrate.

DROP TABLE IF EXISTS task_events, leases, tasks, jobs CASCADE;

-- What the agent offers (owner limits applied) and which workload types it runs.
ALTER TABLE workers
  ADD COLUMN capacity jsonb,
  ADD COLUMN workload_types text[] NOT NULL DEFAULT '{}';

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id),
  name             text,
  type             text NOT NULL,
  requirements     jsonb NOT NULL DEFAULT '{}'::jsonb,
  resources        jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'QUEUED'
                     CHECK (status IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT')),
  priority         integer NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  timeout_seconds  integer NOT NULL CHECK (timeout_seconds BETWEEN 10 AND 604800),
  max_attempts     integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  failures         integer NOT NULL DEFAULT 0,
  input            jsonb NOT NULL,
  output           jsonb,
  output_sha256    text,
  error            jsonb,
  worker_id        uuid REFERENCES workers(id),
  progress         real NOT NULL DEFAULT 0,
  stage            text,
  -- Why the scheduler could not place it yet (explainability).
  pending_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  assigned_at      timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_queue_idx ON jobs (priority DESC, created_at) WHERE status = 'QUEUED';
CREATE INDEX jobs_running_idx ON jobs (started_at) WHERE status = 'RUNNING';
CREATE INDEX jobs_history_idx ON jobs (created_at DESC, id DESC);
CREATE INDEX jobs_owner_idx ON jobs (owner_id, created_at DESC);

CREATE TABLE job_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id        uuid NOT NULL REFERENCES workers(id),
  attempt          integer NOT NULL,
  status           text NOT NULL DEFAULT 'assigned'
                     CHECK (status IN ('assigned', 'running', 'completed', 'failed', 'rejected',
                                       'expired', 'lost', 'cancelled', 'timeout')),
  strategy         text NOT NULL,
  score            real NOT NULL,
  score_detail     jsonb NOT NULL,
  reserved         jsonb NOT NULL,
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  accept_deadline  timestamptz NOT NULL,
  started_at       timestamptz,
  last_seen_at     timestamptz,
  finished_at      timestamptz,
  error            text
);

CREATE UNIQUE INDEX job_assignments_one_active ON job_assignments (job_id) WHERE status IN ('assigned', 'running');
CREATE INDEX job_assignments_worker_active ON job_assignments (worker_id) WHERE status IN ('assigned', 'running');
CREATE INDEX job_assignments_worker_recent ON job_assignments (worker_id, finished_at DESC);

CREATE TABLE job_events (
  id             bigserial PRIMARY KEY,
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  assignment_id  uuid REFERENCES job_assignments(id) ON DELETE SET NULL,
  worker_id      uuid REFERENCES workers(id),
  type           text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_events_job_idx ON job_events (job_id, id);
