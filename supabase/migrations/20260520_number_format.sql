-- Add configurable number format columns to settings
-- Default preserves the existing behaviour: PREFIX-YYYY-NNN
alter table settings
  add column if not exists invoice_number_format     text not null default '{prefix}-{YYYY}-{NNN}',
  add column if not exists quote_number_format       text not null default '{prefix}-{YYYY}-{NNN}',
  add column if not exists credit_note_number_format text not null default '{prefix}-{YYYY}-{NNN}';

-- Update number generation to use the format template
-- Supported tokens: {prefix} {YYYY} {YY} {MM} {NNNN} {NNN} {NN} {N}
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
    update settings set next_invoice_number = next_invoice_number + 1;
  elsif doc_type = 'quote' then
    num    := s.next_quote_number;
    prefix := s.quote_prefix;
    fmt    := s.quote_number_format;
    update settings set next_quote_number = next_quote_number + 1;
  else
    num    := s.next_credit_note_number;
    prefix := s.credit_note_prefix;
    fmt    := s.credit_note_number_format;
    update settings set next_credit_note_number = next_credit_note_number + 1;
  end if;

  result := fmt;
  result := replace(result, '{prefix}', prefix);
  result := replace(result, '{YYYY}',   to_char(current_date, 'YYYY'));
  result := replace(result, '{YY}',     to_char(current_date, 'YY'));
  result := replace(result, '{MM}',     to_char(current_date, 'MM'));
  -- longer patterns first to avoid partial matches
  result := replace(result, '{NNNN}',   lpad(num::text, 4, '0'));
  result := replace(result, '{NNN}',    lpad(num::text, 3, '0'));
  result := replace(result, '{NN}',     lpad(num::text, 2, '0'));
  result := replace(result, '{N}',      num::text);

  return result;
end;
$$;
