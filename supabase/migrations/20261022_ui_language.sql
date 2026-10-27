-- Language of the app interface (German or English); documents keep their own per-document
-- language. No-op when the column already exists.
alter table settings
  add column if not exists ui_language text not null default 'en'
    check (ui_language in ('de', 'en'));
