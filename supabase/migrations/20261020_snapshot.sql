-- Frozen copy of every issued document: the PDF the client received is stored once at
-- issuance in a private bucket and served from there, so later edits to the client,
-- settings or line items can no longer change what was issued.
alter table documents add column if not exists issued_at timestamptz;
alter table documents add column if not exists pdf_path text;

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict do nothing;

drop policy if exists "documents owner select" on storage.objects;
drop policy if exists "documents owner insert" on storage.objects;
drop policy if exists "documents owner update" on storage.objects;
drop policy if exists "documents owner delete" on storage.objects;

create policy "documents owner select" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and public.is_app_user());

create policy "documents owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and public.is_app_user());

create policy "documents owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'documents' and public.is_app_user())
  with check (bucket_id = 'documents' and public.is_app_user());

create policy "documents owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and public.is_app_user());

-- Same body as 20261019_storno_reference.sql, plus issued_at recorded when the number is assigned.
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
      status = case when status = 'draft' then 'sent' else status end,
      issued_at = coalesce(issued_at, now())
  where id = d.id;
  return result;
end;
$$;
