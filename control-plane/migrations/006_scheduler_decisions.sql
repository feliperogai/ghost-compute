-- Explainable scheduling: every placement stores why the worker was chosen.

-- Start of the current uninterrupted online period (availability term).
ALTER TABLE workers ADD COLUMN online_since timestamptz;
UPDATE workers SET online_since = last_seen_at WHERE state <> 'offline';

CREATE TABLE scheduler_decisions (
  id             bigserial PRIMARY KEY,
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  assignment_id  uuid REFERENCES job_assignments(id) ON DELETE SET NULL,
  worker_id      uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  strategy       text NOT NULL,
  score          real NOT NULL,
  -- "Worker X foi escolhido porque ..."
  summary        text NOT NULL,
  -- Terms, weights, runner-up, top candidates, rejected counts.
  explanation    jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduler_decisions_job_idx ON scheduler_decisions (job_id, id);
CREATE INDEX scheduler_decisions_worker_idx ON scheduler_decisions (worker_id, id DESC);
