-- Client data, catalogue descriptions and document numbering:
--   * settings is a singleton (exactly one row)
--   * clients.country holds an ISO 3166-1 alpha-2 code; known free-text names are mapped
--   * clients.client_number (K-0001), assigned by a trigger on every insert path
--   * clients.payment_days NULL = use settings.default_payment_days; EUR is the only currency
--   * catalogue_items.description_de/en (long text prefilled under the line name)
--   * numbering: tokens from the document date, optional yearly restart per document type,
--     no issue more than one day ahead, format must contain a counter, no number reused
-- Every statement is a no-op when already applied, so the file can be run any number of times.

-- ─── settings: one row ──────────────────────────────────────────────────────
do $$
declare n integer;
begin
  select count(*) into n from settings;
  if n > 1 then
    raise exception 'settings has % rows; keep the one the app uses, delete the others and run this file again', n;
  end if;
end $$;

insert into settings (id) select uuid_generate_v4() where not exists (select 1 from settings);

create unique index if not exists settings_singleton on settings ((true));

alter table settings
  add column if not exists next_client_number              integer not null default 1,
  add column if not exists invoice_counter_year            integer,
  add column if not exists quote_counter_year              integer,
  add column if not exists credit_note_counter_year        integer,
  add column if not exists invoice_number_reset_yearly     boolean not null default false,
  add column if not exists quote_number_reset_yearly       boolean not null default false,
  add column if not exists credit_note_number_reset_yearly boolean not null default false;

-- The year each running counter belongs to, so turning on the yearly restart later knows
-- whether the current series is last year's.
update settings set invoice_counter_year = (
  select max(extract(year from date))::integer from documents where type = 'invoice' and number is not null
) where invoice_counter_year is null;
update settings set quote_counter_year = (
  select max(extract(year from date))::integer from documents where type = 'quote' and number is not null
) where quote_counter_year is null;
update settings set credit_note_counter_year = (
  select max(extract(year from date))::integer from documents where type = 'credit_note' and number is not null
) where credit_note_counter_year is null;

-- ─── clients: payment days ──────────────────────────────────────────────────
alter table clients alter column payment_days drop not null;
alter table clients alter column payment_days drop default;

-- One-time, together with the client_number column: the old form saved a blank "payment days"
-- as 14, so every client carried a value and the settings default never applied. Clients whose
-- value equals the current default follow the default from now on; their due dates do not change.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clients' and column_name = 'client_number'
  ) then
    alter table clients add column client_number text;
    update clients set payment_days = null
    where payment_days = (select default_payment_days from settings limit 1);
  end if;
end $$;

update clients set payment_days = null where payment_days < 0 or payment_days > 365;
alter table clients drop constraint if exists clients_payment_days_check;
alter table clients add constraint clients_payment_days_check
  check (payment_days is null or payment_days between 0 and 365);

-- ─── clients: EUR only ──────────────────────────────────────────────────────
update clients set currency = 'EUR' where currency is distinct from 'EUR';

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.clients'::regclass
      and con.contype = 'c'
      and att.attname = 'currency'
  loop
    execute format('alter table public.clients drop constraint %I', c.conname);
  end loop;

  alter table public.clients add constraint clients_currency_check check (currency = 'EUR');
end $$;

-- ─── clients: ISO country codes ─────────────────────────────────────────────
-- Values that match no name below stay as they are; the client form asks to pick a code.
update clients c
set country = m.code
from (values
  ('AT','AT'), ('AT','A'), ('AT','Austria'), ('AT','Österreich'), ('AT','Oesterreich'),
  ('BE','BE'), ('BE','Belgium'), ('BE','Belgien'),
  ('BG','BG'), ('BG','Bulgaria'), ('BG','Bulgarien'),
  ('HR','HR'), ('HR','Croatia'), ('HR','Kroatien'),
  ('CY','CY'), ('CY','Cyprus'), ('CY','Zypern'),
  ('CZ','CZ'), ('CZ','Czechia'), ('CZ','Czech Republic'), ('CZ','Tschechien'), ('CZ','Tschechische Republik'),
  ('DK','DK'), ('DK','Denmark'), ('DK','Dänemark'), ('DK','Daenemark'),
  ('EE','EE'), ('EE','Estonia'), ('EE','Estland'),
  ('FI','FI'), ('FI','Finland'), ('FI','Finnland'),
  ('FR','FR'), ('FR','France'), ('FR','Frankreich'),
  ('DE','DE'), ('DE','D'), ('DE','Germany'), ('DE','Deutschland'),
  ('GR','GR'), ('GR','EL'), ('GR','Greece'), ('GR','Griechenland'),
  ('HU','HU'), ('HU','Hungary'), ('HU','Ungarn'),
  ('IE','IE'), ('IE','Ireland'), ('IE','Irland'),
  ('IT','IT'), ('IT','Italy'), ('IT','Italien'),
  ('LV','LV'), ('LV','Latvia'), ('LV','Lettland'),
  ('LT','LT'), ('LT','Lithuania'), ('LT','Litauen'),
  ('LU','LU'), ('LU','Luxembourg'), ('LU','Luxemburg'),
  ('MT','MT'), ('MT','Malta'),
  ('NL','NL'), ('NL','Netherlands'), ('NL','The Netherlands'), ('NL','Niederlande'), ('NL','Holland'),
  ('PL','PL'), ('PL','Poland'), ('PL','Polen'),
  ('PT','PT'), ('PT','Portugal'),
  ('RO','RO'), ('RO','Romania'), ('RO','Rumänien'), ('RO','Rumaenien'),
  ('SK','SK'), ('SK','Slovakia'), ('SK','Slowakei'),
  ('SI','SI'), ('SI','Slovenia'), ('SI','Slowenien'),
  ('ES','ES'), ('ES','Spain'), ('ES','Spanien'),
  ('SE','SE'), ('SE','Sweden'), ('SE','Schweden'),
  ('CH','CH'), ('CH','Switzerland'), ('CH','Schweiz'),
  ('LI','LI'), ('LI','Liechtenstein'),
  ('NO','NO'), ('NO','Norway'), ('NO','Norwegen'),
  ('GB','GB'), ('GB','UK'), ('GB','United Kingdom'), ('GB','Great Britain'), ('GB','Großbritannien'), ('GB','Grossbritannien'), ('GB','Vereinigtes Königreich'),
  ('US','US'), ('US','USA'), ('US','United States'), ('US','Vereinigte Staaten')
) as m(code, name)
-- lower() on both sides, so the match holds even where the database locale cannot fold Ö/Ä.
where lower(btrim(c.country)) = lower(m.name)
  and c.country is distinct from m.code;

-- ─── clients: client number ─────────────────────────────────────────────────
create or replace function format_client_number(n integer)
returns text language sql immutable as $$
  select 'K-' || lpad(n::text, greatest(4, length(n::text)), '0')
$$;

create unique index if not exists clients_client_number_key on clients(client_number);

-- Existing clients are numbered in the order they were created.
do $$
declare
  s     settings%rowtype;
  added integer;
begin
  select * into s from settings limit 1 for update;
  with todo as (
    select id, row_number() over (order by created_at, id) - 1 as k
    from clients
    where client_number is null
  )
  update clients c
  set client_number = format_client_number(s.next_client_number + todo.k::integer)
  from todo
  where c.id = todo.id;
  get diagnostics added = row_count;
  if added > 0 then
    update settings set next_client_number = next_client_number + added where id = s.id;
  end if;
end $$;

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

drop trigger if exists clients_assign_number on clients;
create trigger clients_assign_number
  before insert on clients
  for each row execute function assign_client_number();

-- ─── catalogue ───────────────────────────────────────────────────────────────
alter table catalogue_items
  add column if not exists description_de text,
  add column if not exists description_en text;

-- Writes only sort_order, in one statement, in the order of p_ids.
create or replace function reorder_catalogue_items(p_ids uuid[])
returns void language sql as $$
  update catalogue_items c
  set sort_order = (x.ord::integer - 1) * 10
  from unnest(p_ids) with ordinality as x(id, ord)
  where c.id = x.id
$$;

-- ─── numbering ───────────────────────────────────────────────────────────────
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
-- Error codes: MI002 = the date lies in a numbering year that has already been closed,
-- MI003 = the format has no counter token.
drop function if exists next_document_number(text);

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
        message = format('Numbering for %s has already started, so a document dated %s can no longer be numbered. Date it in %s or later and put the earlier period in the service date.', cy, d, cy);
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
-- Error code MI001 = the document date is more than one day in the future (Vienna time).
alter table documents add column if not exists issued_at timestamptz;

create or replace function issue_document(p_document_id uuid)
returns text language plpgsql as $$
declare
  d      documents%rowtype;
  today  date := (now() at time zone 'Europe/Vienna')::date;
  result text;
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

  result := next_document_number(d.type, coalesce(d.date, today));

  update documents
  set number = result,
      status = case when status = 'draft' then 'sent' else status end,
      issued_at = coalesce(issued_at, now())
  where id = d.id;
  return result;
end;
$$;
