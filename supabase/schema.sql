-- Mado Invoice — consolidated Supabase schema.
--
-- This file is a SNAPSHOT: applied to an EMPTY Supabase project it yields the schema the
-- application expects today — every column in src/types/index.ts, every RPC the app calls,
-- RLS pinned to app_users, the 'logos' storage bucket the settings page uploads to and the
-- private 'documents' bucket that holds the PDF stored for every issued document.
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
  -- Name the account is held in (EPC QR beneficiary, PDF payment block); empty = company_name.
  bank_account_holder         text,
  invoice_prefix              text not null default 'R',
  quote_prefix                text not null default 'A',
  credit_note_prefix          text not null default 'G',
  next_invoice_number         integer not null default 1,
  next_quote_number           integer not null default 1,
  next_credit_note_number     integer not null default 1,
  -- Next client number (K-0001); the clients trigger takes it.
  next_client_number          integer not null default 1,
  invoice_number_format       text not null default '{prefix}-{YYYY}-{NNN}',
  quote_number_format         text not null default '{prefix}-{YYYY}-{NNN}',
  credit_note_number_format   text not null default '{prefix}-{YYYY}-{NNN}',
  -- Year each counter belongs to; with *_number_reset_yearly on and a {YYYY}/{YY} format,
  -- the first document of a later year restarts the counter at 1.
  invoice_counter_year            integer,
  quote_counter_year              integer,
  credit_note_counter_year        integer,
  invoice_number_reset_yearly     boolean not null default false,
  quote_number_reset_yearly       boolean not null default false,
  credit_note_number_reset_yearly boolean not null default false,
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
  -- When Google was connected and which scopes the grant includes (Drive is optional).
  gmail_connected_at          timestamptz,
  gmail_scopes                text,
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
  -- Bookamat fiscal year the account ids above were chosen in (ids differ per year).
  bookamat_accounts_year      integer,
  -- Sync paid invoices and refunds to Bookamat in the daily cron.
  bookamat_auto_sync          boolean not null default false,
  -- Last failure talking to Bookamat / Google, shown in Settings until a test or sync succeeds.
  bookamat_last_error         text,
  bookamat_last_error_at      timestamptz,
  google_last_error           text,
  google_last_error_at        timestamptz,
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
  ui_language                 text not null default 'en' check (ui_language in ('de','en')),
  -- The studio's Peppol address for e-invoices; empty = 9914 (Austrian VAT number) with uid_number.
  peppol_scheme               text constraint settings_peppol_scheme_check check (peppol_scheme is null or peppol_scheme ~ '^[0-9]{4}$'),
  peppol_id                   text,
  -- Claude connector (20261105_mcp.sql): per action kind 'app' (approve in Mado, also for a kind
  -- not listed) or 'chat' (Claude's own prompt), and whether approving in Mado asks for a current
  -- authenticator code. A Claude session can change neither, nor insert or delete this row
  -- (settings_mcp_guard, MI040).
  mcp_confirm_policy          jsonb not null default '{}' constraint settings_mcp_confirm_policy_check check (
                                jsonb_typeof(mcp_confirm_policy) = 'object'
                                and not jsonb_path_exists(mcp_confirm_policy, '$.* ? (@.type() != "string" || (@ != "app" && @ != "chat"))')),
  mcp_approval_totp           boolean not null default true
);

-- The app and next_document_number read "the" settings row; it must exist, and only once.
insert into settings (id) values (uuid_generate_v4());
create unique index settings_singleton on settings ((true));

-- ─── Clients ─────────────────────────────────────────────────────────────────
create table clients (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),
  -- K-0001, assigned by the clients_assign_number trigger.
  client_number text unique,
  name          text not null,
  company       text,
  address_line1 text not null default '',
  address_line2 text,
  zip           text not null default '',
  city          text not null default '',
  -- ISO 3166-1 alpha-2 code; free text only on rows the code migration could not map.
  country       text not null default '',
  email         text not null default '',
  phone         text,
  uid_number    text,
  tax_treatment text not null default 'at_vat' check (tax_treatment in ('at_vat','eu_reverse_charge','non_eu')),
  language      text not null default 'de' check (language in ('de','en')),
  currency      text not null default 'EUR' constraint clients_currency_check check (currency = 'EUR'),
  -- NULL = settings.default_payment_days.
  payment_days  integer constraint clients_payment_days_check check (payment_days is null or payment_days between 0 and 365),
  -- Skonto prefilled on the client's new invoices; NULL = the settings default, 0 % = none.
  skonto_percent numeric constraint clients_skonto_percent_check check (skonto_percent is null or skonto_percent between 0 and 100),
  skonto_days    integer constraint clients_skonto_days_check check (skonto_days is null or skonto_days between 0 and 365),
  status        text not null default 'active' check (status in ('active','inactive','lead')),
  tags          text[] not null default '{}',
  notes         text,
  -- Excluded from the automatic reminder cron; manual reminders still work.
  reminders_opt_out boolean not null default false,
  -- Further recipients (e.g. an accounting mailbox), copied in CC on every email to the client.
  cc_emails     text[] not null default '{}',
  -- E-invoicing: preferred format, the client's Peppol address (empty = derived from its UID),
  -- the buyer reference prefilled on its e-invoices and the supplier number it assigned to the studio.
  einvoice_format text constraint clients_einvoice_format_check check (einvoice_format is null or einvoice_format in ('ebinterface','ubl')),
  peppol_scheme   text constraint clients_peppol_scheme_check check (peppol_scheme is null or peppol_scheme ~ '^[0-9]{4}$'),
  peppol_id       text,
  buyer_reference text,
  supplier_number text,
  -- Claude connector (20261105_mcp_drafts.sql): the addresses a Claude session put on email or
  -- cc_emails, until the owner saves the client in Mado; an email to one of them is approved in
  -- Mado (clients_mcp_recipients, mcp_actions_recipients).
  mcp_recipients  text[] not null default '{}',
  -- When a Claude session last created or changed the client, until the owner saves it in Mado;
  -- meanwhile the reminder cron and its Bookamat step skip its documents, a recurring schedule that
  -- issues automatically creates drafts for it (src/lib/utils/recurring.ts), no archive copy is
  -- made from it (src/lib/pdf/snapshot.ts) and the portal leaves its recipient block out.
  mcp_written_at  timestamptz
);

create or replace function format_client_number(n integer)
returns text language sql immutable as $$
  select 'K-' || lpad(n::text, greatest(4, length(n::text)), '0')
$$;

-- Every insert path gets the next number; a number typed in by hand is kept.
create or replace function assign_client_number()
returns trigger language plpgsql as $$
declare
  s settings%rowtype;
  n integer;
begin
  if nullif(btrim(new.client_number), '') is not null then return new; end if;
  select * into s from settings limit 1 for update;
  if s.id is null then raise exception 'settings row missing'; end if;
  n := s.next_client_number;
  while exists (select 1 from clients where client_number = format_client_number(n)) loop
    n := n + 1;
  end loop;
  new.client_number := format_client_number(n);
  update settings set next_client_number = n + 1 where id = s.id;
  return new;
end;
$$;

create trigger clients_assign_number
  before insert on clients
  for each row execute function assign_client_number();

-- ─── Service catalogue ───────────────────────────────────────────────────────
create table catalogue_items (
  id            uuid primary key default uuid_generate_v4(),
  name_de       text not null,
  name_en       text not null,
  -- Longer text prefilled under the name when the item is picked.
  description_de text,
  description_en text,
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

-- A client's own price for a catalogue item (rate card); picking the item for that client uses it.
create table client_rates (
  id                uuid primary key default uuid_generate_v4(),
  created_at        timestamptz not null default now(),
  client_id         uuid not null references clients(id) on delete cascade,
  catalogue_item_id uuid not null references catalogue_items(id) on delete cascade,
  price             numeric(10,2) not null,
  note              text
);

create unique index client_rates_client_item_key on client_rates(client_id, catalogue_item_id);
create index client_rates_catalogue_item_idx on client_rates(catalogue_item_id);

-- Writes only sort_order, in one statement, in the order of p_ids.
create or replace function reorder_catalogue_items(p_ids uuid[])
returns void language sql as $$
  update catalogue_items c
  set sort_order = (x.ord::integer - 1) * 10
  from unnest(p_ids) with ordinality as x(id, ord)
  where c.id = x.id
$$;

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
  -- Set once by issue_document when the number is assigned.
  issued_at           timestamptz,
  -- Key of the frozen PDF in the private 'documents' bucket, stored at issuance and never replaced.
  pdf_path            text,
  -- First successful Gmail send (never overwritten by later re-sends); document_events has every send.
  sent_at             timestamptz,
  -- When the client accepted or declined a quote in the portal.
  responded_at        timestamptz,
  -- Generic provenance (quote → invoice, invoice → credit note, template → recurring invoice).
  -- SET NULL so a deleted draft template keeps the invoices generated from it.
  converted_from_id   uuid references documents(id) on delete set null,
  -- Schedule that generated this invoice (FK added after recurring_schedules below).
  recurring_schedule_id uuid,
  -- Set only on a Storno credit note, so a plain credit note is never labelled as one.
  cancels_document_id uuid references documents(id),
  -- Legacy single booking id (before bookamat_bookings); read only.
  bookamat_booking_id text,
  -- Last Bookamat sync failure (null when the last sync worked) and the claim a running sync holds.
  bookamat_error      text,
  bookamat_claimed_at timestamptz,
  -- Bookings a sync is posting, or posted but could not record: the next sync settles them first.
  bookamat_pending    jsonb,
  reminder_sent_at    timestamptz,
  -- Highest dunning level sent so far (1 = Zahlungserinnerung, 2 = 1. Mahnung, 3 = 2. Mahnung).
  reminder_level      integer not null default 0,
  -- Early-payment discount: skonto_percent off the gross total if paid within skonto_days of the date.
  skonto_percent      numeric,
  skonto_days         integer,
  share_token         uuid unique,
  -- The share link stops working after this (NULL = never); new links get 90 days.
  share_expires_at    timestamptz,
  -- First time the client opened the current share link (cleared on rotate/revoke; the owner's
  -- own visits are not counted).
  portal_viewed_at    timestamptz,
  drive_file_id       text,
  -- The buyer's reference (Auftragsreferenz / order number) the document's PDF and e-invoices carry.
  buyer_reference     text,
  -- The total (after discounts, before payments) the document was issued with; written with the
  -- frozen PDF by issueDocument, so a later edit that changes the amount can be flagged.
  issued_total        numeric(12,2),
  -- Invoices: 'advance' asks for money before the service, 'partial' bills a completed part of
  -- it, 'final' bills the whole service and deducts them (§ 11 Abs 1 UStG). Everything else 'standard'.
  invoice_kind        text not null default 'standard',
  -- On an advance or partial invoice: the final invoice that deducts it (at most one). Deleting a
  -- draft final invoice frees it, so does a Storno of the final invoice (documents_deposit_release).
  final_invoice_id    uuid references documents(id) on delete set null,
  -- Claude connector (20261105_mcp_drafts.sql): when a Claude session last recorded, changed or
  -- removed a payment row of the invoice or a refund of the credit note, until the owner confirms
  -- its payments on its page; meanwhile the reminder cron and the automatic Bookamat step skip it
  -- and no archive copy is made of it (payments_mcp_mark, documents_mcp_payments_guard).
  mcp_payments_at     timestamptz,
  constraint documents_invoice_kind_check
    check (invoice_kind in ('standard', 'advance', 'partial', 'final') and (type = 'invoice' or invoice_kind = 'standard')),
  constraint documents_final_invoice_check
    check (final_invoice_id is null or invoice_kind in ('advance', 'partial'))
);

create index on documents(client_id);
create index on documents(type, status);
create index on documents(date);
create index documents_final_invoice_id_idx on documents(final_invoice_id) where final_invoice_id is not null;

-- ─── Document items ──────────────────────────────────────────────────────────
create table document_items (
  id                uuid primary key default uuid_generate_v4(),
  document_id       uuid not null references documents(id) on delete cascade,
  sort_order        integer not null default 0,
  line_type         text not null default 'item'
                    constraint document_items_line_type_check
                    check (line_type in ('item','heading','text','separator','subtotal','page_break','deduction')),
  description       text not null,
  service_date      date,
  -- End of the line's service period; null = a single day (service_date).
  service_date_end  date,
  -- Null on heading, text, separator, subtotal and page_break lines. A 'deduction' line (a final
  -- invoice's deduction of an advance or partial invoice at one VAT rate, src/lib/deposits.ts) is
  -- quantity 1 at a negative price.
  quantity          numeric(10,4) default 1,
  unit              text default 'flat',
  unit_price        numeric(10,2) default 0,
  vat_rate          integer default 20,
  catalogue_item_id uuid references catalogue_items(id),
  -- Item lines: their own discount (lineAmount); subtotal lines: the section's discount.
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
  -- 'skonto' and 'writeoff' close the remaining balance without a bank transfer; 'credit' is an
  -- issued credit note applied to the invoice it corrects; 'refund' is money paid back on a
  -- credit note; 'fee' is dunning fees and default interest paid on top of an invoice (money
  -- received, but neither turnover nor part of the invoice balance).
  kind        text not null default 'payment'
              constraint payments_kind_check check (kind in ('payment','skonto','writeoff','credit','refund','fee')),
  -- How the money arrived; cash payments book on the Bookamat cash account.
  method      text not null default 'bank' check (method in ('bank','cash')),
  -- Statement transaction an imported payment came from; unique so a re-import skips it.
  import_ref  text,
  -- Bank reference (Zahlungsreferenz / Verwendungszweck) the owner noted for the payment.
  reference   text,
  -- The credit note of a 'credit' row. Deliberately no foreign key: a second payments → documents
  -- relationship would make every payments(...) / documents(...) embed ambiguous for PostgREST.
  -- Credit rows exist only for issued credit notes, which documents_delete_guard keeps forever.
  credit_note_id uuid,
  constraint payments_credit_note_check check ((kind = 'credit') = (credit_note_id is not null))
);

create index on payments(document_id);
create unique index payments_import_ref_key on payments(import_ref) where import_ref is not null;
-- A credit note is applied once; a second concurrent apply fails instead of crediting twice.
create unique index payments_credit_note_key on payments(credit_note_id) where kind = 'credit';

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

-- ─── Document events ─────────────────────────────────────────────────────────
-- History per document: issuing, every email and reminder, status changes, payments, Storno,
-- archive copies and Drive uploads. Rows are only ever inserted by the app; read_at is the one
-- column set later (a portal response the owner has seen).
create table document_events (
  id          uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  created_at  timestamptz not null default now(),
  type        text not null check (type in (
                'issued','emailed','mailto_opened','reminder_sent','status_changed',
                'payment_added','payment_removed','storno_created','archived','drive_archived',
                'portal_viewed','portal_responded','bookamat_synced','converted','einvoice_exported',
                'deposit_created','deposit_linked','deposit_released','project_invoiced','project_released')),
  detail      jsonb not null default '{}',
  -- Set when the owner opened the document a 'portal_responded' event belongs to (dashboard notice).
  read_at     timestamptz,
  -- The Claude connection that wrote it ('claude_ai', 'claude_code', 'static'); null for the
  -- browser and the crons. Set by document_events_actor, whatever the insert sends; kept on update.
  actor       text constraint document_events_actor_check check (actor is null or actor in ('claude_ai', 'claude_code', 'static'))
);

create index document_events_document_id_created_at_idx on document_events(document_id, created_at);
create index document_events_unread_responses_idx
  on document_events(created_at) where type = 'portal_responded' and read_at is null;

-- ─── Bookamat bookings ───────────────────────────────────────────────────────
-- One booking per document, calendar year and kind: under Ist-Besteuerung money received in two
-- years is booked in both fiscal years; a refund on a credit note books negative.
create table bookamat_bookings (
  id              uuid primary key default uuid_generate_v4(),
  document_id     uuid not null references documents(id) on delete cascade,
  year            integer not null check (year between 2000 and 2999),
  booking_id      text not null,
  amount          numeric(10,2) not null,
  kind            text not null check (kind in ('income','refund')),
  booked_on       date,
  pdf_attached_at timestamptz,
  created_at      timestamptz not null default now()
);

create unique index bookamat_bookings_document_year_kind_key on bookamat_bookings(document_id, year, kind);

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
-- Longer counter tokens are replaced first so {N} cannot eat part of {NNN}; a counter longer
-- than its token is printed in full instead of being cut (lpad truncates).
create or replace function format_document_number(fmt text, prefix text, num integer, d date)
returns text language sql immutable as $$
  select replace(replace(replace(replace(replace(replace(replace(replace(
    fmt,
    '{prefix}', coalesce(prefix, '')),
    '{YYYY}',   to_char(d, 'YYYY')),
    '{YY}',     to_char(d, 'YY')),
    '{MM}',     to_char(d, 'MM')),
    '{NNNN}',   lpad(num::text, greatest(4, length(num::text)), '0')),
    '{NNN}',    lpad(num::text, greatest(3, length(num::text)), '0')),
    '{NN}',     lpad(num::text, greatest(2, length(num::text)), '0')),
    '{N}',      num::text)
$$;

-- Takes the next number for doc_type, formatted with doc_date (default: today in Vienna).
-- Locks the settings row, so concurrent calls never hand out the same number. With the yearly
-- restart on and a {YYYY}/{YY} format, the first document of a new year starts again at 1.
-- A number that already exists (e.g. after the counter was lowered by hand) is skipped.
-- Error codes: MI002 = the date lies in a numbering year that has already been closed (detail:
-- the open year), MI003 = the format has no counter token. The app maps them to its dictionaries.
create or replace function next_document_number(doc_type text, doc_date date default null)
returns text language plpgsql as $$
declare
  s      settings%rowtype;
  d      date := coalesce(doc_date, (now() at time zone 'Europe/Vienna')::date);
  y      integer := extract(year from d)::integer;
  fmt    text;
  prefix text;
  num    integer;
  cy     integer;
  yearly boolean;
  result text;
  tries  integer := 0;
begin
  select * into s from settings limit 1 for update;
  if s.id is null then raise exception 'settings row missing'; end if;

  if doc_type = 'invoice' then
    fmt := s.invoice_number_format; prefix := s.invoice_prefix; num := s.next_invoice_number;
    cy := s.invoice_counter_year; yearly := s.invoice_number_reset_yearly;
  elsif doc_type = 'quote' then
    fmt := s.quote_number_format; prefix := s.quote_prefix; num := s.next_quote_number;
    cy := s.quote_counter_year; yearly := s.quote_number_reset_yearly;
  elsif doc_type = 'credit_note' then
    fmt := s.credit_note_number_format; prefix := s.credit_note_prefix; num := s.next_credit_note_number;
    cy := s.credit_note_counter_year; yearly := s.credit_note_number_reset_yearly;
  else
    raise exception 'unknown document type %', doc_type;
  end if;

  if fmt !~ '\{N{1,4}\}' then
    raise exception using errcode = 'MI003',
      message = format('The %s number format "%s" has no counter token ({N}, {NN}, {NNN} or {NNNN}). Fix it in Settings → Numbering.', doc_type, fmt);
  end if;

  if yearly and fmt ~ '\{YY(YY)?\}' and cy is not null then
    if y > cy then
      num := 1;
    elsif y < cy then
      raise exception using errcode = 'MI002',
        message = format('Numbering for %s has already started, so a document dated %s can no longer be numbered. Date it in %s or later and put the earlier period in the service date.', cy, d, cy),
        detail = cy::text;
    end if;
  end if;

  loop
    result := format_document_number(fmt, prefix, num, d);
    exit when not exists (select 1 from documents where number = result);
    num := num + 1;
    tries := tries + 1;
    if tries > 100000 then raise exception 'no free document number after %', result; end if;
  end loop;

  if doc_type = 'invoice' then
    update settings set next_invoice_number = num + 1, invoice_counter_year = greatest(coalesce(cy, y), y) where id = s.id;
  elsif doc_type = 'quote' then
    update settings set next_quote_number = num + 1, quote_counter_year = greatest(coalesce(cy, y), y) where id = s.id;
  else
    update settings set next_credit_note_number = num + 1, credit_note_counter_year = greatest(coalesce(cy, y), y) where id = s.id;
  end if;
  return result;
end;
$$;

-- Issues a document in one transaction: assigns the next number for its own type, formatted
-- with the document date. A failure anywhere rolls the counter back, so no number is ever
-- burned. Idempotent for already numbered documents. Issuing keeps an already reached status
-- (e.g. a deposit recorded before issuing left the invoice 'paid'); only drafts move to 'sent'.
-- Cancelled documents cannot be issued. issued_at records when the number was assigned.
-- An invoice issued without a due date gets one from the client's payment terms (settings
-- default as fallback), a quote from the validity period, so every invoice can become overdue.
-- Error code MI001 = the document date is more than one day in the future (Vienna time).
-- Error code MI004 = the document is incomplete; detail lists the problems, comma-separated:
--   settings_incomplete (company name, address, UID or IBAN missing), no_client, no_items,
--   currency_not_eur (invoices and quotes are EUR only; a credit note keeps the currency of the
--   invoice it corrects),
--   and, except on a Storno (it mirrors the invoice it cancels): blank_description,
--   bad_quantity (missing or <= 0), missing_price, period_start_missing,
--   period_end_before_start, bad_discount (a line discount below 0, above 100 % or, as a fixed
--   amount, above the line's quantity × price), for invoices and credit notes
--   reverse_charge_without_uid, client_country_missing (reverse charge / non-EU) and
--   no_service_date (neither the document nor every item line has one), and for invoices and
--   quotes negative_total (money going back is a credit note; computed like calcTotals in
--   src/lib/utils/document.ts: line discounts, then section discounts, then VAT; the document
--   discount never changes the sign).
-- (issued_at belongs to the frozen-copy columns of 20261020_snapshot.sql.)
alter table documents add column if not exists issued_at timestamptz;

create or replace function issue_document(p_document_id uuid)
returns text language plpgsql as $$
declare
  d        documents%rowtype;
  s        settings%rowtype;
  c        clients%rowtype;
  today    date := (now() at time zone 'Europe/Vienna')::date;
  problems text[] := '{}';
  result   text;
  doc_total numeric;
begin
  select * into d from documents where id = p_document_id for update;
  if d.id is null then raise exception 'document % not found', p_document_id; end if;
  if d.status = 'cancelled' then raise exception 'cancelled documents cannot be issued'; end if;
  if d.number is not null then
    if d.status = 'draft' then update documents set status = 'sent' where id = d.id; end if;
    return d.number;
  end if;

  if d.date > today + 1 then
    raise exception using errcode = 'MI001',
      message = format('The document date %s is in the future. A document can be issued at most one day ahead (today is %s).', d.date, today);
  end if;

  select * into s from settings limit 1;
  if s.id is null
     or btrim(coalesce(s.company_name, '')) = ''
     or btrim(coalesce(s.address_line1, '')) = ''
     or btrim(coalesce(s.zip, '')) = ''
     or btrim(coalesce(s.city, '')) = ''
     or btrim(coalesce(s.uid_number, '')) = ''
     or btrim(coalesce(s.iban, '')) = '' then
    problems := array_append(problems, 'settings_incomplete');
  end if;

  select * into c from clients where id = d.client_id;
  if c.id is null then problems := array_append(problems, 'no_client'); end if;

  if not exists (select 1 from document_items where document_id = d.id and line_type = 'item') then
    problems := array_append(problems, 'no_items');
  end if;

  if d.type in ('invoice', 'quote') and d.currency is distinct from 'EUR' then
    problems := array_append(problems, 'currency_not_eur');
  end if;

  if d.cancels_document_id is null then
    if exists (select 1 from document_items where document_id = d.id and line_type = 'item'
               and btrim(coalesce(description, '')) = '') then
      problems := array_append(problems, 'blank_description');
    end if;
    if exists (select 1 from document_items where document_id = d.id and line_type = 'item'
               and (quantity is null or quantity <= 0)) then
      problems := array_append(problems, 'bad_quantity');
    end if;
    if exists (select 1 from document_items where document_id = d.id and line_type = 'item'
               and unit_price is null) then
      problems := array_append(problems, 'missing_price');
    end if;
    if exists (select 1 from document_items where document_id = d.id and line_type = 'item'
               and discount_type is not null and discount_value is not null
               and (discount_value < 0
                    or (discount_type = 'percent' and discount_value > 100)
                    or (discount_type = 'fixed' and discount_value > 0
                        and discount_value > greatest(0, round(coalesce(quantity, 0) * coalesce(unit_price, 0), 2))))) then
      problems := array_append(problems, 'bad_discount');
    end if;
    if (d.service_date is null and d.service_date_end is not null)
       or exists (select 1 from document_items where document_id = d.id and line_type = 'item'
                  and service_date is null and service_date_end is not null) then
      problems := array_append(problems, 'period_start_missing');
    end if;
    if d.service_date_end < d.service_date
       or exists (select 1 from document_items where document_id = d.id and line_type = 'item'
                  and service_date_end < service_date) then
      problems := array_append(problems, 'period_end_before_start');
    end if;

    if d.type <> 'quote' then
      if c.id is not null and d.tax_treatment = 'eu_reverse_charge' and btrim(coalesce(c.uid_number, '')) = '' then
        problems := array_append(problems, 'reverse_charge_without_uid');
      end if;
      if c.id is not null and d.tax_treatment in ('eu_reverse_charge', 'non_eu') and btrim(coalesce(c.country, '')) = '' then
        problems := array_append(problems, 'client_country_missing');
      end if;
      if d.service_date is null
         and exists (select 1 from document_items where document_id = d.id and line_type = 'item'
                     and service_date is null) then
        problems := array_append(problems, 'no_service_date');
      end if;
    end if;

    if d.type in ('invoice', 'quote') then
      -- sec = the number of subtotal lines above a line; a subtotal line closes its section.
      -- (Aliases avoid d, s and c, which are this function's variables.)
      with ln as (
        select line_type, quantity, unit_price, vat_rate, discount_type, discount_value,
               count(*) filter (where line_type = 'subtotal')
                 over (order by sort_order rows between unbounded preceding and 1 preceding) as sec
        from document_items where document_id = d.id
      ),
      it as (
        select sec, vat_rate, gross - case
                 when discount_type is null or coalesce(discount_value, 0) <= 0 or gross <= 0 then 0
                 when discount_type = 'percent' then round(gross * least(discount_value, 100) / 100, 2)
                 else least(discount_value, gross)
               end as amount
        from (select *, round(quantity * unit_price, 2) as gross from ln) g
        where line_type = 'item' and quantity is not null and unit_price is not null and vat_rate is not null
      ),
      secs as (
        select it.sec, sum(it.amount) as gross, min(cl.discount_type) as discount_type, min(cl.discount_value) as discount_value
        from it left join ln cl on cl.line_type = 'subtotal' and cl.sec = it.sec
        group by it.sec
      ),
      scaled as (
        select sec, case
                 when gross <= 0 or discount_type is null or coalesce(discount_value, 0) <= 0 then 1
                 when discount_type = 'percent' then (gross - round(gross * least(discount_value, 100) / 100, 2)) / gross
                 else (gross - least(discount_value, gross)) / gross
               end as factor
        from secs
      )
      select round(sum(it.amount * sc.factor
               * (1 + case when coalesce(d.tax_treatment, 'at_vat') = 'at_vat' then it.vat_rate else 0 end / 100.0)), 2)
        into doc_total
      from it join scaled sc using (sec);
      if doc_total < 0 then problems := array_append(problems, 'negative_total'); end if;
    end if;
  end if;

  if cardinality(problems) > 0 then
    raise exception using errcode = 'MI004',
      message = format('The document cannot be issued yet: %s.', array_to_string(problems, ', ')),
      detail = array_to_string(problems, ',');
  end if;

  result := next_document_number(d.type, coalesce(d.date, today));

  update documents
  set number = result,
      status = case when status = 'draft' then 'sent' else status end,
      issued_at = coalesce(issued_at, now()),
      due_date = case
        when due_date is not null or d.type = 'credit_note' then due_date
        when d.type = 'quote' then coalesce(d.date, today) + coalesce(s.default_quote_validity_days, 14)
        else coalesce(d.date, today) + coalesce(c.payment_days, s.default_payment_days, 14)
      end
  where id = d.id;
  return result;
end;
$$;

-- Writes a document's lines in one transaction and keeps their ids (20261102_integrity.sql): a
-- line whose id belongs to this document is updated, every other line inserted (under the id the
-- editor sent while no row has it, so the editor and the database share the ids) and the
-- document's lines that did not come back are deleted. Time entries and expenses billed on a
-- deleted line move to a new line with exactly the same content (a device backup from before ids
-- were kept); otherwise a draft frees them and its history says so, while an issued document
-- keeps them billed (what it billed stays billed), only without the line. A save with a line
-- that has no id frees nothing: it may be an edited line, not a removed one.
create or replace function replace_document_items(p_document_id uuid, p_items jsonb)
returns void language plpgsql as $$
declare
  d      documents%rowtype;
  kept   jsonb;
  added  jsonb;
  stays  uuid[];
  gone   record;
  twin   uuid;
  twins  uuid[] := '{}';
  freed  integer := 0;
  more   integer := 0;
  legacy boolean;
begin
  -- Two saves of one document (two tabs) run one after the other.
  select * into d from documents where id = p_document_id for update;
  if d.id is null then raise exception 'document % not found', p_document_id; end if;
  -- A line sent without an id (a tab still on the code from before ids were kept, or a device
  -- backup from then) becomes a new row, so an edited line cannot be told from a removed one.
  legacy := exists (
    select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as x(e)
    where coalesce(x.e->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

  with sent as (
    select x.e || jsonb_build_object('document_id', p_document_id) as e, x.ord,
           case when x.e->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (x.e->>'id')::uuid end as uid
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(e, ord)
  ), marked as (
    select s.*,
           s.uid is not null and row_number() over (partition by s.uid order by s.ord) = 1 as is_first,
           exists (select 1 from document_items i where i.id = s.uid and i.document_id = p_document_id) as is_mine,
           exists (select 1 from document_items i where i.id = s.uid) as is_taken
    from sent s
  )
  select
    coalesce(jsonb_agg(m.e || jsonb_build_object('id', m.uid) order by m.ord)
             filter (where m.is_first and m.is_mine), '[]'::jsonb),
    coalesce(jsonb_agg(m.e || jsonb_build_object('id', case when m.is_first and not m.is_taken then m.uid else uuid_generate_v4() end) order by m.ord)
             filter (where not (m.is_first and m.is_mine)), '[]'::jsonb)
  into kept, added
  from marked m;

  stays := array(select (k->>'id')::uuid from jsonb_array_elements(kept) k)
        || array(select (a->>'id')::uuid from jsonb_array_elements(added) a);

  insert into document_items (
    id, document_id, sort_order, line_type, description, service_date, service_date_end,
    quantity, unit, unit_price, vat_rate, catalogue_item_id, discount_type, discount_value
  )
  select
    r.id, p_document_id, r.sort_order, r.line_type, r.description, r.service_date, r.service_date_end,
    r.quantity, r.unit, r.unit_price, r.vat_rate, r.catalogue_item_id, r.discount_type, r.discount_value
  from jsonb_populate_recordset(null::document_items, added) r
  order by r.sort_order;

  update document_items i set
    sort_order = r.sort_order, line_type = r.line_type, description = r.description,
    service_date = r.service_date, service_date_end = r.service_date_end, quantity = r.quantity,
    unit = r.unit, unit_price = r.unit_price, vat_rate = r.vat_rate, catalogue_item_id = r.catalogue_item_id,
    discount_type = r.discount_type, discount_value = r.discount_value
  from jsonb_populate_recordset(null::document_items, kept) r
  where i.id = r.id and i.document_id = p_document_id;

  for gone in
    select i.* from document_items i
    where i.document_id = p_document_id and not (i.id = any(stays))
      and (exists (select 1 from time_entries t where t.document_item_id = i.id)
           or exists (select 1 from project_expenses x where x.document_item_id = i.id))
    order by i.sort_order
  loop
    select r.id into twin
    from jsonb_populate_recordset(null::document_items, added) r
    where r.line_type = gone.line_type
      and r.description is not distinct from gone.description
      and r.quantity is not distinct from gone.quantity
      and r.unit is not distinct from gone.unit
      and r.unit_price is not distinct from gone.unit_price
      and r.vat_rate is not distinct from gone.vat_rate
      and r.service_date is not distinct from gone.service_date
      and r.service_date_end is not distinct from gone.service_date_end
      and not (r.id = any(twins))
    order by r.sort_order
    limit 1;
    if twin is not null then
      twins := twins || twin;
      update time_entries set document_item_id = twin where document_item_id = gone.id;
      update project_expenses set document_item_id = twin where document_item_id = gone.id;
    end if;
  end loop;

  if d.number is null and not legacy then
    update time_entries t set invoiced_document_id = null, document_item_id = null, billed_rate = null
    from document_items i
    where i.document_id = p_document_id and not (i.id = any(stays))
      and t.document_item_id = i.id and t.invoiced_document_id = p_document_id;
    get diagnostics freed = row_count;
    update project_expenses x set invoiced_document_id = null, document_item_id = null
    from document_items i
    where i.document_id = p_document_id and not (i.id = any(stays))
      and x.document_item_id = i.id and x.invoiced_document_id = p_document_id;
    get diagnostics more = row_count;
    if freed + more > 0 then
      insert into document_events (document_id, type, detail)
      values (p_document_id, 'project_released', jsonb_build_object('reason', 'line_removed', 'time_entries', freed, 'expenses', more));
    end if;
  end if;

  delete from document_items where document_id = p_document_id and not (id = any(stays));
end;
$$;

-- How many document lines use each catalogue item and the date of the latest such document,
-- for the counts on the catalogue page.
create or replace function catalogue_usage()
returns table (catalogue_item_id uuid, uses bigint, last_used date) language sql stable as $$
  select i.catalogue_item_id, count(*), max(d.date)
  from document_items i
  join documents d on d.id = i.document_id
  where i.catalogue_item_id is not null
  group by i.catalogue_item_id
$$;

-- Lifecycle (20261030_lifecycle.sql): error codes MI010–MI018 are mapped to the app's dictionaries.
-- ─── Status transitions ──────────────────────────────────────────────────────
-- Every status change, from any client or the service role, has to be one of these steps.
-- Leaving draft needs the number issue_document assigns in the same update. An issued invoice
-- is cancelled only together with its Storno, an issued credit note never, and a paid invoice
-- reopens only inside remove_payment (which sets mado.reopen for its own transaction).
create or replace function documents_status_guard()
returns trigger language plpgsql as $$
declare
  step text := old.status || '>' || new.status;
begin
  if new.status is not distinct from old.status then return new; end if;

  if old.status = 'cancelled' then
    raise exception using errcode = 'MI010', detail = step,
      message = format('%s is cancelled; its status cannot change any more.', coalesce(old.number, 'This document'));
  end if;

  if not step = any (case old.type
    when 'invoice' then array[
      'draft>sent', 'draft>cancelled',
      'sent>overdue', 'sent>paid', 'sent>cancelled',
      'overdue>sent', 'overdue>paid', 'overdue>cancelled',
      'paid>sent', 'paid>overdue', 'paid>cancelled']
    when 'quote' then array[
      'draft>sent', 'draft>cancelled',
      'sent>accepted', 'sent>rejected', 'sent>cancelled',
      'accepted>rejected', 'accepted>cancelled',
      'rejected>accepted', 'rejected>cancelled']
    when 'credit_note' then array['draft>sent', 'draft>cancelled']
    else array[]::text[] end)
  then
    raise exception using errcode = 'MI010', detail = step,
      message = format('A %s cannot change from %s to %s.', replace(old.type, '_', ' '), old.status, new.status);
  end if;

  if old.status = 'draft' and new.status <> 'cancelled' and new.number is null then
    raise exception using errcode = 'MI011',
      message = 'Only an issued (numbered) document can leave draft; issue it first.';
  end if;

  if old.type = 'invoice' and new.status = 'cancelled' and old.number is not null
     and not exists (select 1 from documents s where s.cancels_document_id = old.id) then
    raise exception using errcode = 'MI012',
      message = format('%s is issued: cancel it with a Storno, which creates the cancelling credit note.', old.number);
  end if;

  if old.type = 'credit_note' and new.status = 'cancelled' and old.number is not null then
    raise exception using errcode = 'MI013',
      message = format('%s is an issued credit note and cannot be cancelled.', old.number);
  end if;

  if old.status = 'paid' and new.status in ('sent', 'overdue')
     and coalesce(current_setting('mado.reopen', true), '') <> 'on' then
    raise exception using errcode = 'MI014',
      message = 'A paid invoice only reopens when one of its payments is removed.';
  end if;

  return new;
end;
$$;

drop trigger if exists documents_status_guard on documents;
create trigger documents_status_guard
  before update of status on documents
  for each row execute function documents_status_guard();

-- Issued documents are kept for the retention period and their numbers stay unique.
create or replace function documents_delete_guard()
returns trigger language plpgsql as $$
begin
  if old.number is not null then
    raise exception using errcode = 'MI015',
      message = format('%s is issued and has to be kept; cancel it instead of deleting it.', old.number);
  end if;
  return old;
end;
$$;

drop trigger if exists documents_delete_guard on documents;
create trigger documents_delete_guard
  before delete on documents
  for each row execute function documents_delete_guard();

-- ─── Deduction links ─────────────────────────────────────────────────────────
-- Only an issued, uncancelled advance or partial invoice is deducted, by an uncancelled draft
-- final invoice of the same client (an issued one keeps the deduction it was issued with). What
-- an issued final invoice deducts stays until that invoice is
-- cancelled with its Storno: the invoice can neither move to another final invoice nor be
-- cancelled itself. Cancelling one that a draft final invoice deducts takes it off that draft.
create or replace function documents_deposit_guard()
returns trigger language plpgsql as $$
declare
  f documents%rowtype;
begin
  if new.final_invoice_id is distinct from old.final_invoice_id then
    if old.final_invoice_id is not null then
      select * into f from documents where id = old.final_invoice_id;
      if f.number is not null and f.status <> 'cancelled' then
        raise exception using errcode = 'MI020',
          message = format('%s is deducted on final invoice %s; cancel that invoice first.', coalesce(old.number, 'This invoice'), f.number);
      end if;
    end if;
    if new.final_invoice_id is not null then
      select * into f from documents where id = new.final_invoice_id;
      if new.type <> 'invoice' or new.invoice_kind not in ('advance', 'partial') or new.number is null
         or new.status = 'cancelled' or f.id is null or f.type <> 'invoice' or f.invoice_kind <> 'final'
         or f.status = 'cancelled' or f.number is not null or f.client_id <> new.client_id then
        raise exception using errcode = 'MI021',
          message = 'Only an issued advance or partial invoice can be deducted, by a draft final invoice of the same client.';
      end if;
    end if;
  end if;

  if old.invoice_kind = 'final' and new.invoice_kind <> 'final'
     and exists (select 1 from documents where final_invoice_id = new.id) then
    raise exception using errcode = 'MI021',
      message = 'A final invoice that deducts other invoices stays a final invoice; remove the deductions first.';
  end if;

  if new.client_id <> old.client_id
     and (new.final_invoice_id is not null or exists (select 1 from documents where final_invoice_id = new.id)) then
    raise exception using errcode = 'MI021',
      message = 'A final invoice and the invoices it deducts belong to one client; remove the deductions first.';
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' and new.final_invoice_id is not null then
    select * into f from documents where id = new.final_invoice_id;
    if f.number is not null and f.status <> 'cancelled' then
      raise exception using errcode = 'MI020',
        message = format('%s is deducted on final invoice %s; cancel that invoice first.', coalesce(new.number, 'This invoice'), f.number);
    end if;
    insert into document_events (document_id, type, detail)
    values (new.id, 'deposit_released', jsonb_build_object('final_id', f.id, 'final_number', f.number, 'reason', 'self_cancelled'));
    new.final_invoice_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_deposit_guard on documents;
create trigger documents_deposit_guard
  before update of status, final_invoice_id, invoice_kind, client_id on documents
  for each row execute function documents_deposit_guard();

-- A cancelled final invoice (its Storno, or a draft cancelled from the status menu) deducts
-- nothing any more: its invoices are free for the next final invoice, as both histories say.
create or replace function documents_deposit_release()
returns trigger language plpgsql as $$
declare
  adv record;
  why text := case when new.number is null then 'cancelled' else 'storno' end;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.invoice_kind = 'final' then
    for adv in update documents set final_invoice_id = null where final_invoice_id = new.id returning id, number loop
      insert into document_events (document_id, type, detail)
      values (adv.id, 'deposit_released', jsonb_build_object('final_id', new.id, 'final_number', new.number, 'reason', why)),
             (new.id, 'deposit_released', jsonb_build_object('invoice_id', adv.id, 'invoice_number', adv.number, 'reason', why));
    end loop;
  end if;
  return null;
end;
$$;

drop trigger if exists documents_deposit_release on documents;
create trigger documents_deposit_release
  after update of status on documents
  for each row execute function documents_deposit_release();

-- Deleting a draft final invoice frees its invoices (the foreign key sets the link to null);
-- their histories say so.
create or replace function documents_deposit_delete()
returns trigger language plpgsql as $$
begin
  if old.invoice_kind = 'final' then
    insert into document_events (document_id, type, detail)
    select id, 'deposit_released', jsonb_build_object('reason', 'deleted')
    from documents where final_invoice_id = old.id;
  end if;
  return old;
end;
$$;

drop trigger if exists documents_deposit_delete on documents;
create trigger documents_deposit_delete
  before delete on documents
  for each row execute function documents_deposit_delete();

-- ─── Removing a payment ──────────────────────────────────────────────────────
-- Deletes one payment row. With p_reopen (the app computed that the balance is open again) a
-- paid invoice goes back to 'overdue' when its due date has passed, otherwise to 'sent'.
-- Returns the new status, or null when the status stayed.
create or replace function remove_payment(p_payment_id uuid, p_reopen boolean default false)
returns text language plpgsql as $$
declare
  p      payments%rowtype;
  d      documents%rowtype;
  target text;
begin
  delete from payments where id = p_payment_id returning * into p;
  if p.id is null then raise exception 'payment % not found', p_payment_id; end if;

  select * into d from documents where id = p.document_id for update;
  if not p_reopen or d.status is distinct from 'paid' then return null; end if;

  target := case when d.due_date is not null and d.due_date < (now() at time zone 'Europe/Vienna')::date
                 then 'overdue' else 'sent' end;
  perform set_config('mado.reopen', 'on', true);
  update documents set status = target where id = d.id;
  perform set_config('mado.reopen', '', true);
  return target;
end;
$$;

-- A final invoice deducts an advance invoice with the money received on it, less what was paid
-- back on its credit notes (src/lib/deposits.ts). Once the final invoice is issued that amount is
-- fixed on it, so the money behind it stays as it is: removing a payment of the advance invoice,
-- or recording or removing a refund on one of its credit notes, is refused (MI022) until the
-- final invoice is cancelled with its Storno, which frees the advance invoice again.
create or replace function payments_deposit_guard()
returns trigger language plpgsql as $$
declare
  p   payments%rowtype;
  adv documents%rowtype;
  f   documents%rowtype;
begin
  if tg_op = 'DELETE' then p := old; else p := new; end if;
  if p.kind = 'refund' then
    select a.* into adv
    from documents c join documents a on a.id = c.converted_from_id
    where c.id = p.document_id and c.type = 'credit_note';
  elsif p.kind = 'payment' and tg_op = 'DELETE' then
    select * into adv from documents where id = p.document_id;
  end if;

  if adv.id is not null and adv.type = 'invoice' and adv.invoice_kind = 'advance' and adv.final_invoice_id is not null then
    select * into f from documents where id = adv.final_invoice_id;
    if f.number is not null and f.status <> 'cancelled' then
      raise exception using errcode = 'MI022',
        message = format('%s is deducted on final invoice %s with the money received on it; cancel that invoice with its Storno first.', coalesce(adv.number, 'This invoice'), f.number);
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists payments_deposit_guard on payments;
create trigger payments_deposit_guard
  before insert or delete on payments
  for each row execute function payments_deposit_guard();

-- ─── Quote → invoice ─────────────────────────────────────────────────────────
-- One transaction: the quote row is locked, so a double click or a second tab gets the invoice
-- the first call created. Only sent or accepted quotes convert (MI016). The invoice is an
-- unnumbered draft dated today, due after the client's payment days and with the client's Skonto
-- (each falling back to the settings default; stored only above 0 %, as the builder does), with
-- every line and the buyer reference copied as they are; a sent quote becomes accepted. Advance
-- and partial invoices made from the quote are never its conversion, nor is an invoice cancelled
-- with its Storno (the quote converts again, e.g. into a new final invoice). Once issued ones exist, a
-- plain invoice would bill them twice (MI019): p_final creates the final invoice instead and
-- links them to it (the app then writes the deduction lines). Null when the quote does not exist.
create or replace function convert_quote_to_invoice(p_quote_id uuid, p_final boolean default false)
returns jsonb language plpgsql as $$
declare
  q      documents%rowtype;
  s      settings%rowtype;
  inv_id uuid;
  today  date := (now() at time zone 'Europe/Vienna')::date;
  days   integer;
  pct    numeric;
  sdays  integer;
  linked integer := 0;
  adv    record;
begin
  select * into q from documents where id = p_quote_id and type = 'quote' for update;
  if q.id is null then return null; end if;

  select id into inv_id from documents
  where converted_from_id = q.id and type = 'invoice' and invoice_kind in ('standard', 'final') and status <> 'cancelled'
  order by created_at limit 1;
  if inv_id is not null then
    return jsonb_build_object('invoice_id', inv_id, 'existing', true, 'quote_status', q.status, 'linked', 0);
  end if;

  if q.status not in ('sent', 'accepted') then
    raise exception using errcode = 'MI016', detail = q.status,
      message = format('Only sent or accepted quotes can be converted (this one is %s).', q.status);
  end if;

  if not p_final and exists (
    select 1 from documents
    where converted_from_id = q.id and type = 'invoice' and invoice_kind in ('advance', 'partial')
      and number is not null and status <> 'cancelled'
  ) then
    raise exception using errcode = 'MI019',
      message = 'This quote has advance invoices: create the final invoice, which deducts them.';
  end if;

  select * into s from settings limit 1;
  select payment_days, skonto_percent, skonto_days into days, pct, sdays from clients where id = q.client_id;
  pct := coalesce(pct, s.default_skonto_percent);

  insert into documents (
    type, invoice_kind, number, status, client_id, date, due_date, service_date, service_date_end,
    language, currency, tax_treatment, exchange_rate, notes, notes_internal,
    discount_type, discount_value, skonto_percent, skonto_days, converted_from_id, buyer_reference
  ) values (
    'invoice', case when p_final then 'final' else 'standard' end, null, 'draft', q.client_id, today,
    today + coalesce(days, s.default_payment_days, 14),
    q.service_date, q.service_date_end, q.language, q.currency, q.tax_treatment, q.exchange_rate,
    q.notes, q.notes_internal, q.discount_type, q.discount_value,
    case when pct > 0 then pct end, case when pct > 0 then coalesce(sdays, s.default_skonto_days) end, q.id,
    q.buyer_reference
  ) returning id into inv_id;

  -- Whole rows, so columns added to document_items later are copied too.
  insert into document_items
  select r.*
  from document_items i,
       lateral jsonb_populate_record(null::document_items,
         to_jsonb(i) || jsonb_build_object('id', uuid_generate_v4(), 'document_id', inv_id)) r
  where i.document_id = q.id
  order by i.sort_order;

  if p_final then
    for adv in update documents set final_invoice_id = inv_id
               where converted_from_id = q.id and type = 'invoice' and invoice_kind in ('advance', 'partial')
                 and number is not null and status <> 'cancelled' and final_invoice_id is null
               returning id, number loop
      insert into document_events (document_id, type, detail)
      values (adv.id, 'deposit_linked', jsonb_build_object('final_id', inv_id)),
             (inv_id, 'deposit_linked', jsonb_build_object('invoice_id', adv.id, 'invoice_number', adv.number));
      linked := linked + 1;
    end loop;
  end if;

  if q.status = 'sent' then
    update documents set status = 'accepted' where id = q.id;
  end if;

  return jsonb_build_object('invoice_id', inv_id, 'existing', false, 'quote_status', q.status, 'linked', linked);
end;
$$;

-- ─── Invoice → credit note / Storno ──────────────────────────────────────────
-- Copies an issued invoice into a draft credit note. With p_cancel it is a Storno: the credit note is
-- numbered right here (issue_document) and the invoice cancelled in the same transaction, so a
-- Storno is never a deletable draft and never exists without its cancelled invoice. Only a Storno
-- mirrors a final invoice's deduction lines; a plain credit note starts with the lines that bill
-- the service. Null when the invoice does not exist.
create or replace function create_credit_note(p_invoice_id uuid, p_cancel boolean default false)
returns jsonb language plpgsql as $$
declare
  inv       documents%rowtype;
  cn_id     uuid;
  cn_number text;
  today     date := (now() at time zone 'Europe/Vienna')::date;
begin
  select * into inv from documents where id = p_invoice_id and type = 'invoice' for update;
  if inv.id is null then return null; end if;

  -- A credit note corrects an issued invoice; a cancelled one is already reversed by its Storno.
  if inv.number is null then
    raise exception using errcode = 'MI018', message = 'A draft has no number to cancel or credit; edit or delete it instead.';
  end if;
  if inv.status = 'cancelled' then
    raise exception using errcode = 'MI017', message = format('%s is already cancelled.', inv.number);
  end if;
  -- An issued final invoice keeps the deduction it was issued with: an invoice it deducts is
  -- corrected there, not with a credit note of its own (MI020, as for its Storno).
  if inv.final_invoice_id is not null and exists (
    select 1 from documents f where f.id = inv.final_invoice_id and f.number is not null and f.status <> 'cancelled'
  ) then
    raise exception using errcode = 'MI020',
      message = format('%s is deducted on an issued final invoice; cancel that invoice first.', inv.number);
  end if;

  insert into documents (
    type, number, status, client_id, date, due_date, service_date, service_date_end,
    language, currency, tax_treatment, exchange_rate, notes, notes_internal,
    discount_type, discount_value, converted_from_id, cancels_document_id, buyer_reference
  ) values (
    'credit_note', null, 'draft', inv.client_id, today, null, inv.service_date, inv.service_date_end,
    inv.language, inv.currency, inv.tax_treatment, inv.exchange_rate, inv.notes, inv.notes_internal,
    inv.discount_type, inv.discount_value, inv.id, case when p_cancel then inv.id end, inv.buyer_reference
  ) returning id into cn_id;

  insert into document_items
  select r.*
  from document_items i,
       lateral jsonb_populate_record(null::document_items,
         to_jsonb(i) || jsonb_build_object('id', uuid_generate_v4(), 'document_id', cn_id)) r
  where i.document_id = inv.id and (p_cancel or i.line_type <> 'deduction')
  order by i.sort_order;

  if p_cancel then
    cn_number := issue_document(cn_id);
    update documents set status = 'cancelled' where id = inv.id;
  end if;

  return jsonb_build_object('credit_note_id', cn_id, 'number', cn_number, 'invoice_status', inv.status);
end;
$$;

-- ─── Row Level Security ──────────────────────────────────────────────────────
-- Only users listed in app_users may touch data. Any user can sign up against
-- the Supabase project, so auth.role() = 'authenticated' alone is not enough.
create table app_users (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table app_users enable row level security;

-- Re-run this line after creating the owner account in Supabase Auth.
insert into app_users(user_id) select id from auth.users on conflict do nothing;

-- With a verified MFA factor the owner passes only with an aal2 JWT (the code was entered); an
-- owner without one is unaffected (20261103_final.sql, which also has the rollback). Runs as its
-- owner, which reads auth.mfa_factors. A token without an 'aal' claim counts as aal1.
create or replace function mfa_satisfied()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = auth.uid() and f.status = 'verified'
    )
$$;

revoke execute on function mfa_satisfied() from public, anon;
grant execute on function mfa_satisfied() to authenticated;

create or replace function is_app_user()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_users where user_id = auth.uid()) and public.mfa_satisfied()
$$;

revoke execute on function is_app_user() from public, anon;
grant execute on function is_app_user() to authenticated;

-- mfa_satisfied(), not is_app_user(): that one reads app_users, and through this policy would
-- call itself.
create policy "own row" on app_users for select to authenticated using (user_id = auth.uid() and mfa_satisfied());

alter table settings        enable row level security;
alter table clients         enable row level security;
alter table catalogue_items enable row level security;
alter table documents       enable row level security;
alter table document_items  enable row level security;
alter table payments        enable row level security;
alter table reminder_log    enable row level security;
alter table document_events enable row level security;
alter table recurring_schedules enable row level security;
alter table bookamat_bookings enable row level security;
alter table client_rates    enable row level security;

create policy "owner" on settings        for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on clients         for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on catalogue_items for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on documents       for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on document_items  for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on payments        for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on reminder_log    for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on document_events for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on recurring_schedules for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on bookamat_bookings for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on client_rates    for all to authenticated using (is_app_user()) with check (is_app_user());

-- ─── Projects, time tracking and billable expenses ───────────────────────────
-- (20261101_projects.sql; after is_app_user(), which its policies need.) Expenses are costs
-- passed on to a client; input VAT stays in Bookamat. Unbilled billable entries become the lines
-- of one draft invoice in one transaction; deleting that draft frees them (ON DELETE SET NULL),
-- and so does cancelling the invoice or removing their line from the draft.
-- Error codes: MI030 = project not found, MI031 = nothing to invoice, MI032 = an entry was
-- billed, deleted or made non-billable in the meantime, MI033 = a project with billed entries
-- cannot be deleted.
create table projects (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),
  client_id     uuid not null references clients(id) on delete restrict,
  name          text not null constraint projects_name_check check (btrim(name) <> ''),
  status        text not null default 'active' constraint projects_status_check check (status in ('active','done','archived')),
  -- Net hourly rate of time entries without their own rate.
  hourly_rate   numeric(10,2) constraint projects_hourly_rate_check check (hourly_rate is null or hourly_rate >= 0),
  budget_hours  numeric(10,2) constraint projects_budget_hours_check check (budget_hours is null or budget_hours > 0),
  -- Net budget, compared with the value of all billable time and expenses.
  budget_amount numeric(10,2) constraint projects_budget_amount_check check (budget_amount is null or budget_amount > 0),
  notes         text
);

create index projects_client_id_idx on projects(client_id);

create table time_entries (
  id                   uuid primary key default uuid_generate_v4(),
  created_at           timestamptz not null default now(),
  project_id           uuid not null references projects(id) on delete cascade,
  date                 date not null,
  minutes              integer not null constraint time_entries_minutes_check check (minutes between 1 and 1440),
  description          text not null default '',
  billable             boolean not null default true,
  -- Net hourly rate for this entry; null = the project's rate.
  rate                 numeric(10,2) constraint time_entries_rate_check check (rate is null or rate >= 0),
  -- Set together when the entry is billed; the line keeps its id across edits of the invoice
  -- (replace_document_items). Removing the line from a draft, cancelling the invoice or deleting
  -- the draft makes the entry unbilled again.
  invoiced_document_id uuid references documents(id) on delete set null,
  document_item_id     uuid references document_items(id) on delete set null,
  -- The hourly rate the entry was billed at, so a later change of the project's rate does not
  -- change what it shows as billed. Only meaningful while invoiced_document_id is set.
  billed_rate          numeric(10,2)
);

create index time_entries_project_id_idx on time_entries(project_id, date);
create index time_entries_invoiced_document_id_idx on time_entries(invoiced_document_id) where invoiced_document_id is not null;
create index time_entries_document_item_id_idx on time_entries(document_item_id) where document_item_id is not null;

create table project_expenses (
  id                   uuid primary key default uuid_generate_v4(),
  created_at           timestamptz not null default now(),
  project_id           uuid not null references projects(id) on delete cascade,
  date                 date not null,
  description          text not null constraint project_expenses_description_check check (btrim(description) <> ''),
  net_amount           numeric(10,2) not null constraint project_expenses_net_amount_check check (net_amount > 0),
  vat_rate             integer not null default 20 constraint project_expenses_vat_rate_check check (vat_rate in (0,10,13,20)),
  billable             boolean not null default true,
  -- Surcharge on the net amount when the expense is passed on.
  markup_percent       numeric(6,2) constraint project_expenses_markup_check check (markup_percent is null or markup_percent between 0 and 1000),
  invoiced_document_id uuid references documents(id) on delete set null,
  document_item_id     uuid references document_items(id) on delete set null
);

create index project_expenses_project_id_idx on project_expenses(project_id, date);
create index project_expenses_invoiced_document_id_idx on project_expenses(invoiced_document_id) where invoiced_document_id is not null;
create index project_expenses_document_item_id_idx on project_expenses(document_item_id) where document_item_id is not null;

-- ─── Unbilled entries → draft invoice ────────────────────────────────────────
-- p_lines is what src/lib/projects.ts buildInvoiceLines computed: one object per line with the
-- document_items columns plus time_entry_ids / expense_ids, the entries the line bills. One
-- transaction: the project row is locked, the draft is created for the project's client (its
-- language, tax treatment, payment days and Skonto, each falling back to the settings default;
-- Skonto is stored only when above 0, as the builder does), every line inserted and
-- its entries linked. An entry that is no longer an unbilled billable entry of this project rolls
-- everything back (MI032), so nothing is ever billed twice.
create or replace function invoice_project_entries(p_project_id uuid, p_lines jsonb)
returns uuid language plpgsql as $$
declare
  p       projects%rowtype;
  c       clients%rowtype;
  s       settings%rowtype;
  doc_id  uuid;
  item_id uuid;
  l       jsonb;
  pos     integer := 0;
  ids     uuid[];
  linked  integer;
  today   date := (now() at time zone 'Europe/Vienna')::date;
begin
  select * into p from projects where id = p_project_id for update;
  if p.id is null then
    raise exception using errcode = 'MI030', message = 'Project not found.';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode = 'MI031', message = 'Nothing to invoice.';
  end if;
  if not exists (select 1 from jsonb_array_elements(p_lines) as x(e) where coalesce(e->>'line_type', 'item') = 'item') then
    raise exception using errcode = 'MI031', message = 'Nothing to invoice.';
  end if;

  select * into c from clients where id = p.client_id;
  select * into s from settings limit 1;

  insert into documents (
    type, number, status, client_id, date, due_date, language, currency, tax_treatment,
    exchange_rate, skonto_percent, skonto_days
  ) values (
    'invoice', null, 'draft', c.id, today, today + coalesce(c.payment_days, s.default_payment_days, 14),
    c.language, 'EUR', c.tax_treatment, 1,
    case when coalesce(c.skonto_percent, s.default_skonto_percent) > 0 then coalesce(c.skonto_percent, s.default_skonto_percent) end,
    case when coalesce(c.skonto_percent, s.default_skonto_percent) > 0 then coalesce(c.skonto_days, s.default_skonto_days) end
  ) returning id into doc_id;

  for l in select value from jsonb_array_elements(p_lines) loop
    insert into document_items (
      document_id, sort_order, line_type, description, service_date, service_date_end,
      quantity, unit, unit_price, vat_rate
    ) values (
      doc_id, pos, coalesce(l->>'line_type', 'item'), coalesce(l->>'description', ''),
      (l->>'service_date')::date, (l->>'service_date_end')::date,
      (l->>'quantity')::numeric, l->>'unit', (l->>'unit_price')::numeric, (l->>'vat_rate')::integer
    ) returning id into item_id;
    pos := pos + 1;

    ids := array(select jsonb_array_elements_text(coalesce(l->'time_entry_ids', '[]'::jsonb))::uuid);
    if cardinality(ids) > 0 then
      update time_entries set invoiced_document_id = doc_id, document_item_id = item_id, billed_rate = (l->>'unit_price')::numeric
      where id = any(ids) and project_id = p.id and billable and invoiced_document_id is null;
      get diagnostics linked = row_count;
      if linked <> cardinality(ids) then
        raise exception using errcode = 'MI032', message = 'A time entry is no longer unbilled.';
      end if;
    end if;

    ids := array(select jsonb_array_elements_text(coalesce(l->'expense_ids', '[]'::jsonb))::uuid);
    if cardinality(ids) > 0 then
      update project_expenses set invoiced_document_id = doc_id, document_item_id = item_id
      where id = any(ids) and project_id = p.id and billable and invoiced_document_id is null;
      get diagnostics linked = row_count;
      if linked <> cardinality(ids) then
        raise exception using errcode = 'MI032', message = 'An expense is no longer unbilled.';
      end if;
    end if;
  end loop;

  return doc_id;
end;
$$;

-- A cancelled invoice bills nothing: when an invoice is cancelled with its Storno
-- (create_credit_note with p_cancel) or a draft is cancelled, the time entries and expenses it
-- billed are unbilled again, ready for the corrected invoice, and its history says so.
create or replace function documents_project_release()
returns trigger language plpgsql as $$
declare
  n      integer;
  m      integer;
  storno documents%rowtype;
begin
  update time_entries set invoiced_document_id = null, document_item_id = null, billed_rate = null
  where invoiced_document_id = new.id;
  get diagnostics n = row_count;
  update project_expenses set invoiced_document_id = null, document_item_id = null
  where invoiced_document_id = new.id;
  get diagnostics m = row_count;
  if n + m > 0 then
    select * into storno from documents
    where cancels_document_id = new.id and type = 'credit_note' and number is not null
    order by created_at desc limit 1;
    insert into document_events (document_id, type, detail)
    values (new.id, 'project_released', jsonb_strip_nulls(jsonb_build_object(
      'reason', case when storno.id is null then 'cancelled' else 'storno' end,
      'time_entries', n, 'expenses', m,
      'credit_note_id', storno.id, 'credit_note_number', storno.number)));
  end if;
  return null;
end;
$$;

drop trigger if exists documents_project_release on documents;
create trigger documents_project_release
  after update of status on documents
  for each row
  when (new.type = 'invoice' and new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function documents_project_release();

-- Makes billed entries unbilled again, but only while their invoice is a draft or cancelled:
-- what an issued invoice billed stays billed. Each invoice's history notes what was released
-- from it. Returns how many were freed.
create or replace function release_project_entries(p_time_entry_ids uuid[], p_expense_ids uuid[])
returns integer language plpgsql as $$
declare
  freed integer;
begin
  with te as (
    update time_entries t set invoiced_document_id = null, document_item_id = null, billed_rate = null
    from documents d
    where t.id = any(coalesce(p_time_entry_ids, '{}')) and d.id = t.invoiced_document_id
      and (d.number is null or d.status = 'cancelled')
    returning d.id as document_id, 1 as n, 0 as m
  ), ex as (
    update project_expenses e set invoiced_document_id = null, document_item_id = null
    from documents d
    where e.id = any(coalesce(p_expense_ids, '{}')) and d.id = e.invoiced_document_id
      and (d.number is null or d.status = 'cancelled')
    returning d.id as document_id, 0 as n, 1 as m
  ), per_document as (
    select r.document_id, sum(r.n)::integer as n, sum(r.m)::integer as m
    from (select * from te union all select * from ex) r
    group by r.document_id
  ), logged as (
    insert into document_events (document_id, type, detail)
    select p.document_id, 'project_released', jsonb_build_object('reason', 'manual', 'time_entries', p.n, 'expenses', p.m)
    from per_document p
  )
  select coalesce(sum(p.n + p.m), 0)::integer into freed from per_document p;
  return freed;
end;
$$;

-- What an invoice billed stays on record: a project with billed entries is archived, never
-- deleted (the project page checks this too, but a stale tab or a direct call must not cascade
-- the entries away).
create or replace function projects_delete_guard()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from time_entries where project_id = old.id and invoiced_document_id is not null)
     or exists (select 1 from project_expenses where project_id = old.id and invoiced_document_id is not null) then
    raise exception using errcode = 'MI033', message = 'The project has billed entries; archive it instead.';
  end if;
  return old;
end;
$$;

drop trigger if exists projects_delete_guard on projects;
create trigger projects_delete_guard
  before delete on projects
  for each row execute function projects_delete_guard();

alter table projects enable row level security;
alter table time_entries enable row level security;
alter table project_expenses enable row level security;

create policy "owner" on projects         for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on time_entries     for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on project_expenses for all to authenticated using (is_app_user()) with check (is_app_user());

-- ─── Claude connector (MCP) ──────────────────────────────────────────────────
-- 20261105_mcp.sql: the app is the OAuth authorization server for Claude; each grant holds its own
-- aal2 Supabase session (encrypted by the app), so every MCP query runs as the owner under the RLS
-- above. Irreversible actions Claude prepares wait in mcp_actions for the owner's decision: in
-- Mado (the default, with a current authenticator code unless settings.mcp_approval_totp is off)
-- or in the Claude app when the owner set that kind to 'chat'. MI040–MI043 are worded by the app
-- (lifecycleErrorMessage); 'rate_limited' and 'too_many_pending' are plain exceptions.

-- ─── Grants, codes, tokens ───────────────────────────────────────────────────
create table public.mcp_grants (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  client_id            text not null,
  client_name          text not null,
  redirect_uri         text not null,
  client_kind          text not null constraint mcp_grants_client_kind_check check (client_kind in ('claude_ai', 'claude_code', 'static')),
  scopes               text[] not null,
  resource             text not null,
  -- SHA-256 of the signed authorization request the owner approved: one request, one grant.
  consent_hash         text unique,
  -- The grant's own Supabase session; its tokens are AES-256-GCM encrypted by the app (AAD = id).
  sb_session_id        uuid unique,
  sb_access_enc        text,
  sb_access_expires_at timestamptz,
  sb_refresh_enc       text,
  -- One request at a time refreshes the session token.
  sb_lease_until       timestamptz,
  created_at           timestamptz not null default now(),
  last_used_at         timestamptz,
  -- Moved forward by every refresh; the grant dies after a month without one.
  idle_expires_at      timestamptz not null,
  expires_at           timestamptz not null,
  revoked_at           timestamptz,
  revoked_reason       text,
  rate_minute          timestamptz,
  rate_minute_count    integer not null default 0,
  rate_day             date,
  rate_day_count       integer not null default 0
);

create table public.mcp_codes (
  code_hash      text primary key,
  grant_id       uuid not null references public.mcp_grants(id) on delete cascade,
  client_id      text not null,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text not null,
  scopes         text[] not null,
  expires_at     timestamptz not null,
  used_at        timestamptz
);

create table public.mcp_tokens (
  token_hash  text primary key,
  grant_id    uuid not null references public.mcp_grants(id) on delete cascade,
  kind        text not null constraint mcp_tokens_kind_check check (kind in ('access', 'refresh')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  -- A refresh token presented again more than 10 s after rotated_at is theft: the grant is
  -- revoked. Within the 10 s (concurrent refreshes, a retry) the app issues a fresh pair.
  rotated_at  timestamptz,
  parent_hash text
);

create index mcp_tokens_grant_id_idx on public.mcp_tokens(grant_id);
create index mcp_tokens_expires_at_idx on public.mcp_tokens(expires_at);

-- ─── Prepared actions ────────────────────────────────────────────────────────
create table public.mcp_actions (
  id              uuid primary key default gen_random_uuid(),
  -- SHA-256 of the confirmation id Claude holds ('mca_…'); the id itself is never stored.
  handle_hash     text not null unique,
  grant_id        uuid not null references public.mcp_grants(id) on delete cascade,
  kind            text not null constraint mcp_actions_kind_check check (kind in (
                    'issue', 'issue_and_send', 'send_email', 'send_reminder', 'storno', 'cancel', 'delete', 'bookamat_sync')),
  args            jsonb not null,
  args_hash       text not null,
  -- The state the action depends on when it was prepared; re-checked before it runs.
  fingerprint     text not null,
  label           text not null,
  preview         jsonb not null default '{}',
  approval        text not null constraint mcp_actions_approval_check check (approval in ('chat', 'app')),
  status          text not null default 'pending' constraint mcp_actions_status_check check (status in ('pending', 'running', 'done', 'failed', 'rejected')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  claimed_at      timestamptz,
  claimed_via     text constraint mcp_actions_claimed_via_check check (claimed_via is null or claimed_via in ('chat', 'app')),
  -- The session that runs it; only that session can record the outcome.
  claimed_session uuid,
  finished_at     timestamptz,
  result          jsonb,
  error           jsonb
);

create index mcp_actions_grant_id_idx on public.mcp_actions(grant_id, status);
create index mcp_actions_pending_idx on public.mcp_actions(created_at) where status = 'pending';

-- ─── Call audit ──────────────────────────────────────────────────────────────
create table public.mcp_calls (
  id         bigint generated always as identity primary key,
  grant_id   uuid not null references public.mcp_grants(id) on delete cascade,
  tool       text not null,
  ok         boolean not null,
  error_code text,
  ms         integer,
  created_at timestamptz not null default now()
);

create index mcp_calls_created_at_idx on public.mcp_calls(created_at);
create index mcp_calls_grant_id_idx on public.mcp_calls(grant_id);

-- ─── Access ──────────────────────────────────────────────────────────────────
-- Codes and tokens are for the service role only. The owner reads the grants' non-secret
-- columns, the actions and the calls; every write goes through the service role or the RPCs below.
alter table public.mcp_grants  enable row level security;
alter table public.mcp_codes   enable row level security;
alter table public.mcp_tokens  enable row level security;
alter table public.mcp_actions enable row level security;
alter table public.mcp_calls   enable row level security;

revoke all on table public.mcp_grants, public.mcp_codes, public.mcp_tokens, public.mcp_actions, public.mcp_calls from anon, authenticated;
grant select (id, client_name, client_kind, redirect_uri, scopes, created_at, last_used_at, idle_expires_at, expires_at, revoked_at, revoked_reason)
  on public.mcp_grants to authenticated;
grant select on public.mcp_actions, public.mcp_calls to authenticated;

create policy "owner reads" on public.mcp_grants for select to authenticated using (public.is_app_user());
create policy "owner reads" on public.mcp_actions for select to authenticated using (public.is_app_user());
create policy "owner reads" on public.mcp_calls for select to authenticated using (public.is_app_user());

-- ─── Which session is Claude ─────────────────────────────────────────────────
-- The session id of the request's JWT; null without one (service role, SQL editor) or when it
-- is not a uuid.
create or replace function public.mcp_jwt_session_id()
returns uuid
language sql stable
set search_path = ''
as $$
  select case when (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (auth.jwt() ->> 'session_id')::uuid end
$$;

-- The live grant this request's session belongs to, or null for a browser session.
create or replace function public.mcp_session_grant()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select g.id from public.mcp_grants g
  where g.sb_session_id = public.mcp_jwt_session_id()
    and g.user_id = auth.uid()
    and g.revoked_at is null
    and g.expires_at > now()
$$;

-- True for any session that was ever a grant's, revoked or not.
create or replace function public.is_mcp_session()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.mcp_grants g where g.sb_session_id = public.mcp_jwt_session_id())
$$;

-- ─── Bearer token lookup (service role) ──────────────────────────────────────
-- The live grant behind an unexpired access token, counted against the per-grant rate limit
-- (120 calls a minute, 3000 a day). No row: unknown, expired or revoked. A grant whose Supabase
-- session no longer exists (signed out everywhere, password changed) is revoked here
-- ('session_ended'), so its cached session JWT is not used for the rest of its hour.
create or replace function public.mcp_authenticate(p_token_hash text)
returns table (
  grant_id             uuid,
  user_id              uuid,
  client_id            text,
  client_name          text,
  client_kind          text,
  scopes               text[],
  resource             text,
  token_expires_at     timestamptz,
  sb_session_id        uuid,
  sb_access_enc        text,
  sb_access_expires_at timestamptz,
  sb_refresh_enc       text,
  sb_lease_until       timestamptz
)
language plpgsql security definer
set search_path = ''
as $$
declare
  t      public.mcp_tokens%rowtype;
  g      public.mcp_grants%rowtype;
  v_minute timestamptz := date_trunc('minute', now());
  v_day    date := (now() at time zone 'UTC')::date;
begin
  select * into t from public.mcp_tokens tk
  where tk.token_hash = p_token_hash and tk.kind = 'access' and tk.expires_at > now();
  if not found then return; end if;

  select * into g from public.mcp_grants gr
  where gr.id = t.grant_id and gr.revoked_at is null and gr.expires_at > now() and gr.idle_expires_at > now()
  for update;
  if not found then return; end if;

  if not exists (select 1 from auth.sessions s where s.id = g.sb_session_id and s.user_id = g.user_id) then
    update public.mcp_grants gr set
      revoked_at = now(), revoked_reason = 'session_ended',
      sb_access_enc = null, sb_access_expires_at = null, sb_refresh_enc = null, sb_lease_until = null
    where gr.id = g.id;
    delete from public.mcp_tokens tk where tk.grant_id = g.id;
    return;
  end if;

  if g.rate_minute is distinct from v_minute then g.rate_minute := v_minute; g.rate_minute_count := 0; end if;
  if g.rate_day is distinct from v_day then g.rate_day := v_day; g.rate_day_count := 0; end if;
  if g.rate_minute_count >= 120 then
    raise exception using message = 'rate_limited', detail = 'minute',
      hint = ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::text;
  end if;
  if g.rate_day_count >= 3000 then
    raise exception using message = 'rate_limited', detail = 'day',
      hint = ceil(extract(epoch from ((v_day + 1)::timestamp at time zone 'UTC' - now())))::text;
  end if;

  update public.mcp_grants gr set
    rate_minute = g.rate_minute,
    rate_minute_count = g.rate_minute_count + 1,
    rate_day = g.rate_day,
    rate_day_count = g.rate_day_count + 1,
    last_used_at = case when gr.last_used_at is null or gr.last_used_at < now() - interval '1 minute' then now() else gr.last_used_at end
  where gr.id = g.id;

  return query select g.id, g.user_id, g.client_id, g.client_name, g.client_kind, g.scopes, g.resource, t.expires_at,
    g.sb_session_id, g.sb_access_enc, g.sb_access_expires_at, g.sb_refresh_enc, g.sb_lease_until;
end;
$$;

-- Ends a Supabase session (and its refresh tokens): a revoked grant, refresh-token reuse, a
-- consent whose code was wrong.
create or replace function public.mcp_end_session(p_session_id uuid)
returns void
language sql security definer
set search_path = ''
as $$
  delete from auth.sessions where id = p_session_id
$$;

-- ─── Preparing and running actions ───────────────────────────────────────────
-- Stores what Claude prepared. The channel comes from the owner's policy: 'chat' only when the
-- kind is set to 'chat' and the app did not force approval in Mado (an address not on the client
-- record, an action Claude Code's timeout could cut short).
create or replace function public.mcp_create_action(
  p_handle_hash text,
  p_kind        text,
  p_args        jsonb,
  p_args_hash   text,
  p_fingerprint text,
  p_label       text,
  p_preview     jsonb,
  p_force_app   boolean
)
returns table (id uuid, approval text, expires_at timestamptz)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_grant    uuid := public.mcp_session_grant();
  v_approval text;
  v_row      public.mcp_actions%rowtype;
begin
  if v_grant is null or not public.is_app_user() then
    raise exception using errcode = 'MI042', message = 'Only a Claude connection can prepare actions.';
  end if;

  -- What never ran goes after a week, what ran stays on record for 90 days.
  delete from public.mcp_actions a
  where a.grant_id = v_grant
    and ((a.status in ('pending', 'rejected') and a.created_at < now() - interval '7 days')
      or a.created_at < now() - interval '90 days');

  if (select count(*) from public.mcp_actions a
      where a.grant_id = v_grant and a.status = 'pending' and a.expires_at > now()) >= 20 then
    raise exception using message = 'too_many_pending';
  end if;

  v_approval := case
    when coalesce(p_force_app, true) then 'app'
    when coalesce((select s.mcp_confirm_policy ->> p_kind from public.settings s limit 1), 'app') = 'chat' then 'chat'
    else 'app' end;

  insert into public.mcp_actions (handle_hash, grant_id, kind, args, args_hash, fingerprint, label, preview, approval, expires_at)
  values (p_handle_hash, v_grant, p_kind, p_args, p_args_hash, p_fingerprint, p_label, coalesce(p_preview, '{}'), v_approval, now() + interval '15 minutes')
  returning * into v_row;

  return query select v_row.id, v_row.approval, v_row.expires_at;
end;
$$;

-- Claude runs a 'chat' action: only the grant that prepared it, only once, only while pending
-- and unexpired, and only while the owner's policy still lets Claude confirm its kind. A kind
-- switched back to approval in Mado since moves the pending action there: its approval becomes
-- 'app', nothing is claimed and no row is returned (raising would undo the move), so the app
-- answers with the approval link.
create or replace function public.mcp_claim_action(p_handle_hash text)
returns setof public.mcp_actions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_grant uuid := public.mcp_session_grant();
  v_row   public.mcp_actions%rowtype;
begin
  if v_grant is not null and public.is_app_user() then
    update public.mcp_actions a set approval = 'app'
    where a.handle_hash = p_handle_hash and a.grant_id = v_grant and a.approval = 'chat'
      and a.status = 'pending' and a.expires_at > now()
      and coalesce((select s.mcp_confirm_policy ->> a.kind from public.settings s limit 1), 'app') <> 'chat';
    if found then return; end if;

    update public.mcp_actions a set
      status = 'running', claimed_at = now(), claimed_via = 'chat', claimed_session = public.mcp_jwt_session_id()
    where a.handle_hash = p_handle_hash and a.grant_id = v_grant and a.approval = 'chat'
      and a.status = 'pending' and a.expires_at > now()
    returning * into v_row;
  end if;
  if v_row.id is null then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
  return next v_row;
end;
$$;

-- The owner approves in Mado: never from a Claude session, and with mcp_approval_totp on only
-- with an authenticator code entered in the last five minutes. What a revoked connection prepared
-- (refresh-token reuse revokes it as theft) can only be rejected.
create or replace function public.mcp_approve_action(p_id uuid)
returns setof public.mcp_actions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_row    public.mcp_actions%rowtype;
begin
  if not public.is_app_user() or public.is_mcp_session() or public.mcp_jwt_session_id() is null then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;

  if coalesce((select s.mcp_approval_totp from public.settings s limit 1), true) and not exists (
    select 1
    from jsonb_array_elements(case when jsonb_typeof(v_claims -> 'amr') = 'array' then v_claims -> 'amr' else '[]'::jsonb end) e
    where e ->> 'method' = 'totp'
      and case when (e ->> 'timestamp') ~ '^[0-9]+(\.[0-9]+)?$' then (e ->> 'timestamp')::numeric end
        >= extract(epoch from now()) - 300
  ) then
    raise exception using errcode = 'MI043', message = 'Approving needs a fresh authenticator code.';
  end if;

  update public.mcp_actions a set
    status = 'running', claimed_at = now(), claimed_via = 'app', claimed_session = public.mcp_jwt_session_id()
  where a.id = p_id and a.status = 'pending' and a.expires_at > now()
    and exists (select 1 from public.mcp_grants g where g.id = a.grant_id and g.revoked_at is null)
  returning * into v_row;
  if v_row.id is null then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
  return next v_row;
end;
$$;

create or replace function public.mcp_reject_action(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_app_user() or public.is_mcp_session() then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
  update public.mcp_actions a set status = 'rejected', finished_at = now()
  where a.id = p_id and a.status = 'pending';
  if not found then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
end;
$$;

-- The outcome, recorded by the session that claimed the action.
create or replace function public.mcp_finish_action(p_id uuid, p_ok boolean, p_result jsonb, p_error jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_app_user() then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
  update public.mcp_actions a set
    status = case when p_ok then 'done' else 'failed' end, finished_at = now(), result = p_result, error = p_error
  where a.id = p_id and a.status = 'running' and a.claimed_session = public.mcp_jwt_session_id();
  if not found then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
end;
$$;

-- ─── Triggers ────────────────────────────────────────────────────────────────
-- A Claude session neither changes the policy nor replaces the settings row that holds it.
create or replace function public.settings_mcp_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.is_mcp_session() then
    if tg_op <> 'UPDATE' then
      raise exception using errcode = 'MI040', message = 'The confirmation policy cannot be changed from a Claude connection.';
    end if;
    if new.mcp_confirm_policy is distinct from old.mcp_confirm_policy
       or new.mcp_approval_totp is distinct from old.mcp_approval_totp then
      raise exception using errcode = 'MI040', message = 'The confirmation policy cannot be changed from a Claude connection.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists settings_mcp_guard on public.settings;
create trigger settings_mcp_guard
  before update of mcp_confirm_policy, mcp_approval_totp on public.settings
  for each row execute function public.settings_mcp_guard();
drop trigger if exists settings_mcp_guard_rows on public.settings;
create trigger settings_mcp_guard_rows
  before insert or delete on public.settings
  for each row execute function public.settings_mcp_guard();

-- Whatever the insert sent, the actor is the writing session's grant kind, or null; an update
-- keeps it.
create or replace function public.document_events_actor()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.actor := old.actor;
  else
    new.actor := (select g.client_kind from public.mcp_grants g where g.sb_session_id = public.mcp_jwt_session_id());
  end if;
  return new;
end;
$$;

drop trigger if exists document_events_actor on public.document_events;
create trigger document_events_actor
  before insert or update of actor on public.document_events
  for each row execute function public.document_events_actor();

create or replace function public.mcp_calls_prune()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.mcp_calls c where c.created_at < now() - interval '90 days';
  return null;
end;
$$;

drop trigger if exists mcp_calls_prune on public.mcp_calls;
create trigger mcp_calls_prune
  after insert on public.mcp_calls
  for each statement execute function public.mcp_calls_prune();

-- ─── Function privileges ─────────────────────────────────────────────────────
revoke execute on function public.mcp_jwt_session_id() from public, anon;
revoke execute on function public.mcp_session_grant() from public, anon;
revoke execute on function public.is_mcp_session() from public, anon;
revoke execute on function public.mcp_create_action(text, text, jsonb, text, text, text, jsonb, boolean) from public, anon;
revoke execute on function public.mcp_claim_action(text) from public, anon;
revoke execute on function public.mcp_approve_action(uuid) from public, anon;
revoke execute on function public.mcp_reject_action(uuid) from public, anon;
revoke execute on function public.mcp_finish_action(uuid, boolean, jsonb, jsonb) from public, anon;
grant execute on function public.mcp_jwt_session_id() to authenticated;
grant execute on function public.mcp_session_grant() to authenticated;
grant execute on function public.is_mcp_session() to authenticated;
grant execute on function public.mcp_create_action(text, text, jsonb, text, text, text, jsonb, boolean) to authenticated;
grant execute on function public.mcp_claim_action(text) to authenticated;
grant execute on function public.mcp_approve_action(uuid) to authenticated;
grant execute on function public.mcp_reject_action(uuid) to authenticated;
grant execute on function public.mcp_finish_action(uuid, boolean, jsonb, jsonb) to authenticated;

revoke execute on function public.mcp_authenticate(text) from public, anon, authenticated;
revoke execute on function public.mcp_end_session(uuid) from public, anon, authenticated;
grant execute on function public.mcp_authenticate(text) to service_role;
grant execute on function public.mcp_end_session(uuid) to service_role;

-- Trigger functions are never called directly.
revoke execute on function public.settings_mcp_guard() from public, anon, authenticated;
revoke execute on function public.document_events_actor() from public, anon, authenticated;
revoke execute on function public.mcp_calls_prune() from public, anon, authenticated;

-- ─── Claude connector: drafts only, recipients Claude wrote ──────────────────
-- 20261105_mcp_drafts.sql. A Claude session writes the lines of drafts only (MI044), whichever
-- path writes them; replace_document_items locks the document first, so a draft issued while
-- Claude saves it keeps the lines it was issued with. It neither changes what the recurring cron
-- copies from the template of a recurring schedule (either mode, active or paused) nor deletes
-- such a template (MI045). Addresses a Claude session put on a client (clients.mcp_recipients)
-- never count as on the client record until the owner saves the client in Mado: an action whose
-- arguments name one is approved in Mado whatever the policy says, and the reminder cron skips them.
-- A client a Claude session changed (clients.mcp_written_at) gets no automatic reminders, and
-- drafts, not issued invoices, from a schedule that issues automatically, until the owner saves it
-- in Mado. While an action the owner approved in Mado runs, a Claude session writes none of what it
-- reads (MI046), and one action runs at a time, approved in Mado or confirmed in the chat (MI047).
create or replace function public.document_items_mcp_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  if public.is_mcp_session() then
    if tg_op <> 'INSERT' then v_old := old.document_id; end if;
    if tg_op <> 'DELETE' then v_new := new.document_id; end if;
    if exists (
      select 1 from public.documents d
      where d.id in (v_old, v_new) and (d.number is not null or d.status <> 'draft')
    ) then
      raise exception using errcode = 'MI044', message = 'Only a draft''s lines can be changed from a Claude connection.';
    end if;
    if exists (
      select 1 from public.recurring_schedules r
      where r.source_document_id in (v_old, v_new)
    ) then
      raise exception using errcode = 'MI045',
        message = 'The template of a recurring schedule cannot be changed or deleted from a Claude connection.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists document_items_mcp_guard on public.document_items;
create trigger document_items_mcp_guard
  before insert or update or delete on public.document_items
  for each row execute function public.document_items_mcp_guard();

-- ─── Templates of recurring schedules ────────────────────────────────────────
-- What the recurring cron copies into every period's invoice (insertPeriodInvoice in
-- src/lib/utils/recurring.ts: the client, language, tax treatment, notes, discount, Skonto and
-- the lines) stays as the owner left it while a schedule of either mode, active or paused, uses
-- the document as its template: one that creates drafts can be switched to issue them in Mado
-- without the template being opened again. Nor can a Claude session delete such a template.
-- Paying, reminding, issuing, cancelling or a Storno of the template change none of it and stay
-- possible.
-- The client record the template names (its terms give the due date, its address the recipient
-- block) stays writable; the cron leaves the invoice a draft while clients.mcp_written_at is set.
create or replace function public.documents_mcp_template_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.is_mcp_session() and exists (
    select 1 from public.recurring_schedules r where r.source_document_id = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception using errcode = 'MI045',
        message = 'The template of a recurring schedule cannot be changed or deleted from a Claude connection.';
    end if;
    if (new.client_id, new.language, new.tax_treatment, new.notes, new.discount_type, new.discount_value, new.skonto_percent, new.skonto_days)
       is distinct from (old.client_id, old.language, old.tax_treatment, old.notes, old.discount_type, old.discount_value, old.skonto_percent, old.skonto_days) then
      raise exception using errcode = 'MI045',
        message = 'The template of a recurring schedule cannot be changed or deleted from a Claude connection.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists documents_mcp_template_guard on public.documents;
create trigger documents_mcp_template_guard
  before update of client_id, language, tax_treatment, notes, discount_type, discount_value, skonto_percent, skonto_days or delete
  on public.documents
  for each row execute function public.documents_mcp_template_guard();

-- The addresses in a client's email field and CC list (or in any text): split on what JavaScript's
-- \s matches and on , ; < >, with A-Z lower-cased and nothing else. Both are spelled out rather
-- than left to the database locale (lower() folds U+0130 'İ' to 'i' under glibc but to 'i' + U+0307
-- in JavaScript; [[:space:]] matches U+0085 under ICU but not in JavaScript), because the reminder
-- cron repeats this in the app (mcpAddressSet in src/lib/services/email-compose.ts) to compare the
-- marks, and the app's address checks split on \s.
create or replace function public.mcp_address_set(p_values text[])
returns text[]
language sql immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct a.addr order by a.addr), '{}')
  from unnest(coalesce(p_values, '{}')) v(val),
       regexp_split_to_table(
         translate(coalesce(v.val, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
         '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff,;<>]+') a(addr)
  where a.addr like '_%@_%'
$$;

-- An earlier version of this migration folded the addresses with lower() and split them on the
-- locale's [[:space:]]. Where one was applied (clients.mcp_recipients exists, mcp_written_at not
-- yet), the marks it stored are redone once here, failing closed until the owner saves the client
-- in Mado. Marked are: every address on a client with a mark that names none of its addresses as
-- mcp_address_set now gives them (a mark in the earlier form, its address unknown;
-- clients_mcp_recipients does the same on the client's next write); an address with a character
-- that [[:space:]] matches and \s does not (U+0085 under ICU), where the earlier split cut it and
-- may have left it unmarked; an address that lower() changes or makes equal to another one on the
-- client, which the earlier fold may have taken for an address already there and left unmarked.
-- That version had no mcp_written_at, so what Claude changed on a client under it is not known:
-- the column is added here and set on every client with a mark after the redo and on every client
-- created since the first Claude connection, so the crons and the archive copy hold them until the
-- owner saves them in Mado. A change Claude made under it to the name, company, UID or terms of
-- another client, with no address, left no trace (README: the owner checks and saves those).
-- The two triggers below are bypassed for this one update, inside this statement.
do $$
declare
  v_triggers text[];
  v_trigger  text;
begin
  if not exists (select 1 from pg_catalog.pg_attribute
                 where attrelid = 'public.clients'::regclass and attname = 'mcp_recipients' and not attisdropped)
     or exists (select 1 from pg_catalog.pg_attribute
                where attrelid = 'public.clients'::regclass and attname = 'mcp_written_at' and not attisdropped) then
    return;
  end if;
  v_triggers := array(
    select t.tgname::text from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.clients'::regclass and t.tgenabled <> 'D'
      and t.tgname in ('clients_mcp_recipients', 'clients_mcp_recipients_seen'));
  foreach v_trigger in array v_triggers loop
    execute format('alter table public.clients disable trigger %I', v_trigger);
  end loop;
  update public.clients c set mcp_recipients = r.marks
  from (
    select c2.id, array(
      select a from unnest(s.addrs) a
      where a = any(c2.mcp_recipients)
         or not c2.mcp_recipients <@ s.addrs
         or a ~ '[[:space:]]'
         or lower(a) <> a
         or exists (select 1 from unnest(s.addrs) b where b <> a and lower(b) = lower(a))
      order by a) as marks
    from public.clients c2,
         lateral (select public.mcp_address_set(array[c2.email] || coalesce(c2.cc_emails, '{}')) as addrs) s
  ) r
  where r.id = c.id and c.mcp_recipients is distinct from r.marks;
  alter table public.clients add column mcp_written_at timestamptz;
  execute $q$
    update public.clients set mcp_written_at = now()
    where cardinality(mcp_recipients) > 0
       or created_at >= (select min(g.created_at) from public.mcp_grants g)
  $q$;
  foreach v_trigger in array v_triggers loop
    execute format('alter table public.clients enable trigger %I', v_trigger);
  end loop;
end;
$$;

-- A Claude session: the addresses it adds are marked, marked ones that stay keep their mark, and
-- a write that changes the client sets mcp_written_at. The browser (and the service role): a new
-- client has neither; an update keeps the marks of the addresses still there and mcp_written_at
-- (clients_mcp_recipients_seen clears both when the owner saves the address fields). A mark that
-- names none of the client's addresses was stored by an earlier version of mcp_address_set (see
-- above): the address it stood for is unknown, so every address on the client counts as marked.
create or replace function public.clients_mcp_recipients()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_now    text[] := public.mcp_address_set(array[new.email] || coalesce(new.cc_emails, '{}'));
  v_before text[] := '{}';
  v_marked text[] := '{}';
begin
  if tg_op = 'UPDATE' then
    v_before := public.mcp_address_set(array[old.email] || coalesce(old.cc_emails, '{}'));
    v_marked := coalesce(old.mcp_recipients, '{}');
    if not v_marked <@ v_before then v_marked := v_before; end if;
  end if;
  if public.is_mcp_session() then
    new.mcp_recipients := array(select a from unnest(v_now) a where a = any(v_marked) or not a = any(v_before) order by a);
    new.mcp_written_at := now();
    if tg_op = 'UPDATE' then
      if (to_jsonb(new) - 'mcp_recipients' - 'mcp_written_at') is not distinct from (to_jsonb(old) - 'mcp_recipients' - 'mcp_written_at') then
        new.mcp_written_at := old.mcp_written_at;
      end if;
    end if;
  elsif tg_op = 'INSERT' then
    new.mcp_recipients := '{}';
    new.mcp_written_at := null;
  else
    new.mcp_recipients := array(select a from unnest(v_now) a where a = any(v_marked) order by a);
    new.mcp_written_at := old.mcp_written_at;
  end if;
  return new;
end;
$$;

-- The owner saved the client's address fields in Mado (the client form always sends both): the
-- addresses on it, and the rest of what Claude wrote there, are the owner's now. Runs after
-- clients_mcp_recipients (triggers run in name order).
create or replace function public.clients_mcp_recipients_seen()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_mcp_session() then
    new.mcp_recipients := '{}';
    new.mcp_written_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clients_mcp_recipients on public.clients;
create trigger clients_mcp_recipients
  before insert or update on public.clients
  for each row execute function public.clients_mcp_recipients();
drop trigger if exists clients_mcp_recipients_seen on public.clients;
create trigger clients_mcp_recipients_seen
  before update of email, cc_emails on public.clients
  for each row execute function public.clients_mcp_recipients_seen();

-- Any text in a prepared action's arguments (recipients, subject, body) that names an address a
-- Claude session wrote onto a client sends the action to Mado for approval. mcp_create_action
-- returns the stored channel.
create or replace function public.mcp_actions_recipients()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.approval = 'chat' and exists (
    select 1
    from jsonb_path_query(new.args, 'strict $.** ? (@.type() == "string")') s(val),
         unnest(public.mcp_address_set(array[s.val #>> '{}'])) a(addr),
         public.clients c
    where a.addr = any(c.mcp_recipients)
  ) then
    new.approval := 'app';
  end if;
  return new;
end;
$$;

drop trigger if exists mcp_actions_recipients on public.mcp_actions;
create trigger mcp_actions_recipients
  before insert on public.mcp_actions
  for each row execute function public.mcp_actions_recipients();

-- ─── Payments Claude changed ─────────────────────────────────────────────────
-- A payment, fee, Skonto, write-off or applied credit on an invoice, or a refund on a credit note,
-- that a Claude session records, changes or removes sets documents.mcp_payments_at on that
-- document, and an applied credit also on the credit note it names (credit_note_id): the credit
-- settles the credit note, and a settled credit note's refunds are booked. The mark stays until
-- the owner confirms the document's payments on its page in Mado. Meanwhile the reminder cron
-- skips the invoice and its automatic Bookamat step the document
-- (src/app/api/cron/reminders/route.ts, autoSyncBookamat in src/lib/bookamat.ts), no archive copy
-- is made of it (getIssuedPdf in src/lib/pdf/snapshot.ts) and the portal shows no payments,
-- balance or payment details on it: a removed row reopens a paid invoice or raises what is open, a
-- recorded one is listed as received, and a booking takes its date, its amount and its account
-- (bank or Kassa) from the rows, so a Mahnung, a booking or a frozen PDF would carry what Claude
-- wrote without anyone approving it. A Claude session only ever sets or moves the mark forward
-- (documents_mcp_payments_guard); the owner's browser clears it.
-- An earlier version of this migration had no mark, marked invoices only, or did not mark the
-- credit note an applied credit names. Where one without the mark or with invoices only was
-- applied, every invoice and credit note with a payment or refund recorded or removed from a
-- Claude connection (document_events.actor) is marked once here, so the crons hold it until the
-- owner confirms its payments in Mado (also one confirmed before: confirming now releases the
-- Bookamat sync as well). Where any earlier version was applied, so is every credit note a credit
-- recorded from a Claude connection names (its payment_added event on the invoice).
do $$
declare
  v_had  boolean := exists (select 1 from pg_catalog.pg_attribute
                            where attrelid = 'public.documents'::regclass and attname = 'mcp_payments_at' and not attisdropped);
  v_mark text := (select p.prosrc from pg_catalog.pg_proc p where p.oid = to_regprocedure('public.payments_mcp_mark()'));
begin
  if v_had and v_mark like '%credit_note_id%' then
    return;
  end if;
  alter table public.documents add column if not exists mcp_payments_at timestamptz;
  if not v_had or v_mark like '%d.type = ''invoice''%' then
    execute $q$
      update public.documents d set mcp_payments_at = now()
      where d.type in ('invoice', 'credit_note') and d.mcp_payments_at is null
        and exists (select 1 from public.document_events e
                    where e.document_id = d.id and e.actor is not null
                      and e.type in ('payment_added', 'payment_removed'))
    $q$;
  end if;
  execute $q$
    update public.documents d set mcp_payments_at = now()
    where d.type = 'credit_note' and d.mcp_payments_at is null
      and d.id::text in (select e.detail ->> 'credit_note_id' from public.document_events e
                         where e.actor is not null and e.type in ('payment_added', 'payment_removed')
                           and e.detail ->> 'kind' = 'credit')
  $q$;
end;
$$;
create or replace function public.payments_mcp_mark()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old    uuid;
  v_new    uuid;
  v_old_cn uuid;
  v_new_cn uuid;
begin
  if public.is_mcp_session() then
    if tg_op <> 'INSERT' then v_old := old.document_id; v_old_cn := old.credit_note_id; end if;
    if tg_op <> 'DELETE' then v_new := new.document_id; v_new_cn := new.credit_note_id; end if;
    update public.documents d set mcp_payments_at = now()
    where d.id in (v_old, v_new, v_old_cn, v_new_cn);
  end if;
  return null;
end;
$$;

create or replace function public.documents_mcp_payments_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.is_mcp_session() then
    new.mcp_payments_at := greatest(old.mcp_payments_at, new.mcp_payments_at);
  end if;
  return new;
end;
$$;

drop trigger if exists payments_mcp_mark on public.payments;
create trigger payments_mcp_mark
  after insert or update or delete on public.payments
  for each row execute function public.payments_mcp_mark();
drop trigger if exists documents_mcp_payments_guard on public.documents;
create trigger documents_mcp_payments_guard
  before update of mcp_payments_at on public.documents
  for each row execute function public.documents_mcp_payments_guard();

-- ─── Approved actions while they run ─────────────────────────────────────────
-- An action the owner approved in Mado is claimed (mcp_approve_action: status 'running',
-- claimed_via 'app'), its fingerprint is compared once more, and it runs on the owner's session
-- (runClaimed in src/lib/mcp/confirm.ts). Issuing takes seconds per document (the number, the PDF
-- rendered and stored, the Drive copy), and a draft later in the batch is still an unnumbered draft
-- meanwhile; an email, a reminder or a booking reads the client and the rows it is made of as the
-- run goes. So while the run lasts, a Claude session writes nothing it reads: the documents its
-- arguments name (document_ids, document_id, invoice_id, the draft or client to delete) and the
-- invoice a credit note among them corrects (issuing it applies its credit there), their lines and
-- payments (also a credit that names such a credit note), the advance and partial invoices such a
-- final invoice deducts (final_invoice_id before or after the write: linking or unlinking one, or a
-- payment that marks it) and the clients of those documents (MI046). A Claude write committed
-- before the claim changes the fingerprint and stops the run; one after it is refused here. The
-- hold ends with the run, or ten minutes after the claim at most (STALE_RUN_MS in
-- src/lib/mcp/confirm.ts: a run that died with its function). An action Claude confirms in the chat
-- runs on Claude's own session, which this cannot tell apart from Claude's other writes; that run,
-- like an approved one, compares each draft again just before its number is taken and before the
-- email goes out (src/lib/mcp/actions/issue.ts), and no other action runs meanwhile
-- (mcp_actions_one_run below). The owner's browser, the crons and the approved run itself are not
-- affected.
create index if not exists mcp_actions_running_idx on public.mcp_actions(claimed_at) where status = 'running';

-- Whether such a run names one of the documents or clients (a credit note it names also names the
-- invoice it corrects), or a document of one of the clients. Arguments that are no uuid name nothing.
create or replace function public.mcp_approved_run_holds(p_documents uuid[], p_clients uuid[])
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_documents uuid[];
  v_clients   uuid[];
begin
  select coalesce(array_agg(n.val::uuid) filter (where n.what = 'document'), '{}'),
         coalesce(array_agg(n.val::uuid) filter (where n.what = 'client'), '{}')
    into v_documents, v_clients
  from public.mcp_actions a,
       lateral (
         select e.val, 'document' from jsonb_array_elements_text(
           case when jsonb_typeof(a.args -> 'document_ids') = 'array' then a.args -> 'document_ids' else '[]'::jsonb end) e(val)
         union all select a.args ->> 'document_id', 'document'
         union all select a.args ->> 'invoice_id', 'document'
         union all select a.args ->> 'id', case a.args ->> 'kind' when 'draft' then 'document' when 'client' then 'client' end
           where a.kind = 'delete'
       ) n(val, what)
  where a.status = 'running' and a.claimed_via = 'app' and a.claimed_at > now() - interval '10 minutes'
    and n.what is not null
    and n.val ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_documents := v_documents
    || coalesce((select array_agg(d.converted_from_id) from public.documents d
                 where d.id = any(v_documents) and d.type = 'credit_note' and d.converted_from_id is not null), '{}');
  return v_documents && p_documents
      or v_clients && p_clients
      or exists (select 1 from public.documents d where d.id = any(v_documents) and d.client_id = any(p_clients));
end;
$$;

-- A Claude session's update or delete of a document or client, and any write of a line or payment
-- (of the document, or naming a credit note in credit_note_id), that such a run reads. A document
-- also counts for the final invoice that deducts it, before and after the write: issuing a final
-- invoice reads the invoices it deducts (src/lib/deposits.ts loadDepositCheck), and unlinking one
-- (unlinkDeposit) is a write of that invoice alone.
create or replace function public.mcp_approved_run_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_documents uuid[] := '{}';
  v_clients   uuid[] := '{}';
begin
  if public.is_mcp_session() then
    if tg_table_name = 'clients' then
      v_clients := array[old.id];
    elsif tg_table_name = 'documents' then
      v_documents := array[old.id, old.final_invoice_id];
      if tg_op <> 'DELETE' then v_documents := v_documents || new.final_invoice_id; end if;
    else
      if tg_op <> 'INSERT' then v_documents := array[old.document_id]; end if;
      if tg_op <> 'DELETE' then v_documents := v_documents || new.document_id; end if;
      if tg_table_name = 'payments' then
        if tg_op <> 'INSERT' then v_documents := v_documents || old.credit_note_id; end if;
        if tg_op <> 'DELETE' then v_documents := v_documents || new.credit_note_id; end if;
      end if;
    end if;
    if public.mcp_approved_run_holds(v_documents, v_clients) then
      raise exception using errcode = 'MI046',
        message = 'An action the owner approved is running on this document, its client, the final invoice that deducts it or a credit note that corrects it. Try again when it has finished.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists documents_mcp_run_guard on public.documents;
create trigger documents_mcp_run_guard
  before update or delete on public.documents
  for each row execute function public.mcp_approved_run_guard();
drop trigger if exists document_items_mcp_run_guard on public.document_items;
create trigger document_items_mcp_run_guard
  before insert or update or delete on public.document_items
  for each row execute function public.mcp_approved_run_guard();
drop trigger if exists payments_mcp_run_guard on public.payments;
create trigger payments_mcp_run_guard
  before insert or update or delete on public.payments
  for each row execute function public.mcp_approved_run_guard();
drop trigger if exists clients_mcp_run_guard on public.clients;
create trigger clients_mcp_run_guard
  before update or delete on public.clients
  for each row execute function public.mcp_approved_run_guard();

-- ─── One action at a time ────────────────────────────────────────────────────
-- Whether the owner approved it in Mado (mcp_approve_action) or Claude confirmed it in the chat
-- (mcp_claim_action), one action runs at a time. One confirmed in the chat runs on Claude's own
-- session, so while one approved in Mado holds what it touches, the guard above refuses what it
-- writes as it goes, whichever of the two started first: an email or a Mahnung goes out and the
-- record of it (sent_at, reminder_sent_at, reminder_level) is refused and only logged, so the
-- reminder cron sends the same level again, or a credit note is numbered without its credit on the
-- invoice it corrects. So a claim (pending -> running, either channel) is refused (MI047) while
-- another action runs, claimed in the last ten minutes (STALE_RUN_MS in src/lib/mcp/confirm.ts: a
-- run that died with its function stops counting then). The raise undoes the claim: the action
-- stays pending, and Claude confirms it again or the owner approves it again once the other one
-- has finished. Two claims in the same instant take a transaction-scoped advisory lock on a fixed
-- key one after the other; the second then reads what the first committed (each query reads what
-- was committed before it, read committed as PostgREST runs it) and is refused. mcp_claim_action
-- moving an action to Mado changes its approval, not its status, and is not affected. An earlier
-- version of this migration refused only a chat claim, and only on what an approved run held
-- (mcp_actions_chat_claim_guard): dropped here.
drop trigger if exists mcp_actions_chat_claim_guard on public.mcp_actions;
drop function if exists public.mcp_actions_chat_claim_guard();
create or replace function public.mcp_actions_one_run()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status = 'running' and old.status = 'pending' then
    perform pg_advisory_xact_lock(20261105047);
    if exists (select 1 from public.mcp_actions a
               where a.id <> new.id and a.status = 'running' and a.claimed_at > now() - interval '10 minutes') then
      raise exception using errcode = 'MI047',
        message = 'Another action is running. This one was not started and stays prepared: confirm or approve it again when that one has finished (ten minutes at most if it stopped unexpectedly).';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists mcp_actions_one_run on public.mcp_actions;
create trigger mcp_actions_one_run
  before update of status on public.mcp_actions
  for each row execute function public.mcp_actions_one_run();

revoke execute on function public.mcp_address_set(text[]) from public, anon;
grant execute on function public.mcp_address_set(text[]) to authenticated;
revoke execute on function public.document_items_mcp_guard() from public, anon, authenticated;
revoke execute on function public.documents_mcp_template_guard() from public, anon, authenticated;
revoke execute on function public.clients_mcp_recipients() from public, anon, authenticated;
revoke execute on function public.clients_mcp_recipients_seen() from public, anon, authenticated;
revoke execute on function public.mcp_actions_recipients() from public, anon, authenticated;
revoke execute on function public.payments_mcp_mark() from public, anon, authenticated;
revoke execute on function public.documents_mcp_payments_guard() from public, anon, authenticated;
revoke execute on function public.mcp_approved_run_holds(uuid[], uuid[]) from public, anon, authenticated;
revoke execute on function public.mcp_approved_run_guard() from public, anon, authenticated;
revoke execute on function public.mcp_actions_one_run() from public, anon, authenticated;

-- ─── Storage: issued documents ───────────────────────────────────────────────
-- The PDF of every issued document is stored once in this private bucket (documents.pdf_path)
-- and served from there, so later edits to the client, settings or lines cannot change it.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "documents owner select" on storage.objects;
drop policy if exists "documents owner insert" on storage.objects;
drop policy if exists "documents owner update" on storage.objects;
drop policy if exists "documents owner delete" on storage.objects;

create policy "documents owner select" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and is_app_user());

create policy "documents owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and is_app_user());

create policy "documents owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'documents' and is_app_user())
  with check (bucket_id = 'documents' and is_app_user());

create policy "documents owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and is_app_user());

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
