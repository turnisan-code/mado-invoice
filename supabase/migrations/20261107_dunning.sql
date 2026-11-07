-- Dunning follows the due date (r13-dunning):
--   * When the due date of an open issued invoice (sent or overdue; a paid or cancelled one is
--     never touched) moves to a later date that is today or later (Vienna date), its reminders
--     start over: reminder_level goes back to 0 and reminder_sent_at to null, so the next reminder
--     is a Zahlungserinnerung again once the new due date and the grace period have passed. The
--     history records it as document_events type 'reminders_reset' (the new and the previous due
--     date, the level reached, when the last reminder went out). A due date that is still in the
--     past keeps the level; the reminders already sent stay in reminder_log.
--   * The editor saves 2 s after a change, so a due date that stood only for a moment starts the
--     reminders over too. Moving the due date back into the past before another reminder went out
--     restores the level and the date of the last reminder from that event, recorded as
--     'reminders_restored' (details at the trigger below).
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
  missing := array(select t from unnest(array['reminders_reset', 'reminders_restored']) t where not t = any(types));
  if cardinality(missing) = 0 then return; end if;

  execute format('alter table document_events drop constraint %I', con_name);
  execute format('alter table document_events add constraint document_events_type_check check (type = any (%L::text[]))', types || missing);
end $$;

-- ─── Due date extended: reminders start over ─────────────────────────────────
-- An open issued invoice (sent or overdue; paid, cancelled and drafts are never touched) whose due
-- date moves to a later date that is today or later (Vienna) starts its reminders over: level 0,
-- no reminder sent, and a 'reminders_reset' event with the new and the previous due date, the
-- level reached and when its last reminder went out. A new due date still in the past keeps the
-- level. The editor saves an issued invoice's due date with every other field, so only a real move
-- counts. The status is the app's (markOverdueInvoices, the daily cron's rule), applied right after
-- the save.
-- The editor saves 2 s after a change, so a due date that stood only for a moment (a typo, arrow
-- keys, an extension taken back) starts the reminders over too. Moving the due date back into the
-- past undoes that while no reminder has gone out since (no 'reminder_sent' event, no reminder_log
-- row): the level and the date of the last reminder come back from the latest 'reminders_reset'
-- event, once (they are not 0 and null again until the next reset), and a 'reminders_restored'
-- event records it. That holds while the extended due date has not passed yet (or there is none),
-- and later too when the due date goes back to the one the reminders started over from, or
-- earlier. An extension that ran out and is then moved to another date in the past keeps the
-- reminders that started over. It ran out once the invoice was marked overdue after the reset (a
-- 'status_changed' event to 'overdue': the daily run, or the status update right after a save), so
-- a later date that stands for a moment and is then taken back does not bring the old level back.
create or replace function documents_due_date_reminders()
returns trigger language plpgsql as $$
declare
  v_today    date := (now() at time zone 'Europe/Vienna')::date;
  v_reset_at timestamptz;
  v_detail   jsonb;
  v_level    integer;
  v_sent     timestamptz;
begin
  if not (new.type = 'invoice' and new.number is not null
          and old.status in ('sent', 'overdue') and new.status in ('sent', 'overdue')
          and new.due_date is not null) then
    return new;
  end if;

  if new.due_date >= v_today
     and (old.due_date is null or new.due_date > old.due_date)
     and (old.reminder_level > 0 or old.reminder_sent_at is not null)
  then
    new.reminder_level := 0;
    new.reminder_sent_at := null;
    insert into document_events (document_id, type, detail)
    values (new.id, 'reminders_reset', jsonb_build_object(
      'due_date', new.due_date, 'previous_due_date', old.due_date, 'level', old.reminder_level,
      'previous_reminder_sent_at', old.reminder_sent_at));
    return new;
  end if;

  if new.due_date >= v_today or old.reminder_level <> 0 or old.reminder_sent_at is not null then
    return new;
  end if;
  select e.created_at, e.detail into v_reset_at, v_detail
  from document_events e
  where e.document_id = new.id and e.type = 'reminders_reset'
  order by e.created_at desc
  limit 1;
  if v_reset_at is null
     or not (old.due_date is null or old.due_date >= v_today
             or coalesce(new.due_date <= (v_detail ->> 'previous_due_date')::date, false))
     or (not coalesce(new.due_date <= (v_detail ->> 'previous_due_date')::date, false)
         and exists (select 1 from document_events e
                     where e.document_id = new.id and e.type = 'status_changed'
                       and e.detail ->> 'to' = 'overdue' and e.created_at >= v_reset_at))
     or exists (select 1 from document_events e
                where e.document_id = new.id and e.type = 'reminder_sent' and e.created_at >= v_reset_at)
     or exists (select 1 from reminder_log l
                where l.document_id = new.id and l.sent_at >= v_reset_at)
  then
    return new;
  end if;
  v_level := case when jsonb_typeof(v_detail -> 'level') = 'number' then (v_detail ->> 'level')::integer else 0 end;
  v_sent := (v_detail ->> 'previous_reminder_sent_at')::timestamptz;
  if v_level > 0 or v_sent is not null then
    new.reminder_level := v_level;
    new.reminder_sent_at := v_sent;
    insert into document_events (document_id, type, detail)
    values (new.id, 'reminders_restored', jsonb_build_object(
      'due_date', new.due_date, 'previous_due_date', old.due_date, 'level', v_level,
      'reminder_sent_at', v_sent));
  end if;
  return new;
end;
$$;

drop trigger if exists documents_due_date_reminders on documents;
create trigger documents_due_date_reminders
  before update of due_date on documents
  for each row execute function documents_due_date_reminders();
