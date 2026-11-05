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
--     payments on its page in Mado (an applied credit marks the credit note it names too).
--     Meanwhile the reminder cron skips the invoice, the automatic Bookamat step skips the
--     document and no archive copy is made of it: removing a payment reopens a paid invoice or
--     raises what is open, so an automatic Mahnung would ask for money the client paid, and a
--     booking takes its date, amount and account from the rows.
--   * While an action the owner approved in Mado runs (mcp_actions 'running' via 'app', ten
--     minutes after the claim at most), a Claude session writes nothing the run reads: the
--     documents its arguments name, their lines and payments, the advance and partial invoices
--     such a final invoice deducts, and their clients (mcp_approved_run_guard, MI046). Issuing a
--     batch takes seconds per draft, and a draft later in it is still an unnumbered draft
--     meanwhile: what Claude wrote there after the approval would be numbered and frozen without
--     anyone approving it. Nor does an action Claude confirms in the chat start meanwhile on what
--     such a run holds (mcp_actions_chat_claim_guard, MI046): it runs on Claude's own session, so
--     what it records after sending (the email's sent date, the reminder's level) would be refused.
-- Error codes: MI044 = only a draft's lines can be changed from a Claude connection, MI045 = the
-- template of a recurring schedule cannot be changed or deleted from one, MI046 = an action the
-- owner approved is running on the document or its client (also refusing Claude's confirmation in
-- the chat of an action on it).
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
-- document, and an applied credit also on the credit note it names (credit_note_id): the credit
-- settles the credit note, and a settled credit note's refunds are booked. The mark stays until
-- the owner confirms the document's payments on its page in Mado. Meanwhile the reminder cron
-- skips the invoice and its automatic Bookamat step the document
-- (src/app/api/cron/reminders/route.ts, autoSyncBookamat in src/lib/bookamat.ts), no archive copy
-- is made of it (getIssuedPdf in src/lib/pdf/snapshot.ts) and the portal shows no payments,
-- balance or payment details on it: a removed row reopens a paid invoice or raises what is open, a
-- recorded one is listed as received, and a booking takes its date, its amount and its account
-- (bank or Kassa) from the rows, so a Mahnung, a booking or a frozen PDF would carry what Claude
-- wrote without anyone approving it. A Claude session only ever sets or moves the mark forward
-- (documents_mcp_payments_guard); the owner's browser clears it.
-- An earlier version of this migration had no mark, marked invoices only, or did not mark the
-- credit note an applied credit names. Where one without the mark or with invoices only was
-- applied, every invoice and credit note with a payment or refund recorded or removed from a
-- Claude connection (document_events.actor) is marked once here, so the crons hold it until the
-- owner confirms its payments in Mado (also one confirmed before: confirming now releases the
-- Bookamat sync as well). Where any earlier version was applied, so is every credit note a credit
-- recorded from a Claude connection names (its payment_added event on the invoice).
do $$
declare
  v_had  boolean := exists (select 1 from pg_catalog.pg_attribute
                            where attrelid = 'public.documents'::regclass and attname = 'mcp_payments_at' and not attisdropped);
  v_mark text := (select p.prosrc from pg_catalog.pg_proc p where p.oid = to_regprocedure('public.payments_mcp_mark()'));
begin
  if v_had and v_mark like '%credit_note_id%' then
    return;
  end if;
  alter table public.documents add column if not exists mcp_payments_at timestamptz;
  if not v_had or v_mark like '%d.type = ''invoice''%' then
    execute $q$
      update public.documents d set mcp_payments_at = now()
      where d.type in ('invoice', 'credit_note') and d.mcp_payments_at is null
        and exists (select 1 from public.document_events e
                    where e.document_id = d.id and e.actor is not null
                      and e.type in ('payment_added', 'payment_removed'))
    $q$;
  end if;
  execute $q$
    update public.documents d set mcp_payments_at = now()
    where d.type = 'credit_note' and d.mcp_payments_at is null
      and d.id::text in (select e.detail ->> 'credit_note_id' from public.document_events e
                         where e.actor is not null and e.type in ('payment_added', 'payment_removed')
                           and e.detail ->> 'kind' = 'credit')
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
  v_old    uuid;
  v_new    uuid;
  v_old_cn uuid;
  v_new_cn uuid;
begin
  if public.is_mcp_session() then
    if tg_op <> 'INSERT' then v_old := old.document_id; v_old_cn := old.credit_note_id; end if;
    if tg_op <> 'DELETE' then v_new := new.document_id; v_new_cn := new.credit_note_id; end if;
    update public.documents d set mcp_payments_at = now()
    where d.id in (v_old, v_new, v_old_cn, v_new_cn);
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

-- ─── Approved actions while they run ─────────────────────────────────────────
-- An action the owner approved in Mado is claimed (mcp_approve_action: status 'running',
-- claimed_via 'app'), its fingerprint is compared once more, and it runs on the owner's session
-- (runClaimed in src/lib/mcp/confirm.ts). Issuing takes seconds per document (the number, the PDF
-- rendered and stored, the Drive copy), and a draft later in the batch is still an unnumbered draft
-- meanwhile; an email, a reminder or a booking reads the client and the rows it is made of as the
-- run goes. So while the run lasts, a Claude session writes nothing it reads: the documents its
-- arguments name (document_ids, document_id, invoice_id, the draft or client to delete), their
-- lines and payments (also a credit that names such a credit note), the advance and partial
-- invoices such a final invoice deducts (final_invoice_id before or after the write: linking or
-- unlinking one, or a payment that marks it) and the clients of those documents (MI046). A Claude
-- write committed before the claim changes the fingerprint and stops the run; one after it is
-- refused here. The hold ends with the run, or ten minutes after the claim at most (STALE_RUN_MS
-- in src/lib/mcp/confirm.ts: a run that died with its function). An action Claude confirms in the
-- chat runs on Claude's own session, which this cannot tell apart from Claude's other writes; that
-- run, like an approved one, compares each draft again just before its number is taken and before
-- the email goes out (src/lib/mcp/actions/issue.ts), and it does not start while such a run holds
-- what it names (mcp_actions_chat_claim_guard below). The owner's browser, the crons and the
-- approved run itself are not affected.
create index if not exists mcp_actions_running_idx on public.mcp_actions(claimed_at) where status = 'running';

-- Whether such a run names one of the documents or clients, or a document of one of the clients.
-- Arguments that are no uuid name nothing.
create or replace function public.mcp_approved_run_holds(p_documents uuid[], p_clients uuid[])
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_documents uuid[];
  v_clients   uuid[];
begin
  select coalesce(array_agg(n.val::uuid) filter (where n.what = 'document'), '{}'),
         coalesce(array_agg(n.val::uuid) filter (where n.what = 'client'), '{}')
    into v_documents, v_clients
  from public.mcp_actions a,
       lateral (
         select e.val, 'document' from jsonb_array_elements_text(
           case when jsonb_typeof(a.args -> 'document_ids') = 'array' then a.args -> 'document_ids' else '[]'::jsonb end) e(val)
         union all select a.args ->> 'document_id', 'document'
         union all select a.args ->> 'invoice_id', 'document'
         union all select a.args ->> 'id', case a.args ->> 'kind' when 'draft' then 'document' when 'client' then 'client' end
           where a.kind = 'delete'
       ) n(val, what)
  where a.status = 'running' and a.claimed_via = 'app' and a.claimed_at > now() - interval '10 minutes'
    and n.what is not null
    and n.val ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  return v_documents && p_documents
      or v_clients && p_clients
      or exists (select 1 from public.documents d where d.id = any(v_documents) and d.client_id = any(p_clients));
end;
$$;

-- A Claude session's update or delete of a document or client, and any write of a line or payment
-- (of the document, or naming a credit note in credit_note_id), that such a run reads. A document
-- also counts for the final invoice that deducts it, before and after the write: issuing a final
-- invoice reads the invoices it deducts (src/lib/deposits.ts loadDepositCheck), and unlinking one
-- (unlinkDeposit) is a write of that invoice alone.
create or replace function public.mcp_approved_run_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_documents uuid[] := '{}';
  v_clients   uuid[] := '{}';
begin
  if public.is_mcp_session() then
    if tg_table_name = 'clients' then
      v_clients := array[old.id];
    elsif tg_table_name = 'documents' then
      v_documents := array[old.id, old.final_invoice_id];
      if tg_op <> 'DELETE' then v_documents := v_documents || new.final_invoice_id; end if;
    else
      if tg_op <> 'INSERT' then v_documents := array[old.document_id]; end if;
      if tg_op <> 'DELETE' then v_documents := v_documents || new.document_id; end if;
      if tg_table_name = 'payments' then
        if tg_op <> 'INSERT' then v_documents := v_documents || old.credit_note_id; end if;
        if tg_op <> 'DELETE' then v_documents := v_documents || new.credit_note_id; end if;
      end if;
    end if;
    if public.mcp_approved_run_holds(v_documents, v_clients) then
      raise exception using errcode = 'MI046',
        message = 'An action the owner approved is running on this document, its client or the final invoice that deducts it. Try again when it has finished.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists documents_mcp_run_guard on public.documents;
create trigger documents_mcp_run_guard
  before update or delete on public.documents
  for each row execute function public.mcp_approved_run_guard();
drop trigger if exists document_items_mcp_run_guard on public.document_items;
create trigger document_items_mcp_run_guard
  before insert or update or delete on public.document_items
  for each row execute function public.mcp_approved_run_guard();
drop trigger if exists payments_mcp_run_guard on public.payments;
create trigger payments_mcp_run_guard
  before insert or update or delete on public.payments
  for each row execute function public.mcp_approved_run_guard();
drop trigger if exists clients_mcp_run_guard on public.clients;
create trigger clients_mcp_run_guard
  before update or delete on public.clients
  for each row execute function public.mcp_approved_run_guard();

-- Claude confirms an action in the chat (mcp_claim_action: status 'running', claimed_via 'chat'):
-- it runs on Claude's own session, so while a run the owner approved in Mado holds what it names,
-- the guard above would refuse its writes as it goes. An email or a Mahnung would go out and the
-- record of it (sent_at, reminder_sent_at, reminder_level) be refused and only logged, and the
-- reminder cron would send the same Mahnung level again. So the claim is refused (MI046) while
-- such a run holds a document or client its arguments name (as mcp_approved_run_holds reads them),
-- the final invoice that deducts one of the documents or an advance or partial invoice one of them
-- deducts; the action stays pending and Claude confirms it again when that run has finished.
create or replace function public.mcp_actions_chat_claim_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_documents uuid[];
  v_clients   uuid[];
begin
  if new.status = 'running' and old.status = 'pending' and new.claimed_via = 'chat' then
    select coalesce(array_agg(n.val::uuid) filter (where n.what = 'document'), '{}'),
           coalesce(array_agg(n.val::uuid) filter (where n.what = 'client'), '{}')
      into v_documents, v_clients
    from (
      select e.val, 'document' from jsonb_array_elements_text(
        case when jsonb_typeof(new.args -> 'document_ids') = 'array' then new.args -> 'document_ids' else '[]'::jsonb end) e(val)
      union all select new.args ->> 'document_id', 'document'
      union all select new.args ->> 'invoice_id', 'document'
      union all select new.args ->> 'id', case new.args ->> 'kind' when 'draft' then 'document' when 'client' then 'client' end
        where new.kind = 'delete'
    ) n(val, what)
    where n.what is not null
      and n.val ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_documents := v_documents
      || coalesce((select array_agg(d.final_invoice_id) from public.documents d
                   where d.id = any(v_documents) and d.final_invoice_id is not null), '{}')
      || coalesce((select array_agg(d.id) from public.documents d where d.final_invoice_id = any(v_documents)), '{}');
    if public.mcp_approved_run_holds(v_documents, v_clients) then
      raise exception using errcode = 'MI046',
        message = 'An action the owner approved is running on a document or client this action names, or on the final invoice that deducts one. It stays prepared: confirm it again when that action has finished.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists mcp_actions_chat_claim_guard on public.mcp_actions;
create trigger mcp_actions_chat_claim_guard
  before update of status on public.mcp_actions
  for each row execute function public.mcp_actions_chat_claim_guard();

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
revoke execute on function public.mcp_approved_run_holds(uuid[], uuid[]) from public, anon, authenticated;
revoke execute on function public.mcp_approved_run_guard() from public, anon, authenticated;
revoke execute on function public.mcp_actions_chat_claim_guard() from public, anon, authenticated;
