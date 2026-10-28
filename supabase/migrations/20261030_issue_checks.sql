-- Issue checks and per-line service periods:
--   * document_items.service_date_end: end of a line's service period (null = a single day)
--   * replace_document_items writes the new column
--   * issue_document refuses documents that are not complete enough to be issued (error MI004,
--     detail = the problem codes). The app runs the same checks first and shows them inline
--     (src/lib/utils/issue-checks.ts); this is the last line for every issuance path.
--   * issue_document fills an empty due date (invoices: client terms, quotes: validity), so an
--     invoice issued from the status menu or a bulk action still becomes overdue
-- Every statement is a no-op when already applied, so the file can be run any number of times.

alter table document_items add column if not exists service_date_end date;

-- Replaces a document's line items atomically (delete + insert in one transaction), so a
-- failed or interrupted save can no longer leave the document without items.
create or replace function replace_document_items(p_document_id uuid, p_items jsonb)
returns void language plpgsql as $$
begin
  delete from document_items where document_id = p_document_id;
  insert into document_items (
    document_id, sort_order, line_type, description, service_date, service_date_end,
    quantity, unit, unit_price, vat_rate, catalogue_item_id, discount_type, discount_value
  )
  select
    p_document_id, x.sort_order, x.line_type, x.description, x.service_date, x.service_date_end,
    x.quantity, x.unit, x.unit_price, x.vat_rate, x.catalogue_item_id, x.discount_type, x.discount_value
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
    sort_order        integer,
    line_type         text,
    description       text,
    service_date      date,
    service_date_end  date,
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
--   period_end_before_start, and for invoices and credit notes reverse_charge_without_uid,
--   client_country_missing (reverse charge / non-EU) and no_service_date (neither the
--   document nor every item line has one).
create or replace function issue_document(p_document_id uuid)
returns text language plpgsql as $$
declare
  d        documents%rowtype;
  s        settings%rowtype;
  c        clients%rowtype;
  today    date := (now() at time zone 'Europe/Vienna')::date;
  problems text[] := '{}';
  result   text;
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
