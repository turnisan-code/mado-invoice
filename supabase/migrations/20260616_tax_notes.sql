alter table settings
  add column if not exists tax_note_reverse_charge_de text,
  add column if not exists tax_note_reverse_charge_en text,
  add column if not exists tax_note_non_eu_de text,
  add column if not exists tax_note_non_eu_en text;
