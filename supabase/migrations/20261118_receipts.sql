-- PR 9b „Belege aus Gmail“: what Mado found in Gmail for a statement line, and which receipt
-- belongs to which line. Run once in the SQL editor of Mado's project, after
-- 20261117_expenses.sql; it can be run again.
--  - bank_lines.receipt_search: the line's last Gmail search — the receipt it attached (its
--    e-mail and part, how it was proven, what Claude read on it, its text layer, capped), what it
--    found and did not attach, its notes and the searches that failed. Never the PDF's data: the
--    copy of a receipt attached is in the private 'receipts' bucket (receipt_path), as an upload
--    by hand is (decision D12).
--  - bank_lines.receipt_gmail: a PDF of that list the owner attached („Anhängen“).
--  - receipt_claims: each receipt held by one line only — by its Gmail part, by its bytes
--    (sha256) and by its sender's invoice number (lib/expenses/receipt-match.ts ownClaimKeys).
--    A line's claims go with its receipt.
-- The guard bank_lines_booking_guard (20261117) is unchanged: a line's Beleg stays editable.

alter table bank_lines add column if not exists receipt_search jsonb;
alter table bank_lines add column if not exists receipt_gmail jsonb;

create table if not exists receipt_claims (
  key          text primary key,
  bank_line_id uuid not null references bank_lines(id) on delete cascade,
  -- The line as other lines' notes name it (lib/expenses/receipt-match.ts rowLabel)
  label        text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists receipt_claims_line_idx on receipt_claims (bank_line_id);

alter table receipt_claims enable row level security;
drop policy if exists "owner" on receipt_claims;
create policy "owner" on receipt_claims for all to authenticated using (is_app_user()) with check (is_app_user());
