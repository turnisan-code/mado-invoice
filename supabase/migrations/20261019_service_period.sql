-- Leistungszeitraum: multi-day work is invoiced with a service period (from–to), not a single date.
alter table documents add column if not exists service_date_end date;
