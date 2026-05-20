-- Run in Supabase SQL editor

-- Track when a reminder was sent per invoice
alter table documents add column if not exists reminder_sent_at timestamptz;

-- Reminder email templates in settings
alter table settings add column if not exists email_subject_reminder_de text;
alter table settings add column if not exists email_body_reminder_de    text;
alter table settings add column if not exists email_subject_reminder_en text;
alter table settings add column if not exists email_body_reminder_en    text;
