-- A 0 % invoice books on different Bookamat purchase-tax accounts depending on why it is 0 %:
-- EU reverse charge ("IG Leistungen"), non-EU (Drittland), or a domestic 0 % line. The old single
-- 0 % mapping was in practice the reverse-charge account, so it moves there; the non-EU account is
-- chosen in Settings. No-op when applied again.
alter table settings
  add column if not exists bookamat_vat_account_rc     integer,
  add column if not exists bookamat_vat_account_non_eu integer;

update settings
   set bookamat_vat_account_rc = bookamat_vat_account_0,
       bookamat_vat_account_0  = null
 where bookamat_vat_account_rc is null
   and bookamat_vat_account_0 is not null;
