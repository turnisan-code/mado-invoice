-- Recurring schedules: the days a run left unbilled (after 20261105_mcp_drafts.sql).
--   * recurring_schedules.unbilled: date ranges, [{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}, …],
--     that a run of the generator (the cron or "Generate now", runSchedule in
--     src/lib/utils/recurring.ts) left unbilled when it skipped a period because invoices of the
--     schedule already covered part of it: a generated invoice whose service period was moved
--     into the next period, or a schedule whose interval, next date or billing in advance changed
--     outside the editor. The schedule list and Claude's list_recurring show them until an
--     invoice of the schedule covers them or the owner dismisses them in the list, which empties
--     the column. Before, such days were shown only until the schedule's next invoice was created.
-- The app reads a schedule without the column as having nothing recorded and records nothing for
-- it, so it runs before and after this file. The statement is a no-op when already applied.

alter table public.recurring_schedules add column if not exists unbilled jsonb not null default '[]'::jsonb;
