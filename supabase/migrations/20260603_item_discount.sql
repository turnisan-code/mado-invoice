alter table document_items
  add column if not exists discount_type text check (discount_type in ('percent', 'fixed')),
  add column if not exists discount_value numeric;
