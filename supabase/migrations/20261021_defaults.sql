-- Document defaults editable under Settings → Defaults. DocumentBuilder reads them for new
-- line items, for the tax treatment of a new document until a client is chosen, and for the
-- validity period of a new quote. Every statement is a no-op when the column already exists.
alter table settings
  add column if not exists default_vat_rate            integer not null default 20
    check (default_vat_rate in (0, 10, 13, 20)),
  add column if not exists default_unit                text    not null default 'flat'
    check (default_unit in ('hour', 'day', 'session', 'flat', 'piece', 'month')),
  add column if not exists default_tax_treatment       text    not null default 'at_vat'
    check (default_tax_treatment in ('at_vat', 'eu_reverse_charge', 'non_eu')),
  add column if not exists default_quote_validity_days integer not null default 14
    check (default_quote_validity_days between 0 and 365);
