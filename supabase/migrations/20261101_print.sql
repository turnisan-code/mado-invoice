-- What the client receives (g4-print):
--   * documents.issued_total: the total (after discounts, before payments) a document was issued
--     with, written by issueDocument (src/lib/pdf/issue.ts) together with its frozen PDF. The
--     editor and the e-invoice dialog warn when an issued document's total no longer matches.
--     Null for documents issued before this column existed.
--   * create_credit_note copies the buyer reference (Auftragsreferenz) of the invoice it corrects,
--     so the credit note's PDF and e-invoice quote the same order as the invoice.
-- create_credit_note starts from its definition in 20261030_lifecycle.sql. Every statement is a
-- no-op when already applied, so the file can be run any number of times.

alter table documents add column if not exists issued_total numeric(12,2);

-- ─── Invoice → credit note / Storno ──────────────────────────────────────────
-- Copies an issued invoice into a draft credit note. With p_cancel it is a Storno: the credit note is
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

  -- A credit note corrects an issued invoice; a cancelled one is already reversed by its Storno.
  if inv.number is null then
    raise exception using errcode = 'MI018', message = 'A draft has no number to cancel or credit; edit or delete it instead.';
  end if;
  if inv.status = 'cancelled' then
    raise exception using errcode = 'MI017', message = format('%s is already cancelled.', inv.number);
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
  where i.document_id = inv.id
  order by i.sort_order;

  if p_cancel then
    cn_number := issue_document(cn_id);
    update documents set status = 'cancelled' where id = inv.id;
  end if;

  return jsonb_build_object('credit_note_id', cn_id, 'number', cn_number, 'invoice_status', inv.status);
end;
$$;
