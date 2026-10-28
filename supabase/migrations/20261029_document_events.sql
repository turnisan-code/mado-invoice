-- Event history per document: issuing, every email and reminder, status changes, payments,
-- Storno, archive copies and Drive uploads, so the owner can show when and to whom a
-- document went out. Rows are only ever inserted by the app.
-- Idempotent — safe to re-run.

create table if not exists document_events (
  id          uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  created_at  timestamptz not null default now(),
  type        text not null check (type in (
                'issued','emailed','mailto_opened','reminder_sent','status_changed',
                'payment_added','payment_removed','storno_created','archived','drive_archived',
                'portal_viewed','portal_responded','bookamat_synced','converted')),
  detail      jsonb not null default '{}'
);

create index if not exists document_events_document_id_created_at_idx
  on document_events(document_id, created_at);

alter table document_events enable row level security;
drop policy if exists "owner" on document_events;
create policy "owner" on document_events
  for all to authenticated using (is_app_user()) with check (is_app_user());

-- Seed the history from what was recorded before the log existed. Each insert skips rows that
-- are already there, so a re-run adds nothing.
insert into document_events (document_id, created_at, type, detail)
select d.id, d.issued_at, 'issued', jsonb_build_object('number', d.number)
from documents d
where d.issued_at is not null and d.number is not null
  and not exists (select 1 from document_events e where e.document_id = d.id and e.type = 'issued');

insert into document_events (document_id, created_at, type, detail)
select d.id, d.sent_at, 'emailed', '{}'::jsonb
from documents d
where d.sent_at is not null
  and not exists (
    select 1 from document_events e
    where e.document_id = d.id and e.type = 'emailed' and e.created_at = d.sent_at
  );

insert into document_events (document_id, created_at, type, detail)
select r.document_id, r.sent_at, 'reminder_sent',
       jsonb_strip_nulls(jsonb_build_object('level', r.level, 'to', r.to_email, 'subject', r.subject))
from reminder_log r
where not exists (
  select 1 from document_events e
  where e.document_id = r.document_id and e.type = 'reminder_sent' and e.created_at = r.sent_at
);
