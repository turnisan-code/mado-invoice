-- Mado books expenses (PR 9a „Mado bucht Ausgaben“, item 9 of Bookmatic's audit): the bank
-- statement's lines, the Buchungsregeln, and the Bookamat ledger for bookings that belong to a
-- statement line instead of a document.
--  - settings.own_ibans: the owner's other business accounts. A transfer to or from one is no
--    Privatentnahme/Privateinlage (src/lib/expenses/own-transfer.ts); the IBAN on his invoices
--    (settings.iban) and the statement's own account count anyway.
--  - settings.expenses_from: the switch-over (decision D2). Mado books statement lines from this
--    bank date on; before it, and while it is not set, Bookmatic books them.
--  - bank_lines: one row per line of an imported statement, keyed by the parser's id of the
--    raw line (the id payments.import_ref carries for an invoice payment). `cells` holds the
--    bank's cells as written; everything the engine reads is rebuilt from them. `review` is
--    the owner's state of the line (the rule chosen, the fields set, split lines, the bookings
--    said not to be this payment), saved as it changes. A line is open, skipped or booked;
--    `bookamat_claim` and `bookamat_pending` are a booking attempt's claim and journal (as on
--    documents).
--  - bookamat_bookings: a booking belongs to a document or to a statement line (exactly one);
--    kind 'expense' (a debit) or 'bank_income' (a credit that pays no Mado invoice). One
--    booking per line.
--  - bank_lines_booking_guard: a booked line keeps its cells, its amount and its status, and
--    is not removed (MI050, the booking id in the detail); nor while a booking attempt of it
--    is not settled (MI051).
--  - booking_rules: the Buchungsregeln. Accounts are stored by their Bookamat title and looked
--    up in each year's accounts (decision D7), so nothing is picked again in January.
--  - Bucket 'receipts': the Belege uploaded for a line (private, like 'documents').
-- Error codes: MI050 = the line is booked in Bookamat, MI051 = a booking attempt of the line
-- is not settled.
-- Idempotent — safe to re-run.

-- ─── The owner's business accounts ───────────────────────────────────────────
alter table settings add column if not exists own_ibans text[] not null default '{}';
alter table settings add column if not exists expenses_from date;

-- ─── Statement lines ─────────────────────────────────────────────────────────
create table if not exists bank_lines (
  id                uuid primary key default uuid_generate_v4(),
  line_key          text not null unique,
  cells             text[] not null,
  statement_iban    text not null default '',
  booked_on         date not null,
  value_on          date,
  amount            numeric(12,2) not null check (amount <> 0),
  currency          text not null default 'EUR',
  counterparty      text not null default '',
  bank_text         text not null default '',
  fee               numeric(12,2),
  status            text not null default 'open' check (status in ('open','skipped','booked')),
  review            jsonb not null default '{}'::jsonb,
  receipt_path      text,
  receipt_name      text,
  bookamat_claim    timestamptz,
  bookamat_pending  jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists bank_lines_open_idx on bank_lines(booked_on) where status = 'open';

alter table bank_lines enable row level security;
drop policy if exists "owner" on bank_lines;
create policy "owner" on bank_lines for all to authenticated using (is_app_user()) with check (is_app_user());

-- ─── The ledger: a booking of a document or of a statement line ──────────────
alter table bookamat_bookings alter column document_id drop not null;
alter table bookamat_bookings add column if not exists bank_line_id uuid references bank_lines(id);
alter table bookamat_bookings drop constraint if exists bookamat_bookings_kind_check;
alter table bookamat_bookings add constraint bookamat_bookings_kind_check
  check (kind in ('income','refund','expense','bank_income'));
alter table bookamat_bookings drop constraint if exists bookamat_bookings_source_check;
alter table bookamat_bookings add constraint bookamat_bookings_source_check
  check ((document_id is null) <> (bank_line_id is null)
     and (bank_line_id is null or (kind in ('expense','bank_income') and payment_id is null))
     and (document_id is null or kind in ('income','refund')));

drop index if exists bookamat_bookings_legacy_key;
create unique index bookamat_bookings_legacy_key
  on bookamat_bookings(document_id, year, kind) where payment_id is null and document_id is not null;
create unique index if not exists bookamat_bookings_bank_line_key
  on bookamat_bookings(bank_line_id) where bank_line_id is not null;

-- ─── A booked line stays as it was booked ────────────────────────────────────
create or replace function bank_lines_booking_guard()
returns trigger language plpgsql as $$
declare
  booked text;
  reshaped boolean := false;
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    reshaped := new.cells is distinct from old.cells
             or new.amount is distinct from old.amount
             or new.booked_on is distinct from old.booked_on;
    -- A booking attempt in flight: the line keeps its cells and its status until the attempt
    -- is settled (the booking sets the status and clears its journal in one update)
    if old.bookamat_pending is not null and new.bookamat_pending is not null
       and (reshaped or new.status is distinct from old.status) then
      raise exception using errcode = 'MI051',
        message = 'A Bookamat booking of this statement line is not settled yet. Book it again, or check Bookamat and discard the open attempt first.';
    end if;
    -- Its review, its Beleg and open ↔ skipped stay editable; only what makes it another line,
    -- or un-books it, is checked against the ledger
    if not reshaped and not (old.status = 'booked' and new.status is distinct from old.status) then
      return new;
    end if;
  elsif old.bookamat_pending is not null then
    raise exception using errcode = 'MI051',
      message = 'A Bookamat booking of this statement line is not settled yet. Book it again, or check Bookamat and discard the open attempt first.';
  end if;
  select b.booking_id into booked from bookamat_bookings b where b.bank_line_id = old.id limit 1;
  if booked is not null then
    raise exception using errcode = 'MI050', detail = booked,
      message = format('This statement line is booked in Bookamat (#%s). Delete the booking there and use "Buchung vergessen" first.', booked);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists bank_lines_booking_guard on bank_lines;
create trigger bank_lines_booking_guard
  before update or delete on bank_lines
  for each row execute function bank_lines_booking_guard();

-- ─── Buchungsregeln ──────────────────────────────────────────────────────────
create table if not exists booking_rules (
  id                    uuid primary key default uuid_generate_v4(),
  name                  text not null check (btrim(name) <> ''),
  active                boolean not null default true,
  category              text not null default '',
  match_strings         text[] not null default '{}',
  email_sender          text not null default '',
  email_body_keywords   text[] not null default '{}',
  cost_account          text not null default '',
  tax_account           text not null default '',
  bank_account          text not null default '',
  tax_percent           numeric(5,2) not null default 20 check (tax_percent >= 0 and tax_percent <= 100),
  ba_amount             numeric(5,2) not null default 100 check (ba_amount >= 0 and ba_amount <= 100),
  ba_tax                numeric(5,2) not null default 100 check (ba_tax >= 0 and ba_tax <= 100),
  country               text not null default '',
  vatin                 text not null default '',
  title_template        text not null default '',
  notes_template        text not null default '',
  amount_min            numeric(12,2),
  amount_max            numeric(12,2),
  invoice_address_match text not null default '',
  skip_receipt          boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (amount_min is null or amount_max is null or amount_min <= amount_max)
);

alter table booking_rules enable row level security;
drop policy if exists "owner" on booking_rules;
create policy "owner" on booking_rules for all to authenticated using (is_app_user()) with check (is_app_user());

-- ─── Storage: Belege of statement lines ──────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "receipts owner select" on storage.objects;
drop policy if exists "receipts owner insert" on storage.objects;
drop policy if exists "receipts owner update" on storage.objects;
drop policy if exists "receipts owner delete" on storage.objects;

create policy "receipts owner select" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and is_app_user());

create policy "receipts owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and is_app_user());

create policy "receipts owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'receipts' and is_app_user())
  with check (bucket_id = 'receipts' and is_app_user());

create policy "receipts owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and is_app_user());
