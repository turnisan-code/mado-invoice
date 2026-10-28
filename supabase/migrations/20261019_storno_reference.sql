-- converted_from_id is generic provenance (quote → invoice, invoice → credit note).
-- A Storno is recorded explicitly so a plain credit note is never labelled as one.
alter table documents add column if not exists cancels_document_id uuid references documents(id);

-- Stornos created before this column existed: the referenced invoice is cancelled.
update documents c
set cancels_document_id = c.converted_from_id
from documents i
where c.type = 'credit_note'
  and c.cancels_document_id is null
  and c.converted_from_id = i.id
  and i.type = 'invoice'
  and i.status = 'cancelled';

-- Issuing keeps an already reached status (e.g. a deposit recorded before issuing left the
-- invoice 'paid'); only drafts move to 'sent'. Cancelled documents cannot be issued.
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
  if d.status = 'cancelled' then raise exception 'cancelled documents cannot be issued'; end if;
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

  update documents
  set number = result,
      status = case when status = 'draft' then 'sent' else status end
  where id = d.id;
  return result;
end;
$$;
