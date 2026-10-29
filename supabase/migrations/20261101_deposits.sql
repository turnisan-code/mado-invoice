-- Anzahlungs-, Teil- und Schlussrechnung (§ 11 Abs 1 UStG, UStR 2000 Rz 1521 ff.):
--   * documents.invoice_kind: 'advance' asks for money before the service, 'partial' bills a
--     completed part of it, 'final' bills the whole service and deducts them (invoices only).
--   * documents.final_invoice_id: on an advance or partial invoice, the final invoice that deducts
--     it. One column, so an invoice is deducted at most once; deleting a draft final invoice frees
--     its invoices (on delete set null), a Storno of it frees them too (documents_deposit_release).
--   * document_items.line_type 'deduction': the final invoice's deduction, one negative line per
--     deducted invoice and VAT rate, written by the app (src/lib/deposits.ts) and summed by
--     calcTotals after every discount.
--   * convert_quote_to_invoice (from 20261030_lifecycle.sql) skips advance and partial invoices
--     when it looks for the quote's conversion, refuses a plain conversion once the quote has
--     issued advance or partial invoices (MI019), creates the final invoice with p_final (linking
--     them in the same transaction) and copies the buyer reference.
-- Error codes: MI019 = the quote has advance invoices, create the final invoice; MI020 = the
-- invoice is deducted on an issued final invoice; MI021 = not a valid deduction link.
-- Every statement is a no-op when already applied, so the file can be run any number of times.

-- ─── Columns ─────────────────────────────────────────────────────────────────
alter table documents add column if not exists invoice_kind text not null default 'standard';
alter table documents drop constraint if exists documents_invoice_kind_check;
alter table documents add constraint documents_invoice_kind_check
  check (invoice_kind in ('standard', 'advance', 'partial', 'final') and (type = 'invoice' or invoice_kind = 'standard'));

alter table documents add column if not exists final_invoice_id uuid references documents(id) on delete set null;
alter table documents drop constraint if exists documents_final_invoice_check;
alter table documents add constraint documents_final_invoice_check
  check (final_invoice_id is null or invoice_kind in ('advance', 'partial'));
create index if not exists documents_final_invoice_id_idx on documents(final_invoice_id) where final_invoice_id is not null;

alter table document_items drop constraint if exists document_items_line_type_check;
alter table document_items add constraint document_items_line_type_check
  check (line_type in ('item', 'heading', 'text', 'separator', 'subtotal', 'page_break', 'deduction'));

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
  if con_name is null or con_def like '%''deposit_released''%' then return; end if;

  select array_agg(m[1] order by m[1]) into types
  from (select distinct regexp_matches(con_def, '''([a-z_]+)''', 'g') as m) x;
  types := types || array['deposit_created', 'deposit_linked', 'deposit_released'];

  execute format('alter table document_events drop constraint %I', con_name);
  execute format('alter table document_events add constraint document_events_type_check check (type = any (%L::text[]))', types);
end $$;

-- ─── Deduction links ─────────────────────────────────────────────────────────
-- Only an issued, uncancelled advance or partial invoice is deducted, by an uncancelled final
-- invoice of the same client. What an issued final invoice deducts stays until that invoice is
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
         or f.status = 'cancelled' or f.client_id <> new.client_id then
        raise exception using errcode = 'MI021',
          message = 'Only an issued advance or partial invoice can be deducted, by a final invoice of the same client.';
      end if;
    end if;
  end if;

  if old.invoice_kind = 'final' and new.invoice_kind <> 'final'
     and exists (select 1 from documents where final_invoice_id = new.id) then
    raise exception using errcode = 'MI021',
      message = 'A final invoice that deducts other invoices stays a final invoice; remove the deductions first.';
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
  before update of status, final_invoice_id, invoice_kind on documents
  for each row execute function documents_deposit_guard();

-- A cancelled final invoice (its Storno, or a draft cancelled from the status menu) deducts
-- nothing any more: its invoices are free for the next final invoice, as both histories say.
create or replace function documents_deposit_release()
returns trigger language plpgsql as $$
declare
  r record;
  why text := case when new.number is null then 'cancelled' else 'storno' end;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.invoice_kind = 'final' then
    for r in update documents set final_invoice_id = null where final_invoice_id = new.id returning id, number loop
      insert into document_events (document_id, type, detail)
      values (r.id, 'deposit_released', jsonb_build_object('final_id', new.id, 'final_number', new.number, 'reason', why)),
             (new.id, 'deposit_released', jsonb_build_object('invoice_id', r.id, 'invoice_number', r.number, 'reason', why));
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

-- ─── Quote → invoice ─────────────────────────────────────────────────────────
-- One transaction: the quote row is locked, so a double click or a second tab gets the invoice
-- the first call created. Only sent or accepted quotes convert (MI016). The invoice is an
-- unnumbered draft dated today, due after the client's payment days (settings default), with
-- every line and the buyer reference copied as they are; a sent quote becomes accepted. Advance
-- and partial invoices made from the quote are never its conversion. Once issued ones exist, a
-- plain invoice would bill them twice (MI019): p_final creates the final invoice instead and
-- links them to it (the app then writes the deduction lines). Null when the quote does not exist.
drop function if exists convert_quote_to_invoice(uuid);
create or replace function convert_quote_to_invoice(p_quote_id uuid, p_final boolean default false)
returns jsonb language plpgsql as $$
declare
  q      documents%rowtype;
  s      settings%rowtype;
  inv_id uuid;
  today  date := (now() at time zone 'Europe/Vienna')::date;
  days   integer;
  linked integer := 0;
  r      record;
begin
  select * into q from documents where id = p_quote_id and type = 'quote' for update;
  if q.id is null then return null; end if;

  select id into inv_id from documents
  where converted_from_id = q.id and type = 'invoice' and invoice_kind in ('standard', 'final')
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
  select payment_days into days from clients where id = q.client_id;

  insert into documents (
    type, invoice_kind, number, status, client_id, date, due_date, service_date, service_date_end,
    language, currency, tax_treatment, exchange_rate, notes, notes_internal,
    discount_type, discount_value, skonto_percent, skonto_days, converted_from_id, buyer_reference
  ) values (
    'invoice', case when p_final then 'final' else 'standard' end, null, 'draft', q.client_id, today,
    today + coalesce(days, s.default_payment_days, 14),
    q.service_date, q.service_date_end, q.language, q.currency, q.tax_treatment, q.exchange_rate,
    q.notes, q.notes_internal, q.discount_type, q.discount_value,
    s.default_skonto_percent, case when s.default_skonto_percent is not null then s.default_skonto_days end, q.id,
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
    for r in update documents set final_invoice_id = inv_id
             where converted_from_id = q.id and type = 'invoice' and invoice_kind in ('advance', 'partial')
               and number is not null and status <> 'cancelled' and final_invoice_id is null
             returning id loop
      insert into document_events (document_id, type, detail)
      values (r.id, 'deposit_linked', jsonb_build_object('final_id', inv_id));
      linked := linked + 1;
    end loop;
  end if;

  if q.status = 'sent' then
    update documents set status = 'accepted' where id = q.id;
  end if;

  return jsonb_build_object('invoice_id', inv_id, 'existing', false, 'quote_status', q.status, 'linked', linked);
end;
$$;
