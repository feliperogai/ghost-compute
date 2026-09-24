// What a job already owes providers, in millicredits, for attempts that count as work
// done before the next one: completed replicas (verified jobs) and resumable timeouts.
// Used to keep every new attempt within the remaining budget. `$job` is the jobs alias.
export const owedSql = (job: string) => `COALESCE((
  SELECT sum(LEAST(ceil(p.price_rate * ceil(EXTRACT(EPOCH FROM p.finished_at - p.started_at)) / 60.0),
                   ceil(p.price_rate * ${job}.timeout_seconds / 60.0)))
    FROM job_assignments p
   WHERE p.job_id = ${job}.id AND p.price_rate IS NOT NULL AND p.started_at IS NOT NULL
     AND (p.status = 'completed' OR (p.status = 'timeout' AND ${job}.retry_on_timeout))), 0)`;
