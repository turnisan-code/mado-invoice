-- Bookkeeping and money flows.
--  - payments.kind 'fee': dunning fees and default interest a client paid on top of an invoice
--    (Mahnspesen, Verzugszinsen). Money received, but neither turnover nor part of the balance.
--  - bookamat_bookings: one Bookamat booking per document, calendar year and kind (Ist: money
--    received in two years is booked in both fiscal years). Replaces documents.bookamat_booking_id,
--    which stays readable; its ids are copied over.
--  - documents.bookamat_error / bookamat_claimed_at: the last sync failure, and the claim a sync
--    takes before it posts, so two syncs can never book the same document twice.
--  - settings: optional daily automatic sync, the Bookamat year the account ids were chosen in,
--    and the last Google / Bookamat error for Settings.
-- Idempotent — safe to re-run.

-- ─── Payments ────────────────────────────────────────────────────────────────
alter table payments drop constraint if exists payments_kind_check;
alter table payments add constraint payments_kind_check
  check (kind in ('payment','skonto','writeoff','credit','refund','fee'));

-- ─── Bookamat bookings ───────────────────────────────────────────────────────
create table if not exists bookamat_bookings (
  id              uuid primary key default uuid_generate_v4(),
  document_id     uuid not null references documents(id) on delete cascade,
  -- Bookamat fiscal year the booking was posted to (the year the money moved).
  year            integer not null check (year between 2000 and 2999),
  booking_id      text not null,
  -- Gross amount booked; negative for a refund paid back on a credit note.
  amount          numeric(10,2) not null,
  kind            text not null check (kind in ('income','refund')),
  booked_on       date,
  pdf_attached_at timestamptz,
  created_at      timestamptz not null default now()
);

create unique index if not exists bookamat_bookings_document_year_kind_key on bookamat_bookings(document_id, year, kind);

alter table bookamat_bookings enable row level security;
drop policy if exists "owner" on bookamat_bookings;
create policy "owner" on bookamat_bookings
  for all to authenticated using (is_app_user()) with check (is_app_user());

-- The single booking of the old sync: dated on the invoice's last payment, in that year.
insert into bookamat_bookings (document_id, year, booking_id, amount, kind, booked_on)
select d.id,
       extract(year from coalesce(p.last_date, d.date))::integer,
       d.bookamat_booking_id,
       coalesce(p.received, 0),
       case when d.type = 'credit_note' then 'refund' else 'income' end,
       coalesce(p.last_date, d.date)
from documents d
left join lateral (
  select max(date) as last_date, sum(amount) filter (where kind = 'payment') as received
  from payments where document_id = d.id
) p on true
where d.bookamat_booking_id is not null
  and not exists (select 1 from bookamat_bookings b where b.document_id = d.id);

-- ─── Documents ───────────────────────────────────────────────────────────────
alter table documents add column if not exists bookamat_error text;
alter table documents add column if not exists bookamat_claimed_at timestamptz;

-- ─── Settings ────────────────────────────────────────────────────────────────
alter table settings add column if not exists bookamat_auto_sync boolean not null default false;
alter table settings add column if not exists bookamat_accounts_year integer;
alter table settings add column if not exists bookamat_last_error text;
alter table settings add column if not exists bookamat_last_error_at timestamptz;
alter table settings add column if not exists google_last_error text;
alter table settings add column if not exists google_last_error_at timestamptz;
