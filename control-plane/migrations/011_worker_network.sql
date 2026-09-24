-- Network a worker connects from (as seen by the server), for replica diversity:
-- replicas of a verified job must come from different networks, not just accounts.
ALTER TABLE workers ADD COLUMN last_ip text;
