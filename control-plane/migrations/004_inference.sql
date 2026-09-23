-- Image inference: datasets of images, job groups (one job per batch) and checkpoints.

CREATE TABLE datasets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id),
  name         text NOT NULL,
  -- OPEN: accepts images. SEALED: immutable, usable by inference runs.
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SEALED')),
  image_count  integer NOT NULL DEFAULT 0,
  total_bytes  bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sealed_at    timestamptz
);
CREATE INDEX datasets_owner_idx ON datasets (owner_id, created_at DESC);

CREATE TABLE dataset_images (
  dataset_id    uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  idx           integer NOT NULL,
  name          text,
  content_type  text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  size          integer NOT NULL CHECK (size > 0),
  sha256        text NOT NULL,
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, idx)
);

CREATE TABLE job_groups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users(id),
  kind           text NOT NULL CHECK (kind IN ('image-inference')),
  name           text,
  dataset_id     uuid NOT NULL REFERENCES datasets(id),
  params         jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'RUNNING'
                   CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  total_batches  integer NOT NULL,
  total_items    integer NOT NULL,
  -- json, not jsonb: kept byte-for-byte so result_sha256 stays verifiable.
  result         json,
  result_sha256  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_groups_owner_idx ON job_groups (owner_id, created_at DESC);

ALTER TABLE jobs
  ADD COLUMN group_id uuid REFERENCES job_groups(id) ON DELETE CASCADE,
  ADD COLUMN batch_index integer,
  -- Partial results reported by a worker; handed to the next attempt.
  ADD COLUMN checkpoint jsonb,
  -- Batches are resumable, so a timed-out attempt is retried instead of ending the job.
  ADD COLUMN retry_on_timeout boolean NOT NULL DEFAULT false;
CREATE INDEX jobs_group_idx ON jobs (group_id, batch_index) WHERE group_id IS NOT NULL;
