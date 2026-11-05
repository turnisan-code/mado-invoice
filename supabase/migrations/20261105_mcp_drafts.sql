-- Claude connector, draft tools (after 20261105_mcp.sql):
--   * A Claude session writes the lines of drafts only (document_items_mcp_guard, MI044): every
--     insert, update or delete of a line of a document that has a number or is no draft is
--     refused, whichever path writes it (replace_document_items, a final invoice's deduction
--     lines). replace_document_items locks the document first, so a draft issued while Claude
--     saves it keeps the lines it was issued with. The browser is not affected.
--   * The template of a recurring schedule that issues automatically (mode 'issue', active or
--     paused): a Claude session neither changes what the recurring cron copies from it nor deletes
--     it (documents_mcp_template_guard, document_items_mcp_guard, MI045), so it cannot prime an
--     invoice the cron numbers without anyone approving it. The browser is not affected.
--   * clients.mcp_recipients: the addresses a Claude session put on a client's email or CC list,
--     until the owner saves that client in Mado. They never count as on the client record: an
--     action whose arguments name one of them is approved in Mado whatever the policy says
--     (mcp_actions_recipients), so Claude cannot write an address onto a client and then send
--     there with only the chat prompt as the gate. The reminder cron skips them too.
-- Error codes: MI044 = only a draft's lines can be changed from a Claude connection, MI045 = the
-- template of a schedule that issues automatically cannot be changed or deleted from one.
-- Mirrored in supabase/schema.sql; supabase/tests/mcp_drafts_guards.sql checks the guards and
-- rolls back. Idempotent — safe to re-run.

-- ─── Lines: drafts only ──────────────────────────────────────────────────────
create or replace function public.document_items_mcp_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  if public.is_mcp_session() then
    if tg_op <> 'INSERT' then v_old := old.document_id; end if;
    if tg_op <> 'DELETE' then v_new := new.document_id; end if;
    if exists (
      select 1 from public.documents d
      where d.id in (v_old, v_new) and (d.number is not null or d.status <> 'draft')
    ) then
      raise exception using errcode = 'MI044', message = 'Only a draft''s lines can be changed from a Claude connection.';
    end if;
    if exists (
      select 1 from public.recurring_schedules r
      where r.source_document_id in (v_old, v_new) and r.mode = 'issue'
    ) then
      raise exception using errcode = 'MI045',
        message = 'The template of a recurring schedule that issues invoices automatically cannot be changed or deleted from a Claude connection.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists document_items_mcp_guard on public.document_items;
create trigger document_items_mcp_guard
  before insert or update or delete on public.document_items
  for each row execute function public.document_items_mcp_guard();

-- ─── Templates of schedules that issue automatically ─────────────────────────
-- What the recurring cron copies into every period's invoice (insertPeriodInvoice in
-- src/lib/utils/recurring.ts: the client, language, tax treatment, notes, discount, Skonto and
-- the lines) stays as the owner left it while a schedule in 'issue' mode, active or paused, uses
-- the document as its template; nor can a Claude session delete such a template. Paying,
-- reminding, issuing, cancelling or a Storno of the template change none of it and stay possible.
create or replace function public.documents_mcp_template_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.is_mcp_session() and exists (
    select 1 from public.recurring_schedules r where r.source_document_id = old.id and r.mode = 'issue'
  ) then
    if tg_op = 'DELETE' then
      raise exception using errcode = 'MI045',
        message = 'The template of a recurring schedule that issues invoices automatically cannot be changed or deleted from a Claude connection.';
    end if;
    if (new.client_id, new.language, new.tax_treatment, new.notes, new.discount_type, new.discount_value, new.skonto_percent, new.skonto_days)
       is distinct from (old.client_id, old.language, old.tax_treatment, old.notes, old.discount_type, old.discount_value, old.skonto_percent, old.skonto_days) then
      raise exception using errcode = 'MI045',
        message = 'The template of a recurring schedule that issues invoices automatically cannot be changed or deleted from a Claude connection.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists documents_mcp_template_guard on public.documents;
create trigger documents_mcp_template_guard
  before update of client_id, language, tax_treatment, notes, discount_type, discount_value, skonto_percent, skonto_days or delete
  on public.documents
  for each row execute function public.documents_mcp_template_guard();

-- ─── Recipients Claude wrote ─────────────────────────────────────────────────
alter table public.clients add column if not exists mcp_recipients text[] not null default '{}';

-- The addresses in a client's email field and CC list (or in any text), lower-case and split as
-- the app splits address lists.
create or replace function public.mcp_address_set(p_values text[])
returns text[]
language sql immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct a.addr order by a.addr), '{}')
  from unnest(coalesce(p_values, '{}')) v(val),
       regexp_split_to_table(lower(coalesce(v.val, '')), '[[:space:],;<>]+') a(addr)
  where a.addr like '_%@_%'
$$;

-- A Claude session: the addresses it adds are marked; marked ones that stay keep their mark.
-- The browser: a new client has none; an update keeps the marks of the addresses still there
-- (clients_mcp_recipients_seen clears them when the owner saves the address fields).
create or replace function public.clients_mcp_recipients()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_now    text[] := public.mcp_address_set(array[new.email] || coalesce(new.cc_emails, '{}'));
  v_before text[] := '{}';
  v_marked text[] := '{}';
begin
  if tg_op = 'UPDATE' then
    v_before := public.mcp_address_set(array[old.email] || coalesce(old.cc_emails, '{}'));
    v_marked := coalesce(old.mcp_recipients, '{}');
  end if;
  if public.is_mcp_session() then
    new.mcp_recipients := array(select a from unnest(v_now) a where a = any(v_marked) or not a = any(v_before) order by a);
  elsif tg_op = 'INSERT' then
    new.mcp_recipients := '{}';
  else
    new.mcp_recipients := array(select a from unnest(v_now) a where a = any(v_marked) order by a);
  end if;
  return new;
end;
$$;

-- The owner saved the client's address fields in Mado (the client form always sends both): the
-- addresses on it are the owner's now. Runs after clients_mcp_recipients (triggers run in name
-- order).
create or replace function public.clients_mcp_recipients_seen()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_mcp_session() then new.mcp_recipients := '{}'; end if;
  return new;
end;
$$;

drop trigger if exists clients_mcp_recipients on public.clients;
create trigger clients_mcp_recipients
  before insert or update on public.clients
  for each row execute function public.clients_mcp_recipients();
drop trigger if exists clients_mcp_recipients_seen on public.clients;
create trigger clients_mcp_recipients_seen
  before update of email, cc_emails on public.clients
  for each row execute function public.clients_mcp_recipients_seen();

-- Any text in a prepared action's arguments (recipients, subject, body) that names an address a
-- Claude session wrote onto a client sends the action to Mado for approval. mcp_create_action
-- returns the stored channel.
create or replace function public.mcp_actions_recipients()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.approval = 'chat' and exists (
    select 1
    from jsonb_path_query(new.args, 'strict $.** ? (@.type() == "string")') s(val),
         unnest(public.mcp_address_set(array[s.val #>> '{}'])) a(addr),
         public.clients c
    where a.addr = any(c.mcp_recipients)
  ) then
    new.approval := 'app';
  end if;
  return new;
end;
$$;

drop trigger if exists mcp_actions_recipients on public.mcp_actions;
create trigger mcp_actions_recipients
  before insert on public.mcp_actions
  for each row execute function public.mcp_actions_recipients();

-- ─── Function privileges ─────────────────────────────────────────────────────
revoke execute on function public.mcp_address_set(text[]) from public, anon;
grant execute on function public.mcp_address_set(text[]) to authenticated;
revoke execute on function public.document_items_mcp_guard() from public, anon, authenticated;
revoke execute on function public.documents_mcp_template_guard() from public, anon, authenticated;
revoke execute on function public.clients_mcp_recipients() from public, anon, authenticated;
revoke execute on function public.clients_mcp_recipients_seen() from public, anon, authenticated;
revoke execute on function public.mcp_actions_recipients() from public, anon, authenticated;
