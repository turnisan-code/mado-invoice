-- Payment method (bank transfer or cash), so a cash payment is booked on the Bookamat cash
-- account (Kassa) instead of the bank account; the Kassa mapping lives in settings.
-- No-op when applied again.
alter table payments add column if not exists method text not null default 'bank';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payments'::regclass and conname = 'payments_method_check'
  ) then
    alter table public.payments
      add constraint payments_method_check check (method in ('bank','cash'));
  end if;
end $$;

alter table settings add column if not exists bookamat_cash_account_id integer;
