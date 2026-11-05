-- Claude connector (MCP server at /api/mcp, the app's own OAuth authorization server):
--   * mcp_grants: one row per Claude connection the owner approved. Each grant holds its own aal2
--     Supabase session (created at consent with a fresh authenticator code), encrypted by the app;
--     every MCP query runs as the owner through that session, under the unchanged RLS.
--   * mcp_codes, mcp_tokens: authorization codes and Claude's opaque tokens, stored as SHA-256 only.
--   * mcp_actions: irreversible actions Claude prepared (issue, send, remind, Storno, cancel,
--     delete, Bookamat sync, issue and send). The approval channel is decided here from
--     settings.mcp_confirm_policy ('app' unless the owner set the kind to 'chat'); only the grant
--     that prepared a 'chat' action can claim it, and only while its kind is still set to 'chat'
--     (switched back, the action moves to Mado); only a browser session can approve or reject.
--   * mcp_calls: the tool-call audit (tool, ok, error code, duration), kept 90 days.
--   * settings.mcp_confirm_policy and settings.mcp_approval_totp (approving in Mado asks for a
--     current authenticator code) cannot be changed from a Claude session, nor can it insert or
--     delete the settings row (MI040).
--   * document_events.actor: 'claude_ai', 'claude_code' or 'static' when a Claude session wrote the
--     event, null for the browser and the crons. Set by a trigger on insert and kept on update, so
--     it cannot be spoofed.
-- Error codes: MI040 = the policy cannot be changed from a Claude connection, MI041 = the action is
-- unknown, expired, already used or not executable on this channel, MI042 = only a Claude
-- connection can prepare actions, MI043 = approving needs a fresh authenticator code.
-- 'rate_limited' (detail 'minute' or 'day', hint = seconds until the window resets) and
-- 'too_many_pending' are raised as plain exceptions (P0001) and handled by the app.
-- is_app_user(), mfa_satisfied() and every existing policy stay as they are. Mirrored in
-- supabase/schema.sql; supabase/tests/mcp_guards.sql checks the guards and rolls back.
-- Idempotent — safe to re-run.

-- ─── Settings and history ────────────────────────────────────────────────────
alter table public.settings
  add column if not exists mcp_confirm_policy jsonb not null default '{}'
    constraint settings_mcp_confirm_policy_check check (
      jsonb_typeof(mcp_confirm_policy) = 'object'
      and not jsonb_path_exists(mcp_confirm_policy, '$.* ? (@.type() != "string" || (@ != "app" && @ != "chat"))')
    );
alter table public.settings add column if not exists mcp_approval_totp boolean not null default true;

alter table public.document_events
  add column if not exists actor text
    constraint document_events_actor_check check (actor is null or actor in ('claude_ai', 'claude_code', 'static'));

-- ─── Grants, codes, tokens ───────────────────────────────────────────────────
create table if not exists public.mcp_grants (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  client_id            text not null,
  client_name          text not null,
  redirect_uri         text not null,
  client_kind          text not null constraint mcp_grants_client_kind_check check (client_kind in ('claude_ai', 'claude_code', 'static')),
  scopes               text[] not null,
  resource             text not null,
  -- SHA-256 of the signed authorization request the owner approved: one request, one grant.
  consent_hash         text unique,
  -- The grant's own Supabase session; its tokens are AES-256-GCM encrypted by the app (AAD = id).
  sb_session_id        uuid unique,
  sb_access_enc        text,
  sb_access_expires_at timestamptz,
  sb_refresh_enc       text,
  -- One request at a time refreshes the session token.
  sb_lease_until       timestamptz,
  created_at           timestamptz not null default now(),
  last_used_at         timestamptz,
  -- Moved forward by every refresh; the grant dies after a month without one.
  idle_expires_at      timestamptz not null,
  expires_at           timestamptz not null,
  revoked_at           timestamptz,
  revoked_reason       text,
  rate_minute          timestamptz,
  rate_minute_count    integer not null default 0,
  rate_day             date,
  rate_day_count       integer not null default 0
);

create table if not exists public.mcp_codes (
  code_hash      text primary key,
  grant_id       uuid not null references public.mcp_grants(id) on delete cascade,
  client_id      text not null,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text not null,
  scopes         text[] not null,
  expires_at     timestamptz not null,
  used_at        timestamptz
);

create table if not exists public.mcp_tokens (
  token_hash  text primary key,
  grant_id    uuid not null references public.mcp_grants(id) on delete cascade,
  kind        text not null constraint mcp_tokens_kind_check check (kind in ('access', 'refresh')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  -- A refresh token presented again more than 10 s after rotated_at is theft: the grant is
  -- revoked. Within the 10 s (concurrent refreshes, a retry) the app issues a fresh pair.
  rotated_at  timestamptz,
  parent_hash text
);

create index if not exists mcp_tokens_grant_id_idx on public.mcp_tokens(grant_id);
create index if not exists mcp_tokens_expires_at_idx on public.mcp_tokens(expires_at);

-- ─── Prepared actions ────────────────────────────────────────────────────────
create table if not exists public.mcp_actions (
  id              uuid primary key default gen_random_uuid(),
  -- SHA-256 of the confirmation id Claude holds ('mca_…'); the id itself is never stored.
  handle_hash     text not null unique,
  grant_id        uuid not null references public.mcp_grants(id) on delete cascade,
  kind            text not null constraint mcp_actions_kind_check check (kind in (
                    'issue', 'issue_and_send', 'send_email', 'send_reminder', 'storno', 'cancel', 'delete', 'bookamat_sync')),
  args            jsonb not null,
  args_hash       text not null,
  -- The state the action depends on when it was prepared; re-checked before it runs.
  fingerprint     text not null,
  label           text not null,
  preview         jsonb not null default '{}',
  approval        text not null constraint mcp_actions_approval_check check (approval in ('chat', 'app')),
  status          text not null default 'pending' constraint mcp_actions_status_check check (status in ('pending', 'running', 'done', 'failed', 'rejected')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  claimed_at      timestamptz,
  claimed_via     text constraint mcp_actions_claimed_via_check check (claimed_via is null or claimed_via in ('chat', 'app')),
  -- The session that runs it; only that session can record the outcome.
  claimed_session uuid,
  finished_at     timestamptz,
  result          jsonb,
  error           jsonb
);

create index if not exists mcp_actions_grant_id_idx on public.mcp_actions(grant_id, status);
create index if not exists mcp_actions_pending_idx on public.mcp_actions(created_at) where status = 'pending';

-- ─── Call audit ──────────────────────────────────────────────────────────────
create table if not exists public.mcp_calls (
  id         bigint generated always as identity primary key,
  grant_id   uuid not null references public.mcp_grants(id) on delete cascade,
  tool       text not null,
  ok         boolean not null,
  error_code text,
  ms         integer,
  created_at timestamptz not null default now()
);

create index if not exists mcp_calls_created_at_idx on public.mcp_calls(created_at);
create index if not exists mcp_calls_grant_id_idx on public.mcp_calls(grant_id);

-- ─── Access ──────────────────────────────────────────────────────────────────
-- Codes and tokens are for the service role only. The owner reads the grants' non-secret
-- columns, the actions and the calls; every write goes through the service role or the RPCs below.
alter table public.mcp_grants  enable row level security;
alter table public.mcp_codes   enable row level security;
alter table public.mcp_tokens  enable row level security;
alter table public.mcp_actions enable row level security;
alter table public.mcp_calls   enable row level security;

revoke all on table public.mcp_grants, public.mcp_codes, public.mcp_tokens, public.mcp_actions, public.mcp_calls from anon, authenticated;
grant select (id, client_name, client_kind, redirect_uri, scopes, created_at, last_used_at, idle_expires_at, expires_at, revoked_at, revoked_reason)
  on public.mcp_grants to authenticated;
grant select on public.mcp_actions, public.mcp_calls to authenticated;

drop policy if exists "owner reads" on public.mcp_grants;
create policy "owner reads" on public.mcp_grants for select to authenticated using (public.is_app_user());
drop policy if exists "owner reads" on public.mcp_actions;
create policy "owner reads" on public.mcp_actions for select to authenticated using (public.is_app_user());
drop policy if exists "owner reads" on public.mcp_calls;
create policy "owner reads" on public.mcp_calls for select to authenticated using (public.is_app_user());

-- ─── Which session is Claude ─────────────────────────────────────────────────
-- The session id of the request's JWT; null without one (service role, SQL editor) or when it
-- is not a uuid.
create or replace function public.mcp_jwt_session_id()
returns uuid
language sql stable
set search_path = ''
as $$
  select case when (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (auth.jwt() ->> 'session_id')::uuid end
$$;

-- The live grant this request's session belongs to, or null for a browser session.
create or replace function public.mcp_session_grant()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select g.id from public.mcp_grants g
  where g.sb_session_id = public.mcp_jwt_session_id()
    and g.user_id = auth.uid()
    and g.revoked_at is null
    and g.expires_at > now()
$$;

-- True for any session that was ever a grant's, revoked or not.
create or replace function public.is_mcp_session()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.mcp_grants g where g.sb_session_id = public.mcp_jwt_session_id())
$$;

-- ─── Bearer token lookup (service role) ──────────────────────────────────────
-- The live grant behind an unexpired access token, counted against the per-grant rate limit
-- (120 calls a minute, 3000 a day). No row: unknown, expired or revoked. A grant whose Supabase
-- session no longer exists (signed out everywhere, password changed) is revoked here
-- ('session_ended'), so its cached session JWT is not used for the rest of its hour.
create or replace function public.mcp_authenticate(p_token_hash text)
returns table (
  grant_id             uuid,
  user_id              uuid,
  client_id            text,
  client_name          text,
  client_kind          text,
  scopes               text[],
  resource             text,
  token_expires_at     timestamptz,
  sb_session_id        uuid,
  sb_access_enc        text,
  sb_access_expires_at timestamptz,
  sb_refresh_enc       text,
  sb_lease_until       timestamptz
)
language plpgsql security definer
set search_path = ''
as $$
declare
  t      public.mcp_tokens%rowtype;
  g      public.mcp_grants%rowtype;
  v_minute timestamptz := date_trunc('minute', now());
  v_day    date := (now() at time zone 'UTC')::date;
begin
  select * into t from public.mcp_tokens tk
  where tk.token_hash = p_token_hash and tk.kind = 'access' and tk.expires_at > now();
  if not found then return; end if;

  select * into g from public.mcp_grants gr
  where gr.id = t.grant_id and gr.revoked_at is null and gr.expires_at > now() and gr.idle_expires_at > now()
  for update;
  if not found then return; end if;

  if not exists (select 1 from auth.sessions s where s.id = g.sb_session_id and s.user_id = g.user_id) then
    update public.mcp_grants gr set
      revoked_at = now(), revoked_reason = 'session_ended',
      sb_access_enc = null, sb_access_expires_at = null, sb_refresh_enc = null, sb_lease_until = null
    where gr.id = g.id;
    delete from public.mcp_tokens tk where tk.grant_id = g.id;
    return;
  end if;

  if g.rate_minute is distinct from v_minute then g.rate_minute := v_minute; g.rate_minute_count := 0; end if;
  if g.rate_day is distinct from v_day then g.rate_day := v_day; g.rate_day_count := 0; end if;
  if g.rate_minute_count >= 120 then
    raise exception using message = 'rate_limited', detail = 'minute',
      hint = ceil(extract(epoch from (v_minute + interval '1 minute' - now())))::text;
  end if;
  if g.rate_day_count >= 3000 then
    raise exception using message = 'rate_limited', detail = 'day',
      hint = ceil(extract(epoch from ((v_day + 1)::timestamp at time zone 'UTC' - now())))::text;
  end if;

  update public.mcp_grants gr set
    rate_minute = g.rate_minute,
    rate_minute_count = g.rate_minute_count + 1,
    rate_day = g.rate_day,
    rate_day_count = g.rate_day_count + 1,
    last_used_at = case when gr.last_used_at is null or gr.last_used_at < now() - interval '1 minute' then now() else gr.last_used_at end
  where gr.id = g.id;

  return query select g.id, g.user_id, g.client_id, g.client_name, g.client_kind, g.scopes, g.resource, t.expires_at,
    g.sb_session_id, g.sb_access_enc, g.sb_access_expires_at, g.sb_refresh_enc, g.sb_lease_until;
end;
$$;

-- Ends a Supabase session (and its refresh tokens): a revoked grant, refresh-token reuse, a
-- consent whose code was wrong.
create or replace function public.mcp_end_session(p_session_id uuid)
returns void
language sql security definer
set search_path = ''
as $$
  delete from auth.sessions where id = p_session_id
$$;

-- ─── Preparing and running actions ───────────────────────────────────────────
-- Stores what Claude prepared. The channel comes from the owner's policy: 'chat' only when the
-- kind is set to 'chat' and the app did not force approval in Mado (an address not on the client
-- record, an action Claude Code's timeout could cut short).
create or replace function public.mcp_create_action(
  p_handle_hash text,
  p_kind        text,
  p_args        jsonb,
  p_args_hash   text,
  p_fingerprint text,
  p_label       text,
  p_preview     jsonb,
  p_force_app   boolean
)
returns table (id uuid, approval text, expires_at timestamptz)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_grant    uuid := public.mcp_session_grant();
  v_approval text;
  v_row      public.mcp_actions%rowtype;
begin
  if v_grant is null or not public.is_app_user() then
    raise exception using errcode = 'MI042', message = 'Only a Claude connection can prepare actions.';
  end if;

  -- What never ran goes after a week, what ran stays on record for 90 days.
  delete from public.mcp_actions a
  where a.grant_id = v_grant
    and ((a.status in ('pending', 'rejected') and a.created_at < now() - interval '7 days')
      or a.created_at < now() - interval '90 days');

  if (select count(*) from public.mcp_actions a
      where a.grant_id = v_grant and a.status = 'pending' and a.expires_at > now()) >= 20 then
    raise exception using message = 'too_many_pending';
  end if;

  v_approval := case
    when coalesce(p_force_app, true) then 'app'
    when coalesce((select s.mcp_confirm_policy ->> p_kind from public.settings s limit 1), 'app') = 'chat' then 'chat'
    else 'app' end;

  insert into public.mcp_actions (handle_hash, grant_id, kind, args, args_hash, fingerprint, label, preview, approval, expires_at)
  values (p_handle_hash, v_grant, p_kind, p_args, p_args_hash, p_fingerprint, p_label, coalesce(p_preview, '{}'), v_approval, now() + interval '15 minutes')
  returning * into v_row;

  return query select v_row.id, v_row.approval, v_row.expires_at;
end;
$$;

-- Claude runs a 'chat' action: only the grant that prepared it, only once, only while pending
-- and unexpired, and only while the owner's policy still lets Claude confirm its kind. A kind
-- switched back to approval in Mado since moves the pending action there: its approval becomes
-- 'app', nothing is claimed and no row is returned (raising would undo the move), so the app
-- answers with the approval link.
create or replace function public.mcp_claim_action(p_handle_hash text)
returns setof public.mcp_actions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_grant uuid := public.mcp_session_grant();
  v_row   public.mcp_actions%rowtype;
begin
  if v_grant is not null and public.is_app_user() then
    update public.mcp_actions a set approval = 'app'
    where a.handle_hash = p_handle_hash and a.grant_id = v_grant and a.approval = 'chat'
      and a.status = 'pending' and a.expires_at > now()
      and coalesce((select s.mcp_confirm_policy ->> a.kind from public.settings s limit 1), 'app') <> 'chat';
    if found then return; end if;

    update public.mcp_actions a set
      status = 'running', claimed_at = now(), claimed_via = 'chat', claimed_session = public.mcp_jwt_session_id()
    where a.handle_hash = p_handle_hash and a.grant_id = v_grant and a.approval = 'chat'
      and a.status = 'pending' and a.expires_at > now()
    returning * into v_row;
  end if;
  if v_row.id is null then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
  return next v_row;
end;
$$;

-- The owner approves in Mado: never from a Claude session, and with mcp_approval_totp on only
-- with an authenticator code entered in the last five minutes. What a revoked connection prepared
-- (refresh-token reuse revokes it as theft) can only be rejected.
create or replace function public.mcp_approve_action(p_id uuid)
returns setof public.mcp_actions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_row    public.mcp_actions%rowtype;
begin
  if not public.is_app_user() or public.is_mcp_session() or public.mcp_jwt_session_id() is null then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;

  if coalesce((select s.mcp_approval_totp from public.settings s limit 1), true) and not exists (
    select 1
    from jsonb_array_elements(case when jsonb_typeof(v_claims -> 'amr') = 'array' then v_claims -> 'amr' else '[]'::jsonb end) e
    where e ->> 'method' = 'totp'
      and case when (e ->> 'timestamp') ~ '^[0-9]+(\.[0-9]+)?$' then (e ->> 'timestamp')::numeric end
        >= extract(epoch from now()) - 300
  ) then
    raise exception using errcode = 'MI043', message = 'Approving needs a fresh authenticator code.';
  end if;

  update public.mcp_actions a set
    status = 'running', claimed_at = now(), claimed_via = 'app', claimed_session = public.mcp_jwt_session_id()
  where a.id = p_id and a.status = 'pending' and a.expires_at > now()
    and exists (select 1 from public.mcp_grants g where g.id = a.grant_id and g.revoked_at is null)
  returning * into v_row;
  if v_row.id is null then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
  return next v_row;
end;
$$;

create or replace function public.mcp_reject_action(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_app_user() or public.is_mcp_session() then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
  update public.mcp_actions a set status = 'rejected', finished_at = now()
  where a.id = p_id and a.status = 'pending';
  if not found then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
end;
$$;

-- The outcome, recorded by the session that claimed the action.
create or replace function public.mcp_finish_action(p_id uuid, p_ok boolean, p_result jsonb, p_error jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_app_user() then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
  update public.mcp_actions a set
    status = case when p_ok then 'done' else 'failed' end, finished_at = now(), result = p_result, error = p_error
  where a.id = p_id and a.status = 'running' and a.claimed_session = public.mcp_jwt_session_id();
  if not found then
    raise exception using errcode = 'MI041', message = 'The action is unknown, expired, already used or not executable here.';
  end if;
end;
$$;

-- ─── Triggers ────────────────────────────────────────────────────────────────
-- A Claude session neither changes the policy nor replaces the settings row that holds it.
create or replace function public.settings_mcp_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.is_mcp_session() then
    if tg_op <> 'UPDATE' then
      raise exception using errcode = 'MI040', message = 'The confirmation policy cannot be changed from a Claude connection.';
    end if;
    if new.mcp_confirm_policy is distinct from old.mcp_confirm_policy
       or new.mcp_approval_totp is distinct from old.mcp_approval_totp then
      raise exception using errcode = 'MI040', message = 'The confirmation policy cannot be changed from a Claude connection.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists settings_mcp_guard on public.settings;
create trigger settings_mcp_guard
  before update of mcp_confirm_policy, mcp_approval_totp on public.settings
  for each row execute function public.settings_mcp_guard();
drop trigger if exists settings_mcp_guard_rows on public.settings;
create trigger settings_mcp_guard_rows
  before insert or delete on public.settings
  for each row execute function public.settings_mcp_guard();

-- Whatever the insert sent, the actor is the writing session's grant kind, or null; an update
-- keeps it.
create or replace function public.document_events_actor()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.actor := old.actor;
  else
    new.actor := (select g.client_kind from public.mcp_grants g where g.sb_session_id = public.mcp_jwt_session_id());
  end if;
  return new;
end;
$$;

drop trigger if exists document_events_actor on public.document_events;
create trigger document_events_actor
  before insert or update of actor on public.document_events
  for each row execute function public.document_events_actor();

create or replace function public.mcp_calls_prune()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.mcp_calls c where c.created_at < now() - interval '90 days';
  return null;
end;
$$;

drop trigger if exists mcp_calls_prune on public.mcp_calls;
create trigger mcp_calls_prune
  after insert on public.mcp_calls
  for each statement execute function public.mcp_calls_prune();

-- ─── Function privileges ─────────────────────────────────────────────────────
revoke execute on function public.mcp_jwt_session_id() from public, anon;
revoke execute on function public.mcp_session_grant() from public, anon;
revoke execute on function public.is_mcp_session() from public, anon;
revoke execute on function public.mcp_create_action(text, text, jsonb, text, text, text, jsonb, boolean) from public, anon;
revoke execute on function public.mcp_claim_action(text) from public, anon;
revoke execute on function public.mcp_approve_action(uuid) from public, anon;
revoke execute on function public.mcp_reject_action(uuid) from public, anon;
revoke execute on function public.mcp_finish_action(uuid, boolean, jsonb, jsonb) from public, anon;
grant execute on function public.mcp_jwt_session_id() to authenticated;
grant execute on function public.mcp_session_grant() to authenticated;
grant execute on function public.is_mcp_session() to authenticated;
grant execute on function public.mcp_create_action(text, text, jsonb, text, text, text, jsonb, boolean) to authenticated;
grant execute on function public.mcp_claim_action(text) to authenticated;
grant execute on function public.mcp_approve_action(uuid) to authenticated;
grant execute on function public.mcp_reject_action(uuid) to authenticated;
grant execute on function public.mcp_finish_action(uuid, boolean, jsonb, jsonb) to authenticated;

revoke execute on function public.mcp_authenticate(text) from public, anon, authenticated;
revoke execute on function public.mcp_end_session(uuid) from public, anon, authenticated;
grant execute on function public.mcp_authenticate(text) to service_role;
grant execute on function public.mcp_end_session(uuid) to service_role;

-- Trigger functions are never called directly.
revoke execute on function public.settings_mcp_guard() from public, anon, authenticated;
revoke execute on function public.document_events_actor() from public, anon, authenticated;
revoke execute on function public.mcp_calls_prune() from public, anon, authenticated;
