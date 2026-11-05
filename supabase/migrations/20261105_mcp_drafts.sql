-- Claude connector, draft tools (after 20261105_mcp.sql):
--   * A Claude session writes the lines of drafts only (document_items_mcp_guard, MI044): every
--     insert, update or delete of a line of a document that has a number or is no draft is
--     refused, whichever path writes it (replace_document_items, a final invoice's deduction
--     lines). replace_document_items locks the document first, so a draft issued while Claude
--     saves it keeps the lines it was issued with. The browser is not affected.
--   * The template of a recurring schedule, whatever its mode, active or paused: a Claude session
--     neither changes what the recurring cron copies from it nor deletes it
--     (documents_mcp_template_guard, document_items_mcp_guard, MI045), so it cannot prime an
--     invoice the cron numbers without anyone approving it, also not through a schedule that
--     creates drafts and is switched to issue them later. The browser is not affected.
--   * clients.mcp_recipients: the addresses a Claude session put on a client's email or CC list,
--     until the owner saves that client in Mado. They never count as on the client record: an
--     action whose arguments name one of them is approved in Mado whatever the policy says
--     (mcp_actions_recipients), so Claude cannot write an address onto a client and then send
--     there with only the chat prompt as the gate. The reminder cron skips them too.
--   * clients.mcp_written_at: when a Claude session last created or changed the client, until the
--     owner saves it in Mado. Meanwhile the reminder cron skips the client's invoices
--     (src/app/api/cron/reminders/route.ts), its automatic Bookamat step skips the client's
--     documents (autoSyncBookamat in src/lib/bookamat.ts), a schedule that issues automatically
--     creates its invoices as drafts (src/lib/utils/recurring.ts), no archive copy of an issued
--     document is made from the client afterwards (getIssuedPdf in src/lib/pdf/snapshot.ts) and
--     the client portal leaves the recipient block out: a Mahnung, a booking, an issued invoice or
--     a frozen PDF would carry what Claude wrote there (the name, the recipient block, the UID,
--     the payment terms) without anyone approving it.
--   * documents.mcp_payments_at: when a Claude session last recorded, changed or removed a payment
--     row of an invoice or a refund of a credit note, until the owner confirms the document's
--     payments on its page in Mado. Meanwhile the reminder cron skips the invoice, the automatic
--     Bookamat step skips the document and no archive copy is made of it: removing a payment
--     reopens a paid invoice or raises what is open, so an automatic Mahnung would ask for money
--     the client paid, and a booking takes its date, amount and account from the rows.
-- Error codes: MI044 = only a draft's lines can be changed from a Claude connection, MI045 = the
-- template of a recurring schedule cannot be changed or deleted from one.
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
      where r.source_document_id in (v_old, v_new)
    ) then
      raise exception using errcode = 'MI045',
        message = 'The template of a recurring schedule cannot be changed or deleted from a Claude connection.';
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

-- ─── Templates of recurring schedules ────────────────────────────────────────
-- What the recurring cron copies into every period's invoice (insertPeriodInvoice in
-- src/lib/utils/recurring.ts: the client, language, tax treatment, notes, discount, Skonto and
-- the lines) stays as the owner left it while a schedule of either mode, active or paused, uses
-- the document as its template: one that creates drafts can be switched to issue them in Mado
-- without the template being opened again. Nor can a Claude session delete such a template.
-- Paying, reminding, issuing, cancelling or a Storno of the template change none of it and stay
-- possible.
-- The client record the template names (its terms give the due date, its address the recipient
-- block) stays writable; the cron leaves the invoice a draft while clients.mcp_written_at is set.
create or replace function public.documents_mcp_template_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.is_mcp_session() and exists (
    select 1 from public.recurring_schedules r where r.source_document_id = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception using errcode = 'MI045',
        message = 'The template of a recurring schedule cannot be changed or deleted from a Claude connection.';
    end if;
    if (new.client_id, new.language, new.tax_treatment, new.notes, new.discount_type, new.discount_value, new.skonto_percent, new.skonto_days)
       is distinct from (old.client_id, old.language, old.tax_treatment, old.notes, old.discount_type, old.discount_value, old.skonto_percent, old.skonto_days) then
      raise exception using errcode = 'MI045',
        message = 'The template of a recurring schedule cannot be changed or deleted from a Claude connection.';
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
-- The addresses in a client's email field and CC list (or in any text): split on what JavaScript's
-- \s matches and on , ; < >, with A-Z lower-cased and nothing else. Both are spelled out rather
-- than left to the database locale (lower() folds U+0130 'İ' to 'i' under glibc but to 'i' + U+0307
-- in JavaScript; [[:space:]] matches U+0085 under ICU but not in JavaScript), because the reminder
-- cron repeats this in the app (mcpAddressSet in src/lib/services/email-compose.ts) to compare the
-- marks, and the app's address checks split on \s.
create or replace function public.mcp_address_set(p_values text[])
returns text[]
language sql immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct a.addr order by a.addr), '{}')
  from unnest(coalesce(p_values, '{}')) v(val),
       regexp_split_to_table(
         translate(coalesce(v.val, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
         '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff,;<>]+') a(addr)
  where a.addr like '_%@_%'
$$;

-- An earlier version of this migration folded the addresses with lower() and split them on the
-- locale's [[:space:]]. Where one was applied (clients.mcp_recipients exists, mcp_written_at not
-- yet), the marks it stored are redone once here, failing closed until the owner saves the client
-- in Mado. Marked are: every address on a client with a mark that names none of its addresses as
-- mcp_address_set now gives them (a mark in the earlier form, its address unknown;
-- clients_mcp_recipients does the same on the client's next write); an address with a character
-- that [[:space:]] matches and \s does not (U+0085 under ICU), where the earlier split cut it and
-- may have left it unmarked; an address that lower() changes or makes equal to another one on the
-- client, which the earlier fold may have taken for an address already there and left unmarked.
-- That version had no mcp_written_at, so what Claude changed on a client under it is not known:
-- the column is added here and set on every client with a mark after the redo and on every client
-- created since the first Claude connection, so the crons and the archive copy hold them until the
-- owner saves them in Mado. A change Claude made under it to the name, company, UID or terms of
-- another client, with no address, left no trace (README: the owner checks and saves those).
-- The two triggers below are bypassed for this one update, inside this statement.
do $$
declare
  v_triggers text[];
  v_trigger  text;
begin
  if not exists (select 1 from pg_catalog.pg_attribute
                 where attrelid = 'public.clients'::regclass and attname = 'mcp_recipients' and not attisdropped)
     or exists (select 1 from pg_catalog.pg_attribute
                where attrelid = 'public.clients'::regclass and attname = 'mcp_written_at' and not attisdropped) then
    return;
  end if;
  v_triggers := array(
    select t.tgname::text from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.clients'::regclass and t.tgenabled <> 'D'
      and t.tgname in ('clients_mcp_recipients', 'clients_mcp_recipients_seen'));
  foreach v_trigger in array v_triggers loop
    execute format('alter table public.clients disable trigger %I', v_trigger);
  end loop;
  update public.clients c set mcp_recipients = r.marks
  from (
    select c2.id, array(
      select a from unnest(s.addrs) a
      where a = any(c2.mcp_recipients)
         or not c2.mcp_recipients <@ s.addrs
         or a ~ '[[:space:]]'
         or lower(a) <> a
         or exists (select 1 from unnest(s.addrs) b where b <> a and lower(b) = lower(a))
      order by a) as marks
    from public.clients c2,
         lateral (select public.mcp_address_set(array[c2.email] || coalesce(c2.cc_emails, '{}')) as addrs) s
  ) r
  where r.id = c.id and c.mcp_recipients is distinct from r.marks;
  alter table public.clients add column mcp_written_at timestamptz;
  execute $q$
    update public.clients set mcp_written_at = now()
    where cardinality(mcp_recipients) > 0
       or created_at >= (select min(g.created_at) from public.mcp_grants g)
  $q$;
  foreach v_trigger in array v_triggers loop
    execute format('alter table public.clients enable trigger %I', v_trigger);
  end loop;
end;
$$;

alter table public.clients add column if not exists mcp_recipients text[] not null default '{}';
alter table public.clients add column if not exists mcp_written_at timestamptz;

-- A Claude session: the addresses it adds are marked, marked ones that stay keep their mark, and
-- a write that changes the client sets mcp_written_at. The browser (and the service role): a new
-- client has neither; an update keeps the marks of the addresses still there and mcp_written_at
-- (clients_mcp_recipients_seen clears both when the owner saves the address fields). A mark that
-- names none of the client's addresses was stored by an earlier version of mcp_address_set (see
-- above): the address it stood for is unknown, so every address on the client counts as marked.
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
    if not v_marked <@ v_before then v_marked := v_before; end if;
  end if;
  if public.is_mcp_session() then
    new.mcp_recipients := array(select a from unnest(v_now) a where a = any(v_marked) or not a = any(v_before) order by a);
    new.mcp_written_at := now();
    if tg_op = 'UPDATE' then
      if (to_jsonb(new) - 'mcp_recipients' - 'mcp_written_at') is not distinct from (to_jsonb(old) - 'mcp_recipients' - 'mcp_written_at') then
        new.mcp_written_at := old.mcp_written_at;
      end if;
    end if;
  elsif tg_op = 'INSERT' then
    new.mcp_recipients := '{}';
    new.mcp_written_at := null;
  else
    new.mcp_recipients := array(select a from unnest(v_now) a where a = any(v_marked) order by a);
    new.mcp_written_at := old.mcp_written_at;
  end if;
  return new;
end;
$$;

-- The owner saved the client's address fields in Mado (the client form always sends both): the
-- addresses on it, and the rest of what Claude wrote there, are the owner's now. Runs after
-- clients_mcp_recipients (triggers run in name order).
create or replace function public.clients_mcp_recipients_seen()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_mcp_session() then
    new.mcp_recipients := '{}';
    new.mcp_written_at := null;
  end if;
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

-- ─── Payments Claude changed ─────────────────────────────────────────────────
-- A payment, fee, Skonto, write-off or applied credit on an invoice, or a refund on a credit note,
-- that a Claude session records, changes or removes sets documents.mcp_payments_at on that
-- document, until the owner confirms its payments on its page in Mado. Meanwhile the reminder cron
-- skips the invoice and its automatic Bookamat step the document
-- (src/app/api/cron/reminders/route.ts, autoSyncBookamat in src/lib/bookamat.ts), no archive copy
-- is made of it (getIssuedPdf in src/lib/pdf/snapshot.ts) and the portal shows no payments,
-- balance or payment details on it: a removed row reopens a paid invoice or raises what is open, a
-- recorded one is listed as received, and a booking takes its date, its amount and its account
-- (bank or Kassa) from the rows, so a Mahnung, a booking or a frozen PDF would carry what Claude
-- wrote without anyone approving it. A Claude session only ever sets or moves the mark forward
-- (documents_mcp_payments_guard); the owner's browser clears it.
-- An earlier version of this migration had no mark, or marked invoices only. Where one was
-- applied, every invoice and credit note with a payment or refund recorded or removed from a
-- Claude connection (document_events.actor) is marked once here, so the crons hold it until the
-- owner confirms its payments in Mado (also one confirmed before: confirming now releases the
-- Bookamat sync as well).
do $$
begin
  if exists (select 1 from pg_catalog.pg_attribute
             where attrelid = 'public.documents'::regclass and attname = 'mcp_payments_at' and not attisdropped)
     and not exists (select 1 from pg_catalog.pg_proc p
                     where p.oid = to_regprocedure('public.payments_mcp_mark()')
                       and p.prosrc like '%d.type = ''invoice''%') then
    return;
  end if;
  alter table public.documents add column if not exists mcp_payments_at timestamptz;
  execute $q$
    update public.documents d set mcp_payments_at = now()
    where d.type in ('invoice', 'credit_note') and d.mcp_payments_at is null
      and exists (select 1 from public.document_events e
                  where e.document_id = d.id and e.actor is not null
                    and e.type in ('payment_added', 'payment_removed'))
  $q$;
end;
$$;
alter table public.documents add column if not exists mcp_payments_at timestamptz;

create or replace function public.payments_mcp_mark()
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
    update public.documents d set mcp_payments_at = now()
    where d.id in (v_old, v_new);
  end if;
  return null;
end;
$$;

create or replace function public.documents_mcp_payments_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.is_mcp_session() then
    new.mcp_payments_at := greatest(old.mcp_payments_at, new.mcp_payments_at);
  end if;
  return new;
end;
$$;

drop trigger if exists payments_mcp_mark on public.payments;
create trigger payments_mcp_mark
  after insert or update or delete on public.payments
  for each row execute function public.payments_mcp_mark();
drop trigger if exists documents_mcp_payments_guard on public.documents;
create trigger documents_mcp_payments_guard
  before update of mcp_payments_at on public.documents
  for each row execute function public.documents_mcp_payments_guard();

-- ─── Function privileges ─────────────────────────────────────────────────────
revoke execute on function public.mcp_address_set(text[]) from public, anon;
grant execute on function public.mcp_address_set(text[]) to authenticated;
revoke execute on function public.document_items_mcp_guard() from public, anon, authenticated;
revoke execute on function public.documents_mcp_template_guard() from public, anon, authenticated;
revoke execute on function public.clients_mcp_recipients() from public, anon, authenticated;
revoke execute on function public.clients_mcp_recipients_seen() from public, anon, authenticated;
revoke execute on function public.mcp_actions_recipients() from public, anon, authenticated;
revoke execute on function public.payments_mcp_mark() from public, anon, authenticated;
revoke execute on function public.documents_mcp_payments_guard() from public, anon, authenticated;
