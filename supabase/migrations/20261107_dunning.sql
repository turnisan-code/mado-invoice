-- Dunning follows the due date (r13-dunning):
--   * When the due date of an open issued invoice (sent or overdue; a paid or cancelled one is
--     never touched) moves to a later date that is today or later (Vienna date), its reminders
--     start over: reminder_level goes back to 0 and reminder_sent_at to null, so the next reminder
--     is a Zahlungserinnerung again once the new due date and the grace period have passed. The
--     history records it as document_events type 'reminders_reset' (the new and the previous due
--     date, the level reached). A due date that is still in the past keeps the level; the
--     reminders already sent stay in reminder_log.
--   * The status (overdue or sent) is not set here: right after the save the app applies the daily
--     cron's own rule to that invoice (markOverdueInvoices in src/lib/utils/overdue.ts), so the
--     badge follows the due date at once.
-- Mirrored in supabase/schema.sql. Every statement is a no-op when already applied, so the file can
-- be run any number of times.

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
  missing := array(select t from unnest(array['reminders_reset']) t where not t = any(types));
  if cardinality(missing) = 0 then return; end if;

  execute format('alter table document_events drop constraint %I', con_name);
  execute format('alter table document_events add constraint document_events_type_check check (type = any (%L::text[]))', types || missing);
end $$;

-- ─── Due date extended: reminders start over ─────────────────────────────────
-- An open issued invoice (sent or overdue; paid, cancelled and drafts are never touched) whose due
-- date moves to a later date that is today or later (Vienna) starts its reminders over: level 0,
-- no reminder sent, and a 'reminders_reset' event with the new and the previous due date and the
-- level reached. A new due date still in the past keeps the level. The editor saves an issued
-- invoice's due date with every other field, so only a real move counts. The status is the app's
-- (markOverdueInvoices, the daily cron's rule), applied right after the save.
create or replace function documents_due_date_reminders()
returns trigger language plpgsql as $$
begin
  if new.type = 'invoice' and new.number is not null
     and old.status in ('sent', 'overdue') and new.status in ('sent', 'overdue')
     and new.due_date is not null
     and new.due_date >= (now() at time zone 'Europe/Vienna')::date
     and (old.due_date is null or new.due_date > old.due_date)
     and (old.reminder_level > 0 or old.reminder_sent_at is not null)
  then
    new.reminder_level := 0;
    new.reminder_sent_at := null;
    insert into document_events (document_id, type, detail)
    values (new.id, 'reminders_reset', jsonb_build_object(
      'due_date', new.due_date, 'previous_due_date', old.due_date, 'level', old.reminder_level));
  end if;
  return new;
end;
$$;

drop trigger if exists documents_due_date_reminders on documents;
create trigger documents_due_date_reminders
  before update of due_date on documents
  for each row execute function documents_due_date_reminders();
