-- Projects, time tracking and billable expenses (costs passed on to a client; input VAT stays
-- in Bookamat). Unbilled billable entries become the lines of one draft invoice in a single
-- transaction (invoice_project_entries); a billed entry points at its invoice and line. Deleting
-- the draft frees its entries again (ON DELETE SET NULL).
-- Error codes: MI030 = project not found, MI031 = nothing to invoice, MI032 = an entry was
-- billed, deleted or made non-billable in the meantime, MI033 = a project with billed entries
-- cannot be deleted.
-- Idempotent — safe to re-run.

create table if not exists projects (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),
  client_id     uuid not null references clients(id) on delete restrict,
  name          text not null constraint projects_name_check check (btrim(name) <> ''),
  status        text not null default 'active' constraint projects_status_check check (status in ('active','done','archived')),
  -- Net hourly rate of time entries without their own rate.
  hourly_rate   numeric(10,2) constraint projects_hourly_rate_check check (hourly_rate is null or hourly_rate >= 0),
  budget_hours  numeric(10,2) constraint projects_budget_hours_check check (budget_hours is null or budget_hours > 0),
  -- Net budget, compared with the value of all billable time and expenses.
  budget_amount numeric(10,2) constraint projects_budget_amount_check check (budget_amount is null or budget_amount > 0),
  notes         text
);

create index if not exists projects_client_id_idx on projects(client_id);

create table if not exists time_entries (
  id                   uuid primary key default uuid_generate_v4(),
  created_at           timestamptz not null default now(),
  project_id           uuid not null references projects(id) on delete cascade,
  date                 date not null,
  minutes              integer not null constraint time_entries_minutes_check check (minutes between 1 and 1440),
  description          text not null default '',
  billable             boolean not null default true,
  -- Net hourly rate for this entry; null = the project's rate.
  rate                 numeric(10,2) constraint time_entries_rate_check check (rate is null or rate >= 0),
  -- Set together when the entry is billed. The line link is cleared whenever the builder rewrites
  -- the invoice's lines; the entry stays billed on the invoice until the invoice is deleted.
  invoiced_document_id uuid references documents(id) on delete set null,
  document_item_id     uuid references document_items(id) on delete set null,
  -- The hourly rate the entry was billed at, so a later change of the project's rate does not
  -- change what it shows as billed. Only meaningful while invoiced_document_id is set.
  billed_rate          numeric(10,2)
);

alter table time_entries add column if not exists billed_rate numeric(10,2);

create index if not exists time_entries_project_id_idx on time_entries(project_id, date);
create index if not exists time_entries_invoiced_document_id_idx on time_entries(invoiced_document_id) where invoiced_document_id is not null;
create index if not exists time_entries_document_item_id_idx on time_entries(document_item_id) where document_item_id is not null;

create table if not exists project_expenses (
  id                   uuid primary key default uuid_generate_v4(),
  created_at           timestamptz not null default now(),
  project_id           uuid not null references projects(id) on delete cascade,
  date                 date not null,
  description          text not null constraint project_expenses_description_check check (btrim(description) <> ''),
  net_amount           numeric(10,2) not null constraint project_expenses_net_amount_check check (net_amount > 0),
  vat_rate             integer not null default 20 constraint project_expenses_vat_rate_check check (vat_rate in (0,10,13,20)),
  billable             boolean not null default true,
  -- Surcharge on the net amount when the expense is passed on.
  markup_percent       numeric(6,2) constraint project_expenses_markup_check check (markup_percent is null or markup_percent between 0 and 1000),
  invoiced_document_id uuid references documents(id) on delete set null,
  document_item_id     uuid references document_items(id) on delete set null
);

create index if not exists project_expenses_project_id_idx on project_expenses(project_id, date);
create index if not exists project_expenses_invoiced_document_id_idx on project_expenses(invoiced_document_id) where invoiced_document_id is not null;
create index if not exists project_expenses_document_item_id_idx on project_expenses(document_item_id) where document_item_id is not null;

-- ─── Unbilled entries → draft invoice ────────────────────────────────────────
-- p_lines is what src/lib/projects.ts buildInvoiceLines computed: one object per line with the
-- document_items columns plus time_entry_ids / expense_ids, the entries the line bills. One
-- transaction: the project row is locked, the draft is created for the project's client (its
-- language, tax treatment and payment days; Skonto from the settings, stored only when above 0
-- as the builder does), every line inserted and
-- its entries linked. An entry that is no longer an unbilled billable entry of this project rolls
-- everything back (MI032), so nothing is ever billed twice.
create or replace function invoice_project_entries(p_project_id uuid, p_lines jsonb)
returns uuid language plpgsql as $$
declare
  p       projects%rowtype;
  c       clients%rowtype;
  s       settings%rowtype;
  doc_id  uuid;
  item_id uuid;
  l       jsonb;
  pos     integer := 0;
  ids     uuid[];
  linked  integer;
  today   date := (now() at time zone 'Europe/Vienna')::date;
begin
  select * into p from projects where id = p_project_id for update;
  if p.id is null then
    raise exception using errcode = 'MI030', message = 'Project not found.';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode = 'MI031', message = 'Nothing to invoice.';
  end if;
  if not exists (select 1 from jsonb_array_elements(p_lines) as x(e) where coalesce(e->>'line_type', 'item') = 'item') then
    raise exception using errcode = 'MI031', message = 'Nothing to invoice.';
  end if;

  select * into c from clients where id = p.client_id;
  select * into s from settings limit 1;

  insert into documents (
    type, number, status, client_id, date, due_date, language, currency, tax_treatment,
    exchange_rate, skonto_percent, skonto_days
  ) values (
    'invoice', null, 'draft', c.id, today, today + coalesce(c.payment_days, s.default_payment_days, 14),
    c.language, 'EUR', c.tax_treatment, 1,
    case when s.default_skonto_percent > 0 then s.default_skonto_percent end,
    case when s.default_skonto_percent > 0 then s.default_skonto_days end
  ) returning id into doc_id;

  for l in select value from jsonb_array_elements(p_lines) loop
    insert into document_items (
      document_id, sort_order, line_type, description, service_date, service_date_end,
      quantity, unit, unit_price, vat_rate
    ) values (
      doc_id, pos, coalesce(l->>'line_type', 'item'), coalesce(l->>'description', ''),
      (l->>'service_date')::date, (l->>'service_date_end')::date,
      (l->>'quantity')::numeric, l->>'unit', (l->>'unit_price')::numeric, (l->>'vat_rate')::integer
    ) returning id into item_id;
    pos := pos + 1;

    ids := array(select jsonb_array_elements_text(coalesce(l->'time_entry_ids', '[]'::jsonb))::uuid);
    if cardinality(ids) > 0 then
      update time_entries set invoiced_document_id = doc_id, document_item_id = item_id, billed_rate = (l->>'unit_price')::numeric
      where id = any(ids) and project_id = p.id and billable and invoiced_document_id is null;
      get diagnostics linked = row_count;
      if linked <> cardinality(ids) then
        raise exception using errcode = 'MI032', message = 'A time entry is no longer unbilled.';
      end if;
    end if;

    ids := array(select jsonb_array_elements_text(coalesce(l->'expense_ids', '[]'::jsonb))::uuid);
    if cardinality(ids) > 0 then
      update project_expenses set invoiced_document_id = doc_id, document_item_id = item_id
      where id = any(ids) and project_id = p.id and billable and invoiced_document_id is null;
      get diagnostics linked = row_count;
      if linked <> cardinality(ids) then
        raise exception using errcode = 'MI032', message = 'An expense is no longer unbilled.';
      end if;
    end if;
  end loop;

  return doc_id;
end;
$$;

-- Makes billed entries unbilled again, but only while their invoice is a draft or cancelled
-- (a Storno reversed it): what an issued invoice billed stays billed. Returns how many were freed.
create or replace function release_project_entries(p_time_entry_ids uuid[], p_expense_ids uuid[])
returns integer language plpgsql as $$
declare
  freed integer;
  more  integer;
begin
  update time_entries t set invoiced_document_id = null, document_item_id = null, billed_rate = null
  from documents d
  where t.id = any(coalesce(p_time_entry_ids, '{}')) and d.id = t.invoiced_document_id
    and (d.number is null or d.status = 'cancelled');
  get diagnostics freed = row_count;

  update project_expenses e set invoiced_document_id = null, document_item_id = null
  from documents d
  where e.id = any(coalesce(p_expense_ids, '{}')) and d.id = e.invoiced_document_id
    and (d.number is null or d.status = 'cancelled');
  get diagnostics more = row_count;

  return freed + more;
end;
$$;

-- What an invoice billed stays on record: a project with billed entries is archived, never
-- deleted (the project page checks this too, but a stale tab or a direct call must not cascade
-- the entries away).
create or replace function projects_delete_guard()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from time_entries where project_id = old.id and invoiced_document_id is not null)
     or exists (select 1 from project_expenses where project_id = old.id and invoiced_document_id is not null) then
    raise exception using errcode = 'MI033', message = 'The project has billed entries; archive it instead.';
  end if;
  return old;
end;
$$;

drop trigger if exists projects_delete_guard on projects;
create trigger projects_delete_guard
  before delete on projects
  for each row execute function projects_delete_guard();

alter table projects enable row level security;
alter table time_entries enable row level security;
alter table project_expenses enable row level security;

drop policy if exists "owner" on projects;
drop policy if exists "owner" on time_entries;
drop policy if exists "owner" on project_expenses;
create policy "owner" on projects         for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on time_entries     for all to authenticated using (is_app_user()) with check (is_app_user());
create policy "owner" on project_expenses for all to authenticated using (is_app_user()) with check (is_app_user());
