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
--  - set_line_receipt(): a receipt's claims and the line's receipt fields set in one step.
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

-- One step for the receipt of a statement line (PR 9b): the line as the caller loaded it, its
-- claims swapped and its receipt fields set — or nothing. Called by a Gmail search, by „Anhängen“
-- and by a Beleg uploaded or removed by hand (src/lib/expenses/receipts.ts). The copy of a new
-- receipt is uploaded before, under a name of its own, and removed by the caller when this
-- refuses, so a refusal never touches the copy the line keeps.
--  p_expected_*: receipt_path, receipt_search->>'at' and whether receipt_gmail was set, as loaded
--  p_keys: the receipt's claim keys (null: the line's claims stay as they are; '{}': released)
-- Refused ('changed') when the line is no longer open, a booking attempt is open or running (a
-- claim younger than 3 minutes), or its receipt changed meanwhile; 'held' when another line
-- holds one of the keys.
create or replace function set_line_receipt(
  p_line uuid, p_expected_path text, p_expected_search_at text, p_expected_gmail boolean,
  p_keys text[], p_label text, p_path text, p_name text, p_search jsonb, p_gmail jsonb
) returns jsonb language plpgsql as $$
declare
  l     bank_lines%rowtype;
  other text;
begin
  select * into l from bank_lines where id = p_line for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if l.status <> 'open' or l.bookamat_pending is not null
     or (l.bookamat_claim is not null and l.bookamat_claim > now() - interval '3 minutes')
     or l.receipt_path is distinct from p_expected_path
     or (l.receipt_search ->> 'at') is distinct from p_expected_search_at
     or (l.receipt_gmail is not null) is distinct from p_expected_gmail then
    return jsonb_build_object('status', 'changed');
  end if;
  if p_keys is not null then
    select c.label into other from receipt_claims c where c.key = any(p_keys) and c.bank_line_id <> p_line limit 1;
    if found then return jsonb_build_object('status', 'held', 'label', other); end if;
    begin
      delete from receipt_claims where bank_line_id = p_line;
      insert into receipt_claims (key, bank_line_id, label)
        select distinct k, p_line, coalesce(p_label, '') from unnest(p_keys) as k;
    exception when unique_violation then
      -- Another line claimed one of them meanwhile: the line's own claims are as they were
      return jsonb_build_object('status', 'held', 'label', '');
    end;
  end if;
  update bank_lines set receipt_path = p_path, receipt_name = p_name, receipt_search = p_search, receipt_gmail = p_gmail
  where id = p_line;
  return jsonb_build_object('status', 'ok');
end;
$$;
