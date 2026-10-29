-- Links between documents, payments and project entries never silently break (g5-integrity):
--   * replace_document_items keeps every line's id across saves (update what comes back, insert
--     the rest, delete what is gone), so time entries and expenses stay on the line that bills
--     them. A billed line removed from a draft frees its entries; the draft's history says so.
--   * document_events types 'project_invoiced' (a draft made from a project's unbilled entries,
--     logged by /api/projects/[id]/invoice) and 'project_released' (entries unbilled again: their
--     line was removed, the invoice cancelled, or released on the project page).
--   * An invoice that is cancelled (its Storno, or a draft cancelled) frees what it billed.
-- Every redefined function starts from its latest definition (named at each one) and is mirrored
-- in supabase/schema.sql. Every statement is a no-op when already applied, so the file can be run
-- any number of times.

-- ─── Event types ─────────────────────────────────────────────────────────────
-- The allowed event types are read back from the existing check and extended, so event types
-- other migrations add to the same check are kept whichever runs first.
do $$
declare
  con_name text;
  con_def  text;
  types    text[];
  missing  text[];
begin
  select c.conname, pg_get_constraintdef(c.oid) into con_name, con_def
  from pg_constraint c
  where c.conrelid = 'document_events'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%''issued''%'
  limit 1;
  if con_name is null then return; end if;

  select array_agg(m[1] order by m[1]) into types
  from (select distinct regexp_matches(con_def, '''([a-z_]+)''', 'g') as m) x;
  missing := array(select t from unnest(array['project_invoiced', 'project_released']) t where not t = any(types));
  if cardinality(missing) = 0 then return; end if;

  execute format('alter table document_events drop constraint %I', con_name);
  execute format('alter table document_events add constraint document_events_type_check check (type = any (%L::text[]))', types || missing);
end $$;

-- ─── Document lines ──────────────────────────────────────────────────────────
-- Starts from 20261030_issue_checks.sql. Writes a document's lines in one transaction and keeps
-- their ids: a line whose id belongs to this document is updated, every other line inserted
-- (under the id the editor sent while no row has it, so the editor and the database share the
-- ids) and the document's lines that did not come back are deleted. Time entries and expenses
-- billed on a deleted line move to a new line with exactly the same content (a device backup
-- from before ids were kept); otherwise a draft frees them and its history says so, while an
-- issued document keeps them billed (what it billed stays billed), only without the line.
create or replace function replace_document_items(p_document_id uuid, p_items jsonb)
returns void language plpgsql as $$
declare
  d      documents%rowtype;
  kept   jsonb;
  added  jsonb;
  stays  uuid[];
  gone   record;
  twin   uuid;
  twins  uuid[] := '{}';
  freed  integer := 0;
  more   integer := 0;
begin
  -- Two saves of one document (two tabs) run one after the other.
  select * into d from documents where id = p_document_id for update;
  if d.id is null then raise exception 'document % not found', p_document_id; end if;

  with sent as (
    select x.e || jsonb_build_object('document_id', p_document_id) as e, x.ord,
           case when x.e->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (x.e->>'id')::uuid end as uid
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(e, ord)
  ), marked as (
    select s.*,
           s.uid is not null and row_number() over (partition by s.uid order by s.ord) = 1 as is_first,
           exists (select 1 from document_items i where i.id = s.uid and i.document_id = p_document_id) as is_mine,
           exists (select 1 from document_items i where i.id = s.uid) as is_taken
    from sent s
  )
  select
    coalesce(jsonb_agg(m.e || jsonb_build_object('id', m.uid) order by m.ord)
             filter (where m.is_first and m.is_mine), '[]'::jsonb),
    coalesce(jsonb_agg(m.e || jsonb_build_object('id', case when m.is_first and not m.is_taken then m.uid else uuid_generate_v4() end) order by m.ord)
             filter (where not (m.is_first and m.is_mine)), '[]'::jsonb)
  into kept, added
  from marked m;

  stays := array(select (k->>'id')::uuid from jsonb_array_elements(kept) k)
        || array(select (a->>'id')::uuid from jsonb_array_elements(added) a);

  insert into document_items (
    id, document_id, sort_order, line_type, description, service_date, service_date_end,
    quantity, unit, unit_price, vat_rate, catalogue_item_id, discount_type, discount_value
  )
  select
    r.id, p_document_id, r.sort_order, r.line_type, r.description, r.service_date, r.service_date_end,
    r.quantity, r.unit, r.unit_price, r.vat_rate, r.catalogue_item_id, r.discount_type, r.discount_value
  from jsonb_populate_recordset(null::document_items, added) r
  order by r.sort_order;

  update document_items i set
    sort_order = r.sort_order, line_type = r.line_type, description = r.description,
    service_date = r.service_date, service_date_end = r.service_date_end, quantity = r.quantity,
    unit = r.unit, unit_price = r.unit_price, vat_rate = r.vat_rate, catalogue_item_id = r.catalogue_item_id,
    discount_type = r.discount_type, discount_value = r.discount_value
  from jsonb_populate_recordset(null::document_items, kept) r
  where i.id = r.id and i.document_id = p_document_id;

  for gone in
    select i.* from document_items i
    where i.document_id = p_document_id and not (i.id = any(stays))
      and (exists (select 1 from time_entries t where t.document_item_id = i.id)
           or exists (select 1 from project_expenses x where x.document_item_id = i.id))
    order by i.sort_order
  loop
    select r.id into twin
    from jsonb_populate_recordset(null::document_items, added) r
    where r.line_type = gone.line_type
      and r.description is not distinct from gone.description
      and r.quantity is not distinct from gone.quantity
      and r.unit is not distinct from gone.unit
      and r.unit_price is not distinct from gone.unit_price
      and r.vat_rate is not distinct from gone.vat_rate
      and r.service_date is not distinct from gone.service_date
      and r.service_date_end is not distinct from gone.service_date_end
      and not (r.id = any(twins))
    order by r.sort_order
    limit 1;
    if twin is not null then
      twins := twins || twin;
      update time_entries set document_item_id = twin where document_item_id = gone.id;
      update project_expenses set document_item_id = twin where document_item_id = gone.id;
    end if;
  end loop;

  if d.number is null then
    update time_entries t set invoiced_document_id = null, document_item_id = null, billed_rate = null
    from document_items i
    where i.document_id = p_document_id and not (i.id = any(stays))
      and t.document_item_id = i.id and t.invoiced_document_id = p_document_id;
    get diagnostics freed = row_count;
    update project_expenses x set invoiced_document_id = null, document_item_id = null
    from document_items i
    where i.document_id = p_document_id and not (i.id = any(stays))
      and x.document_item_id = i.id and x.invoiced_document_id = p_document_id;
    get diagnostics more = row_count;
    if freed + more > 0 then
      insert into document_events (document_id, type, detail)
      values (p_document_id, 'project_released', jsonb_build_object('reason', 'line_removed', 'time_entries', freed, 'expenses', more));
    end if;
  end if;

  delete from document_items where document_id = p_document_id and not (id = any(stays));
end;
$$;

-- ─── Project entries of a cancelled invoice ──────────────────────────────────
-- A cancelled invoice bills nothing: when an invoice is cancelled with its Storno
-- (create_credit_note with p_cancel) or a draft is cancelled, the time entries and expenses it
-- billed are unbilled again, ready for the corrected invoice, and its history says so.
create or replace function documents_project_release()
returns trigger language plpgsql as $$
declare
  n      integer;
  m      integer;
  storno documents%rowtype;
begin
  update time_entries set invoiced_document_id = null, document_item_id = null, billed_rate = null
  where invoiced_document_id = new.id;
  get diagnostics n = row_count;
  update project_expenses set invoiced_document_id = null, document_item_id = null
  where invoiced_document_id = new.id;
  get diagnostics m = row_count;
  if n + m > 0 then
    select * into storno from documents
    where cancels_document_id = new.id and type = 'credit_note' and number is not null
    order by created_at desc limit 1;
    insert into document_events (document_id, type, detail)
    values (new.id, 'project_released', jsonb_strip_nulls(jsonb_build_object(
      'reason', case when storno.id is null then 'cancelled' else 'storno' end,
      'time_entries', n, 'expenses', m,
      'credit_note_id', storno.id, 'credit_note_number', storno.number)));
  end if;
  return null;
end;
$$;

drop trigger if exists documents_project_release on documents;
create trigger documents_project_release
  after update of status on documents
  for each row
  when (new.type = 'invoice' and new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function documents_project_release();

-- Starts from 20261101_projects.sql. Makes billed entries unbilled again, but only while their
-- invoice is a draft or cancelled: what an issued invoice billed stays billed. Each invoice's
-- history notes what was released from it. Returns how many were freed.
create or replace function release_project_entries(p_time_entry_ids uuid[], p_expense_ids uuid[])
returns integer language plpgsql as $$
declare
  freed integer;
begin
  with te as (
    update time_entries t set invoiced_document_id = null, document_item_id = null, billed_rate = null
    from documents d
    where t.id = any(coalesce(p_time_entry_ids, '{}')) and d.id = t.invoiced_document_id
      and (d.number is null or d.status = 'cancelled')
    returning d.id as document_id, 1 as n, 0 as m
  ), ex as (
    update project_expenses e set invoiced_document_id = null, document_item_id = null
    from documents d
    where e.id = any(coalesce(p_expense_ids, '{}')) and d.id = e.invoiced_document_id
      and (d.number is null or d.status = 'cancelled')
    returning d.id as document_id, 0 as n, 1 as m
  ), per_document as (
    select r.document_id, sum(r.n)::integer as n, sum(r.m)::integer as m
    from (select * from te union all select * from ex) r
    group by r.document_id
  ), logged as (
    insert into document_events (document_id, type, detail)
    select p.document_id, 'project_released', jsonb_build_object('reason', 'manual', 'time_entries', p.n, 'expenses', p.m)
    from per_document p
  )
  select coalesce(sum(p.n + p.m), 0)::integer into freed from per_document p;
  return freed;
end;
$$;
