-- Email recipients per client: further addresses (e.g. an accounting mailbox) that every email
-- and reminder to the client copies in CC. Idempotent — safe to re-run.

alter table clients add column if not exists cc_emails text[] not null default '{}';
