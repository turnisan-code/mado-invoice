-- Line editor (g3-editor):
--   * issue_document also refuses a line discount out of range (bad_discount) and, on invoices
--     and quotes, a negative total (negative_total). The app runs the same checks first
--     (src/lib/utils/issue-checks.ts); item lines now carry their own discount_type /
--     discount_value (percent 0–100 or a fixed amount up to the line's gross), applied by
--     lineAmount() in src/lib/utils/document.ts.
-- Starts from the definition in 20261030_issue_checks.sql. Every statement is a no-op when already
-- applied, so the file can be run any number of times.

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
