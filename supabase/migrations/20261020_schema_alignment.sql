-- Brings an EXISTING database in line with supabase/schema.sql. Production acquired several
-- columns and dropped several NOT NULLs by hand, outside any migration; this records that
-- state. Every statement is a no-op when the column or constraint already has the right
-- shape, so the file can be run any number of times.
--
-- Functions and the app_users RLS policies are not repeated here: the 20261019_* migrations
-- already define them with create or replace / drop policy if exists.

-- ─── settings ────────────────────────────────────────────────────────────────
alter table settings
  add column if not exists invoice_number_format        text not null default '{prefix}-{YYYY}-{NNN}',
  add column if not exists quote_number_format          text not null default '{prefix}-{YYYY}-{NNN}',
  add column if not exists credit_note_number_format    text not null default '{prefix}-{YYYY}-{NNN}',
  add column if not exists logo_url                     text,
  add column if not exists invoice_footer_de            text,
  add column if not exists invoice_footer_en            text,
  add column if not exists quote_footer_de              text,
  add column if not exists quote_footer_en              text,
  add column if not exists credit_note_footer_de        text,
  add column if not exists credit_note_footer_en        text,
  add column if not exists tax_note_reverse_charge_de   text,
  add column if not exists tax_note_reverse_charge_en   text,
  add column if not exists tax_note_non_eu_de           text,
  add column if not exists tax_note_non_eu_en           text,
  add column if not exists gmail_email                  text,
  add column if not exists gmail_access_token           text,
  add column if not exists gmail_refresh_token          text,
  add column if not exists gmail_token_expiry           bigint,
  add column if not exists drive_folder_id              text,
  add column if not exists drive_folder_name            text,
  add column if not exists bookamat_username            text,
  add column if not exists bookamat_api_key             text,
  add column if not exists bookamat_country             text default 'at',
  add column if not exists bookamat_bank_account_id     integer,
  add column if not exists bookamat_cost_account_id     integer,
  add column if not exists bookamat_vat_account_0       integer,
  add column if not exists bookamat_vat_account_10      integer,
  add column if not exists bookamat_vat_account_13      integer,
  add column if not exists bookamat_vat_account_20      integer,
  add column if not exists email_subject_invoice_de     text,
  add column if not exists email_body_invoice_de        text,
  add column if not exists email_subject_invoice_en     text,
  add column if not exists email_body_invoice_en        text,
  add column if not exists email_subject_quote_de       text,
  add column if not exists email_body_quote_de          text,
  add column if not exists email_subject_quote_en       text,
  add column if not exists email_body_quote_en          text,
  add column if not exists email_subject_credit_note_de text,
  add column if not exists email_body_credit_note_de    text,
  add column if not exists email_subject_credit_note_en text,
  add column if not exists email_body_credit_note_en    text,
  add column if not exists email_subject_reminder_de    text,
  add column if not exists email_body_reminder_de       text,
  add column if not exists email_subject_reminder_en    text,
  add column if not exists email_body_reminder_en       text;

-- ─── documents ───────────────────────────────────────────────────────────────
alter table documents
  add column if not exists service_date_end    date,
  add column if not exists discount_type       text check (discount_type in ('percent','fixed')),
  add column if not exists discount_value      numeric,
  add column if not exists converted_from_id   uuid references documents(id),
  add column if not exists cancels_document_id uuid references documents(id),
  add column if not exists bookamat_booking_id text,
  add column if not exists reminder_sent_at    timestamptz,
  add column if not exists share_token         uuid,
  add column if not exists drive_file_id       text;

-- Drafts are saved without a number; issue_document assigns one later.
alter table documents alter column number drop not null;

-- The names Postgres gives the inline "unique" constraints in schema.sql, so a database
-- built from it and one aligned by this file end up identical.
create unique index if not exists documents_number_key      on documents(number);
create unique index if not exists documents_share_token_key on documents(share_token);

-- ─── document_items ──────────────────────────────────────────────────────────
alter table document_items
  add column if not exists line_type      text not null default 'item',
  add column if not exists service_date   date,
  add column if not exists discount_type  text check (discount_type in ('percent','fixed')),
  add column if not exists discount_value numeric;

-- Non-item lines (heading, text, separator, subtotal, page_break) store nulls here.
alter table document_items
  alter column quantity   drop not null,
  alter column unit       drop not null,
  alter column unit_price drop not null,
  alter column vat_rate   drop not null;

update document_items set line_type = 'item' where line_type is null;
alter table document_items
  alter column line_type set default 'item',
  alter column line_type set not null;

-- Replace whatever check constraint currently guards line_type (hand-made ones may have
-- any name or an older value list) with the canonical one.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.document_items'::regclass
      and con.contype = 'c'
      and att.attname = 'line_type'
  loop
    execute format('alter table public.document_items drop constraint %I', c.conname);
  end loop;

  alter table public.document_items
    add constraint document_items_line_type_check
    check (line_type in ('item','heading','text','separator','subtotal','page_break'));
end $$;

-- ─── catalogue_items ─────────────────────────────────────────────────────────
-- The original check lacked 'session', which both unit pickers offer.
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.catalogue_items'::regclass
      and con.contype = 'c'
      and att.attname = 'unit'
  loop
    execute format('alter table public.catalogue_items drop constraint %I', c.conname);
  end loop;

  alter table public.catalogue_items
    add constraint catalogue_items_unit_check
    check (unit in ('hour','day','session','flat','piece','month'));
end $$;

-- ─── storage: company logo ───────────────────────────────────────────────────
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
