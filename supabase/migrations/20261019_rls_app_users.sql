-- Pin RLS to the app owner. The previous policies only checked
-- auth.role() = 'authenticated', so any user who signed up against the
-- Supabase project had full access to every table.

create table if not exists app_users (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table app_users enable row level security;

drop policy if exists "own row" on app_users;
create policy "own row" on app_users
  for select to authenticated
  using (user_id = auth.uid());

insert into app_users(user_id) select id from auth.users on conflict do nothing;

create or replace function is_app_user()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from app_users where user_id = auth.uid())
$$;

revoke execute on function is_app_user() from public, anon;
grant execute on function is_app_user() to authenticated;

drop policy if exists "owner" on settings;
drop policy if exists "owner" on clients;
drop policy if exists "owner" on catalogue_items;
drop policy if exists "owner" on documents;
drop policy if exists "owner" on document_items;
drop policy if exists "owner" on payments;

create policy "owner" on settings        for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on clients         for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on catalogue_items for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on documents       for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on document_items  for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on payments        for all to authenticated using (is_app_user()) with check (is_app_user());
