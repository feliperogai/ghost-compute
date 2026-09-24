-- Open platform: self-service accounts, provider offers, customer budgets.
-- Credits stay virtual (ADR 007): providers are paid in credits, never money.

-- 'member': a public account (customer and/or provider). Sees only its own data.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'operator', 'viewer', 'member'));

-- What a provider offers with one computer. No row = default offer (listed, standard
-- price, always available, no extra limits).
CREATE TABLE worker_offers (
  worker_id     uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  listed        boolean NOT NULL DEFAULT true,
  -- Millicredits per minute of each reserved resource: {cpuCore, ramGb, gpu, vramGb}.
  price         jsonb NOT NULL,
  -- {timezone, windows: [{days: [0..6], start: "HH:MM", end: "HH:MM"}]}; no windows = always.
  availability  jsonb NOT NULL,
  -- {maxCpuCores?, maxRamMb?, maxJobSeconds?, maxConcurrent?, allowGpu?, workloadTypes?}
  limits        jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Customer budget: the most the job may cost, in millicredits (held at creation).
ALTER TABLE jobs ADD COLUMN budget bigint CHECK (budget IS NULL OR budget > 0);

-- Price the provider asked when the attempt was assigned (millicredits/min for the
-- reserved resources). Later price changes never affect a running attempt.
ALTER TABLE job_assignments ADD COLUMN price_rate integer CHECK (price_rate IS NULL OR price_rate > 0);

-- Reputation inputs, all observed by the server.
CREATE INDEX job_assignments_worker_finished ON job_assignments (worker_id, finished_at) WHERE finished_at IS NOT NULL;
