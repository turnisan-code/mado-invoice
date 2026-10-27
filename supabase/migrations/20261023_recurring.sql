-- Recurring invoices: a schedule points at a template invoice and every run copies that
-- invoice into a new one for the next period (monthly retainers, rentals, subscriptions).
-- The template content lives in the invoice itself; the schedule only holds the timing.
-- Idempotent — safe to re-run.

create table if not exists recurring_schedules (
  id                 uuid primary key default uuid_generate_v4(),
  created_at         timestamptz not null default now(),
  source_document_id uuid not null unique references documents(id) on delete cascade,
  name               text not null,
  interval           text not null check (interval in ('weekly','monthly','quarterly','half_yearly','yearly')),
  -- Day-of-month the schedule was created with, so 31 Jan → 28 Feb → 31 Mar instead of
  -- drifting to the 28th for good.
  anchor_day         smallint not null,
  next_date          date not null,
  end_date           date,
  active             boolean not null default true,
  -- true: the service period is the interval STARTING on the invoice date; false: the interval
  -- that ENDS the day before the invoice date (billing in arrears).
  in_advance         boolean not null default false,
  mode               text not null default 'draft' check (mode in ('draft','issue')),
  last_generated_at  timestamptz,
  last_document_id   uuid references documents(id) on delete set null
);

alter table documents
  add column if not exists recurring_schedule_id uuid references recurring_schedules(id) on delete set null;

-- A period can never be generated twice, even if two runs overlap.
create unique index if not exists documents_recurring_period_key
  on documents(recurring_schedule_id, date)
  where recurring_schedule_id is not null;

-- Generated invoices point back at their template through converted_from_id. Without an
-- ON DELETE rule that FK blocks deleting a draft template that already produced invoices;
-- SET NULL keeps the generated invoices and only clears the back-reference. The constraint is
-- found by column rather than by name because production may have created it by hand.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.documents'::regclass
      and con.contype = 'f'
      and att.attname = 'converted_from_id'
      and con.confdeltype <> 'n'
  loop
    execute format('alter table public.documents drop constraint %I', c.conname);
  end loop;

  if not exists (
    select 1
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.documents'::regclass
      and con.contype = 'f'
      and att.attname = 'converted_from_id'
      and con.confdeltype = 'n'
  ) then
    alter table public.documents
      add constraint documents_converted_from_id_fkey
      foreign key (converted_from_id) references documents(id) on delete set null;
  end if;
end $$;

alter table recurring_schedules enable row level security;
drop policy if exists "owner" on recurring_schedules;
create policy "owner" on recurring_schedules for all to authenticated using (is_app_user()) with check (is_app_user());
