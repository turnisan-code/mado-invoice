-- Multi-stage dunning (Zahlungserinnerung → 1. Mahnung → 2. Mahnung), Skonto terms on
-- invoices and payment kinds (money received vs. Skonto taken vs. written off).

-- ─── documents ───────────────────────────────────────────────────────────────
alter table documents
  add column if not exists reminder_level int not null default 0,
  add column if not exists skonto_percent numeric,
  add column if not exists skonto_days    int;

-- ─── reminder_log ────────────────────────────────────────────────────────────
-- One row per reminder email that went out, so the invoice page can show the dunning history
-- and the cron can tell which level comes next.
create table if not exists reminder_log (
  id          uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  level       int not null,
  sent_at     timestamptz not null default now(),
  to_email    text,
  subject     text
);

create index if not exists reminder_log_document_id_idx on reminder_log(document_id);

alter table reminder_log enable row level security;
drop policy if exists "owner" on reminder_log;
create policy "owner" on reminder_log for all to authenticated using (is_app_user()) with check (is_app_user());

-- ─── payments ────────────────────────────────────────────────────────────────
-- 'payment' is money that arrived (the only kind the UVA and revenue figures count);
-- 'skonto' and 'writeoff' close the remaining balance without a bank transfer.
alter table payments add column if not exists kind text not null default 'payment';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payments'::regclass and conname = 'payments_kind_check'
  ) then
    alter table public.payments
      add constraint payments_kind_check check (kind in ('payment','skonto','writeoff'));
  end if;
end $$;

-- ─── settings ────────────────────────────────────────────────────────────────
alter table settings
  add column if not exists reminders_enabled      boolean not null default true,
  add column if not exists reminder_grace_days    int     not null default 7,
  add column if not exists reminder_interval_days int     not null default 14,
  add column if not exists reminder_max_level     int     not null default 3,
  add column if not exists reminder_fee           numeric not null default 0,
  add column if not exists reminder_interest_rate numeric not null default 0,
  add column if not exists default_skonto_percent numeric,
  add column if not exists default_skonto_days    int;

-- ─── clients ─────────────────────────────────────────────────────────────────
alter table clients add column if not exists reminders_opt_out boolean not null default false;
