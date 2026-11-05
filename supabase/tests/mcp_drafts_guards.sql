-- Checks the guards of supabase/migrations/20261105_mcp_drafts.sql: a Claude session writes the
-- lines of drafts only (MI044), leaves the template of a recurring schedule of either mode as it
-- is (MI045), and an address it put on a client sends an action naming it to Mado for approval
-- until the owner saves the client there; a client it changed keeps mcp_written_at until then, and
-- an invoice or credit note whose payments or refunds it changed keeps mcp_payments_at until the
-- owner confirms them (an applied credit marks the credit note too), and while an action the owner
-- approved runs it writes none of what the run reads and confirms no action on it in the chat
-- (MI046).
-- Run it in the Supabase SQL editor (postgres role) after both 20261105 migrations; the owner must
-- be in app_users. Everything happens in one transaction that is rolled back. Sessions are
-- simulated as in mcp_guards.sql ('browser' is the owner's browser at aal2, 'claude' a seeded
-- claude.ai grant's session). The first failed check stops the script with "FAIL <check>"; a clean
-- run ends with the row 'all MCP draft guard checks passed'.

begin;

-- ─── Helpers (rolled back with everything else) ──────────────────────────────
create function public.mcp_drafts_test_ok(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
  raise notice 'ok   %', p_label;
end $$;

create function public.mcp_drafts_test_raises(p_label text, p_sql text, p_expected text) returns void language plpgsql as $$
declare
  v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
  end;
  if v_state is null then raise exception 'FAIL %: succeeded, expected %', p_label, p_expected; end if;
  if v_state <> p_expected then raise exception 'FAIL %: expected %, got %', p_label, p_expected, v_state; end if;
  raise notice 'ok   %', p_label;
end $$;

-- The same addresses, in any order (the collation decides the stored order).
create function public.mcp_drafts_test_same(p_a text[], p_b text[]) returns boolean language sql immutable as $$
  select p_a @> p_b and p_a <@ p_b
$$;

grant execute on function public.mcp_drafts_test_ok(text, boolean), public.mcp_drafts_test_raises(text, text, text),
  public.mcp_drafts_test_same(text[], text[]) to authenticated;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
do $$
declare
  v_owner   uuid := (select user_id from public.app_users limit 1);
  v_now     numeric := extract(epoch from now());
  v_grant   uuid := gen_random_uuid();
  v_browser uuid := gen_random_uuid();
  v_claude  uuid := gen_random_uuid();
  v_client  uuid;
  v_other   uuid;
  v_draft   uuid;
  v_issued  uuid;
  v_tpl     uuid;
  v_tpl_is  uuid;
  v_tpl_dr  uuid;
  v_stale   uuid;
  v_paid    uuid;
  v_pay     uuid;
  v_cn      uuid;
  v_cinv    uuid;
  v_ccn     uuid;
  v_rclient uuid;
  v_rdraft  uuid;
  v_rinv    uuid;
  v_rcninv  uuid;
  v_rcn     uuid;
  v_rdep    uuid;
  v_rfree   uuid;
  v_sdraft  uuid;
  v_cdraft  uuid;
  v_base    jsonb;
begin
  if v_owner is null then raise exception 'FAIL setup: app_users is empty; add the owner first'; end if;

  insert into public.mcp_grants (id, user_id, client_id, client_name, redirect_uri, client_kind, scopes, resource,
    sb_session_id, sb_access_enc, sb_refresh_enc, idle_expires_at, expires_at)
  values (v_grant, v_owner, 'https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude (draft guard test)', 'https://claude.ai/api/mcp/auth_callback',
    'claude_ai', array['mado:read', 'mado:write', 'mado:irreversible'], 'https://mado.test/api/mcp',
    v_claude, 'v1.secret-access', 'v1.secret-refresh', now() + interval '30 days', now() + interval '90 days');

  insert into public.clients (name, email) values ('MCP draft guard test', 'known@example.test') returning id into v_client;
  insert into public.documents (type, client_id) values ('invoice', v_client) returning id into v_draft;
  insert into public.documents (type, client_id, number, status) values ('invoice', v_client, 'MCP-GUARD-TEST-1', 'sent') returning id into v_issued;
  insert into public.document_items (document_id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate)
  values (v_draft, 0, 'item', 'Draft line', 1, 'hour', 100, 20),
         (v_issued, 0, 'item', 'Issued line', 1, 'hour', 100, 20);

  -- Templates: a draft of a paused 'issue' schedule, an issued one of an active 'issue' schedule,
  -- and a draft of a 'draft' schedule.
  insert into public.clients (name) values ('MCP draft guard test, other') returning id into v_other;
  insert into public.documents (type, client_id, notes) values ('invoice', v_client, 'Template') returning id into v_tpl;
  insert into public.documents (type, client_id, number, status, notes) values ('invoice', v_client, 'MCP-GUARD-TEST-2', 'sent', 'Template') returning id into v_tpl_is;
  insert into public.documents (type, client_id, notes) values ('invoice', v_client, 'Template') returning id into v_tpl_dr;
  insert into public.document_items (document_id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate)
  values (v_tpl, 0, 'item', 'Retainer', 1, 'month', 500, 20),
         (v_tpl_is, 0, 'item', 'Retainer', 1, 'month', 500, 20),
         (v_tpl_dr, 0, 'item', 'Retainer', 1, 'month', 500, 20);
  insert into public.recurring_schedules (source_document_id, name, interval, anchor_day, next_date, mode, active)
  values (v_tpl, 'MCP draft guard test, issue, paused', 'monthly', 1, current_date + 30, 'issue', false),
         (v_tpl_is, 'MCP draft guard test, issue', 'monthly', 1, current_date + 30, 'issue', true),
         (v_tpl_dr, 'MCP draft guard test, draft', 'monthly', 1, current_date + 30, 'draft', true);
  update public.settings set mcp_confirm_policy = '{"send_email": "chat", "send_reminder": "chat"}', mcp_approval_totp = true where id is not null;

  -- A paid invoice, due a month ago.
  insert into public.documents (type, client_id, number, status, due_date) values ('invoice', v_other, 'MCP-GUARD-TEST-3', 'sent', current_date - 30) returning id into v_paid;
  insert into public.document_items (document_id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate)
  values (v_paid, 0, 'item', 'Paid line', 1, 'hour', 100, 20);
  insert into public.payments (document_id, date, amount, kind, method) values (v_paid, current_date - 20, 120, 'payment', 'bank') returning id into v_pay;
  update public.documents set status = 'paid' where id = v_paid;
  -- An issued credit note of that invoice, nothing paid back yet.
  insert into public.documents (type, client_id, number, status, converted_from_id) values ('credit_note', v_other, 'MCP-GUARD-TEST-CN-1', 'sent', v_paid) returning id into v_cn;
  insert into public.document_items (document_id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate)
  values (v_cn, 0, 'item', 'Credited line', 1, 'hour', 100, 20);
  -- An issued invoice and an issued credit note of it, not applied yet.
  insert into public.documents (type, client_id, number, status) values ('invoice', v_other, 'MCP-GUARD-TEST-4', 'sent') returning id into v_cinv;
  insert into public.documents (type, client_id, number, status, converted_from_id) values ('credit_note', v_other, 'MCP-GUARD-TEST-CN-2', 'sent', v_cinv) returning id into v_ccn;
  insert into public.document_items (document_id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate)
  values (v_cinv, 0, 'item', 'Invoiced line', 1, 'hour', 100, 20),
         (v_ccn, 0, 'item', 'Credited line', 1, 'hour', 50, 20);

  -- Actions the owner approved, running on the owner's session: an issue of a draft final invoice
  -- (its client is held with it, so are the advance invoice it deducts and a partial invoice
  -- linked to it meanwhile), a reminder of an issued invoice (its id upper-case in the arguments)
  -- and a Bookamat sync of an issued credit note, all for one client. Holding nothing: a run
  -- approved eleven minutes ago (died with its function) and one Claude confirmed in the chat.
  insert into public.clients (name) values ('MCP draft guard test, approved run') returning id into v_rclient;
  insert into public.documents (type, client_id, invoice_kind) values ('invoice', v_rclient, 'final') returning id into v_rdraft;
  insert into public.documents (type, client_id, number, status, invoice_kind, final_invoice_id)
  values ('invoice', v_rclient, 'MCP-GUARD-TEST-7', 'sent', 'advance', v_rdraft) returning id into v_rdep;
  insert into public.documents (type, client_id, number, status, invoice_kind)
  values ('invoice', v_rclient, 'MCP-GUARD-TEST-8', 'sent', 'partial') returning id into v_rfree;
  insert into public.documents (type, client_id, number, status) values ('invoice', v_rclient, 'MCP-GUARD-TEST-5', 'sent') returning id into v_rinv;
  insert into public.documents (type, client_id, number, status) values ('invoice', v_rclient, 'MCP-GUARD-TEST-6', 'sent') returning id into v_rcninv;
  insert into public.documents (type, client_id, number, status, converted_from_id) values ('credit_note', v_rclient, 'MCP-GUARD-TEST-CN-3', 'sent', v_rcninv) returning id into v_rcn;
  insert into public.documents (type, client_id) values ('invoice', v_other) returning id into v_sdraft;
  insert into public.documents (type, client_id) values ('invoice', v_other) returning id into v_cdraft;
  insert into public.document_items (document_id, sort_order, line_type, description, quantity, unit, unit_price, vat_rate)
  values (v_rdraft, 0, 'item', 'Approved line', 2, 'hour', 100, 20),
         (v_rinv, 0, 'item', 'Reminded line', 1, 'hour', 100, 20),
         (v_rcninv, 0, 'item', 'Corrected line', 1, 'hour', 100, 20),
         (v_rcn, 0, 'item', 'Credited line', 1, 'hour', 100, 20);
  insert into public.mcp_actions (handle_hash, grant_id, kind, args, args_hash, fingerprint, label, approval, status, expires_at, claimed_at, claimed_via, claimed_session)
  values ('h-run-issue', v_grant, 'issue', jsonb_build_object('document_ids', jsonb_build_array(v_rdraft), 'redate_to_today', true), 'ah', 'fp', 'Issue', 'app', 'running', now() + interval '15 minutes', now(), 'app', v_browser),
         ('h-run-remind', v_grant, 'send_reminder', jsonb_build_object('invoice_id', upper(v_rinv::text), 'mode', 'manual'), 'ah', 'fp', 'Remind', 'app', 'running', now() + interval '15 minutes', now(), 'app', v_browser),
         ('h-run-sync', v_grant, 'bookamat_sync', jsonb_build_object('document_id', v_rcn), 'ah', 'fp', 'Sync', 'app', 'running', now() + interval '15 minutes', now(), 'app', v_browser),
         ('h-run-stale', v_grant, 'issue', jsonb_build_object('document_ids', jsonb_build_array(v_sdraft), 'redate_to_today', true), 'ah', 'fp', 'Issue', 'app', 'running', now() + interval '15 minutes', now() - interval '11 minutes', 'app', v_browser),
         ('h-run-chat', v_grant, 'issue', jsonb_build_object('document_ids', jsonb_build_array(v_cdraft), 'redate_to_today', true), 'ah', 'fp', 'Issue', 'chat', 'running', now() + interval '15 minutes', now(), 'chat', v_claude);

  -- A client as an earlier version of mcp_address_set (lower()) left it: Claude wrote the email and
  -- the mark has the earlier, glibc lower() form. The trigger is bypassed to store that mark.
  alter table public.clients disable trigger clients_mcp_recipients;
  insert into public.clients (name, email, mcp_recipients)
  values ('MCP draft guard test, earlier mark', 'İnfo@attacker.example', array['info@attacker.example']) returning id into v_stale;
  alter table public.clients enable trigger clients_mcp_recipients;

  v_base := jsonb_build_object('sub', v_owner, 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2');
  perform set_config('mcp_test.client', v_client::text, true);
  perform set_config('mcp_test.draft', v_draft::text, true);
  perform set_config('mcp_test.issued', v_issued::text, true);
  perform set_config('mcp_test.other', v_other::text, true);
  perform set_config('mcp_test.tpl', v_tpl::text, true);
  perform set_config('mcp_test.tpl_issued', v_tpl_is::text, true);
  perform set_config('mcp_test.tpl_draft', v_tpl_dr::text, true);
  perform set_config('mcp_test.stale', v_stale::text, true);
  perform set_config('mcp_test.paid', v_paid::text, true);
  perform set_config('mcp_test.payment', v_pay::text, true);
  perform set_config('mcp_test.credit_note', v_cn::text, true);
  perform set_config('mcp_test.credit_invoice', v_cinv::text, true);
  perform set_config('mcp_test.credit_cn', v_ccn::text, true);
  perform set_config('mcp_test.run_client', v_rclient::text, true);
  perform set_config('mcp_test.run_draft', v_rdraft::text, true);
  perform set_config('mcp_test.run_invoice', v_rinv::text, true);
  perform set_config('mcp_test.run_cn_invoice', v_rcninv::text, true);
  perform set_config('mcp_test.run_credit_note', v_rcn::text, true);
  perform set_config('mcp_test.run_deposit', v_rdep::text, true);
  perform set_config('mcp_test.run_free_deposit', v_rfree::text, true);
  perform set_config('mcp_test.stale_run_draft', v_sdraft::text, true);
  perform set_config('mcp_test.chat_run_draft', v_cdraft::text, true);
  perform set_config('mcp_test.browser', (v_base || jsonb_build_object('session_id', v_browser,
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', v_now - 60))))::text, true);
  perform set_config('mcp_test.claude', (v_base || jsonb_build_object('session_id', v_claude,
    'amr', jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', v_now - 30))))::text, true);
end $$;

-- ─── Claude: lines of drafts only ────────────────────────────────────────────
select set_config('request.jwt.claims', current_setting('mcp_test.claude'), true);
set local role authenticated;

do $$
declare
  v_draft  uuid := current_setting('mcp_test.draft')::uuid;
  v_issued uuid := current_setting('mcp_test.issued')::uuid;
  v_line   uuid := (select id from public.document_items where document_id = v_draft limit 1);
begin
  perform public.mcp_drafts_test_ok('claude: recognised', public.is_mcp_session());
  perform public.replace_document_items(v_draft, jsonb_build_array(
    jsonb_build_object('id', v_line, 'sort_order', 0, 'line_type', 'item', 'description', 'Draft line, edited', 'quantity', 2, 'unit', 'hour', 'unit_price', 100, 'vat_rate', 20),
    jsonb_build_object('id', gen_random_uuid(), 'sort_order', 1, 'line_type', 'text', 'description', 'Note')));
  perform public.mcp_drafts_test_ok('claude saves a draft''s lines',
    (select count(*) = 2 and bool_or(description = 'Draft line, edited') from public.document_items where document_id = v_draft));
  delete from public.document_items where document_id = v_draft and line_type = 'text';
  perform public.mcp_drafts_test_ok('claude deletes a draft''s line',
    (select count(*) = 1 from public.document_items where document_id = v_draft));

  perform public.mcp_drafts_test_raises('claude cannot replace an issued document''s lines (MI044)',
    format($q$select public.replace_document_items(%L, '[]'::jsonb)$q$, v_issued), 'MI044');
  perform public.mcp_drafts_test_raises('claude cannot add a line to an issued document (MI044)',
    format($q$insert into public.document_items (document_id, sort_order, line_type, description) values (%L, 1, 'text', 'x')$q$, v_issued), 'MI044');
  perform public.mcp_drafts_test_raises('claude cannot change an issued document''s line (MI044)',
    format($q$update public.document_items set description = 'x' where document_id = %L$q$, v_issued), 'MI044');
  perform public.mcp_drafts_test_raises('claude cannot delete an issued document''s line (MI044)',
    format($q$delete from public.document_items where document_id = %L$q$, v_issued), 'MI044');
  perform public.mcp_drafts_test_raises('claude cannot move a draft line onto an issued document (MI044)',
    format($q$update public.document_items set document_id = %L where document_id = %L$q$, v_issued, v_draft), 'MI044');
  perform public.mcp_drafts_test_ok('the issued document''s line is unchanged',
    (select count(*) = 1 and bool_and(description = 'Issued line') from public.document_items where document_id = v_issued));
end $$;

-- ─── Claude: templates of recurring schedules ────────────────────────────────
do $$
declare
  v_tpl    uuid := current_setting('mcp_test.tpl')::uuid;
  v_tpl_is uuid := current_setting('mcp_test.tpl_issued')::uuid;
  v_tpl_dr uuid := current_setting('mcp_test.tpl_draft')::uuid;
  v_other  uuid := current_setting('mcp_test.other')::uuid;
begin
  perform public.mcp_drafts_test_raises('claude cannot change a paused issue template''s notes (MI045)',
    format($q$update public.documents set notes = 'Pay to another account' where id = %L$q$, v_tpl), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot change its discount (MI045)',
    format($q$update public.documents set discount_type = 'percent', discount_value = 50 where id = %L$q$, v_tpl), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot change its client (MI045)',
    format($q$update public.documents set client_id = %L where id = %L$q$, v_other, v_tpl), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot change its tax treatment (MI045)',
    format($q$update public.documents set tax_treatment = 'non_eu' where id = %L$q$, v_tpl), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot replace its lines (MI045)',
    format($q$select public.replace_document_items(%L, '[]'::jsonb)$q$, v_tpl), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot add a line (MI045)',
    format($q$insert into public.document_items (document_id, sort_order, line_type, description, quantity, unit_price, vat_rate) values (%L, 1, 'item', 'Extra', 1, 9999, 20)$q$, v_tpl), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot change a line (MI045)',
    format($q$update public.document_items set unit_price = 5000 where document_id = %L$q$, v_tpl), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot delete a line (MI045)',
    format($q$delete from public.document_items where document_id = %L$q$, v_tpl), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot delete the template (MI045)',
    format($q$delete from public.documents where id = %L$q$, v_tpl), 'MI045');
  perform public.mcp_drafts_test_ok('the paused template is as the owner left it',
    (select notes = 'Template' and discount_type is null and client_id = current_setting('mcp_test.client')::uuid and tax_treatment = 'at_vat'
       from public.documents where id = v_tpl)
    and (select count(*) = 1 and bool_and(unit_price = 500) from public.document_items where document_id = v_tpl));
  update public.documents set service_date = current_date where id = v_tpl;
  perform public.mcp_drafts_test_ok('claude still sets what the cron does not copy',
    (select service_date = current_date from public.documents where id = v_tpl));

  perform public.mcp_drafts_test_raises('claude cannot change an issued issue template''s notes (MI045)',
    format($q$update public.documents set notes = 'x' where id = %L$q$, v_tpl_is), 'MI045');
  perform public.mcp_drafts_test_raises('an issued template''s line: MI044 first',
    format($q$update public.document_items set unit_price = 1 where document_id = %L$q$, v_tpl_is), 'MI044');
  update public.documents set reminder_level = 1, notes = notes where id = v_tpl_is;
  perform public.mcp_drafts_test_ok('claude still records a reminder on an issued template',
    (select reminder_level = 1 and notes = 'Template' from public.documents where id = v_tpl_is));

  -- A schedule that creates drafts can be switched to issue them in Mado without the template
  -- being opened again: its template is locked for Claude as well.
  perform public.mcp_drafts_test_raises('claude cannot change a draft-mode schedule''s template notes (MI045)',
    format($q$update public.documents set notes = 'Edited by Claude' where id = %L$q$, v_tpl_dr), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot add a line to a draft-mode schedule''s template (MI045)',
    format($q$insert into public.document_items (document_id, sort_order, line_type, description) values (%L, 1, 'text', 'Note')$q$, v_tpl_dr), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot replace a draft-mode schedule''s template lines (MI045)',
    format($q$select public.replace_document_items(%L, '[]'::jsonb)$q$, v_tpl_dr), 'MI045');
  perform public.mcp_drafts_test_raises('claude cannot delete a draft-mode schedule''s template (MI045)',
    format($q$delete from public.documents where id = %L$q$, v_tpl_dr), 'MI045');
  perform public.mcp_drafts_test_ok('the draft-mode schedule''s template is as the owner left it',
    (select notes = 'Template' from public.documents where id = v_tpl_dr)
    and (select count(*) = 1 and bool_and(description = 'Retainer') from public.document_items where document_id = v_tpl_dr));
end $$;

-- ─── Claude: payments of an invoice ──────────────────────────────────────────
do $$
declare
  v_paid   uuid := current_setting('mcp_test.paid')::uuid;
  v_issued uuid := current_setting('mcp_test.issued')::uuid;
  v_cn     uuid := current_setting('mcp_test.credit_note')::uuid;
  v_status text;
  v_at     timestamptz;
begin
  perform public.mcp_drafts_test_ok('an invoice whose payments claude has not changed: no mcp_payments_at',
    (select mcp_payments_at is null and status = 'paid' from public.documents where id = v_paid));
  v_status := public.remove_payment(current_setting('mcp_test.payment')::uuid, true);
  select mcp_payments_at into v_at from public.documents where id = v_paid;
  perform public.mcp_drafts_test_ok('claude removes the payment of a paid, past-due invoice: overdue again, mcp_payments_at set',
    v_status = 'overdue' and v_at is not null);
  update public.documents set mcp_payments_at = null where id = v_paid returning mcp_payments_at into v_at;
  perform public.mcp_drafts_test_ok('claude cannot clear mcp_payments_at', v_at is not null);
  update public.documents set mcp_payments_at = now() - interval '1 day' where id = v_paid returning mcp_payments_at into v_at;
  perform public.mcp_drafts_test_ok('claude cannot move mcp_payments_at back', v_at > now() - interval '1 hour');
  perform public.mcp_drafts_test_ok('an issued invoice claude has not paid: no mcp_payments_at',
    (select mcp_payments_at is null from public.documents where id = v_issued));
  insert into public.payments (document_id, date, amount, kind, method) values (v_issued, current_date, 10, 'payment', 'bank');
  perform public.mcp_drafts_test_ok('claude records a payment: mcp_payments_at set',
    (select mcp_payments_at is not null from public.documents where id = v_issued));
  -- The automatic Bookamat step books a credit note's refunds with their date, amount and account.
  perform public.mcp_drafts_test_ok('a credit note claude has not refunded: no mcp_payments_at',
    (select mcp_payments_at is null from public.documents where id = v_cn));
  insert into public.payments (document_id, date, amount, kind, method) values (v_cn, current_date - 3, 120, 'refund', 'cash');
  select mcp_payments_at into v_at from public.documents where id = v_cn;
  perform public.mcp_drafts_test_ok('claude records a refund on a credit note: mcp_payments_at set', v_at is not null);
  update public.documents set mcp_payments_at = null where id = v_cn returning mcp_payments_at into v_at;
  perform public.mcp_drafts_test_ok('claude cannot clear a credit note''s mcp_payments_at', v_at is not null);
  -- An applied credit settles the credit note it names, and a settled credit note's refunds are
  -- booked: the credit note is marked as well as the invoice.
  insert into public.payments (document_id, date, amount, kind, method, note, credit_note_id)
  values (current_setting('mcp_test.credit_invoice')::uuid, current_date, 60, 'credit', 'bank', 'MCP-GUARD-TEST-CN-2', current_setting('mcp_test.credit_cn')::uuid);
  perform public.mcp_drafts_test_ok('claude applies a credit note: the invoice and the credit note get mcp_payments_at',
    (select bool_and(mcp_payments_at is not null) and count(*) = 2 from public.documents
     where id in (current_setting('mcp_test.credit_invoice')::uuid, current_setting('mcp_test.credit_cn')::uuid)));
end $$;

-- ─── Claude: while an action the owner approved runs ─────────────────────────
do $$
declare
  v_rdraft  uuid := current_setting('mcp_test.run_draft')::uuid;
  v_rclient uuid := current_setting('mcp_test.run_client')::uuid;
  v_rinv    uuid := current_setting('mcp_test.run_invoice')::uuid;
  v_rcninv  uuid := current_setting('mcp_test.run_cn_invoice')::uuid;
  v_rcn     uuid := current_setting('mcp_test.run_credit_note')::uuid;
  v_rdep    uuid := current_setting('mcp_test.run_deposit')::uuid;
  v_rfree   uuid := current_setting('mcp_test.run_free_deposit')::uuid;
begin
  perform public.mcp_drafts_test_raises('claude cannot change a draft an approved issue runs on (MI046)',
    format($q$update public.documents set notes = 'Pay to another account' where id = %L$q$, v_rdraft), 'MI046');
  perform public.mcp_drafts_test_raises('claude cannot replace its lines (MI046)',
    format($q$select public.replace_document_items(%L, '[]'::jsonb)$q$, v_rdraft), 'MI046');
  perform public.mcp_drafts_test_raises('claude cannot add a line to it (MI046)',
    format($q$insert into public.document_items (document_id, sort_order, line_type, description, quantity, unit_price, vat_rate) values (%L, 1, 'item', 'Extra', 40, 250, 20)$q$, v_rdraft), 'MI046');
  perform public.mcp_drafts_test_raises('claude cannot take the advance invoice it deducts off it (MI046)',
    format($q$update public.documents set final_invoice_id = null where id = %L$q$, v_rdep), 'MI046');
  perform public.mcp_drafts_test_raises('claude cannot link another partial invoice to it (MI046)',
    format($q$update public.documents set final_invoice_id = %L where id = %L$q$, v_rdraft, v_rfree), 'MI046');
  perform public.mcp_drafts_test_raises('claude cannot record a payment on the advance invoice it deducts (MI046)',
    format($q$insert into public.payments (document_id, date, amount, kind, method) values (%L, current_date, 120, 'payment', 'bank')$q$, v_rdep), 'MI046');
  perform public.mcp_drafts_test_raises('claude cannot change its client (MI046)',
    format($q$update public.clients set company = 'ACME Treuhand (neu)', address_line1 = 'Postfach 9' where id = %L$q$, v_rclient), 'MI046');
  perform public.mcp_drafts_test_raises('claude cannot record a payment on an invoice an approved reminder runs on, named upper-case (MI046)',
    format($q$insert into public.payments (document_id, date, amount, kind, method) values (%L, current_date, 120, 'payment', 'bank')$q$, v_rinv), 'MI046');
  perform public.mcp_drafts_test_raises('claude cannot apply a credit note an approved Bookamat sync runs on (MI046)',
    format($q$insert into public.payments (document_id, date, amount, kind, method, credit_note_id) values (%L, current_date, 120, 'credit', 'bank', %L)$q$, v_rcninv, v_rcn), 'MI046');
  perform public.mcp_drafts_test_raises('claude cannot record a refund on it (MI046)',
    format($q$insert into public.payments (document_id, date, amount, kind, method) values (%L, current_date, 10, 'refund', 'bank')$q$, v_rcn), 'MI046');
  perform public.mcp_drafts_test_ok('what the approved runs read is as the owner approved it',
    (select notes is null from public.documents where id = v_rdraft)
    and (select count(*) = 1 and bool_and(description = 'Approved line' and quantity = 2) from public.document_items where document_id = v_rdraft)
    and (select company is null and coalesce(address_line1, '') = '' from public.clients where id = v_rclient)
    and (select final_invoice_id = v_rdraft and mcp_payments_at is null from public.documents where id = v_rdep)
    and (select final_invoice_id is null from public.documents where id = v_rfree)
    and not exists (select 1 from public.payments where document_id in (v_rinv, v_rcninv, v_rcn, v_rdep)));

  -- Claude confirms in the chat an action on what such a run holds: it does not start and stays
  -- pending (it would run on Claude's session, where the record of the reminder it sent is
  -- refused). One on an invoice nothing holds starts.
  perform public.mcp_create_action('h-chat-held', 'send_reminder', jsonb_build_object('invoice_id', v_rinv, 'mode', 'manual'), 'ah', 'fp', 'Remind', '{}', false);
  perform public.mcp_drafts_test_raises('claude cannot confirm in the chat a reminder on an invoice an approved reminder runs on (MI046)',
    $q$select public.mcp_claim_action('h-chat-held')$q$, 'MI046');
  perform public.mcp_create_action('h-chat-deposit', 'send_reminder', jsonb_build_object('invoice_id', v_rdep, 'mode', 'manual'), 'ah', 'fp', 'Remind', '{}', false);
  perform public.mcp_drafts_test_raises('nor one on the advance invoice a final draft an approved issue runs on deducts (MI046)',
    $q$select public.mcp_claim_action('h-chat-deposit')$q$, 'MI046');
  perform public.mcp_drafts_test_ok('both stay pending, to be confirmed in the chat',
    (select count(*) = 2 and bool_and(status = 'pending' and approval = 'chat' and claimed_at is null)
     from public.mcp_actions where handle_hash in ('h-chat-held', 'h-chat-deposit')));
  perform public.mcp_create_action('h-chat-free', 'send_reminder', jsonb_build_object('invoice_id', current_setting('mcp_test.issued')::uuid, 'mode', 'manual'), 'ah', 'fp', 'Remind', '{}', false);
  perform public.mcp_drafts_test_ok('one on an invoice no approved run holds starts',
    (select status = 'running' and claimed_via = 'chat' from public.mcp_claim_action('h-chat-free')));

  update public.documents set notes = 'Claude' where id = current_setting('mcp_test.stale_run_draft')::uuid;
  perform public.mcp_drafts_test_ok('a run claimed more than ten minutes ago holds nothing',
    (select notes = 'Claude' from public.documents where id = current_setting('mcp_test.stale_run_draft')::uuid));
  update public.documents set notes = 'Claude' where id = current_setting('mcp_test.chat_run_draft')::uuid;
  perform public.mcp_drafts_test_ok('a run Claude confirmed in the chat holds nothing (Claude''s own session runs it)',
    (select notes = 'Claude' from public.documents where id = current_setting('mcp_test.chat_run_draft')::uuid));
end $$;

-- ─── Claude: addresses it writes are marked ──────────────────────────────────
do $$
declare
  v_client  uuid := current_setting('mcp_test.client')::uuid;
  v_other   uuid := current_setting('mcp_test.other')::uuid;
  v_stale   uuid := current_setting('mcp_test.stale')::uuid;
  v_marks   text[];
  v_written timestamptz;
  v_new     uuid;
  v         record;
begin
  perform public.mcp_drafts_test_ok('a client claude has not changed: no mcp_written_at',
    (select mcp_written_at is null from public.clients where id = v_client));
  update public.clients set cc_emails = array['Evil@Example.test'] where id = v_client returning mcp_recipients, mcp_written_at into v_marks, v_written;
  perform public.mcp_drafts_test_ok('claude adds a CC: marked, lower-case; the owner''s email is not', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));
  perform public.mcp_drafts_test_ok('claude changed the client: mcp_written_at set', v_written is not null);
  update public.clients set mcp_written_at = null where id = v_client returning mcp_written_at into v_written;
  perform public.mcp_drafts_test_ok('claude cannot clear mcp_written_at', v_written is not null);
  update public.clients set name = name, email = email where id = v_other returning mcp_written_at into v_written;
  perform public.mcp_drafts_test_ok('a claude write that changes nothing leaves mcp_written_at unset', v_written is null);
  update public.clients set company = 'ACME - NEW BANK DETAILS', payment_days = 0 where id = v_other returning mcp_written_at into v_written;
  perform public.mcp_drafts_test_ok('claude changes the company and terms: mcp_written_at set', v_written is not null);

  -- The earlier mark names no address as mcp_address_set gives them now: every address on the
  -- client stays marked through a write that does not touch them.
  update public.clients set phone = '+43 1 555' where id = v_stale returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('a mark in the earlier form: claude changes the phone, the address stays marked',
    public.mcp_drafts_test_same(v_marks, array['İnfo@attacker.example']));
  select * into v from public.mcp_create_action('h-stale', 'send_email', jsonb_build_object('to', jsonb_build_array('İnfo@attacker.example')), 'ah', 'fp', 'Send', '{}', false);
  perform public.mcp_drafts_test_ok('the address behind the earlier mark: approved in Mado', v.approval = 'app');
  update public.clients set mcp_recipients = '{}' where id = v_client returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('claude cannot clear the marks', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));
  update public.clients set phone = '+43 1 000' where id = v_client returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('claude changes another field: the marks stay', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));

  insert into public.clients (name, email, cc_emails, mcp_recipients, mcp_written_at) values ('MCP draft guard test 2', 'new@example.test', array['new-cc@example.test'], '{}', null)
    returning id, mcp_recipients, mcp_written_at into v_new, v_marks, v_written;
  perform public.mcp_drafts_test_ok('a client claude creates: its addresses marked', public.mcp_drafts_test_same(v_marks, array['new-cc@example.test', 'new@example.test']));
  perform public.mcp_drafts_test_ok('a client claude creates: mcp_written_at set', v_written is not null);
  update public.clients set email = 'New2@example.test' where id = v_new returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('claude replaces an email: the new one marked, the old mark gone', public.mcp_drafts_test_same(v_marks, array['new-cc@example.test', 'new2@example.test']));
  -- Only A-Z are lower-cased and only JavaScript's \s and , ; < > split, whatever the database
  -- locale, so the reminder cron's copy in the app gives the same marks (lower() would turn U+0130
  -- into 'i' here and 'i' + U+0307 there; U+0085 is no \s, U+00A0 is).
  perform public.mcp_drafts_test_ok('the address set splits on ASCII and Unicode spaces and , ; < >, not on U+0085',
    public.mcp_drafts_test_same(public.mcp_address_set(array['A@B.at' || chr(9) || 'c@d.at' || chr(11) || 'E@F.at, g@h.at;<I@J.at>' || chr(160) || 'k@l.at' || chr(12288) || 'm' || chr(133) || '@N.at']),
      array['a@b.at', 'c@d.at', 'e@f.at', 'g@h.at', 'i@j.at', 'k@l.at', 'm' || chr(133) || '@n.at']));
  insert into public.clients (name, email, cc_emails) values ('MCP draft guard test 4', 'İ@Example.test', array['ΚΑΣ@Example.test', 'odd' || chr(133) || '@Example.test'])
    returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('non-ASCII addresses claude writes: marked with only A-Z lower-cased',
    public.mcp_drafts_test_same(v_marks, array['İ@example.test', 'ΚΑΣ@example.test', 'odd' || chr(133) || '@example.test']));
  select * into v from public.mcp_create_action('h-nonascii', 'send_email', jsonb_build_object('document_id', gen_random_uuid(), 'to', jsonb_build_array('İ@EXAMPLE.TEST'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb, 'subject', 'Invoice', 'body', 'Hello'), 'ah', 'fp', 'Send', '{}', false);
  perform public.mcp_drafts_test_ok('a non-ASCII address claude wrote, other case: approved in Mado', v.approval = 'app');

  select * into v from public.mcp_create_action('h-known', 'send_email', jsonb_build_object('document_id', gen_random_uuid(), 'to', jsonb_build_array('known@example.test'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb, 'subject', 'Invoice', 'body', 'Hello'), 'ah', 'fp', 'Send', '{}', false);
  perform public.mcp_drafts_test_ok('the owner''s address: the chat policy holds', v.approval = 'chat');
  select * into v from public.mcp_create_action('h-cc', 'send_email', jsonb_build_object('document_id', gen_random_uuid(), 'to', jsonb_build_array('known@example.test'), 'cc', jsonb_build_array('EVIL@example.test'), 'bcc', '[]'::jsonb, 'subject', 'Invoice', 'body', 'Hello'), 'ah', 'fp', 'Send', '{}', false);
  perform public.mcp_drafts_test_ok('a CC claude wrote: approved in Mado', v.approval = 'app');
  select * into v from public.mcp_create_action('h-reminder', 'send_reminder', jsonb_build_object('invoice_id', gen_random_uuid(), 'mode', 'gmail', 'to', jsonb_build_array('new2@example.test'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb), 'ah', 'fp', 'Remind', '{}', false);
  perform public.mcp_drafts_test_ok('a reminder to a client claude created: approved in Mado', v.approval = 'app');
  select * into v from public.mcp_create_action('h-body', 'send_email', jsonb_build_object('document_id', gen_random_uuid(), 'to', jsonb_build_array('known@example.test'), 'body', 'Reply to Evil <evil@example.test>'), 'ah', 'fp', 'Send', '{}', false);
  perform public.mcp_drafts_test_ok('the address named in the text: approved in Mado', v.approval = 'app');
  select * into v from public.mcp_create_action('h-forced', 'send_email', jsonb_build_object('to', jsonb_build_array('known@example.test')), 'ah', 'fp', 'Send', '{}', true);
  perform public.mcp_drafts_test_ok('forced stays forced', v.approval = 'app');
  perform set_config('mcp_test.new_client', v_new::text, true);
end $$;

-- ─── The owner in Mado ───────────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.browser'), true);
set local role authenticated;

do $$
declare
  v_client  uuid := current_setting('mcp_test.client')::uuid;
  v_paid    uuid := current_setting('mcp_test.paid')::uuid;
  v_marks   text[];
  v_written timestamptz;
  v_at      timestamptz;
begin
  perform public.mcp_drafts_test_ok('browser: not a Claude session', not public.is_mcp_session());
  update public.documents set mcp_payments_at = null where id = v_paid returning mcp_payments_at into v_at;
  perform public.mcp_drafts_test_ok('browser: the owner confirms the payments, mcp_payments_at cleared', v_at is null);
  insert into public.payments (document_id, date, amount, kind, method) values (v_paid, current_date, 120, 'payment', 'bank');
  perform public.mcp_drafts_test_ok('browser: a payment the owner records sets no mcp_payments_at',
    (select mcp_payments_at is null from public.documents where id = v_paid));
  update public.documents set mcp_payments_at = null where id = current_setting('mcp_test.credit_note')::uuid returning mcp_payments_at into v_at;
  perform public.mcp_drafts_test_ok('browser: the owner confirms a credit note''s refunds, mcp_payments_at cleared', v_at is null);
  delete from public.payments where document_id = current_setting('mcp_test.credit_note')::uuid and kind = 'refund';
  perform public.mcp_drafts_test_ok('browser: a refund the owner removes sets no mcp_payments_at',
    (select mcp_payments_at is null from public.documents where id = current_setting('mcp_test.credit_note')::uuid));
  update public.documents set mcp_payments_at = null where id = current_setting('mcp_test.credit_cn')::uuid returning mcp_payments_at into v_at;
  perform public.mcp_drafts_test_ok('browser: the owner confirms the applied credit note, mcp_payments_at cleared', v_at is null);
  delete from public.payments where credit_note_id = current_setting('mcp_test.credit_cn')::uuid and kind = 'credit';
  perform public.mcp_drafts_test_ok('browser: a credit the owner removes marks neither document again',
    (select mcp_payments_at is null from public.documents where id = current_setting('mcp_test.credit_cn')::uuid));

  -- The approved actions run on the owner's session: it is not held.
  update public.documents set notes = 'Owner edit' where id = current_setting('mcp_test.run_draft')::uuid;
  insert into public.document_items (document_id, sort_order, line_type, description) values (current_setting('mcp_test.run_draft')::uuid, 1, 'text', 'Owner note');
  update public.clients set company = 'Owner Co' where id = current_setting('mcp_test.run_client')::uuid;
  insert into public.payments (document_id, date, amount, kind, method) values (current_setting('mcp_test.run_invoice')::uuid, current_date, 10, 'payment', 'bank');
  update public.documents set final_invoice_id = null where id = current_setting('mcp_test.run_deposit')::uuid;
  perform public.mcp_drafts_test_ok('browser: the owner''s session, which runs the approved actions, is not held',
    (select notes = 'Owner edit' from public.documents where id = current_setting('mcp_test.run_draft')::uuid)
    and (select count(*) = 2 from public.document_items where document_id = current_setting('mcp_test.run_draft')::uuid)
    and (select company = 'Owner Co' from public.clients where id = current_setting('mcp_test.run_client')::uuid)
    and exists (select 1 from public.payments where document_id = current_setting('mcp_test.run_invoice')::uuid)
    and (select final_invoice_id is null from public.documents where id = current_setting('mcp_test.run_deposit')::uuid));
  insert into public.document_items (document_id, sort_order, line_type, description)
  values (current_setting('mcp_test.issued')::uuid, 1, 'text', 'Owner note');
  perform public.mcp_drafts_test_ok('browser still writes an issued document''s lines',
    exists (select 1 from public.document_items where document_id = current_setting('mcp_test.issued')::uuid and description = 'Owner note'));

  update public.documents set notes = 'Owner edit' where id = current_setting('mcp_test.tpl')::uuid;
  insert into public.document_items (document_id, sort_order, line_type, description) values (current_setting('mcp_test.tpl')::uuid, 1, 'text', 'Owner note');
  perform public.mcp_drafts_test_ok('browser still edits the template of an issue schedule',
    (select notes = 'Owner edit' from public.documents where id = current_setting('mcp_test.tpl')::uuid)
    and (select count(*) = 2 from public.document_items where document_id = current_setting('mcp_test.tpl')::uuid));
  update public.documents set notes = 'Owner edit' where id = current_setting('mcp_test.tpl_draft')::uuid;
  perform public.mcp_drafts_test_ok('browser still edits the template of a draft-mode schedule',
    (select notes = 'Owner edit' from public.documents where id = current_setting('mcp_test.tpl_draft')::uuid));
  -- A template delete approved in Mado runs on the owner's session; its schedule goes with it.
  delete from public.documents where id = current_setting('mcp_test.tpl_draft')::uuid;
  perform public.mcp_drafts_test_ok('browser still deletes a template, with its schedule',
    not exists (select 1 from public.documents where id = current_setting('mcp_test.tpl_draft')::uuid)
    and not exists (select 1 from public.recurring_schedules where source_document_id = current_setting('mcp_test.tpl_draft')::uuid));

  update public.clients set phone = '+43 1 234' where id = v_client returning mcp_recipients, mcp_written_at into v_marks, v_written;
  perform public.mcp_drafts_test_ok('browser: another field saved, the marks stay', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));
  perform public.mcp_drafts_test_ok('browser: another field saved, mcp_written_at stays', v_written is not null);
  update public.clients set mcp_recipients = '{}', mcp_written_at = null where id = v_client returning mcp_recipients, mcp_written_at into v_marks, v_written;
  perform public.mcp_drafts_test_ok('browser: the marks are not written directly', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));
  perform public.mcp_drafts_test_ok('browser: mcp_written_at is not cleared directly', v_written is not null);
  update public.clients set email = email, cc_emails = cc_emails where id = v_client returning mcp_recipients, mcp_written_at into v_marks, v_written;
  perform public.mcp_drafts_test_ok('browser: the client form saved, the marks are cleared', cardinality(v_marks) = 0);
  perform public.mcp_drafts_test_ok('browser: the client form saved, mcp_written_at cleared', v_written is null);
  update public.clients set email = email, cc_emails = cc_emails where id = current_setting('mcp_test.stale')::uuid returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('browser: the client form saved, the earlier mark is cleared too', cardinality(v_marks) = 0);
  insert into public.clients (name, email, mcp_recipients, mcp_written_at) values ('MCP draft guard test 3', 'owner-new@example.test', array['owner-new@example.test'], now())
    returning mcp_recipients, mcp_written_at into v_marks, v_written;
  perform public.mcp_drafts_test_ok('browser: a new client has no marks', cardinality(v_marks) = 0);
  perform public.mcp_drafts_test_ok('browser: a new client has no mcp_written_at', v_written is null);
end $$;

-- ─── Claude after the owner saved the client ─────────────────────────────────
reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.claude'), true);
set local role authenticated;

do $$
declare
  v record;
begin
  select * into v from public.mcp_create_action('h-after', 'send_email', jsonb_build_object('to', jsonb_build_array('evil@example.test')), 'ah', 'fp', 'Send', '{}', false);
  perform public.mcp_drafts_test_ok('saved by the owner: the chat policy holds again', v.approval = 'chat');
  select * into v from public.mcp_create_action('h-new', 'send_email', jsonb_build_object('to', jsonb_build_array('new-cc@example.test')), 'ah', 'fp', 'Send', '{}', false);
  perform public.mcp_drafts_test_ok('the client claude created is still marked', v.approval = 'app');
end $$;

reset role;
rollback;

select 'all MCP draft guard checks passed' as result;
