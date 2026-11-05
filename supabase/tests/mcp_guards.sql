-- Checks the Claude connector's database guards (supabase/migrations/20261105_mcp.sql).
-- Run it in the Supabase SQL editor (postgres role) after the migration, while no action runs: once
-- 20261105_mcp_drafts.sql is applied as well, an action claimed in the last ten minutes refuses the
-- claims and approvals here (MI047, mcp_actions_one_run), and the script stops on that error. The
-- owner must be in app_users. Everything happens in one transaction that is rolled back, so nothing
-- stays behind.
-- Sessions are simulated with `set local role` and request.jwt.claims:
--   browser        the owner's browser at aal2, authenticator code entered a minute ago
--   browser_stale  the same session, code entered an hour ago
--   browser_aal1   the browser before the code step
--   claude         the session of a seeded claude.ai grant, at aal2
--   claude2        the session of a second (Claude Code) grant
-- Both grant sessions are seeded in auth.sessions too, as mcp_authenticate requires.
-- The first failed check stops the script with "FAIL <check>"; a clean run ends with the row
-- 'all MCP guard checks passed', selected after the rollback so the SQL editor shows it.

begin;

-- ─── Helpers (rolled back with everything else) ──────────────────────────────
create function public.mcp_test_ok(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
  raise notice 'ok   %', p_label;
end $$;

-- p_expected is a SQLSTATE (MI041, 42501, …) or the message of a plain exception ('rate_limited').
create function public.mcp_test_raises(p_label text, p_sql text, p_expected text) returns void language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
    v_msg := sqlerrm;
  end;
  if v_state is null then raise exception 'FAIL %: succeeded, expected %', p_label, p_expected; end if;
  if v_state <> p_expected and v_msg <> p_expected then
    raise exception 'FAIL %: expected %, got % (%)', p_label, p_expected, v_state, v_msg;
  end if;
  raise notice 'ok   %', p_label;
end $$;

create function public.mcp_test_h(p_value text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_value, 'UTF8')), 'hex')
$$;

grant execute on function public.mcp_test_ok(text, boolean), public.mcp_test_raises(text, text, text), public.mcp_test_h(text)
  to anon, authenticated, service_role;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
do $$
declare
  v_owner   uuid := (select user_id from public.app_users limit 1);
  v_now     numeric := extract(epoch from now());
  v_grant   uuid := gen_random_uuid();
  v_grant2  uuid := gen_random_uuid();
  v_browser uuid := gen_random_uuid();
  v_claude  uuid := gen_random_uuid();
  v_claude2 uuid := gen_random_uuid();
  v_client  uuid;
  v_doc     uuid;
  v_base    jsonb;
begin
  if v_owner is null then raise exception 'FAIL setup: app_users is empty; add the owner first'; end if;

  insert into auth.sessions (id, user_id, created_at, updated_at)
  values (v_claude, v_owner, now(), now()), (v_claude2, v_owner, now(), now());
  insert into public.mcp_grants (id, user_id, client_id, client_name, redirect_uri, client_kind, scopes, resource,
    consent_hash, sb_session_id, sb_access_enc, sb_refresh_enc, idle_expires_at, expires_at)
  values
    (v_grant, v_owner, 'https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude (guard test)', 'https://claude.ai/api/mcp/auth_callback',
     'claude_ai', array['mado:read', 'mado:write', 'mado:irreversible'], 'https://mado.test/api/mcp',
     public.mcp_test_h('consent_guard'), v_claude, 'v1.secret-access', 'v1.secret-refresh', now() + interval '30 days', now() + interval '90 days'),
    (v_grant2, v_owner, 'https://claude.ai/oauth/claude-code-client-metadata', 'Claude Code (guard test)', 'http://localhost:33418/callback',
     'claude_code', array['mado:read', 'mado:write', 'mado:irreversible'], 'https://mado.test/api/mcp',
     null, v_claude2, 'v1.secret-access', 'v1.secret-refresh', now() + interval '30 days', now() + interval '90 days');
  insert into public.mcp_tokens (token_hash, grant_id, kind, expires_at)
  values (public.mcp_test_h('mado_at_guard'), v_grant, 'access', now() + interval '1 hour'),
         (public.mcp_test_h('mado_at_expired'), v_grant, 'access', now() - interval '1 second'),
         (public.mcp_test_h('mado_rt_guard'), v_grant, 'refresh', now() + interval '30 days');
  insert into public.mcp_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, resource, scopes, expires_at)
  values (public.mcp_test_h('code_guard'), v_grant, 'x', 'x', 'x', 'x', array['mado:read'], now() + interval '2 minutes');

  insert into public.clients (name) values ('MCP guard test') returning id into v_client;
  insert into public.documents (type, client_id) values ('invoice', v_client) returning id into v_doc;
  update public.settings set mcp_confirm_policy = '{}', mcp_approval_totp = true where id is not null;

  v_base := jsonb_build_object('sub', v_owner, 'role', 'authenticated', 'aud', 'authenticated');
  perform set_config('mcp_test.grant', v_grant::text, true);
  perform set_config('mcp_test.grant2', v_grant2::text, true);
  perform set_config('mcp_test.doc', v_doc::text, true);
  perform set_config('mcp_test.has_factor', (exists (
    select 1 from auth.mfa_factors f where f.user_id = v_owner and f.status = 'verified'))::text, true);
  perform set_config('mcp_test.browser', (v_base || jsonb_build_object('aal', 'aal2', 'session_id', v_browser,
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', v_now - 60), jsonb_build_object('method', 'password', 'timestamp', v_now - 3600))))::text, true);
  perform set_config('mcp_test.browser_stale', (v_base || jsonb_build_object('aal', 'aal2', 'session_id', v_browser,
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', v_now - 3600), jsonb_build_object('method', 'password', 'timestamp', v_now - 3600))))::text, true);
  perform set_config('mcp_test.browser_aal1', (v_base || jsonb_build_object('aal', 'aal1', 'session_id', v_browser,
    'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', v_now - 60))))::text, true);
  perform set_config('mcp_test.claude', (v_base || jsonb_build_object('aal', 'aal2', 'session_id', v_claude,
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', v_now - 30), jsonb_build_object('method', 'otp', 'timestamp', v_now - 30))))::text, true);
  perform set_config('mcp_test.claude_aal1', (v_base || jsonb_build_object('aal', 'aal1', 'session_id', v_claude,
    'amr', jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', v_now - 30))))::text, true);
  perform set_config('mcp_test.claude2', (v_base || jsonb_build_object('aal', 'aal2', 'session_id', v_claude2,
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', v_now - 30), jsonb_build_object('method', 'otp', 'timestamp', v_now - 30))))::text, true);
end $$;

-- ─── Browser at aal2 ─────────────────────────────────────────────────────────
select set_config('request.jwt.claims', current_setting('mcp_test.browser'), true);
set local role authenticated;

do $$
declare
  v_event uuid;
  v_actor text;
begin
  perform public.mcp_test_ok('browser: owner with the second factor', public.is_app_user());
  perform public.mcp_test_ok('browser: not a Claude session', not public.is_mcp_session() and public.mcp_session_grant() is null);
  perform public.mcp_test_raises('browser cannot prepare (MI042)',
    $q$select public.mcp_create_action('h', 'issue', '{}', 'a', 'f', 'l', '{}', false)$q$, 'MI042');
  perform public.mcp_test_raises('mcp_codes unreadable', 'select count(*) from public.mcp_codes', '42501');
  perform public.mcp_test_raises('mcp_tokens unreadable', 'select count(*) from public.mcp_tokens', '42501');
  perform public.mcp_test_raises('grant session tokens unreadable', 'select sb_refresh_enc from public.mcp_grants', '42501');
  perform public.mcp_test_raises('grant session id unreadable', 'select sb_session_id from public.mcp_grants', '42501');
  perform public.mcp_test_raises('grant consent hash unreadable', 'select consent_hash from public.mcp_grants', '42501');
  perform public.mcp_test_ok('grants list readable',
    (select count(*) from public.mcp_grants where client_name like '%(guard test)') = 2);
  perform public.mcp_test_raises('actions not writable directly',
    $q$update public.mcp_actions set status = 'done' where id is not null$q$, '42501');
  perform public.mcp_test_raises('mcp_authenticate is service-role only', $q$select * from public.mcp_authenticate('x')$q$, '42501');
  perform public.mcp_test_raises('mcp_end_session is service-role only', 'select public.mcp_end_session(gen_random_uuid())', '42501');

  update public.settings set mcp_confirm_policy = '{"issue": "chat", "cancel": "app"}' where id is not null;
  perform public.mcp_test_ok('browser changes the policy', (select mcp_confirm_policy ->> 'issue' from public.settings) = 'chat');
  perform public.mcp_test_raises('policy values are app or chat',
    $q$update public.settings set mcp_confirm_policy = '{"issue": "yes"}' where id is not null$q$, '23514');

  insert into public.document_events (document_id, type, actor)
  values (current_setting('mcp_test.doc')::uuid, 'status_changed', 'claude_code')
  returning id, actor into v_event, v_actor;
  perform public.mcp_test_ok('browser event: a sent actor is cleared', v_actor is null);
  update public.document_events set actor = 'claude_code' where id = v_event returning actor into v_actor;
  perform public.mcp_test_ok('browser event: an actor cannot be set later', v_actor is null);
end $$;

-- ─── Claude grant session ────────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.claude'), true);
set local role authenticated;

do $$
declare
  v       record;
  v_event uuid;
  v_actor text;
begin
  perform public.mcp_test_ok('claude: recognised', public.is_mcp_session());
  perform public.mcp_test_ok('claude: its grant', public.mcp_session_grant() = current_setting('mcp_test.grant')::uuid);

  select * into v from public.mcp_create_action(public.mcp_test_h('mca_chat'), 'issue', '{"document_ids": []}', 'ah', 'fp', 'Issue 1 draft', '{}', false);
  perform public.mcp_test_ok('policy chat → chat', v.approval = 'chat');
  perform public.mcp_test_ok('valid 15 minutes', v.expires_at between now() + interval '14 minutes' and now() + interval '16 minutes');
  perform set_config('mcp_test.chat', v.id::text, true);

  select * into v from public.mcp_create_action(public.mcp_test_h('mca_forced'), 'issue', '{}', 'ah', 'fp', 'Issue 1 draft', '{}', true);
  perform public.mcp_test_ok('forced → app despite the policy', v.approval = 'app');
  select * into v from public.mcp_create_action(public.mcp_test_h('mca_cancel'), 'cancel', '{}', 'ah', 'fp', 'Cancel', '{}', false);
  perform public.mcp_test_ok('policy app → app', v.approval = 'app');
  perform set_config('mcp_test.cancel', v.id::text, true);
  select * into v from public.mcp_create_action(public.mcp_test_h('mca_delete'), 'delete', '{}', 'ah', 'fp', 'Delete', '{}', false);
  perform public.mcp_test_ok('kind missing from the policy → app', v.approval = 'app');
  perform set_config('mcp_test.delete', v.id::text, true);
  select * into v from public.mcp_create_action(public.mcp_test_h('mca_ias'), 'issue_and_send', '{}', 'ah', 'fp', 'Issue and send', '{}', false);
  perform public.mcp_test_ok('issue_and_send accepted, approved in Mado', v.approval = 'app');
  perform set_config('mcp_test.ias', v.id::text, true);
  perform public.mcp_test_raises('unknown kind refused',
    $q$select public.mcp_create_action('h-x', 'publish', '{}', 'a', 'f', 'l', '{}', false)$q$, '23514');
  perform public.mcp_create_action(public.mcp_test_h('mca_expire'), 'issue', '{}', 'ah', 'fp', 'Issue', '{}', false);
  perform public.mcp_create_action(public.mcp_test_h('mca_other'), 'issue', '{}', 'ah', 'fp', 'Issue', '{}', false);
  select * into v from public.mcp_create_action(public.mcp_test_h('mca_switch'), 'issue', '{}', 'ah', 'fp', 'Issue', '{}', false);
  perform public.mcp_test_ok('prepared while issue is confirmed in Claude', v.approval = 'chat');

  select * into v from public.mcp_claim_action(public.mcp_test_h('mca_chat'));
  perform public.mcp_test_ok('claim: running via chat', v.status = 'running' and v.claimed_via = 'chat' and v.claimed_at is not null);
  perform public.mcp_test_raises('claim twice (MI041)', format('select public.mcp_claim_action(%L)', public.mcp_test_h('mca_chat')), 'MI041');
  perform public.mcp_test_raises('claim an app action (MI041)', format('select public.mcp_claim_action(%L)', public.mcp_test_h('mca_forced')), 'MI041');
  perform public.mcp_test_raises('claim an unknown handle (MI041)', format('select public.mcp_claim_action(%L)', public.mcp_test_h('nope')), 'MI041');

  perform public.mcp_finish_action(v.id, true, '{"number": "R-2026-001"}', null);
  perform public.mcp_test_ok('finish: done with the result',
    (select status = 'done' and result ->> 'number' = 'R-2026-001' and finished_at is not null from public.mcp_actions where id = v.id));
  perform public.mcp_test_raises('finish twice (MI041)', format('select public.mcp_finish_action(%L, true, null, null)', v.id), 'MI041');

  perform public.mcp_test_raises('claude cannot approve (MI041)', format('select public.mcp_approve_action(%L)', current_setting('mcp_test.cancel')), 'MI041');
  perform public.mcp_test_raises('claude cannot reject (MI041)', format('select public.mcp_reject_action(%L)', current_setting('mcp_test.cancel')), 'MI041');

  perform public.mcp_test_raises('claude cannot change the policy (MI040)',
    $q$update public.settings set mcp_confirm_policy = '{}' where id is not null$q$, 'MI040');
  perform public.mcp_test_raises('claude cannot switch off the approval code (MI040)',
    $q$update public.settings set mcp_approval_totp = false where id is not null$q$, 'MI040');
  perform public.mcp_test_raises('claude cannot delete the settings row (MI040)',
    'delete from public.settings where id is not null', 'MI040');
  perform public.mcp_test_raises('claude cannot insert a settings row (MI040)',
    $q$insert into public.settings (mcp_confirm_policy, mcp_approval_totp) values ('{"issue": "chat", "send_email": "chat"}', false)$q$, 'MI040');
  update public.settings set company_name = company_name where id is not null;
  perform public.mcp_test_ok('claude still writes other settings', true);

  insert into public.document_events (document_id, type, actor)
  values (current_setting('mcp_test.doc')::uuid, 'status_changed', 'claude_code')
  returning id, actor into v_event, v_actor;
  perform public.mcp_test_ok('claude event: actor from the grant, not from the insert', v_actor = 'claude_ai');
  update public.document_events set actor = null where id = v_event returning actor into v_actor;
  perform public.mcp_test_ok('claude event: the actor cannot be cleared', v_actor = 'claude_ai');
end $$;

-- ─── A kind switched back to Mado after it was prepared ──────────────────────
reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.browser'), true);
set local role authenticated;
do $$ begin
  update public.settings set mcp_confirm_policy = '{"cancel": "app"}' where id is not null;
  perform public.mcp_test_ok('browser sets issue back to approval in Mado', (select mcp_confirm_policy ->> 'issue' from public.settings) is null);
end $$;

reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.claude'), true);
set local role authenticated;
do $$
declare
  v       record;
  v_found boolean;
begin
  select * into v from public.mcp_claim_action(public.mcp_test_h('mca_switch'));
  v_found := found;
  perform public.mcp_test_ok('claim after the switch: nothing claimed, no error', not v_found);
  perform public.mcp_test_ok('claim after the switch: the action waits for approval in Mado',
    (select approval = 'app' and status = 'pending' and claimed_at is null and claimed_via is null
       from public.mcp_actions where handle_hash = public.mcp_test_h('mca_switch')));
  perform public.mcp_test_raises('claim after the switch, again (MI041)', format('select public.mcp_claim_action(%L)', public.mcp_test_h('mca_switch')), 'MI041');
end $$;

reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.browser'), true);
set local role authenticated;
do $$ begin
  update public.settings set mcp_confirm_policy = '{"issue": "chat", "cancel": "app"}' where id is not null;
  perform public.mcp_test_ok('switched back to Claude: the moved action stays in Mado',
    (select approval = 'app' and status = 'pending' from public.mcp_actions where handle_hash = public.mcp_test_h('mca_switch')));
end $$;

-- ─── Expiry and a foreign grant ──────────────────────────────────────────────
reset role;
update public.mcp_actions set expires_at = now() - interval '1 second' where handle_hash = public.mcp_test_h('mca_expire');

select set_config('request.jwt.claims', current_setting('mcp_test.claude'), true);
set local role authenticated;
do $$ begin
  perform public.mcp_test_raises('claim after expiry (MI041)', format('select public.mcp_claim_action(%L)', public.mcp_test_h('mca_expire')), 'MI041');
end $$;

reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.claude2'), true);
set local role authenticated;
do $$
declare
  v record;
begin
  perform public.mcp_test_ok('second grant: its own session', public.is_mcp_session() and public.mcp_session_grant() <> current_setting('mcp_test.grant')::uuid);
  perform public.mcp_test_raises('another grant cannot claim (MI041)', format('select public.mcp_claim_action(%L)', public.mcp_test_h('mca_other')), 'MI041');
  select * into v from public.mcp_create_action(public.mcp_test_h('mca_revoked'), 'cancel', '{}', 'ah', 'fp', 'Cancel', '{}', false);
  perform set_config('mcp_test.revoked', v.id::text, true);
end $$;

reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.claude_aal1'), true);
set local role authenticated;
do $$ begin
  if current_setting('mcp_test.has_factor')::boolean then
    perform public.mcp_test_raises('claude session at aal1 cannot prepare (MI042)',
      $q$select public.mcp_create_action('h-aal1', 'issue', '{}', 'a', 'f', 'l', '{}', false)$q$, 'MI042');
    perform public.mcp_test_raises('claude session at aal1 cannot claim (MI041)', format('select public.mcp_claim_action(%L)', public.mcp_test_h('mca_other')), 'MI041');
  else
    raise notice 'skip aal1 checks: the owner has no verified authenticator factor';
  end if;
end $$;

-- ─── Approving in Mado ───────────────────────────────────────────────────────
reset role;
update public.mcp_grants set revoked_at = now(), revoked_reason = 'guard test' where id = current_setting('mcp_test.grant2')::uuid;
select set_config('request.jwt.claims', current_setting('mcp_test.browser_stale'), true);
set local role authenticated;
do $$ begin
  perform public.mcp_test_raises('approve without a fresh code (MI043)', format('select public.mcp_approve_action(%L)', current_setting('mcp_test.cancel')), 'MI043');
end $$;

reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.browser'), true);
set local role authenticated;
do $$
declare
  v record;
begin
  perform public.mcp_test_raises('approve what a revoked connection prepared (MI041)',
    format('select public.mcp_approve_action(%L)', current_setting('mcp_test.revoked')), 'MI041');
  perform public.mcp_reject_action(current_setting('mcp_test.revoked')::uuid);
  perform public.mcp_test_ok('reject what a revoked connection prepared',
    (select status = 'rejected' from public.mcp_actions where id = current_setting('mcp_test.revoked')::uuid));

  select * into v from public.mcp_approve_action(current_setting('mcp_test.cancel')::uuid);
  perform public.mcp_test_ok('approve: running via app', v.status = 'running' and v.claimed_via = 'app');
  perform public.mcp_test_raises('approve twice (MI041)', format('select public.mcp_approve_action(%L)', current_setting('mcp_test.cancel')), 'MI041');
  perform public.mcp_finish_action(v.id, false, null, '{"code": "MI012"}');
  perform public.mcp_test_ok('finish: failed with the error',
    (select status = 'failed' and error ->> 'code' = 'MI012' from public.mcp_actions where id = v.id));

  perform public.mcp_reject_action(current_setting('mcp_test.delete')::uuid);
  perform public.mcp_test_ok('reject', (select status = 'rejected' from public.mcp_actions where id = current_setting('mcp_test.delete')::uuid));
  perform public.mcp_test_raises('reject twice (MI041)', format('select public.mcp_reject_action(%L)', current_setting('mcp_test.delete')), 'MI041');

  update public.settings set mcp_approval_totp = false where id is not null;
end $$;

reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.browser_stale'), true);
set local role authenticated;
do $$
declare
  v record;
begin
  select * into v from public.mcp_approve_action(current_setting('mcp_test.ias')::uuid);
  perform public.mcp_test_ok('approval code switched off: an older code is enough', v.status = 'running' and v.claimed_via = 'app');
end $$;

-- ─── Browser before the code step ────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.browser_aal1'), true);
set local role authenticated;
do $$ begin
  if current_setting('mcp_test.has_factor')::boolean then
    perform public.mcp_test_ok('aal1: not the owner', not public.is_app_user());
    perform public.mcp_test_ok('aal1: no actions visible', (select count(*) from public.mcp_actions) = 0);
    perform public.mcp_test_ok('aal1: no grants visible', (select count(*) from public.mcp_grants) = 0);
    perform public.mcp_test_ok('aal1: no calls visible', (select count(*) from public.mcp_calls) = 0);
    perform public.mcp_test_raises('aal1: cannot approve (MI041)', format('select public.mcp_approve_action(%L)', current_setting('mcp_test.chat')), 'MI041');
  else
    raise notice 'skip aal1 checks: the owner has no verified authenticator factor';
  end if;
end $$;

-- ─── Anonymous ───────────────────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;
do $$ begin
  perform public.mcp_test_raises('anon: actions unreadable', 'select count(*) from public.mcp_actions', '42501');
  perform public.mcp_test_raises('anon: grants unreadable', 'select count(*) from public.mcp_grants', '42501');
  perform public.mcp_test_raises('anon: cannot prepare', $q$select public.mcp_create_action('h', 'issue', '{}', 'a', 'f', 'l', '{}', false)$q$, '42501');
end $$;

-- ─── Service role: bearer lookup and rate limit ──────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
set local role service_role;
do $$
declare
  v record;
begin
  select * into v from public.mcp_authenticate(public.mcp_test_h('mado_at_guard'));
  perform public.mcp_test_ok('authenticate: live token → its grant',
    v.grant_id = current_setting('mcp_test.grant')::uuid and v.client_kind = 'claude_ai' and v.sb_refresh_enc = 'v1.secret-refresh' and v.token_expires_at > now());
  perform public.mcp_test_ok('authenticate: counted and stamped',
    (select rate_minute_count = 1 and rate_day_count = 1 and last_used_at is not null from public.mcp_grants where id = v.grant_id));
  perform public.mcp_test_ok('authenticate: expired token → nothing',
    not exists (select 1 from public.mcp_authenticate(public.mcp_test_h('mado_at_expired'))));
  perform public.mcp_test_ok('authenticate: refresh token is no access token',
    not exists (select 1 from public.mcp_authenticate(public.mcp_test_h('mado_rt_guard'))));

  update public.mcp_grants set rate_day = (now() at time zone 'UTC')::date, rate_day_count = 3000 where id = v.grant_id;
  perform public.mcp_test_raises('authenticate: 3000 a day', format('select * from public.mcp_authenticate(%L)', public.mcp_test_h('mado_at_guard')), 'rate_limited');
  update public.mcp_grants set rate_day_count = 0, rate_minute = date_trunc('minute', now()), rate_minute_count = 120 where id = v.grant_id;
  perform public.mcp_test_raises('authenticate: 120 a minute', format('select * from public.mcp_authenticate(%L)', public.mcp_test_h('mado_at_guard')), 'rate_limited');

  update public.mcp_grants set rate_minute_count = 0, revoked_at = now(), revoked_reason = 'guard test' where id = v.grant_id;
  perform public.mcp_test_ok('authenticate: revoked grant → nothing',
    not exists (select 1 from public.mcp_authenticate(public.mcp_test_h('mado_at_guard'))));
  update public.mcp_grants set revoked_at = null, revoked_reason = null where id = v.grant_id;

  perform public.mcp_test_raises('one approved authorization request, one grant (23505)',
    format($q$insert into public.mcp_grants (user_id, client_id, client_name, redirect_uri, client_kind, scopes, resource, consent_hash, idle_expires_at, expires_at)
      values (%L, 'x', 'x', 'x', 'static', '{}', 'x', %L, now(), now())$q$, v.user_id, public.mcp_test_h('consent_guard')), '23505');

  -- Signed out everywhere or password changed: the grant's Supabase session is deleted.
  perform public.mcp_end_session(v.sb_session_id);
  perform public.mcp_test_ok('authenticate: session gone → nothing',
    not exists (select 1 from public.mcp_authenticate(public.mcp_test_h('mado_at_guard'))));
  perform public.mcp_test_ok('authenticate: session gone → the grant is revoked, its tokens deleted',
    (select revoked_at is not null and revoked_reason = 'session_ended' and sb_access_enc is null and sb_refresh_enc is null
       from public.mcp_grants where id = v.grant_id)
    and not exists (select 1 from public.mcp_tokens where grant_id = v.grant_id));
  update public.mcp_grants set revoked_at = null, revoked_reason = null where id = v.grant_id;

  perform public.mcp_end_session(gen_random_uuid());
  perform public.mcp_test_ok('end_session runs', true);

  insert into public.mcp_calls (grant_id, tool, ok, ms) values (v.grant_id, 'get_context', true, 12);
  perform public.mcp_test_ok('calls recorded', exists (select 1 from public.mcp_calls where grant_id = v.grant_id));
end $$;

-- ─── At most 20 pending per grant ────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims', current_setting('mcp_test.claude'), true);
set local role authenticated;
do $$
declare
  i integer := 0;
begin
  loop
    i := i + 1;
    begin
      perform public.mcp_create_action(public.mcp_test_h('mca_fill_' || i), 'issue', '{}', 'ah', 'fp', 'Issue', '{}', false);
    exception when others then
      if sqlerrm = 'too_many_pending' then exit; end if;
      raise;
    end;
    if i > 25 then raise exception 'FAIL pending limit: more than 20 pending accepted'; end if;
  end loop;
  perform public.mcp_test_ok('pending limit at 20',
    (select count(*) from public.mcp_actions where grant_id = current_setting('mcp_test.grant')::uuid and status = 'pending' and expires_at > now()) = 20);
end $$;

reset role;
rollback;

select 'all MCP guard checks passed' as result;
