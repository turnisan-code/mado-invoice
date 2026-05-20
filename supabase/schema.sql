-- Studio Invoice — Supabase schema
-- Run this in the Supabase SQL editor to initialise your database.

create extension if not exists "uuid-ossp";

-- ─── Settings ────────────────────────────────────────────────────────────────
create table settings (
  id                    uuid primary key default uuid_generate_v4(),
  company_name          text not null default '',
  owner_name            text not null default '',
  address_line1         text not null default '',
  address_line2         text,
  zip                   text not null default '',
  city                  text not null default '',
  country               text not null default 'Austria',
  email                 text not null default '',
  phone                 text,
  website               text,
  uid_number            text not null default '',
  iban                  text not null default '',
  bic                   text not null default '',
  bank_name             text,
  invoice_prefix        text not null default 'R',
  quote_prefix          text not null default 'A',
  credit_note_prefix    text not null default 'G',
  next_invoice_number        integer not null default 1,
  next_quote_number          integer not null default 1,
  next_credit_note_number    integer not null default 1,
  invoice_number_format      text not null default '{prefix}-{YYYY}-{NNN}',
  quote_number_format        text not null default '{prefix}-{YYYY}-{NNN}',
  credit_note_number_format  text not null default '{prefix}-{YYYY}-{NNN}',
  default_payment_days  integer not null default 14,
  default_language      text not null default 'de',
  logo_url              text,
  invoice_footer_de     text,
  invoice_footer_en     text,
  created_at            timestamptz not null default now()
);

-- Only ever one row
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
  notes         text
);

-- ─── Service Catalogue ───────────────────────────────────────────────────────
create table catalogue_items (
  id            uuid primary key default uuid_generate_v4(),
  name_de       text not null,
  name_en       text not null,
  default_price numeric(10,2) not null default 0,
  unit          text not null default 'day' check (unit in ('hour','day','flat','piece','month')),
  vat_rate      integer not null default 20 check (vat_rate in (0,10,13,20)),
  category      text,
  sort_order    integer not null default 0,
  active        boolean not null default true
);

-- Seed with studio defaults
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
  id                uuid primary key default uuid_generate_v4(),
  created_at        timestamptz not null default now(),
  type              text not null check (type in ('invoice','quote','credit_note')),
  number            text not null unique,
  client_id         uuid not null references clients(id) on delete restrict,
  date              date not null default current_date,
  service_date      date,
  due_date          date,
  status            text not null default 'draft' check (status in ('draft','sent','paid','overdue','accepted','rejected','cancelled')),
  language          text not null default 'de' check (language in ('de','en')),
  currency          text not null default 'EUR',
  tax_treatment     text not null default 'at_vat',
  exchange_rate     numeric(10,6) not null default 1,
  notes             text,
  notes_internal    text,
  converted_from_id uuid references documents(id)
);

create index on documents(client_id);
create index on documents(type, status);
create index on documents(date);

-- ─── Document Items ───────────────────────────────────────────────────────────
create table document_items (
  id                uuid primary key default uuid_generate_v4(),
  document_id       uuid not null references documents(id) on delete cascade,
  sort_order        integer not null default 0,
  description       text not null,
  quantity          numeric(10,4) not null default 1,
  unit              text not null default 'flat',
  unit_price        numeric(10,2) not null default 0,
  vat_rate          integer not null default 20,
  catalogue_item_id uuid references catalogue_items(id)
);

create index on document_items(document_id);

-- ─── Payments ─────────────────────────────────────────────────────────────────
create table payments (
  id          uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  date        date not null default current_date,
  amount      numeric(10,2) not null,
  note        text
);

create index on payments(document_id);

-- ─── Atomic invoice number generation ────────────────────────────────────────
create or replace function next_document_number(doc_type text)
returns text language plpgsql as $$
declare
  s      settings%rowtype;
  num    integer;
  prefix text;
  fmt    text;
  result text;
begin
  select * into s from settings limit 1;
  if doc_type = 'invoice' then
    num    := s.next_invoice_number;
    prefix := s.invoice_prefix;
    fmt    := s.invoice_number_format;
    update settings set next_invoice_number = next_invoice_number + 1;
  elsif doc_type = 'quote' then
    num    := s.next_quote_number;
    prefix := s.quote_prefix;
    fmt    := s.quote_number_format;
    update settings set next_quote_number = next_quote_number + 1;
  else
    num    := s.next_credit_note_number;
    prefix := s.credit_note_prefix;
    fmt    := s.credit_note_number_format;
    update settings set next_credit_note_number = next_credit_note_number + 1;
  end if;

  result := fmt;
  result := replace(result, '{prefix}', prefix);
  result := replace(result, '{YYYY}',   to_char(current_date, 'YYYY'));
  result := replace(result, '{YY}',     to_char(current_date, 'YY'));
  result := replace(result, '{MM}',     to_char(current_date, 'MM'));
  result := replace(result, '{NNNN}',   lpad(num::text, 4, '0'));
  result := replace(result, '{NNN}',    lpad(num::text, 3, '0'));
  result := replace(result, '{NN}',     lpad(num::text, 2, '0'));
  result := replace(result, '{N}',      num::text);

  return result;
end;
$$;

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table settings        enable row level security;
alter table clients         enable row level security;
alter table catalogue_items enable row level security;
alter table documents       enable row level security;
alter table document_items  enable row level security;
alter table payments        enable row level security;

-- Single authenticated user owns everything
create policy "owner" on settings        for all using (auth.role() = 'authenticated');
create policy "owner" on clients         for all using (auth.role() = 'authenticated');
create policy "owner" on catalogue_items for all using (auth.role() = 'authenticated');
create policy "owner" on documents       for all using (auth.role() = 'authenticated');
create policy "owner" on document_items  for all using (auth.role() = 'authenticated');
create policy "owner" on payments        for all using (auth.role() = 'authenticated');
