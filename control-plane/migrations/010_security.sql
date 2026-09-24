-- Security controls for the open platform (docs/security/AUDIT.md).

-- Result verification. 'replicate': the job is only COMPLETED when two computers of
-- different owners return results that agree (a third one breaks a tie).
ALTER TABLE jobs ADD COLUMN verification text NOT NULL DEFAULT 'none'
  CHECK (verification IN ('none', 'replicate'));

-- Each attempt keeps its own result (replicas are compared before the job gets one),
-- whether a failure was the environment's (retryable) or the job's, and the verdict of
-- the comparison.
ALTER TABLE job_assignments
  ADD COLUMN output         json,
  ADD COLUMN output_sha256  text,
  ADD COLUMN retryable      boolean,
  ADD COLUMN verdict        text CHECK (verdict IN ('agreed', 'disagreed'));

CREATE INDEX job_assignments_verdict ON job_assignments (worker_id) WHERE verdict = 'disagreed';
