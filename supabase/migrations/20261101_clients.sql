-- Clients and catalogue carry their own terms (g4-clients):
--   * client_rates: a client's own price for a catalogue item (rate card), at most one per client
--     and item. Picking the item in the editor for that client uses it instead of default_price.
--   * clients.skonto_percent / skonto_days: the client's Skonto terms, prefilled on its new
--     invoices. NULL = the settings default (default_skonto_percent / default_skonto_days),
--     0 % = no Skonto for this client.
--   * catalogue_usage() also returns when each item was last used (the latest document date).
-- issue_document already gives an invoice issued without a due date one from the client's
-- payment days (20261031_editor.sql), and clients.currency is EUR only (20261029_clients_numbering.sql).
-- Idempotent — safe to re-run.

-- ─── Rate cards ──────────────────────────────────────────────────────────────
create table if not exists client_rates (
  id                uuid primary key default uuid_generate_v4(),
  created_at        timestamptz not null default now(),
  client_id         uuid not null references clients(id) on delete cascade,
  catalogue_item_id uuid not null references catalogue_items(id) on delete cascade,
  price             numeric(10,2) not null,
  note              text
);

create unique index if not exists client_rates_client_item_key on client_rates(client_id, catalogue_item_id);
create index if not exists client_rates_catalogue_item_idx on client_rates(catalogue_item_id);

alter table client_rates enable row level security;
drop policy if exists "owner" on client_rates;
create policy "owner" on client_rates
  for all to authenticated using (is_app_user()) with check (is_app_user());

-- ─── Client Skonto terms ─────────────────────────────────────────────────────
alter table clients
  add column if not exists skonto_percent numeric,
  add column if not exists skonto_days    integer;

alter table clients drop constraint if exists clients_skonto_percent_check;
alter table clients add constraint clients_skonto_percent_check
  check (skonto_percent is null or skonto_percent between 0 and 100);
alter table clients drop constraint if exists clients_skonto_days_check;
alter table clients add constraint clients_skonto_days_check
  check (skonto_days is null or skonto_days between 0 and 365);

-- ─── Catalogue usage ─────────────────────────────────────────────────────────
-- How many document lines use each catalogue item and the date of the latest such document,
-- for the counts on the catalogue page. The result type changes, so the function is recreated.
drop function if exists catalogue_usage();
create function catalogue_usage()
returns table (catalogue_item_id uuid, uses bigint, last_used date) language sql stable as $$
  select i.catalogue_item_id, count(*), max(d.date)
  from document_items i
  join documents d on d.id = i.document_id
  where i.catalogue_item_id is not null
  group by i.catalogue_item_id
$$;
