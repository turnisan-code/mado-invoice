-- The second factor and links handed to clients are enforced in the database (g6-security):
--   * is_app_user(), which every table policy, every policy of the private 'documents' bucket
--     and the 'logos' upload, update and delete policies go through, passes for an owner who has
--     a verified MFA factor only with an aal2 JWT (the code was entered); mfa_satisfied() is
--     that rule. An owner without a verified factor is unaffected. Before this, a leaked
--     password alone gave an aal1 JWT that could read and write everything through PostgREST
--     and Storage, past the code step the app's proxy asks for.
--   * app_users' own-row policy follows the same rule. 'logos public read' stays open to
--     everyone on purpose: the bucket is public, and the PDF renderer and the client portal load
--     the logo without a session.
--   * Service-role paths (cron jobs, the client portal) bypass RLS and are unaffected.
--   * Share links that still have no expiry (share_token set, share_expires_at NULL: created by a
--     reminder email before ensurePortalLink set one) get SHARE_LINK_DAYS (src/lib/share.ts: 90)
--     from now, as 20261030_pdf_portal.sql did for the links that existed then.
-- Every redefined function starts from its latest definition (named at each one) and is mirrored
-- in supabase/schema.sql. Every statement is a no-op when already applied, so the file can be run
-- any number of times.
--
-- ROLLBACK — if the owner is locked out (every page empty, every save refused), run these three
-- statements in the Supabase SQL editor, which connects as postgres and is not subject to RLS.
-- They restore the app_users policy and is_app_user() as 20261019_rls_app_users.sql defined them:
--
--   drop policy if exists "own row" on public.app_users; create policy "own row" on public.app_users for select to authenticated using (user_id = auth.uid());
--   create or replace function public.is_app_user() returns boolean language sql stable security definer set search_path = public as $$ select exists (select 1 from app_users where user_id = auth.uid()) $$;
--   drop function if exists public.mfa_satisfied();
--
-- Removing the factor instead (Account → two-factor authentication, or in the dashboard under
-- Authentication → Users) also lets an aal1 session through again.

-- ─── mfa_satisfied(): the second factor, when one is set up ──────────────────
-- Runs as its owner (the role running this file), which reads auth.mfa_factors; a policy running
-- as the signed-in user could not. A token without an 'aal' claim counts as aal1. search_path is
-- empty, so every name is schema-qualified.
create or replace function public.mfa_satisfied()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = auth.uid() and f.status = 'verified'
    )
$$;

revoke execute on function public.mfa_satisfied() from public, anon;
grant execute on function public.mfa_satisfied() to authenticated;

-- Nothing uses it yet: if it cannot run (no access to auth.mfa_factors or the claims), the file
-- stops here and every policy still works as before.
do $$ begin perform public.mfa_satisfied(); end $$;

-- ─── is_app_user(): the owner, with the second factor when one is set up ─────
-- Latest definition: 20261019_rls_app_users.sql.
create or replace function public.is_app_user()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_users where user_id = auth.uid()) and public.mfa_satisfied()
$$;

revoke execute on function public.is_app_user() from public, anon;
grant execute on function public.is_app_user() to authenticated;

-- Latest definition: 20261019_rls_app_users.sql. mfa_satisfied(), not is_app_user(): that one
-- reads app_users, and through this policy would call itself.
drop policy if exists "own row" on public.app_users;
create policy "own row" on public.app_users
  for select to authenticated
  using (user_id = auth.uid() and public.mfa_satisfied());

do $$ begin perform public.is_app_user(); end $$;

-- ─── Share links without an expiry ───────────────────────────────────────────
update public.documents set share_expires_at = now() + interval '90 days'
where share_token is not null and share_expires_at is null;
