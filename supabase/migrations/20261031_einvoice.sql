-- Structured e-invoices (ebInterface 6.1, Peppol BIS Billing 3.0): per client the preferred
-- format, its Peppol address (empty = derived from its UID), the buyer reference prefilled on its
-- e-invoices and the supplier number it assigned to the studio; per document the buyer reference
-- (Auftragsreferenz) it was exported with; the studio's own Peppol address (empty = 9914 + UID);
-- and the 'einvoice_exported' history event.
-- Idempotent — safe to re-run.

alter table clients add column if not exists einvoice_format text;
alter table clients add column if not exists peppol_scheme   text;
alter table clients add column if not exists peppol_id       text;
alter table clients add column if not exists buyer_reference text;
alter table clients add column if not exists supplier_number text;

alter table clients drop constraint if exists clients_einvoice_format_check;
alter table clients add constraint clients_einvoice_format_check
  check (einvoice_format is null or einvoice_format in ('ebinterface', 'ubl'));
alter table clients drop constraint if exists clients_peppol_scheme_check;
alter table clients add constraint clients_peppol_scheme_check
  check (peppol_scheme is null or peppol_scheme ~ '^[0-9]{4}$');

alter table documents add column if not exists buyer_reference text;

alter table settings add column if not exists peppol_scheme text;
alter table settings add column if not exists peppol_id     text;

alter table settings drop constraint if exists settings_peppol_scheme_check;
alter table settings add constraint settings_peppol_scheme_check
  check (peppol_scheme is null or peppol_scheme ~ '^[0-9]{4}$');

-- The allowed event types are read back from the existing check and extended, so event types
-- other migrations add to the same check are kept whichever runs first.
do $$
declare
  con_name text;
  con_def  text;
  types    text[];
begin
  select c.conname, pg_get_constraintdef(c.oid) into con_name, con_def
  from pg_constraint c
  where c.conrelid = 'document_events'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%''issued''%'
  limit 1;
  if con_name is null or con_def like '%''einvoice_exported''%' then return; end if;

  select array_agg(m[1] order by m[1]) into types
  from (select distinct regexp_matches(con_def, '''([a-z_]+)''', 'g') as m) x;
  types := types || 'einvoice_exported'::text;

  execute format('alter table document_events drop constraint %I', con_name);
  execute format('alter table document_events add constraint document_events_type_check check (type = any (%L::text[]))', types);
end $$;
