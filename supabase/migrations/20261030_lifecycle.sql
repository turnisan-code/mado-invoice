-- Document lifecycle: which status changes are allowed (the same table as src/lib/status.ts),
-- issued documents can never be deleted, quote → invoice and Storno run in one transaction each,
-- payments get a bank reference and two kinds that are not money received ('credit': an issued
-- credit note applied to the invoice it corrects; 'refund': money paid back on a credit note),
-- and the client's portal response is stored.
-- Error codes MI010–MI018 are mapped to the app's dictionaries (lifecycleErrorMessage).
-- Idempotent — safe to re-run.

-- ─── Payments ────────────────────────────────────────────────────────────────
alter table payments add column if not exists reference text;
-- Deliberately no foreign key: a second payments → documents relationship would make every
-- payments(...) and documents(...) embed in the app ambiguous for PostgREST. Credit rows are
-- written only for issued credit notes, which documents_delete_guard keeps forever.
alter table payments add column if not exists credit_note_id uuid;

alter table payments drop constraint if exists payments_kind_check;
alter table payments add constraint payments_kind_check
  check (kind in ('payment','skonto','writeoff','credit','refund'));

alter table payments drop constraint if exists payments_credit_note_check;
alter table payments add constraint payments_credit_note_check
  check ((kind = 'credit') = (credit_note_id is not null));

-- A credit note is applied once; a second concurrent apply fails instead of crediting twice.
create unique index if not exists payments_credit_note_key on payments(credit_note_id) where kind = 'credit';

-- ─── Portal response and its dashboard notice ────────────────────────────────
alter table documents add column if not exists responded_at timestamptz;
-- Set when the owner opened the document a 'portal_responded' event belongs to.
alter table document_events add column if not exists read_at timestamptz;

create index if not exists document_events_unread_responses_idx
  on document_events(created_at) where type = 'portal_responded' and read_at is null;

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

-- ─── Quote → invoice ─────────────────────────────────────────────────────────
-- One transaction: the quote row is locked, so a double click or a second tab gets the invoice
-- the first call created. Only sent or accepted quotes convert (MI016). The invoice is an
-- unnumbered draft dated today, due after the client's payment days (settings default), with
-- every line copied as it is; a sent quote becomes accepted. Null when the quote does not exist.
create or replace function convert_quote_to_invoice(p_quote_id uuid)
returns jsonb language plpgsql as $$
declare
  q      documents%rowtype;
  s      settings%rowtype;
  inv_id uuid;
  today  date := (now() at time zone 'Europe/Vienna')::date;
  days   integer;
begin
  select * into q from documents where id = p_quote_id and type = 'quote' for update;
  if q.id is null then return null; end if;

  select id into inv_id from documents
  where converted_from_id = q.id and type = 'invoice'
  order by created_at limit 1;
  if inv_id is not null then
    return jsonb_build_object('invoice_id', inv_id, 'existing', true, 'quote_status', q.status);
  end if;

  if q.status not in ('sent', 'accepted') then
    raise exception using errcode = 'MI016', detail = q.status,
      message = format('Only sent or accepted quotes can be converted (this one is %s).', q.status);
  end if;

  select * into s from settings limit 1;
  select payment_days into days from clients where id = q.client_id;

  insert into documents (
    type, number, status, client_id, date, due_date, service_date, service_date_end,
    language, currency, tax_treatment, exchange_rate, notes, notes_internal,
    discount_type, discount_value, skonto_percent, skonto_days, converted_from_id
  ) values (
    'invoice', null, 'draft', q.client_id, today, today + coalesce(days, s.default_payment_days, 14),
    q.service_date, q.service_date_end, q.language, q.currency, q.tax_treatment, q.exchange_rate,
    q.notes, q.notes_internal, q.discount_type, q.discount_value,
    s.default_skonto_percent, case when s.default_skonto_percent is not null then s.default_skonto_days end, q.id
  ) returning id into inv_id;

  -- Whole rows, so columns added to document_items later are copied too.
  insert into document_items
  select (jsonb_populate_record(null::document_items,
            to_jsonb(i) || jsonb_build_object('id', uuid_generate_v4(), 'document_id', inv_id))).*
  from document_items i
  where i.document_id = q.id
  order by i.sort_order;

  if q.status = 'sent' then
    update documents set status = 'accepted' where id = q.id;
  end if;

  return jsonb_build_object('invoice_id', inv_id, 'existing', false, 'quote_status', q.status);
end;
$$;

-- ─── Invoice → credit note / Storno ──────────────────────────────────────────
-- Copies the invoice into a draft credit note. With p_cancel it is a Storno: the credit note is
-- numbered right here (issue_document) and the invoice cancelled in the same transaction, so a
-- Storno is never a deletable draft and never exists without its cancelled invoice.
-- Null when the invoice does not exist.
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

  if p_cancel and inv.number is null then
    raise exception using errcode = 'MI018', message = 'A draft has no number to cancel; delete it instead.';
  end if;
  if p_cancel and inv.status = 'cancelled' then
    raise exception using errcode = 'MI017', message = format('%s is already cancelled.', inv.number);
  end if;

  insert into documents (
    type, number, status, client_id, date, due_date, service_date, service_date_end,
    language, currency, tax_treatment, exchange_rate, notes, notes_internal,
    discount_type, discount_value, converted_from_id, cancels_document_id
  ) values (
    'credit_note', null, 'draft', inv.client_id, today, null, inv.service_date, inv.service_date_end,
    inv.language, inv.currency, inv.tax_treatment, inv.exchange_rate, inv.notes, inv.notes_internal,
    inv.discount_type, inv.discount_value, inv.id, case when p_cancel then inv.id end
  ) returning id into cn_id;

  insert into document_items
  select (jsonb_populate_record(null::document_items,
            to_jsonb(i) || jsonb_build_object('id', uuid_generate_v4(), 'document_id', cn_id))).*
  from document_items i
  where i.document_id = inv.id
  order by i.sort_order;

  if p_cancel then
    cn_number := issue_document(cn_id);
    update documents set status = 'cancelled' where id = inv.id;
  end if;

  return jsonb_build_object('credit_note_id', cn_id, 'number', cn_number, 'invoice_status', inv.status);
end;
$$;
