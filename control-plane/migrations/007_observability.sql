-- Observability: time series for the admin dashboard and an error log for debugging.

-- One sample per worker per minute, from heartbeats.
CREATE TABLE worker_metrics (
  worker_id          uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  ts                 timestamptz NOT NULL DEFAULT now(),
  state              text NOT NULL,
  cpu_percent        real,
  cpu_ghost_percent  real,
  ram_used_mb        integer,
  ram_ghost_mb       integer,
  gpu_percent        real,
  temperature_c      real,
  active_assignments integer NOT NULL DEFAULT 0,
  PRIMARY KEY (worker_id, ts)
);
CREATE INDEX worker_metrics_ts_idx ON worker_metrics (ts);

-- One snapshot of the whole network per minute (collector, leader only).
CREATE TABLE network_metrics (
  ts                timestamptz PRIMARY KEY,
  workers_online    integer NOT NULL,
  workers_offline   integer NOT NULL,
  workers_by_state  jsonb NOT NULL,
  cpu_cores         real NOT NULL,
  ram_mb            bigint NOT NULL,
  gpus              integer NOT NULL,
  vram_mb           bigint NOT NULL,
  jobs_queued       integer NOT NULL,
  jobs_running      integer NOT NULL,
  -- Finished during the minute before ts.
  jobs_completed    integer NOT NULL,
  jobs_failed       integer NOT NULL,
  -- Time from creation to assignment of jobs assigned during that minute.
  queue_wait_p50_s  real,
  queue_wait_p95_s  real
);

-- HTTP request stats, per control-plane instance and minute. Latency as a histogram
-- (bucket upper bounds in ms, last = overflow) so instances merge exactly.
CREATE TABLE api_metrics (
  instance    text NOT NULL,
  minute      timestamptz NOT NULL,
  requests    integer NOT NULL,
  errors_4xx  integer NOT NULL,
  errors_5xx  integer NOT NULL,
  buckets     integer[] NOT NULL,
  PRIMARY KEY (minute, instance)
);

-- Recent server errors (5xx) with the request id for log correlation.
CREATE TABLE api_errors (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  method      text NOT NULL,
  route       text NOT NULL,
  status      integer NOT NULL,
  request_id  text,
  code        text,
  message     text
);
CREATE INDEX api_errors_ts_idx ON api_errors (ts DESC);
