-- Checks the guards of supabase/migrations/20261105_mcp_drafts.sql: a Claude session writes the
-- lines of drafts only (MI044), and an address it put on a client sends an action naming it to
-- Mado for approval until the owner saves the client there.
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
  v_draft   uuid;
  v_issued  uuid;
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
  update public.settings set mcp_confirm_policy = '{"send_email": "chat", "send_reminder": "chat"}', mcp_approval_totp = true where id is not null;

  v_base := jsonb_build_object('sub', v_owner, 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2');
  perform set_config('mcp_test.client', v_client::text, true);
  perform set_config('mcp_test.draft', v_draft::text, true);
  perform set_config('mcp_test.issued', v_issued::text, true);
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

-- ─── Claude: addresses it writes are marked ──────────────────────────────────
do $$
declare
  v_client uuid := current_setting('mcp_test.client')::uuid;
  v_marks  text[];
  v_new    uuid;
  v        record;
begin
  update public.clients set cc_emails = array['Evil@Example.test'] where id = v_client returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('claude adds a CC: marked, lower-case; the owner''s email is not', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));
  update public.clients set mcp_recipients = '{}' where id = v_client returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('claude cannot clear the marks', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));
  update public.clients set phone = '+43 1 000' where id = v_client returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('claude changes another field: the marks stay', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));

  insert into public.clients (name, email, cc_emails, mcp_recipients) values ('MCP draft guard test 2', 'new@example.test', array['new-cc@example.test'], '{}')
    returning id, mcp_recipients into v_new, v_marks;
  perform public.mcp_drafts_test_ok('a client claude creates: its addresses marked', public.mcp_drafts_test_same(v_marks, array['new-cc@example.test', 'new@example.test']));
  update public.clients set email = 'New2@example.test' where id = v_new returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('claude replaces an email: the new one marked, the old mark gone', public.mcp_drafts_test_same(v_marks, array['new-cc@example.test', 'new2@example.test']));

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
  v_client uuid := current_setting('mcp_test.client')::uuid;
  v_marks  text[];
begin
  perform public.mcp_drafts_test_ok('browser: not a Claude session', not public.is_mcp_session());
  insert into public.document_items (document_id, sort_order, line_type, description)
  values (current_setting('mcp_test.issued')::uuid, 1, 'text', 'Owner note');
  perform public.mcp_drafts_test_ok('browser still writes an issued document''s lines',
    exists (select 1 from public.document_items where document_id = current_setting('mcp_test.issued')::uuid and description = 'Owner note'));

  update public.clients set phone = '+43 1 234' where id = v_client returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('browser: another field saved, the marks stay', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));
  update public.clients set mcp_recipients = '{}' where id = v_client returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('browser: the marks are not written directly', public.mcp_drafts_test_same(v_marks, array['evil@example.test']));
  update public.clients set email = email, cc_emails = cc_emails where id = v_client returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('browser: the client form saved, the marks are cleared', cardinality(v_marks) = 0);
  insert into public.clients (name, email) values ('MCP draft guard test 3', 'owner-new@example.test') returning mcp_recipients into v_marks;
  perform public.mcp_drafts_test_ok('browser: a new client has no marks', cardinality(v_marks) = 0);
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
