-- Number formatting shared by next_document_number and issue_document.
-- Longer counter tokens are replaced first so {N} cannot eat part of {NNN}.
create or replace function format_document_number(fmt text, prefix text, num integer, d date)
returns text language sql immutable as $$
  select replace(replace(replace(replace(replace(replace(replace(replace(
    fmt,
    '{prefix}', coalesce(prefix, '')),
    '{YYYY}',   to_char(d, 'YYYY')),
    '{YY}',     to_char(d, 'YY')),
    '{MM}',     to_char(d, 'MM')),
    '{NNNN}',   lpad(num::text, 4, '0')),
    '{NNN}',    lpad(num::text, 3, '0')),
    '{NN}',     lpad(num::text, 2, '0')),
    '{N}',      num::text)
$$;

-- Locks the settings row so two concurrent calls can never hand out the same number.
create or replace function next_document_number(doc_type text)
returns text language plpgsql as $$
declare
  s   settings%rowtype;
  num integer;
begin
  select * into s from settings limit 1 for update;
  if s.id is null then raise exception 'settings row missing'; end if;
  if doc_type = 'invoice' then
    num := s.next_invoice_number;
    update settings set next_invoice_number = next_invoice_number + 1 where id = s.id;
    return format_document_number(s.invoice_number_format, s.invoice_prefix, num, current_date);
  elsif doc_type = 'quote' then
    num := s.next_quote_number;
    update settings set next_quote_number = next_quote_number + 1 where id = s.id;
    return format_document_number(s.quote_number_format, s.quote_prefix, num, current_date);
  else
    num := s.next_credit_note_number;
    update settings set next_credit_note_number = next_credit_note_number + 1 where id = s.id;
    return format_document_number(s.credit_note_number_format, s.credit_note_prefix, num, current_date);
  end if;
end;
$$;

-- Issues a document in one transaction: assigns the next number for its own type (year/month
-- tokens come from the document date) and sets status 'sent'. A failure anywhere rolls the
-- counter back, so no number is ever burned. Idempotent for already numbered documents.
create or replace function issue_document(p_document_id uuid)
returns text language plpgsql as $$
declare
  d      documents%rowtype;
  s      settings%rowtype;
  num    integer;
  result text;
begin
  select * into d from documents where id = p_document_id for update;
  if d.id is null then raise exception 'document % not found', p_document_id; end if;
  if d.number is not null then
    if d.status = 'draft' then update documents set status = 'sent' where id = d.id; end if;
    return d.number;
  end if;

  select * into s from settings limit 1 for update;
  if s.id is null then raise exception 'settings row missing'; end if;

  if d.type = 'invoice' then
    num := s.next_invoice_number;
    update settings set next_invoice_number = next_invoice_number + 1 where id = s.id;
    result := format_document_number(s.invoice_number_format, s.invoice_prefix, num, coalesce(d.date, current_date));
  elsif d.type = 'quote' then
    num := s.next_quote_number;
    update settings set next_quote_number = next_quote_number + 1 where id = s.id;
    result := format_document_number(s.quote_number_format, s.quote_prefix, num, coalesce(d.date, current_date));
  else
    num := s.next_credit_note_number;
    update settings set next_credit_note_number = next_credit_note_number + 1 where id = s.id;
    result := format_document_number(s.credit_note_number_format, s.credit_note_prefix, num, coalesce(d.date, current_date));
  end if;

  update documents set number = result, status = 'sent' where id = d.id;
  return result;
end;
$$;

-- Replaces a document's line items atomically (delete + insert in one transaction), so a
-- failed or interrupted save can no longer leave the document without items.
create or replace function replace_document_items(p_document_id uuid, p_items jsonb)
returns void language plpgsql as $$
begin
  delete from document_items where document_id = p_document_id;
  insert into document_items (
    document_id, sort_order, line_type, description, service_date,
    quantity, unit, unit_price, vat_rate, catalogue_item_id, discount_type, discount_value
  )
  select
    p_document_id, x.sort_order, x.line_type, x.description, x.service_date,
    x.quantity, x.unit, x.unit_price, x.vat_rate, x.catalogue_item_id, x.discount_type, x.discount_value
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(
    sort_order        integer,
    line_type         text,
    description       text,
    service_date      date,
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
