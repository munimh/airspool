-- airspool outbox tables for Postgres.
-- Times are milliseconds since the Unix epoch. Safe to run more than once.
-- To use other names, pass tablePrefix (and schema, on Postgres) to the store
-- and edit the names below to match.

CREATE TABLE IF NOT EXISTS airspool_changes (
  id bigserial PRIMARY KEY,
  queue text NOT NULL,
  group_key text NOT NULL,
  base_id text NOT NULL,
  table_name text NOT NULL,
  record_id text,
  match_fields jsonb,
  fields jsonb NOT NULL,
  typecast boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  send_after bigint NOT NULL,
  sent_at bigint,
  last_error text
);

CREATE INDEX IF NOT EXISTS airspool_changes_by_group ON airspool_changes (queue, status, group_key, id);

CREATE TABLE IF NOT EXISTS airspool_leases (
  queue text PRIMARY KEY,
  owner text NOT NULL,
  expires_at bigint NOT NULL
);
