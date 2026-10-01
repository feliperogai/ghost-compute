-- Random verification by trusted computers. A share of verified jobs, drawn when each
-- job is created (providers cannot tell which), has its verification replica run on a
-- computer owned by staff, whose answer decides. Waits for one only while one is online.
ALTER TABLE jobs ADD COLUMN trusted_check boolean NOT NULL DEFAULT false;
