-- Google grant metadata: when the account was connected and which scopes it granted,
-- so Settings can show real state instead of guessing whether Drive access exists.
alter table settings add column if not exists gmail_connected_at timestamptz;
alter table settings add column if not exists gmail_scopes text;

-- First successful Gmail send of a document (never overwritten by later re-sends).
alter table documents add column if not exists sent_at timestamptz;
