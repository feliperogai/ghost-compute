-- Automatic worker benchmarks ("calibration") and the resulting performance profile.

CREATE TABLE worker_calibrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id        uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  -- Seeds the network test data; proves the bytes really travelled.
  nonce            text NOT NULL,
  params           jsonb NOT NULL,
  reason           text NOT NULL,
  status           text NOT NULL DEFAULT 'REQUESTED'
                     CHECK (status IN ('REQUESTED', 'COMPLETED', 'FAILED', 'EXPIRED')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  deadline         timestamptz NOT NULL,
  completed_at     timestamptz,
  -- Measured by the server itself (upload bandwidth).
  server_measured  jsonb NOT NULL DEFAULT '{}'::jsonb,
  report           jsonb,
  issues           jsonb,
  error            text
);
CREATE UNIQUE INDEX worker_calibrations_one_open ON worker_calibrations (worker_id) WHERE status = 'REQUESTED';
CREATE INDEX worker_calibrations_recent ON worker_calibrations (worker_id, requested_at DESC);

CREATE TABLE worker_performance (
  worker_id        uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  calibration_id   uuid REFERENCES worker_calibrations(id) ON DELETE SET NULL,
  profile          jsonb NOT NULL,
  verified         boolean NOT NULL,
  agent_version    text,
  hardware_sha256  text NOT NULL,
  calibrated_at    timestamptz NOT NULL,
  -- Throughput seen on real jobs (EWMA per workload type); corrects optimistic benchmarks.
  observed         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
