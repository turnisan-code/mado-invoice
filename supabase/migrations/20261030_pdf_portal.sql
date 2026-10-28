-- PDF and client portal:
--   * settings.bank_account_holder: the name the account is held in, printed as the beneficiary
--     of the payment QR code and in the PDF payment block (empty = company name)
--   * documents.portal_viewed_at: when the client first opened the document in the portal
--   * documents.share_expires_at: when the share link stops working (NULL = never); links that
--     already exist get 90 days from now, the same as a newly created link
--   * a saved copy of the wrong English non-EU tax note is cleared
-- Every statement is a no-op when already applied, so the file can be run any number of times.

alter table settings add column if not exists bank_account_holder text;

alter table documents
  add column if not exists portal_viewed_at timestamptz,
  add column if not exists share_expires_at timestamptz;

update documents set share_expires_at = now() + interval '90 days'
where share_token is not null and share_expires_at is null;

-- The old English non-EU default ("tax liability shifts to the recipient") is the reverse-charge
-- wording; a saved copy of it falls back to the corrected default.
update settings set tax_note_non_eu_en = null
where tax_note_non_eu_en = 'Tax liability shifts to the recipient of the services.';
