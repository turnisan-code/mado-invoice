-- Bank-statement import: an imported payment remembers the statement transaction it came from,
-- so importing the same statement twice cannot record a payment twice. No-op when applied again.
alter table payments add column if not exists import_ref text;
create unique index if not exists payments_import_ref_key on payments(import_ref) where import_ref is not null;
