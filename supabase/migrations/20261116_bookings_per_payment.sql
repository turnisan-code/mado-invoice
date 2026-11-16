-- One Bookamat booking per payment (Ist-Besteuerung: a part payment belongs to its own UVA
-- period), and booked payments locked (PR 8b „Eine Buchung je Zahlung“).
--  - bookamat_bookings.payment_id: the payment (or refund) a booking books. Rows from before this
--    migration keep payment_id null where no single payment can be named; such a row still covers
--    the money of its year (src/lib/bookamat-client.ts, unbookedPlan).
--  - One booking per payment; the old one-per-(document, year, kind) rule stays for the rows
--    without a payment.
--  - Backfill: a row gets its payment when the document has exactly one money row of that year
--    and kind, of the booked amount.
--  - payments_booking_guard (MI048): a payment a booking covers cannot be removed, nor its
--    document, date, amount, kind or method changed, until the booking is deleted in Bookamat and
--    forgotten in Mado („Buchung vergessen“ deletes the bookamat_bookings row).
-- Idempotent — safe to re-run.

-- ─── Bookings per payment ────────────────────────────────────────────────────
alter table bookamat_bookings add column if not exists payment_id uuid references payments(id);

drop index if exists bookamat_bookings_document_year_kind_key;
create unique index if not exists bookamat_bookings_legacy_key
  on bookamat_bookings(document_id, year, kind) where payment_id is null;
create unique index if not exists bookamat_bookings_payment_key
  on bookamat_bookings(payment_id) where payment_id is not null;

update bookamat_bookings b
set payment_id = m.payment_id
from (
  select b2.id as row_id, min(p.id::text)::uuid as payment_id, count(*) as n, min(p.amount) as amount
  from bookamat_bookings b2
  join payments p
    on p.document_id = b2.document_id
   and extract(year from p.date)::integer = b2.year
   and p.kind = case when b2.kind = 'refund' then 'refund' else 'payment' end
   and p.amount > 0
  where b2.payment_id is null
  group by b2.id
) m
where b.id = m.row_id
  and m.n = 1
  and abs(m.amount - abs(b.amount)) < 0.005
  and not exists (select 1 from bookamat_bookings o where o.payment_id = m.payment_id);

-- ─── Booked payments stay as they are ────────────────────────────────────────
create or replace function payments_booking_guard()
returns trigger language plpgsql as $$
declare
  p       payments%rowtype := old;
  booking text;
  num     text;
begin
  if tg_op = 'UPDATE'
     and new.document_id is not distinct from old.document_id and new.date is not distinct from old.date
     and new.amount is not distinct from old.amount and new.kind is not distinct from old.kind
     and new.method is not distinct from old.method then
    return new;
  end if;

  select b.booking_id into booking
  from bookamat_bookings b
  where b.payment_id = p.id
     or (b.payment_id is null
         and p.kind in ('payment', 'refund')
         and b.document_id = p.document_id
         and b.year = extract(year from p.date)::integer
         and b.kind = case when p.kind = 'refund' then 'refund' else 'income' end)
  limit 1;

  if booking is not null then
    select number into num from documents where id = p.document_id;
    raise exception using errcode = 'MI048',
      message = format('%s: this payment is booked in Bookamat (#%s). Delete the booking there and use "Buchung vergessen" first.', coalesce(num, 'This document'), booking);
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists payments_booking_guard on payments;
create trigger payments_booking_guard
  before update or delete on payments
  for each row execute function payments_booking_guard();
