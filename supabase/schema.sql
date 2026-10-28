-- Mado Invoice — consolidated Supabase schema.
--
-- This file is a SNAPSHOT: applied to an EMPTY Supabase project it yields the schema the
-- application expects today — every column in src/types/index.ts, every RPC the app calls,
-- RLS pinned to app_users, and the 'logos' storage bucket the settings page uploads to.
--
-- The files under supabase/migrations/ (plus supabase/add_reminders.sql and
-- BOOKAMAT_MIGRATION.sql) are HISTORY: they record how an existing database reached this
-- state and are never edited. Do not run this file against a database that already has
-- tables; run supabase/migrations/20261020_schema_alignment.sql and the later migrations
-- there instead.
--
-- Run in the Supabase SQL editor (the storage policies need the postgres role).

create extension if not exists "uuid-ossp";

-- ─── Settings (single row) ───────────────────────────────────────────────────
create table settings (
  id                          uuid primary key default uuid_generate_v4(),
  created_at                  timestamptz not null default now(),
  company_name                text not null default '',
  owner_name                  text not null default '',
  address_line1               text not null default '',
  address_line2               text,
  zip                         text not null default '',
  city                        text not null default '',
  country                     text not null default 'Austria',
  email                       text not null default '',
  phone                       text,
  website                     text,
  uid_number                  text not null default '',
  iban                        text not null default '',
  bic                         text not null default '',
  bank_name                   text,
  invoice_prefix              text not null default 'R',
  quote_prefix                text not null default 'A',
  credit_note_prefix          text not null default 'G',
  next_invoice_number         integer not null default 1,
  next_quote_number           integer not null default 1,
  next_credit_note_number     integer not null default 1,
  invoice_number_format       text not null default '{prefix}-{YYYY}-{NNN}',
  quote_number_format         text not null default '{prefix}-{YYYY}-{NNN}',
  credit_note_number_format   text not null default '{prefix}-{YYYY}-{NNN}',
  default_payment_days        integer not null default 14,
  default_language            text not null default 'de',
  default_vat_rate            integer not null default 20 check (default_vat_rate in (0,10,13,20)),
  default_unit                text not null default 'flat' check (default_unit in ('hour','day','session','flat','piece','month')),
  default_tax_treatment       text not null default 'at_vat' check (default_tax_treatment in ('at_vat','eu_reverse_charge','non_eu')),
  default_quote_validity_days integer not null default 14 check (default_quote_validity_days between 0 and 365),
  logo_url                    text,
  invoice_footer_de           text,
  invoice_footer_en           text,
  quote_footer_de             text,
  quote_footer_en             text,
  credit_note_footer_de       text,
  credit_note_footer_en       text,
  tax_note_reverse_charge_de  text,
  tax_note_reverse_charge_en  text,
  tax_note_non_eu_de          text,
  tax_note_non_eu_en          text,
  gmail_email                 text,
  gmail_access_token          text,
  gmail_refresh_token         text,
  gmail_token_expiry          bigint,
  drive_folder_id             text,
  drive_folder_name           text,
  bookamat_username           text,
  bookamat_api_key            text,
  bookamat_country            text default 'at',
  bookamat_bank_account_id    integer,
  -- Bookamat cash account (Kassa) for payments received in cash.
  bookamat_cash_account_id    integer,
  bookamat_cost_account_id    integer,
  -- Purchase-tax accounts: domestic 0 % lines, EU reverse charge (IG Leistungen), non-EU (Drittland).
  bookamat_vat_account_0      integer,
  bookamat_vat_account_rc     integer,
  bookamat_vat_account_non_eu integer,
  bookamat_vat_account_10     integer,
  bookamat_vat_account_13     integer,
  bookamat_vat_account_20     integer,
  email_subject_invoice_de    text,
  email_body_invoice_de       text,
  email_subject_invoice_en    text,
  email_body_invoice_en       text,
  email_subject_quote_de      text,
  email_body_quote_de         text,
  email_subject_quote_en      text,
  email_body_quote_en         text,
  email_subject_credit_note_de text,
  email_body_credit_note_de   text,
  email_subject_credit_note_en text,
  email_body_credit_note_en   text,
  email_subject_reminder_de   text,
  email_body_reminder_de      text,
  email_subject_reminder_en   text,
  email_body_reminder_en      text,
  -- Dunning: automatic reminders start reminder_grace_days after the due date and escalate
  -- every reminder_interval_days up to reminder_max_level. Mahnspesen apply from level 2,
  -- Verzugszinsen are % p.a. on the open balance.
  reminders_enabled           boolean not null default true,
  reminder_grace_days         integer not null default 7,
  reminder_interval_days      integer not null default 14,
  reminder_max_level          integer not null default 3,
  reminder_fee                numeric not null default 0,
  reminder_interest_rate      numeric not null default 0,
  -- Skonto pre-filled on new invoices.
  default_skonto_percent      numeric,
  default_skonto_days         integer,
  -- Language of the app interface; documents keep their own language.
  ui_language                 text not null default 'en' check (ui_language in ('de','en'))
);

-- The app and next_document_number read "the" settings row; it must exist.
insert into settings (id) values (uuid_generate_v4());

-- ─── Clients ─────────────────────────────────────────────────────────────────
create table clients (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),
  name          text not null,
  company       text,
  address_line1 text not null default '',
  address_line2 text,
  zip           text not null default '',
  city          text not null default '',
  country       text not null default '',
  email         text not null default '',
  phone         text,
  uid_number    text,
  tax_treatment text not null default 'at_vat' check (tax_treatment in ('at_vat','eu_reverse_charge','non_eu')),
  language      text not null default 'de' check (language in ('de','en')),
  currency      text not null default 'EUR' check (currency in ('EUR','USD','GBP')),
  payment_days  integer not null default 14,
  status        text not null default 'active' check (status in ('active','inactive','lead')),
  tags          text[] not null default '{}',
  notes         text,
  -- Excluded from the automatic reminder cron; manual reminders still work.
  reminders_opt_out boolean not null default false
);

-- ─── Service catalogue ───────────────────────────────────────────────────────
create table catalogue_items (
  id            uuid primary key default uuid_generate_v4(),
  name_de       text not null,
  name_en       text not null,
  default_price numeric(10,2) not null default 0,
  unit          text not null default 'day'
                constraint catalogue_items_unit_check
                check (unit in ('hour','day','session','flat','piece','month')),
  vat_rate      integer not null default 20 check (vat_rate in (0,10,13,20)),
  category      text,
  sort_order    integer not null default 0,
  active        boolean not null default true
);

insert into catalogue_items (name_de, name_en, default_price, unit, vat_rate, category, sort_order) values
  ('Studio 1 Miete',           'Studio 1 Rental',          0, 'day',   20, 'Studio',      10),
  ('Studio Control Miete',     'Studio Control Rental',     0, 'day',   20, 'Studio',      20),
  ('Recording Session',        'Recording Session',         0, 'hour',  20, 'Recording',   30),
  ('Recording Day',            'Recording Day',             0, 'day',   20, 'Recording',   40),
  ('Mobile Recording',         'Mobile Recording',          0, 'flat',  20, 'Recording',   50),
  ('Mixing',                   'Mixing',                    0, 'flat',  20, 'Production',  60),
  ('Mastering',                'Mastering',                 0, 'flat',  20, 'Production',  70),
  ('Mikrofon Miete',           'Microphone Rental',         0, 'day',   20, 'Equipment',   80);

-- ─── Documents ───────────────────────────────────────────────────────────────
create table documents (
  id                  uuid primary key default uuid_generate_v4(),
  created_at          timestamptz not null default now(),
  type                text not null check (type in ('invoice','quote','credit_note')),
  -- Drafts have no number; issue_document assigns one. NULLs never collide in a unique constraint.
  number              text unique,
  client_id           uuid not null references clients(id) on delete restrict,
  date                date not null default current_date,
  service_date        date,
  service_date_end    date,
  due_date            date,
  status              text not null default 'draft' check (status in ('draft','sent','paid','overdue','accepted','rejected','cancelled')),
  language            text not null default 'de' check (language in ('de','en')),
  currency            text not null default 'EUR',
  tax_treatment       text not null default 'at_vat',
  exchange_rate       numeric(10,6) not null default 1,
  discount_type       text check (discount_type in ('percent','fixed')),
  discount_value      numeric,
  notes               text,
  notes_internal      text,
  -- Generic provenance (quote → invoice, invoice → credit note, template → recurring invoice).
  -- SET NULL so a deleted draft template keeps the invoices generated from it.
  converted_from_id   uuid references documents(id) on delete set null,
  -- Schedule that generated this invoice (FK added after recurring_schedules below).
  recurring_schedule_id uuid,
  -- Set only on a Storno credit note, so a plain credit note is never labelled as one.
  cancels_document_id uuid references documents(id),
  bookamat_booking_id text,
  reminder_sent_at    timestamptz,
  -- Highest dunning level sent so far (1 = Zahlungserinnerung, 2 = 1. Mahnung, 3 = 2. Mahnung).
  reminder_level      integer not null default 0,
  -- Early-payment discount: skonto_percent off the gross total if paid within skonto_days of the date.
  skonto_percent      numeric,
  skonto_days         integer,
  share_token         uuid unique,
  drive_file_id       text
);

create index on documents(client_id);
create index on documents(type, status);
create index on documents(date);

-- ─── Document items ──────────────────────────────────────────────────────────
create table document_items (
  id                uuid primary key default uuid_generate_v4(),
  document_id       uuid not null references documents(id) on delete cascade,
  sort_order        integer not null default 0,
  line_type         text not null default 'item'
                    constraint document_items_line_type_check
                    check (line_type in ('item','heading','text','separator','subtotal','page_break')),
  description       text not null,
  service_date      date,
  -- Null on every line that is not an 'item' (heading, text, separator, subtotal, page_break).
  quantity          numeric(10,4) default 1,
  unit              text default 'flat',
  unit_price        numeric(10,2) default 0,
  vat_rate          integer default 20,
  catalogue_item_id uuid references catalogue_items(id),
  -- Only 'subtotal' lines carry a section discount.
  discount_type     text check (discount_type in ('percent','fixed')),
  discount_value    numeric
);

create index on document_items(document_id);

-- ─── Payments ────────────────────────────────────────────────────────────────
create table payments (
  id          uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  date        date not null default current_date,
  amount      numeric(10,2) not null,
  note        text,
  -- 'payment' is money that arrived (the only kind the UVA and revenue figures count);
  -- 'skonto' and 'writeoff' close the remaining balance without a bank transfer.
  kind        text not null default 'payment' check (kind in ('payment','skonto','writeoff')),
  -- How the money arrived; cash payments book on the Bookamat cash account.
  method      text not null default 'bank' check (method in ('bank','cash')),
  -- Statement transaction an imported payment came from; unique so a re-import skips it.
  import_ref  text
);

create index on payments(document_id);
create unique index payments_import_ref_key on payments(import_ref) where import_ref is not null;

-- ─── Reminder log ────────────────────────────────────────────────────────────
-- One row per reminder email that went out: the invoice page shows this history.
create table reminder_log (
  id          uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  level       integer not null,
  sent_at     timestamptz not null default now(),
  to_email    text,
  subject     text
);

create index on reminder_log(document_id);

-- ─── Recurring schedules ─────────────────────────────────────────────────────
-- A schedule points at a template invoice; every run copies it into a new invoice for the
-- next period. The template content is the invoice itself, the schedule only holds timing.
create table recurring_schedules (
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
  add constraint documents_recurring_schedule_id_fkey
  foreign key (recurring_schedule_id) references recurring_schedules(id) on delete set null;

-- A period can never be generated twice, even if two runs overlap.
create unique index documents_recurring_period_key
  on documents(recurring_schedule_id, date)
  where recurring_schedule_id is not null;

-- ─── Numbering ───────────────────────────────────────────────────────────────
-- Longer counter tokens are replaced first so {N} cannot eat part of {NNN}.
create or replace function format_document_number(fmt text, prefix text, num integer, d date)
returns text language sql immutable as $$
  select replace(replace(replace(replace(replace(replace(replace(replace(
    fmt,
    '{prefix}', coalesce(prefix, '')),
    '{YYYY}',   to_char(d, 'YYYY')),
    '{YY}',     to_char(d, 'YY')),
    '{MM}',     to_char(d, 'MM')),
    '{NNNN}',   lpad(num::text, 4, '0')),
    '{NNN}',    lpad(num::text, 3, '0')),
    '{NN}',     lpad(num::text, 2, '0')),
    '{N}',      num::text)
$$;

-- Locks the settings row so two concurrent calls can never hand out the same number.
create or replace function next_document_number(doc_type text)
returns text language plpgsql as $$
declare
  s   settings%rowtype;
  num integer;
begin
  select * into s from settings limit 1 for update;
  if s.id is null then raise exception 'settings row missing'; end if;
  if doc_type = 'invoice' then
    num := s.next_invoice_number;
    update settings set next_invoice_number = next_invoice_number + 1 where id = s.id;
    return format_document_number(s.invoice_number_format, s.invoice_prefix, num, current_date);
  elsif doc_type = 'quote' then
    num := s.next_quote_number;
    update settings set next_quote_number = next_quote_number + 1 where id = s.id;
    return format_document_number(s.quote_number_format, s.quote_prefix, num, current_date);
  else
    num := s.next_credit_note_number;
    update settings set next_credit_note_number = next_credit_note_number + 1 where id = s.id;
    return format_document_number(s.credit_note_number_format, s.credit_note_prefix, num, current_date);
  end if;
end;
$$;

-- Issues a document in one transaction: assigns the next number for its own type (year/month
-- tokens come from the document date). A failure anywhere rolls the counter back, so no number
-- is ever burned. Idempotent for already numbered documents. Issuing keeps an already reached
-- status (e.g. a deposit recorded before issuing left the invoice 'paid'); only drafts move to
-- 'sent'. Cancelled documents cannot be issued.
create or replace function issue_document(p_document_id uuid)
returns text language plpgsql as $$
declare
  d      documents%rowtype;
  s      settings%rowtype;
  num    integer;
  result text;
begin
  select * into d from documents where id = p_document_id for update;
  if d.id is null then raise exception 'document % not found', p_document_id; end if;
  if d.status = 'cancelled' then raise exception 'cancelled documents cannot be issued'; end if;
  if d.number is not null then
    if d.status = 'draft' then update documents set status = 'sent' where id = d.id; end if;
    return d.number;
  end if;

  select * into s from settings limit 1 for update;
  if s.id is null then raise exception 'settings row missing'; end if;

  if d.type = 'invoice' then
    num := s.next_invoice_number;
    update settings set next_invoice_number = next_invoice_number + 1 where id = s.id;
    result := format_document_number(s.invoice_number_format, s.invoice_prefix, num, coalesce(d.date, current_date));
  elsif d.type = 'quote' then
    num := s.next_quote_number;
    update settings set next_quote_number = next_quote_number + 1 where id = s.id;
    result := format_document_number(s.quote_number_format, s.quote_prefix, num, coalesce(d.date, current_date));
  else
    num := s.next_credit_note_number;
    update settings set next_credit_note_number = next_credit_note_number + 1 where id = s.id;
    result := format_document_number(s.credit_note_number_format, s.credit_note_prefix, num, coalesce(d.date, current_date));
  end if;

  update documents
  set number = result,
      status = case when status = 'draft' then 'sent' else status end
  where id = d.id;
  return result;
end;
$$;

-- Replaces a document's line items atomically (delete + insert in one transaction), so a
-- failed or interrupted save can no longer leave the document without items.
create or replace function replace_document_items(p_document_id uuid, p_items jsonb)
returns void language plpgsql as $$
begin
  delete from document_items where document_id = p_document_id;
  insert into document_items (
    document_id, sort_order, line_type, description, service_date,
    quantity, unit, unit_price, vat_rate, catalogue_item_id, discount_type, discount_value
  )
  select
    p_document_id, x.sort_order, x.line_type, x.description, x.service_date,
    x.quantity, x.unit, x.unit_price, x.vat_rate, x.catalogue_item_id, x.discount_type, x.discount_value
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
    sort_order        integer,
    line_type         text,
    description       text,
    service_date      date,
    quantity          numeric,
    unit              text,
    unit_price        numeric,
    vat_rate          integer,
    catalogue_item_id uuid,
    discount_type     text,
    discount_value    numeric
  )
  order by x.sort_order;
end;
$$;

-- ─── Row Level Security ──────────────────────────────────────────────────────
-- Only users listed in app_users may touch data. Any user can sign up against
-- the Supabase project, so auth.role() = 'authenticated' alone is not enough.
create table app_users (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table app_users enable row level security;
create policy "own row" on app_users for select to authenticated using (user_id = auth.uid());

-- Re-run this line after creating the owner account in Supabase Auth.
insert into app_users(user_id) select id from auth.users on conflict do nothing;

create or replace function is_app_user()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from app_users where user_id = auth.uid())
$$;

revoke execute on function is_app_user() from public, anon;
grant execute on function is_app_user() to authenticated;

alter table settings        enable row level security;
alter table clients         enable row level security;
alter table catalogue_items enable row level security;
alter table documents       enable row level security;
alter table document_items  enable row level security;
alter table payments        enable row level security;
alter table reminder_log    enable row level security;
alter table recurring_schedules enable row level security;

create policy "owner" on settings        for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on clients         for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on catalogue_items for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on documents       for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on document_items  for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on payments        for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on reminder_log    for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on recurring_schedules for all to authenticated using (is_app_user()) with check (is_app_user());

-- ─── Storage: company logo ───────────────────────────────────────────────────
-- SettingsForm uploads logo.<ext> to the public 'logos' bucket with upsert (insert + update)
-- and stores the public URL in settings.logo_url. The bucket is public so the PDF renderer
-- and the client portal can fetch the logo without a session.
insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

drop policy if exists "logos public read"  on storage.objects;
drop policy if exists "logos owner insert" on storage.objects;
drop policy if exists "logos owner update" on storage.objects;
drop policy if exists "logos owner delete" on storage.objects;

create policy "logos public read" on storage.objects
  for select to public
  using (bucket_id = 'logos');

create policy "logos owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'logos' and is_app_user());

create policy "logos owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'logos' and is_app_user())
  with check (bucket_id = 'logos' and is_app_user());

create policy "logos owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'logos' and is_app_user());
