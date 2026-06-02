-- Fix: add WHERE id = s.id to all UPDATE statements inside next_document_number.
-- Supabase has pg_safeupdate enabled which blocks UPDATE without a WHERE clause,
-- even inside plpgsql functions.
create or replace function next_document_number(doc_type text)
returns text language plpgsql as $$
declare
  s      settings%rowtype;
  num    integer;
  prefix text;
  fmt    text;
  result text;
begin
  select * into s from settings limit 1;
  if doc_type = 'invoice' then
    num    := s.next_invoice_number;
    prefix := s.invoice_prefix;
    fmt    := s.invoice_number_format;
    update settings set next_invoice_number = next_invoice_number + 1 where id = s.id;
  elsif doc_type = 'quote' then
    num    := s.next_quote_number;
    prefix := s.quote_prefix;
    fmt    := s.quote_number_format;
    update settings set next_quote_number = next_quote_number + 1 where id = s.id;
  else
    num    := s.next_credit_note_number;
    prefix := s.credit_note_prefix;
    fmt    := s.credit_note_number_format;
    update settings set next_credit_note_number = next_credit_note_number + 1 where id = s.id;
  end if;

  result := fmt;
  result := replace(result, '{prefix}', prefix);
  result := replace(result, '{YYYY}',   to_char(current_date, 'YYYY'));
  result := replace(result, '{YY}',     to_char(current_date, 'YY'));
  result := replace(result, '{MM}',     to_char(current_date, 'MM'));
  result := replace(result, '{NNNN}',   lpad(num::text, 4, '0'));
  result := replace(result, '{NNN}',    lpad(num::text, 3, '0'));
  result := replace(result, '{NN}',     lpad(num::text, 2, '0'));
  result := replace(result, '{N}',      num::text);

  return result;
end;
$$;
