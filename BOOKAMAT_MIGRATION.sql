alter table documents add column if not exists bookamat_booking_id text;
alter table settings
  add column if not exists bookamat_username text,
  add column if not exists bookamat_api_key text,
  add column if not exists bookamat_country text default 'at',
  add column if not exists bookamat_bank_account_id integer,
  add column if not exists bookamat_cost_account_id integer,
  add column if not exists bookamat_vat_account_0 integer,
  add column if not exists bookamat_vat_account_10 integer,
  add column if not exists bookamat_vat_account_13 integer,
  add column if not exists bookamat_vat_account_20 integer;
