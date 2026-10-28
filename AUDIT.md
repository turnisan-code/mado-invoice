# Mado Invoice — Audit & Backlog

_Generated 2026-10-19 from a multi-agent code audit of branch `claude/thirsty-williams-211a6b` (includes the open PR #22 reverse-charge fix)._

## How to read this

- 24 finder agents (13 subsystem readers + 11 Austrian-compliance/UX lenses) produced **822 raw claims**, de-duplicated to **322**.
- Critical/high bugs were re-verified by independent agents: **20 confirmed ✓**, 30 could not be re-verified (usage limits) ?, 0 rejected. The remaining 272 claims carry the finder's file:line evidence but were not re-verified ○.
- By category after dedup: bug 146, missing 67, ux 78, quality 31.
- Severity: critical = wrong money/tax/numbering on issued documents, data loss, security; high = common path broken or legally required content missing; medium = edge case/workaround exists; low = cosmetic. Effort: S <1h · M half day · L 1–2 days · XL multi-day.

## Overview

Mado Invoice is a well-shaped single-user invoicing app: the document builder, PDF renderer, portal, Gmail/Drive/Bookamat integrations, reminders and reports all exist, the totals helper (calcTotals) already honours section/document discounts and tax treatment, and the RPC-based numbering, share tokens and cookie-based auth gate are the right architectural choices. For day-to-day use (EUR invoices to Austrian clients, Gmail send, manual payment entry) it mostly works.

It is not yet a reliable or compliant invoicing tool. The riskiest area is persistence and issuance: line items are replaced with an unserialised delete+insert that fails silently (confirmed), items are never ordered by sort_order, a number is consumed and the document flipped to "sent" before the user confirms a download/Drive/Gmail action, buttons have no re-entrancy guard, the mailto path emails a "DRAFT" PDF, a new credit note is routed to the invoice page, and the numbering RPC has no row lock. Issued invoices stay fully editable and autosaved, can be hard-deleted with number reuse, and are regenerated from live client/settings rows with no snapshot or audit trail, so the 7-year archive and the "unveränderbar" requirement are not met. Money figures diverge across views: no cent rounding, list totals and the VAT report ignore discounts, KZ 000 includes reverse-charge turnover, credit notes never reduce anything, the dashboard mixes bases, reminders demand the full total despite partial payments, and Bookamat books USD/GBP amounts as EUR. Legal content is incomplete (issuer UID never printed, no per-rate net split, no Leistungszeitraum, wrong English non-EU note, credit-note PDF labelled like an invoice). Security is adequate for one person but fragile: any authenticated Supabase user has full access, the OAuth flow has no state, cron auth fails open without the secret, tokens are serialised to the browser and there is no proxy.ts to refresh sessions. markOverdueInvoices is dead code, so the overdue status and cron reminders never trigger. The repository schema cannot reproduce the production database.

The codebase is readable but duplicated (two line-item editors, three persistence paths, four list components, three template engines, five OAuth blocks), which is why the same bug appears in several places. Fixing correctness and lifecycle rules first, then compliance content, then archival and reporting, will turn the app into a dependable tool; the feature list beyond that (dunning levels, accountant export, bank import, recurring invoices) is attractive but should wait until the foundations hold.

## P0 — Fix now (money, numbering, data loss, broken paths)

_45 items_

1. **Line items replaced by non-atomic delete+insert; failures silent; autosave races manual save** — high · effort M · ✓ verified
   - Where: src/components/forms/DocumentBuilder.tsx:295-297, 380-382, 605-627
   - Why: An issued invoice can end up with no items, duplicated items or an empty PDF while the UI still shows 'Saved'.
   - Fix: Replace items via one transactional RPC (replace_document_items), serialise all writes through a single in-flight promise, and surface errors with a 'Not saved - retry' state.
   - Claims: bug-p1-2, bug-p1-3, bug-p1-4

2. **document_items never ordered by sort_order** — high · effort S · ? not re-verified
   - Where: src/app/(app)/invoices/[id]/page.tsx:18 and every document_items(*) select
   - Why: Headings, subtotals and lines can print in scrambled order on PDF, portal and builder after a save.
   - Fix: Add .order('sort_order', { referencedTable: 'document_items' }) to every documents+items query (or sort in one shared loader).
   - Claims: bug-p1-1

3. **Download/Drive/Gmail issue the number and set 'sent' before confirmation, with no re-entrancy guard** — high · effort M · ◐ partly verified
   - Where: src/components/forms/DocumentBuilder.tsx:359-424, 552
   - Why: Cancelling a save dialog or double-clicking produces phantom sent documents, numbering gaps or two numbered copies, and Drive/Gmail prerequisites are checked only after the number is burned.
   - Fix: Check prerequisites first, show the Mark-as-sent confirmation before issuing, guard ensureNumberAndSave with an issuingRef, cache the issued number and disable all action buttons while saving.
   - Claims: bug-p1-6, bug-p1-11, bug-p1-27

4. **Non-Gmail email path sends a 'DRAFT' PDF without number, QR or status change** — medium · effort S · ✓ verified
   - Where: src/components/forms/DocumentBuilder.tsx:537
   - Why: Without Gmail connected the client receives an unnumbered draft and the invoice stays a draft.
   - Fix: Route openInEmail through the same confirmed ensureNumberAndSave flow and build mail content and PDF from the saved number with includeQr=true.
   - Claims: bug-p1-5

5. **New credit note redirects to /invoices/{id}; detail pages never check document type** — high · effort S · ◐ partly verified
   - Where: src/components/forms/DocumentBuilder.tsx:269; src/app/(app)/invoices/[id]/page.tsx:18
   - Why: A saved credit note opens as an invoice and would receive an invoice number and invoice actions.
   - Fix: Introduce one pathFor(type) helper used in all five places and add .eq('type', ...) (or a redirect) to each [id] page query.
   - Claims: bug-p1-7, bug-p1-26

6. **next_document_number has no row lock and burns the counter before the document is written** — high · effort M · ? not re-verified
   - Where: supabase/migrations/20260528_fix_next_number_where_clause.sql:13
   - Why: Concurrent calls can return duplicate numbers and any failure after the RPC leaves a gap.
   - Fix: Use select ... for update and move number assignment plus document update into one RPC (issue_document) so it is transactional.
   - Claims: bug-p1-13

7. **Bulk 'Mark Sent' and the status dropdown set 'sent'/'paid' without assigning a number** — high · effort S · ◐ partly verified
   - Where: src/app/api/invoices/bulk/route.ts:21; src/components/layout/DocumentStatusBar.tsx:67
   - Why: Unnumbered invoices become sent/paid and can never be numbered because 'Mark as sent' is hidden afterwards.
   - Fix: Reject non-draft targets when number is null (or issue a number server-side via the RPC) in both paths.
   - Claims: bug-p1-37, bug-p1-17

8. **Marking 'paid' via dropdown or bulk records no payment row** — high · effort M · ? not re-verified
   - Where: src/components/layout/DocumentStatusBar.tsx:67; api/invoices/bulk/route.ts
   - Why: Revenue KPIs, client balances and the Bookamat booking date are wrong for invoices paid this way.
   - Fix: On transition to 'paid' open a payment-date dialog and insert a payments row for the open balance.
   - Claims: bug-p4-18

9. **Quote->invoice conversion drops discounts, line types and service dates (credit-note conversion drops service_date)** — high · effort S · ○ finder evidence
   - Where: src/app/(app)/quotes/[id]/convert/route.ts:39; api/invoices/[id]/convert-to-credit-note/route.ts:41
   - Why: The invoice total differs from the accepted quote and headings/subtotals vanish.
   - Fix: Copy discount_type/discount_value on the document and spread all item columns (line_type, service_date, discount_*) in both routes.
   - Claims: bug-p1-8, bug-p3-27

10. **Convert route has no type/status/duplicate guard, ignores errors, burns a number on a draft, sets no due date and races autosave** — high · effort M · ○ finder evidence
   - Where: src/app/(app)/quotes/[id]/convert/route.ts:8-39
   - Why: Invoices can be 'converted', quotes converted twice or into empty invoices, and converted invoices never become overdue.
   - Fix: Require type=quote and status sent/accepted, refuse if converted_from_id exists, insert with number null and due_date from client payment_days, check both insert errors (ideally one RPC), and flush autosave before converting.
   - Claims: bug-p2-10, bug-p2-11, bug-p2-12, bug-p1-48, bug-p2-9

11. **Accepted quotes cannot be converted from the UI** — high · effort S · ? not re-verified
   - Where: src/app/(app)/quotes/[id]/page.tsx:40
   - Why: The normal flow (client accepts via portal, owner invoices) is blocked because the button hides on 'accepted'.
   - Fix: Show Convert for accepted quotes and hide it only when an invoice with converted_from_id exists (link to it instead).
   - Claims: bug-p1-47

12. **No cent rounding in calcTotals; toFixed vs Intl and DB numeric truncation diverge** — high · effort M · ○ finder evidence
   - Where: src/lib/utils/document.ts:77; epc-qr.ts:31; bookamat/sync/route.ts:83; DocumentBuilder.tsx:1261
   - Why: Printed net + VAT can differ from the total by a cent and QR/Bookamat/portal amounts can disagree with the emailed PDF.
   - Fix: Round line amounts and VAT groups to integer cents inside calcTotals, derive total/balance from rounded values, normalise inputs to 2/4 decimals on change, and use the same rounded value for display and machine strings.
   - Claims: bug-p1-10, bug-p5-3, bug-p2-63, bug-p5-13

13. **Percent discounts above 100% accepted, producing negative totals** — medium · effort S · ○ finder evidence
   - Where: src/lib/utils/document.ts:69; discount inputs in DocumentBuilder.tsx
   - Why: A typo yields a negative invoice that is saved and printed.
   - Fix: Clamp percent to 0-100 and fixed to 0-subtotal in the inputs and in calcTotals.
   - Claims: bug-p1-9

14. **List totals, total-sort and CSV ignore document and section discounts** — high · effort S · ? not re-verified
   - Where: src/components/lists/InvoiceList.tsx:36 (and Quote/CreditNote lists)
   - Why: Discounted invoices show and export a higher total than the PDF.
   - Fix: Delete the local calcTotal copies, select discount columns and call the shared calcTotals.
   - Claims: bug-p1-40

15. **VAT report overstates: ignores discounts, counts RC/non-EU in KZ 000, never subtracts credit notes** — high · effort M · ? not re-verified
   - Where: src/app/(app)/reports/page.tsx:20-38
   - Why: UVA figures copied from the report are wrong.
   - Fix: Aggregate via calcTotals per document, add only at_vat net to KZ 000 (RC/non-EU as separate rows) and include credit notes with negative sign.
   - Claims: bug-p2-1, bug-p4-5, bug-p4-7

16. **Dashboard KPIs use wrong bases (total vs balance, lifetime paid, 13-month cap, invoice-date revenue, month overflow, -Infinity, wrong 'recent' order)** — medium · effort M · ○ finder evidence
   - Where: src/app/(app)/dashboard/page.tsx:14-90
   - Why: Outstanding, Paid this month and Revenue numbers are inconsistent with each other and with reality.
   - Fix: Query the payments table directly for all payment-date KPIs and the chart, use balance_due for outstanding/overdue, build month keys with new Date(y,m-1,1), guard empty arrays and sort Recently Paid by payment date.
   - Claims: bug-p2-3, bug-p2-4, bug-p2-5, bug-p2-6, bug-p2-13, bug-p2-14, bug-p2-17

17. **markOverdueInvoices is never called, so cron reminders never fire** — high · effort S · ? not re-verified
   - Where: src/lib/utils/overdue.ts:3; api/cron/reminders/route.ts
   - Why: Past-due invoices stay 'sent' and the daily reminder job sends nothing.
   - Fix: Call markOverdueInvoices(createServiceClient()) at the top of the cron handler (and optionally per request in the app layout).
   - Claims: bug-p1-44

18. **Reminder/cron/Bookamat PDFs and emails ignore payments, section discounts and the EPC QR** — high · effort M · ◐ partly verified
   - Where: src/app/api/invoices/[id]/reminder/route.ts:44; api/cron/reminders/route.ts:85; DocumentBuilder.tsx:320
   - Why: Clients are reminded for the full amount after a deposit and get a PDF without the Offen row or GiroCode.
   - Fix: Select payments(*) in both routes, pass them and the unchanged items to calcTotals, set {{balance_due}} from totals.balance_due, and include the QR whenever an invoice has a number.
   - Claims: bug-p4-17, bug-p1-33, bug-p4-21

19. **Date helpers are UTC-based (today, addDays across DST, formatDate, Bookamat fiscal year)** — medium · effort S · ○ finder evidence
   - Where: src/lib/utils/document.ts:119-133; bookamat/sync/route.ts:74
   - Why: After midnight Vienna time documents and payments get yesterday's date, due dates shift and overdue detection lags.
   - Fix: Add a shared todayLocal()/addDays built from Europe/Vienna date parts, format with timeZone UTC for date-only strings and slice the year from the ISO string.
   - Claims: bug-p1-22, bug-p5-6, bug-p2-64

20. **Client payment_days never drives the due date** — medium · effort S · ○ finder evidence
   - Where: src/components/forms/DocumentBuilder.tsx:176
   - Why: Clients with negotiated terms get the global default payment deadline.
   - Fix: Recompute dueDate from client.payment_days in handleClientChange and on mount for unissued documents.
   - Claims: bug-p1-23

21. **Company-only clients render blank (no link in list, ' (Company)' in dropdown, 'Dear ,' greeting)** — high · effort S · ? not re-verified
   - Where: src/components/lists/ClientList.tsx:188; DocumentBuilder.tsx:733
   - Why: A client saved with only a company name cannot be opened from the list and gets a broken email greeting.
   - Fix: Add a shared displayName(client) helper and use it at every display site.
   - Claims: bug-p1-20

22. **Catalogue EditForm is defined inside the component and remounts on every keystroke** — high · effort S · ✓ verified
   - Where: src/components/forms/CatalogueManager.tsx:145
   - Why: Editing or adding a catalogue item is unusable beyond one character per field.
   - Fix: Hoist EditForm to module scope and pass categories/datalist id as props.
   - Claims: bug-p2-19

23. **Settings saves write NULL into NOT NULL text columns** — high · effort S · ? not re-verified
   - Where: src/components/forms/SettingsForm.tsx:301
   - Why: Clearing an optional-looking field makes the whole section save fail with a raw Postgres error.
   - Fix: Save '' for NOT NULL columns (drop the || null) or migrate the genuinely optional columns to nullable.
   - Claims: bug-p2-33

24. **Variable chip insertion writes into the wrong template after switching tab** — high · effort S · ? not re-verified
   - Where: src/components/forms/SettingsForm.tsx:538
   - Why: Clicking a chip silently overwrites a different doc-type/language template.
   - Fix: Clear lastFocused on tab/language change and key the inputs by tab+language so they remount.
   - Claims: bug-p2-34

25. **RLS grants full access to any authenticated Supabase user** — critical · effort S · ? not re-verified
   - Where: supabase/schema.sql:191-196
   - Why: Anyone who can sign up on the project can read and edit all invoices and settings.
   - Fix: Pin policies to the owner uid (or an app_owners table), add 'to authenticated', and disable self-signup in Supabase.
   - Claims: bug-p3-32

26. **Google OAuth flow has no state parameter and /api/gmail/auth is unauthenticated** — medium · effort S · ✓ verified
   - Where: src/app/api/gmail/callback/route.ts:11
   - Why: A crafted link can bind an attacker's Google account to the owner's settings row.
   - Fix: Require a session in /auth, generate a random state stored in an httpOnly cookie and verify it in the callback.
   - Claims: bug-p2-35

27. **Cron auth fails open when CRON_SECRET is unset** — low · effort S · ✓ verified
   - Where: src/app/api/cron/reminders/route.ts:19
   - Why: Anyone can trigger the reminder job by sending 'Bearer undefined'.
   - Fix: Return 401 when the secret is missing and compare with timingSafeEqual.
   - Claims: bug-p3-20

28. **Gmail tokens and Bookamat API key are serialised into client components** — medium · effort S · ○ finder evidence
   - Where: src/app/(app)/settings/page.tsx:6 and all [id] pages
   - Why: Secrets ship to the browser on every settings and document page.
   - Fix: Select only needed columns server-side and expose booleans like gmailConnected/bookamatConfigured.
   - Claims: bug-p2-41

29. **Share, convert and gmail/auth routes skip the explicit auth check; share DELETE reports success for nothing** — medium · effort S · ○ finder evidence
   - Where: src/app/api/documents/[id]/share/route.ts:34; quotes/[id]/convert; convert-to-credit-note
   - Why: Routes rely solely on RLS and return misleading success to anonymous callers.
   - Fix: Add a shared requireUser() guard called first in every handler and use .select('id').single() to detect no-op writes.
   - Claims: bug-p3-8

30. **No proxy.ts/middleware: refreshed Supabase session cookies are dropped** — high · effort S · ? not re-verified
   - Where: src/lib/supabase/server.ts:13 (no src/proxy.ts exists)
   - Why: The owner gets logged out unexpectedly once the access token expires.
   - Fix: Add src/proxy.ts that builds a server client with request/response cookie binding and calls auth.getUser() on each non-static request.
   - Claims: bug-p3-41

31. **Drive archive overwritten by name-based dedup; drafts upload as 'document.pdf'** — high · effort S · ✓ verified
   - Where: src/app/api/documents/[id]/drive-pdf/route.ts:78
   - Why: An issued invoice's archived PDF can be silently replaced by a different document.
   - Fix: Refuse Drive upload for unnumbered documents and dedup by appProperties.documentId instead of filename.
   - Claims: bug-p2-49

32. **Bookamat posts wrong amounts: non-EUR as EUR, RC/non-EU on the 0% account, missing VAT account silently falls back** — high · effort M · ◐ partly verified
   - Where: src/app/api/bookamat/sync/route.ts:82-83
   - Why: Bookings in Bookamat (and thus the UVA) carry wrong amounts and tax accounts.
   - Fix: Refuse non-EUR without a stored rate, add separate reverse-charge/non-EU account mappings, and 400 when a VAT rate present in the totals has no mapped account.
   - Claims: bug-p2-56, bug-p5-10, bug-p2-59

33. **Bookamat sync lacks guards and state handling (unpaid/draft syncable, DB write ignored, year mismatch, unsaved-state PDF, multi-year partials, config mismatch, 409 not adopted)** — high · effort M · ○ finder evidence
   - Where: src/app/api/bookamat/sync/route.ts:44-131; PaymentPanel.tsx:107-159; invoices/[id]/page.tsx:62
   - Why: Unpaid invoices can be booked as income, retries create duplicate bookings and the UI keeps offering sync.
   - Fix: Require type=invoice, number and balance<=0, claim the row before posting and check the update error, verify accounts for the target fiscal year, book one booking per payment, share an isBookamatConfigured() helper and adopt the 409 bookingId client-side.
   - Claims: bug-p2-57, bug-p2-58, bug-p2-60, bug-p2-61, bug-p2-62, bug-p2-65, bug-p3-1

34. **API routes accept unvalidated bodies (CRLF header injection, arbitrary Bookamat URL segments, unguarded JSON parse, TOCTOU status update)** — medium · effort S · ○ finder evidence
   - Where: src/lib/utils/reminder.ts:15; api/bookamat/attach-pdf/route.ts:23; api/portal/[token]/respond/route.ts:24
   - Why: Malformed or crafted input crashes routes or injects mail headers.
   - Fix: Add zod schemas per route, strip CR/LF from header values, read country from settings and make the quote status update conditional on status='sent'.
   - Claims: bug-p2-55, bug-p3-47, bug-p3-7, missing-merge-70

35. **Google routes and settings handlers swallow or crash on errors; no invalid_grant handling** — high · effort M · ○ finder evidence
   - Where: src/app/api/gmail/send/route.ts:37; gmail/callback/route.ts:11-25; SettingsForm.tsx:439; cron/reminders/route.ts:163
   - Why: A revoked token yields a bare 500, the composed email is lost, 'connected' is reported after failed writes and the cron fails silently.
   - Fix: Wrap Google calls in try/catch returning JSON errors, map invalid_grant to a 'reconnect' state stored on settings and shown as a banner, and check every settings update error.
   - Claims: bug-p2-51, bug-p2-52, bug-p2-53, bug-p2-43, missing-merge-49

36. **Logo picker accepts WebP/GIF/HEIC which react-pdf cannot decode** — medium · effort S · ○ finder evidence
   - Where: src/components/forms/SettingsForm.tsx:645
   - Why: One wrong logo upload breaks every PDF.
   - Fix: Restrict accept and validate file.type to png/jpeg/svg plus a size limit.
   - Claims: bug-p2-40

37. **Invoice list state bugs: empty page after delete, hidden rows acted on by bulk actions, sticky URL status filter, wrong action counts** — medium · effort S · ○ finder evidence
   - Where: src/components/lists/InvoiceList.tsx:78-137; api/invoices/bulk/route.ts:27
   - Why: Bulk actions can hit invoices the user no longer sees and the list shows stale or empty views.
   - Fix: Clamp the page, derive bulk ids from the visible filtered set, sync status from the URL (key or effect) and return the actual changed count from .select('id').
   - Claims: bug-p1-41, bug-p1-42, bug-p1-43, bug-p1-45

38. **Foreign-key failures surface raw (client with documents, converted quote/invoice)** — medium · effort S · ○ finder evidence
   - Where: src/components/forms/ClientForm.tsx:125; supabase/schema.sql:107
   - Why: Deleting shows a Postgres error instead of guidance.
   - Fix: Pre-check dependants and offer archive/cancel instead, and migrate converted_from_id to on delete set null.
   - Claims: bug-p2-23, bug-p3-19

39. **Client stats computed from only the newest 50 documents** — medium · effort S · ○ finder evidence
   - Where: src/app/(app)/clients/[id]/page.tsx:48
   - Why: Revenue, open balance and invoice count are understated for active clients.
   - Fix: Aggregate over all documents in a separate query and paginate only the history list.
   - Claims: bug-p2-24

40. **Unvalidated inputs reach the DB (payment days NaN, empty catalogue names, empty payment date)** — medium · effort S · ○ finder evidence
   - Where: src/components/forms/ClientForm.tsx:100; CatalogueManager.tsx:54; PaymentPanel.tsx:53
   - Why: Saves fail with constraint errors or produce blank picker entries.
   - Fix: Validate integers/required names/dates before submit with inline errors.
   - Claims: bug-p2-27, bug-p2-31, missing-merge-66

41. **Catalogue manager: section rename 'Cancel' saves and Enter saves twice; delete/reorder ignore errors** — medium · effort S · ○ finder evidence
   - Where: src/components/forms/CatalogueManager.tsx:104-214
   - Why: Unintended renames persist and failed reorders look saved until reload.
   - Fix: Drop the onBlur save, guard with an in-flight ref, check all update/delete results and persist reorder with one upsert.
   - Claims: bug-p2-29, bug-p2-32

42. **Unsaved edits are lost: pending autosave cancelled on unmount, new documents never persisted, no navigation guard** — high · effort M · ○ finder evidence
   - Where: src/components/forms/DocumentBuilder.tsx:623-627
   - Why: A long new invoice or the last two seconds of edits vanish on Back, reload or a tab switch.
   - Fix: Create a draft row on first meaningful change, flush (not cancel) autosave on unmount, and add beforeunload plus a dirty flag.
   - Claims: bug-p1-15, missing-merge-7

43. **Overpayments accepted silently; zero-total documents show 'Paid in full'** — medium · effort S · ○ finder evidence
   - Where: src/components/layout/PaymentPanel.tsx:48
   - Why: An overpayment is hidden and an empty document looks settled.
   - Fix: Warn when amount > balance, show an 'Overpaid by' state and treat total<=0 as nothing to pay.
   - Claims: bug-p3-30

44. **Reminder offered for not-yet-due invoices and the route accepts any document id** — medium · effort S · ○ finder evidence
   - Where: src/components/layout/InvoicePageClient.tsx:49; api/invoices/[id]/reminder/route.ts:24
   - Why: Clients can receive 'seit 0 Tagen überfällig' or a reminder for a quote/paid invoice.
   - Fix: Show the button only when due_date < today and restrict the route to invoices with status sent/overdue and balance > 0.
   - Claims: bug-p3-22, bug-p3-31

45. **Clearing the Date field breaks draft save and autosave** — medium · effort S · ○ finder evidence
   - Where: src/components/forms/DocumentBuilder.tsx:279
   - Why: An empty date yields a raw Postgres error on save and silent autosave failure.
   - Fix: Validate date before any save or always fall back to today().
   - Claims: bug-p1-21

## P1 — Austrian compliance & document integrity

_26 items_

1. **Issued documents remain fully editable and autosaved; status transitions and payments ignore status** — high · effort L · ◐ partly verified
   - Where: src/components/forms/DocumentBuilder.tsx:604; DocumentStatusBar.tsx:9-67; PaymentPanel.tsx:66
   - Why: A sent invoice can be silently rewritten, reverted to draft or edited after Bookamat/Drive sync, breaking immutability.
   - Fix: Treat number IS NOT NULL as locked (read-only builder, explicit 'Correct via credit note'), define a transition table and only allow payments on numbered sent/overdue invoices.
   - Claims: bug-p4-24, bug-p4-25, bug-p3-17, missing-merge-57

2. **Issued invoices can be hard-deleted (singly and in bulk) and their number reused** — critical · effort M · ◐ partly verified
   - Where: src/components/layout/DeleteDocumentButton.tsx:20; api/invoices/bulk/route.ts:42
   - Why: Violates the 7-year retention and continuous numbering requirement.
   - Fix: Allow delete only when number is null; replace with 'Cancel (Storno)' for issued documents and drop the counter rollback.
   - Claims: bug-p4-11, bug-p1-39

3. **No frozen copy of issued invoices: PDFs regenerate from live client/settings data** — high · effort L · ✓ verified
   - Where: src/app/api/documents/[id]/drive-pdf/route.ts:20 and all render paths
   - Why: Editing a client address or IBAN silently changes already issued invoices and their Drive archive.
   - Fix: At issuance store recipient/issuer JSON snapshots (and ideally the rendered PDF) on the document and render from them.
   - Claims: bug-p4-2

4. **No audit trail: no issued_at/sent_at, no email dispatch history** — high · effort M · ○ finder evidence
   - Where: src/app/api/gmail/send/route.ts:37
   - Why: The owner cannot prove when and to whom an invoice was sent.
   - Fix: Add issued_at and a document_events table written on issue, send, reminder, status change and Drive upload.
   - Claims: missing-merge-11

5. **Credit-note PDF is labelled like an invoice and never references the corrected invoice** — high · effort S · ? not re-verified
   - Where: src/components/pdf/InvoiceDocument.tsx:142
   - Why: A Gutschrift without reference to the original invoice is not a valid Rechnungskorrektur.
   - Fix: Add credit-note labels, print 'Korrektur zu Rechnung {number} vom {date}' from converted_from_id, drop the due date and show amounts as credits.
   - Claims: bug-p3-56

6. **No Storno workflow and credit notes cannot be settled, applied or synced to Bookamat** — high · effort L · ○ finder evidence
   - Where: src/components/layout/DocumentStatusBar.tsx:11-67; api/bookamat/sync/route.ts:107
   - Why: Cancelling or crediting an invoice leaves balances, Bookamat and the VAT report untouched.
   - Fix: On cancel auto-create a linked Storno/credit note with reason, add a 'settled' status with refund payment that reduces the invoice balance, and post credit notes to Bookamat with negative sign.
   - Claims: missing-merge-14, missing-merge-64, missing-merge-54

7. **Issuer UID-Nummer (and owner name/website) never printed on PDF or portal** — high · effort S · ? not re-verified
   - Where: src/components/pdf/InvoiceDocument.tsx:338
   - Why: A mandatory § 11 UStG element is missing on every invoice.
   - Fix: Render settings.uid_number (and website) in the footer contact block and portal header.
   - Claims: bug-p4-8

8. **Tax note wrong for English non-EU documents and absent on the portal** — high · effort S · ○ finder evidence
   - Where: src/lib/utils/document.ts:95; src/app/portal/[token]/page.tsx:243
   - Why: Non-EU clients get a reverse-charge sentence and portal viewers see no explanation for missing VAT.
   - Fix: Change the EN default to a 'not subject to Austrian VAT' sentence and render getTaxNote under the portal totals.
   - Claims: bug-p4-4, bug-p3-6

9. **Issue-time validation missing: reverse charge without recipient UID, empty descriptions, zero quantities** — medium · effort S · ◐ partly verified
   - Where: src/components/forms/DocumentBuilder.tsx:264-266
   - Why: Legally incomplete invoices can be numbered and sent.
   - Fix: Block 'sent' when eu_reverse_charge and client UID is empty or any item has blank description/quantity <= 0, with inline errors.
   - Claims: bug-p4-9, bug-p5-37

10. **Net amount per VAT rate and per-line VAT rate not shown on the PDF** — high · effort S · ○ finder evidence
   - Where: src/components/pdf/InvoiceDocument.tsx:299
   - Why: Multi-rate invoices lack the required Entgelt split per rate.
   - Fix: Print 'Netto {rate}%' bases before each VAT row and add a rate suffix/column on item lines.
   - Claims: missing-merge-16

11. **No service period (Leistungszeitraum from-to) and no check that a service date exists** — high · effort M · ○ finder evidence
   - Where: src/components/forms/DocumentBuilder.tsx:790
   - Why: Multi-day sessions cannot state the mandatory period of supply.
   - Fix: Add service_period_end on document and line, a day/period toggle, print it, and warn at issue when no service date exists.
   - Claims: missing-merge-3

12. **PDF/portal/email print raw ISO dates, raw unit enums and English labels on German documents** — medium · effort S · ○ finder evidence
   - Where: src/components/pdf/InvoiceDocument.tsx:146, 268; portal page
   - Why: German invoices show '2026-10-09', '/day', 'Subtotal' and English ones 'USt.'.
   - Fix: Run formatDate on template vars and add UNIT_LABELS plus localised section/VAT labels in a shared labels module.
   - Claims: bug-p2-37, bug-p5-14

13. **PDF uses built-in Helvetica (WinAnsi only); non-Latin-1 characters and the minus sign are dropped** — medium · effort S · ○ finder evidence
   - Where: src/components/pdf/InvoiceDocument.tsx:6
   - Why: Client names with ł/ř/ő or the discount minus silently disappear from legal documents.
   - Fix: Font.register a Unicode TTF family (e.g. Inter/Noto) from /public/fonts and use it as the page font.
   - Claims: bug-p1-29, missing-merge-17

14. **Number tokens use DB current_date, counters never reset per year, issue date unvalidated** — medium · effort S · ○ finder evidence
   - Where: supabase/migrations/20260528_fix_next_number_where_clause.sql:33
   - Why: A December invoice issued in January gets the new year in its number and the sequence never restarts.
   - Fix: Pass the document date to the RPC, derive {YYYY}/{MM} from it and reset the counter when the year changes.
   - Claims: bug-p4-15

15. **Numbering settings unvalidated and overwrite live counters with stale values** — medium · effort S · ○ finder evidence
   - Where: src/components/forms/SettingsForm.tsx:348-351, 555
   - Why: Empty prefix, missing sequence token or a lowered counter leads to malformed or duplicate numbers.
   - Fix: Validate prefix/format/next-number against issued numbers, only write counters that were edited and use replaceAll in the preview.
   - Claims: bug-p2-38, bug-p2-39, bug-p2-45

16. **Repository schema cannot reproduce production (missing columns, contradictory NOT NULL, unit 'session' check, no logos bucket)** — high · effort M · ○ finder evidence
   - Where: supabase/schema.sql:72-115
   - Why: A restore from the repo yields a database the app cannot run on.
   - Fix: Write catch-up migrations (or dump the live schema), relax number/item NOT NULLs, add 'session' to the unit check and create the logos bucket with policies.
   - Claims: bug-p3-33, bug-p3-34, bug-p3-35, bug-p3-45

17. **Multi-currency is nominal: exchange_rate always 1, catalogue prices copied verbatim, USD/GBP summed as EUR** — high · effort L · ○ finder evidence
   - Where: src/app/(app)/reports/page.tsx:36; CatalogueManager.tsx:272; DuplicateDocumentButton.tsx:60
   - Why: Reports, dashboard, client balances and Bookamat treat foreign amounts as euros.
   - Fix: Expose an editable EUR rate (prefilled from ECB) on non-EUR documents, print the EUR VAT amount, convert in all aggregates and copy exchange_rate on duplicate.
   - Claims: bug-p4-12, bug-p2-30, bug-p3-28

18. **UVA report is Soll-based only and 'Zahllast' omits Vorsteuer** — high · effort M · ? not re-verified
   - Where: src/app/(app)/reports/page.tsx:21
   - Why: An Einnahmen-Ausgaben-Rechner under Ist-Besteuerung gets the wrong period attribution.
   - Fix: Add a Soll/Ist setting (default Ist) that attributes payments pro rata to VAT groups, and relabel the total as Umsatzsteuer ohne Vorsteuer.
   - Claims: bug-p4-22

19. **No Kleinunternehmer mode or exemption note** — medium · effort M · ○ finder evidence
   - Where: src/lib/utils/document.ts:97
   - Why: Below the threshold the app cannot issue compliant VAT-free invoices.
   - Fix: Add settings.vat_regime with the § 6 Abs 1 Z 27 note, hide VAT rows and the report in that mode.
   - Claims: missing-merge-13

20. **VAT report lacks per-UID ZM table and monthly/annual periods** — medium · effort M · ○ finder evidence
   - Where: src/app/(app)/reports/page.tsx:96; ReportControls.tsx:25
   - Why: The ZM and the annual declaration cannot be prepared from the report.
   - Fix: Join client UIDs for a grouped ZM table and add month/year period selectors.
   - Claims: missing-merge-74, missing-merge-31

21. **Drive archiving is optional and fire-and-forget** — high · effort M · ○ finder evidence
   - Where: src/components/forms/DocumentBuilder.tsx:587
   - Why: Issued invoices may never reach the 7-year archive.
   - Fix: Trigger drive-pdf as an awaited side effect of issuance (year/type subfolders) and show the archive status on the document.
   - Claims: missing-merge-52

22. **No structured e-invoice (ebInterface/Peppol UBL) or PDF/A output** — medium · effort XL · ○ finder evidence
   - Where: src/components/pdf/InvoiceDocument.tsx:6
   - Why: Public-sector and larger clients increasingly require structured invoices.
   - Fix: Add a UBL (Peppol BIS 3.0) export route and embed fonts for PDF/A once the snapshot exists.
   - Claims: missing-merge-76

23. **Portal and share link work for drafts and unnumbered documents** — medium · effort S · ○ finder evidence
   - Where: src/app/portal/[token]/pdf/route.ts:20
   - Why: A client can receive a 'Rechnung DRAFT' PDF.
   - Fix: 404 unless the document has a number and status is not draft; hide the Share button otherwise.
   - Claims: bug-p1-34

24. **EPC QR beneficiary uses the trade name and remittance is truncated at 35 chars** — medium · effort S · ○ finder evidence
   - Where: src/lib/utils/epc-qr.ts:29; DocumentBuilder.tsx:337
   - Why: Verification-of-Payee may flag the transfer and long references get cut.
   - Fix: Add settings.account_holder for the QR/payment block and allow 140 chars in the unstructured field.
   - Claims: missing-merge-18, bug-p4-23

25. **IBAN, BIC and UID stored without format validation** — medium · effort S · ○ finder evidence
   - Where: src/components/forms/SettingsForm.tsx:758
   - Why: A typo makes every QR unpayable or prints a wrong UID.
   - Fix: Add mod-97 IBAN, BIC regex and ATU+8 digit checks on save.
   - Claims: missing-merge-47

26. **No HTTP security headers and portal pages are indexable** — low · effort S · ○ finder evidence
   - Where: next.config.ts:3; src/app/portal/layout.tsx:2
   - Why: The token portal can be framed and could be indexed if a link leaks.
   - Fix: Add headers() with frame-ancestors/Referrer-Policy and export robots noindex metadata for the portal.
   - Claims: missing-merge-69, bug-p3-10

## P2 — Missing features (ranked by value)

_22 items_

1. **Multi-stage dunning with grace period, opt-out, fees/interest and a printable Mahnung** — high · effort L · ○ finder evidence
   - Where: src/app/api/cron/reminders/route.ts:36; ReminderButton.tsx:18
   - Why: Today every client is emailed once the morning after the due date and never again, with no way out without Gmail.
   - Fix: Add reminder settings (enabled, grace, interval, levels, fee basis), per-client opt-out, reminder history, and a Mahnung PDF/mailto fallback.
   - Claims: missing-merge-39, missing-merge-65

2. **Accountant-grade export and full data backup** — high · effort M · ○ finder evidence
   - Where: src/components/lists/InvoiceList.tsx:51
   - Why: The only export is an 8-column gross CSV; the Steuerberater needs net/VAT/treatment/UID/payment data and credit notes.
   - Fix: Add a per-period 'Export for accountant' (semicolon CSV/XLSX, de-AT formats) plus JSON backup and bulk PDF ZIP.
   - Claims: missing-merge-34

3. **Invoice list: balance due column, date-range/client filters and filtered totals** — medium · effort M · ○ finder evidence
   - Where: src/app/(app)/invoices/page.tsx:10; InvoiceList.tsx:92
   - Why: Partially paid invoices look unpaid and 'all invoices of Q3 with sums' is impossible.
   - Fix: Select payments, show Paid/Open, add URL-persisted year/quarter/from-to/client filters with sum footer.
   - Claims: missing-merge-21, missing-merge-22

4. **Quote lifecycle: enforce valid-until, record portal responses, notify owner** — medium · effort M · ○ finder evidence
   - Where: src/app/api/portal/[token]/respond/route.ts:22
   - Why: Expired quotes can be accepted and the owner is never told.
   - Fix: Reject responses after due_date, store responded_at/action, show expired state in lists and email the owner on response.
   - Claims: missing-merge-23

5. **Skonto, payment-terms sentence and late-fee template variables** — medium · effort M · ○ finder evidence
   - Where: src/components/layout/PaymentPanel.tsx:65
   - Why: Common Austrian B2B terms cannot be stated or applied at payment.
   - Fix: Add skonto_percent/days on document (defaults from client/settings), print the terms line and support Skonto settlement with VAT-base reduction.
   - Claims: missing-merge-10

6. **Payment model: partially_paid/written_off states, payment method and bank reference** — medium · effort M · ○ finder evidence
   - Where: src/components/layout/PaymentPanel.tsx:48
   - Why: Uncollectible or partly paid invoices have no honest status.
   - Fix: Derive partially_paid from balance, add written_off with reason, and store method/reference on payments.
   - Claims: missing-merge-63

7. **Bank statement import (CAMT.053/CSV) with automatic payment matching** — medium · effort L · ○ finder evidence
   - Where: src/components/layout/PaymentPanel.tsx:51
   - Why: Every incoming payment is typed by hand.
   - Fix: Parse bank exports, match on invoice number/amount and create payments after review.
   - Claims: missing-merge-77

8. **Recurring invoices for monthly rentals/retainers** — medium · effort L · ○ finder evidence
   - Where: src/components/layout/DuplicateDocumentButton.tsx:21
   - Why: Monthly 'Studio Miete' invoices are rebuilt by hand each month.
   - Fix: Add recurring_profiles generated by the daily cron as drafts.
   - Claims: missing-merge-78

9. **Client-specific rate cards** — medium · effort M · ○ finder evidence
   - Where: src/components/forms/DocumentBuilder.tsx:224
   - Why: Different day rates per label/client must be retyped on every line.
   - Fix: Add client_prices and prefer them in pickCatalogueItem.
   - Claims: missing-merge-79

10. **Anzahlungs-/Teil-/Schlussrechnung workflow** — medium · effort L · ○ finder evidence
   - Where: src/types/index.ts:5
   - Why: Deposits cannot be invoiced and deducted (incl. VAT) on the final invoice.
   - Fix: Add invoice_kind and advance_invoice_ids with a deduction block in totals and PDF.
   - Claims: missing-merge-75

11. **Quick-add client from the builder and show client notes/terms there** — medium · effort M · ○ finder evidence
   - Where: src/components/forms/DocumentBuilder.tsx:173, 730
   - Why: Creating a client mid-invoice loses the draft and client hints are invisible while billing.
   - Fix: Add an inline 'New client' dialog that selects the result and an info box with notes/payment terms under the selector.
   - Claims: missing-merge-41, missing-merge-40

12. **Settings defaults for currency, VAT rate, unit, tax treatment and quote validity** — medium · effort S · ○ finder evidence
   - Where: src/components/forms/SettingsForm.tsx:212
   - Why: New documents hard-code EUR/20%/at_vat.
   - Fix: Add default_* columns and use them in blankLine/new documents.
   - Claims: missing-merge-46

13. **Email: CC/BCC, multiple contacts per client and portal link in emails** — medium · effort M · ○ finder evidence
   - Where: src/app/api/gmail/send/route.ts:17
   - Why: Accounting mailboxes cannot be copied and clients never get the online link.
   - Fix: Add client_contacts/cc_emails, accept cc/bcc in the send route and expose {{portal_link}} in templates.
   - Claims: missing-merge-15, missing-merge-59

14. **Portal: viewed tracking, link expiry/rotation and pay-now QR** — low · effort M · ○ finder evidence
   - Where: src/app/portal/[token]/page.tsx:63, 277; share/route.ts:17
   - Why: The owner cannot see if the client opened the invoice and phone users cannot scan the GiroCode.
   - Fix: Record share_viewed_at, add optional expiry and regenerate, and render the EPC QR image on the portal.
   - Claims: missing-merge-60, missing-merge-61, missing-merge-62

15. **Bookamat: sync status in the list, bulk sync, re-attach PDF, optional automatic sync** — medium · effort M · ○ finder evidence
   - Where: src/components/lists/InvoiceList.tsx:1; PaymentPanel.tsx:236
   - Why: Skipped syncs are easily forgotten and a failed attachment cannot be retried.
   - Fix: Add a Bookamat badge/filter with bulk sync, an 'Attach PDF' action and an optional cron sync.
   - Claims: missing-merge-56, missing-merge-58

16. **Password reset (and optional MFA) for the owner account** — medium · effort S · ○ finder evidence
   - Where: src/app/(auth)/login/page.tsx:22
   - Why: A forgotten password locks the owner out.
   - Fix: Add 'Forgot password' via resetPasswordForEmail with a /reset-password page and auth callback.
   - Claims: missing-merge-68

17. **Client data model: ISO country with tax-treatment suggestion, client number, duplicate detection** — medium · effort M · ○ finder evidence
   - Where: src/components/forms/ClientForm.tsx:144; supabase/schema.sql:44
   - Why: Tax treatment cannot be derived from country and bookkeeping lacks a Kundennummer.
   - Fix: Add country_code select, client_number sequence and a warning on duplicate email/UID.
   - Claims: missing-merge-36, missing-merge-38, missing-merge-42

18. **Catalogue: long descriptions, search and 'show hidden' toggle** — low · effort S · ○ finder evidence
   - Where: src/types/index.ts:104; CatalogueManager.tsx:193
   - Why: Recurring service descriptions are retyped and hidden items are hard to manage.
   - Fix: Add description_de/en used to prefill lines, a search box and a hidden filter with usage counts.
   - Claims: missing-merge-43, missing-merge-45

19. **Lists: bulk/export for quotes, credit notes and clients, URL-persisted view, client balances and tag filters** — low · effort M · ○ finder evidence
   - Where: src/components/lists/QuoteList.tsx:48; ClientList.tsx:53
   - Why: Only invoices have bulk actions and views reset on Back.
   - Fix: Generalise the invoice list's selection/export, mirror q/sort/page to searchParams and aggregate per-client open balance.
   - Claims: missing-merge-24, missing-merge-25, missing-merge-26

20. **Projects, time tracking, expenses and client statements** — low · effort XL · ○ finder evidence
   - Where: src/types/index.ts:133; clients/[id]/page.tsx:96
   - Why: Production-level grouping, unbilled hours, Vorsteuer and offene-Posten statements are outside the app today.
   - Fix: Add projects and time_entries tables, a client statement PDF, and either an expenses module or a clear note that Vorsteuer lives in Bookamat.
   - Claims: missing-merge-80, missing-merge-82, missing-merge-83, missing-merge-81

21. **Google hygiene: validate the Drive folder on save and revoke the grant on disconnect** — low · effort S · ○ finder evidence
   - Where: src/components/forms/SettingsForm.tsx:437-448
   - Why: A wrong folder fails only at first upload and tokens stay valid after disconnect.
   - Fix: Call drive.files.get on save (supportsAllDrives) and add POST /api/gmail/disconnect that revokes the token.
   - Claims: missing-merge-51, missing-merge-50

22. **Per-line discounts (columns exist but unused)** — low · effort S · ○ finder evidence
   - Where: src/components/forms/DocumentBuilder.tsx:259
   - Why: A 10% discount on one line is impossible although the schema suggests it.
   - Fix: Support item-level discounts in calcTotals/PDF or rename the columns to section_discount.
   - Claims: missing-merge-6

## P3 — UX & design polish (themes)

_20 items_

1. **Mixed German/English copy, raw enums and inconsistent wording** — medium · effort M · ○ finder evidence
   - Where: DocumentBuilder.tsx:712, 1394, 1497; SettingsForm.tsx:307; layout.tsx:25; DocumentStatusBar.tsx:108
   - Why: Labels flip language with the document, dialogs print 'credit_note', toasts and casing vary, html lang is 'de' for an English UI.
   - Fix: Keep app chrome in one language with a label map, localise only printed content, set lang accordingly and standardise toast/case patterns.
   - Claims: ux-merge-5, ux-merge-92, ux-merge-110, ux-merge-111, ux-merge-14, ux-merge-85, missing-merge-73, bug-p5-35

2. **Native confirm() dialogs, ad-hoc modals and one-click destructive actions** — medium · effort M · ○ finder evidence
   - Where: DocumentBuilder.tsx:653; PaymentPanel.tsx:182; InvoiceList.tsx:419; src/components/ui
   - Why: Eight confirm() calls, modals without focus trap/Escape, bulk delete with no detail, and payment removal/reset/revoke/disconnect execute instantly.
   - Fix: Add shared Dialog/AlertDialog primitives and route every confirmation and destructive action through them with specific copy.
   - Claims: ux-merge-16, ux-merge-74, ux-merge-34, missing-merge-71

3. **Accessible names, label association and state attributes missing** — medium · effort M · ○ finder evidence
   - Where: DocumentBuilder.tsx:643, 729; InvoiceList.tsx:186; MobileHeader.tsx:108; SettingsForm.tsx:645
   - Why: Icon-only buttons, grid inputs, sortable headers, selection toggles, tabs and nav expose no name or state to assistive tech.
   - Fix: Add aria-label/htmlFor+id everywhere, real checkboxes, aria-sort/aria-pressed/aria-current and a keyboard-reachable logo upload.
   - Claims: ux-merge-4, ux-merge-13, ux-merge-33, ux-merge-41, ux-merge-91, ux-merge-118

4. **Focus rings, contrast, reduced motion and inline validation** — medium · effort M · ○ finder evidence
   - Where: DocumentBuilder.tsx:265, 644, 766; PageTransition.tsx:8
   - Why: Selects drop the focus outline, muted text is below WCAG, animations ignore prefers-reduced-motion and validation is toast-only.
   - Fix: Shared Select token with focus-visible ring, darker muted tokens, motion-safe animations and an errors map with aria-invalid.
   - Claims: ux-merge-115, ux-merge-116, ux-merge-117, missing-merge-87

5. **Mobile layout overflow and clipping** — medium · effort M · ◐ partly verified
   - Where: portal/[token]/page.tsx:147; CreditNoteList.tsx:107; clients/[id]/page.tsx:90; SettingsForm.tsx:811; ReminderButton.tsx:52
   - Why: Portal line table, credit-note list, stat cards, Settings/ClientForm grids and the numbering row are clipped at 375px and the Resend button is empty.
   - Fix: Use grid-cols-1 sm:* breakpoints, overflow-x-auto or card layouts below sm, and always render a label in Resend.
   - Claims: bug-p3-4, missing-merge-84, ux-merge-52, ux-merge-60, bug-p5-21, bug-p5-20

6. **Touch ergonomics: iOS zoom, tiny targets, keyboards, safe area, touch reorder/share, chart** — medium · effort M · ○ finder evidence
   - Where: ui/input.tsx:12; PaymentPanel.tsx:182; MobileHeader.tsx:49; DocumentBuilder.tsx:814; RevenueChart.tsx:38
   - Why: Every tap zooms, icon buttons are 10-28px, the top bar sits under the notch, line items cannot be reordered by touch and the chart is hover-only.
   - Fix: text-base on mobile, min 44pt targets, inputMode/type hints, safe-area-inset-top, move up/down buttons, Web Share and tap/keyboard chart access.
   - Claims: ux-merge-102, ux-merge-103, ux-merge-104, ux-merge-90, bug-p5-17, missing-merge-85, missing-merge-86, ux-merge-42

7. **Dark mode gaps and theme toggle/hydration bugs** — medium · effort S · ○ finder evidence
   - Where: DocumentBuilder.tsx:1239; Sidebar.tsx:61-64; MobileHeader.tsx:134
   - Why: Amber/blue boxes stay light, the toggle shows the wrong icon for system-dark users and causes a hydration mismatch.
   - Fix: Add dark: variants, use resolvedTheme and render both icons toggled by CSS.
   - Claims: ux-merge-19, bug-p3-49, bug-p3-50

8. **App shell and PWA: manifest, sticky bars, padding, favicon, mono font, auth redirect** — low · effort S · ○ finder evidence
   - Where: (app)/layout.tsx:17; manifest.ts:8-19; globals.css:11; src/app/favicon.ico
   - Why: Sticky bars never stick, desktop keeps 5rem bottom padding, manifest icons are the wrong size with a forced dark theme, the Vercel favicon ships and font-mono is undefined.
   - Fix: Drop overflow-auto on main, use utility padding, generate real 192/512 icons, replace favicon, load Geist Mono and add ?next= to the login redirect.
   - Claims: ux-merge-93, bug-p3-53, bug-p3-48, bug-p3-52, bug-p3-54, bug-p3-55, ux-merge-87

9. **Line-item editor ergonomics: numeric inputs, catalogue popup, single-line descriptions, VAT column, drag offset** — medium · effort M · ◐ partly verified
   - Where: DocumentBuilder.tsx:150, 1182, 1215, 1260, 1263
   - Why: Comma decimals become 0, the catalogue popup hijacks Tab and clicks, notes cannot wrap, VAT shows on RC docs and drop lands one row off.
   - Fix: Use text+inputMode=decimal with parse on blur, onClick items closing on blur/Escape, auto-growing textarea, hide VAT when not at_vat and fix the drop index.
   - Claims: bug-p5-19, ux-merge-10, ux-merge-15, bug-p5-36, bug-p1-14

10. **PDF layout and labels** — medium · effort M · ○ finder evidence
   - Where: InvoiceDocument.tsx:6, 65, 167, 198, 316, 337
   - Why: Footer can overlap body, header not repeated, bare QR, empty IBAN lines, wrong labels on quotes/credit notes, bank details on credit notes, no sender line, QR on USD/GBP, no status stamp.
   - Fix: Raise bottom padding, fixed header/wrap=false rows, captioned larger QR, type-specific labels and payment block, DIN sender line, EUR-only QR and ENTWURF/STORNIERT stamps.
   - Claims: bug-p1-32, ux-merge-23, ux-merge-24, ux-merge-26, ux-merge-27, ux-merge-29, ux-merge-97, ux-merge-95, missing-merge-19

11. **Dates and money formatting in the UI and CSV** — medium · effort S · ○ finder evidence
   - Where: document.ts:114; InvoiceList.tsx:65, 337
   - Why: Lists and panels show ISO dates, English docs get German number format, USD shows as € and the CSV does not open in Austrian Excel.
   - Fix: formatDate/formatMoney with lang and currency at every site; BOM, semicolon and de-AT formats in CSV.
   - Claims: ux-merge-12, ux-merge-30, ux-merge-35

12. **List rows and bulk bar interaction** — low · effort S · ○ finder evidence
   - Where: InvoiceList.tsx:332, 431
   - Why: Only the number cell is clickable and Confirm can double-fire.
   - Fix: Row-level navigation and disabled Confirm with spinner.
   - Claims: ux-merge-37, ux-merge-38

13. **Dashboard and reports presentation** — low · effort S · ○ finder evidence
   - Where: dashboard/page.tsx:43, 141, 288; reports/page.tsx:9, 70, 88; clients/page.tsx:9
   - Why: Overdue banner at the bottom, drafts in Pending Quotes and Last Invoice, unlinked KPI cards, no included-invoice list, misleading VAT labels and unvalidated period params.
   - Fix: Move the banner up, filter drafts/cancelled, link or restyle cards, add a collapsible document table, rename Zahllast and clamp quarter/year.
   - Claims: ux-merge-44, ux-merge-45, ux-merge-47, ux-merge-46, ux-merge-39, bug-p2-15, bug-p1-46

14. **Error and loading feedback** — medium · effort M · ○ finder evidence
   - Where: settings/page.tsx:4; portal/[token]/page.tsx:69; ConvertToInvoiceButton.tsx:17; ReminderButton.tsx:25; ShareLinkButton.tsx:57; PaymentPanel.tsx:139
   - Why: No error/not-found pages, missing loading states, buttons stuck in 'Converting…'/'Sending…', swallowed DB/clipboard/PDF errors and raw error bodies in toasts.
   - Fix: Add error.tsx/not-found.tsx/loading.tsx, try/catch/finally in all handlers, friendly error mapping and matching skeletons.
   - Claims: ux-merge-40, ux-merge-83, ux-merge-56, ux-merge-32, bug-p2-16, bug-p3-25, bug-p3-9, ux-merge-79, ux-merge-76, ux-merge-73

15. **Email templates and reminder flow** — medium · effort S · ○ finder evidence
   - Where: SettingsForm.tsx:1090; reminder/route.ts:34, 54; ReminderButton.tsx:64
   - Why: Non-reminder templates show no defaults or preview, reminder language follows the client not the invoice, {{sender}} can be empty and reminders send without review.
   - Fix: Shared defaults with placeholders and live preview, derive language from the invoice, use company_name || owner_name and reuse the review modal.
   - Claims: ux-merge-61, ux-merge-113, ux-merge-105, bug-p2-44

16. **Google and Bookamat settings feedback** — medium · effort M · ○ finder evidence
   - Where: SettingsForm.tsx:1130-1325, 1204; ShareLinkButton.tsx:82-84; PaymentPanel.tsx:238
   - Why: Permanent 'Re-connect' warning, Drive checkbox active after disconnect, repeating toast, no health info, no Bookamat disconnect/cancel, stray '0', Copy silently uploads to Drive.
   - Fix: Store granted scopes, clear the query param, add test-connection/last-error, Bookamat Cancel/Disconnect, booking link, and a separate Save-to-Drive button.
   - Claims: bug-p2-42, bug-p2-54, ux-merge-70, ux-merge-71, ux-merge-88, ux-merge-62, ux-merge-77, ux-merge-78, ux-merge-67

17. **Clients and catalogue interaction** — medium · effort M · ○ finder evidence
   - Where: ClientForm.tsx:144, 196; CatalogueManager.tsx:182-283; DocumentBuilder.tsx:733
   - Why: No cancel when editing a client, hover-only catalogue actions, dead-end empty catalogue, Enter does not save, defaults ignore Settings and the client dropdown mixes inactive clients.
   - Fix: Add Cancel, always-visible actions with keyboard access, a global Add item, form submit on Enter, settings-driven defaults and a grouped/searchable client picker.
   - Claims: ux-merge-48, ux-merge-49, ux-merge-50, ux-merge-51, ux-merge-54, ux-merge-20

18. **Issue-flow guidance: setup completeness, stale draft dates, numbering hints, hidden tax notes** — medium · effort S · ○ finder evidence
   - Where: DocumentBuilder.tsx:271, 358; SettingsForm.tsx:783, 961
   - Why: Invoices can be issued with empty IBAN/UID, drafts keep their creation date, and consequences of numbering changes are unexplained.
   - Fix: settingsComplete() guard with links, refresh date/due date on issue, helper text and a Tax nav item.
   - Claims: ux-merge-101, ux-merge-94, ux-merge-66, ux-merge-64

19. **Visual consistency of buttons and controls** — low · effort S · ○ finder evidence
   - Where: DuplicateDocumentButton.tsx:72; DocumentBuilder.tsx:1253
   - Why: Six hand-rolled button styles and three control heights misalign rows.
   - Fix: Use Button variants everywhere and add a Select primitive matching Input.
   - Claims: ux-merge-109, ux-merge-112

20. **Portal polish: payment box, titles and language** — low · effort S · ○ finder evidence
   - Where: portal/[token]/page.tsx:283; src/app/layout.tsx:13
   - Why: Empty IBAN lines, unlabeled reference, no QR, native confirm, page title 'Mado Invoice' and lang='de' on English documents.
   - Fix: Guard empty lines, label Verwendungszweck, render the QR, inline confirm, generateMetadata with number and lang from document.language.
   - Claims: ux-merge-81, ux-merge-84

## P4 — Code quality (themes)

_7 items_

1. **DocumentBuilder: duplicated mobile/desktop editor, three persistence paths, repeated section math and render side effects** — high · effort L · ○ finder evidence
   - Where: src/components/forms/DocumentBuilder.tsx:55, 278, 471, 560, 622, 733, 809
   - Why: Every builder fix must be made two or three times and the persistence bugs stem from divergent paths.
   - Fix: Extract LineRow/CataloguePopover/SectionSubtotal components, one persist() function keyed on a dirty flag, import calcSectionSubtotal and blobToBase64 from lib, memoise the client sort and drop the dead showSaveFilePicker branch.
   - Claims: quality-merge-1, quality-merge-2, quality-merge-3, quality-merge-5, quality-merge-6, quality-merge-10, quality-merge-11

2. **PDF assembly, label tables and template engines duplicated across routes** — medium · effort M · ○ finder evidence
   - Where: portal/[token]/pdf/route.ts:25, 73; InvoiceDocument.tsx:60; SettingsForm.tsx:30
   - Why: Portal, drive-pdf, cron and builder already diverge in totals, QR and labels.
   - Fix: Add src/lib/pdf/build-document.ts, a shared document-labels module, one fillTemplate with a typed variable registry, and typed InvoiceDocument props without 'as any'.
   - Claims: quality-merge-12, quality-merge-13, quality-merge-14, quality-merge-15

3. **Four near-identical list components, duplicated status/label maps and convert buttons; whole tables shipped** — medium · effort M · ○ finder evidence
   - Where: src/components/lists/QuoteList.tsx:81; ClientList.tsx:7; ConvertToInvoiceButton.tsx:13; invoices/page.tsx:8
   - Why: Accessibility, formatting and filter fixes must be applied four times and wording already diverges.
   - Fix: Extract useListState/SortableTh/StatusBadge/Pagination, a single labels module, one ConvertDocumentButton and select only needed columns with a last-invoice view.
   - Claims: quality-merge-16, quality-merge-22, quality-merge-23, missing-merge-27

4. **Fragile date math via mutating Date and toISOString** — low · effort S · ○ finder evidence
   - Where: src/app/(app)/reports/page.tsx:14; dashboard/page.tsx:11-19
   - Why: Has already produced a wrong KPI and will again.
   - Fix: Centralise period and today helpers in one tz-aware date module.
   - Claims: quality-merge-21

5. **Forms bypass the project's form stack; blind row writes; mismatched settings keys** — medium · effort M · ○ finder evidence
   - Where: ClientForm.tsx:77; CatalogueManager.tsx:54; SettingsForm.tsx:618
   - Why: No schema validation, whole rows written back to the DB and section flags easy to miswire.
   - Fix: Use react-hook-form + zod for ClientForm, pick editable fields in saveEdit, and key dirty state by nav id while removing dead refs/state.
   - Claims: quality-merge-26, quality-merge-27, quality-merge-31

6. **Server integrations duplicated: OAuth client, Drive upsert, reminder context, Bookamat fetch, auth guard, hand-rolled MIME** — medium · effort M · ○ finder evidence
   - Where: src/lib/utils/reminder.ts:21, 66; drive/upload/route.ts:49; bookamat/sync/route.ts:56; accounts/route.ts:50; reminder/route.ts:13, 33
   - Why: Five OAuth blocks, two Drive upload sequences and two reminder builders mean every integration fix lands in several files.
   - Fix: Add getAuthedGoogleClient, upsertDocumentPdf, buildReminderEmail, bookamatFetch and requireUser helpers, await token write-back and build MIME with MailComposer.
   - Claims: quality-merge-33, quality-merge-34, quality-merge-35, quality-merge-36, quality-merge-38, quality-merge-41, quality-merge-44, quality-merge-48

7. **Operational hygiene: settings singleton, counter-restore heuristic, portal light wrapper, nav duplication, template leftovers, env docs** — low · effort S · ○ finder evidence
   - Where: supabase/schema.sql:40; DeleteDocumentButton.tsx:31; portal/layout.tsx:4; MobileHeader.tsx:16; ui/sonner.tsx:41; README.md:1
   - Why: A missing or duplicate settings row crashes pages, the rollback regex misreads some formats, and required env vars are undocumented.
   - Fix: Enforce a singleton with a null-safe onboarding state, store sequence_no at issue, give the portal its own root layout, share NAV_ITEMS, delete unused assets and commit .env.example.
   - Claims: quality-merge-43, quality-merge-46, quality-merge-47, quality-merge-49, quality-merge-50, bug-p2-46, missing-merge-67

## Suggested PR sequence

1. **Persistence and issuance integrity** — effort L · risk: Touches the hottest code path and needs two migrations (replace_document_items, issue_document); test draft/send/download/Gmail flows end to end.
   - Scope: DocumentBuilder persistence, numbering RPC
   - Includes: Line items replaced by non-atomic delete+insert; failures silent; autosave races manual save; document_items never ordered by sort_order; Download/Drive/Gmail issue the number and set 'sent' before confirmation, with no re-entrancy guard; Non-Gmail email path sends a 'DRAFT' PDF without number, QR or status change; New credit note redirects to /invoices/{id}; detail pages never check document type; next_document_number has no row lock and burns the counter before the document is written; Clearing the Date field breaks draft save and autosave; Unsaved edits are lost: pending autosave cancelled on unmount, new documents never persisted, no navigation guard; DocumentBuilder: duplicated mobile/desktop editor, three persistence paths, repeated section math and render side effects

2. **Security hardening** — effort M · risk: An RLS policy pinned to the wrong uid locks the owner out; apply with the owner uid verified and keep a service-role fallback.
   - Scope: RLS, OAuth, cron, route auth, proxy.ts, input validation
   - Includes: RLS grants full access to any authenticated Supabase user; Google OAuth flow has no state parameter and /api/gmail/auth is unauthenticated; Cron auth fails open when CRON_SECRET is unset; Gmail tokens and Bookamat API key are serialised into client components; Share, convert and gmail/auth routes skip the explicit auth check; share DELETE reports success for nothing; No proxy.ts/middleware: refreshed Supabase session cookies are dropped; API routes accept unvalidated bodies (CRLF header injection, arbitrary Bookamat URL segments, unguarded JSON parse, TOCTOU status update); No HTTP security headers and portal pages are indexable

3. **Money math and VAT report correctness** — effort M · risk: Rounding changes alter printed totals by cents on existing documents; compare old vs new PDFs for a sample.
   - Scope: calcTotals rounding, discounts everywhere, VAT report, dashboard KPIs
   - Includes: No cent rounding in calcTotals; toFixed vs Intl and DB numeric truncation diverge; Percent discounts above 100% accepted, producing negative totals; List totals, total-sort and CSV ignore document and section discounts; VAT report overstates: ignores discounts, counts RC/non-EU in KZ 000, never subtracts credit notes; Dashboard KPIs use wrong bases (total vs balance, lifetime paid, 13-month cap, invoice-date revenue, month overflow, -Infinity, wrong 'recent' order); Date helpers are UTC-based (today, addDays across DST, formatDate, Bookamat fiscal year); Fragile date math via mutating Date and toISOString

4. **Status lifecycle and immutability** — effort L · risk: Locking issued documents changes the owner's habits; provide a clear 'correct via credit note' path before merging.
   - Scope: Status bar, bulk route, payments, overdue cron, delete rules
   - Includes: Bulk 'Mark Sent' and the status dropdown set 'sent'/'paid' without assigning a number; Marking 'paid' via dropdown or bulk records no payment row; markOverdueInvoices is never called, so cron reminders never fire; Overpayments accepted silently; zero-total documents show 'Paid in full'; Reminder offered for not-yet-due invoices and the route accepts any document id; Issued documents remain fully editable and autosaved; status transitions and payments ignore status; Issued invoices can be hard-deleted (singly and in bulk) and their number reused

5. **Conversion routes** — effort M · risk: Low; one FK migration (on delete set null).
   - Scope: Quote->invoice and invoice->credit-note routes and buttons
   - Includes: Quote->invoice conversion drops discounts, line types and service dates (credit-note conversion drops service_date); Convert route has no type/status/duplicate guard, ignores errors, burns a number on a draft, sets no due date and races autosave; Accepted quotes cannot be converted from the UI; Foreign-key failures surface raw (client with documents, converted quote/invoice)

6. **Reminders, cron and Bookamat correctness** — effort L · risk: Bookamat behaviour cannot be unit-tested offline; verify against a test fiscal year before syncing real invoices.
   - Scope: Reminder routes, cron, Bookamat sync/attach, PaymentPanel
   - Includes: Reminder/cron/Bookamat PDFs and emails ignore payments, section discounts and the EPC QR; Client payment_days never drives the due date; Bookamat posts wrong amounts: non-EUR as EUR, RC/non-EU on the 0% account, missing VAT account silently falls back; Bookamat sync lacks guards and state handling (unpaid/draft syncable, DB write ignored, year mismatch, unsaved-state PDF, multi-year partials, config mismatch, 409 not adopted); Server integrations duplicated: OAuth client, Drive upsert, reminder context, Bookamat fetch, auth guard, hand-rolled MIME

7. **Schema catch-up and numbering settings** — effort M · risk: Migrations must match the live database exactly; dump production first and diff.
   - Scope: supabase migrations, settings numbering card
   - Includes: Repository schema cannot reproduce production (missing columns, contradictory NOT NULL, unit 'session' check, no logos bucket); Number tokens use DB current_date, counters never reset per year, issue date unvalidated; Numbering settings unvalidated and overwrite live counters with stale values; Settings saves write NULL into NOT NULL text columns; Operational hygiene: settings singleton, counter-restore heuristic, portal light wrapper, nav duplication, template leftovers, env docs

8. **Legal invoice content on PDF and portal** — effort L · risk: Layout regressions on long invoices; render a regression set of PDFs (multi-page, multi-rate, RC, credit note).
   - Scope: InvoiceDocument, portal page, tax notes, fonts, issue-time validation
   - Includes: Credit-note PDF is labelled like an invoice and never references the corrected invoice; Issuer UID-Nummer (and owner name/website) never printed on PDF or portal; Tax note wrong for English non-EU documents and absent on the portal; Issue-time validation missing: reverse charge without recipient UID, empty descriptions, zero quantities; Net amount per VAT rate and per-line VAT rate not shown on the PDF; No service period (Leistungszeitraum from-to) and no check that a service date exists; PDF/portal/email print raw ISO dates, raw unit enums and English labels on German documents; PDF uses built-in Helvetica (WinAnsi only); non-Latin-1 characters and the minus sign are dropped; EPC QR beneficiary uses the trade name and remittance is truncated at 35 chars; IBAN, BIC and UID stored without format validation; PDF layout and labels; PDF assembly, label tables and template engines duplicated across routes

9. **Snapshot and archival** — effort L · risk: Snapshot columns must be backfilled for existing issued invoices from current client/settings rows.
   - Scope: Issuance snapshot, Drive archiving, portal gating, logo validation
   - Includes: No frozen copy of issued invoices: PDFs regenerate from live client/settings data; No audit trail: no issued_at/sent_at, no email dispatch history; Drive archiving is optional and fire-and-forget; Drive archive overwritten by name-based dedup; drafts upload as 'document.pdf'; Portal and share link work for drafts and unnumbered documents; Logo picker accepts WebP/GIF/HEIC which react-pdf cannot decode

10. **Google integration robustness** — effort M · risk: Needs a reconnect test with a revoked token; add a gmail_scopes column.
   - Scope: Gmail/Drive routes, callback, settings card
   - Includes: Google routes and settings handlers swallow or crash on errors; no invalid_grant handling; Google and Bookamat settings feedback; Google hygiene: validate the Drive folder on save and revoke the grant on disconnect

11. **Clients, catalogue and settings form fixes** — effort M · risk: Low; mostly isolated client components.
   - Scope: ClientForm, CatalogueManager, SettingsForm, client pages
   - Includes: Company-only clients render blank (no link in list, ' (Company)' in dropdown, 'Dear ,' greeting); Catalogue EditForm is defined inside the component and remounts on every keystroke; Variable chip insertion writes into the wrong template after switching tab; Client stats computed from only the newest 50 documents; Unvalidated inputs reach the DB (payment days NaN, empty catalogue names, empty payment date); Catalogue manager: section rename 'Cancel' saves and Enter saves twice; delete/reorder ignore errors; Clients and catalogue interaction; Forms bypass the project's form stack; blind row writes; mismatched settings keys

12. **Lists, dashboard and accountant export** — effort L · risk: Refactoring four lists at once is a large diff; land the shared list hooks first, then the export.
   - Scope: List components, dashboard panels, CSV/export
   - Includes: Invoice list state bugs: empty page after delete, hidden rows acted on by bulk actions, sticky URL status filter, wrong action counts; Invoice list: balance due column, date-range/client filters and filtered totals; Accountant-grade export and full data backup; Dates and money formatting in the UI and CSV; List rows and bulk bar interaction; Dashboard and reports presentation; Four near-identical list components, duplicated status/label maps and convert buttons; whole tables shipped

13. **Credit notes, Storno and VAT reporting options** — effort L · risk: Depends on owner decisions (Soll/Ist, Kleinunternehmer, Storno semantics); do not merge before they are answered.
   - Scope: Credit-note lifecycle, Bookamat credit notes, Soll/Ist, Kleinunternehmer, ZM/periods
   - Includes: No Storno workflow and credit notes cannot be settled, applied or synced to Bookamat; UVA report is Soll-based only and 'Zahllast' omits Vorsteuer; No Kleinunternehmer mode or exemption note; VAT report lacks per-UID ZM table and monthly/annual periods

14. **Dunning, payment terms and payment model** — effort L · risk: Automatic reminders email real clients; ship with reminders disabled by default and a dry-run log.
   - Scope: Reminder levels, Skonto, payment statuses, quote lifecycle
   - Includes: Multi-stage dunning with grace period, opt-out, fees/interest and a printable Mahnung; Skonto, payment-terms sentence and late-fee template variables; Payment model: partially_paid/written_off states, payment method and bank reference; Quote lifecycle: enforce valid-until, record portal responses, notify owner; Email templates and reminder flow

15. **Multi-currency** — effort M · risk: Existing USD/GBP documents need a backfilled rate; ask the owner for historical rates or use ECB on the invoice date.
   - Scope: Exchange rate on documents, aggregates, Bookamat, catalogue
   - Includes: Multi-currency is nominal: exchange_rate always 1, catalogue prices copied verbatim, USD/GBP summed as EUR

16. **Mobile and accessibility pass** — effort L · risk: Numeric input rework (text+inputMode) changes how values are parsed; cover with tests for comma/dot input.
   - Scope: Responsive layouts, touch, dialogs, a11y, error pages
   - Includes: Native confirm() dialogs, ad-hoc modals and one-click destructive actions; Accessible names, label association and state attributes missing; Focus rings, contrast, reduced motion and inline validation; Mobile layout overflow and clipping; Touch ergonomics: iOS zoom, tiny targets, keyboards, safe area, touch reorder/share, chart; Dark mode gaps and theme toggle/hydration bugs; App shell and PWA: manifest, sticky bars, padding, favicon, mono font, auth redirect; Line-item editor ergonomics: numeric inputs, catalogue popup, single-line descriptions, VAT column, drag offset; Error and loading feedback

17. **Copy, consistency and remaining features** — effort XL · risk: Broad but low-risk; split into several small PRs by area when executing.
   - Scope: Language/labels, button system, portal polish, settings defaults, quick-add client, Bookamat UX, password reset
   - Includes: Mixed German/English copy, raw enums and inconsistent wording; Visual consistency of buttons and controls; Portal polish: payment box, titles and language; Issue-flow guidance: setup completeness, stale draft dates, numbering hints, hidden tax notes; Settings defaults for currency, VAT rate, unit, tax treatment and quote validity; Quick-add client from the builder and show client notes/terms there; Email: CC/BCC, multiple contacts per client and portal link in emails; Bookamat: sync status in the list, bulk sync, re-attach PDF, optional automatic sync; Password reset (and optional MFA) for the owner account; Client data model: ISO country with tax-treatment suggestion, client number, duplicate detection; Catalogue: long descriptions, search and 'show hidden' toggle; Lists: bulk/export for quotes, credit notes and clients, URL-persisted view, client balances and tag filters; Portal: viewed tracking, link expiry/rotation and pay-now QR; Per-line discounts (columns exist but unused)

18. **Larger workflow features (later)** — effort XL · risk: Each is its own project; only start after PRs 1-9 so they build on locked, snapshotted documents.
   - Scope: Bank import, recurring invoices, rate cards, deposits, projects/time/expenses, e-invoicing
   - Includes: Bank statement import (CAMT.053/CSV) with automatic payment matching; Recurring invoices for monthly rentals/retainers; Client-specific rate cards; Anzahlungs-/Teil-/Schlussrechnung workflow; Projects, time tracking, expenses and client statements; No structured e-invoice (ebInterface/Peppol UBL) or PDF/A output

## Open questions (decisions only you can make)

- Are you a Kleinunternehmer (under the €55k threshold) or regular VAT-registered? This decides whether a Kleinunternehmer mode is needed and whether the VAT report matters at all.
- Soll- or Ist-Besteuerung (invoice date vs payment date) for your UVA? The report currently uses invoice date; Bookamat books by payment date.
- Cancellation semantics: when an issued invoice is wrong, do you want a Storno (full cancellation document) or a Gutschrift/Rechnungskorrektur that reduces the balance, and should 'cancelled' auto-create that document?
- Should issued invoices be strictly locked (edits only via credit note), or do you want a short grace period (e.g. until sent via Gmail) where edits are still allowed?
- Is Bookamat staying as the bookkeeping system? If yes, should the app stop pretending to be a UVA tool and only export; if no, do you want expenses/Vorsteuer inside the app?
- Do you need USD/GBP invoicing at all, and if so should rates come from ECB automatically or be entered per invoice?
- Which e-invoicing standard (ebInterface for Austrian public sector, Peppol UBL, ZUGFeRD/Factur-X) do any of your clients require, or can this wait?
- Should the UI be German, English, or switchable? Today it is English with German fragments and html lang='de'.
- Automatic reminders: should the cron send emails at all without review, and after how many days of grace, with what escalation (1./2./3. Mahnung, fees, interest)?
- Is the Supabase project's self-signup disabled, and is there exactly one owner account the RLS policies should be pinned to?
- Should Drive archiving be mandatory on issue (year/type folders) and should the archived PDF be the canonical copy served by the portal?
- Does your business bank account run under your own name or the studio name (for the EPC QR beneficiary / Verification of Payee)?
- Which of the larger features matter most to you: bank import, recurring rental invoices, deposits/final invoices, client rate cards, or projects?

## What exists today (subsystem summaries)

### builder-items

DocumentBuilder.tsx (1522 lines) is a single client component used by the new/detail pages for invoices, quotes and credit notes. It keeps the whole document in React state: header fields (client, dates, language, currency, tax treatment, notes), a document-level discount, and `lines: LineItem[]` where each line has a `line_type` of item|heading|text|separator|subtotal|page_break plus description, service_date, quantity, unit, unit_price, vat_rate, catalogue_item_id and (for subtotal rows) discount_type/discount_value. `blankLine()` creates an item (qty 1, flat, 20%), `blankSpecial()` a non-item row. Totals are recomputed on every render through `calcTotals()` in src/lib/utils/document.ts, which walks the array in order, scales each section's items by the subtotal row's discount, groups VAT by rate, then applies the document discount proportionally and subtracts payments. The description input opens a catalogue popup on focus (filtered by the typed text, with an inline "New catalogue item" form that inserts into catalogue_items). Persistence is "delete all items, re-insert" via `buildItemsPayload()`, done by `save()` (explicit draft/sent), `ensureNumberAndSave()` (silently issues a number + status 'sent' before Download PDF / Drive / Gmail) and a 2 s debounced `autoSave()` that only runs for existing documents. `buildPdfBlob()` renders InvoiceDocument with @react-pdf in the browser (EPC QR only when includeQr and invoice with balance due) and `blobToBase64()` feeds Gmail/Drive/Bookamat. The desktop grid supports HTML5 drag reordering; the mobile layout duplicates all markup as cards.

Works today: Item lines with qty, unit (hour/day/session/flat/piece/month), unit price, VAT 0/10/13/20 and optional per-line service date (popover); Structural lines: heading, note (text), divider, subtotal and page break, rendered in editor and PDF; Per-section discount on subtotal rows (percent or fixed, quick 5-25% chips) that scales the section's items in calcTotals and prints gross/discount/net on the PDF; Document-level discount (percent or fixed) applied proportionally across VAT groups; Catalogue picker on description focus with substring filter in the document language, plus inline creation of a new catalogue item; Client selection applies client defaults (language, currency, tax treatment); client pre-selection via ?client= query; Tax-treatment aware totals (reverse charge / non-EU show no VAT) with editable tax note from Settings; Debounced autosave (2 s) for existing documents with 'Saved HH:MM' indicator; Cmd/Ctrl+S shortcut; Draft save vs 'Mark as sent' with confirmation dialog; number issued atomically via next_document_number RPC; Browser-side PDF generation (preview without QR, final with EPC/SEPA GiroCode), Download via File System Access API with fallback, Save to Drive, Send via Gmail with editable preview, mailto fallback; Desktop drag-and-drop reordering of lines; responsive mobile card layout with collapsible details; Payments from the detail page are reflected as Paid / Balance due in totals

### builder-doc

src/components/forms/DocumentBuilder.tsx (1,522 lines, client component) is the single editor for invoices, quotes and credit notes. The six (app) pages fetch settings, clients, active catalogue and (detail pages) the document with document_items/payments server-side and hand them to the builder; the invoice detail page wraps it in InvoicePageClient to add PaymentPanel and ReminderButton. The builder keeps all header fields (client, date, due date / "valid until", service date, language, currency, tax treatment, notes, internal notes, document discount) and the line list in local React state, applies client defaults on client change (language, currency, tax treatment — not payment terms), and computes totals live with calcTotals (tax-treatment aware since PR #22). Persistence: for a new document save('draft'|'sent') inserts the documents row then document_items; for an existing document a 2-second debounced autosave updates the row, then deletes and re-inserts all items. Numbers are allocated only on issue through the next_document_number RPC (template {prefix}-{YYYY}-{NNN}, counter in settings), either via "Mark as sent" (confirm modal → save('sent')) or implicitly via ensureNumberAndSave() whenever Download PDF, Save to Drive or Send via Gmail is pressed on an unnumbered document; both paths set status to 'sent'. PDFs are rendered in the browser with @react-pdf; the EPC/SEPA QR is added only on final PDFs of EUR invoices with a positive balance. Gmail sending shows an editable To/Subject/Body modal, then POSTs the base64 PDF to /api/gmail/send (optionally also to /api/drive/upload). Status changes beyond draft→sent live in DocumentStatusBar outside the builder.

Works today: Single builder for invoice / quote / credit_note with type-specific labels (typeLabel, PDF title, email defaults); Client dropdown applies client language, currency and tax treatment on selection and on ?client= deep link; Date, due date (quotes: 'Valid until'), optional document service date and per-line service date popover; Language DE/EN, currency EUR/USD/GBP, tax treatment at_vat / eu_reverse_charge / non_eu with configurable tax note preview; Line items with catalogue autocomplete (search, inline 'New catalogue item' creation), units, VAT rate per line, quantity step 0.25; Special lines: heading, note, divider, subtotal (with per-section % or fixed discount), page break; desktop drag-and-drop reordering; Document-level discount (% with quick chips, or fixed) reflected in VAT groups and total; Live totals panel: net, discount, VAT groups (hidden for reverse charge / non-EU), total, paid, balance due; Draft save, 'Mark as sent' with confirmation modal, atomic number assignment via next_document_number RPC with format tokens; 2 s debounced autosave for existing documents with 'Saved HH:MM' indicator; Cmd/Ctrl+S shortcut; Preview PDF (no QR, 'DRAFT' number), Download PDF (issues number, adds EPC QR, uses File System Access API when available); Save to Drive (updates existing Drive file in place via drive_file_id); Send via Gmail with editable preview modal, RFC 2047 subject, PDF attachment, optional Drive upload; mailto fallback when Gmail not connected; Email subject/body templates per type and language with {{invoice_number}} {{client}} {{total}} {{due_date}} … placeholders; buildPdfBlob exposed via ref so PaymentPanel (Bookamat) and ReminderButton can attach the PDF; Mobile card layout for line items, collapsible language/currency/tax section, sticky action bar

### pdf

All PDFs come from one @react-pdf/renderer component, src/components/pdf/InvoiceDocument.tsx. It draws an A4 page with the built-in Helvetica font (no Font.register anywhere): logo or company-name fallback top-left, document title + number/date/service-date top-right, a "Billed to" block (client UID if present), a four-column table (description/qty/rate/amount) that understands line types item/heading/text/separator/subtotal (with per-section discount rows)/page_break, then a wrap={false} block with due date, subtotal, document discount, per-rate "USt." rows (only for at_vat), total, an "Offen/Balance due" row when payments exist, and an optional EPC (GiroCode) QR. Below that: tax note (from getTaxNote, settings-overridable), free notes, and a per-type footer text with {{variables}}. A fixed footer prints contact + bank details and "page / total". Money is always formatted de-AT; dates via formatDate(lang). Four callers assemble the same docData shape independently: (1) DocumentBuilder (client, pdf().toBlob()) for Preview (no QR), Download/Save-to-Drive/Gmail (QR, after ensureNumberAndSave issues a number and sets status 'sent'); (2) portal/[token]/pdf (service role, renderToBuffer, any status); (3) api/documents/[id]/drive-pdf (auth'd, renderToBuffer, updates existing Drive file in place); (4) cron/reminders (pdf().toBuffer() stream, no payments, no QR). QR generation (epc-qr.ts) builds a BCD/002/SCT payload with IBAN, BIC, company name, EUR amount only for EUR docs, invoice number as unstructured reference, rendered via qrcode to a PNG data URI. Totals come from calcTotals (already tax-treatment aware). The main weaknesses: items are fetched without ordering on every server path, legally required content (supplier UID, net per VAT rate, service period, credit-note reference) is missing, non-WinAnsi characters (including the "−" sign used for discounts) silently vanish, and exporting a PDF irreversibly issues a number before the user confirms.

Works today: A4 layout with logo (or bold company-name fallback), document title per type/language, number, date, optional service date (src/components/pdf/InvoiceDocument.tsx:166-182); Billed-to block with company/name/address/country and client UID when present (InvoiceDocument.tsx:184-195); Line types rendered: item rows with per-line service date, headings, free text, separators, section subtotals with strike-through gross + discount + net rows, and forced page breaks (InvoiceDocument.tsx:205-272); Totals block kept on one page via wrap={false}: subtotal, document discount (with % shown), per-rate VAT rows only when tax_treatment is at_vat, total, balance due when payments exist (InvoiceDocument.tsx:274-322); Tax note for reverse charge / non-EU taken from Settings overrides with German/English defaults (src/lib/utils/document.ts:86-98); Per-type, per-language footer text with {{invoice_number}}, {{date}}, {{due_date}}, {{client}}, {{subtotal}}, {{vat}}, {{total}}, {{balance_due}} substitution (InvoiceDocument.tsx:144-160); Fixed footer on every page with contact details, bank details and 'page / total' counter (InvoiceDocument.tsx:329-348); EPC/GiroCode QR (BCD 002, UTF-8, SCT) with IBAN/BIC/name, EUR amount pre-filled only for EUR documents, invoice number as reference; shown on invoices with balance due > 0 (src/lib/utils/epc-qr.ts:13-73); Client-side generation for Preview, Download (File System Access API with fallback), Save to Drive and Gmail attachment (src/components/forms/DocumentBuilder.tsx:320-498, 548-567); Server-side renderToBuffer for the public portal download and for re-uploading to Google Drive, updating the existing Drive file in place when found (src/app/portal/[token]/pdf/route.ts, src/app/api/documents/[id]/drive-pdf/route.ts); Cron reminders render and attach the invoice PDF server-side, falling back to sending without attachment on render failure (src/app/api/cron/reminders/route.ts:80-131); German umlauts, ß, €, £, $ render correctly with the built-in Helvetica (WinAnsi); italic tax note resolves to Helvetica-Oblique via react-pdf's standard-font mapping; Austrian date format (dd.mm.yyyy) for German and dd/mm/yyyy for English documents (document.ts:117-124)

### lists

Four server pages under src/app/(app)/{invoices,quotes,credit-notes,clients}/page.tsx each fetch the full table through the cookie-based Supabase client (RLS "authenticated" policy) — documents with `select('*, clients(name, company), document_items(line_type, quantity, unit_price, vat_rate)')` ordered by date, clients with a second query of all invoices to build a client→last-invoice-date map — and hand everything to a 'use client' list component. The four list components are near-identical copies: a local `calcTotal` (quantity×unit_price×(1+vat) with reverse-charge/non-EU zeroing), a `statusColor` map, a `Th`/`SortIcon` header, client-side substring search over number/client/company (clients: name/company/email), a native `<select>` status filter (invoices add an "outstanding" pseudo-status and an "overdue" filter that also includes sent+past-due), in-memory sort on one column, and 25-row client-side pagination with Prev/Next. Invoices, quotes and clients have a separate mobile card layout; credit notes only have a table. Only InvoiceList has selection (per-page select-all, Set of ids), a fixed bottom bulk bar (Mark Sent, Mark Paid, Export CSV, Delete) with a custom confirm modal, and a CSV exporter (comma-delimited, dot decimals, English headers, gross total only). Bulk actions call src/app/api/invoices/bulk/route.ts, which checks `auth.getUser()`, whitelists the status, and runs a single `update`/`delete ... in('id', ids).eq('type','invoice')`, returning `ids.length` as the count; it does not assign numbers, record payments, touch Bookamat/Drive, or guard against deleting issued invoices. Dashboard deep-links `/invoices?status=…` seed the filter via `initialStatus`.

Works today: Server-rendered lists for invoices, quotes, credit notes and clients with client + line-item joins (src/app/(app)/*/page.tsx); Client-side search by number / client name / company (clients: name, company, email); Status filter per list; invoice filter adds 'Outstanding (sent + overdue)' and an overdue filter that also catches sent invoices past due_date (InvoiceList.tsx:94-96); Sortable columns with asc/desc toggle and sort icons; clients sortable by last-invoice date; Client-side pagination (25/page) with Prev/Next and result count; Invoice totals shown with VAT suppressed for reverse-charge / non-EU (calcTotal in each list); Invoice multi-select (row + select-all-on-page), floating bulk bar with Mark Sent / Mark Paid / Export CSV / Delete, custom confirm modal, toasts, router.refresh() after action; CSV export of filtered or selected invoices (InvoiceList.tsx:51-73); Bulk API route with auth check, status whitelist and type guard, RLS enforced through cookie client (api/invoices/bulk/route.ts); Deep link from dashboard via /invoices?status=outstanding|overdue|paid (invoices/page.tsx:4-16); Mobile card layouts for invoices, quotes and clients; overdue rows get a red left border; dark mode styling throughout; Loading skeletons (loading.tsx) and empty states with 'Create your first …' CTA; Clients list shows tax treatment label, tags, status badge and last invoice date

### dashboard-reports

The dashboard (src/app/(app)/dashboard/page.tsx) is a server component that runs three Supabase queries: invoices in status sent/overdue (no date cap), invoices in status paid dated within the last 13 months, and the 5 newest draft/sent quotes. Totals come from the shared calcTotals (document discount, section discounts, tax treatment). It derives "open" (sent, due_date null or >= today) and "overdue" (status overdue, or sent with due_date < today) on the fly, builds four KPI cards (Outstanding, Overdue with oldest-days, Paid this month with month-over-month delta, Revenue YTD), a 12-month SVG bar chart (RevenueChart, client component with hover tooltip) keyed on payment dates, a Recently Paid list, a Pending Quotes list and an overdue alert banner at the bottom linking to /invoices?status=overdue. All KPI money is formatted as EUR via formatMoney(amount) without currency.

The Reports page (src/app/(app)/reports/page.tsx) reads year/quarter from the URL (ReportControls pushes them via router.push), queries invoices in sent/paid/overdue by invoice date within the quarter, and re-implements totals inline as quantity*unit_price per item, grouping by vat_rate for at_vat documents and separately accumulating reverse-charge and non-EU bases; it prints a UVA-style table (KZ 000, per-rate base + VAT, RC/non-EU rows, "Zahllast"), a ZM hint and a net/VAT/gross summary.

src/lib/utils/overdue.ts exports markOverdueInvoices (bulk-updates sent invoices with due_date < today to 'overdue') but nothing in the repo calls it.

POST /quotes/[id]/convert (route.ts) loads any document by id, pulls the next invoice number via the next_document_number RPC, inserts a draft invoice copying client/language/currency/tax_treatment/exchange_rate/notes, copies items (without line_type, service_date or discounts), marks the quote 'accepted' and returns the new id; ConvertToInvoiceButton calls it after a native confirm() and navigates to the invoice.

Works today: Dashboard KPI cards: Outstanding (count + amount, links to /invoices?status=outstanding), Overdue (count, amount, oldest-days, link), Paid this month (count, amount, MoM % delta), Revenue YTD; Open/overdue derived on the fly from status + due_date, consistent with InvoiceList's overdue filter; Totals via shared calcTotals incl. document discount, section discounts and tax_treatment (reverse charge / non-EU not taxed); 12-month SVG revenue bar chart keyed on payment dates, current month highlighted, hover tooltip, dark-mode aware; Recently Paid panel (6 rows: number, client, total, last payment date) and Pending Quotes panel (5 rows) with empty states; Overdue alert banner linking to the overdue invoice filter; Dashboard loading skeleton (loading.tsx); Reports: quarter buttons + year select persisted in the URL; period banner with included-invoice count; Reports: UVA-style breakdown by VAT rate (base + VAT), reverse-charge row with ZM hint, non-EU row, net/VAT/gross summary; drafts and cancelled invoices excluded; Quote→invoice conversion creates a draft invoice with copied header fields, items and converted_from_id, marks the quote accepted, shows toast + redirects; Convert button hidden once a quote is accepted/rejected/cancelled; All routes rely on Supabase RLS (auth.role()='authenticated'); unauthenticated POST to the convert route yields 404

### clients-catalogue

Clients live in a single `clients` table (supabase/schema.sql:44-64) edited through one client component, `ClientForm` (src/components/forms/ClientForm.tsx), which reads raw FormData, requires Name or Company, and inserts/updates/deletes directly from the browser with the anon Supabase client under a role-wide RLS policy (schema.sql:192). `/clients/new` wraps the form; `/clients/[id]` (src/app/(app)/clients/[id]/page.tsx) is a server component that loads the client plus its last 50 documents (invoices, quotes, credit notes with items and payments), computes per-client stats with `calcTotals` (revenue of paid invoices, open balance of sent/overdue invoices, invoice count), renders `ClientEditSection` (view mode with contact/billing facts and an Edit toggle that swaps in `ClientForm`), and lists documents with totals and status badges plus "+ Quote / + Invoice" links that pre-select the client (`?client=`), which the DocumentBuilder uses to apply language, currency and tax treatment. `/clients` lists clients with search, status filter, sortable columns, 25-row pagination and a mobile card layout. The catalogue (src/app/(app)/catalogue/page.tsx → `CatalogueManager`) loads all `catalogue_items` ordered by `sort_order` and manages them fully client-side: items grouped by free-text `category` sections, inline add/edit with DE/EN names, price, unit, VAT rate and section (datalist), duplicate, hide/show (`active`), delete (detaching `document_items.catalogue_item_id` first), HTML5 drag-and-drop reordering persisted with one UPDATE per item, and section create/rename/delete. Inactive items are excluded from the document builder's picker. The most impactful defects found: the catalogue edit form is a component defined inside the parent and remounts on every keystroke (focus jumps), company-only clients cannot be opened from the desktop list, reverse-charge clients can be saved without a UID, issued documents render live client data rather than a snapshot, and `payment_days` never affects due dates.

Works today: Create/edit clients with Name-or-Company either-or validation, two address lines, ZIP/city/country, email/phone, UID, tax treatment (AT VAT / EU reverse charge / non-EU), language DE/EN, currency EUR/USD/GBP, payment days, status (active/inactive/lead), chip-style tag input (Enter/comma adds, Backspace removes), notes (ClientForm.tsx); Delete client with confirmation; FK `on delete restrict` protects clients that have documents (schema.sql:96); Client list with search over name/company/email, status filter, sortable Name/Company/Country/Status/Last-Invoice columns, 25-per-page pagination, mobile card layout and empty states (ClientList.tsx); Client detail header with initials avatar, company/name, status badge; stat cards for total revenue (paid invoices), open balance (sent/overdue) and invoice count, computed with the tax-treatment-aware calcTotals (clients/[id]/page.tsx:51-63); Inline view/edit toggle for client details (ClientEditSection.tsx) with mailto:/tel: links and tags/notes display; Per-client document history across invoices, quotes and credit notes (last 50) with amount, type, date, status and deep links; empty state with 'Create first invoice'; '+ Quote' / '+ Invoice' buttons pre-select the client via ?client= and the DocumentBuilder applies the client's language, currency and tax treatment (DocumentBuilder.tsx:161-171); Loading skeletons for /clients and /clients/[id]; notFound() for unknown ids; server-side auth redirect in the (app) layout; all tables RLS-protected; Catalogue grouped by sections with item count, inline add/edit (Name DE/EN, price, unit, VAT 0/10/13/20, section with datalist suggestions), duplicate, hide/show, delete; Hidden (inactive) catalogue items are excluded from the document builder picker and from the new-document pages' queries (`.eq('active', true)`); Deleting a catalogue item first nulls document_items.catalogue_item_id so historic invoice lines are preserved (CatalogueManager.tsx:62); Drag-and-drop reordering persisted as sort_order; section create (pending until first item), rename (merges on name clash) and delete (moves items to uncategorised); Catalogue items can also be created inline from the DocumentBuilder (DocumentBuilder.tsx:195-214); Dark-mode styling throughout

### settings

The Settings page (src/app/(app)/settings/page.tsx) loads the single `settings` row with `select('*')` and hands the whole object (including Gmail OAuth tokens and the Bookamat API key) to the client component SettingsForm.tsx (1331 lines). The form keeps one useState blob per section (biz, contact, banking, docs, defaults, footer x6, taxNotes, emailTpl x16, integrations) initialised once from props, a `dirty` record keyed by section name, and renders one section at a time via a left nav (desktop) / horizontal pill bar (mobile). Each SectionCard shows a "Save changes" button only while dirty; the save functions call `supabase.from('settings').update({...}).eq('id', settings.id)` directly from the browser (RLS: any authenticated user), converting empty strings to `null`. Numbering writes prefix, format template and the live `next_*_number` counters that the Postgres function `next_document_number()` increments; a client-side `previewFormat` mimics the SQL token replacement. Footer and email-template textareas support `{{var}}` chips: `onFocus` records the DOM element plus a setter closure in a ref, and clicking a chip splices the token into `el.value`. Substitution happens elsewhere (InvoiceDocument.tsx footerVars, DocumentBuilder.buildEmailContent, reminder-templates.fillTemplate). Integrations: Gmail via /api/gmail/auth → callback storing tokens in settings; Drive folder ID parsed from a pasted URL; Bookamat username/API key verified by POST /api/bookamat/accounts, then bank/income/VAT account IDs selected and stored. Logo upload goes to a public Supabase storage bucket `logos` (path `logo.<ext>`, upsert) and the public URL plus cache-buster is stored in `logo_url`.

Works today: Per-section edit/save with dirty-only Save button and saving state (SettingsForm.tsx:78-116, 157-165); Company name / owner name + logo upload (Supabase storage, upsert, cache-busted public URL) and logo removal (498-519); Address/contact fields incl. email, phone, website, two address lines, ZIP, city, country, UID (684-743); Banking: IBAN, BIC, bank name; consumed by PDF footer and EPC/SEPA QR (756-775; InvoiceDocument.tsx:339-342; epc-qr.ts); Numbering per doc type: prefix, format template with tokens {prefix}{YYYY}{YY}{MM}{NNNN}{NNN}{NN}{N}, next counter, live preview (789-828, 549-564) backed by atomic SQL next_document_number(); Defaults: payment days and document language, used by DocumentBuilder (842-861; DocumentBuilder.tsx:84-85); PDF footer text per doc type and language with {{invoice_number}} {{date}} {{due_date}} {{client}} {{subtotal}} {{vat}} {{total}} {{balance_due}} substitution (875-958; InvoiceDocument.tsx:144-160); Editable tax-note texts for reverse charge / non-EU in DE and EN with built-in fallback (961-1020; document.ts:86-98); Email subject/body templates per doc type (invoice/quote/credit note/reminder) and language with variable chips and cursor insertion (1025-1115); Reminder templates fall back to built-in DE/EN defaults shown as placeholders (1090-1111; reminder-templates.ts); Gmail connect/disconnect with OAuth (gmail.send + drive scopes) and toast feedback from ?gmail= query param (289-294, 1126-1153); Google Drive folder configuration from pasted URL or ID with display name (448-461, 1156-1212); Bookamat credentials check + loading of bank/cost/VAT accounts from the Bookamat API and mapping of 0/10/13/20 % VAT accounts (463-496, 1215-1325); Dark mode styling and mobile nav pill bar (593-611)

### google

The Google integration is a single-account OAuth connection stored on the one `settings` row. `GET /api/gmail/auth` redirects to Google with scopes gmail.send, userinfo.email and full `drive` (access_type offline, prompt consent). `GET /api/gmail/callback` exchanges the code, fetches the user's email and writes `gmail_email`, `gmail_access_token`, `gmail_refresh_token`, `gmail_token_expiry` into `settings`, then redirects to `/settings?gmail=connected|error`. Every consumer (gmail/send, drive/upload, documents/[id]/drive-pdf, invoices/[id]/reminder, cron/reminders) rebuilds an OAuth2 client from those columns and registers an `on('tokens')` handler that writes refreshed tokens back. Gmail sending: the browser renders the PDF with @react-pdf, base64-encodes it, shows a "Review email" modal (To/Subject/Body editable, optional "Also save to Google Drive" checkbox) and POSTs to `/api/gmail/send`, where `buildMime()` hand-assembles a multipart/mixed message (RFC 2047 base64 subject, text/plain UTF-8 body, base64 PDF part) and calls `gmail.users.messages.send`. Drive: `/api/drive/upload` receives a client-rendered PDF, `/api/documents/[id]/drive-pdf` renders the PDF server-side from DB state (used by ShareLinkButton's Copy button). Both verify the stored `documents.drive_file_id` (files.get, not trashed), otherwise search the configured folder by exact filename, adopt a match, then `files.update` in place or `files.create` and persist the id. Settings UI shows Connect/Disconnect, folder URL/ID + display name, and a Drive re-consent hint. The main defects: a document number is issued and status flipped to "sent" before the user confirms the email (duplicates on cancel/retry), no OAuth `state`, name-based Drive dedup that overwrites other documents' archive copies, a scope check that compares the access-token string against the literal "drive", and no error handling/reconnect path when the refresh token is revoked.

Works today: OAuth connect flow with offline access and forced consent, storing Gmail address + tokens in settings (src/app/api/gmail/auth/route.ts, callback/route.ts); Shared OAuth client factory (src/lib/google/client.ts) and automatic access-token refresh with write-back via oauth2.on('tokens') in all five consumers; Gmail send with PDF attachment, UTF-8 body, RFC 2047-encoded subject; editable To/Subject/Body review modal with per-type DE/EN templates and {{variables}} (DocumentBuilder.tsx:500-596, reminder.ts:buildMime); Manual and cron payment reminders reuse the same MIME builder via sendReminderEmail (reminder.ts:50-86); Drive upload from the builder (client-rendered PDF) and from the share modal (server-rendered PDF) into a configured folder, with in-place update of an existing file so Drive Desktop sync keeps one file (drive/upload/route.ts, drive-pdf/route.ts); Stale-file recovery: trashed/deleted Drive ids are detected and a same-name file in the folder is adopted and persisted as drive_file_id; Drive checkbox in both the Gmail review modal and the share-link modal, defaulting to on when a folder is configured; Settings: Connect/Disconnect Gmail, folder URL-or-ID parsing (regex extracts the id), optional display name, success/error toast from ?gmail= query param; Buttons degrade gracefully: without Gmail the builder falls back to a mailto: link + PDF download

### bookamat

The Bookamat integration consists of three authenticated App-Router route handlers plus UI in SettingsForm and PaymentPanel. Settings (src/components/forms/SettingsForm.tsx:1214-1325) collects a Bookamat username and API key, calls POST /api/bookamat/accounts, which fetches the bank, cost and purchase-tax account lists for the current calendar year (src/app/api/bookamat/accounts/route.ts:21-29), and lets the user map one bank account, one income account and one tax account per Austrian VAT rate (0/10/13/20). The mapping is stored in nine settings.bookamat_* columns added by BOOKAMAT_MIGRATION.sql. On the invoice detail page, PaymentPanel shows a "Sync to Bookamat →" link whenever credentials and a bank account exist and the document has no bookamat_booking_id; when a payment brings the invoice to fully paid it opens a confirmation modal. Sync first renders the PDF client-side from the live editor state (src/components/layout/InvoicePageClient.tsx:36-46 → DocumentBuilder.buildPdfBlob), then POSTs /api/bookamat/sync. That route recomputes totals via calcTotals (including tax_treatment), groups gross amounts per VAT rate, uses the latest payment date as booking date and fiscal year, sets date_invoice, vatin (client UID), a title "<number> – <client>" and an English description, and posts one booking to https://www.bookamat.com/api/v1/{country}/{year}/bookings/. The returned id is written to documents.bookamat_booking_id and echoed with country/year so the client can call /api/bookamat/attach-pdf, which uploads the base64 PDF to /bookings/attachments/. "Reset sync" only nulls the stored id. The sync route performs no document type, status or currency checks, creates a single booking regardless of how many payments exist, has no credit-note path, and the migration file lives outside supabase/migrations.

Works today: Settings: enter Bookamat username + API key (password field), load bank / income / purchase-tax account lists from Bookamat and map 0/10/13/20 % VAT rates to tax accounts; 'Change' re-opens the form for saved credentials (SettingsForm.tsx:1214-1325); All three API routes require a Supabase session (sync:7-8, attach-pdf:7-8, accounts:6-7); API key is read server-side from settings, never from the request; Sync builds one Bookamat booking per invoice with amounts grouped by VAT rate, gross amount + tax_percent, 100 % deductibility, date = latest payment date, date_invoice = invoice date, vatin = client UID, truncated title/description (sync/route.ts:58-109); Fiscal-year URL derived from payment date, not invoice date (sync/route.ts:73-75); Reverse-charge / non-EU documents land in the 0 % group because calcTotals now honours tax_treatment (document.ts:19,45) and the sync passes doc.tax_treatment (sync/route.ts:52); Already-synced guard (409 with existing bookingId) and persisted bookamat_booking_id (sync/route.ts:44-46,128-131); PDF is generated before the sync request (avoiding re-render killing the react-pdf worker) and attached via /bookings/attachments/ as base64 JSON; attachment failure degrades to a warning toast while the booking stays recorded (PaymentPanel.tsx:107-159, attach-pdf/route.ts:26-54); Auto-prompt to sync when a payment completes the invoice, plus manual 'Sync to Bookamat →' and 'Reset sync' controls with a 'Synced' badge (PaymentPanel.tsx:64-70, 233-259); Accounts route tolerates several response shapes (array, {objects}, {results}, {data}) and id/title field names (accounts/route.ts:44-68)

### portal

The portal lets the owner hand a client an unauthenticated link to one document. On the authenticated side, `ShareLinkButton` (rendered on invoice/quote/credit-note detail pages) calls `POST /api/documents/[id]/share`, which reads `documents.share_token` through the cookie-based anon client (RLS "authenticated only") and, if empty, stores a `crypto.randomUUID()`; `DELETE` nulls it. The button shows a modal with the URL (`window.location.origin + /portal/<token>`), copy-to-clipboard (optionally also uploading the PDF to Google Drive) and "Revoke link". The DB side is a single migration: `share_token uuid unique`.

The public side runs with the service-role client (bypasses RLS). `src/app/portal/[token]/page.tsx` looks the document up by token (`.single()` → `notFound()`), loads `settings` with `select('*')`, computes totals with `calcTotals(items, payments, discount, tax_treatment)` and renders a server component: issuer header/logo, client block with UID, dates in dd.mm.yyyy / dd/mm/yyyy, line items incl. heading/text/separator/section-subtotal rows with section discounts, totals (document discount, VAT groups only when `at_vat`, paid/balance), notes, IBAN/BIC box for sent/overdue invoices, a PDF link and – for quotes in status `sent` – `QuoteActions` (client component). `portal/layout.tsx` wraps everything in a light-coloured div. `/portal/[token]/pdf` re-runs the same lookup, builds an EPC QR for EUR invoices with a balance and streams `InvoiceDocument` via `renderToBuffer` as an attachment. `POST /api/portal/[token]/respond` validates `action ∈ {accepted, rejected}`, requires `type === 'quote' && status === 'sent'` and writes the new status.

Token entropy and route gating are sound; the main defects are unordered line items (wrong order/section totals), a client-accepted quote losing its "Convert to invoice" button, the items table being clipped on phones, overdue state never being derived, and missing legally relevant content (issuer UID, tax note) on the client-facing views.

Works today: Share token generation with crypto.randomUUID() (122-bit, unguessable), stored in documents.share_token (unique); existing token is reused, DELETE revokes it (src/app/api/documents/[id]/share/route.ts); Share routes are protected by RLS policies `auth.role() = 'authenticated'` (supabase/schema.sql) so anonymous callers get 404/no-op; ShareLinkButton modal: copy link, optional 'Also save to Google Drive', revoke, blue icon state when a link is active; sonner toasts for success/failure; Public page /portal/[token] renders server-side with the service-role client; invalid/revoked token → notFound(); Bilingual (de/en) labels driven by document.language; document type title, status badge, Austrian date format via formatDate; Issuer header (logo or company name, address, email) and client block incl. company/name/address/UID; Line items incl. heading/text/separator/subtotal rows, section discounts (percent/fixed) with strike-through gross and net; Totals: subtotal, document-level discount, VAT groups only when tax_treatment = at_vat (reverse charge / non-EU show no VAT), total, paid and balance due; Notes block and payment info (company, bank, IBAN, BIC, document number) shown only for sent/overdue invoices; PDF download at /portal/[token]/pdf renders the same InvoiceDocument with EPC/SEPA QR (EUR, balance > 0) and Content-Disposition: attachment; Quote accept/decline buttons for quotes in status 'sent'; POST /api/portal/[token]/respond validates action/type/status and updates the quote status; UI shows accepted/declined confirmation; Forced light colour scheme wrapper for the client-facing portal

### payments-status

The subsystem moves an invoice from 'sent' to 'paid' and hosts the side actions on a document page. PaymentPanel (client component, direct Supabase writes through the anon key + RLS) inserts rows into `payments`, sums paid amounts client-side, flips `documents.status` to 'paid' when paid >= total - 0.005 and back to 'sent' when a payment is removed, then offers a Bookamat sync (POST /api/bookamat/sync, then attach-pdf with a client-rendered PDF). DocumentStatusBar is a free-form dropdown that writes any status from a per-type list (invoice: draft/sent/paid/overdue/cancelled; quote: draft/sent/accepted/rejected/cancelled; credit note: draft/sent/cancelled) with a confirm modal only for cancelled/rejected; the invoice list's bulk bar does the same through PATCH /api/invoices/bulk. Reminders: ReminderButton (rendered for sent/overdue invoices when Gmail is connected) renders the PDF client-side and POSTs to /api/invoices/[id]/reminder, which fills DE/EN templates from settings (`fillTemplate`, single-pass token replacement), sends via the Gmail API and stamps `reminder_sent_at`. A Vercel cron (vercel.json, 08:00 UTC daily) calls /api/cron/reminders with the service-role client, selects invoices with status='overdue' and reminder_sent_at IS NULL, renders the PDF server-side with @react-pdf and sends exactly one reminder per invoice. Nothing ever sets status='overdue' automatically: `markOverdueInvoices` in src/lib/utils/overdue.ts has no callers, and the dashboard/list derive "overdue" on the fly from due_date. DeleteDocumentButton deletes the row (items/payments cascade) and, if the deleted number was the latest, offers to roll the settings counter back. DuplicateDocumentButton copies header and items into a new draft. Quote-to-invoice (POST /quotes/[id]/convert) consumes an invoice number immediately, copies header and a reduced item set, and marks the quote accepted; invoice-to-credit-note creates a draft credit note with items and `converted_from_id`.

Works today: Record partial or full payments with date, amount and note; balance and 'Paid in full' indicator; auto-set status 'paid' at full payment and revert to 'sent' when a payment is removed; Bookamat prompt after full payment, sync + PDF attachment, 'Reset sync' to allow re-sync; Per-type status dropdown with colour coding and confirm modal for cancelled/rejected; local state re-synced from server props after router.refresh(); Manual payment reminder via Gmail with client-rendered PDF attachment, DE/EN subject+body templates editable in Settings with a token helper list, last-sent date shown, resend; Daily Vercel cron reminder route protected by CRON_SECRET, service-role client, server-side @react-pdf rendering, Gmail token refresh persisted, per-invoice error collection; Single-pass template substitution that prevents chained token injection via client names; Delete with cascade to items/payments and optional restore of the number counter when the deleted number was the most recent; Duplicate as draft copying header, discounts and all item columns including line_type, service_date and section discounts; Quote to invoice conversion with atomic number via next_document_number RPC and quote marked accepted; Convert button hidden once accepted/rejected/cancelled; Invoice to credit note conversion producing a draft with items, item/document discounts and converted_from_id link; Bulk mark sent/paid/delete and CSV export from the invoice list, with auth-checked API routes; Dashboard and invoice list derive overdue dynamically from status='sent' and due_date < today

### data-security

Persistence is a single Supabase Postgres with six tables (settings singleton, clients, catalogue_items, documents, document_items, payments) defined in supabase/schema.sql plus eight ad-hoc migration files; numbering is done by a plpgsql RPC `next_document_number` that reads and bumps a counter in `settings`. RLS is enabled on every table with one policy each: `auth.role() = 'authenticated'` grants full CRUD to any signed-in Supabase user. Three client variants exist: a browser client (anon key, used directly from many 'use client' components for inserts/updates/deletes), a cookie-based server client (`@supabase/ssr`, used by server components and most API routes) and a service-role client that bypasses RLS, used only by the public portal (page, PDF route, accept/reject route) and the Vercel cron. Page auth is a single `getUser()` check in `(app)/layout.tsx` redirecting to /login; there is no middleware/proxy, so route handlers are gated individually — eight routes call `getUser()`, four rely on RLS alone, and the cron route compares `Authorization` to `Bearer ${CRON_SECRET}`. Google OAuth (gmail.send + drive + userinfo.email) tokens, the Gmail address, Drive folder and the Bookamat username/API key are stored in plaintext columns on `settings`; every document page selects `settings.*` and hands the whole row to client components. The SQL in the repo is badly out of sync with the code: `line_type`, item `service_date`, document-level discounts, all gmail_/drive_ columns and 12 e-mail-template columns are used by code but exist in no SQL file, while `documents.number NOT NULL` and `catalogue_items.unit` check conflict with what the app inserts. Secrets handling is otherwise sane (`.env*` ignored, service key only server-side), but there is no `.env.example`, no CSRF `state` on the OAuth flow, and the overdue-marking helper that the reminder cron depends on is never called.

Works today: RLS enabled on all six tables; anon role has no access to any row; Service-role key only referenced in src/lib/supabase/service.ts and imported solely by server code (portal page/pdf/respond, cron); (app)/layout.tsx gates every app page with server-side supabase.auth.getUser() and redirects to /login; Eight API routes (bookamat/accounts, bookamat/attach-pdf, bookamat/sync, drive/upload, documents/[id]/drive-pdf, gmail/send, gmail/callback, invoices/[id]/reminder, invoices/bulk) check getUser() and return 401; Vercel cron for reminders (vercel.json, daily 08:00) protected by CRON_SECRET bearer check and maxDuration=60; Public client portal via unguessable share_token (crypto.randomUUID, uuid unique column) with revoke (DELETE sets token null); quote accept/reject only allowed while status='sent'; Google OAuth with offline access + prompt=consent; refresh tokens persisted and rotated via on('tokens') handlers in every Google-using route; Atomic-ish numbering RPC with configurable format tokens ({prefix},{YYYY},{YY},{MM},{NNNN}..{N}) and pg_safeupdate-compatible WHERE clause; Bulk status/delete route whitelists allowed statuses and restricts to type='invoice'; Settings secrets (gmail tokens) are cleared on Disconnect; Bookamat key only ever sent server-to-Bookamat; .gitignore excludes .env* and *.pem; no secrets committed in the tree; Catalogue delete nulls catalogue_item_id on document_items first, avoiding FK failures

### shell-ui

The shell is a thin Next.js 16 App Router skeleton. src/app/layout.tsx sets html lang="de", loads Geist via next/font, wraps everything in a next-themes ThemeProvider (attribute="class", defaultTheme="system") and mounts a Sonner Toaster (top-right, richColors). src/app/page.tsx redirects to /dashboard. The (app) route group layout (src/app/(app)/layout.tsx) is an async server component that builds a Supabase server client, calls auth.getUser() and redirects to /login when there is no user; it then renders a desktop Sidebar (hidden <md), a MobileHeader (slim logo bar + fixed bottom tab bar with a "More" bottom sheet), and a <main> that wraps children in PageTransition (a client div keyed on pathname with a 180ms CSS fade). There is no proxy.ts/middleware: auth gating happens only in this layout and session refresh cookies can never be persisted from Server Components (server.ts swallows cookie writes). Theme switching is done in both Sidebar and MobileHeader by comparing useTheme().theme against 'dark'. globals.css imports Tailwind 4 + shadcn tokens (neutral oklch palette, light/dark variables, .dark custom variant) and defines the fade-in keyframe. Shared ui primitives are minimal: base-ui Button/Input/Separator, plain Label/Textarea, an inline SVG Logo, Sonner wrapper. Nine loading.tsx skeletons exist (dashboard, list and detail for invoices/quotes/credit-notes/clients) but none for settings/reports/catalogue and no error/not-found boundaries. PWA support is a manifest.ts (standalone, portrait, dark colours, three icon entries all pointing at the 180px /apple-icon) plus generated icon.tsx/apple-icon.tsx, while a default Vercel favicon.ico still ships. The login page is a client form using signInWithPassword and a hard redirect to /dashboard.

Works today: Server-side auth gate: (app)/layout.tsx calls supabase.auth.getUser() and redirects unauthenticated requests to /login; Email/password login via Supabase with toast error feedback and disabled submit while pending (login/page.tsx); Desktop sidebar with active-route highlighting (pathname.startsWith), theme toggle and sign-out; Mobile bottom tab bar (4 primary tabs) + 'More' bottom sheet for overflow routes, theme toggle and sign-out, with safe-area-inset-bottom padding; System/light/dark theming via next-themes with class strategy, color-scheme sync and transition suppression; Toaster follows theme; Consistent neutral oklch design tokens for light and dark in globals.css; dark-mode color-scheme fix for native date inputs; Subtle page fade-in transition keyed on pathname; Skeleton loading states for dashboard, invoice/quote/credit-note/client lists and detail pages; PWA manifest (standalone, short_name 'Mado') plus generated 32px favicon and 180px Apple touch icon; appleWebApp meta for iOS home-screen install; Shared base-ui Button (variants/sizes), Input and Textarea with 16px font on mobile (prevents iOS zoom), Label, Separator; cn() helper (clsx + tailwind-merge) used across components; Public portal layout forces light scheme independent of the app theme

## Appendix — every claim

Legend: ✓ verified by an independent agent · ○ finder evidence only · ? verification did not run · ✗ rejected. Sorted by category, then severity.

### Bugs (146)

#### ? [critical] Issued (numbered/sent/paid) invoices can be hard-deleted singly or in bulk, cascading items and payments, and the delete offers to roll the number counter back so the number is reused  <sub>bug-p4-11</sub>

`src/components/layout/DeleteDocumentButton.tsx:20` · found by: lens:small-business-tax, lens:e-invoicing-archival, lens:lifecycle-integrity, builder-doc, payments-status, lens:rechnungsmerkmale, lens:ux-flows

DeleteDocumentButton runs a plain DELETE on `documents` for any status after a generic window.confirm, and the bulk DELETE route deletes every invoice in the id list with no number/status guard (the client confirmation only says 'This cannot be undone'); the schema cascades to document_items and payments, so a sent/paid invoice that was already emailed, uploaded to Drive or booked in Bookamat disappears without trace, leaving a number that exists at the client but not in the books. One mis-click on 'select all' on a page of paid invoices wipes seven years of records plus their payments; for a sole trader with no DB backup this is unrecoverable. After deleting a numbered document the button additionally reads the settings counter and, if the deleted sequence equals counter-1, offers to decrement it (parsing the number with a trailing-digits regex that breaks for formats like `{NNN}/{YY}`); the toast for declining says 'Gap left in numbering' as if a gap were the defect. If the PDF was already sent, the next invoice silently receives the same number — a duplicate 'fortlaufende Nummer' is a real §11 Abs 1 Z 3 lit g UStG violation, whereas a documented gap (cancelled invoice) is fine. Worse, the Drive upload route looks up an existing file by name and overwrites it in place, so the new PDF replaces the archived PDF of the deleted invoice. Austrian retention (§ 132 BAO, 7 years) makes this a Betriebsprüfung risk; the correct action for an issued Rechnung is a Storno/credit note, never deletion.

Evidence: src/components/layout/DeleteDocumentButton.tsx:17-20 `if (!confirm('Delete this document? This cannot be undone.')) return ... const { error } = await supabase.from('documents').delete().eq('id', id)` (no status/number guard); :31 `const seqMatch = docNumber.match(/(\d+)$/)`; :34-39 `if (currentCounter !== undefined && seqNum !== null && seqNum === currentCounter - 1) { const restore = confirm(`Re…

Fix: Allow hard delete only when `number IS NULL` (drafts); for issued documents replace the button with 'Cancel (Storno)' which sets status='cancelled', keeps the record and offers to create a credit note. Add `.is('number', null)` (and/or `.eq('status','draft')`) to the bulk delete query, return the count actually deleted, and in the UI disable 'Delete' when any selected row has a number and explain why. Remove the counter-restore branch entirely (numbers are consumed once and never reused) and change the toast copy so a gap caused by a Storno is presented as normal. Back it with an RLS policy or trigger: `create policy ... for delete using (number is null)`.

Merged with: [bug] Deleting an issued invoice is allowed and offers to re-use its number; [bug] Issued (numbered, sent/paid) invoices can be hard-deleted with no status check and their number re-used; [ux] Issued and paid invoices can be deleted; counter 'restore' prompt re-uses a number that may already be with a client

#### ? [critical] RLS grants full access to ANY authenticated Supabase user; nothing binds data to the owner  <sub>bug-p3-32</sub>

`supabase/schema.sql:191` · found by: data-security, clients-catalogue

Every policy is `auth.role() = 'authenticated'`. The app never restricts to a specific uid and the code contains no signup gate; if the Supabase project has email signups enabled (the default), anyone holding the public anon key (shipped in the browser bundle) can call supabase.auth.signUp() and then read/modify all clients, invoices, payments, Google refresh tokens and the Bookamat API key. Cannot be verified from code whether signups are disabled in the dashboard — the schema itself contains no defence.

Evidence: supabase/schema.sql:191 `create policy "owner" on settings        for all using (auth.role() = 'authenticated');` (same for clients/catalogue_items/documents/document_items/payments lines 192-196); src/lib/supabase/client.ts:5-6 `process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!`

Fix: Pin policies to the owner (`using (auth.uid() = '<owner-uuid>')` or an `app_owners(user_id)` table), add `to authenticated`, and disable self-signup in Supabase Auth settings; document this in the schema.

Merged with: [quality] RLS grants every authenticated account full access (not owner-scoped)

#### ? [high] document_items are never ordered by sort_order in any query or consumer; sections, subtotals and PDF line order can scramble after autosave  <sub>bug-p1-1</sub>

`src/app/(app)/invoices/[id]/page.tsx:18` · found by: builder-items, pdf, portal

Every page and server route loads items with the embedded select `document_items(*)` and consumers map the rows in the order received. No query orders the embedded rows by sort_order and no client-side sort exists (`grep -rn sort_order src` finds only writes). PostgREST returns embedded rows in physical/heap order; because the builder deletes and re-inserts all rows on every autosave (DocumentBuilder.tsx:614-615), vacuumed slots are reused and heap order drifts from sort_order. calcTotals, calcSectionSubtotal and InvoiceDocument walk the array sequentially to find section boundaries (heading -> items -> subtotal with discount), so a reordered result moves items between sections: a subtotal row that moves above its items changes which items its discount scales, per-section discounts apply to the wrong lines and the PDF totals change. Affected: invoice/quote/credit-note detail pages (feeding the builder), portal PDF route, drive-pdf route, cron reminders, bookamat.

Evidence: src/app/(app)/invoices/[id]/page.tsx:18 `supabase.from('documents').select('*, document_items(*), payments(*)').eq('id', id).single()` (no `.order('sort_order', { referencedTable: 'document_items' })`); src/components/forms/DocumentBuilder.tsx:93-94 `doc?.items?.length ? doc.items.map(i => ({` (no sort); src/lib/utils/document.ts:53-62 walks `items` sequentially to find section boundaries; src/app…

Fix: Add `.order('sort_order', { referencedTable: 'document_items', ascending: true })` to every documents+document_items select (portal, drive-pdf, cron, invoice/quote/credit-note detail pages), or sort by sort_order in the builder's initial state and in a shared loader before passing items to calcTotals/InvoiceDocument (bookamat too).

Merged with: [bug] Line items rendered in database order, not sort_order (portal page and portal PDF)

#### ? [high] Quote conversion burns a sequential invoice number on a draft, breaking the app's own 'number only when sent' rule and enabling numbering gaps/duplicates  <sub>bug-p1-48</sub>

`src/app/(app)/quotes/[id]/convert/route.ts:16` · found by: dashboard-reports, payments-status, lens:e-invoicing-archival, lens:lifecycle-integrity

The route calls next_document_number and stores the number on a status 'draft' invoice. DocumentBuilder deliberately assigns numbers only when first marking as sent, and ensureNumberAndSave short-circuits on doc.number, so the normal issue path (due date fill, status->sent) is skipped for converted drafts. Deleting the converted draft leaves a gap (DeleteDocumentButton:42 'Gap left in numbering'); the route has no status/converted guard, so a second POST creates another numbered invoice; and a draft that sits for weeks gets an invoice date later than higher numbers (§11 UStG fortlaufende Nummerierung).

Evidence: src/app/(app)/quotes/[id]/convert/route.ts:16 `const { data: numData, error: numErr } = await supabase.rpc('next_document_number', { doc_type: 'invoice' })` and :26 `status: 'draft',` ; src/components/forms/DocumentBuilder.tsx:286-288 `// Existing doc: assign number only when first marking as sent` / `if (status === 'sent' && !doc.number) {` ; :359 `if (doc?.number) return { number: doc.number }`

Fix: Insert the converted invoice with number: null (like the credit-note route) and let the builder number it on issue; reject conversion when an invoice with converted_from_id = quote.id exists.

Merged with: [bug] Conversion consumes an invoice number while the invoice is still a draft; [bug] Quote-to-invoice conversion consumes an invoice number for a draft and has no type/status/duplicate guard

#### ? [high] Quote -> invoice conversion drops document discount, section discounts, line_type and service_date, so headings/text/subtotals disappear and the invoice total differs from the accepted quote  <sub>bug-p1-8</sub>

`src/app/(app)/quotes/[id]/convert/route.ts:39` · found by: builder-items, pdf, dashboard-reports, payments-status, data-security, lens:rechnungsmerkmale, lens:lifecycle-integrity, lens:freelancer-workflows, lens:ux-flows

The convert route copies no discount_type/discount_value on the document and the item mapping copies only sort_order/description/quantity/unit/unit_price/vat_rate/catalogue_item_id. Heading/text/separator/subtotal rows (which carry the per-section discount, DocumentBuilder:259-260) are inserted without line_type and without their discount, so they are reloaded as 'item' rows (DocumentBuilder:96 `line_type: (i.line_type ?? 'item')`, quantity defaults to 1) or become phantom rows with null quantity that InvoiceDocument and the portal skip without warning; section discounts vanish (invoice total higher than the quote) and per-line service dates are lost. The sibling credit-note conversion route copies these fields correctly.

Evidence: src/app/(app)/quotes/[id]/convert/route.ts:38-48 `.map((item: { sort_order: number; description: string; quantity: number; unit: string; unit_price: number; vat_rate: number; catalogue_item_id: string | null }) => ({ document_id: invoice.id, sort_order: item.sort_order, description: item.description, quantity: item.quantity, unit: item.unit, unit_price: item.unit_price, vat_rate: item.vat_rate, ca…

Fix: Copy discount_type/discount_value on the document and line_type, service_date, discount_type, discount_value on every item - e.g. `const { id, document_id, ...rest } = item; return { ...rest, document_id: invoice.id }` as convert-to-credit-note/DuplicateDocumentButton do - ideally via one shared `cloneItems()` helper.

Merged with: [bug] Quote → invoice conversion drops the document discount, line_type, item service_date and section discounts; [bug] Quote→invoice conversion drops line_type, service dates and section/document discounts; invoice→credit-note drops per-line service dates; [bug] Quote → invoice conversion drops discounts, section rows and service dates; [quality] Three divergent document/item-cloning code paths copy different column sets

#### ? [high] Accepted quotes cannot be converted from the UI - the portal and the status dropdown set 'accepted', which hides the Convert button  <sub>bug-p1-47</sub>

`src/app/(app)/quotes/[id]/page.tsx:40` · found by: dashboard-reports, portal, payments-status, lens:lifecycle-integrity

The quote page renders ConvertToInvoiceButton only when status is not accepted/rejected/cancelled. The portal accept endpoint and DocumentStatusBar both set status 'accepted'. So the normal flow (client accepts via share link -> owner invoices) requires the owner to first flip the status back to 'sent'.

Evidence: src/app/(app)/quotes/[id]/page.tsx:40 `{!['accepted', 'rejected', 'cancelled'].includes(doc.status) && (` ; src/app/api/portal/[token]/respond/route.ts:26 `.update({ status: action })`

Fix: Show the button for 'accepted' quotes (hide only when an invoice with converted_from_id = quote.id already exists, and show a link to that invoice instead).

Merged with: [bug] Quote accepted by the client via the portal can no longer be converted to an invoice; [bug] Quote accepted through the client portal can no longer be converted to an invoice

#### ? [high] Credit notes never reduce the UVA figures, dashboard revenue or client balances  <sub>bug-p4-7</sub>

`src/app/(app)/reports/page.tsx:20` · found by: lens:small-business-tax, lens:lifecycle-integrity, lens:freelancer-workflows, dashboard-reports, lens:rechnungsmerkmale, clients-catalogue

Credit notes are stored as positive amounts (the convert-to-credit-note route copies quantity/unit_price unchanged, no negation) and every aggregate filters `type = 'invoice'`: the quarterly VAT report, dashboard Outstanding/Revenue, and the client page 'Total revenue'/'Open balance'. Issuing a Gutschrift/Rechnungskorrektur therefore changes nothing financially: the original invoice stays 'sent'/'paid' and fully counted in the VAT base, the client's open balance is not reduced, and the UVA figures (Kennzahl 000, USt per rate) still include the full invoiced amount. Credit notes also have no PaymentPanel/Bookamat path (PaymentPanel is only mounted on invoice pages), so they are never booked. The page literally says 'Copy these figures into FinanzOnline', so after the first credit note the user over-declares revenue and would pay VAT on cancelled or reduced revenue.

Evidence: src/app/(app)/reports/page.tsx:17-24 `.from('documents').select('*, document_items(*)').eq('type', 'invoice').in('status', ['sent', 'paid', 'overdue'])` (grep `credit` in that file → nothing); src/app/api/invoices/[id]/convert-to-credit-note/route.ts:46-48 copies `quantity: item.quantity, unit: item.unit, unit_price: item.unit_price` unchanged; src/app/(app)/dashboard/page.tsx:26-38 both queries `…

Fix: Include `type in ('invoice','credit_note')` with status sent in reports/dashboard/client aggregates and subtract credit-note net/VAT per rate and per tax treatment (sign = -1 for credit_note; show a separate 'Gutschriften' line); show credit notes as negative in client balance; when a credit note is issued for a fully credited invoice, mark the original as cancelled (or 'credited'); add a Bookamat sync (negative booking) and settlement/refund tracking for credit notes.

Merged with: [bug] VAT report ignores credit notes, so issued Gutschriften never reduce the reported turnover/USt; [bug] Credit notes never reduce the corrected invoice or the VAT report; invoice stays fully outstanding; [bug] Client revenue and open balance ignore credit notes; [missing] Credit notes are absent from the VAT report and the dashboard

#### ? [high] UVA report is Soll-based (invoice date, includes unpaid invoices) with no Ist-Besteuerung option, and 'Zahllast' omits Vorsteuer  <sub>bug-p4-22</sub>

`src/app/(app)/reports/page.tsx:21` · found by: lens:dunning-payment-terms, lens:freelancer-workflows, dashboard-reports, lens:small-business-tax, lens:dates-money-i18n

The quarterly VAT report selects sent/paid/overdue invoices by document (issue) date and never looks at payments. Under §17 UStG a solo Austrian freelancer who is an Einnahmen-Ausgaben-Rechner (non-bookkeeping business up to the revenue threshold) is by default an Ist-Versteuerer: USt is owed in the period the payment is received, not when the invoice is issued. For this owner the quarterly figures to copy into FinanzOnline would include VAT on invoices not yet paid and omit VAT on last quarter's invoices paid this quarter. The report also labels the total 'Zahllast USt gesamt' although it is only the Umsatzsteuer side — no Vorsteuer (expenses) exist in the app — so copying these numbers produces a wrong UVA in any quarter with unpaid invoices or input tax.

Evidence: src/app/(app)/reports/page.tsx:17-23 `.select('*, document_items(*)').eq('type', 'invoice').in('status', ['sent', 'paid', 'overdue']).gte('date', qStart).lte('date', qEnd)` — no payments selected; :62 `Copy these figures into FinanzOnline.`; :88 `<span className="font-semibold">Zahllast USt gesamt</span>`; grep 'vorsteuer|expense' in src returns 0 hits.

Fix: Add a Soll/Ist setting (default Ist); in Ist mode select payments(*) and attribute each payment's share (proportional to invoice VAT groups, net of Skonto) to the quarter of the payment date; rename the total to 'Umsatzsteuer (ohne Vorsteuer)' and link to Bookamat for the actual Zahllast.

Merged with: [missing] No cash-basis (Ist-Besteuerung) VAT reporting: the UVA report is always by invoice date while Bookamat books by payment date

#### ? [high] VAT report ignores document-level and section discounts, overstating Bemessungsgrundlage and USt  <sub>bug-p2-1</sub>

`src/app/(app)/reports/page.tsx:36` · found by: dashboard-reports, lens:small-business-tax, lens:dates-money-i18n

The page recomputes net as quantity*unit_price per item and never reads discount_type/discount_value on the document or on subtotal lines (grep 'discount' in reports/page.tsx → no match), whereas the issued PDF/calcTotals scale bases by the discount. The page tells the user to copy these figures into FinanzOnline.

Evidence: src/app/(app)/reports/page.tsx:36 `const net = item.quantity * item.unit_price` ; :43 `vatMap[key].vat += net * ((item.vat_rate ?? 0) / 100)` ; vs src/lib/utils/document.ts:69-74 `if (discount && discount.value > 0 && subtotal > 0) { discount_amount = ...; vat_groups = vat_groups.map(g => ({ rate: g.rate, base: g.base * scale, amount: g.amount * scale }))`

Fix: Select discount_type/discount_value and item line_type/discount_* and aggregate via calcTotals(doc.document_items, [], docDiscount, doc.tax_treatment).vat_groups per document instead of re-implementing the math.

Merged with: [bug] VAT report ignores document-level and section discounts; [bug] VAT report (UVA) ignores document/section discounts and credit notes, overstating the tax base

#### ? [high] Multi-currency is nominal: exchange_rate is always 1, no ECB rates, and USD/GBP amounts flow unconverted into the UVA report, dashboard, client balances and Bookamat  <sub>bug-p4-12</sub>

`src/app/(app)/reports/page.tsx:36` · found by: lens:small-business-tax, lens:e-invoicing-archival, lens:lifecycle-integrity, lens:freelancer-workflows, dashboard-reports, clients-catalogue, data-security, lens:dates-money-i18n, builder-items, builder-doc, pdf, bookamat, lens:rechnungsmerkmale

Clients and documents can be USD or GBP, but every insert hard-codes `exchange_rate: 1`, the field is never editable or read (grep -rn exchange_rate src → only the two inserts and the two convert copies), and no rate is fetched (grep 'ecb|frankfurter|exchangerate' in src → 0). All aggregations treat raw amounts as EUR: the VAT report adds foreign-currency line amounts straight into 'Gesamtumsatz netto' and the per-rate bases without looking at doc.currency (grep -n currency in reports/page.tsx → no hits) and formats with the EUR formatter; the dashboard sums across currencies and picks the first document's currency for all KPIs; the Bookamat payload sends the document-currency amount as the booking amount. § 20 Abs 6 UStG requires the EUR equivalent at the official rate as the tax base (and §11 Abs 1 Z 3 UStG requires the VAT amount in EUR on foreign-currency invoices), and the page explicitly tells the user to copy the figures into FinanzOnline. For a Vienna studio billing US/UK artists in their currency the UVA figures and bookkeeping amounts are wrong as soon as one such invoice exists.

Evidence: src/components/forms/DocumentBuilder.tsx:309 `type, number, exchange_rate: 1, ...docFields,` (also :389); src/app/(app)/reports/page.tsx:33-38 `for (const doc of yearDocs) { for (const item of (doc.document_items ?? [])) { ... const net = item.quantity * item.unit_price ... subtotal += net` with :78 `formatMoney(subtotal)` (no currency) and :62 `<p ...>Copy these figures into FinanzOnline.</p>`; s…

Fix: Expose an editable EUR exchange rate on non-EUR documents (prefilled from an ECB/BMF rate, e.g. frankfurter.app, on the invoice date), store it in `exchange_rate` (editable before issue, frozen after), print the EUR VAT equivalent on at_vat non-EUR PDFs, and convert to EUR via exchange_rate in the report, dashboard, client balances and the Bookamat payload; show a warning when a non-EUR document has rate 1, or at minimum exclude non-EUR documents from the UVA report with a visible warning until a rate is set.

Merged with: [bug] Mixed-currency documents are summed 1:1 and labelled as EUR (or an arbitrary currency) on the dashboard, VAT report and client page; exchange_rate is never used; [bug] VAT report sums non-EUR invoices as EUR; exchange_rate column is never populated; [bug] Non-EUR documents are summed as if they were EUR; exchange_rate is hard-coded to 1 and never used; [missing] Foreign-currency documents have no exchange rate (hard-coded 1, no UI), no EUR VAT amount on the PDF, and are summed 1:1 as EUR in reports/dashboard and Bookamat

#### ? [high] UVA 'Kennzahl 000' includes reverse-charge and non-EU turnover  <sub>bug-p4-5</sub>

`src/app/(app)/reports/page.tsx:38` · found by: lens:small-business-tax, dashboard-reports, lens:dates-money-i18n

The report adds every line's net to `subtotal` before branching on tax_treatment, then labels that figure 'Gesamtumsatz netto (Kennzahl 000)'. Reverse-charge services to EU businesses (§ 3a Abs 6 UStG, place of supply abroad) and non-EU services are not steuerbar in Austria and must not be entered in KZ 000; they belong only in the ZM (EU) or nowhere (non-EU). For this studio, every EU-band or US-label invoice inflates the KZ 000 figure the page tells the user to 'copy into FinanzOnline'.

Evidence: src/app/(app)/reports/page.tsx:38 `subtotal += net` (executed for all treatments) and :78 `<Row label="Gesamtumsatz netto (Kennzahl 000)" value={formatMoney(subtotal)} />`; :44-47 only route RC/non-EU to separate counters after the add.

Fix: Only add `net` to the KZ 000 subtotal when `doc.tax_treatment === 'at_vat'`; show RC (KZ 021/ZM) and non-EU bases as separate informational rows outside the KZ 000 total, and show the sum of all three as 'Gesamtumsatz (inkl. nicht steuerbar)' if desired.

Merged with: [bug] KZ 000 includes non-taxable reverse-charge and non-EU turnover; [bug] Report's 'Kennzahl 000' includes non-taxable reverse-charge and non-EU turnover; 'Zahllast' row is only output VAT

#### ? [high] Unpaid, draft or non-invoice documents can be synced as received income dated on the invoice date  <sub>bug-p2-57</sub>

`src/app/api/bookamat/sync/route.ts:71` · found by: bookamat

The manual button appears for any invoice without a booking id, and the route does not check doc.type, doc.status or doc.number. With no payments, paymentDate falls back to doc.date, so an unpaid invoice is booked as income on its issue date — wrong for Austrian cash-basis (Einnahmen-Ausgaben) accounting. A draft is booked with title 'Draft – …' and a 'DRAFT.pdf' attachment (DocumentBuilder.tsx:323).

Evidence: src/components/layout/PaymentPanel.tsx:250-256 button rendered whenever `bookamatConfigured` and `!bookamatId`; src/app/api/bookamat/sync/route.ts:71 `const paymentDate = lastPayment?.date ?? doc.date`; `grep -n "doc.type\|doc.status" src/app/api/bookamat/sync/route.ts` returns nothing

Fix: In the route require doc.type === 'invoice', doc.number, and balance_due <= 0.005 (or status 'paid'); in PaymentPanel render the sync control only when fullyPaid.

Merged with: [ux] Bookamat modal claims 'This invoice is fully paid' even when it is not

#### ✓ [high] Non-EUR invoices are booked as EUR amounts (currency and exchange_rate ignored)  <sub>bug-p2-56</sub>

`src/app/api/bookamat/sync/route.ts:83` · found by: bookamat

The sync route never reads doc.currency or doc.exchange_rate; it posts the raw document totals as Bookamat amounts. Bookamat bookings for an Austrian account are in EUR, so a USD/GBP invoice is booked 1:1 as if it were EUR. The app allows USD/GBP (types/index.ts:2, schema.sql:59) and exchange_rate is always written as 1 (DocumentBuilder.tsx:309,389).

Evidence: src/app/api/bookamat/sync/route.ts:83 `amount: (g.base + g.amount).toFixed(2),` and :102-109 payload has no currency field; `grep -n "currency\|exchange" src/app/api/bookamat/sync/route.ts` returns nothing

Fix: Refuse sync (400 with a clear message) when doc.currency !== 'EUR' unless a real exchange rate is stored; then convert each VAT group with the rate and record the original currency/amount in the description.

Verifier (confirmed, high): src/app/api/bookamat/sync/route.ts:48-53 computes `calcTotals(doc.document_items ?? [], doc.payments ?? [], ..., doc.tax_treatment)` and :77-88 posts `amount: (g.base + g.amount).toFixed(2)` per VAT group; the payload at :102-109 (`title, date, date_invoice, v… — Code behaviour is certain; that Bookamat bookings are EUR-only cannot be verified from the repo but is the normal case for an Austrian account. Since exchange_rate is hard-coded to 1 and never editabl…

#### ✓ [high] No frozen copy of an issued invoice: PDFs are regenerated from live client/settings data and the Drive archive is overwritten in place  <sub>bug-p4-2</sub>

`src/app/api/documents/[id]/drive-pdf/route.ts:20` · found by: lens:rechnungsmerkmale, lens:e-invoicing-archival, lens:lifecycle-integrity, clients-catalogue

Documents store only client_id; every render path (builder PDF, portal page and PDF, Drive re-upload, reminder PDF, Bookamat vatin) joins the current `clients` row and current `settings` (company address, UID, IBAN/BIC, footer, tax-note texts) at render time and recomputes the tax note from current settings. Editing a client's name, address or UID, or changing the studio IBAN/footer/tax notes, therefore silently changes the content of every already issued invoice the next time it is downloaded from the portal, attached to a reminder, attached to Bookamat or re-saved to Drive. The drive-pdf route then calls files.update on the stored drive_file_id, replacing the archived PDF with the regenerated one. There is no persisted PDF anywhere (grep 'storage.from' src → only logo upload) and no snapshot columns. For this user the Drive folder is the only archive and it does not reliably contain what the client received; a valid Austrian invoice must show the recipient's name/address as issued (§11 UStG) and §132 BAO retention / a Betriebsprüfung compare exactly this.

Evidence: src/app/api/documents/[id]/drive-pdf/route.ts:20 `.select('*, document_items(*), payments(*), clients(*)')`, :29 `const client = doc.clients as unknown as Client`, :51 `const taxNote = getTaxNote(doc.tax_treatment ?? 'at_vat', lang, settings as Settings)`, :131-135 `const { data: file } = await drive.files.update({ fileId: activeFileId, media: { mimeType: 'application/pdf', body: stream }, ... })`…

Fix: At issuance (number assignment) store a JSON snapshot on the document (`recipient jsonb`: name, company, address lines, zip, city, country, uid_number; issuer settings: name/address/UID/IBAN/BIC; the resolved tax note), fill it in ensureNumberAndSave/save('sent')/convert, and render PDFs/portal from the snapshot when present. Preferably also render the PDF once server-side at issuance and store the bytes in a private Supabase Storage bucket (`issued-pdfs/{number}.pdf`), serving that stored file for portal download, reminders, Bookamat and Drive instead of regenerating and overwriting.

Merged with: [bug] Documents render live client data; editing a client silently rewrites already issued invoices; [missing] No billing-data snapshot on issued documents (client edits change printed invoices)

Verifier (confirmed, high): Every render path joins live rows: src/app/api/documents/[id]/drive-pdf/route.ts:20 `.select('*, document_items(*), payments(*), clients(*)')`, :29 `const client = doc.clients as unknown as Client`, :51 `const taxNote = getTaxNote(doc.tax_treatment ?? 'at_vat'… — Verified as described. Worth sharpening: the gap is broader than client/settings joins — src/components/forms/DocumentBuilder.tsx:604-628 autosaves line items, dates and amounts of any loaded document…

#### ✓ [high] Drive archive is overwritten by name-based dedup: drafts upload as 'document.pdf', adopted files are never renamed  <sub>bug-p2-49</sub>

`src/app/api/documents/[id]/drive-pdf/route.ts:78` · found by: google

drive-pdf names the file `${doc.number ?? 'document'}.pdf`. ShareLinkButton is rendered for drafts and the share route has no status check, so Copy on a draft uploads 'document.pdf'. Because the draft has no drive_file_id, the route searches the folder for 'document.pdf', adopts whatever is there and overwrites its content; the id is persisted. Later, once the document is numbered, the stored id is 'active' so `files.update` is called with media only – the file keeps the name 'document.pdf' while containing e.g. R-2026-010. The next shared draft adopts 'document.pdf' again and destroys that archive copy. The same name-collision overwrite happens whenever two documents share a filename (e.g. quote and invoice number formats configured without {prefix}).

Evidence: drive-pdf/route.ts:78 `const filename = `${doc.number ?? 'document'}.pdf``; :109-121 `if (!activeFileId && settings.drive_folder_id) { ... q: `name='${safe}' and '${settings.drive_folder_id}' in parents and trashed=false` ... activeFileId = found.files[0].id ... update({ drive_file_id: activeFileId })`; :131-135 `drive.files.update({ fileId: activeFileId, media: {...}, fields: 'id,webViewLink' })`…

Fix: Refuse Drive upload for unnumbered documents (return 400 'Issue a number first') or name them by document id; dedup by `appProperties: { documentId }` (`q: appProperties has { key='documentId' and value='<id>' }`) instead of filename; always pass `requestBody: { name: filename }` on files.update so …

Verifier (confirmed, high): Chain verified step by step. src/app/(app)/invoices/[id]/page.tsx:47 renders `<ShareLinkButton …>` for every status; src/app/api/documents/[id]/share/route.ts:9-27 only reads/sets `share_token` with no status/number check. src/components/layout/ShareLinkButton… — Severity high because the overwrite of an issued invoice's archive PDF is silent and the Drive checkbox defaults on; partial mitigation is Google Drive's revision history (prior content may be recover…

#### ✓ [high] Reminder emails demand the full invoice total, ignoring recorded partial payments ({{balance_due}} == total)  <sub>bug-p4-17</sub>

`src/app/api/invoices/[id]/reminder/route.ts:44` · found by: lens:dunning-payment-terms, lens:freelancer-workflows, google, payments-status

Both the cron and the manual reminder route call calcTotals with an empty payments array and neither selects payments(*), so `amount` is the gross invoice total even when the client has already paid a deposit or part of it. reminder-templates maps {{amount}}, {{total}} and {{balance_due}} all to the same value, while the Settings UI advertises {{balance_due}} as 'Balance due'. The cron's attached PDF is also rendered without payments, so it shows no 'Offen' line. Sending a Zahlungserinnerung for an amount the client has partly paid is embarrassing and legally shaky for a freelancer who depends on repeat clients.

Evidence: src/app/api/invoices/[id]/reminder/route.ts:44 `const totals = calcTotals(invoice.document_items ?? [], [], docDiscount, invoice.tax_treatment)`; :49 `amount: formatMoney(totals.total, ...)`; src/app/api/cron/reminders/route.ts:33 `.select('*, document_items(*), clients(*)')` (no payments), :58 `const emailTotals = calcTotals(invoice.document_items ?? [], [], docDiscount, invoice.tax_treatment)`, …

Fix: Select `payments(*)` in both routes, pass them to calcTotals, set `{{balance_due}}`/`{{amount}}` to totals.balance_due and `{{total}}` to totals.total (keep total as the gross), skip invoices whose balance_due <= 0.005, and pass payments into the cron's PDF render.

Merged with: [bug] Reminder emails state the full invoice total, ignoring payments ({{balance_due}} == {{amount}} == total); [bug] Reminder emails demand the full invoice total, ignoring recorded payments ({{balance_due}} == total)

Verifier (confirmed, high): src/app/api/invoices/[id]/reminder/route.ts:24-28 selects `'*, document_items(*), clients(*)'` (no payments) and :44 `const totals = calcTotals(invoice.document_items ?? [], [], docDiscount, invoice.tax_treatment)`, :49 `amount: formatMoney(totals.total, …)`. … — Verified exactly as claimed. Fix: select `payments(*)` in both routes, pass them to calcTotals, map `{{balance_due}}`/`{{amount}}` to `totals.balance_due`, `{{total}}` to `totals.total`, skip invoices…

#### ✓ [high] Bulk 'Mark Sent' issues invoices without assigning an invoice number  <sub>bug-p1-37</sub>

`src/app/api/invoices/bulk/route.ts:21` · found by: lists

The single-document send path (DocumentBuilder.ensureNumberAndSave) calls `supabase.rpc('next_document_number')` and sets due_date before writing status 'sent'. The bulk route just writes `{ status: body.status }`. Selecting draft invoices (number null) and clicking Mark Sent produces 'sent' invoices with no number and possibly no due_date, i.e. issued documents outside the consecutive numbering required by § 11 UStG; they render as 'Draft' in the list while being status sent, and the overdue/reminder logic treats them as real invoices.

Evidence: src/app/api/invoices/bulk/route.ts:19-23 `.from('documents').update({ status: body.status }).in('id', body.ids).eq('type', 'invoice')` vs src/components/forms/DocumentBuilder.tsx:364 `const { data: numData, error: numErr } = await supabase.rpc('next_document_number', { doc_type: type })` ... :373 `status: 'sent' as const`

Fix: In PATCH, when status === 'sent', reject (or skip) rows whose `number` is null, or assign numbers server-side via next_document_number per row and set due_date from client.payment_days; return the list of skipped ids so the UI can explain.

Verifier (confirmed, high): src/app/api/invoices/bulk/route.ts:14-23 accepts `status` in `['draft','sent','paid','overdue','cancelled']` and runs `.update({ status: body.status }).in('id', body.ids).eq('type', 'invoice')` — no number assignment, no due_date, no draft check. The UI expose… — Verified. Sharpening: the same gap exists in the single-document status dropdown — src/components/layout/DocumentStatusBar.tsx `applyStatus` writes `{ status: newStatus }` directly, so choosing 'sent'…

#### ✓ [high] Catalogue EditForm is defined inside the parent component and remounts on every keystroke (focus jumps to Name DE)  <sub>bug-p2-19</sub>

`src/components/forms/CatalogueManager.tsx:145` · found by: clients-catalogue, lens:ux-mobile, lens:ux-a11y-forms, lists

`EditForm` is declared inside `CatalogueManager`'s function body, so every parent render creates a new component type. React therefore unmounts and remounts the whole form on each `setDraft`/`setAddDraft` call (every keystroke), and the `autoFocus` on the Name (DE) input steals focus each time. Typing more than one character into Name (EN), Default price or Section is impossible. No React Compiler is configured (next.config.ts is empty), so nothing memoises the function.

Evidence: src/components/forms/CatalogueManager.tsx:145 `function EditForm({ d, setD, onSave, onCancel, autoFocusName = true }: {` (inside `export default function CatalogueManager`), rendered at :307 `<EditForm d={draft} setD={setDraft} onSave={saveEdit} onCancel={cancelEdit} />` and :315; :158 `<input autoFocus={autoFocusName} value={d.name_de ?? ''} onChange={e => setD(p => ({ ...p, name_de: e.target.val…

Fix: Hoist `EditForm` to module scope (pass `categories` and the datalist id as props) or inline its JSX; never define components inside another component's render body.

Merged with: [bug] CatalogueManager's EditForm is declared inside the component, so the form remounts on every keystroke and focus jumps to 'Name (DE)'; [quality] Components defined inside component bodies (EditForm, Th) are recreated on every render

Verifier (confirmed, high): src/components/forms/CatalogueManager.tsx:19 `export default function CatalogueManager(...)` and :145 `function EditForm({ d, setD, onSave, onCancel, autoFocusName = true }: {` is declared inside that function body, so each parent render creates a new function… — Verified; this makes the inline edit/add form unusable beyond one character in any field other than Name (DE) (and even that loses the caret on remount). Fix: hoist `EditForm` to module scope and pass…

#### ✓ [high] Saving a new credit note redirects to /invoices/{id}; the credit note is then edited as an invoice and would receive an invoice number  <sub>bug-p1-7</sub>

`src/components/forms/DocumentBuilder.tsx:269` · found by: builder-items, builder-doc, payments-status, lens:ux-flows

`basePath` in save() maps credit_note to 'invoices' (the other four basePath computations correctly use 'credit-notes'). After Save draft / Mark as sent on a new credit note the user lands on the invoice detail page, which does not filter by type and renders InvoicePageClient with `type="invoice"`: the builder now treats the credit note as an invoice, Download PDF / Gmail call next_document_number('invoice'), the PDF is titled 'Rechnung', and PaymentPanel, a 'Convert to credit note' button and a back link to /invoices appear.

Evidence: src/components/forms/DocumentBuilder.tsx:269 `const basePath = type === 'invoice' ? 'invoices' : type === 'quote' ? 'quotes' : 'invoices'` vs :432 `: 'credit-notes'`; src/app/(app)/invoices/[id]/page.tsx:18 `.eq('id', id).single()` (no type check) and src/components/layout/InvoicePageClient.tsx:54-56 `<DocumentBuilder ... type={type}` with `type: 'invoice'`.

Fix: Extract one `pathFor(type)` helper (`{invoice:'invoices', quote:'quotes', credit_note:'credit-notes'}[type]`) and use it in all five places; additionally make each detail page assert `doc.type` and redirect/404 on mismatch.

Merged with: [bug] New credit note saved from /credit-notes/new redirects to the invoice route; [bug] New credit note is routed to the invoice page and handled as an invoice; [quality] basePath computed five times inline, one of them wrong

Verifier (confirmed, high): Exact code at src/components/forms/DocumentBuilder.tsx:269 `const basePath = type === 'invoice' ? 'invoices' : type === 'quote' ? 'quotes' : 'invoices'`, used at :315 `router.push(`/${basePath}/${newDoc.id}`)` for every new-document save (Save draft and the Ma… — Rated high (not critical) because the mis-route itself is deterministic but the wrong-number outcome needs the user to also press 'Mark as sent' on the invoice page (whose dialog says 'issue a new inv…

#### ✓ [high] Download PDF / Save to Drive / Send via Gmail are not disabled while saving and ensureNumberAndSave has no re-entrancy guard - a double click issues two numbers or creates two documents  <sub>bug-p1-6</sub>

`src/components/forms/DocumentBuilder.tsx:359` · found by: builder-items, builder-doc

savePdf, saveToDrive and sendViaGmail each call ensureNumberAndSave(), which decides whether to allocate from the stale `doc.number` prop, never checks the `saving` flag, calls the next_document_number RPC and inserts/updates. None of the triggering buttons (desktop or mobile) is disabled by `saving`, so two quick clicks within the ~1-3 s PDF render window run two RPCs: the counter advances twice; for a new document two documents with consecutive numbers are inserted; for an existing draft the second UPDATE overwrites the number so the first PDF/email carries number N while the DB ends up with N+1 (one number burned).

Evidence: src/components/forms/DocumentBuilder.tsx:358-366 `async function ensureNumberAndSave() { if (doc?.number) return { number: doc.number } ... setSaving(true)` (no `if (saving) return`) ... `const { data: numData } = await supabase.rpc('next_document_number', { doc_type: type })`; :1483 `<Button type="button" variant="outline" size="sm" onClick={savePdf} ...>` (no disabled), :1487 `onClick={saveToDri…

Fix: Guard ensureNumberAndSave with a ref (`if (issuingRef.current) return null; issuingRef.current = true`), cache the allocated number in state (`issuedNumber`) so subsequent calls reuse it, add `disabled={saving || pdfBusy}` to all action-bar buttons, and show a spinner while the PDF renders.

Merged with: [ux] Preview/PDF/Drive/Gmail buttons give no loading or disabled feedback during PDF render

Verifier (confirmed, high): src/components/forms/DocumentBuilder.tsx:358-366 `async function ensureNumberAndSave() { if (doc?.number) return { number: doc.number } ... setSaving(true); const { data: numData, error: numErr } = await supabase.rpc('next_document_number', { doc_type: type })… — Guard with a ref (`issuingRef`), cache the issued number in state so later calls reuse it, and add `disabled={saving || pdfBusy}` to all action-bar buttons.

#### ✓ [high] Download PDF / Save to Drive / Send via Gmail issue the number and set status 'sent' before the user confirms; cancelling the save picker or the Gmail review dialog leaves the document issued (and a new doc stranded on /new)  <sub>bug-p1-11</sub>

`src/components/forms/DocumentBuilder.tsx:552` · found by: builder-items, builder-doc, pdf, google, lens:lifecycle-integrity, lens:ux-flows

savePdf, saveToDrive and sendViaGmail all call ensureNumberAndSave() first, which consumes the next number via RPC and writes status: 'sent'. Only afterwards is the OS save dialog or the editable Gmail preview shown. If the user aborts the save picker (AbortError -> return), clicks Cancel in the email modal, or the send fails, the draft has already been irreversibly numbered and marked sent, nothing was saved or sent, the numbering sequence has a hole and the user has no way to undo. For a brand-new document the row is inserted but the user stays on the /new page (router.push only happens in confirmSendViaGmail), so pressing 'Save draft' or 'Mark as sent' afterwards creates a second document; the `alreadySent: true` constant also makes the draft->requestSent branch dead code. The explicit 'Mark as sent' button, by contrast, shows a confirmation dialog saying this cannot be undone.

Evidence: src/components/forms/DocumentBuilder.tsx:462-466 `async function savePdf() { const saved = await ensureNumberAndSave(); if (!saved) return; const result = await buildPdfBlob(saved.number, true)`; :370-373 `status: 'sent' as const`; :485-487 `catch (e) { if ((e as Error).name === 'AbortError') return }`; :552-553 `const saved = await ensureNumberAndSave() / if (!saved) return` -> :566 `setGmailPrev…

Fix: Separate 'issue' from 'export': when the doc has no number, show the Mark-as-sent confirmation first; for Gmail build the preview from a DRAFT/provisional number placeholder and call ensureNumberAndSave() only inside confirmSendViaGmail right before the POST (then substitute the real number into subject/body/filename, or render the PDF after confirmation with the freshly issued number); keep the modal open with its edits when the send fails; roll back status to draft on cancel. For Download on an already-issued doc, no DB write should happen.

Merged with: [bug] Gmail send issues the number and marks the document 'sent' before the review modal; cancel/failure/double-click produces duplicate numbered documents; [bug] 'Save to Drive' on a draft silently issues a number and flips status to 'sent'; [bug] Download PDF / Save to Drive / Send via Gmail issue a number and mark 'sent' before the action is confirmed or completed; [bug] Download PDF, Save to Drive and Send via Gmail issue the number and set status 'sent' before the action completes or can be cancelled; [ux] Download PDF / Save to Drive / Send via Gmail silently issue a number and mark sent, while 'Mark as sent' confirms

Verifier (confirmed, high): All three export actions issue before any user confirmation: src/components/forms/DocumentBuilder.tsx:423-424 `async function saveToDrive() { const saved = await ensureNumberAndSave()`, :462-463 `async function savePdf() { const saved = await ensureNumberAndSa… — Rated high rather than critical: no amounts/tax are wrong, but it produces phantom 'sent' documents, numbering gaps on every cancel, and stranded duplicate rows for new documents. Separate 'issue' fro…

#### ✓ [high] Issued (sent/paid) invoices remain fully editable and are silently rewritten by the 2-second autosave — no lock, no warning  <sub>bug-p4-24</sub>

`src/components/forms/DocumentBuilder.tsx:604` · found by: lens:e-invoicing-archival, lens:lifecycle-integrity, lens:freelancer-workflows, builder-doc, payments-status, lens:rechnungsmerkmale, lens:ux-flows, builder-items, pdf, data-security

DocumentBuilder renders the identical editable form for every status. Only the 'Mark as sent' button is gated on doc.status === 'draft'; client, date, service date, tax treatment, currency, discount, notes, prices, VAT and every line item stay editable on sent, paid and overdue documents, and the 2-second autosave writes those edits straight to `documents` and deletes/re-inserts all `document_items` with no status check. There is no locked/read-only concept anywhere (grep -rniE 'locked|immutable|readonly|read_only|finali[sz]ed' src supabase returns only an unrelated readOnly input in ShareLinkButton). A numbered invoice that was already emailed, archived to Drive and booked in Bookamat can therefore change amounts, VAT, client or date in the DB; later PDF regenerations (portal, reminder, Drive re-upload which updates the same file in place) then differ from what the client received, and PaymentPanel keeps using the stale server-side `total`. For an Austrian freelancer an issued invoice must be immutable (§11 UStG, §131/132 BAO ordnungsgemäße Aufzeichnungen); corrections belong in a credit note. Every mature tool (sevDesk, lexoffice, FreeFinance) locks finalized invoices; this is the first thing a Betriebsprüfung picks up.

Evidence: src/components/forms/DocumentBuilder.tsx:604-617 `const autoSave = useCallback(async () => { if (!doc || !clientId || saving) return ... await supabase.from('documents').update({ client_id: clientId, date, service_date: ..., tax_treatment: taxTreatment, ... }).eq('id', doc.id) ... await supabase.from('document_items').delete().eq('document_id', doc.id); await supabase.from('document_items').insert…

Fix: Treat `number IS NOT NULL` (or status !== 'draft') as 'issued'/locked: add `readOnly = !!doc && doc.status !== 'draft'`, render DocumentBuilder read-only (disable inputs, skip autosave and Ctrl+S), expose only notes_internal/status/payments, show an 'Issued — create a credit note or duplicate to change' banner, and route corrections through 'Convert to credit note' / a new invoice. Enforce server-side with a BEFORE UPDATE trigger on documents/document_items that raises when an issued document's fields/items/totals change.

Merged with: [bug] Issued (sent/paid) documents remain fully editable and are silently autosaved; [bug] Issued (numbered) invoices remain fully editable with 2-second autosave and can be reverted to 'draft' (no status transition rules); [bug] Issued (sent/paid) invoices stay fully editable and are silently autosaved; [missing] Issued documents are not immutable: builder autosaves edits to sent/paid invoices, hard delete reuses numbers and cascades payments, every PDF re-renders from live rows (no stored PDF snapshot, no locked_at/issued_at/audit columns)

Verifier (confirmed, high): src/components/forms/DocumentBuilder.tsx:604-618 `const autoSave = useCallback(async () => { if (!doc || !clientId || saving) return ... await supabase.from('documents').update({ client_id: clientId, date, service_date: ..., tax_treatment: taxTreatment, ... })… — Rated high: real silent-rewrite path on issued documents, but it is an absent lock rather than a mis-computation. Suggested fix stands: `readOnly = !!doc && doc.status !== 'draft'` in the builder (dis…

#### ✓ [high] Autosave and save() replace line items with a non-atomic delete + insert, ignore both errors and still show 'Saved'; overlapping writes duplicate or lose items and server renders in the window produce an empty PDF  <sub>bug-p1-2</sub>

`src/components/forms/DocumentBuilder.tsx:614` · found by: builder-items, builder-doc, pdf, data-security, lens:e-invoicing-archival, lens:ux-flows, lens:ux-a11y-forms

Both persistence paths (autoSave at :614-616, save() at :295-297, ensureNumberAndSave at :380-382) delete all document_items and then insert the new payload as two separate requests without a transaction. In autoSave neither the delete nor the insert result is checked and setLastSaved runs regardless. If the insert fails (constraint violation, offline, RLS/session expired, tab closed between the two requests) the document is left with zero items while the UI says 'Saved 14:32'. Overlapping autosaves (the guard checks `saving` but not `autoSaving`; a slow first save still running when the next 2 s timer fires) interleave delete/insert and produce duplicated line items. Autosave also fires on sent/paid invoices (no status guard). Because the portal route (service role), drive-pdf and cron read with their own connections, a request landing between the two statements renders a PDF with no line items and 'Gesamtbetrag EUR 0,00' - the client clicking 'PDF herunterladen' in the portal while the owner has the invoice open is a realistic trigger.

Evidence: src/components/forms/DocumentBuilder.tsx:604-605 `const autoSave = useCallback(async () => { if (!doc || !clientId || saving) return`; :613-617 `if (!error) { await supabase.from('document_items').delete().eq('document_id', doc.id) / await supabase.from('document_items').insert(buildItemsPayload(doc.id)) / setLastSaved(new Date()) }` (no error handling); same pattern at :295-297 and :380-382.

Fix: Move the replace into a single Postgres function (`replace_document_items(doc_id, items jsonb)`) called via rpc so it is transactional, or upsert by stable item ids and delete only the missing ones. Check and surface every error (toast on failure), keep lastSaved untouched on failure, keep a dirty flag, skip/queue when `autoSaving` is already true, stop autosaving issued documents, or render server PDFs from a stored snapshot.

Merged with: [bug] Autosave deletes and re-inserts items non-atomically and races with manual save → duplicated or empty line items; [bug] Line items are replaced with a non-atomic delete+insert on every autosave; a failed insert leaves an issued invoice with no items; [bug] Save and autosave delete all line items before re-inserting, without a transaction, and autosave failures are silent behind a stale 'Saved HH:MM' indicator

Verifier (confirmed, high): Non-atomic replace in three places: src/components/forms/DocumentBuilder.tsx:614-615 `await supabase.from('document_items').delete().eq('document_id', doc.id); await supabase.from('document_items').insert(buildItemsPayload(doc.id))` inside autoSave, where neit… — Rated high: data-loss path in the hottest loop with no error surfacing. Move the replace into a single Postgres function (`replace_document_items(doc_id, items jsonb)`) or upsert by stable ids, check …

#### ? [high] Money/quantity fields are type="number" + parseFloat||0 with no inputMode="decimal": comma decimals and invalid intermediate input are silently zeroed and iOS shows the wrong keyboard  <sub>bug-p5-19</sub>

`src/components/forms/DocumentBuilder.tsx:1260` · found by: lens:ux-mobile, lens:ux-a11y-forms, builder-items, builder-doc, payments-status, clients-catalogue, shell-ui

All quantity, price, discount, payment-amount and catalogue-price fields are controlled `<input type="number">` whose onChange does `parseFloat(e.target.value) || 0`. A number input only exposes a value that is a valid floating-point number; when the user types `12,50` (the normal Austrian way, and what the iOS keyboard's `,` key produces), `e.target.value` becomes `""`, `parseFloat("")||0` is `0`, and because the input is controlled React writes `0` back into the field. In an English-locale Chrome/Safari the comma keystroke may instead be dropped so `12,50` becomes `1250`. Any transient state such as `.` or `1e` is likewise zeroed, and clearing a field shows `0`. There is no `inputMode="decimal"` anywhere, so iOS shows the full keyboard's number layer instead of the large decimal keypad. Meanwhile every total is rendered with `de-AT` formatting (`€ 1.234,50`), so the UI shows commas as decimals while the inputs may not accept them. For a studio owner entering `450,00`-style day rates and `12,5` hours on the phone, prices silently reset to 0 while typing or end up 100x wrong on an issued invoice without any error.

Evidence: src/components/forms/DocumentBuilder.tsx:1253-1254 `<Input type="number" value={line.quantity} min={0} step={0.25} onChange={e => updateLine(line.id, { quantity: parseFloat(e.target.value) || 0 })}`; :1260-1261 `<Input type="number" value={line.unit_price} min={0} step={0.01} onChange={e => updateLine(line.id, { unit_price: parseFloat(e.target.value) || 0 })}`; same pattern at :887-888, :974, :100…

Fix: Use `type="text" inputMode="decimal"` (and `inputMode="numeric"` for integers), keep the raw string in state while editing, and parse on blur/commit with a comma-tolerant parser (`value.replace(/\s/g,'').replace(',', '.')`); mark unparsable input with `aria-invalid` instead of coercing to 0; format the committed value back with de-AT separators on blur.

Merged with: [ux] Numeric fields (qty, price, discount, payment amount, catalogue price) use type=number + parseFloat||0: reject comma decimals, snap to 0, restrictive step; [missing] No numeric input that accepts Austrian comma decimals

#### ? [high] Saving empty optional-looking fields violates NOT NULL constraints and fails with a raw Postgres error  <sub>bug-p2-33</sub>

`src/components/forms/SettingsForm.tsx:301` · found by: settings, data-security

The Company, Address and Banking save handlers convert empty strings to null, but schema.sql declares company_name, owner_name, address_line1, zip, city, country, email, uid_number, iban and bic as `text not null default ''`. Any save with one of these left blank is rejected by Postgres (23502) and the user sees the raw error message. A fresh installation cannot save the Company card unless both names are filled; a freelancer without a UID cannot save the Address card; clearing the BIC breaks the Banking card.

Evidence: SettingsForm.tsx:301-302 `company_name: biz.company_name || null,\n      owner_name:   biz.owner_name   || null,`; SettingsForm.tsx:322 `uid_number:    contact.uid_number    || null,`; SettingsForm.tsx:335 `bic:       banking.bic       || null,`; schema.sql:10 `owner_name            text not null default '',`; schema.sql:19 `uid_number            text not null default '',`; schema.sql:21 `bic     …

Fix: Either save '' for NOT NULL columns (drop the `|| null` for those keys) or add a migration making the genuinely optional columns (owner_name, uid_number, bic, phone-like fields) nullable; map constraint errors to a friendly message.

Merged with: [bug] Settings form writes NULL into NOT NULL text columns when a field is cleared

#### ? [high] Variable chip insertion writes into the wrong template after switching doc-type/language tab (silent overwrite)  <sub>bug-p2-34</sub>

`src/components/forms/SettingsForm.tsx:538` · found by: settings

onFocus stores the DOM element and a setter closure that captures `activeDocTab`/`subjectKey` at focus time. The subject input and body textarea are the same DOM nodes for every tab, so after the user focuses e.g. the Invoice subject, clicks the Quote tab (buttons do not update lastFocused), then clicks a chip, `el.value` is the Quote text but the captured setter targets the Invoice field: the Invoice subject is replaced with Quote-subject + token. The same happens in the PDF footer section (footerDe setter captured, textarea reused by the quote/credit-note branches) and across sections (a detached templates textarea still in lastFocused when a footer chip is clicked). The hint text tells the user to focus then click, but tab switching in between is natural.

Evidence: SettingsForm.tsx:1089 `onFocus={e => onFieldFocus(e.currentTarget, v => setTplField(activeDocTab, subjectKey, v))}`; SettingsForm.tsx:538-540 `const { el, setter } = target ... setter(el.value.slice(0, start) + token + el.value.slice(end))`; SettingsForm.tsx:896 `onFocus={e => onFieldFocus(e.currentTarget, v => { setFooterDe(v); markDirty('footer') })}`

Fix: Clear `lastFocused` on tab/language/section change (and on blur), key the input elements by `${activeDocTab}-${activeLang}` so they remount, or resolve the target field from current state at insert time instead of a captured closure.

Merged with: [quality] Duplicate variable-insertion functions and copy-pasted footer blocks in SettingsForm

#### ? [high] Status transitions are unconstrained: a numbered, sent or paid invoice can be set back to 'draft'  <sub>bug-p4-25</sub>

`src/components/layout/DocumentStatusBar.tsx:9` · found by: lens:e-invoicing-archival, payments-status

DocumentStatusBar lists 'draft' as a selectable status for invoices and applies any transition with a single UPDATE; the bulk PATCH route likewise allows 'draft'. Deleting a payment flips 'paid' back to 'sent' without confirmation. Because the number is kept, the document then shows the 'Mark as sent' button again and is treated as a draft by the dashboard/reports (reports only include sent/paid/overdue), so an issued invoice can vanish from the UVA figures by a status change. For the Austrian VAT report this means revenue silently drops out of a quarter.

Evidence: src/components/layout/DocumentStatusBar.tsx:9 `const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const` and :67 `await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)`; src/app/api/invoices/bulk/route.ts:14 `const allowedStatuses = ['draft', 'sent', 'paid', 'overdue', 'cancelled']`; src/components/layout/PaymentPanel.tsx:87 `await supabase.from…

Fix: Define a transition table (draft→sent; sent↔overdue; sent/overdue→paid/cancelled; paid→sent only via payment removal with confirm) and hide 'draft' for numbered documents. Enforce in a trigger: `if old.number is not null and new.status = 'draft' then raise`.

Merged with: [quality] Status transitions scattered across six writers with no shared rules

#### ? [high] Status dropdown lets an unnumbered draft be set to sent/paid/overdue, bypassing number assignment  <sub>bug-p1-17</sub>

`src/components/layout/DocumentStatusBar.tsx:67` · found by: builder-doc, lens:ux-flows

DocumentStatusBar (rendered on all three detail pages) writes any status directly. A draft with number NULL can be set to 'sent' or 'paid'; the builder then hides 'Mark as sent' (status !== 'draft') so no number is ever allocated, the PDF prints 'DRAFT', and the invoice appears in outstanding/paid lists without a legal number.

Evidence: src/components/layout/DocumentStatusBar.tsx:67 `const { error } = await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)`; src/components/forms/DocumentBuilder.tsx:1511 `{(!doc || doc.status === 'draft') && (` hides the issue button.

Fix: In DocumentStatusBar, when `doc.number` is null and the target status is not 'draft'/'cancelled', call the issue path (RPC number + status) or block with a toast 'Issue the document first'. Alternatively hide the dropdown for unnumbered drafts.

Merged with: [bug] Status pill and bulk 'Mark Sent' move invoices to 'sent' without assigning a number

#### ? [high] Marking an invoice 'paid' via status dropdown or bulk action records no payment, so revenue KPIs read €0 and the Bookamat booking date is wrong  <sub>bug-p4-18</sub>

`src/components/layout/DocumentStatusBar.tsx:67` · found by: lens:dunning-payment-terms, lens:lifecycle-integrity, lists, payments-status, lens:ux-flows

DocumentStatusBar and the bulk PATCH route just write status='paid'; the only place a payments row is inserted is PaymentPanel.addPayment. Dashboard revenue (this month / this year / 12-month chart) and the client page 'Total revenue' are sums of payment rows, so such invoices are shown as paid but contribute EUR 0, and 'Paid this month' excludes them entirely (it filters by payment date). Bookamat sync dates the booking with `lastPayment?.date ?? doc.date`, i.e. the invoice date when no payment exists; for an Einnahmen-Ausgaben-Rechner the Zufluss date decides the tax year, so a December invoice marked paid in January lands in the wrong year in Bookamat. The reverse is also possible: status can be set back to 'sent' or 'draft' while payments remain. The dashboard KPIs become untrustworthy as soon as the convenient bulk button is used.

Evidence: src/components/layout/DocumentStatusBar.tsx:66-67 `const { error } = await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)` (INVOICE_STATUSES includes 'paid' and 'draft', line 9); src/app/api/invoices/bulk/route.ts:19-23 `.update({ status: body.status }).in('id', body.ids)`; `grep -rn "from('payments')" src` → only src/components/layout/PaymentPanel.tsx:52 (insert) and :8…

Fix: When status changes to 'paid' (dropdown, bulk), open a small dialog for payment date (default today) and insert a payments row for the open balance (and delete/flag payments when leaving 'paid'); refuse Bookamat sync when no payment row exists; alternatively make KPIs fall back to the invoice total when status='paid' and payments are empty.

Merged with: [bug] Bulk 'Mark Paid' sets status without recording a payment, so revenue, balance and Bookamat disagree; [bug] Marking 'paid' via dropdown or bulk leaves no payment record, so balance and revenue stay wrong; [bug] 'paid' set via status pill or bulk action creates no payment, so revenue stats omit it and the Bookamat prompt never fires

#### ? [high] No safe-area-inset-top handling: top bar and toasts sit under the iPhone status bar / Dynamic Island in the installed PWA  <sub>bug-p5-17</sub>

`src/components/layout/MobileHeader.tsx:49` · found by: lens:ux-mobile, shell-ui

The root layout opts into `viewportFit: 'cover'` and `appleWebApp.statusBarStyle: 'black-translucent'`, which makes the web view extend under the iOS status bar when the app is launched from the home screen (manifest `display: 'standalone'`). Nothing in the app compensates: the mobile top bar has only `px-4 py-3`, and the Sonner toaster is `position="top-right"` with no offset. Result in standalone mode: the logo bar is drawn under the clock/battery (and because black-translucent uses white status-bar text, it is white-on-white in light mode), and every success/error toast (the app's only feedback channel for Gmail send, Drive upload, save errors) appears partly under the status bar / Dynamic Island. This matters because the owner uses the app on an iPhone a lot and the manifest is explicitly configured for home-screen install.

Evidence: src/app/layout.tsx:9-11 `export const viewport: Viewport = { viewportFit: 'cover', }`; src/app/layout.tsx:16-20 `appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Mado', }`; src/app/layout.tsx:29 `<Toaster richColors position="top-right" />`; src/components/layout/MobileHeader.tsx:49 `<div className="md:hidden flex items-center px-4 py-3 border-b border-neutral-200 dark:bo…

Fix: Add `style={{ paddingTop: 'env(safe-area-inset-top)' }}` to the mobile top bar (and keep it `sticky top-0` or let content scroll beneath), and give the Toaster a safe offset, e.g. `<Toaster position="top-center" mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 12px)' }} />` (sonner ≥2 supports mobileOffset).

Merged with: [bug] Mobile top bar has no safe-area-inset-top padding although the iOS status bar is translucent and viewport-fit=cover

#### ? [high] Company-only clients (name stored as '') render blank: no clickable link in the client list, ' (Company)' in the builder dropdown and 'Dear ,' in the default email greeting  <sub>bug-p1-20</sub>

`src/components/lists/ClientList.tsx:188` · found by: builder-doc, lists, clients-catalogue

Since the 'Name or Company' change, ClientForm saves `name: nameVal` which is '' when only a company is entered, but every display site still renders c.name. In the desktop client table the only link in the row is `<Link>{c.name}</Link>`; with an empty name the link has no content, so the row shows a blank Name cell with nothing to click, and sorting by name puts these clients first with an empty label; the mobile card renders an empty `<p>` as the primary line. In the builder the client select renders `{c.name}{c.company ? ` (${c.company})` : ''}` -> ' (Acme GmbH)', and the default English email body greets `Dear ${client.name},` -> 'Dear ,'.

Evidence: src/components/lists/ClientList.tsx:188 `<Link href={\`/clients/${c.id}\`} className="font-medium hover:underline">{c.name}</Link>`; :135 `<p className="font-medium text-sm">{c.name}</p>`; src/components/forms/ClientForm.tsx:78-88 `const nameVal = (fd.get('name') as string).trim() ... name: nameVal, company: companyVal || null,`; src/components/forms/DocumentBuilder.tsx:529 `: \`Dear ${client.name…

Fix: Introduce a shared `displayName(c) = c.company && c.name ? `${c.name} (${c.company})` : c.company || c.name` helper; use it as the list link text (with `c.name` as the secondary line when both exist), make the whole row clickable, sort by the display name, use it in the builder select, and greet with `client.name || client.company`.

Merged with: [bug] Company-only clients cannot be opened from the desktop client list (empty link) and sort to the top

#### ? [high] List totals, total-sort and CSV ignore document-level and section discounts  <sub>bug-p1-40</sub>

`src/components/lists/InvoiceList.tsx:36` · found by: lists, lens:small-business-tax, lens:lifecycle-integrity, lens:freelancer-workflows, lens:dates-money-i18n, lens:ux-flows, builder-items, dashboard-reports, data-security

Each list has its own calcTotal that sums quantity x unit_price x VAT and never applies the document discount (documents.discount_type/discount_value, written by DocumentBuilder) nor section discounts stored on subtotal lines (migration 20260603_item_discount.sql). The list pages do not even select the item discount columns. An invoice with 1 000 EUR net, 20 % VAT and a 10 % document discount shows 1 200,00 EUR in the list and CSV while the detail page, PDF and dashboard show 1 080,00 EUR.

Evidence: src/components/lists/InvoiceList.tsx:36-42 `function calcTotal(items: DocItem[], taxTreatment?: string | null) { ... return s + i.quantity * i.unit_price * (vatApplies ? 1 + (i.vat_rate ?? 0) / 100 : 1)`; src/app/(app)/invoices/page.tsx:10 `document_items(line_type, quantity, unit_price, vat_rate)`; src/components/forms/DocumentBuilder.tsx:374 `discount_type: discountType, discount_value: discount…

Fix: Delete the three local calcTotal copies; select `discount_type, discount_value` on documents and items in the list pages and call `calcTotals(items, [], docDiscount, tax_treatment).total` from src/lib/utils/document.ts (same as dashboard). Same fix in QuoteList.tsx:33 and CreditNoteList.tsx:31.

Merged with: [bug] Invoice/quote/credit-note list totals, sorting and CSV export ignore section and document discounts; [bug] Invoice/quote/credit-note list totals and CSV export ignore document and section discounts; [quality] Divergent total calculators: list components' calcTotal and the reports page re-implement totals without discounts instead of using the shared calcTotals

#### ? [high] Credit note PDF is a 'Gutschrift' with 'Rechnungsnummer:' label, no reference to the corrected invoice, positive amounts and a due date  <sub>bug-p3-56</sub>

`src/components/pdf/InvoiceDocument.tsx:142` · found by: lens:rechnungsmerkmale, builder-doc, pdf, lens:small-business-tax, lens:freelancer-workflows, builder-items, dashboard-reports, portal, payments-status, lens:dunning-payment-terms, lens:e-invoicing-archival, lens:lifecycle-integrity, lens:ux-flows

The credit-note PDF title is 'Gutschrift', the number is labelled 'Rechnungsnummer:' (only quotes get a different label), the original invoice number/date are never printed although converted_from_id is stored, amounts are shown as a positive 'Gesamtbetrag', and because the builder defaults a missing due_date to today+payment_days the converted credit note acquires a 'Fälligkeitsdatum' which autosave persists. In Austria a 'Gutschrift' under §11 Abs 8 UStG means self-billing by the recipient; a correction of the studio's own invoice must be a Rechnungskorrektur/Stornorechnung that references the original invoice (number and date) so that the VAT correction under §16 UStG is traceable. The current document can be misread by the client's bookkeeping as a self-billed invoice.

Evidence: src/components/pdf/InvoiceDocument.tsx:63 `credit_note:   { de: 'Gutschrift',           en: 'Credit Note' }`; :142 `const noLabel = doc.type === 'quote' ? L('quote_no', lang) : L('invoice_no', lang)`; :281 `{doc.type === 'quote' ? L('valid_label', lang) : L('due_label', lang)}` (credit notes get 'Fälligkeitsdatum'); `grep -rn converted_from src` → only src/types/index.ts:133 and the two convert ro…

Fix: Rename labels to 'Rechnungskorrektur'/'Stornorechnung' (EN 'Credit Note – Invoice correction'), label the number 'Korrekturnummer:', join converted_from_id and print 'zu Rechnung {number} vom {date}', render amounts negative or label 'Gutschriftsbetrag', and skip due date/payment block/EPC for type=credit_note.

Merged with: [bug] Credit notes get a 14-day due date labelled 'Valid until' and the PDF uses invoice labels ('Rechnungsnummer', 'Faelligkeitsdatum') with no reference to the corrected invoice; [bug] Credit note PDF is titled 'Gutschrift', labelled 'Rechnungsnummer', and never references the original invoice; [missing] converted_from_id is write-only: credit notes never reference the invoice they correct (PDF labels it 'Rechnungsnummer', prints a due date), quotes/invoices are not cross-linked, credit does not reduce the invoice balance, and nothing prevents converting twice

#### ? [high] Issuer's UID-Nummer (settings.uid_number) is never printed on invoice PDFs or the portal  <sub>bug-p4-8</sub>

`src/components/pdf/InvoiceDocument.tsx:338` · found by: lens:small-business-tax, lens:freelancer-workflows, pdf, settings, portal, lens:rechnungsmerkmale, lens:dates-money-i18n, lens:ux-flows, lens:ux-consistency

The PDF footer prints phone, email, address, company name, bank, IBAN and BIC, and the 'Billed to' block prints the client's UID, but the issuer's own UID-Nummer (captured in Settings → Address) is never rendered anywhere on the document or the client portal (grep 'uid_number' in src/components/pdf and src/app/portal returns only client.uid_number). § 11 Abs 1 Z 3 lit i UStG requires the supplier's UID on every invoice above the Kleinbetragsrechnung limit (and both UIDs on reverse-charge invoices), so every invoice this studio issues is formally deficient unless the UID is manually typed into the free-text footer, and the client's Vorsteuerabzug can be challenged.

Evidence: src/components/pdf/InvoiceDocument.tsx:329-344 footer renders `settings.phone, settings.email, ...address`, `settings.company_name`, `settings.bank_name`, `'IBAN: '}{settings.iban}`, `'BIC: '}{settings.bic}`; grep 'uid_number' in InvoiceDocument.tsx matches only :193 `client.uid_number`; src/components/forms/SettingsForm.tsx:738 `<label className={lbl}>UID-Nummer</label>`.

Fix: Render `{L('uid', lang)}: {settings.uid_number}` (and website) in the footer/contact block and in the portal header whenever it is set; warn in Settings if empty and optionally refuse to issue a number when settings.uid_number is empty.

Merged with: [bug] Supplier UID (UID-Nummer) is never printed on any PDF; [missing] Issuer block incomplete on PDF and portal: issuer UID (settings.uid_number), owner name ('Inhaber'), address_line2, country and website are collected in Settings but never printed; company name only when no logo

#### ? [high] No proxy.ts/middleware: refreshed Supabase session cookies are silently dropped in Server Components  <sub>bug-p3-41</sub>

`src/lib/supabase/server.ts:13` · found by: data-security, shell-ui

There is no src/proxy.ts (or middleware.ts) anywhere (`ls src/proxy.ts src/middleware.ts proxy.ts middleware.ts` -> No such file). The only place that touches the session on the server is (app)/layout.tsx:9 `supabase.auth.getUser()`, which runs inside a Server Component. When the access token has expired (1 hour), @supabase/ssr refreshes it (refresh-token rotation) and tries to write the new cookies through setAll; `cookieStore.set()` throws in a Server Component and the catch block swallows it, so the browser keeps the old, now-rotated refresh token. Each request re-refreshes with the old refresh token until Supabase's reuse detection revokes the family and the owner is bounced to /login mid-edit. The bundled @supabase/ssr docs state that if cookies cannot be set from pages or components, middleware must handle session updates or it causes random logouts and difficult-to-debug auth issues; the Supabase SSR guide requires a middleware (`proxy.ts` in Next 16).

Evidence: src/lib/supabase/server.ts:12-17 `setAll(cookiesToSet) { try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } catch {} }`; src/app/(app)/layout.tsx:9 `const { data: { user } } = await supabase.auth.getUser()`; `find . -name middleware.ts -o -name proxy.ts` → nothing

Fix: Add src/proxy.ts that creates a server client with getAll/setAll bound to the request/response cookies, calls auth.getUser() on every non-static request (matcher excluding _next/static, images, /portal, /api/cron), redirects unauthenticated users to /login and returns the response carrying the refreshed cookies, per Supabase's Next.js SSR docs.

#### ? [high] No cent rounding in calcTotals - printed Netto + USt. can differ from Gesamt by a cent, float residue yields 'Offen EUR 0,00' and an EPC QR with EUR0.00, and QR/Bookamat get unrounded amounts  <sub>bug-p1-10</sub>

`src/lib/utils/document.ts:77` · found by: builder-items, builder-doc, pdf, lens:rechnungsmerkmale, lens:dates-money-i18n

subtotal, each VAT group, total and balance_due are carried as raw floats and rounded independently only at display time by Intl.NumberFormat. Example: one line 1.3 h x EUR 7.71 -> net 10.023 (prints 10,02), VAT 20 % 2.0046 (prints 2,00), total 12.0276 (prints 12,03) so the PDF shows 10,02 + 2,00 = 12,03; likewise qty 0.25 x EUR 0,50 at 20 % -> 0,13 + 0,03 != 0,15. balance_due = total - total_paid is compared with > 0 without rounding: a total of 99.99 paid in three 33.33 payments leaves ~1.4e-14, so the PDF prints 'Offen EUR 0,00' and embeds 'EUR0.00' in the EPC QR, which is below the EPC minimum of 0.01 and is rejected by banking apps. The EPC QR uses `toFixed(2)` of the unrounded balance and Bookamat receives the same unrounded floats.

Evidence: src/lib/utils/document.ts:46-49 `subtotal += base / const vatAmt = base * (rate / 100) / ... vatMap.set(rate, { base: ex.base + base, amount: ex.amount + vatAmt })`; :77-78 `const total_vat = vat_groups.reduce((s, g) => s + g.amount, 0)` / `const total = subtotal - discount_amount + total_vat` (no Math.round; `grep -rn "Math.round\|toFixed" src/lib/utils/document.ts` is empty); :81 `balance_due: t…

Fix: Round each line amount and each VAT group amount to 2 decimals (half-up, `Math.round(x * 100) / 100`) inside calcTotals and derive total/balance_due from the rounded parts so printed figures are self-consistent; use the rounded total for the QR and Bookamat and require amount >= 0.01 before emitting the QR / balance row.

Merged with: [bug] Totals are not rounded to cents, so printed net + VAT can differ from the printed total by one cent; [bug] PDF totals do not add up: no rounding step, every figure rounded independently at display time

#### ? [high] Default English non-EU tax note uses reverse-charge wording that contradicts the German 'not taxable' default  <sub>bug-p4-4</sub>

`src/lib/utils/document.ts:95` · found by: lens:rechnungsmerkmale, lens:small-business-tax, lens:freelancer-workflows, pdf, settings

For `non_eu` the German default reads 'Nicht steuerbar (Leistungsort außerhalb der EU)' while the English default (and the Settings placeholder) reads 'Tax liability shifts to the recipient of the services.', which is the reverse-charge statement. An English invoice to a US/UK/Swiss client thus carries a legally different and misleading statement than the German one (there is no EU reverse charge to a third-country recipient; the supply is simply outside Austrian VAT scope). The text is editable in Settings, but the shipped default is incorrect.

Evidence: src/lib/utils/document.ts:92-96 `if (taxTreatment === 'non_eu') { return lang === 'de' ? (settings?.tax_note_non_eu_de || 'Nicht steuerbar (Leistungsort außerhalb der EU)') : (settings?.tax_note_non_eu_en || 'Tax liability shifts to the recipient of the services.') }`; src/components/forms/SettingsForm.tsx:1012 `placeholder="Tax liability shifts to the recipient of the services."`.

Fix: Change the EN default and the matching SettingsForm placeholder to 'Not subject to Austrian VAT – place of supply outside the EU (Sec. 3a Austrian VAT Act / § 3a UStG)'.

Merged with: [bug] Default English non-EU tax note asserts reverse charge, contradicting the German text; [bug] Default English non-EU tax note is the reverse-charge sentence, not a 'not taxable' statement

#### ? [high] markOverdueInvoices is never called: past-due invoices stay badged 'sent', get no red marker, and cron reminders never fire  <sub>bug-p1-44</sub>

`src/lib/utils/overdue.ts:3` · found by: lists, dashboard-reports, payments-status, data-security, lens:dunning-payment-terms, lens:lifecycle-integrity, lens:freelancer-workflows, lens:dates-money-i18n, lens:ux-flows, portal, shell-ui

The helper exists but grep -rn markOverdueInvoices src finds only its definition. Every automatic consumer keys on status === 'overdue': the daily cron (api/cron/reminders) selects .eq('status','overdue'), InvoiceList highlights rows and badges only when doc.status === 'overdue', and the invoice status badge keeps saying 'sent'. The overdue filter and dashboard work around it by also testing due_date < today, but nothing else does: unless the owner changes the status manually an invoice due last month is listed as 'sent' under 'Overdue', gets no red marker, and never receives a reminder.

Evidence: src/lib/utils/overdue.ts:3 `export async function markOverdueInvoices(supabase: SupabaseClient) {` (grep: only definition, no call sites); src/app/api/cron/reminders/route.ts:35 `.eq('status', 'overdue')`; src/components/lists/InvoiceList.tsx:95 `else if (status === 'overdue') list = list.filter(d => d.status === 'overdue' || (d.status === 'sent' && !!d.due_date && d.due_date < today))`; :341 `{do…

Fix: Call markOverdueInvoices(createServiceClient()) at the top of the cron handler (before selecting overdue invoices) and/or in the (app) layout once per request; derive an `effectiveStatus` (sent && due_date < today -> overdue) in one shared helper and use it for badge, marker, filter and sort; or change the cron and list filters to the same `status='sent' AND due_date < today` predicate the dashboard uses.

Merged with: [bug] Cron reminders never fire: nothing sets status='overdue' and the cron only selects that status (markOverdueInvoices is dead code); [bug] Automatic overdue reminders never fire: markOverdueInvoices is dead code and the cron only selects status='overdue'; [bug] markOverdueInvoices is never called, so overdue status is never set automatically and the reminder cron never sends anything; [bug] Overdue invoices are shown as 'Gesendet/Sent' on the portal; [missing] Automatic overdue status transition is not wired up (markOverdueInvoices has no caller); [quality] markOverdueInvoices is dead code while several views depend on status 'overdue'; login page carries a no-op `dynamic` export

#### ? [high] next_document_number has no row lock and the counter is consumed before the document insert/update; failures leave gaps and concurrent calls can return duplicates  <sub>bug-p1-13</sub>

`supabase/migrations/20260528_fix_next_number_where_clause.sql:13` · found by: builder-items, builder-doc, data-security, lens:lifecycle-integrity

The function reads settings, then updates the counter without `for update`; two concurrent calls can both read the same value and return a duplicate number while advancing the counter by two. Client-side, for a new document the RPC increments next_invoice_number first, then the insert runs. If the insert/update fails afterwards (e.g. `date: ''` from a cleared Date field -> invalid input syntax for type date, a null due_date constraint, items insert error, network drop) the number is lost and the error path only toasts. Austrian invoices must be numbered consecutively (§ 11 Abs 1 Z 3 lit d UStG); unexplained gaps are a tax-audit issue.

Evidence: supabase/migrations/20260528_fix_next_number_where_clause.sql:13 `select * into s from settings limit 1;` (no `for update`), :18 `update settings set next_invoice_number = next_invoice_number + 1 where id = s.id;`; src/components/forms/DocumentBuilder.tsx:304-311 `const { data: numData, error: numErr } = await supabase.rpc('next_document_number', { doc_type: type })` ... `const { data: newDoc, err…

Fix: Use `select * into s from settings limit 1 for update;` and issue the number inside the same transaction as the insert/update via one RPC (`issue_document(doc_id)`) that allocates the number, sets status and updates the document; validate all fields client-side before calling the RPC.

Merged with: [bug] next_document_number has no row lock → concurrent calls return the same number and skip the counter; [bug] next_document_number is not atomic: concurrent issuance can return the same number and always burns the counter before the document is written; [bug] Number is consumed before the document row is written; any failure afterwards burns it

#### ? [high] Schema NOT NULL constraints contradict what the app inserts (number, item quantity/unit/unit_price/vat_rate)  <sub>bug-p3-34</sub>

`supabase/schema.sql:95` · found by: data-security, lens:e-invoicing-archival

schema.sql declares documents.number NOT NULL UNIQUE and document_items.quantity/unit/unit_price/vat_rate NOT NULL, but drafts are saved with number null and heading/text/separator/subtotal lines are inserted with those four fields null. On a DB built from the repo SQL 'Save draft' and any heading line fail with not-null violations; the live DB evidently had these constraints dropped by hand, which is untracked.

Evidence: supabase/schema.sql:95 `number            text not null unique,` and :120-123 `quantity numeric(10,4) not null ... unit text not null ... unit_price numeric(10,2) not null ... vat_rate integer not null`; src/components/forms/DocumentBuilder.tsx:302 `let number: string | null = null` → :308-310 `insert({ type, number, ...` and :254-257 `quantity: l.line_type === 'item' ? l.quantity : null, unit: ..…

Fix: Migration: `alter table documents alter column number drop not null; alter table document_items alter column quantity drop not null, ...` plus a partial unique index `unique (number) where number is not null`, and add `line_type` with a check constraint.

Merged with: [bug] supabase/schema.sql has drifted from the production schema, so a restore from the repo produces a database the app cannot run on

#### ? [high] Schema/migrations drift: columns used by code exist in no SQL file  <sub>bug-p3-33</sub>

`supabase/schema.sql:115` · found by: data-security, builder-items, settings, google, bookamat, lens:lifecycle-integrity, lens:ux-flows, builder-doc, clients-catalogue, portal, payments-status, lens:freelancer-workflows

document_items.line_type and document_items.service_date, documents.discount_type/discount_value (the 20260603 migration only alters document_items), settings.gmail_email/gmail_access_token/gmail_refresh_token/gmail_token_expiry/drive_folder_id/drive_folder_name and the 12 email_subject_/email_body_ columns for invoice/quote/credit_note are written by the app but absent from schema.sql, migrations/, add_reminders.sql and BOOKAMAT_MIGRATION.sql. Running the documented setup (schema.sql:2 'Run this in the Supabase SQL editor to initialise') on a fresh project makes the first document save fail with `column "line_type" ... does not exist`, Gmail connect fails, e-mail template save fails. The repo cannot recreate production — no disaster recovery.

Evidence: src/components/forms/DocumentBuilder.tsx:251 `line_type: l.line_type,` / :253 `service_date: ...` / :282 `discount_type: discountType, discount_value: discountValue || null,` (on documents); src/app/api/gmail/callback/route.ts:26-29 `gmail_email: userInfo.email, gmail_access_token: ..., gmail_refresh_token: ..., gmail_token_expiry: ...`; src/components/forms/SettingsForm.tsx:413 `email_subject_inv…

Fix: Write catch-up migrations for every missing column (or dump the live schema with `supabase db dump`), delete the stale schema.sql or regenerate it, and move add_reminders.sql/BOOKAMAT_MIGRATION.sql into supabase/migrations with timestamps.

Merged with: [missing] Repository SQL schema and migrations do not match the database the code relies on: no migrations for line_type/service_date/nullable item columns, nullable documents.number, unit 'session', Gmail/Drive/email-template settings columns, Bookamat columns (root-level file only) or the logos bucket; [quality] Repository schema is stale and scattered; schema.sql plus untracked migrations cannot reproduce the production database

#### ○ [medium] Client stats are computed from only the newest 50 documents  <sub>bug-p2-24</sub>

`src/app/(app)/clients/[id]/page.tsx:48` · found by: clients-catalogue, lens:freelancer-workflows

Total revenue, open balance and invoice count iterate the same query that is capped at 50 rows, so once a client has more than 50 documents older unpaid invoices disappear from Open balance and revenue/count are understated.

Evidence: src/app/(app)/clients/[id]/page.tsx:48 `.limit(50)`; :57-63 `const totalRevenue = allDocs.filter(d => d.type === 'invoice' && d.status === 'paid')...` / `const invoiceCount = allDocs.filter(d => d.type === 'invoice').length`

Fix: Aggregate over all documents (separate unbounded query or a SQL view/RPC) and paginate only the displayed list.

Merged with: [bug] Client page KPIs are computed from only the 50 most recent documents; [ux] Client document history offers no filtering and silently stops at 50

#### ○ [medium] Chart and payment KPIs only see status='paid' invoices dated within 13 months, although they key on payment date  <sub>bug-p2-5</sub>

`src/app/(app)/dashboard/page.tsx:36` · found by: dashboard-reports, lens:small-business-tax, lens:lifecycle-integrity

Payments on partially paid (status 'sent'/'overdue') invoices are excluded entirely; payments on an invoice dated more than 13 months ago (e.g. an old invoice finally paid last month) never appear in the chart, 'Paid this month' or Revenue YTD, and bars change retroactively once an invoice becomes fully paid.

Evidence: src/app/(app)/dashboard/page.tsx:36-37 `.eq('status', 'paid')` / `.gte('date', chartCutoffStr)`

Fix: Query the payments table directly (payments.date >= cutoff, joined to invoice currency/number) for the chart and payment KPIs; keep the documents query only for the Recently Paid list.

Merged with: [bug] Dashboard revenue KPIs load only status='paid' invoices and aggregate per invoice: yearly revenue uses invoice date, 'Paid this month' double-counts instalments, partial payments on open invoices are ignored

#### ○ [medium] Dashboard Outstanding/Overdue amounts use the full invoice total, not the balance due, so partially paid invoices are overstated  <sub>bug-p2-3</sub>

`src/app/(app)/dashboard/page.tsx:57` · found by: dashboard-reports, lens:dunning-payment-terms, lens:dates-money-i18n, lens:ux-flows

getTotal returns .total; PaymentPanel keeps a partially paid invoice at status 'sent' (status flips to 'paid' only when newTotal >= total). An invoice of €10,000 with €9,000 paid shows €10,000 in Outstanding and in the overdue banner.

Evidence: src/app/(app)/dashboard/page.tsx:57 `const getTotal = (doc: typeof active[0]) => docTotals(doc).total` ; :64 `const overdueTotal = overdue.reduce((s, d) => s + getTotal(d), 0)` ; src/components/layout/PaymentPanel.tsx:86-87 `if (newTotal < total - 0.005) { await supabase.from('documents').update({ status: 'sent' })`

Fix: Use docTotals(doc).balance_due for Outstanding/Overdue sums and the banner.

Merged with: [bug] Dashboard Outstanding/Overdue amounts ignore recorded payments (sum total instead of balance_due); [bug] Dashboard KPIs use inconsistent bases: Outstanding/Overdue use invoice total instead of balance_due, revenue mixes invoice date and payment date, and currencies are summed as EUR; [missing] Partial payments are invisible on the dashboard

#### ○ [medium] 'Paid this month' sums the whole lifetime total_paid of any invoice that has a payment this month, inconsistent with the chart  <sub>bug-p2-4</sub>

`src/app/(app)/dashboard/page.tsx:81` · found by: dashboard-reports

paidThisMonth selects invoices with at least one payment dated this month, then revenueThisMonth adds total_paid (all payments ever). The chart bars instead add each payment's amount by payment month. An invoice paid €9,000 in August and €1,000 in October contributes €10,000 to October's KPI but €1,000 to October's bar; the MoM delta is computed from the inflated numbers.

Evidence: src/app/(app)/dashboard/page.tsx:75-77 `const paidThisMonth = paid.filter(i => (i.payments ?? []).some((p: { date: string }) => p.date?.startsWith(thisMonth)))` ; :81 `const revenueThisMonth = paidThisMonth.reduce((s, d) => s + getPaid(d), 0)` ; :106 `if (idx !== undefined) months[idx].revenue += p.amount`

Fix: Compute revenueThisMonth/LastMonth from months[] (sum of payment amounts whose date starts with the month).

#### ○ [medium] 'Revenue {year}' filters by invoice date but sums all payments, and is shown as the headline of the 'last 12 months' chart  <sub>bug-p2-6</sub>

`src/app/(app)/dashboard/page.tsx:86` · found by: dashboard-reports

revenueThisYear includes payments received in other years for invoices dated this year and excludes January payments for December invoices, while the chart next to it uses payment dates over a rolling 12-month window. The number in the chart header therefore does not equal the sum of the bars.

Evidence: src/app/(app)/dashboard/page.tsx:86-88 `const revenueThisYear = paid.filter(i => i.date?.startsWith(thisYear)).reduce((s, doc) => s + getPaid(doc), 0)` ; :213-215 `<span ...>last 12 months</span> ... {formatMoney(revenueThisYear, chartCurrency)}`

Fix: Define revenue by payment date (Istbesteuerung) everywhere; show the 12-month sum in the chart header and the calendar-year sum in the KPI card.

Merged with: [ux] Chart header shows calendar-year total next to 'last 12 months' caption

#### ○ [medium] Detail pages do not check the document type, so /invoices/<quoteId> renders a quote (or credit note) as an invoice  <sub>bug-p1-26</sub>

`src/app/(app)/invoices/[id]/page.tsx:18` · found by: builder-doc

All three [id] pages select by id only. A quote or credit note opened under /invoices gets InvoicePageClient (PaymentPanel, Bookamat, reminder, 'Convert to credit note'), invoice statuses in the status bar and a back link to /invoices; the wrong-type URL is exactly what the credit-note redirect bug produces.

Evidence: src/app/(app)/invoices/[id]/page.tsx:18 `supabase.from('documents').select('*, document_items(*), payments(*)').eq('id', id).single(),` and :24 `if (!doc) notFound()` (no `.eq('type','invoice')`); identical in quotes/[id]/page.tsx:17 and credit-notes/[id]/page.tsx:16.

Fix: Add `.eq('type', 'invoice')` (resp. quote/credit_note) to each query, or redirect to the correct route based on doc.type.

#### ○ [medium] 'Configured' check on the invoice page differs from the sync route's requirement  <sub>bug-p2-65</sub>

`src/app/(app)/invoices/[id]/page.tsx:62` · found by: bookamat, lens:ux-flows

The page shows the sync control when username, key and bank account exist, but the route also demands a cost (income) account, so a user who saved without picking an income account sees the button and always gets a 400 toast.

Evidence: src/app/(app)/invoices/[id]/page.tsx:62 `bookamatConfigured={!!(settings?.bookamat_username && settings?.bookamat_api_key && settings?.bookamat_bank_account_id)}` vs src/app/api/bookamat/sync/route.ts:35-39 `!settings.bookamat_cost_account_id`

Fix: Add a shared isBookamatConfigured(settings) helper used by the page, the route and the settings card.

Merged with: [ux] Bookamat can be saved as 'connected' without accounts; invoice page then silently hides sync

#### ○ [medium] overflow-auto on <main> turns it into the sticky containment scroller, so in-page sticky bars never stick  <sub>bug-p3-48</sub>

`src/app/(app)/layout.tsx:17` · found by: shell-ui, builder-items, builder-doc, lens:ux-mobile

The (app) layout gives <main> `overflow-auto` but no fixed height (wrapper is min-h-screen), so the window scrolls while <main> is nevertheless the nearest scrolling ancestor for every `position: sticky` element inside pages. Sticky elements therefore stick to main's own edges (which move with the page) instead of the viewport. The document editor's action bar (`sticky bottom-0`, intended to float with Save draft / Finalize / Preview / PDF / Gmail buttons) and the Settings section nav (`sticky top-8`) are affected.

Evidence: src/app/(app)/layout.tsx:17 `<main className="flex-1 overflow-auto md:pb-0" style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}>` ; src/components/forms/DocumentBuilder.tsx:1429 `<div className="sticky bottom-0 -mx-6 -mb-6 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-t ...">` ; src/components/forms/SettingsForm.tsx:571 `<nav className="hidden lg:flex flex-col gap-0.5 w…

Fix: Remove `overflow-auto` from <main> (let the document scroll; wide tables should get their own overflow-x wrapper), or make <main> the real scroll container by constraining the shell to h-screen with `overflow-y-auto` on main.

Merged with: [ux] Builder action bar is not actually sticky (main has overflow-auto), would collide with the mobile tab bar, and bleeds beyond p-4 cards

#### ○ [medium] Race between DocumentBuilder autosave and conversion can create an invoice with zero items (and still marks the quote accepted)  <sub>bug-p2-9</sub>

`src/app/(app)/quotes/[id]/convert/route.ts:8` · found by: dashboard-reports

Autosave (2 s debounce) deletes all document_items and re-inserts them in two separate requests. The convert route reads the quote's items with a plain select; if it lands between the delete and the insert it copies an empty list, inserts an invoice without items, and sets the quote to accepted. Edits made less than 2 s before clicking Convert are also missing from the invoice.

Evidence: src/components/forms/DocumentBuilder.tsx:614-615 `await supabase.from('document_items').delete().eq('document_id', doc.id)` / `await supabase.from('document_items').insert(buildItemsPayload(doc.id))` ; :626 `autoSaveTimer.current = setTimeout(autoSave, 2000)` ; src/app/(app)/quotes/[id]/convert/route.ts:8-12 `.from('documents').select('*, document_items(*)').eq('id', id).single()`

Fix: Make the convert button flush pending autosave first (expose a save() via ref or disable while autoSaving), and have the route refuse to convert a quote with zero item lines.

#### ○ [medium] Convert route accepts any document id and any status — invoices/credit notes can be 'converted' and a quote can be converted repeatedly  <sub>bug-p2-11</sub>

`src/app/(app)/quotes/[id]/convert/route.ts:11` · found by: dashboard-reports, payments-status

The select has no type or status filter (the credit-note route has .eq('type','invoice')). Posting /quotes/<invoiceId>/convert creates a new invoice from an existing invoice and flips that invoice's status to 'accepted' (an invalid invoice status); posting twice for the same quote creates two invoices with two burned numbers.

Evidence: src/app/(app)/quotes/[id]/convert/route.ts:8-13 `.from('documents').select('*, document_items(*)').eq('id', id).single()` ; compare src/app/api/invoices/[id]/convert-to-credit-note/route.ts:12 `.eq('type', 'invoice')`

Fix: Add .eq('type','quote'), reject status rejected/cancelled, and reject when an invoice with converted_from_id = id already exists (return its id instead).

Merged with: [bug] Convert route does not verify the source is a quote or that it was not converted already

#### ○ [medium] Converted invoice has no due date, so it can never become overdue unless the user notices  <sub>bug-p2-12</sub>

`src/app/(app)/quotes/[id]/convert/route.ts:25` · found by: dashboard-reports

The route stores due_date null and ignores client.payment_days / settings.default_payment_days. The dashboard treats null due_date as never due ('9999') and markOverdueInvoices excludes nulls. The builder fills a due date only via its own issue path; DocumentStatusBar lets the user set 'sent' directly, leaving due_date null.

Evidence: src/app/(app)/quotes/[id]/convert/route.ts:25 `due_date: null,` ; src/app/(app)/dashboard/page.tsx:60 `const open = active.filter(i => i.status === 'sent' && (i.due_date ?? '9999') >= now)` ; src/lib/utils/overdue.ts:11 `.not('due_date', 'is', null)`

Fix: Look up the client's payment_days (fallback settings.default_payment_days) and set due_date = date + payment_days, as DocumentBuilder:273-274 does.

Merged with: [missing] Converted invoice does not inherit a due date from the client's payment terms

#### ○ [medium] Convert route ignores errors of the item insert and the quote status update — no transaction, partial state on failure  <sub>bug-p2-10</sub>

`src/app/(app)/quotes/[id]/convert/route.ts:38` · found by: dashboard-reports

If the document_items insert fails (e.g. constraint violation) the invoice header still exists with no lines, the quote is still flagged accepted, and the client is redirected to the empty invoice with a success toast. If the status update fails, the quote stays sent while the invoice exists.

Evidence: src/app/(app)/quotes/[id]/convert/route.ts:38 `await supabase.from('document_items').insert(` (result unused) ; :51 `await supabase.from('documents').update({ status: 'accepted' }).eq('id', quote.id)` (result unused)

Fix: Check both errors; on item-insert failure delete the created invoice and return 500; better, move the whole conversion into a plpgsql RPC so it is atomic.

#### ○ [medium] Gmail refresh/access tokens and Bookamat API key are serialized into client components on every settings and document page  <sub>bug-p2-41</sub>

`src/app/(app)/settings/page.tsx:6` · found by: settings, google, data-security, bookamat, portal

Every page that renders DocumentBuilder/SettingsForm (settings page and every invoice/quote/credit-note detail page via `InvoicePageClient` → `DocumentBuilder`) selects `*` from settings and passes the whole object to a client component, so gmail_access_token, gmail_refresh_token and bookamat_api_key are serialised into the RSC payload/HTML and React props. SettingsForm even reads gmail_access_token on the client and renders the Bookamat key into a password input. Any XSS, malicious browser extension or shared screen exposes a long-lived Google refresh token with gmail.send + full drive scope and the Bookamat API key.

Evidence: src/app/(app)/settings/page.tsx:6 `const { data: settings } = await supabase.from('settings').select('*').single()` and :14 `<SettingsForm settings={settings} />`; src/app/(app)/invoices/[id]/page.tsx:19 `supabase.from('settings').select('*').single(),` and :55 `settings={settings!}`; SettingsForm.tsx:1204 `{!settings?.gmail_access_token?.includes('drive') && settings?.gmail_refresh_token && (`; t…

Fix: Select only the columns the UI needs (or strip token/key fields in the server component) and expose booleans like `gmailConnected`, `bookamatConfigured`; keep secrets server-side in API routes, or move tokens/API keys into a separate table without an authenticated-role RLS policy and read it only with the service client in API routes.

Merged with: [bug] Google refresh/access tokens and Bookamat API key are serialized into the browser on every document page; [quality] settings `select('*')` pulls OAuth tokens and API keys into the browser (settings page) and into every unauthenticated portal request; [ux] Bookamat API key pre-filled into the password field and re-displayed on 'Change'

#### ○ [medium] Bookamat attach-pdf / accounts routes crash or build arbitrary upstream URLs from unvalidated body fields  <sub>bug-p3-47</sub>

`src/app/api/bookamat/attach-pdf/route.ts:23` · found by: data-security, bookamat

`country`, `year` and `filename` are interpolated straight from the JSON body; a missing filename throws TypeError (500 via catch), and arbitrary strings become path segments of the Bookamat API call made with the stored API key.

Evidence: src/app/api/bookamat/attach-pdf/route.ts:23 `const baseUrl = `https://www.bookamat.com/api/v1/${country}/${year}/`` and :31 `const safeName = filename.replace(/"/g, '').slice(0, 50)`; src/app/api/bookamat/accounts/route.ts:22

Fix: Validate with zod (already a dependency): country ∈ {'at','de'}, year 4-digit, filename non-empty; read country from settings instead of the body.

Merged with: [quality] Attachment step trusts client-supplied bookingId/country/year and is orchestrated non-atomically from the browser

#### ○ [medium] Partial payments spanning fiscal years collapse into one booking in the last payment's year  <sub>bug-p2-62</sub>

`src/app/api/bookamat/sync/route.ts:69` · found by: bookamat

Only the latest payment date is used and the amount is the full invoice total, not the amounts actually received per date. For cash-basis accounting a 50 % deposit in December and the balance in January must be income in two years; the sync books 100 % in January.

Evidence: src/app/api/bookamat/sync/route.ts:69-71 `const lastPayment = … .sort((a, b) => b.date.localeCompare(a.date))[0]\n  const paymentDate = lastPayment?.date ?? doc.date` and :83 `amount: (g.base + g.amount).toFixed(2)`

Fix: Create one booking per payment, splitting each payment pro rata across the VAT groups, and store the booking ids per payment (or at minimum refuse/warn when payments fall in different years).

#### ○ [medium] Accounts are loaded for the current calendar year but bookings are posted to the payment-date year  <sub>bug-p2-60</sub>

`src/app/api/bookamat/sync/route.ts:74` · found by: bookamat

Bookamat scopes preferences per fiscal year in the URL. The settings UI loads and stores account ids from /{year=now}/preferences/…, while the sync posts to /{year=payment year}/bookings/. Syncing a December payment in January (or any back-dated payment) sends ids chosen from a different fiscal year's account set.

Evidence: src/app/api/bookamat/accounts/route.ts:21-22 `const year = new Date().getFullYear()\n  const base = \`https://www.bookamat.com/api/v1/${country}/${year}/\`` vs src/app/api/bookamat/sync/route.ts:74-75 `const year = new Date(paymentDate).getFullYear()\n  const baseUrl = …/${country}/${year}/`

Fix: Before posting, fetch the target year's account lists and verify the stored ids exist there (fail with a clear message if not), or store the mapping per fiscal year in settings.

#### ○ [medium] Missing per-rate VAT account silently falls back to the 0 % account; empty-items fallback sends a bank-account id as purchasetaxaccount  <sub>bug-p2-59</sub>

`src/app/api/bookamat/sync/route.ts:82` · found by: bookamat

Settings allow every VAT rate to stay 'Not used' (SettingsForm.tsx:1307) and the route only validates bank/cost accounts (:35-42). A 13 % or 10 % line is then posted with the 0 % tax account id but tax_percent '13.00'. When the document has no item lines the fallback uses the bank account id in the purchasetaxaccount field, which is a different Bookamat entity.

Evidence: src/app/api/bookamat/sync/route.ts:82 `purchasetaxaccount: vatAccId ?? settings.bookamat_vat_account_0,` and :94 `purchasetaxaccount: settings.bookamat_vat_account_0 ?? settings.bookamat_bank_account_id,`

Fix: Before posting, verify each VAT rate present in totals.vat_groups has a mapped account and return 400 naming the missing rate; drop the bank-account fallback and reject documents with no billable lines.

#### ○ [medium] Bookamat sync books reverse-charge/non-EU invoices on the 0 % VAT account and sends foreign-currency amounts unconverted  <sub>bug-p5-10</sub>

`src/app/api/bookamat/sync/route.ts:82` · found by: lens:dates-money-i18n, bookamat, lens:small-business-tax

calcTotals collapses reverse-charge and non-EU documents into a single vat_group with rate 0, and the sync maps rate 0 to bookamat_vat_account_0 — the same purchase-tax account as a genuine domestic 0 % supply. Bookamat derives the UVA/ZM from these accounts, so EU reverse-charge revenue is not flagged for the Zusammenfassende Meldung and non-EU revenue is treated as steuerbar. Amounts are also sent in document currency: a USD 1,000 invoice is booked as 1000.00 in an Austrian (EUR) book. Concrete: EU reverse-charge invoice € 1.000 → payload amounts[0].purchasetaxaccount = bookamat_vat_account_0, tax_percent '0.00'.

Evidence: src/lib/utils/document.ts:45 `const rate: VatRate = vatApplies ? (item.vat_rate as VatRate) : 0`; src/app/api/bookamat/sync/route.ts:62-67 `const vatAccountMap: Record<number, number | null> = {\n    0: settings.bookamat_vat_account_0, 10: ..., 13: ..., 20: ... }` and :79-83 `const vatAccId = vatAccountMap[g.rate]\n    return { ... purchasetaxaccount: vatAccId ?? settings.bookamat_vat_account_0,\n…

Fix: Add settings bookamat_vat_account_reverse_charge and bookamat_vat_account_non_eu (Bookamat exposes distinct 'Reverse Charge'/'nicht steuerbar' purchase-tax accounts in preferences/purchasetaxaccounts) and pick the account by doc.tax_treatment; refuse to sync (or convert via exchange_rate) when doc.currency is not EUR.

Merged with: [missing] Bookamat sync has no tax-treatment-aware account mapping: reverse-charge and non-EU revenue booked to the generic 0 % VAT account

#### ○ [medium] Booking created in Bookamat but DB write failure is ignored → duplicate bookings on retry; check-then-write race  <sub>bug-p2-58</sub>

`src/app/api/bookamat/sync/route.ts:128` · found by: bookamat

After a successful POST to Bookamat the update of documents.bookamat_booking_id is awaited but its error is discarded and the route still returns ok. If the update fails the invoice looks unsynced after reload and the next sync creates a second booking. The :44 pre-check and :128 write are also not atomic, so two concurrent requests both pass the guard.

Evidence: src/app/api/bookamat/sync/route.ts:128-131 `await supabase\n    .from('documents')\n    .update({ bookamat_booking_id: String(bookingId) })\n    .eq('id', documentId)` (no `{ error }` destructuring); :44 `if (doc.bookamat_booking_id) {`

Fix: Check the update error and return it together with bookingId so the UI can store it; claim the row first with `.update({bookamat_booking_id:'pending'}).is('bookamat_booking_id', null).select()` and abort if zero rows were affected.

Merged with: [quality] Sync route has no try/catch around the external fetch and ignores the DB update result

#### ○ [medium] Cron reminder PDF/email ignore payments, drop section discounts and omit the QR  <sub>bug-p1-33</sub>

`src/app/api/cron/reminders/route.ts:85` · found by: pdf

The cron query selects document_items and clients but not payments, and calcTotals is called with [] for payments, so a partially paid overdue invoice is reminded for the full total and the attached PDF has no 'Offen' row. The item mapping also omits discount_type/discount_value, so section-subtotal rows in the PDF show undiscounted numbers while calcTotals (fed the raw items) applies the discount - the PDF no longer adds up. qrCodeDataUri is hard-coded null, so the reminder PDF lacks the EPC QR the original had. The single-invoice reminder route has the same [] payments problem.

Evidence: src/app/api/cron/reminders/route.ts:33: `.select('*, document_items(*), clients(*)')` ; :85: `const totals = calcTotals(items, [], docDiscount, invoice.tax_treatment)` ; :102-110 item map with only line_type/description/service_date/quantity/unit/unit_price/vat_rate ; :118: `qrCodeDataUri: null,`; src/app/api/invoices/[id]/reminder/route.ts:44 also passes [].

Fix: Select payments(*), pass them to calcTotals, pass items unchanged (or spread them), generate the EPC QR with balance_due exactly like the portal route; same for src/app/api/invoices/[id]/reminder/route.ts:44.

#### ○ [medium] Route handlers without explicit auth rely solely on RLS; share DELETE reports success for anonymous callers or missing rows  <sub>bug-p3-8</sub>

`src/app/api/documents/[id]/share/route.ts:34` · found by: portal, data-security, dashboard-reports, payments-status

Route handlers are not wrapped by (app)/layout.tsx. documents/[id]/share (POST+DELETE), invoices/[id]/convert-to-credit-note, (app)/quotes/[id]/convert and gmail/auth never call `auth.getUser()` (unlike drive-pdf/route.ts:16-17) and rely on RLS. For share DELETE, RLS silently filters the update for anonymous callers or a foreign id, `error` stays null and the route answers 200 `{ ok: true }` on 0 affected rows although the token is still active. Not exploitable today, but misleading, inconsistent with the other owner-only API routes, and any future loosening of a documents policy (e.g. for the portal) would make these routes anonymously writable.

Evidence: src/app/api/documents/[id]/share/route.ts:30-41 `export async function DELETE(...) { ... const { error } = await supabase.from('documents').update({ share_token: null }).eq('id', id) ... return NextResponse.json({ ok: true }) }` (no getUser); src/app/api/invoices/[id]/convert-to-credit-note/route.ts:4-15; src/app/(app)/quotes/[id]/convert/route.ts:4-14; src/app/api/gmail/auth/route.ts:4

Fix: Add a shared `requireUser()` helper (same `auth.getUser()` 401 guard as drive-pdf) used by every route; return 401 before touching data; append `.select('id').single()` / check affected row count and return 404 when no row was updated.

Merged with: [quality] Conversion routes skip the explicit auth guard other mutating routes perform; quote convert route lives under the (app) page tree

#### ✓ [medium] Gmail OAuth flow has no `state` parameter (login/link CSRF) and the auth route is unauthenticated  <sub>bug-p2-35</sub>

`src/app/api/gmail/callback/route.ts:11` · found by: settings, google, data-security

`generateAuthUrl` is called without `state` and the callback exchanges whatever `?code=` arrives and stores the resulting tokens into the owner's settings row as long as the owner's browser session is logged in. An attacker who starts the flow with their own Google account, captures the redirect code, and gets the logged-in owner to open `/api/gmail/callback?code=...` binds the owner's settings row to the attacker's Gmail/Drive: every subsequent invoice, reminder and PDF upload (client names, amounts, PDFs) is sent from and archived in an account the attacker controls. `/api/gmail/auth` also never checks the session before redirecting to Google.

Evidence: src/app/api/gmail/auth/route.ts:6-14 `const url = oauth2.generateAuthUrl({\n    access_type: 'offline',\n    prompt: 'consent',\n    scope: [...] })` (no state, no session check); src/app/api/gmail/callback/route.ts:7-11 `const code = req.nextUrl.searchParams.get('code')\n  ...\n  const { tokens } = await oauth2.getToken(code)`; callback:25-29 `await supabase.from('settings').update({\n    gmail_e…

Fix: In /api/gmail/auth require an authenticated session, generate a random `state`, store it in an httpOnly SameSite=Lax cookie and pass it to generateAuthUrl; in the callback compare `searchParams.get('state')` with the cookie and reject on mismatch before exchanging the code, and check the session before the exchange.

Merged with: [bug] Google OAuth flow has no `state` parameter → login CSRF can bind an attacker's Google account

Verifier (confirmed, high): src/app/api/gmail/auth/route.ts:4-16 `generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [...] })` — no `state`, and no session check before redirecting. src/app/api/gmail/callback/route.ts:7-11 reads `code` and immediately `oauth2.getToken(co… — Verified; rated medium rather than high: the attack needs the owner to open an attacker-supplied link while logged in within minutes (Google auth codes are short-lived and single-use), and the result …

#### ○ [medium] Gmail send and drive-pdf routes have no error handling; UI loses the composed email and shows a generic message  <sub>bug-p2-51</sub>

`src/app/api/gmail/send/route.ts:37` · found by: google, builder-doc

`gmail.users.messages.send` and the Drive calls in drive-pdf are not wrapped; a Google error (most commonly `invalid_grant` after the refresh token is revoked/expired, or 403 insufficient scope) becomes a non-JSON 500. The builder has already closed the modal (`setGmailPreview(null)` runs before `res.ok` is checked), so the edited To/Subject/Body are gone and the toast says only 'Failed to send email.'; ShareLinkButton calls `res.json()` on the HTML error body and shows 'Drive upload failed: Unexpected token…'. Nothing tells the user to reconnect.

Evidence: send/route.ts:37 `await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })` (no try/catch); DocumentBuilder.tsx:577-583 `setGmailSending(false); setGmailPreview(null); if (!res.ok) { const err = await res.json().catch(() => ({})); toast.error(err.error ?? 'Failed to send email.')`; drive-pdf/route.ts:131-146 unguarded `drive.files.update/create`; ShareLinkButton.tsx:67-68 `const dat…

Fix: Wrap Google calls in try/catch and return JSON `{ error, code }`; map `invalid_grant`/401 to a 'Google connection expired – reconnect in Settings' message (and null the tokens); keep the modal open on failure.

Merged with: [ux] Gmail send failure closes the modal and discards edited To/Subject/Body

#### ✓ [medium] Bulk delete removes issued (numbered, sent/paid) invoices and fails outright when any selected invoice has a credit note  <sub>bug-p1-39</sub>

`src/app/api/invoices/bulk/route.ts:42` · found by: lists

The DELETE route deletes any invoice regardless of status/number, bypassing the counter-restore logic of the single delete and the 7-year retention of issued invoices. In addition, `documents.converted_from_id` references documents(id) with no ON DELETE clause, and the credit-note conversion sets it, so a batch containing an invoice that was converted to a credit note aborts the whole statement with a raw Postgres FK error shown in a toast ('Delete failed: update or delete on table "documents" violates foreign key constraint...').

Evidence: src/app/api/invoices/bulk/route.ts:40-44 `.from('documents').delete().in('id', body.ids).eq('type', 'invoice')`; supabase/schema.sql:107 `converted_from_id uuid references documents(id)`; src/app/api/invoices/[id]/convert-to-credit-note/route.ts:33 `converted_from_id: invoice.id,`; src/components/layout/DeleteDocumentButton.tsx:24 `if (docNumber) {` (counter-restore only in single delete)

Fix: Restrict bulk delete to `status = 'draft'` (or `number is null`) server-side and surface skipped ids; offer bulk 'Mark cancelled' for issued invoices. Add `on delete set null` to converted_from_id or check for referencing credit notes before deleting.

Verifier (confirmed, medium): src/app/api/invoices/bulk/route.ts:40-44 `.from('documents').delete().in('id', body.ids).eq('type', 'invoice')` has no status/number restriction. supabase/schema.sql:107 `converted_from_id uuid references documents(id)` has no ON DELETE clause, and src/app/api… — Partially sharpening the claim: deleting issued invoices is not unique to the bulk path — src/components/layout/DeleteDocumentButton.tsx:20-21 deletes any document and :24-46 merely offers a counter-r…

#### ○ [medium] Manifest declares 192x192 and 512x512 icons that are actually the 180x180 apple-icon  <sub>bug-p3-53</sub>

`src/app/manifest.ts:19` · found by: shell-ui, lens:ux-mobile

All three manifest icon entries point to /apple-icon, whose generator fixes the size at 180x180, yet two entries claim 192x192 and 512x512 (the latter as maskable). Chrome validates declared vs. actual dimensions; icons whose size does not match are rejected and the installability check ('needs an icon of at least 192px') fails, so the Android/desktop Chrome install prompt is not offered and the home-screen icon falls back. iOS ignores manifest icons so the owner may not notice.

Evidence: src/app/manifest.ts:19-24 `{ src: '/apple-icon', sizes: '192x192', type: 'image/png', purpose: 'any', }` ; :25-30 `{ src: '/apple-icon', sizes: '512x512', type: 'image/png', purpose: 'maskable', }` ; src/app/apple-icon.tsx:3 `export const size = { width: 180, height: 180 }`

Fix: Generate real 192px and 512px PNGs (static files in public/ or additional ImageResponse routes with matching `size`) and give the maskable entry a padded artwork; declare only sizes that match the files.

Merged with: [quality] PWA manifest declares 192px and 512px (maskable) icons that are actually the 180px apple-icon; theme/background colours are hard-coded dark

#### ✓ [medium] Line-items table is clipped on phones — Amount column not visible  <sub>bug-p3-4</sub>

`src/app/portal/[token]/page.tsx:147` · found by: portal, lens:ux-mobile

The wrapper uses `overflow-hidden` and the header cells fix Qty/Rate/Amount to 64 + 112 + 112 px (border-box incl. padding). At a 375 px viewport the content box is 343 px, leaving ~53 px for the description column; any normal German word is wider than that, so the table grows past its container and the right-hand columns (prices and amounts) are cut off instead of scrolling.

Evidence: src/app/portal/[token]/page.tsx:147 `<div className="mb-6 rounded-xl overflow-hidden border border-neutral-200 bg-white">` and :152-154 `... uppercase tracking-wide w-16">{t('qty', lang)}</th>` / `w-28">{t('rate', lang)}</th>` / `w-28">{t('amount', lang)}</th>`

Fix: Use `overflow-x-auto` on the wrapper and drop the fixed `w-*` widths, or render a stacked card list below the `sm:` breakpoint (description on one line, qty × rate = amount on the next).

Merged with: [ux] Portal page has no phone layout: meta grid, 4-column line table and single-row action bar

Verifier (confirmed, medium): src/app/portal/[token]/page.tsx:85 outer `max-w-3xl mx-auto px-4` gives a 343px content box at 375px; :147 `<div className="mb-6 rounded-xl overflow-hidden border …">` (341px inside the border); :148 `<table className="w-full text-sm">` (auto layout, no table-… — Verified by layout math; not run in a browser. Severity medium rather than high: the totals block (:231-266, `w-64` in `flex justify-end`) still fits and shows the total, and the PDF download remains …

#### ○ [medium] Reverse-charge / non-EU documents carry no tax note on the portal page  <sub>bug-p3-6</sub>

`src/app/portal/[token]/page.tsx:243` · found by: portal

When `tax_treatment !== 'at_vat'` the VAT rows are suppressed, but nothing explains why: `getTaxNote` is not imported or rendered in the page (import list at line 5 is calcTotals, formatMoney, formatDate, calcSectionSubtotal). An EU business client sees Nettobetrag = Gesamtbetrag with no 'Steuerschuldnerschaft des Leistungsempfängers' statement, although the PDF route does include it (pdf/route.ts:48).

Evidence: src/app/portal/[token]/page.tsx:243 `{doc.tax_treatment === 'at_vat' && totals.vat_groups.map(g => (` — no `getTaxNote` call anywhere in page.tsx

Fix: Render `getTaxNote(doc.tax_treatment ?? 'at_vat', lang, settings)` under the totals block (and for at_vat optionally the per-rate base amounts).

#### ○ [medium] Portal PDF route serves drafts and unnumbered documents; share link can be created for any status  <sub>bug-p1-34</sub>

`src/app/portal/[token]/pdf/route.ts:20` · found by: pdf, portal

The portal PDF route looks up only by share_token and never checks status or number; ShareLinkButton is rendered unconditionally on invoice and credit-note pages. Sharing a draft gives the client a 'document.pdf' whose header reads 'Rechnungsnummer: ' (empty) - a legally invalid invoice - and because the route re-renders from live rows, the same link later serves different content after edits.

Evidence: src/app/portal/[token]/pdf/route.ts:14-20: `.eq('share_token', token).single()` ... `if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })` (no status check); :51 `number: doc.number ?? ''`; :75 `const filename = `${doc.number ?? 'document'}.pdf``; src/app/(app)/invoices/[id]/page.tsx:47: `<ShareLinkButton documentId={doc.id} ...>` (no status gating)

Fix: Return 404 (and hide the Share button) unless the document has a number and status is not draft; consider serving a stored PDF snapshot instead of re-rendering.

Merged with: [ux] Draft documents can be shared; client sees 'Entwurf' with empty number

#### ○ [medium] Catalogue delete and reorder ignore request errors  <sub>bug-p2-32</sub>

`src/components/forms/CatalogueManager.tsx:104` · found by: clients-catalogue

The detach update before delete is not checked (a failure then surfaces as an FK error on delete), and the per-item sort_order updates fired on every drop are awaited without error handling, so a failed reorder looks persisted until reload.

Evidence: src/components/forms/CatalogueManager.tsx:62 `await supabase.from('document_items').update({ catalogue_item_id: null }).eq('catalogue_item_id', id)`; :104 `await Promise.all(withOrder.map(item => supabase.from('catalogue_items').update({ sort_order: item.sort_order }).eq('id', item.id)))`

Fix: Check both results and toast on error; persist reorder with a single `upsert` of {id, sort_order} rows or an RPC.

Merged with: [quality] Per-row request fan-out without atomicity or error handling in the catalogue

#### ○ [medium] Section rename: 'Cancel' saves the new name, and Enter/✓ saves twice  <sub>bug-p2-29</sub>

`src/components/forms/CatalogueManager.tsx:214` · found by: clients-catalogue

The rename input saves on blur. Clicking the X button first blurs the input, which runs `saveCatRename` and persists the edited name before the click handler resets state; pressing Enter or clicking ✓ submits and then blurs (on unmount), so the update loop and toast run twice.

Evidence: src/components/forms/CatalogueManager.tsx:214 `onBlur={saveCatRename}`; :218 `<button type="button" onClick={() => setRenamingCat(null)} className="text-neutral-400 hover:text-neutral-600"><X size={13} /></button>`

Fix: Drop the onBlur save (or cancel on blur), and `preventDefault` on the cancel button's mousedown; guard `saveCatRename` with an in-flight ref.

#### ○ [medium] Catalogue prices are currency-less EUR numbers that are inserted unchanged into USD/GBP documents  <sub>bug-p2-30</sub>

`src/components/forms/CatalogueManager.tsx:272` · found by: clients-catalogue

`default_price` has no currency; the manager formats it as EUR, and picking an item in a non-EUR document copies the number verbatim, so a €450 day rate becomes £450 / $450 on the line.

Evidence: src/components/forms/CatalogueManager.tsx:272 `{formatMoney(item.default_price)}` (formatMoney defaults to 'EUR', src/lib/utils/document.ts:113); src/components/forms/DocumentBuilder.tsx:224 `unit_price: item.default_price,`

Fix: Either store per-currency prices (EUR/USD/GBP columns or a prices JSON) or convert with the document's exchange_rate and show a warning in the picker for non-EUR documents.

Merged with: [missing] No per-currency catalogue prices

#### ○ [medium] Empty or non-numeric 'Payment days' produces NaN and a database not-null error  <sub>bug-p2-27</sub>

`src/components/forms/ClientForm.tsx:100` · found by: clients-catalogue

`parseInt('')` yields NaN, which serialises to null; the column is `integer not null`, so saving fails with the raw constraint message. Negative values are also accepted.

Evidence: src/components/forms/ClientForm.tsx:100 `payment_days: parseInt(fd.get('payment_days') as string, 10),`; supabase/schema.sql:60 `payment_days  integer not null default 14,`

Fix: Validate as an integer >= 0 (fallback to settings.default_payment_days), add `required min="0" step="1"` to the input and show a field-level error.

#### ○ [medium] Deleting a client that has documents surfaces a raw Postgres FK error  <sub>bug-p2-23</sub>

`src/components/forms/ClientForm.tsx:125` · found by: clients-catalogue, lens:lifecycle-integrity, lens:ux-flows

The delete handler does not check for linked documents; the FK is `on delete restrict`, so the toast shows the database error text verbatim and the user gets no guidance (e.g. to set status = inactive).

Evidence: src/components/forms/ClientForm.tsx:125-126 `const { error } = await supabase.from('clients').delete().eq('id', client.id)` / `if (error) { toast.error(error.message); setDeleting(false); return }`; supabase/schema.sql:96 `references clients(id) on delete restrict`

Fix: Count documents for the client before offering Delete; hide/disable the button with a hint to archive (status inactive) when documents exist, and map FK errors to a friendly message.

Merged with: [bug] Deleting a client or a converted quote/invoice fails with a raw Postgres FK error; [ux] Deleting a client with documents shows native confirm then a raw Postgres foreign-key error

#### ○ [medium] Client-specific payment terms are ignored: due date is pre-filled from settings and not updated when the client changes  <sub>bug-p1-23</sub>

`src/components/forms/DocumentBuilder.tsx:176` · found by: builder-doc, clients-catalogue, lens:dunning-payment-terms, lens:lifecycle-integrity

The due date is initialised from settings.default_payment_days before any client is chosen; handleClientChange only copies language/currency/tax treatment. client.payment_days is used only if the due date field is empty at issue time, so a client with 30-day terms gets a 14-day due date unless the user clears the field.

Evidence: src/components/forms/DocumentBuilder.tsx:84 `useState(doc?.due_date ?? addDays(today(), settings.default_payment_days))`; :176-180 `if (c) { if (c.language) setLanguage(c.language) / if (c.currency) setCurrency(c.currency as Currency) / setTaxTreatment(c.tax_treatment as TaxTreatment) }` (no due date); :273-274 fallback only `if (... !dueDate && client)`.

Fix: In handleClientChange (and the mount effect) set `dueDate = addDays(date, c.payment_days ?? settings.default_payment_days)` for new/unissued documents unless the user edited it manually; recompute when `date` changes.

Merged with: [bug] Client `payment_days` never influences the due date in the normal flow; [bug] Client-specific payment_days is never applied; due date always uses the global default

#### ✓ [medium] Reverse-charge invoices can be issued without the recipient's UID  <sub>bug-p4-9</sub>

`src/components/forms/DocumentBuilder.tsx:264` · found by: lens:small-business-tax, clients-catalogue, builder-items, builder-doc, pdf, lens:rechnungsmerkmale

Tax treatment 'eu_reverse_charge' can be selected on a document (or inherited from a client) while `clients.uid_number` is null; nothing validates it at save/send time and the PDF simply omits the UID line. § 11 Abs 1a UStG requires the recipient's UID on reverse-charge invoices, and the ZM cannot be filed without it. For a studio billing EU labels/bands, a missing UID means the invoice is not a valid RC invoice.

Evidence: src/components/forms/DocumentBuilder.tsx:264-266 `save()` validates only `if (!clientId)` and `if (!lines.some(l => l.line_type === 'item'))`; :782-787 tax-treatment select has no UID check; src/components/pdf/InvoiceDocument.tsx:193 `{client.uid_number ? `\n${L('uid', lang)}: ${client.uid_number}` : ''}`; src/components/forms/ClientForm.tsx:149 UID field is optional.

Fix: In save()/ensureNumberAndSave(), block status 'sent' when `taxTreatment === 'eu_reverse_charge' && !client?.uid_number` with a toast; show an inline warning in the builder and in ClientForm when EU reverse charge is chosen without a UID (optionally validate format /^[A-Z]{2}[A-Z0-9]{2,12}$/).

Merged with: [bug] EU reverse-charge clients can be saved without a UID, so issued reverse-charge invoices omit the legally required recipient VAT ID; [missing] No issue-time validation of legally mandatory content: client UID not required for reverse charge or invoices > €10,000, no UID format/VIES check, empty addresses, empty descriptions and zero amounts accepted

Verifier (confirmed, high): Code matches the evidence. src/components/forms/DocumentBuilder.tsx:264-266 `save()` validates only `if (!clientId)` and `if (!lines.some(l => l.line_type === 'item'))`; the same two checks are the only ones in ensureNumberAndSave (:360-361) and requestSent (:… — Rated medium rather than high: this is an absent validation rather than a logic defect, and the owner has a visible UID field; when it does occur the issued document is missing mandatory content, so i…

#### ○ [medium] Documents can be issued with item lines that have an empty description or zero quantity  <sub>bug-p5-37</sub>

`src/components/forms/DocumentBuilder.tsx:266` · found by: lens:ux-a11y-forms

Before assigning a number and marking as sent, the only line-level check is that at least one `line_type === 'item'` exists. A line with a blank description, quantity 0 (the value any invalid input collapses to) or price 0 passes and is printed on the PDF and synced to Bookamat. An Austrian invoice must state the nature and extent of the service (Art und Umfang der Leistung, § 11 UStG); a blank description line on a numbered invoice is non-compliant and cannot be fixed without a credit note.

Evidence: DocumentBuilder.tsx:266 `if (!lines.some(l => l.line_type === 'item')) { toast.error('Add at least one line item.'); return }` (same at :361, :600); `blankLine()` :48 starts with `description: '', quantity: 1, … unit_price: 0`; items are written verbatim in `buildItemsPayload` :248-261 `description: l.description, … quantity: l.line_type === 'item' ? l.quantity : null`. No other validation of `des…

Fix: In `save('sent')` and `ensureNumberAndSave()` reject (with inline errors) any item line whose trimmed description is empty or whose quantity ≤ 0; optionally warn on unit_price 0. Allow drafts to remain incomplete.

#### ○ [medium] Clearing the Date field breaks draft save and autosave with a raw Postgres error  <sub>bug-p1-21</sub>

`src/components/forms/DocumentBuilder.tsx:279` · found by: builder-doc

Only status 'sent' falls back to today(); 'draft' save and autosave send `date: ''` to a NOT NULL date column. The user gets the toast 'invalid input syntax for type date: ""' on Save draft, and autosave fails silently (no toast, 'Saved' indicator stops updating).

Evidence: src/components/forms/DocumentBuilder.tsx:271 `const effectiveDate = (status === 'sent' && !date) ? today() : date` -> :279 `client_id: clientId, date: effectiveDate, ...`; autosave :608 `client_id: clientId, date, service_date: serviceDate || null,`.

Fix: Validate `date` before any save (toast 'Date is required' and mark the field), or always fall back to today().

#### ○ [medium] Preview, 'Send via Superhuman' and all reminder PDFs are generated without the EPC QR code  <sub>bug-p4-21</sub>

`src/components/forms/DocumentBuilder.tsx:320` · found by: lens:dunning-payment-terms, builder-items, builder-doc, payments-status, pdf

buildPdfBlob defaults includeQr=false; only savePdf, saveToDrive and sendViaGmail pass true. downloadPdf (Preview) and openInEmail (the non-Gmail send path) therefore produce a PDF without the GiroCode, and InvoicePageClient.generatePdfBase64 (used by ReminderButton and Bookamat) also omits it. The cron explicitly passes qrCodeDataUri: null. A reminder is exactly the document where a scan-to-pay code matters most, and a studio owner without Gmail connected never ships a QR at all.

Evidence: src/components/forms/DocumentBuilder.tsx:320 `async function buildPdfBlob(numOverride?: string, includeQr = false)`; :334 `if (includeQr && type === 'invoice' && settings.iban && totals.balance_due > 0)`; :447 `const result = await buildPdfBlob()` (downloadPdf); :545 `await downloadPdf()` inside openInEmail; src/components/layout/InvoicePageClient.tsx:38 `builderRef.current.buildPdfBlob(document.n…

Fix: Include the QR whenever type==='invoice' and a number exists (preview can show it too); generate it in the cron with balance_due; have generatePdfBase64 pass includeQr=true for reminders.

Merged with: [bug] PDFs built through the imperative handle (reminder emails, Bookamat upload) never include the EPC QR code; [bug] Reminder PDFs differ from the issued invoice: no EPC QR code and no 'Offen' balance line; [quality] DocumentBuilderHandle hides the includeQr parameter of buildPdfBlob; [ux] Preview never shows the QR, so the final invoice cannot be checked before sending

#### ○ [medium] Save to Drive / Send via Gmail issue the number before discovering that Drive folder or Gmail token is missing (buttons gated on gmail_email only)  <sub>bug-p1-27</sub>

`src/components/forms/DocumentBuilder.tsx:424` · found by: builder-doc, lens:ux-flows, google, lens:ux-consistency

The Drive button is gated on gmail_email, not drive_folder_id. saveToDrive first runs ensureNumberAndSave (number allocated, status sent), renders the PDF, and only then uploadToDrive toasts 'No Drive folder configured'. Same ordering problem for Gmail: the button is gated on gmail_email while /api/gmail/send requires gmail_refresh_token, so a revoked token yields an issued document plus 'Gmail not connected'.

Evidence: src/components/forms/DocumentBuilder.tsx:424-430 `const saved = await ensureNumberAndSave() ... await uploadToDrive(pdfBase64, ...)` with the check at :400 `if (!settings.drive_folder_id) {`; :1487 `{settings.gmail_email && (<Button ... onClick={saveToDrive}`; :1491 `{settings.gmail_email ? (` vs src/app/api/gmail/send/route.ts:13 `if (!settings?.gmail_refresh_token) {`.

Fix: Check prerequisites (drive_folder_id / gmail_refresh_token) before ensureNumberAndSave, and gate the buttons on the same fields the API routes require.

Merged with: [bug] Drive buttons are gated on Gmail, not on a configured Drive folder, and issue the number before failing; [ux] 'Save to Drive' buttons gated on Gmail connection, not on a configured Drive folder

#### ✓ [medium] 'Send via Superhuman' / mailto / mobile 'Email' path never issues a number: it emails a PDF titled 'DRAFT' without QR, subject 'Rechnung DRAFT', and leaves the invoice as draft  <sub>bug-p1-5</sub>

`src/components/forms/DocumentBuilder.tsx:537` · found by: builder-items, builder-doc, pdf, lens:e-invoicing-archival, lens:ux-flows

When Gmail is not connected, the toolbar's send button calls openInEmail(), which builds the mailto link (no number override in buildEmailContent) and calls downloadPdf() -> buildPdfBlob() with no number override and includeQr=false. Neither issues a number nor marks the document sent, so for a new or draft document the subject/body read 'Rechnung DRAFT', the attached PDF shows 'Rechnungsnummer: DRAFT' and no EPC QR, and the document remains a draft although the user just emailed it. It also does not check that the client has an email address (mailto: with empty address). The Gmail path (sendViaGmail) calls ensureNumberAndSave first. The user can send a legally invalid document to the client without the app ever issuing it.

Evidence: src/components/forms/DocumentBuilder.tsx:537-546 `async function openInEmail() { ... const content = buildEmailContent()` (no number override) -> :542 `href: \`mailto:${client.email}?subject=...\`` -> `mailLink.click()` / :545 `await downloadPdf()`; :320-323 `async function buildPdfBlob(numOverride?: string, includeQr = false) { ... number: numOverride ?? doc?.number ?? 'DRAFT'`; compare :552 `con…

Fix: Make openInEmail run the same (confirmed) ensureNumberAndSave() flow first, build the email content with saved.number, download the final PDF via buildPdfBlob(saved.number, true), require client.email like sendViaGmail, tell the user the PDF was downloaded for manual attachment, and redirect to the new document id like the other paths.

Merged with: [bug] Non-Gmail email path sends a PDF numbered 'DRAFT' without issuing a number, without EPC QR and without archiving; [bug] Non-Gmail 'Email' path sends a PDF numbered DRAFT and never marks the document sent

Verifier (confirmed, high): src/components/forms/DocumentBuilder.tsx:537-546 `async function openInEmail() { if (!client) {...} const content = buildEmailContent() ... href: `mailto:${client.email}?subject=...` ... mailLink.click(); await downloadPdf() }`. buildEmailContent (:500-502) re… — Rated medium: the path is only shown when Gmail is not connected (the owner's integrations include Gmail sending), and a workaround exists (press 'Mark as sent' first; router.refresh() then supplies d…

#### ✓ [medium] In-flight autosave can interleave with an explicit save, duplicating or dropping all line items  <sub>bug-p1-4</sub>

`src/components/forms/DocumentBuilder.tsx:605` · found by: builder-items

The `saving` guard only stops autoSave from starting while a save is running; it does not stop save()/ensureNumberAndSave() from starting while an autosave is awaiting. Sequence A.delete -> B.delete -> A.insert -> B.insert inserts every line twice (doubling the invoice total of a document that is being issued at that moment); A.delete -> A.insert -> B.delete -> B.insert is fine, but A.insert after B.insert duplicates as well.

Evidence: src/components/forms/DocumentBuilder.tsx:605 `if (!doc || !clientId || saving) return` (autosave side only) and :293-296 `await supabase.from('documents').update({ ...docFields, ...numberUpdate }).eq('id', doc.id)` ... `await supabase.from('document_items').delete()...insert(...)` with no check for a running autosave.

Fix: Serialize writes through one promise queue/ref (`saveInFlight`), cancel the pending timer and await any running autosave before save()/ensureNumberAndSave(), and make the replace transactional.

Verifier (confirmed, medium): src/components/forms/DocumentBuilder.tsx:605 `if (!doc || !clientId || saving) return` is the only guard and it lives in autoSave; save() (:264-318) and ensureNumberAndSave (:358-397) check neither `autoSaving` nor a pending timer before issuing `update` -> `d… — Rated medium (timing-dependent edge case). Overlaps with bug-p1-2; the fix is shared: serialize writes through one in-flight promise/ref, cancel the pending timer and await any running autosave before…

#### ✓ [medium] Autosave failures are completely silent; 'Saved HH:MM' keeps showing the last successful time  <sub>bug-p1-3</sub>

`src/components/forms/DocumentBuilder.tsx:613` · found by: builder-items

autoSave only acts on success. Any persistent error (e.g. the Date input cleared so `date: ''` is sent to a `date` column, offline, RLS/session expired) means every subsequent edit is never persisted, with no toast, no error state and a stale 'Saved 14:02' label.

Evidence: src/components/forms/DocumentBuilder.tsx:607-618 `const { error } = await supabase.from('documents').update({ client_id: clientId, date, ...` then `if (!error) { ... setLastSaved(new Date()) }` `setAutoSaving(false)` - no else branch.

Fix: On error show a persistent 'Not saved - retry' state (and toast once), keep a dirty flag, retry on next change, and validate `date` before sending (fall back to today or block).

Verifier (confirmed, high): src/components/forms/DocumentBuilder.tsx:607-618 `const { error } = await supabase.from('documents').update({ client_id: clientId, date, service_date: serviceDate || null, ...}).eq('id', doc.id); if (!error) { ...; setLastSaved(new Date()) } setAutoSaving(fals… — Rated medium: the common online path works, but when it fails the user has no signal that edits are not persisted. Show a 'Not saved — retry' state, keep a dirty flag, and validate/fallback `date` bef…

#### ○ [medium] Pending autosave is cancelled on unmount; edits made in the last 2 s before leaving the page are discarded with no unsaved-changes guard  <sub>bug-p1-15</sub>

`src/components/forms/DocumentBuilder.tsx:627` · found by: builder-items, builder-doc

The autosave effect's cleanup clears the pending timer on unmount, so typing a note or editing a line and immediately clicking Back, the back arrow, a sidebar link, another link or the browser back button loses that change without warning. There is no beforeunload handler and no dirty indicator (`grep -rn beforeunload src` is empty), also not for new (unsaved) documents.

Evidence: src/components/forms/DocumentBuilder.tsx:625-627 `autoSaveTimer.current = setTimeout(autoSave, 2000)` / `return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current) }`; `grep -rn beforeunload src/` returns nothing.

Fix: Track a `dirty` flag; flush (not cancel) the pending autosave on unmount/visibilitychange, and register a beforeunload prompt plus a Next.js navigation guard while dirty or saving (also for new documents).

#### ✓ [medium] Catalogue popup hijacks Tab and first click after the Description field; items unselectable by keyboard  <sub>bug-p5-36</sub>

`src/components/forms/DocumentBuilder.tsx:1215` · found by: lens:ux-a11y-forms, builder-items, builder-doc, lens:ux-mobile

The catalogue picker opens on every `onFocus` of a Description input and never closes on blur, Tab or Escape. Its item buttons use `onMouseDown` only (no `onClick`), so Enter/Space on a focused item does nothing. Because the popup sits in DOM order right after the input, Tab from Description walks through every catalogue item and the 'New catalogue item…' button before reaching Qty, and the popup stays open. The `fixed inset-0 z-40` backdrop also swallows the first mousedown on Qty/Price (focus happens on mousedown, so the user must click twice). This is the hottest path in the app — entering each line of a session invoice — and it breaks Tab-to-next-field for everyone, not only screen-reader users.

Evidence: src/components/forms/DocumentBuilder.tsx:1187-1189 `onFocus={e => { setActiveLine(line.id) setShowCatalogue(true)`; :1200 `<div className="fixed inset-0 z-40" onMouseDown={() => setShowCatalogue(false)} />`; :1215 `onMouseDown={() => pickCatalogueItem(item, line.id)}>`; :1239 `<button type="button" onMouseDown={() => saveNewCatalogueItem(line.id)}`; same pattern on mobile at :932-934, :945, :960, …

Fix: Use `onClick` (plus `onMouseDown={e => e.preventDefault()}` to keep input focus) on items; close on input `onBlur` (with relatedTarget check) and on Escape; drop the full-screen backdrop; give the input `role="combobox" aria-expanded aria-controls` and the list `role="listbox"` with ArrowUp/Down + Enter selection.

Merged with: [ux] Catalogue popover: mouse-only, opens on every focus, invisible full-screen backdrop blocks input, fixed position detaches on scroll/keyboard

Verifier (confirmed, high): Desktop description input src/components/forms/DocumentBuilder.tsx:1187-1189 `onFocus={e => { setActiveLine(line.id); setShowCatalogue(true)` and mobile :932-934 — the popup opens on every focus (including keyboard focus). There is no onBlur and no key handler… — Rated medium rather than high: the line-entry path is degraded, not broken — typing a few characters narrows the list, and mouse users can click twice — but it hits every line of every document. Fix: …

#### ○ [medium] Client-side PDF is built from unrounded input values while the DB truncates to numeric(10,2)/(10,4), so emailed PDF ≠ portal/reminder/Bookamat totals  <sub>bug-p5-13</sub>

`src/components/forms/DocumentBuilder.tsx:1261` · found by: lens:dates-money-i18n

The quantity and price inputs have step 0.25/0.01 but typed values are stored in state as-is via parseFloat, and the PDF/email/Drive copy is generated from that state before the page reloads. Postgres then rounds unit_price to 2 and quantity to 4 decimals, so every server-side regeneration (portal PDF, cron reminder PDF, Bookamat amounts) uses different numbers for the same invoice number. Concrete: unit price 33.333 × qty 3 → emailed PDF prints Netto € 100,00 / Gesamt € 120,00; stored 33.33 → portal PDF and reminder PDF print € 99,99 / € 119,99. Two versions of one Rechnungsnummer with different totals is exactly what an auditor flags.

Evidence: supabase/schema.sql document_items `quantity          numeric(10,4) not null default 1, ... unit_price        numeric(10,2) not null default 0`; src/components/forms/DocumentBuilder.tsx:1260-1261 `<Input type="number" value={line.unit_price} min={0} step={0.01}\n                    onChange={e => updateLine(line.id, { unit_price: parseFloat(e.target.value) || 0 })}` (step is not enforced on typed …

Fix: Normalise on change: `unit_price: Math.round(parseFloat(v)*100)/100`, `quantity: Math.round(parseFloat(v)*10000)/10000`, and validate before issuing; alternatively reload the saved document before building the final PDF.

#### ○ [medium] Numbering accepts empty prefix, formats without a sequence token, and counters below issued numbers  <sub>bug-p2-39</sub>

`src/components/forms/SettingsForm.tsx:348` · found by: settings, lens:e-invoicing-archival, lens:ux-flows

No validation runs before saving the Numbering card. An empty prefix is stored as '' (preview shows '?' but save sends the empty string), producing numbers like '-2026-001'. A format with no {N}/{NN}/{NNN}/{NNNN} token (e.g. '{prefix}-{YYYY}') makes every issued document receive the identical number, so the second issue fails on the unique constraint. Setting 'Next #' below an already-issued sequence has the same effect. `min="1"` is UI-only and `parseInt(...) || 1` silently turns 0/NaN into 1.

Evidence: SettingsForm.tsx:348 `invoice_prefix:              docs.invoice_prefix,`; SettingsForm.tsx:556 `.replace('{prefix}', prefix || '?')`; SettingsForm.tsx:819 `<input type="number" min="1" className={inp} value={docs[row.numKey]}`; schema.sql:168-176 `result := fmt; result := replace(result, '{prefix}', prefix); ... result := replace(result, '{N}', num::text);`

Fix: Validate before save: non-empty prefix, format contains exactly one sequence token, next number >= 1 and >= max issued sequence for that type (query documents); show inline errors instead of saving.

Merged with: [bug] The 'Next #' counter is a free-form editable field in Settings, allowing number reuse or a unique-violation on the next issue; [bug] Lowering 'Next #' in Settings causes unique-violation errors and burns counter values

#### ○ [medium] Numbering save overwrites live counters with stale page-load values  <sub>bug-p2-38</sub>

`src/components/forms/SettingsForm.tsx:351` · found by: settings

saveDocsSection always writes next_invoice_number/next_quote_number/next_credit_note_number from state initialised at page load, even when the user only changed a prefix or format. If a document was issued in another tab (or via the quote→invoice convert route) since the Settings page loaded, the counter is rolled back; the next issue call returns an already-used number and the insert fails on the `documents.number` unique constraint with a raw 'duplicate key' error, after `next_document_number()` has already consumed the counter.

Evidence: SettingsForm.tsx:203 `next_invoice_number:         String(settings?.next_invoice_number ?? 1),`; SettingsForm.tsx:351-353 `next_invoice_number:         parseInt(docs.next_invoice_number, 10) || 1,\n      next_quote_number:           parseInt(docs.next_quote_number, 10) || 1,\n      next_credit_note_number:     parseInt(docs.next_credit_note_number, 10) || 1,`; schema.sql:95 `number            text…

Fix: Only include a counter in the update when its field was edited, or re-read the row and compare before writing; ideally move counter edits to a guarded RPC that refuses values lower than the highest issued sequence.

Merged with: [quality] Per-section updates always write every field of the section

#### ○ [medium] 'logos' storage bucket and its policies are defined nowhere  <sub>bug-p3-45</sub>

`src/components/forms/SettingsForm.tsx:504` · found by: data-security

Logo upload targets a `logos` bucket via the anon-key browser client and reads a public URL, but no SQL creates the bucket or grants storage.objects INSERT/UPDATE to authenticated users. On a fresh project the upload fails with 'Bucket not found' / storage RLS error.

Evidence: src/components/forms/SettingsForm.tsx:504 `const { error } = await supabase.storage.from('logos').upload(path, file, { upsert: true })` and :506 `supabase.storage.from('logos').getPublicUrl(path)`; `grep -rn "storage\|bucket\|logos" supabase BOOKAMAT_MIGRATION.sql` → no matches

Fix: Migration: `insert into storage.buckets (id, name, public) values ('logos','logos',true)` plus storage.objects policies for authenticated insert/update/delete on that bucket.

#### ○ [medium] Logo picker accepts any image type but the PDF renderer only decodes JPEG/PNG/SVG  <sub>bug-p2-40</sub>

`src/components/forms/SettingsForm.tsx:645` · found by: settings, pdf

The file input uses accept="image/*" and the upload path stores whatever extension the file had. @react-pdf/image 4.5.1 (`getImageFormat`) recognises only JPEG, PNG and SVG and throws 'Not valid image extension' otherwise. Uploading a WebP, GIF, HEIC (iPhone default) or AVIF logo succeeds, the settings thumbnail renders fine, but from then on every PDF (download, Gmail send, portal PDF, cron reminder attachment) fails until the logo is replaced. There is also no size limit, so a multi-MB photo is embedded in every PDF.

Evidence: SettingsForm.tsx:645 `<input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} disabled={uploadingLogo} />`; SettingsForm.tsx:502-504 `const ext = file.name.split('.').pop()\n    const path = `logo.${ext}`\n    const { error } = await supabase.storage.from('logos').upload(path, file, { upsert: true })`; node_modules/@react-pdf/image/lib/index.js:195-205 (main checkout) `i…

Fix: Restrict accept to image/png,image/jpeg,image/svg+xml, validate file.type and size (e.g. <= 1 MB) client-side, and reset `e.target.value` after upload so re-selecting the same file works.

Merged with: [bug] Logo upload accepts any image/* but react-pdf <Image> only decodes JPEG/PNG/SVG - a WebP/GIF/HEIC logo breaks every PDF

#### ○ [medium] Settings → Numbering uses fixed pixel grid columns that overflow and get clipped on phones  <sub>bug-p5-21</sub>

`src/components/forms/SettingsForm.tsx:811` · found by: lens:ux-mobile

The numbering rows use `grid-cols-[100px_72px_1fr_72px] gap-3`: 244px of fixed columns plus 36px of gaps = 280px before the format-template field even starts. On a 375px phone the SectionCard content width is about 295px (page `p-4`, card `px-6`), so the format input is squeezed to a few pixels or — because an `<input>` has an intrinsic minimum width — the row overflows and the `Next #` input is cut off by the SectionCard's `overflow-hidden`. The owner cannot check or correct the next invoice/quote/credit-note number from the phone, which matters when a document was deleted and the counter needs fixing.

Evidence: src/components/forms/SettingsForm.tsx:797 `<div className="grid grid-cols-[100px_72px_1fr_72px] gap-3 items-center pb-1 border-b ...">`; :811 `<div className="grid grid-cols-[100px_72px_1fr_72px] gap-3 items-center">`; :819 `<input type="number" min="1" className={inp} value={docs[row.numKey]}`; :822 `<div className="pl-[112px]">`; :94 SectionCard wrapper `<div className="rounded-xl border ... ove…

Fix: Use `grid-cols-1 sm:grid-cols-[100px_72px_1fr_72px]` with per-field labels on mobile, add `min-w-0` to the inputs, and replace `pl-[112px]` with `sm:pl-[112px]`.

#### ○ [medium] 'Re-connect your Google account to grant Drive access' warning is always shown because it checks whether the opaque access-token string contains 'drive'  <sub>bug-p2-42</sub>

`src/components/forms/SettingsForm.tsx:1204` · found by: settings, google, data-security, lens:freelancer-workflows, lens:ux-flows

The condition tests whether the Google access token string contains the substring 'drive'. Access tokens are opaque (`ya29...`) and never contain scope names, so the condition is true for every connected account: the amber warning with a Re-connect link is displayed permanently, even right after a fresh consent that included the drive scope, and gives no real information about Drive scope. `tokens.scope` from the callback is discarded, so the app has no way to know whether Drive was granted.

Evidence: SettingsForm.tsx:1204-1206 `{!settings?.gmail_access_token?.includes('drive') && settings?.gmail_refresh_token && (\n                  <p className="text-xs text-amber-600 dark:text-amber-500">\n                    Re-connect your Google account to grant Drive access.{' '}`; callback/route.ts:25-30 stores only email/tokens/expiry

Fix: Add a `gmail_scopes text` column, store the granted `tokens.scope` string in the callback, and show the hint only when it lacks 'https://www.googleapis.com/auth/drive' — or drop the warning.

Merged with: [bug] 'Re-connect to grant Drive access' warning is always shown once Gmail is connected; [bug] Drive 'Re-connect to grant Drive access' warning is shown permanently because it string-searches the opaque access token; [bug] 'Re-connect your Google account to grant Drive access' warning is shown permanently; [quality] Scope detection hack and discarded scope data; [missing] Granted OAuth scopes are not stored

#### ○ [medium] Attached PDF is rendered from unsaved editor state (and without the EPC QR), not from the data the booking was computed from  <sub>bug-p2-61</sub>

`src/components/layout/InvoicePageClient.tsx:38` · found by: bookamat

generatePdfBase64 calls DocumentBuilder.buildPdfBlob, which builds the PDF from in-memory `lines`, `totals`, `date` etc., while the booking amounts come from the DB rows. If the user edits a line and syncs without saving, the PDF archived in Bookamat shows different amounts than the booking. includeQr defaults to false, so the archived copy also differs from the issued/sent PDF.

Evidence: src/components/forms/DocumentBuilder.tsx:320-329 `async function buildPdfBlob(numOverride?: string, includeQr = false) { … items: lines.map(l => ({ ...l })), totals,`; src/components/layout/InvoicePageClient.tsx:38 `builderRef.current.buildPdfBlob(document.number ?? undefined)`; src/app/api/bookamat/sync/route.ts:48-53 totals from `doc.document_items`

Fix: Block sync while the builder has unsaved changes (or save first), pass includeQr=true, or attach the already-archived Drive PDF (documents.drive_file_id) instead of re-rendering.

#### ○ [medium] Reminder offered for invoices that are not yet due; email text then says '0 Tagen überfällig'  <sub>bug-p3-22</sub>

`src/components/layout/InvoicePageClient.tsx:49` · found by: payments-status, lens:lifecycle-integrity, lens:dunning-payment-terms

The button is shown for status 'sent' regardless of due_date and daysOverdue is clamped to 0, so a reminder sent before the due date reads 'am <date> fällig war und nun seit 0 Tagen überfällig ist'.

Evidence: src/components/layout/InvoicePageClient.tsx:49 `const showReminder = (document.status === 'overdue' || document.status === 'sent') && gmailConfigured`; src/app/api/invoices/[id]/reminder/route.ts:38 `? Math.max(0, Math.floor((today.getTime() - new Date(dueDate).getTime()) / 86400000))`; src/lib/utils/reminder-templates.ts:37 `...am {{due_date}} fällig war und nun seit {{days_overdue}} Tagen überfä…

Fix: Show the button only when due_date < today (or status overdue), or add a separate pre-due 'friendly reminder' template.

Merged with: [ux] Reminder can be sent for not-yet-due 'sent' invoices ('seit 0 Tagen überfällig'); status menu allows any transition

#### ○ [medium] Overpayments are accepted silently and zero-total documents show 'Paid in full'  <sub>bug-p3-30</sub>

`src/components/layout/PaymentPanel.tsx:48` · found by: payments-status, lens:lifecycle-integrity

Only `amt <= 0` is rejected; a payment larger than the balance is stored, balanceDue goes negative and the panel displays 'Paid in full', hiding the overpayment. An invoice whose total is 0 (no items / 100% discount) is also reported 'Paid in full'.

Evidence: src/components/layout/PaymentPanel.tsx:44 `const fullyPaid = balanceDue <= 0.005`; :48 `if (!amt || amt <= 0) { toast.error('Enter a valid amount.'); return }`

Fix: Warn/confirm when amt > balanceDue + 0.005, show an 'Overpaid by X' state, and treat total <= 0 as 'nothing to pay' rather than paid.

Merged with: [bug] Payments can exceed the invoice total and can be recorded on drafts/cancelled invoices

#### ○ [medium] PaymentPanel status transitions ignore the current status and number: drafts/cancelled invoices become 'paid', paid ones silently become 'sent'  <sub>bug-p3-17</sub>

`src/components/layout/PaymentPanel.tsx:66` · found by: payments-status, data-security, lens:ux-flows

PaymentPanel is rendered for every invoice regardless of status/number. Recording a full payment unconditionally writes 'paid' — a draft without number or a cancelled invoice becomes a 'paid' invoice, counts as revenue on the dashboard and can be synced to Bookamat as 'Draft – Client'. Removing a payment unconditionally writes 'sent' (an overdue invoice silently stops being overdue, a draft becomes 'sent' without ever being issued). The status update result is also not checked before showing the 'marked as paid' toast.

Evidence: src/components/layout/PaymentPanel.tsx:66 `await supabase.from('documents').update({ status: 'paid' }).eq('id', documentId)` (no number/status guard); :87 `await supabase.from('documents').update({ status: 'sent' }).eq('id', documentId)`; src/app/api/bookamat/sync/route.ts:60 `const title = `${doc.number ?? 'Draft'} – ${clientName}`.slice(0, 50)`

Fix: Hide/disable the payment form unless the invoice has a number and status in ('sent','overdue'); pass the current status in and only transition sent/overdue -> paid, and on removal only paid -> (due_date < today ? overdue : sent); check the update error; add a DB check constraint `status <> 'paid' or number is not null`.

Merged with: [bug] Payments can be recorded on unnumbered drafts; removing a payment forces status 'sent'; no confirmation on removal

#### ○ [medium] ReminderButton: the 'Resend' button has no visible content on phones, and the 'Reminder sent' status is hidden  <sub>bug-p5-20</sub>

`src/components/layout/ReminderButton.tsx:52` · found by: lens:ux-mobile

Once a reminder has been sent, the component renders a `BellRing` icon with its text hidden below `sm`, and a Resend `<button>` whose only child is a `<span className="hidden sm:inline">`. On a phone the button therefore has no content and no size: it cannot be tapped, so a second reminder for an overdue invoice cannot be sent from the iPhone, and the bell icon has no explanation. The first-send button is icon-only on mobile as well. Chasing overdue invoices is a task this owner is likely to do from the phone.

Evidence: src/components/layout/ReminderButton.tsx:47-60 `<div className="flex items-center gap-2"> <span className="flex items-center gap-1.5 text-xs ..."> <BellRing size={13} /> <span className="hidden sm:inline">Reminder sent {date}</span> </span> <button onClick={sendReminder} disabled={sending} title={`Resend reminder (last sent ${date})`} className="text-xs ..."> <span className="hidden sm:inline">{se…

Fix: Always render a label (e.g. `Resend` / `Remind`) or put the icon inside the button; show the sent date on mobile in a short form (`Sent 03.10.`).

#### ○ [medium] Theme toggle compares the stored setting ('system') instead of the resolved theme  <sub>bug-p3-49</sub>

`src/components/layout/Sidebar.tsx:61` · found by: shell-ui

defaultTheme is 'system'. useTheme().theme returns the stored preference, so for a user who never toggled it is 'system' even when the OS is dark. The button then shows the Moon icon / 'Dark mode' label although the UI is already dark, and the first click sets 'dark' (no visible change); only the second click switches to light. Same code in MobileHeader.

Evidence: src/components/layout/Sidebar.tsx:61 `onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}` ; :64-65 `{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}` `{theme === 'dark' ? 'Light mode' : 'Dark mode'}` ; src/components/ui/ThemeProvider.tsx:7 `defaultTheme="system" enableSystem` ; src/components/layout/MobileHeader.tsx:134-138 identical logic

Fix: Use `resolvedTheme` from useTheme() for both the comparison and the icon/label (and apply the same change in MobileHeader.tsx:134-138).

#### ○ [medium] Theme-dependent markup in Sidebar/MobileHeader causes a hydration mismatch for dark-mode users  <sub>bug-p3-50</sub>

`src/components/layout/Sidebar.tsx:64` · found by: shell-ui

next-themes 0.4.6 initialises `theme` with `useState(() => H(storageKey, defaultTheme))` where H returns undefined only when `typeof window == 'undefined'` and otherwise reads localStorage synchronously. On the server the Sidebar therefore renders Moon + 'Dark mode'; on the client's first (hydration) render a user who chose dark gets Sun + 'Light mode'. React 19 reports a recoverable hydration error and re-renders on the client on every page load (dev overlay error each navigation, flash in production). MobileHeader is always in the DOM (md:hidden) so it mismatches too.

Evidence: src/components/layout/Sidebar.tsx:64-65 `{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}` / `{theme === 'dark' ? 'Light mode' : 'Dark mode'}` ; node_modules/next-themes/dist/index.mjs `let[c,n]=t.useState(()=>H(m,l))` ... `H=(e,i)=>{if(O)return; ... s=localStorage.getItem(e) ... return s||i}` with `O=typeof window=="undefined"`

Fix: Render theme-independent markup: output both icons/labels and toggle visibility with CSS (`<Sun className="hidden dark:block"/>`, `<Moon className="dark:hidden"/>`), or gate the toggle behind a mounted flag (useSyncExternalStore / useEffect) as the next-themes README recommends.

#### ○ [medium] Status filter seeded from the URL sticks after navigating to /invoices without a status  <sub>bug-p1-43</sub>

`src/components/lists/InvoiceList.tsx:78` · found by: lists

`useState(initialStatus ?? '')` only reads the prop on mount and the page does not key the component. Soft navigation from /invoices?status=overdue (dashboard card) to /invoices (sidebar link) or to /invoices?status=outstanding keeps the InvoiceList instance and its state, so the list stays filtered on the previous status while the URL and dropdown suggest otherwise. Unknown values such as ?status=foo are also accepted and yield an empty list while the select shows 'All statuses'.

Evidence: src/components/lists/InvoiceList.tsx:78 `const [status, setStatus] = useState(initialStatus ?? '')`; src/app/(app)/invoices/page.tsx:16 `<InvoiceList invoices={docs ?? []} initialStatus={status} />` (no key); src/components/layout/Sidebar.tsx:18 `{ href: '/invoices', label: 'Invoices', ...}`

Fix: Pass `key={status ?? ''}` from the page or sync with `useEffect(() => setStatus(initialStatus ?? ''), [initialStatus])`, validate against STATUSES, and ideally write search/status/sort/page to the URL with router.replace.

#### ○ [medium] After bulk delete the list can land on an empty page with pagination hidden  <sub>bug-p1-41</sub>

`src/components/lists/InvoiceList.tsx:117` · found by: lists

`page` is only reset by search/filter/sort changes, never when `invoices` shrinks after router.refresh(). Example: 26 invoices, user is on page 2 (page=1), selects the single row there and deletes it -> 25 rows, `pageItems = filtered.slice(25, 50)` is empty, the empty-state is not shown because `filtered.length !== 0`, and the pagination block is hidden because `filtered.length > PAGE_SIZE` is false - the user sees '25 invoices' and a blank table with no way back except changing a filter.

Evidence: src/components/lists/InvoiceList.tsx:117 `const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)`; :351 `{filtered.length > PAGE_SIZE && (`; :303 `{filtered.length === 0 && (`

Fix: Clamp the page: `const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); const safePage = Math.min(page, pageCount - 1)` and use safePage for slicing, or reset page in bulkDelete/bulkUpdateStatus.

#### ○ [medium] Bulk status/delete acts on selected rows that are no longer visible after changing search or filter  <sub>bug-p1-42</sub>

`src/components/lists/InvoiceList.tsx:137` · found by: lists

Selection is never cleared when the search text or status filter changes, and the bar keeps showing 'N selected'. Mark Sent/Paid/Delete send `[...selected]` (all ids, hidden ones included) while Export CSV only exports `filtered.filter(d => selected.has(d.id))` (visible ones). A user who selects 5 overdue invoices, switches the filter to 'Draft' to look at something, then clicks Mark Paid, pays the 5 hidden invoices without seeing them in the confirm dialog ('Mark as paid 5 invoices?').

Evidence: src/components/lists/InvoiceList.tsx:137 `const ids = [...selected]`; :178 `? filtered.filter(d => selected.has(d.id))`; :219 `onChange={e => { setQ(e.target.value); setPage(0) }}`; :225 `onChange={e => { setStatus(e.target.value); setPage(0) }}`

Fix: Either clear the selection on search/filter change, or derive the acted-upon ids from `filtered` (visible selection) for all bulk actions and list the invoice numbers in the confirm dialog.

#### ○ [medium] PDF uses built-in Helvetica (WinAnsi only, no Font.register): the U+2212 minus in discount rows and any non-WinAnsi letters in client names/descriptions are silently dropped  <sub>bug-p1-29</sub>

`src/components/pdf/InvoiceDocument.tsx:6` · found by: pdf

fontFamily is the built-in 'Helvetica' and there is no Font.register call in the codebase (grep 'Font.register' src -> 0). react-pdf's built-in fonts go through pdfkit's AFM encoder, whose WIN_ANSI_MAP maps anything outside WinAnsi to '.notdef', so the glyph vanishes without any error. Discount amounts are prefixed with the Unicode minus '-' (U+2212, code 8722), which is not in WIN_ANSI_MAP: on an issued invoice the discount row reads 'Rabatt (10%)   EUR 50,00' with no sign, indistinguishable from a surcharge. Likewise Polish l/s/z with diacritics, Czech r/e/u, Hungarian o/u, Turkish s/g, Romanian t, Cyrillic, Greek, emoji disappear, e.g. a client 'Lukasz Nowak, Wroclaw' with Polish letters prints as 'ukasz Nowak, Wrocaw'.

Evidence: src/components/pdf/InvoiceDocument.tsx:6 `page: { fontFamily: 'Helvetica', fontSize: 9, ...}`; :296 `<Text>−{fmt(doc.totals.discount_amount)}</Text>` and :246 `<Text style={s.subtotalValue}>−{fmt(discAmt)}</Text>`; node_modules/@react-pdf/pdfkit/lib/pdfkit.js:2929-2957 WIN_ANSI_MAP (no 8722) and :3126-3128 `characterToGlyph(character) { return characters[WIN_ANSI_MAP[character] || character] || '.…

Fix: Font.register a TTF family with Latin-Extended/Cyrillic coverage (e.g. Inter or Noto Sans, regular/bold/italic) served from /public/fonts and use it as fontFamily; until then use ASCII '-' (or format negative numbers through Intl) for the discount sign.

#### ○ [medium] Fixed footer is taller than the page's bottom padding, so body content can overlap it on full pages  <sub>bug-p1-32</sub>

`src/components/pdf/InvoiceDocument.tsx:6` · found by: pdf

The footer is absolutely positioned at bottom: 36 with paddingTop 12, a 10pt title + 5pt margin and up to four 8pt lines at lineHeight 1.7 (13.6pt each: company, bank name, IBAN, BIC) ~ 36+12+17+54 ~ 119pt from the page bottom. Body content may extend down to paddingBottom = 100pt. On any page that is filled to the boundary (long item lists) the last row(s) are drawn across the footer rule and the 'Kontakt' title.

Evidence: src/components/pdf/InvoiceDocument.tsx:6: `paddingBottom: 100` ; :54: `footer: { position: 'absolute', bottom: 36, ... paddingTop: 12, ...}` ; :55-56: `footerTitle: { fontSize: 10, ... marginBottom: 5 }, footerText: { fontSize: 8, ... lineHeight: 1.7 }` ; :339-342 four footer text lines

Fix: Raise page paddingBottom to at least 130 (or compute from the footer line count), or reduce footer lineHeight.

#### ○ [medium] {{date}} and {{due_date}} variables render raw ISO dates in PDF footer, emails and reminders  <sub>bug-p2-37</sub>

`src/components/pdf/InvoiceDocument.tsx:146` · found by: settings, builder-doc, pdf, lens:ux-consistency, builder-items, google, payments-status

The chips offered in Settings produce unformatted 'YYYY-MM-DD' strings because the substitution maps pass `doc.date` / `dueDate` straight through while every other date on the PDF goes through formatDate(). A German invoice footer 'Zahlbar bis {{due_date}}' prints 'Zahlbar bis 2026-10-25' instead of '25.10.2026'; the same happens in Gmail bodies and cron reminders ('am 2026-10-11 fällig').

Evidence: src/components/pdf/InvoiceDocument.tsx:146-147 `date: doc.date,\n    due_date: doc.due_date ?? '',`; src/components/forms/DocumentBuilder.tsx:512-513 `due_date: dueDate ?? '',\n      date,`; src/app/api/cron/reminders/route.ts:50 `const dueDate = invoice.due_date ?? ''`; src/lib/utils/document.ts:133 `return new Date().toISOString().split('T')[0]`

Fix: Run `formatDate(value, lang)` for date/due_date in footerVars, buildEmailContent and both reminder contexts.

Merged with: [bug] Email templates insert raw ISO dates ({{date}}, {{due_date}}) instead of Austrian format; [bug] PDF footer variables {{date}} and {{due_date}} are inserted as raw ISO strings; [bug] {{date}} / {{due_date}} template variables insert ISO dates into emails, reminders and PDF footers; [ux] Email templates and reminders substitute raw ISO dates; service-date tooltip ISO; reminder amounts always de-AT; service date hidden on mobile

#### ○ [medium] PDF and portal hard-code English unit names, 'Subtotal'/'Net'/'Discount' section labels and 'USt.' VAT label regardless of document language, and quantities are not locale-formatted  <sub>bug-p5-14</sub>

`src/components/pdf/InvoiceDocument.tsx:268` · found by: lens:dates-money-i18n, lens:ux-consistency, lens:rechnungsmerkmale, lens:freelancer-workflows, builder-items, clients-catalogue, pdf, portal

On a German Rechnung the rate column prints the raw unit enum ('€ 450,00/day', '/hour', '/flat', '/piece', '/session', '/month') and the quantity is JavaScript's String(1.5) = '1.5' instead of '1,5'; the per-section subtotal rows print 'Subtotal', 'Net' and 'Discount' in English via string literals while every other label goes through the L()/t() tables, so a German document shows 'Subtotal … Net' above a totals block saying 'Nettobetrag/Gesamtbetrag'. On an English invoice the VAT rows print 'USt. 20%' (next to 'Sub-Total' and 'Total'), and the builder's totals panel does the same, while the client portal localises the same line as 'MwSt.' (DE) / 'VAT' (EN) — 'USt.' is the correct Austrian term, 'MwSt.' the German one, so the same invoice shows a different tax term on the PDF than on its share link, and English-language clients see an untranslated German abbreviation. The portal additionally omits the unit entirely so PDF and portal disagree. Day rates and hourly engineer rates are this studio's main line items, so nearly every German invoice reads '… /day' and '… /hour'; the owner sends mostly German documents to Austrian clients, and this mixed-language output looks unprofessional on issued invoices.

Evidence: src/components/pdf/InvoiceDocument.tsx:267-268 `<Text style={s.colQty}>{item.quantity}</Text>\n              <Text style={s.colRate}>{fmt(item.unit_price)}/{item.unit}</Text>`; :237 `<Text style={s.subtotalLabel}>Subtotal</Text>`; :249 `<Text style={[s.subtotalLabel, { fontFamily: 'Helvetica-Bold' }]}>Net</Text>`; :301 `<Text style={s.totalsLabel}>USt. {g.rate}%</Text>`; DocumentBuilder.tsx:1365 `…

Fix: Add a UNIT_LABELS map ({hour:{de:'Std.',en:'h'}, day:{de:'Tag',en:'day'}, session:{de:'Session',en:'session'}, flat:{de:'pauschal',en:'flat'}, piece:{de:'Stk.',en:'pc'}, month:{de:'Monat',en:'month'}}); add `section_subtotal`, `net` and `vat: { de: 'USt.', en: 'VAT' }` keys to the PDF LABELS / portal L maps (de: 'Zwischensumme', 'Netto') and use them in PDF, builder (lines 874/903/1129/1158/1365) and portal (change portal's 'MwSt.' to 'USt.', use L('discount', lang)); format quantity with `new Intl.NumberFormat(lang==='de'?'de-AT':'en-GB')` and show the unit on the portal too.

Merged with: [bug] PDF and portal contain hard-coded English/German strings: raw unit keys, 'Subtotal'/'Net', 'USt.' on English documents, ISO dates in footer variables; [missing] Unit names are not localised (English enum printed on German documents, catalogue and builder); [ux] Section subtotal rows hard-coded English ('Subtotal'/'Net'/'Discount') in PDF and portal; raw unit enum suffixes; [ux] VAT rows hard-coded 'USt.' on English PDFs; portal says 'MwSt.' (German-German) vs 'USt.' on PDF; [ux] Quantity printed raw (dot decimal, no rounding, no unit) in PDF and portal

#### ○ [medium] Percent discounts above 100 % are accepted and produce negative subtotals/VAT/totals that are saved and printed  <sub>bug-p1-9</sub>

`src/lib/utils/document.ts:69` · found by: builder-items, builder-doc, lens:dates-money-i18n

The document- and section-level discount inputs have min=0 but no max, and parseFloat accepts any value. calcTotals only checks `value > 0` and multiplies without clamping: a 150 % document discount yields discount_amount = 1.5 x subtotal and a negative total; a section discount of 150 % gives a negative scale and negative VAT bases. The negative figures are saved and printed on the issued PDF; the EPC QR is skipped (balance <= 0) silently.

Evidence: src/components/forms/DocumentBuilder.tsx:1333-1334 `<input type="number" value={discountValue} min={0} step={discountType === 'percent' ? 1 : 0.01} onChange={e => setDiscountValue(parseFloat(e.target.value) || 0)}` (no max; same at :887 and :1142); src/lib/utils/document.ts:69-73 `if (discount && discount.value > 0 && subtotal > 0) { discount_amount = discount.type === 'percent' ? subtotal * (disc…

Fix: Clamp percent to 0-100 (`max={100}`, `Math.min(100, value)`) and fixed to 0-subtotal both in the inputs (max attribute + clamp in onChange) and in calcTotals/flushSection; block issuing when total < 0.

Merged with: [bug] Percent discounts above 100 % and negative quantities/prices are accepted and produce negative totals

#### ○ [medium] 'Today' is computed in UTC (today(), overdue detection in list/dashboard/overdue.ts) and addDays round-trips through UTC, so the default invoice date is yesterday after midnight, overdue detection lags, and due dates shift across DST  <sub>bug-p1-22</sub>

`src/lib/utils/document.ts:133` · found by: builder-doc, lists, dashboard-reports, payments-status, lens:lifecycle-integrity, lens:dates-money-i18n

`new Date().toISOString()` is UTC: in Vienna between 00:00 and 01:00 (CET) or 02:00 (CEST) the builder pre-fills yesterday's date, and the same pattern in InvoiceList, overdue.ts and the dashboard means an invoice due yesterday is not shown under the Overdue filter until the UTC day rolls over. addDays parses the ISO date as UTC midnight, adds days in local time and converts back with toISOString; when the 14-day span crosses the spring DST change (e.g. date 2026-03-20) the due date comes out one day early (2026-04-02 instead of 04-03).

Evidence: src/lib/utils/document.ts:133 `return new Date().toISOString().split('T')[0]`; :126-129 `const d = new Date(date) / d.setDate(d.getDate() + days) / return d.toISOString().split('T')[0]`; src/components/lists/InvoiceList.tsx:90 `const today = new Date().toISOString().split('T')[0]`.

Fix: Provide a shared `todayLocal()` built from local date parts (or `Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna' })`) in utils/document.ts and reuse it in the list, dashboard and overdue.ts; do day arithmetic on y/m/d parts (or use date-fns `addDays`/`format` without UTC round-trips).

Merged with: [bug] 'Today' is computed in UTC, not Europe/Vienna; [bug] Default payment date uses the UTC calendar day; [bug] Document, payment and numbering dates use the UTC calendar day, not Vienna time; [bug] 'Today' is derived from UTC everywhere, so between 00:00 and 01:00/02:00 Vienna time document, payment and overdue dates are yesterday's; [bug] addDays is off by one across the spring DST change (due dates one day too early)

#### ○ [medium] EPC QR and Bookamat amounts use toFixed(2) while the PDF uses Intl, so they differ by one cent for ~3 % of totals  <sub>bug-p5-3</sub>

`src/lib/utils/epc-qr.ts:31` · found by: lens:dates-money-i18n

Number.prototype.toFixed rounds the exact binary value, Intl.NumberFormat rounds the shortest decimal representation. For totals whose decimal form ends in 5 at the third place they disagree. A brute-force scan (qty ∈ {0.25…3} × prices €1,00–€999,99 at 20 % VAT) found 20 306 mismatching combinations. Example: qty 0.25 × € 50,15 + 20 % = 15.045 → PDF prints € 15,05, the GiroCode encodes EUR15.04 and the Bookamat booking amount is "15.04". The client's banking app pre-fills a cent less than the invoice says, and the bookkeeping entry differs from the issued document.

Evidence: src/lib/utils/epc-qr.ts:31 `const amountStr = amountEur != null && amountEur > 0 ? `EUR${amountEur.toFixed(2)}` : ''`. src/app/api/bookamat/sync/route.ts:83 `amount: (g.base + g.amount).toFixed(2),` and :95 `amount: totals.total.toFixed(2),`. src/lib/utils/document.ts:114 `new Intl.NumberFormat('de-AT', { style: 'currency', currency }).format(amount)`. node: (15.045).toFixed(2)='15.04' vs Intl → '…

Fix: Round once in calcTotals (integer cents) and derive both the display string and the machine strings from that rounded value, e.g. `(Math.round(amount*100)/100).toFixed(2)` or `(cents/100).toFixed(2)` where cents is an integer.

#### ○ [medium] next_document_number derives {YYYY}/{YY}/{MM} from current_date instead of the document date, never resets the counter per year, and the issue date is unvalidated  <sub>bug-p4-15</sub>

`supabase/migrations/20260528_fix_next_number_where_clause.sql:33` · found by: lens:small-business-tax, lens:e-invoicing-archival, lens:lifecycle-integrity, data-security, lens:rechnungsmerkmale, builder-doc, settings, lens:freelancer-workflows

`next_document_number` substitutes {YYYY}/{YY}/{MM} with `current_date` at the moment the document is marked sent, while the document's `date` is a free date input that can be set to any past or future day and remains editable after issue; the builder passes no date to the RPC. An invoice dated 31 Dec 2026 but issued on 2 Jan 2027 is numbered R-2027-xxx and sorts into the wrong year's series; conversely the user can back-date a numbered invoice into a closed VAT quarter, and nothing checks that date >= the previous issued invoice's date. The function also keeps a single ever-increasing counter with no year tracking, so on 1 January the sequence continues (R-2026-087 → R-2027-088) unless the owner remembers to edit 'Next #' in Settings. Tax auditors expect the number series to match the invoice date/year and a per-year series is what the owner's accountant expects; the date field is freely editable so this will happen at every year end.

Evidence: supabase/migrations/20260528_fix_next_number_where_clause.sql:33-35 `result := replace(result, '{YYYY}',   to_char(current_date, 'YYYY')); result := replace(result, '{YY}', to_char(current_date, 'YY')); result := replace(result, '{MM}', to_char(current_date, 'MM'));` and :39 `result := replace(result, '{NNN}', lpad(num::text, 3, '0'));` with no year tracking (same in supabase/schema.sql:170-172); …

Fix: Add a `doc_date date default current_date` parameter to next_document_number, pass the document's `date` from the builder, and derive the {YYYY}/{YY}/{MM} tokens from it; store `counter_year` per doc type in settings and, if the format contains {YYYY}/{YY} and counter_year <> extract(year from doc_date), reset the counter to 1; at issue time warn if date is earlier than the last issued invoice or lies in a quarter whose UVA was already filed; freeze date after issue.

Merged with: [bug] {YYYY}/{YY}/{MM} in document numbers use the DB's current_date (UTC) at RPC time, not the document date; [missing] Document counters never reset per year although the default format embeds {YYYY}; the year token uses DB current_date instead of the document date, and the upcoming number is not previewed

#### ○ [medium] catalogue_items.unit CHECK excludes 'session', which the UI offers  <sub>bug-p3-35</sub>

`supabase/schema.sql:72` · found by: data-security, builder-doc, clients-catalogue

Both unit pickers list 'session' (the studio's main unit), but the table constraint only allows hour/day/flat/piece/month. Creating or editing a catalogue item with unit 'session' fails with a raw check-constraint error toast.

Evidence: supabase/schema.sql:72 `unit text not null default 'day' check (unit in ('hour','day','flat','piece','month')),`; src/components/forms/CatalogueManager.tsx:11 `const UNITS: Unit[] = ['hour', 'day', 'session', 'flat', 'piece', 'month']`; src/types/index.ts:8 `export type Unit = ... | 'session'`

Fix: Migration dropping/re-adding the check with 'session' (and apply the same list as a check on document_items.unit).

Merged with: [bug] Creating a catalogue item with unit 'session' from the builder violates the catalogue_items check constraint; [bug] Catalogue offers unit 'session' that the schema's CHECK constraint rejects

#### ○ [medium] converted_from_id FK has no ON DELETE action → deleting a converted quote or invoice fails with a raw Postgres error  <sub>bug-p3-19</sub>

`supabase/schema.sql:107` · found by: payments-status, data-security

converted_from_id references documents(id) with the default NO ACTION, so after converting a quote to an invoice (or an invoice to a credit note) deleting the source row throws a foreign-key violation. Single delete, bulk delete and client delete (documents.client_id ON DELETE RESTRICT) all surface the verbatim `violates foreign key constraint` message via toast.

Evidence: supabase/schema.sql:107 `converted_from_id uuid references documents(id)` and :96 `client_id uuid not null references clients(id) on delete restrict`; src/components/layout/DeleteDocumentButton.tsx:20-21 `const { error } = await supabase.from('documents').delete().eq('id', id)` / `if (error) { toast.error(error.message); setLoading(false); return }`; src/components/forms/ClientForm.tsx:125-126

Fix: Migrate the FK to `on delete set null`; in the UI pre-check for dependants and show 'This quote was converted to invoice R-2026-012 and cannot be deleted.' / 'Client has N documents' instead of the PG message.

#### ○ [low] 'Last Invoice' column counts drafts and cancelled invoices  <sub>bug-p1-46</sub>

`src/app/(app)/clients/page.tsx:9` · found by: lists, clients-catalogue

The clients page builds lastInvoicedMap from all documents of type invoice without a status filter, so a client whose only invoice is an unsent draft (or a cancelled one) shows that date as 'Last Invoice'.

Evidence: src/app/(app)/clients/page.tsx:9 `supabase.from('documents').select('client_id, date').eq('type', 'invoice').order('date', { ascending: false })`

Fix: Add `.in('status', ['sent','paid','overdue'])` to the query.

Merged with: [ux] 'Invoices' counter and 'Last Invoice' include drafts and cancelled invoices

#### ○ [low] 'vs last month' delta is wrong on the 31st of a month because setMonth(-1) overflows  <sub>bug-p2-13</sub>

`src/app/(app)/dashboard/page.tsx:14` · found by: dashboard-reports, lens:dates-money-i18n

On 31 March, 31 May, 31 July, 31 October and 31 December, `setMonth(getMonth()-1)` lands on a non-existent day (e.g. 31 Feb) and rolls forward into the current month, so lastMonth === thisMonth and the KPI shows '+0% vs last month' regardless of the real figures.

Evidence: src/app/(app)/dashboard/page.tsx:14-15 `const lastMonthDate = new Date(); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1)` / `const lastMonth = lastMonthDate.toISOString().slice(0, 7)`

Fix: Build month keys with `new Date(y, m - 1, 1)` (as the chart does at line 96) instead of mutating today's date.

Merged with: [bug] Dashboard month arithmetic overflows on the 31st and KPI cards mix invoice-date and payment-date bases

#### ○ [low] 'oldest: -Infinityd' when all overdue invoices lack a due date  <sub>bug-p2-14</sub>

`src/app/(app)/dashboard/page.tsx:69` · found by: dashboard-reports

An invoice can be set to status 'overdue' manually (DocumentStatusBar) with due_date null. overdue.length > 0 but the filtered array is empty, so Math.max() returns -Infinity which is rendered in the KPI sub-label.

Evidence: src/app/(app)/dashboard/page.tsx:69-72 `const oldestOverdueDays = overdue.length > 0 ? Math.max(...overdue.filter(i => i.due_date).map(i => Math.floor(...)))`

Fix: Compute on the filtered array and return null when it is empty.

#### ○ [low] 'Recently Paid' is ordered by invoice date, not by payment date  <sub>bug-p2-17</sub>

`src/app/(app)/dashboard/page.tsx:90` · found by: dashboard-reports

The paid query orders by documents.date and the panel takes the first six, so an invoice from January that was paid yesterday is not 'recent' while a last-week invoice paid last week is.

Evidence: src/app/(app)/dashboard/page.tsx:38 `.order('date', { ascending: false })` ; :90 `const recentPaid = paid.slice(0, 6)`

Fix: Sort by the latest payment date (max of payments[].date) before slicing.

#### ○ [low] `md:pb-0` is dead: the inline paddingBottom always wins on desktop  <sub>bug-p3-52</sub>

`src/app/(app)/layout.tsx:17` · found by: shell-ui

The bottom padding reserved for the mobile tab bar is set as an inline style; inline styles beat the `md:pb-0` utility, so on every desktop viewport the main area keeps 5rem (+ safe-area) of empty space below each page.

Evidence: src/app/(app)/layout.tsx:17 `<main className="flex-1 overflow-auto md:pb-0" style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}>`

Fix: Express the padding as utilities: `pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0` and drop the inline style.

#### ○ [low] Report period params are not validated — NaN or out-of-range quarter produces garbage dates and an empty, mislabelled report  <sub>bug-p2-15</sub>

`src/app/(app)/reports/page.tsx:9` · found by: dashboard-reports

parseInt of an invalid year/quarter yields NaN; quarter 5 yields qEnd '2026-15-31'. The Supabase query then errors (docs null), the page shows 'Period: NaN-NaN-01 – NaN-NaN-31 · 0 invoices' and all-zero figures with no error message.

Evidence: src/app/(app)/reports/page.tsx:9-10 `const year = parseInt(yearParam ?? String(currentYear), 10)` / `const quarter = parseInt(quarterParam ?? ..., 10)` ; :14 `const qEnd = `${year}-${String(qEndMonth).padStart(2, '0')}-${qEndMonth === 3 || qEndMonth === 12 ? 31 : ...}``

Fix: Clamp quarter to 1–4 and year to a sane range (fall back to current), and derive qEnd with `new Date(year, quarter*3, 0)`.

#### ○ [low] Fiscal year derived via Date.getFullYear() on a date-only string is timezone dependent  <sub>bug-p2-64</sub>

`src/app/api/bookamat/sync/route.ts:74` · found by: bookamat

`new Date('2026-01-01')` is UTC midnight; on a server with a negative UTC offset getFullYear() returns 2025, posting the booking to the wrong fiscal year. Vercel runs UTC so it currently works, but local dev or a region change silently breaks it.

Evidence: src/app/api/bookamat/sync/route.ts:74 `const year = new Date(paymentDate).getFullYear()`

Fix: Use `Number(paymentDate.slice(0, 4))`.

#### ○ [low] Per-VAT-group rounding can make the booking total differ from the invoice total by a cent  <sub>bug-p2-63</sub>

`src/app/api/bookamat/sync/route.ts:83` · found by: bookamat

Each group is rounded independently with toFixed(2) while the PDF rounds the unrounded total. Example: qty 0.8337 × 10.00 at 20 % (gross 10.0044) plus qty 0.9095 × 10.00 at 10 % (gross 10.0045): PDF total 20.01 (InvoiceDocument.tsx:308), Bookamat 10.00 + 10.00 = 20.00, so the booking does not match the bank receipt.

Evidence: src/app/api/bookamat/sync/route.ts:83 `amount: (g.base + g.amount).toFixed(2),`; src/components/pdf/InvoiceDocument.tsx:308 `{fmt(doc.totals.total)}`

Fix: Round each group, then add the difference to the rounded document total onto the largest group so the sum equals the invoice total exactly.

#### ✓ [low] Cron auth check fails open when CRON_SECRET is unset (accepts `Bearer undefined`)  <sub>bug-p3-20</sub>

`src/app/api/cron/reminders/route.ts:19` · found by: payments-status, data-security

The guard is a plain string comparison against the env var without checking it exists. If the variable is missing or misnamed in Vercel the expected header becomes the literal string `Bearer undefined`, which any caller can send to trigger reminder e-mails from the owner's Gmail to every overdue client.

Evidence: src/app/api/cron/reminders/route.ts:19 `if (auth !== `Bearer ${process.env.CRON_SECRET}`) {`

Fix: `const secret = process.env.CRON_SECRET; if (!secret || !timingSafeEqual(...)) return 401` and fail the build/start if the secret is missing.

Verifier (confirmed, high): src/app/api/cron/reminders/route.ts:18-21: `const auth = req.headers.get('authorization'); if (auth !== `Bearer ${process.env.CRON_SECRET}`) { return 401 }`. With CRON_SECRET unset the template literal yields the literal `Bearer undefined`, so a request with t… — Real fail-open pattern and a one-line fix (`const secret = process.env.CRON_SECRET; if (!secret || auth !== `Bearer ${secret}`)`), but severity is low: it requires the env var to be missing, in which …

#### ○ [low] Callback crashes with a raw 500 when the code exchange fails  <sub>bug-p2-52</sub>

`src/app/api/gmail/callback/route.ts:11` · found by: google

`oauth2.getToken(code)` throws on an expired/reused code (e.g. browser back/reload on the callback URL) or a redirect-URI mismatch. The exception is unhandled, so the user sees Next's error page instead of being redirected to `/settings?gmail=error`.

Evidence: callback/route.ts:11 `const { tokens } = await oauth2.getToken(code)` with no try/catch; :8 only handles the missing-code case

Fix: Wrap the exchange and userinfo fetch in try/catch and redirect to `/settings?gmail=error&reason=...`; also check the `error` query param Google sends on denial.

#### ○ [low] Callback ignores the settings update result, so a failed write still reports 'connected'  <sub>bug-p2-53</sub>

`src/app/api/gmail/callback/route.ts:25` · found by: google

The `update(...)` return value is not checked. If the gmail_* columns do not exist (they are not in any checked-in migration) or RLS rejects the write, the route still redirects to `?gmail=connected` and the toast says 'Gmail connected successfully.' while nothing was stored.

Evidence: callback/route.ts:25-32 `await supabase.from('settings').update({ gmail_email: userInfo.email, ... }).eq('id', settings.id)` followed unconditionally by `return NextResponse.redirect(`${...}/settings?gmail=connected`)`

Fix: Destructure `{ error }` from the update and redirect to `?gmail=error` when set.

#### ○ [low] Credit note conversion drops per-item service_date  <sub>bug-p3-27</sub>

`src/app/api/invoices/[id]/convert-to-credit-note/route.ts:41` · found by: payments-status

The explicit item map omits service_date, so credit notes for session-based invoices lose the per-line dates shown on the original.

Evidence: src/app/api/invoices/[id]/convert-to-credit-note/route.ts:41-53 `document_id: creditNote.id,         sort_order: item.sort_order,         line_type: item.line_type,         description: item.description,         quantity: item.quantity,         unit: item.unit,         unit_price: item.unit_price,         vat_rate: item.vat_rate,         catalogue_item_id: item.catalogue_item_id,         discount_…

Fix: Add `service_date: item.service_date`.

#### ○ [low] Manual reminder route accepts any document id (quotes, credit notes, paid/cancelled invoices)  <sub>bug-p3-31</sub>

`src/app/api/invoices/[id]/reminder/route.ts:24` · found by: payments-status

The select has no type or status filter, so POST /api/invoices/<quoteId>/reminder emails 'Zahlungserinnerung: Rechnung A-2026-003' to the client, and reminding a paid invoice is possible by direct call.

Evidence: src/app/api/invoices/[id]/reminder/route.ts:24-28 `.from('documents')     .select('*, document_items(*), clients(*)')     .eq('id', id)     .single()`

Fix: Add `.eq('type','invoice')` and reject when status is not sent/overdue or balance_due <= 0.

#### ○ [low] {{sender}} in the default reminder template is empty when company_name is blank  <sub>bug-p2-44</sub>

`src/app/api/invoices/[id]/reminder/route.ts:54` · found by: settings

The default reminder bodies shown as placeholders in Settings end with '{{sender}}'. The context builds sender with `settings.company_name ?? settings.owner_name`, but company_name is `not null default ''`, so `??` never falls through and a freelancer who filled only Owner name sends reminders signed with an empty line.

Evidence: src/lib/utils/reminder-templates.ts:45 `{{sender}}``; src/app/api/invoices/[id]/reminder/route.ts:54 `sender: settings.company_name ?? settings.owner_name ?? '',`; schema.sql:9 `company_name          text not null default '',`

Fix: Use `settings.company_name || settings.owner_name || ''` (same in cron/reminders/route.ts:68) and add `{{sender}}`/`{{amount}}` to REMINDER_VARS.

#### ○ [low] Bulk route reports the requested count, not the number of rows actually changed  <sub>bug-p1-45</sub>

`src/app/api/invoices/bulk/route.ts:27` · found by: lists

Both handlers return `body.ids.length` even when rows were filtered out by `.eq('type','invoice')` or RLS, or when ids were stale after a concurrent delete. The toast then claims 'N invoices marked as paid' while fewer (or zero) rows changed.

Evidence: src/app/api/invoices/bulk/route.ts:27 `return NextResponse.json({ updated: body.ids.length })`; :48 `return NextResponse.json({ deleted: body.ids.length })`

Fix: Append `.select('id')` to the update/delete and return `data.length`; validate that `ids` is an array of UUID strings and cap its length.

#### ○ [low] Respond route: unguarded JSON parse and unconditional status update (TOCTOU)  <sub>bug-p3-7</sub>

`src/app/api/portal/[token]/respond/route.ts:24` · found by: portal

`await req.json()` throws on a malformed/empty body → unhandled 500. The status check and the update are separate statements with no `.eq('status', 'sent')` guard, so two concurrent requests (accept in one tab, decline in another, or a double click) both pass the check and the last write wins.

Evidence: src/app/api/portal/[token]/respond/route.ts:6 `const { action } = await req.json()`; :24-27 `.update({ status: action })` / `.eq('id', doc.id)`

Fix: Wrap `req.json()` in try/catch (400 on failure) and make the update conditional: `.update({ status: action }).eq('id', doc.id).eq('status', 'sent').select('id')`, returning 409 when no row was updated.

#### ○ [low] Default Vercel favicon.ico still shipped next to the custom icon  <sub>bug-p3-54</sub>

`src/app/favicon.ico:1` · found by: shell-ui

src/app/favicon.ico is the create-next-app default (rendering it shows the Vercel triangle). Next emits <link rel="icon"> tags for both favicon.ico and icon.tsx; browsers that prefer the .ico (Safari tab/bookmark icons, anything fetching /favicon.ico directly) show the Vercel logo instead of the Mado 'M'.

Evidence: src/app/favicon.ico exists (file: 'MS Windows icon resource - 4 icons, 16x16, 32x32'; rendered via sips: black circle with white triangle) alongside src/app/icon.tsx:19 `<div style={{ color: 'white', fontSize: '20px', fontWeight: '700', fontFamily: 'system-ui' }}>M</div>`

Fix: Delete src/app/favicon.ico or replace it with an .ico export of the 'M' icon.

#### ○ [low] `--font-mono` references an undefined CSS variable, so `font-mono` has no effect (IBAN/BIC, share links render proportional)  <sub>bug-p3-55</sub>

`src/app/globals.css:11` · found by: shell-ui

globals.css maps the mono token to `var(--font-geist-mono)`, but the root layout loads Geist without a `variable` option and never loads Geist Mono (`grep -rn 'variable:' src` -> none), so `--font-geist-mono` is never defined and `font-family: var(--font-geist-mono)` is invalid at computed-value time and falls back to the inherited font. The 7 `font-mono` usages (portal IBAN/BIC lines 283-284, ShareLinkButton URL field, Settings number-format tokens) therefore render in proportional Geist. `--font-sans: var(--font-sans)` on line 10 is also self-referential.

Evidence: src/app/globals.css:10-11 `--font-sans: var(--font-sans);` `--font-mono: var(--font-geist-mono);` ; src/app/layout.tsx:7 `const geist = Geist({ subsets: ["latin"] });` ; src/app/portal/[token]/page.tsx:283 `<div>IBAN: <span className="font-mono">{settings.iban}</span></div>`

Fix: Load `Geist({ variable: '--font-geist-sans' })` and `Geist_Mono({ variable: '--font-geist-mono' })`, put both `.variable` classes on <html>, and set `--font-sans: var(--font-geist-sans)` in @theme inline.

#### ○ [low] Portal pages are indexable by search engines  <sub>bug-p3-10</sub>

`src/app/portal/layout.tsx:2` · found by: portal

Neither the portal layout nor the page exports `metadata`/`generateMetadata` with `robots: noindex`, and there is no `robots.ts` (grep `generateMetadata|metadata` in src/app/portal → none; `ls src/app | grep robots` → none). If a client forwards or posts a link, crawlers can index invoice amounts, bank details and client address.

Evidence: src/app/portal/layout.tsx:1-8 contains only the component; no `export const metadata` in the portal tree

Fix: `export const metadata = { robots: { index: false, follow: false } }` in portal/layout.tsx and add `X-Robots-Tag: noindex` to the PDF response.

#### ○ [low] Catalogue edit allows saving items with empty names, producing blank entries in the invoice picker  <sub>bug-p2-31</sub>

`src/components/forms/CatalogueManager.tsx:54` · found by: clients-catalogue

`saveEdit` sends the draft without validation; both name columns accept '' (`text not null`). The builder's `catalogueName` then returns '' and the picker shows an unlabeled row. `addItem` has a fallback, `saveEdit` does not.

Evidence: src/components/forms/CatalogueManager.tsx:54 `const { error } = await supabase.from('catalogue_items').update(draft).eq('id', editingId)`; contrast :78 `name_de: addDraft.name_de || 'Neuer Eintrag'`

Fix: Require at least one trimmed name before saving and fall back name_de ↔ name_en like `saveNewCatalogueItem` does in the builder.

#### ○ [low] Drag-and-drop lands one row below the blue indicator when dragging downward  <sub>bug-p1-14</sub>

`src/components/forms/DocumentBuilder.tsx:150` · found by: builder-items

The indicator draws a top border on the hovered row (meaning 'insert before'), but handleDrop removes the dragged row first and then splices at the original hovered index, which after removal points one slot further. Dragging A onto C in [A,B,C,D] yields [B,C,A,D] instead of [B,A,C,D]; upward drags behave as indicated.

Evidence: src/components/forms/DocumentBuilder.tsx:148-150 `const next = [...lines]` / `const [moved] = next.splice(dragIdx.current, 1)` / `next.splice(idx, 0, moved)` with :1061 `const dragOverClass = dragOver === idx ? 'border-t-2 border-blue-400' : ''`.

Fix: Compute the insertion index as `idx > dragIdx.current ? idx - 1 : idx` after removal, or render the indicator below the row when dragging downward.

#### ○ [low] 'Mark as sent?' dialog interpolates the raw enum ('credit_note') into user-facing copy  <sub>bug-p5-35</sub>

`src/components/forms/DocumentBuilder.tsx:712` · found by: lens:ux-consistency, builder-items, builder-doc

The confirmation text builds the sentence from the `type` prop, producing 'This will issue a new credit_note number and mark it as sent.' for Gutschriften. The `typeLabel` map with proper names already exists in the same file but is not used here.

Evidence: DocumentBuilder.tsx:712 `? \`This will issue a new ${type} number and mark it as sent. This cannot be undone.\`` and :713 `: \`This will mark ${type} ${doc.number} as sent.\``; typeLabel defined at :64-68

Fix: Use `typeLabel[type].en.toLowerCase()` (or a dedicated English label map) in both strings.

Merged with: [ux] 'Mark as sent?' dialog prints raw enum ('credit_note number'); credit notes show quote label 'Valid until'

#### ○ [low] Form renders but every save is a silent no-op when the settings row is missing; two handlers would throw  <sub>bug-p2-46</sub>

`src/components/forms/SettingsForm.tsx:298` · found by: settings

Props allow `settings: null`. All save functions start with `if (!settings) return` so clicking Save does nothing and shows no message, while disconnectGmail and handleLogoUpload dereference `settings!.id` and throw a TypeError. This state occurs when the seed row was not inserted or `.single()` errors (e.g. two rows).

Evidence: SettingsForm.tsx:11 `interface Props { settings: Settings | null }`; SettingsForm.tsx:298 `if (!settings) return`; SettingsForm.tsx:508 `await supabase.from('settings').update({ logo_url: url }).eq('id', settings!.id)`

Fix: Render an explicit error/empty state ('Settings row not found – run schema.sql') when settings is null and never use the non-null assertion.

#### ○ [low] Gmail disconnect and Drive folder save ignore update errors and always report success  <sub>bug-p2-43</sub>

`src/components/forms/SettingsForm.tsx:439` · found by: settings

Both handlers await the Supabase update without reading `error`, then update local state and toast success. If the update fails (network, RLS, constraint), the UI shows 'Gmail disconnected.' while the tokens remain in the database and the cron keeps sending from that account; similarly 'Drive folder saved.' may be shown without persistence.

Evidence: SettingsForm.tsx:439-445 `await supabase.from('settings').update({\n      gmail_email: null, gmail_access_token: null,\n      gmail_refresh_token: null, gmail_token_expiry: null,\n    }).eq('id', settings!.id)\n    setGmailEmail(null)\n    setDisconnecting(false)\n    toast.success('Gmail disconnected.')`; SettingsForm.tsx:453-460 `await supabase.from('settings').update({ ... }).eq('id', settings.…

Fix: Destructure `{ error }` and bail out with toast.error as the other save functions do; also revoke the Google token (oauth2.revokeToken) on disconnect.

#### ○ [low] Client-side number preview diverges from SQL for repeated tokens and uses browser date  <sub>bug-p2-45</sub>

`src/components/forms/SettingsForm.tsx:555` · found by: settings

previewFormat uses String.replace with string patterns (first occurrence only) whereas the Postgres function replaces every occurrence; a format like '{YY}{MM}-{NNN}-{YY}' previews differently from what is issued. The preview also uses the browser's local date while SQL uses the DB server's current_date (UTC), so around midnight or on year boundaries the preview can show a different year.

Evidence: SettingsForm.tsx:555-557 `return fmt\n      .replace('{prefix}', prefix || '?')\n      .replace('{YYYY}', YYYY)`; schema.sql:169 `result := replace(result, '{prefix}', prefix);`

Fix: Use `replaceAll` (or a global regex) in previewFormat and label the preview as 'example'.

#### ○ [low] ConvertToInvoiceButton stays stuck in 'Converting…' when the route returns a non-JSON error  <sub>bug-p2-16</sub>

`src/components/layout/ConvertToInvoiceButton.tsx:17` · found by: dashboard-reports, payments-status

res.json() is awaited without try/catch; an HTML 500 from Next (e.g. RPC throwing) rejects the promise, the exception escapes the handler, no toast is shown and loading is never reset.

Evidence: src/components/layout/ConvertToInvoiceButton.tsx:16-18 `const res = await fetch(`/quotes/${quoteId}/convert`, { method: 'POST' })` / `const data = await res.json()` / `if (!res.ok) { toast.error(data.error); setLoading(false); return }`

Fix: Wrap in try/catch, use `await res.json().catch(() => ({ error: 'Conversion failed' }))`, and reset loading in finally.

Merged with: [bug] Convert buttons crash on non-JSON error responses

#### ○ [low] Duplicate resets exchange_rate and ignores item insert failures  <sub>bug-p3-28</sub>

`src/components/layout/DuplicateDocumentButton.tsx:60` · found by: payments-status

The header insert omits exchange_rate (DB default 1), so a USD/GBP document with a stored rate duplicates with rate 1; the items insert result is discarded, so 'Duplicated as draft.' is shown even when no items were copied.

Evidence: src/components/layout/DuplicateDocumentButton.tsx:33-48 insert block has no `exchange_rate`; :60 `await supabase.from('document_items').insert(items)`

Fix: Copy exchange_rate; check `{ error }` from the items insert and toast/rollback.

#### ○ [low] 409 'Already synced' response is not adopted by the client, UI keeps offering sync until reload  <sub>bug-p3-1</sub>

`src/components/layout/PaymentPanel.tsx:126` · found by: bookamat

The route returns the existing bookingId with 409, but PaymentPanel only toasts and leaves bookamatId null, so the 'Sync to Bookamat →' link remains and the modal can be reopened.

Evidence: src/components/layout/PaymentPanel.tsx:126-127 `if (res.status === 409) {         toast.info('Already synced to Bookamat.')`; src/app/api/bookamat/sync/route.ts:45 `return NextResponse.json({ error: 'Already synced', bookingId: doc.bookamat_booking_id }, { status: 409 })`

Fix: Read bookingId from the 409 body and call setBookamatId(String(bookingId)).

#### ○ [low] ReminderButton leaves 'Sending…' stuck forever on any thrown error  <sub>bug-p3-25</sub>

`src/components/layout/ReminderButton.tsx:25` · found by: payments-status

generatePdf() and fetch() are awaited without try/catch/finally; a network failure or a PDF exception rejects the handler before setSending(false) runs, leaving the button disabled.

Evidence: src/components/layout/ReminderButton.tsx:25 `const pdf = await generatePdf()`; :28 `const res = await fetch(`/api/invoices/${documentId}/reminder`, {`; :33 `setSending(false)`

Fix: Wrap in try/catch with `finally { setSending(false) }` and toast the error.

#### ○ [low] Unhandled clipboard failure in ShareLinkButton  <sub>bug-p3-9</sub>

`src/components/layout/ShareLinkButton.tsx:57` · found by: portal

`navigator.clipboard.writeText` rejects on non-secure contexts, denied permission or some iOS WebViews. `copyLink` has no try/catch, so the rejection is unhandled, no toast appears, and because `handleCopyWithDrive` awaits it first the optional Drive upload never runs either.

Evidence: src/components/layout/ShareLinkButton.tsx:57 `await navigator.clipboard.writeText(portalUrl)` inside `async function copyLink()` without try/catch; :83 `await copyLink()`

Fix: try/catch around writeText with a fallback (select the read-only input and show 'Press ⌘C') and still continue with the Drive upload.

#### ○ [low] Drive checkbox stays active after Gmail is disconnected (folder id is never cleared)  <sub>bug-p2-54</sub>

`src/components/layout/ShareLinkButton.tsx:84` · found by: google

`disconnectGmail` nulls only the gmail_* columns; `drive_folder_id` survives. Pages compute `driveConfigured={!!settings?.drive_folder_id}`, so the share modal keeps a pre-checked 'Also save to Google Drive' box and every Copy click fires a Drive request that fails with 'Google not connected'.

Evidence: SettingsForm.tsx:439-442 `update({ gmail_email: null, gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null })`; invoices/[id]/page.tsx:47 `driveConfigured={!!settings?.drive_folder_id}`; ShareLinkButton.tsx:18 `useState(driveConfigured)` and :84 `if (saveToDrive && driveConfigured) { await uploadToDrive() }`

Fix: Define driveConfigured as `!!(drive_folder_id && gmail_refresh_token)` in the pages and/or clear drive_folder_id on disconnect.

#### ○ [low] formatDate parses date-only strings as UTC and formats in the runtime's local zone (wrong day west of UTC)  <sub>bug-p5-6</sub>

`src/lib/utils/document.ts:119` · found by: lens:dates-money-i18n, pdf

formatDate does new Date('2026-10-09') (UTC midnight) and formats with Intl in the local timezone. On the server (UTC) and in Vienna this is fine, but the invoice PDF is generated in the browser (DocumentBuilder → pdf().toBlob()), so if the owner issues or re-sends an invoice while travelling in a zone west of UTC every date on the PDF (Datum, Leistungsdatum, Fälligkeitsdatum, per-line service dates) is printed one day early. Verified: TZ=America/New_York formatDate('2026-10-09') → '08.10.2026'.

Evidence: src/lib/utils/document.ts:117-124 `const d = new Date(date)\n  if (isNaN(d.getTime())) return date\n  return new Intl.DateTimeFormat(lang === 'de' ? 'de-AT' : 'en-GB', {\n    day: '2-digit', month: '2-digit', year: 'numeric'\n  }).format(d)`; client-side PDF: src/components/forms/DocumentBuilder.tsx:345-347 `const blob = await pdf(<InvoiceDocument ... />).toBlob()`.

Fix: Pass `timeZone: 'UTC'` to Intl.DateTimeFormat (the string is a pure calendar date), or split the string and format `new Date(y, m-1, d)`.

Merged with: [bug] formatDate parses ISO dates as UTC midnight and formats in the local timezone

#### ○ [low] EPC unstructured remittance is truncated at 35 characters (the structured-reference limit) and mislabeled  <sub>bug-p4-23</sub>

`src/lib/utils/epc-qr.ts:29` · found by: lens:dunning-payment-terms

The payload places the reference in the unstructured 'Remittance Information' slot, which the EPC guideline allows up to 140 characters; 35 is the limit of the structured slot. Today the reference is just the invoice number so nothing is cut, but any richer reference (e.g. 'Rechnung R-2026-012 vom 01.10.2026') would be silently truncated. Rest of the payload is conformant: 'BCD', '002', '1', 'SCT', BIC (optional, ≤11), name ≤70, IBAN, `EUR` + toFixed(2), empty purpose/structured ref, LF separators, EC level M.

Evidence: src/lib/utils/epc-qr.ts:29 `const cleanRef = reference.slice(0, 35)`; :43-44 `'',           // Remittance reference (structured, empty)` / `cleanRef,     // Remittance information (unstructured)`.

Fix: Use `reference.replace(/[\r\n]/g, ' ').slice(0, 140)` for the unstructured field; if a structured reference is ever used, put it in field 10 with the 35-char limit.

#### ○ [low] MIME headers are built from unsanitized strings (CRLF header injection via the editable 'To' field)  <sub>bug-p2-55</sub>

`src/lib/utils/reminder.ts:15` · found by: google

`buildMime` interpolates `to`, `from` and `filename` straight into header lines. A value containing `\r\n` (pasted from a contact list, or a crafted client email stored in the DB) adds arbitrary headers such as `Bcc:`. Only the owner can trigger it today, but client emails are stored data.

Evidence: reminder.ts:14-15 ``From: ${from}`, `To: ${to}`` and :28 ``Content-Disposition: attachment; filename="${filename}"``; DocumentBuilder.tsx:659-663 free-text `<input value={gmailPreview.to} ...>`

Fix: Strip `[\r\n]` from all header values, validate recipients with a simple address regex (allow comma-separated list), and RFC 2047/2231-encode non-ASCII names/filenames – or build the message with a library (nodemailer MailComposer / mimetext).

### Missing capabilities (67)

#### ○ [high] Credit notes never reach Bookamat (and would post positive amounts)  <sub>missing-merge-54</sub>

`src/app/api/bookamat/sync/route.ts:107` · found by: bookamat, lens:small-business-tax

A refunded/cancelled invoice stays as income in Bookamat. PaymentPanel with the Bookamat prompt is only mounted on the invoice page; the credit-note page renders DocumentBuilder alone, and the sync route has no credit-note branch or sign handling for `type = 'credit_note'` (description is hard-coded 'Invoice'). After a Storno the user's Bookamat income stays overstated unless they book the correction manually.

Evidence: grep -rn 'PaymentPanel|bookamat' 'src/app/(app)/credit-notes' → no matches; src/app/(app)/credit-notes/[id]/page.tsx:44-50 renders `<DocumentBuilder type="credit_note" ... />` with no PaymentPanel; src/components/layout/InvoicePageClient.tsx:63-71 is the only `<PaymentPanel ... bookamatConfigured ... />`; src/app/api/bookamat/sync/route.ts:107 `description: `Invoice ${doc.number ?? ''} | …`` and :…

Fix: Add a 'Sync to Bookamat' action on sent credit notes that posts a negative/expense-side booking (or Bookamat's storno mechanism) with `vatin` and a reference to the original invoice's booking id; negate amounts in the sync route when `doc.type === 'credit_note'` and surface it on the credit-note page.

#### ○ [high] No multi-stage dunning (1./2./3. Mahnung), reminder history, Verzugszinsen/Mahnspesen, new deadline, global/per-client opt-out or grace period: the cron emails every client once the morning after the due date and never again  <sub>missing-merge-39</sub>

`src/app/api/cron/reminders/route.ts:36` · found by: clients-catalogue, settings, payments-status, data-security, lens:dunning-payment-terms, lens:freelancer-workflows

vercel.json runs /api/cron/reminders daily at 08:00 and the route emails every invoice with status 'overdue' and no reminder_sent_at, i.e. the morning after the due date, to every client, with no grace period, no global or per-client opt-out, no repeat interval, no per-invoice pause for disputed invoices and no reminder language override; the only way to stop it is to disconnect Gmail. A studio owner has friends and long-term partners with informal payment arrangements and needs to control this. Austrian practice escalates Zahlungserinnerung → 1. Mahnung → 2. Mahnung → letzte Mahnung/Inkasso with a new deadline (Nachfrist) each time, plus Mahnspesen (flat EUR 40 B2B, § 458 UGB) and Verzugszinsen (9.2 pp over base rate B2B § 456 UGB, 4 % B2C § 1000 ABGB). The app stores only a single reminder_sent_at timestamp per invoice and one DE/EN template pair (four settings columns), the cron sends exactly once (reminder_sent_at IS NULL) and never follows up; the manual Resend overwrites the date so there is no record of how many reminders went out, and a manual reminder also sets reminder_sent_at, which then suppresses the automatic one forever. The reminder context has no fields for interest, fee or a new deadline and the default templates just restate the original due date; markOverdueInvoices is only defined, never called. grep -rni 'reminders_enabled|auto_remind|reminder_days|grace|opt_out|no_reminder|send_reminders|mahn|dunning|late_fee|reminder_level|verzug|interest|mahnspesen' src supabase vercel.json → no matches.

Evidence: vercel.json:4-5 `"path": "/api/cron/reminders", "schedule": "0 8 * * *"`; src/app/api/cron/reminders/route.ts:31-36 `.eq('type', 'invoice') .eq('status', 'overdue') .is('reminder_sent_at', null)` and :154 `.update({ reminder_sent_at: new Date().toISOString() })`; :46-47 `const client = invoice.clients` / `if (!client?.email) continue`; src/app/api/invoices/[id]/reminder/route.ts:86 `.update({ remi…

Fix: Add settings reminders_enabled (default false), reminder_grace_days, reminder_interval_days, max_level and interest/fee basis (B2B 9.2 pp over base rate / B2C 4 %, Mahnspesen EUR 40 B2B) surfaced in a 'Reminders' card; add `clients.auto_reminders boolean` (+ optional grace) exposed in ClientForm and `documents.reminders_paused`; add a `reminders` table (document_id, level, sent_at, channel, balance_at_send, fee, interest, new_due_date) with per-level templates and cadence; compute interest = balance_due × rate × days/365 per level and add {{interest}}, {{fee}}, {{amount_incl_fees}}, {{new_due_date}} (e.g. +7 days) template variables; have the cron honour all of it and escalate; call markOverdueInvoices from the cron.

#### ○ [high] No handling for revoked/expired refresh tokens (invalid_grant) and no reconnect prompt; cron fails silently  <sub>missing-merge-49</sub>

`src/app/api/cron/reminders/route.ts:163` · found by: google

When Google rejects the refresh token the send/upload routes 500, the cron only logs errors, and Settings keeps showing 'connected'. With an OAuth consent screen in Testing status this happens every 7 days, so reminders stop without the owner noticing.

Evidence: grep -rni 'invalid_grant' src → no matches; cron/reminders/route.ts:158-164 pushes errors to an array that is only console.logged; send/route.ts has no try/catch

Fix: Catch `invalid_grant`/401 centrally, null the tokens and set a `gmail_error` column; surface a banner in the app/dashboard and in Settings; optionally notify via the fallback `settings.email`.

#### ○ [high] No audit trail or email dispatch history: no sent_at/issued_at, no record of when/to whom an invoice was emailed (Gmail message/thread id discarded), and status 'sent' is set on number allocation before (and regardless of) the actual Gmail send  <sub>missing-merge-11</sub>

`src/app/api/gmail/send/route.ts:37` · found by: builder-doc, google, lens:e-invoicing-archival, lens:freelancer-workflows

The only timestamps on a document are created_at and reminder_sent_at. Status is a single mutable column; the Gmail send route sends the message and returns `ok` without persisting recipient, subject, timestamp or Gmail message/thread id (which could also be used to send reminders as replies in the same thread); re-sending an already-sent invoice records nothing; the share-link, Drive upload, payment removal and status changes leave no record. ensureNumberAndSave sets `status: 'sent'` as a side effect of Download PDF, Save to Drive and Send via Gmail, before the Gmail request is made and even if it fails, so 'sent' really means 'numbered' and there is no way to see whether, when and to which address an invoice was actually emailed, which matters for dunning (Mahnwesen) and disputes. There is no open/delivery tracking and no per-document activity timeline. grep -rniE 'audit|history|status_history|document_events|sent_at|issued_at|email_log|message_id|thread|opened_at' src supabase → only reminder_sent_at.

Evidence: src/app/api/gmail/send/route.ts:37-39 `await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })  return NextResponse.json({ ok: true })` (send result discarded, nothing written to documents); supabase/schema.sql:100 `status text not null default 'draft' check (...)` is the only status field; src/components/forms/DocumentBuilder.tsx:370-375 `status: 'sent' as const` inside ensureNumb…

Fix: Introduce an `issued` status (number assigned) separate from `sent`, with `issued_at timestamptz` set once; add `document_events(id, document_id, type, at, actor, payload jsonb)` / `document_emails(document_id, kind, to, subject, gmail_message_id, gmail_thread_id, sent_at)` written on issue, send (by /api/gmail/send and the reminder routes), share, Drive upload, payment and status changes; show a 'Sent 12.10.2026 to x@y.at' timeline on the document page.

#### ○ [high] Drive archiving is optional and fire-and-forget: absent from 'Mark as sent' and 'Download PDF', unawaited after Gmail send, no folder structure (per year / per type), and drive_file_id is never shown (result only a 5-second toast)  <sub>missing-merge-52</sub>

`src/components/forms/DocumentBuilder.tsx:587` · found by: google, lens:e-invoicing-archival, lens:ux-flows

An Austrian freelancer must keep every issued invoice for 7 years; today archiving depends on remembering the Drive checkbox/button. Only two paths touch Drive: the Gmail dialog (checkbox, default on, result not awaited and failures only toasted) and the explicit 'Save to Drive' button. Marking a document as sent via save('sent') never uploads anything; 'Download PDF' saves to the local disk only; the share-link dialog checkbox can be unticked. All document types land flat in one folder. After upload the only feedback is a toast with an 'open' link that disappears after 5 s; drive_file_id is persisted but no page reads it (grep -rn drive_file_id src --include='*.tsx' → none), so the owner cannot tell whether an invoice was archived or open the file later. For a studio owner sending dozens of invoices a year, the archive silently misses whichever ones went out via a path that skipped Drive or hit a Google token error.

Evidence: src/components/forms/DocumentBuilder.tsx:587 `if (gmailPreview.uploadToDrive) void uploadToDrive(gmailPreview.pdfBase64, gmailPreview.filename, gmailPreview.newDocId ?? doc?.id)` (unawaited); :264-318 `async function save(status: 'draft' | 'sent') { ... }` contains no Drive/upload call; :717 `onClick={() => { setShowSentConfirm(false); save('sent') }}`; :686-690 `<input type="checkbox" checked={gm…

Fix: Make archiving a side effect of issuance, not of sending: add a setting 'Archive every issued document to Drive automatically' that triggers drive-pdf when a number is assigned (and after each Gmail send), store the PDF, enqueue/retry the upload on failure; create/lookup `<Year>/<Rechnungen|Angebote|Gutschriften>` subfolders; show an 'Archived ✓ / In Drive · open' chip in the document header when drive_file_id is set (store webViewLink or build it from the id).

Merged with: [ux] Settings copy promises auto-upload to Drive on download, which does not exist

#### ○ [high] No draft persistence for new documents and no unsaved-changes guard: a long invoice or dirty settings are lost on navigation, back swipe or reload  <sub>missing-merge-7</sub>

`src/components/forms/DocumentBuilder.tsx:623` · found by: builder-items, lens:ux-a11y-forms, settings, lens:ux-flows

A new invoice/quote/credit note is held only in React state until 'Save draft' or 'Mark as sent' is pressed; autosave is skipped until the document exists (nothing is created on first edit). There is no beforeunload handler (grep -rn beforeunload src → empty) and no client-side navigation guard; the sidebar, the mobile bottom tab bar and dashboard links navigate instantly. Settings likewise shows a per-section 'Save changes' only when dirty and discards edits on leave. On the phone the bottom tab bar sits directly under the document action bar, so a mis-tap on 'Dashboard' or an accidental back swipe throws away a half-built twenty-line invoice.

Evidence: src/components/forms/DocumentBuilder.tsx:622-624 `useEffect(() => { if (!doc) return` and :605 `if (!doc || !clientId || saving) return`; :626 `setTimeout(autoSave, 2000)`; new-doc persistence only in `save()` :264-318 and Ctrl+S at :630-640; grep -rn 'beforeunload' src → no matches; SettingsForm.tsx:102-113 `{dirty && ( … <button … onClick={onSave}>` with no leave guard; MobileHeader.tsx:56-77 bo…

Fix: Create a draft row on first meaningful change (or on page open) and switch the builder into 'existing doc' mode; track a `dirty` flag (new doc: any edit; existing doc: edits since last successful autosave; settings: any dirty section), add a beforeunload listener while dirty, and intercept in-app navigation (a shared `useUnsavedChanges` hook that confirms before router.push/Link click).

Merged with: [ux] No unsaved-changes protection: new documents (no autosave) and dirty Settings sections are lost silently on navigation

#### ○ [high] No service period (Leistungszeitraum from–to), no fallback text, and no check that a service date exists before issuing  <sub>missing-merge-3</sub>

`src/components/forms/DocumentBuilder.tsx:790` · found by: builder-items, builder-doc, pdf, lens:rechnungsmerkmale, lens:freelancer-workflows, lens:dates-money-i18n

§ 11 Abs 1 Z 3 lit d / Z 4 UStG requires the day or period of supply on every invoice. Both the document and each line carry a single optional service_date; there is no end date, so multi-day sessions, a mixing week or a month of engineer work cannot be stated as 'Leistungszeitraum 03.–07.03.2026' or 'März 2026' except by misusing headings/notes/descriptions, although multi-day sessions are the normal case for studio day rates. Issuing with no service date anywhere is allowed (save()/ensureNumberAndSave only check client and ≥1 item line) and the PDF simply omits the line when it is empty, with no 'Leistungsdatum entspricht Rechnungsdatum' fallback. An invoice without Leistungsdatum exposes the client to a Vorsteuer refusal and the owner to a Finanzamt query. grep -rni 'service_period|service_date_end|period_from|period_start|period_end|date_from|leistungszeitraum' src supabase → no results.

Evidence: src/components/forms/DocumentBuilder.tsx:790-791 `<Label>Service date</Label><Input type="date" value={serviceDate} ...>` (single date only); :264-266 `async function save(status: 'draft' | 'sent') { if (!clientId) { toast.error('Select a client.'); return } if (!lines.some(l => l.line_type === 'item')) { toast.error('Add at least one line item.'); return }` (no service_date check; same at :360-36…

Fix: Add service_date_end / service_period_end (document and line, or derive from line service dates), a 'single day / period' (Leistungszeitraum) toggle in the builder, and print 'Leistungszeitraum: 03.03.–07.03.2026' on the PDF when an end date is set; on 'Mark as sent' / ensureNumberAndSave require a document service_date (or per-line service dates) for invoices and credit notes, otherwise block with a clear toast or default to the invoice date with the standard note 'Leistungsdatum entspricht Rechnungsdatum'.

#### ○ [high] No cancellation (Storno) workflow for issued invoices: 'cancelled' is a bare status change with no Stornorechnung, no reason, no handling of payments/Bookamat/Drive artifacts, and the invoice stays editable  <sub>missing-merge-14</sub>

`src/components/layout/DocumentStatusBar.tsx:67` · found by: builder-doc, payments-status

The status bar can flip an invoice to 'cancelled' after a confirm, but nothing creates the required cancellation document or links it; the only alternatives are hard delete or a manual credit note. There is no mandatory reason, no handling of existing payments or Bookamat/Drive artifacts, and the invoice remains fully editable (autosave has no status gate). Combined with free deletion, there is no compliant way to void an issued invoice.

Evidence: src/components/layout/DocumentStatusBar.tsx:13 `const DESTRUCTIVE = new Set(['cancelled', 'rejected'])` (only a confirm) → :67 `const { error } = await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)` (plain status update); no code path creates a storno document; src/components/forms/DocumentBuilder.tsx:604-605 `const autoSave = useCallback(async () => { if (!doc || !clie…

Fix: On 'cancelled' for a numbered invoice, auto-create a credit note/Storno referencing it (the convert-to-credit-note route exists), require a reason, lock both documents, and handle existing payments and external artifacts; lock editing once `number` is set.

#### ○ [high] No accountant-grade or full data export: the only export is an 8-column gross invoice CSV (no net/VAT split, tax treatment, UID, payment date, credit notes), the VAT report has no export, no backup/JSON dump, bulk PDF/ZIP or import, and no per-client / per-year revenue breakdown  <sub>missing-merge-34</sub>

`src/components/lists/InvoiceList.tsx:51` · found by: dashboard-reports, lens:small-business-tax, lens:e-invoicing-archival, lens:freelancer-workflows

InvoiceList.exportCSV writes Number, Client, Company, Date, Due Date, gross Total, Currency, Status — no line items, net, VAT per rate, tax treatment, client UID, payment date/amount, exchange rate or credit notes; quotes, credit notes and clients have no export at all; the VAT report page has no export; there is no JSON/SQL dump, no bulk PDF/ZIP download, no scheduled backup and no import (grep -rniE 'backup|dump|jszip|archiver|importData|xlsx|excel|datev|bmd' src → none). PDFs can only be downloaded one by one or archived to Drive if the user clicks the Drive option each time. A Steuerberater needs at minimum a per-document net/VAT/treatment list by payment date (Ist) to prepare the UVA/E1a and BMD/DATEV-style imports need those columns; there is no Umsatz je Kunde / Jahresumsatz view for the Einkommensteuer. The comma-delimited dot-decimal file opens incorrectly in de-AT Excel. The Supabase project is the single copy of seven years of records, and § 131 Abs 3 / § 132 BAO require handing records to the Finanzamt on a data carrier in readable form.

Evidence: src/components/lists/InvoiceList.tsx:51-64 `function exportCSV(invoices: Invoice[]) { const rows = [ ['Number', 'Client', 'Company', 'Date', 'Due Date', 'Total', 'Currency', 'Status'], ...` and :65 `.join(',')`; :176-182 `function handleExport() { ... exportCSV(toExport)`; grep -rniE 'csv|backup|dump|export' src --include='*.ts' --include='*.tsx' returns only this function; src/app/(app)/reports/p…

Fix: Add an 'Export for accountant' action (per period) producing a semicolon-delimited, de-AT formatted CSV/XLSX with number, type (invoice/credit note sign), invoice date, service date, client, client UID, country, tax treatment, currency, exchange rate, net per rate (20/13/10/0), VAT per rate, gross, payment dates/amounts; add a Settings → Data page with a full JSON export of settings/clients/documents+items+payments+events, per-year or filtered ZIP of all issued PDFs via a server route using renderToBuffer, a CSV client import, and a CSV/PDF export of the report period plus a client and yearly revenue table.

#### ○ [high] Net amount per VAT rate and per-line VAT rate are not shown on the PDF  <sub>missing-merge-16</sub>

`src/components/pdf/InvoiceDocument.tsx:299` · found by: pdf, lens:rechnungsmerkmale, lens:small-business-tax

§ 11 Abs 1 Z 3 lit e/f UStG requires the Entgelt split per tax rate when several rates apply, and readers must be able to tell which line carries which rate. calcTotals already returns vat_groups[].base, but the line table has Description/Qty/Rate/Amount only (no VAT column) and the totals block prints one overall 'Nettobetrag' plus only 'USt. 20% <amount>' per rate; the taxable base per rate is omitted (grep '\.base' and 'vat_rate' in InvoiceDocument.tsx: the only hit is the `vat_rate: VatRate | null` type field at line 98). On a mixed invoice (e.g. 20 % studio rental + 13 % artistic service) the recipient cannot tell which Entgelt belongs to which rate. Single-rate invoices are fine.

Evidence: src/components/pdf/InvoiceDocument.tsx:299-304 `{doc.tax_treatment === 'at_vat' && doc.totals.vat_groups.map(g => (<View ...><Text style={s.totalsLabel}>USt. {g.rate}%</Text><Text>{fmt(g.amount)}</Text></View>))}` (amount only, not `g.base`); :198-203 header `L('description')`, `L('qty')`, `L('rate')`, `L('amount')` (no VAT column); item row :259-271 prints description, quantity, unit_price/unit, …

Fix: When `vat_groups.length > 1` print 'Netto {rate}%: {base}' before each 'USt. {rate}%: {amount}' row (or a small tax table) and add a 'USt.' column / rate suffix on item rows; keep the compact layout for single-rate invoices.

#### ○ [medium] No .env.example / documentation of required environment variables  <sub>missing-merge-67</sub>

`README.md:1` · found by: data-security

Seven env vars are required (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, NEXT_PUBLIC_APP_URL) but none is documented; README is the create-next-app boilerplate. A missing NEXT_PUBLIC_APP_URL yields the OAuth redirect 'undefined/api/gmail/callback'.

Evidence: grep -rn 'process\.env\.' src lists the 7 names (src/lib/google/client.ts:5-7, src/lib/supabase/service.ts:6-7, src/app/api/cron/reminders/route.ts:19 …); ls -a | grep -E '^\.env' → nothing; README.md:1 'This is a [Next.js](https://nextjs.org) project bootstrapped with create-next-app'

Fix: Commit .env.example with every key and a one-line purpose; add a startup assertion for the server-only ones.

#### ○ [medium] No balance-due / partial-payment information in the invoice list  <sub>missing-merge-21</sub>

`src/app/(app)/invoices/page.tsx:10` · found by: lists

The payments table and PaymentPanel exist, but the invoices page does not select payments and the list shows only the gross total. A partially paid invoice looks identical to an unpaid one, and nothing shows 'offen' amounts or a sum of the filtered rows.

Evidence: grep -n 'payments' src/app/(app)/invoices/page.tsx src/components/lists/InvoiceList.tsx → no matches; src/app/(app)/invoices/page.tsx:10 selects only `clients(name, company), document_items(…)`

Fix: Select `payments(amount, date)`, compute balance_due via calcTotals, add a 'Paid/Open' column and a footer with Σ total / Σ open for the current filter.

#### ○ [medium] ZM (Zusammenfassende Meldung) has no per-recipient UID breakdown  <sub>missing-merge-74</sub>

`src/app/(app)/reports/page.tsx:96` · found by: lens:small-business-tax

The report shows one aggregate reverse-charge figure and tells the user to 'report this in FinanzOnline under ZM', but the ZM must list, per period, each EU recipient's UID with the net amount of 'sonstige Leistungen'. The query does not even join clients, so the user must open every RC invoice by hand each quarter. No other ZM support exists (grep 'zusammenfassende|\bZM\b' matches only these two lines).

Evidence: src/app/(app)/reports/page.tsx:19 `.select('*, document_items(*)')` (no clients join); :44-45 `} else if (doc.tax_treatment === 'eu_reverse_charge') { reverseChargeBase += net`; :96 `EU Reverse Charge volume this quarter: {formatMoney(reverseChargeBase)}. Report this in FinanzOnline under ZM.`

Fix: Join `clients(uid_number, company, name, country)` and render a ZM table grouped by `uid_number` (country code, UID, net sum, flag 'sonstige Leistung'), flagging RC invoices whose client has no UID; offer CSV export of that table.

#### ○ [medium] No password reset, magic link or MFA for the single owner account  <sub>missing-merge-68</sub>

`src/app/(auth)/login/page.tsx:22` · found by: data-security, shell-ui, lens:ux-flows

The login page offers only email+password via signInWithPassword; there is no 'Forgot password' link, no /reset route and no auth callback. For a single-owner tool a forgotten password locks the owner out until they use the Supabase dashboard.

Evidence: grep -rn 'signUp|resetPasswordForEmail|signInWithOtp|updateUser|mfa|forgot' src → no matches; src/app/(auth)/login/page.tsx:22 `const { error } = await supabase.auth.signInWithPassword({ email, password })`; :35-60 form contains only email, password and the submit button, no link or secondary action

Fix: Add a 'Forgot password?' link calling supabase.auth.resetPasswordForEmail with a redirect to a /reset-password page that calls auth.updateUser, plus the auth callback route; or offer a magic-link sign-in; optionally TOTP MFA (supabase.auth.mfa).

Merged with: [ux] Login page offers no password-reset path and mixes languages

#### ○ [medium] Email sending limited to a single To address: no CC/BCC (self/accounting), Reply-To, sender display name or signature, and only one contact/email per client  <sub>missing-merge-15</sub>

`src/app/api/gmail/send/route.ts:17` · found by: builder-doc, settings, google, clients-catalogue, lens:freelancer-workflows

Clients have exactly one name/email/phone; sending and reminders go only there, and the Gmail modal has only To, Subject, Body — the send route accepts no cc/bcc and the MIME builder emits only From/To/Subject. Labels and agencies usually want the booker on To and accounting (buchhaltung@) on CC, and many freelancers BCC themselves or a bookkeeping inbox for the records. Emails go out as bare `From: <gmail address>` with no display name ('Tree House Studios'); replies land on the Gmail account even if the business address (settings.email) differs; there is no fixed signature block. grep -rni 'bcc|reply_to|replyTo|Reply-To|signature|contacts|contact_person|billing_email|cc_email' src supabase → no hits.

Evidence: src/app/api/gmail/send/route.ts:17 `const { to, subject, body, pdfBase64, filename } = await req.json()`; src/lib/utils/reminder.ts:13-16 `const lines = [ `From: ${from}`, `To: ${to}`, `Subject: ...` with `from: settings.gmail_email` (send/route.ts:35); src/components/forms/DocumentBuilder.tsx:656-683 modal fields are To, Subject, Body only; :566 `setGmailPreview({ to: client.email, ...`; supabase…

Fix: Add a `client_contacts` table (name, email, role, default_to/cc) or at least `billing_email` and `cc_emails text[]` on clients and use them in Gmail send and reminders; add optional Cc/Bcc fields to the Gmail preview and MIME builder with settings email_bcc_self ('always BCC me'), email_reply_to and email_signature; use `From: =?UTF-8?B?<company>?= <gmail>` and `Reply-To: settings.email` when it differs; persist the Gmail message id on the document.

#### ○ [medium] Portal link is not available in emails (send dialog, reminders)  <sub>missing-merge-59</sub>

`src/app/api/gmail/send/route.ts:17` · found by: portal

The Gmail send route only relays subject/body/attachment and the reminder templates have no `{{portal_link}}` placeholder, so clients get a PDF but never the link to view/accept online. grep -rn '/portal' src → only src/components/layout/ShareLinkButton.tsx:22.

Evidence: src/app/api/gmail/send/route.ts:17 `const { to, subject, body, pdfBase64, filename } = await req.json()`; src/lib/utils/reminder-templates.ts:34-45 placeholders are invoice_number, client, amount, due_date, days_overdue, iban, sender only

Fix: Auto-create the share token when sending and expose `{{portal_link}}` in invoice/quote/reminder templates (default bodies include 'Online ansehen: …').

#### ○ [medium] Quote lifecycle gaps: 'valid until' (due_date) is never enforced (portal accepts expired quotes) or surfaced (no column/expired state in QuoteList, dashboard lists sent quotes forever), portal accept/decline is not recorded (who/when/IP) and the owner is not notified; no versioning of edited sent quotes  <sub>missing-merge-23</sub>

`src/app/api/portal/[token]/respond/route.ts:22` · found by: lists, dashboard-reports, portal, data-security, lens:lifecycle-integrity, lens:freelancer-workflows

Quotes store their 'valid until' in due_date (the portal labels it 'Gültig bis'), but no code reads it: the portal accept endpoint only checks type/status and the UI shows Accept/Decline for any quote in status 'sent', so a client can accept a months-old day-rate quote online after prices changed; quotes keep status 'sent' forever (only invoices are flipped to overdue, and even that function is unused); QuoteList has no 'Valid until' column, sort or 'expired' indication; DocumentStatus has no 'expired' and the dashboard's Pending Quotes list never flags lapsed quotes. A click on 'Angebot annehmen' is a binding acceptance, but the respond route only flips the status: nothing records when or by whom (no responded_at/accepted_by/IP/user agent) and no e-mail/notification reaches the owner, who must notice the badge change by chance when opening the quote list (so the studio cannot block the dates). Editing a sent quote overwrites it in place with no revision history or 'v2' numbering. grep -rn 'accepted_at|responded_at|accepted_by|viewed_at|expired|notify' src supabase → no results.

Evidence: src/app/api/portal/[token]/respond/route.ts:21-22 `if (doc.type !== 'quote') …` / `if (doc.status !== 'sent') …` (no due_date check); :24-31 `await supabase.from('documents').update({ status: action }).eq('id', doc.id)` … `return NextResponse.json({ ok: true, status: action })` (only write, no notification); src/app/portal/[token]/page.tsx:300 `{docType === 'quote' && doc.status === 'sent' && (`; …

Fix: Select `due_date` in the respond route and reject with 410 when `due_date < today`; on the portal replace the buttons with 'Dieses Angebot ist abgelaufen – bitte kontaktieren Sie uns'; add a 'Valid until' column and an 'expired' pseudo-status/filter (sent && due_date < today) mirroring the invoice overdue logic, mark such quotes in the dashboard (optionally an 'expired' status set by the cron); add `responded_at`, `responded_by` (optional name/email field in the portal form), `responded_ip`, `responded_user_agent` (or a document_events table) and show them on the quote page; on accept/reject send the owner a notification email via the existing Gmail helper and an 'Accepted — convert to invoice' dashboard card; create a revision when editing a sent quote.

#### ○ [medium] No structured country (ISO code) and no automatic tax-treatment suggestion  <sub>missing-merge-36</sub>

`src/components/forms/ClientForm.tsx:144` · found by: clients-catalogue

Country is free text, so nothing can derive 'Austria → at_vat', 'EU + UID → reverse charge', 'non-EU → non_eu', and the same country may be spelled differently across clients. grep -rn -i 'country_code|COUNTRIES|EU_COUNTRIES|isEu' src → no hits.

Evidence: src/components/forms/ClientForm.tsx:144 `<Field label="Country" name="country" defaultValue={client?.country ?? ''} />`; supabase/schema.sql:53 `country       text not null default '',`

Fix: Add a `country_code` column with a select of ISO-3166 codes (localised names), derive the default tax treatment and warn when treatment and country disagree.

#### ○ [medium] No client-specific prices / rate cards  <sub>missing-merge-79</sub>

`src/components/forms/DocumentBuilder.tsx:224` · found by: lens:freelancer-workflows

The catalogue has one `default_price` per item and `pickCatalogueItem` always inserts that price; there is no per-client override, discount percentage, or negotiated day rate. A studio routinely has different day rates for labels vs. independent artists vs. long-term engineers' clients and must remember and retype them each time. grep 'client_price|price_list|rate_card|client_rate' src supabase → 0 hits.

Evidence: supabase/schema.sql:67-77 `create table catalogue_items (... default_price numeric(10,2) ...)`; src/components/forms/DocumentBuilder.tsx:221-228 `function pickCatalogueItem(item, lineId) { updateLine(lineId, { description: catalogueName(item), unit_price: item.default_price, ...`

Fix: Add `client_prices (client_id, catalogue_item_id, price)` and/or `clients.default_discount_percent`; in pickCatalogueItem prefer the client-specific price, and show a 'client rate' badge.

#### ○ [medium] No separate account-holder name: EPC QR beneficiary and payment footer use the trade name (Verification-of-Payee mismatch risk), and no invoice-number remittance wording  <sub>missing-merge-18</sub>

`src/components/forms/DocumentBuilder.tsx:337` · found by: pdf, lens:dunning-payment-terms

The QR `name` field and the PDF payment block print settings.company_name ('Tree House Studios'), but an Austrian Einzelunternehmer's business account is usually held in the owner's name. Since the EU Instant Payments Regulation made Verification of Payee mandatory (Oct 2025), a name that does not match the IBAN produces a 'no match' warning in the client's banking app for every scanned invoice. There is no account_holder field in Settings (grep 'account_holder' src → 0) and the remittance text does not use 'Rechnung {number}' wording.

Evidence: src/components/forms/DocumentBuilder.tsx:337 `name: settings.company_name,`; src/app/portal/[token]/pdf/route.ts:39 and src/app/api/documents/[id]/drive-pdf/route.ts:43 same; src/lib/utils/epc-qr.ts:28 `const cleanName = name.slice(0, 70)`; src/components/pdf/InvoiceDocument.tsx:339-342 `{settings.company_name}{'\n'}...{'IBAN: '}{settings.iban}`; src/types/index.ts:11-80 Settings has `iban`, `bic`…

Fix: Add settings.account_holder (default owner_name, fallback company_name), use it for the EPC beneficiary name and as the first line of the payment block, keep company_name only as the document header, and use 'Rechnung {number}' as the remittance text.

#### ○ [medium] No quick-add client from the document builder; the new-client flow ends on the client list  <sub>missing-merge-41</sub>

`src/components/forms/DocumentBuilder.tsx:730` · found by: clients-catalogue, lens:ux-flows

The client select only lists existing clients and there is no inline 'New client' option (grep -n 'clients/new|new client' DocumentBuilder.tsx → nothing). Creating a client redirects to /clients, not to the new client's page or back to the document. 'Create an invoice for a new client' therefore takes: leave builder (losing work) → Clients → New Client → fill → save → list → find client → open → '+ Invoice' → rebuild lines. For a studio that onboards new bands weekly this is the most common first step.

Evidence: src/components/forms/DocumentBuilder.tsx:730-736 `<select value={clientId} ...><option value="">Select client…</option>{clients.sort(...).map(...)}` (only existing clients); src/components/forms/ClientForm.tsx:115 `router.push('/clients')` after insert

Fix: Add a '+ New client…' option that opens ClientForm in a dialog and selects the created client, or a `?returnTo=` round-trip; after creating a client from /clients/new redirect to /clients/<id>.

Merged with: [ux] After creating a client you are sent to the list, not the new client or back where you came from

#### ○ [medium] Line items (and catalogue items) cannot be reordered by touch — reordering exists only as HTML5 drag-and-drop in the desktop grid  <sub>missing-merge-85</sub>

`src/components/forms/DocumentBuilder.tsx:814` · found by: lens:ux-mobile, lens:ux-a11y-forms

Reordering uses native `draggable`/`onDragStart`/`onDrop`, and only inside the `hidden sm:block` desktop layout. The mobile card list renders grip icons for separators, headings, notes and subtotals, but they are decorative (no drag props), item cards have no handle at all, and there are no move-up/move-down buttons. CatalogueManager likewise relies on `draggable` only. For session invoices that list days, engineers and rentals in a deliberate order, the owner has to delete and re-add lines to fix the order on the phone.

Evidence: src/components/forms/DocumentBuilder.tsx:1046 `<div className="hidden sm:block overflow-x-auto -mx-1 px-1">` … :1054-1060 `const dragProps = { draggable: true, onDragStart: () => handleDragStart(idx), onDragOver: ..., onDrop: () => handleDrop(idx), onDragEnd: handleDragEnd, }` (desktop only); mobile list :809 `<div className="sm:hidden space-y-0">` with decorative :814 `<GripVertical size={14} cla…

Fix: Add 'move up' / 'move down' buttons (or a long-press reorder via a touch-capable DnD lib such as dnd-kit with TouchSensor) to the mobile line cards and catalogue rows; remove the decorative grips or wire them up.

Merged with: [ux] Line-item reordering is mouse drag-only; mobile cards show an inert grip

#### ○ [medium] No defaults for currency, VAT rate, unit, tax treatment or quote validity in Settings  <sub>missing-merge-46</sub>

`src/components/forms/SettingsForm.tsx:212` · found by: settings

Defaults card only covers payment days and language. New documents hard-code EUR and at_vat, and new line items have no configurable default VAT rate/unit. grep -rn 'default_currency|default_vat|default_unit|default_tax_treatment' src supabase → no matches.

Evidence: src/components/forms/DocumentBuilder.tsx:86-87 `const [currency, setCurrency] = useState<Currency>(doc?.currency ?? 'EUR') const [taxTreatment, setTaxTreatment] = useState<TaxTreatment>(doc?.tax_treatment as TaxTreatment ?? 'at_vat')`; SettingsForm.tsx:212-215 `const [defaults, setDefaults] = useState({ default_payment_days: ..., default_language: ... })`

Fix: Add default_currency, default_vat_rate, default_unit, default_quote_validity_days to settings and use them in DocumentBuilder.

#### ○ [medium] Drive folder is never validated; no folder picker; no Shared Drive support  <sub>missing-merge-51</sub>

`src/components/forms/SettingsForm.tsx:448` · found by: google, settings

Saving the folder only regex-extracts an id; a pasted file URL, a folder of another Google account, or a Shared Drive folder is accepted and fails only at first upload with Google's 'File not found: <id>'. Drive calls omit `supportsAllDrives`/`includeItemsFromAllDrives`, so Shared Drive folders cannot be used at all.

Evidence: SettingsForm.tsx:448-461 `const match = driveFolder.match(/[-\w]{25,}/) ... update({ drive_folder_id: folderId || null ...})` with no Drive call; grep -n 'supportsAllDrives' src/app/api/drive/upload/route.ts src/app/api/documents/[id]/drive-pdf/route.ts → none

Fix: On save call `drive.files.get({ fileId, fields: 'id,name,mimeType', supportsAllDrives: true })`, require mimeType `application/vnd.google-apps.folder`, store the real name; pass `supportsAllDrives: true` (and `includeItemsFromAllDrives` on list) in upload routes.

Merged with: [ux] Drive folder never verified; display name defaults to raw ID

#### ○ [medium] No validation of IBAN, BIC or UID formats in Settings  <sub>missing-merge-47</sub>

`src/components/forms/SettingsForm.tsx:758` · found by: settings, lens:dunning-payment-terms

IBAN/BIC feed the EPC QR code and UID is printed to clients; a typo (wrong check digits, 7-digit ATU) is only noticed when a bank app rejects the QR. grep -rn 'mod97|isValidIban|validateIban|ATU[0-9]' src → no matches.

Evidence: SettingsForm.tsx:758-760 `<input className={inp} value={banking.iban} onChange={e => { setBanking(b => ({ ...b, iban: e.target.value })); markDirty('banking') }} placeholder="AT12 3456 7890 1234 5678" />`

Fix: Add mod-97 IBAN validation, BIC regex (8/11 chars), ATU + 8 digits UID check, and normalise IBAN spacing on save.

Merged with: [ux] IBAN/BIC stored without validation; a typo yields an unpayable QR on every invoice

#### ○ [medium] Editing or deleting a synced/archived invoice ignores external artifacts (Drive PDF, Bookamat booking, share link) with no warning  <sub>missing-merge-57</sub>

`src/components/layout/DeleteDocumentButton.tsx:20` · found by: bookamat, payments-status

Neither DocumentBuilder nor DeleteDocumentButton nor the bulk DELETE route knows about bookamat_booking_id, drive_file_id or share_token, so amounts can drift from the Bookamat booking after an edit, the invoice can vanish while the booking remains in the books, the archived PDF stays in Drive, and no warning is shown.

Evidence: src/components/layout/DeleteDocumentButton.tsx:20 `const { error } = await supabase.from('documents').delete().eq('id', id)` (no reference to drive_file_id/bookamat_booking_id anywhere in the file); src/app/api/invoices/bulk/route.ts:40-44; grep -n -i bookamat src/components/forms/DocumentBuilder.tsx src/components/layout/DeleteDocumentButton.tsx → no matches

Fix: Lock items/totals once synced (or require Reset first); block delete when bookamat_booking_id is set; offer to trash the Drive file; otherwise show an explicit warning listing what remains (Bookamat booking must be removed manually).

#### ○ [medium] Credit notes cannot be settled or applied against an invoice  <sub>missing-merge-64</sub>

`src/components/layout/DocumentStatusBar.tsx:11` · found by: payments-status

Credit-note statuses are draft/sent/cancelled only; there is no 'settled/refunded' state, no way to record the refund, and no link that reduces the original invoice's balance. Partial credit notes (crediting only some lines) are not supported, the conversion always copies every item.

Evidence: src/components/layout/DocumentStatusBar.tsx:11 `const CREDIT_NOTE_STATUSES = ['draft', 'sent', 'cancelled'] as const`; src/app/api/invoices/[id]/convert-to-credit-note/route.ts:38-55 copies all items

Fix: Add a 'settled' status with a refund payment (negative payment or credit_note_payments), and let the user pick lines/amounts when creating a credit note.

#### ○ [medium] No recurring invoices / templates for monthly rentals  <sub>missing-merge-78</sub>

`src/components/layout/DuplicateDocumentButton.tsx:21` · found by: lens:freelancer-workflows

There is no recurrence model (no interval, next_run, template flag) and no scheduled generation; the only reuse path is the manual 'Duplicate as draft' button. A studio with monthly 'Studio Control Miete' or retainer clients re-creates the same invoice by hand each month. grep 'recurring|recurrence|repeat_every|interval' src supabase → 0 hits.

Evidence: src/components/layout/DuplicateDocumentButton.tsx:21 `async function duplicate()` (manual); src/types/index.ts:116-142 `interface Document` has no recurrence fields; vercel.json:3-6 only cron is `/api/cron/reminders`

Fix: Add a `recurring_profiles` table (client, items, interval, next_date, auto_send flag) and extend the daily cron to generate drafts (or send via Gmail) on next_date, listing upcoming runs on the dashboard.

#### ○ [medium] Payment/status model gaps: no partially_paid or written_off status, payments store no method or bank reference, overpayments are silently marked 'Paid in full', and uncollectible receivables can only be 'cancelled'  <sub>missing-merge-63</sub>

`src/components/layout/PaymentPanel.tsx:48` · found by: payments-status, lens:dunning-payment-terms, lens:freelancer-workflows

DocumentStatus has no 'partially_paid'; payments store only date/amount/note, so there is no method (bank/cash/PayPal), no bank reference for reconciliation and no early-payment-discount handling that would settle an invoice at less than total. Invoice statuses are draft/sent/paid/overdue/cancelled; the only way to retire an uncollectible receivable is 'cancelled', which is wrong for a validly issued invoice and leaves no trace for the USt-Berichtigung (§ 16 Abs 3 UStG). PaymentPanel accepts any positive amount with no upper bound, marks the invoice paid and shows 'Paid in full' even when the balance is negative, hiding the overpayment that must be refunded or credited. grep -rn -i -E 'write.?off|writeoff|overpay' src → no hits.

Evidence: src/types/index.ts:6 `export type DocumentStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'accepted' | 'rejected' | 'cancelled'`; src/components/layout/DocumentStatusBar.tsx:9 `const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled']`; supabase/schema.sql:130-136 `create table payments (... date ..., amount numeric(10,2) not null, note text)`; src/components/layout/PaymentPanel.…

Fix: Add 'partially_paid' (or derive from balance) and 'written_off' statuses with date/reason that exclude the invoice from outstanding and flag it for VAT correction; add payment.method and payment.reference columns; warn when amount > balance and offer 'record as client credit / refund' instead of silently marking paid; add a 'Write off / Skonto' action that closes the remaining balance with a reason.

Merged with: [ux] Payment recording has no method, Skonto/bank-fee write-off or 'settle remaining'

#### ○ [medium] No bank statement import (CAMT.053 / CSV) or automatic payment matching  <sub>missing-merge-77</sub>

`src/components/layout/PaymentPanel.tsx:51` · found by: lens:freelancer-workflows

Every incoming payment must be typed manually into PaymentPanel (date, amount, note). Mature tools import the bank CSV/CAMT file or connect via PSD2 and match transfers to invoices by number/amount/IBAN. For a freelancer this is the most frequent recurring chore and the main source of stale 'sent' invoices. grep 'camt|mt940|bank_import|csv_import' src → 0 hits.

Evidence: src/components/layout/PaymentPanel.tsx:51-54 `.from('payments').insert({ document_id: documentId, date, amount: amt, note: note || null })` — only entry point; src/components/lists/InvoiceList.tsx:51 `function exportCSV(` — export only, no import

Fix: Add an 'Import bank statement' page accepting CAMT.053 XML / George & Raiffeisen CSV, parse Verwendungszweck for invoice numbers (the EPC QR already puts the number there), propose matches by amount ±0.05, and create payments in one confirm step.

#### ○ [medium] No Skonto (early-payment discount), payment-terms sentence, late-fee settings or {{payment_days}}/{{uid}}/{{company}} footer variables; Skonto cannot be taken on payment with VAT-base adjustment  <sub>missing-merge-10</sub>

`src/components/layout/PaymentPanel.tsx:65` · found by: builder-items, pdf, lens:dunning-payment-terms, settings

'2 % Skonto bei Zahlung binnen 7 Tagen' is routine on Austrian B2B invoices and relevant for § 11 (Entgeltminderung must be stated) and § 16 UStG (VAT base reduction). There are no skonto fields on documents, clients or settings (grep -rni 'skonto|mahnspesen|late_fee' src supabase → nothing); only free-text notes/footer can carry it, nothing is printed in the totals/payment block, and PaymentPanel only closes an invoice when payments reach the full total — if a client takes 2 % Skonto the invoice stays 'sent' forever (or the owner must fake a payment) and the VAT base is not reduced. The PDF prints only a due date; there is no 'Zahlbar innerhalb von 14 Tagen ohne Abzug' line and no {{payment_days}}, {{uid}} or {{company}} footer variable; the reminder flow has no fee concept.

Evidence: src/types/index.ts:116-142 `interface Document { ... discount_type: 'percent' | 'fixed' | null ... }` — no skonto fields; src/components/pdf/InvoiceDocument.tsx:279-283 only prints `L('due_label', lang)` + date; :144-153 footerVars (no payment_days / uid / company); src/components/layout/PaymentPanel.tsx:65-66 `if (newTotal >= total - 0.005) { await supabase.from('documents').update({ status: 'pai…

Fix: Add skonto_percent/skonto_days on the document (defaults from client/settings) and optional reminder fee settings with variables ({{skonto_amount}}, {{reminder_fee}}); print 'Bei Zahlung bis {date}: {pct}% Skonto ({amount})' and a default payment-terms line per language on the PDF; in PaymentPanel offer 'Skonto genommen' which records the discount and closes the balance (adjusting the VAT base); add {{payment_days}}, {{uid}}, {{company}} variables.

#### ○ [medium] No reminder path without Gmail and no formal Mahnung document  <sub>missing-merge-65</sub>

`src/components/layout/ReminderButton.tsx:18` · found by: payments-status

ReminderButton returns null when Gmail is not connected; there is no mailto fallback (the builder has one for sending invoices) and no printable 'Zahlungserinnerung/Mahnung' PDF with Mahnspesen and interest.

Evidence: src/components/layout/ReminderButton.tsx:18 `if (!gmailConfigured) return null`; src/components/layout/InvoicePageClient.tsx:49 `... && gmailConfigured`

Fix: Add a 'Download reminder PDF' / mailto fallback and a Mahnung template with fee and interest lines.

#### ○ [medium] Report period is quarters only: no monthly UVA period and no annual (Jahres-) summary  <sub>missing-merge-31</sub>

`src/components/layout/ReportControls.tsx:25` · found by: dashboard-reports, lens:small-business-tax

Only quarters are selectable; UVA is monthly above €100k turnover and the annual Umsatzsteuerjahreserklärung (U1) / E1a needs a full-year total with totals per VAT rate, RC and non-EU. ReportControls has only [1,2,3,4] and the page has no 'month' or 'year-only' mode, so the user has to add four quarterly screens by hand at year end.

Evidence: src/components/layout/ReportControls.tsx:25 `{[1, 2, 3, 4].map(q => (`; src/app/(app)/reports/page.tsx:6 `searchParams: Promise<{ year?: string; quarter?: string }>` and :12-14 derive only `qStart`/`qEnd` from the quarter

Fix: Add a period type selector (month / quarter / year) that sets `from`/`to` search params; compute the same breakdown for any range and add a 'Jahr' summary with totals per VAT rate, RC and non-EU.

#### ○ [medium] CreditNoteList has no mobile card layout: a 5-column table inside overflow-hidden is clipped on phones  <sub>missing-merge-84</sub>

`src/components/lists/CreditNoteList.tsx:107` · found by: lens:ux-mobile, lists, lens:ux-flows

InvoiceList, QuoteList and ClientList each render a `sm:hidden` card list plus a `hidden sm:table` desktop table. CreditNoteList renders only a `<table className="w-full">` with Number, Client, Date, Total and Status, wrapped in a `rounded-xl … overflow-hidden` container and with no `overflow-x-auto`. At 375px the columns' min-content width exceeds the ~343px available, so the Total and Status columns are cut off and unreachable. The owner reviews credit notes on the phone like any other document list.

Evidence: src/components/lists/CreditNoteList.tsx:106-107 `<div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden"> <table className="w-full text-sm">` (no `sm:hidden` block, no `hidden sm:table`); compare src/components/lists/QuoteList.tsx:120 `<div className="sm:hidden divide-y ...">` and :158 `<table className="hidden sm:table w-full text…

Fix: Copy the mobile card block from QuoteList.tsx (lines 120-155) into CreditNoteList and mark the table `hidden sm:table`.

Merged with: [ux] Credit note list has no mobile layout; table clipped on phones

#### ○ [medium] No sync status or 'unsynced paid invoices' view in the invoice list, no bulk sync  <sub>missing-merge-56</sub>

`src/components/lists/InvoiceList.tsx:1` · found by: bookamat

The only place sync state is visible is the invoice detail page; a paid invoice whose prompt was skipped is easy to forget.

Evidence: grep -n -i bookamat src/components/lists/InvoiceList.tsx → no matches; grep -rn -i bookamat 'src/app/(app)/invoices/page.tsx' → none

Fix: Add a 'Bookamat' column/badge and a filter 'paid, not synced' with a bulk sync action.

#### ○ [medium] No date-range / month / year or client filter and no filtered totals in the invoice list (and client page) for bookkeeping  <sub>missing-merge-22</sub>

`src/components/lists/InvoiceList.tsx:92` · found by: lists, lens:ux-flows, lens:freelancer-workflows

An Austrian freelancer needs 'all invoices of 2025' or 'Q3' with sums for the E/A-Rechnung and UVA cross-checks, or 'last month's invoice for client X'; the list filters only by status and a free-text match on number/client — no date range, month/year filter, no client dropdown, no Σ net/VAT/gross of the filtered set. The client page lists all document types mixed together with a hard limit of 50 and no filters. The reports page covers VAT only and has no export.

Evidence: src/components/lists/InvoiceList.tsx:92-102 `if (status === 'outstanding') ... else if (status) ...; if (q) { ... includes(lq) }` — grep -n 'month|year|range|dateFrom|from|date' InvoiceList.tsx shows only sort/display uses; src/app/(app)/clients/[id]/page.tsx:43-48 `.eq('client_id', id).order('date', { ascending: false }).limit(50)` with no type/date filter; grep -i 'csv|export' src/app/(app)/repo…

Fix: Add year/quarter/month and from–to filters (URL-persisted) plus a client filter to the invoice list, and show Σ net/VAT/gross of the filtered set (reuse for CSV); add type tabs and a 'show all' link on the client page.

Merged with: [ux] No global search, no client/date-range or tag filters on lists; only keyboard shortcut is Cmd+S

#### ○ [medium] No Unicode-capable font registration for the PDF; branding limited to one logo and Helvetica (no colours, letterhead, second logo) and no AGB/terms attachment on send  <sub>missing-merge-17</sub>

`src/components/pdf/InvoiceDocument.tsx:6` · found by: pdf, lens:freelancer-workflows

No custom font is registered (grep 'Font.register' src → 0), so only WinAnsi characters render — needed for Eastern-European client/artist names (ł/ř/ő) and for the minus sign. The PDF has a single logo slot and hard-coded greys; there are no accent colour, font, letterhead or footer-logo settings. Emails always carry exactly one PDF — there is no way to attach AGB/terms, a rider or a session sheet, which studios commonly send with quotes. grep 'accent|letterhead|agb|terms_pdf' src → 0 relevant hits.

Evidence: src/components/pdf/InvoiceDocument.tsx:6 `page: { fontFamily: 'Helvetica', fontSize: 9, ...` and :9 single `logo` style; src/components/forms/SettingsForm.tsx:645 `<input type="file" accept="image/*" ... onChange={handleLogoUpload}` (one logo); src/lib/utils/reminder.ts:10 `if (pdfBase64 && filename) {` single attachment

Fix: Register a Unicode TTF family (regular/bold/italic, e.g. Inter/Noto from /public/fonts) with Font.register in InvoiceDocument and set it as the page font; add accent colour + optional letterhead/footer logo settings; add a Settings upload for 'attach to quotes/invoices' PDFs that the Gmail MIME builder appends.

#### ○ [medium] No structured e-invoice output (ebInterface / Peppol UBL / EN 16931 / ZUGFeRD) and PDFs are not PDF/A  <sub>missing-merge-76</sub>

`src/components/pdf/InvoiceDocument.tsx:6` · found by: lens:e-invoicing-archival

Searched src and supabase for ebinterface, peppol, ubl, zugferd, factur, xrechnung, en16931, xmp, pdf/a — no hits. The only output is a react-pdf document using the non-embedded standard Helvetica font, which cannot be PDF/A and carries no XMP metadata. Today this user has no e-invoicing obligation for private-sector studio clients, but any invoice to an Austrian federal body (Bund) must already be submitted as ebInterface or Peppol UBL via USP, and from 2030 ViDA will require EN 16931 e-invoices plus digital reporting for the intra-EU reverse-charge invoices he already issues.

Evidence: src/components/pdf/InvoiceDocument.tsx:6 `page: { fontFamily: 'Helvetica', fontSize: 9, ... }` (standard-14 font, not embedded); :163 `<Document>` with no metadata/XMP props; grep -rniE 'ebinterface|peppol|ubl|zugferd|factur|xrechnung|16931|xmp|pdf/a' src supabase → no matches

Fix: Add `GET /api/documents/[id]/ubl` that maps document/items/client/settings to a Peppol BIS Billing 3.0 UBL Invoice (seller/buyer VAT ids, TaxCategory S/AE/G, PaymentMeans with IBAN, InvoiceLine per item) and validate it against the EN 16931 schematron in CI; link it from the document page and attach it to sends; consider a PDF/A-3 renderer for Factur-X/ZUGFeRD.

#### ○ [medium] No shared dialog/confirm, select or table primitives; pages fall back to native confirm() and ad-hoc inaccessible overlays  <sub>missing-merge-71</sub>

`src/components/ui/button.tsx:1` · found by: shell-ui, payments-status, clients-catalogue, portal, builder-doc, dashboard-reports, lens:ux-consistency, lens:ux-flows, data-security

src/components/ui contains only button, input, label, separator, sonner, textarea, Logo and ThemeProvider. Consequently grep -rn 'confirm(' src finds 8 native confirm() dialogs (DeleteDocumentButton, ConvertToInvoiceButton, ConvertToCreditNoteButton, ClientForm, CatalogueManager, portal QuoteActions), grep -rln '<select' src finds native selects in 9 files, 7 hand-rolled `fixed inset-0` overlays exist and grep -rln 'role="dialog"|aria-modal|<dialog' src → 0, so none of the modals is accessible.

Evidence: src/components/layout/DeleteDocumentButton.tsx:17 `if (!confirm('Delete this document? This cannot be undone.')) return`; src/components/layout/ShareLinkButton.tsx:115 `<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setOpen(false)}>`

Fix: Add shadcn/base-ui AlertDialog, Dialog, Select (and Table/Badge/Skeleton) to src/components/ui and migrate the native confirm() calls and overlays to them.

Merged with: [ux] Eight native confirm() dialogs (document delete + counter restore, conversions, client/catalogue delete, portal accept/decline) alongside inconsistent custom modals

#### ○ [medium] No Kleinunternehmer (§ 6 Abs 1 Z 27 UStG) mode or exemption note: 0 % lines under at_vat print 'USt. 0%' with no legal reference; no Steuernummer/EX-number field, no threshold tracker, no Vorsteuer input for the Zahllast  <sub>missing-merge-13</sub>

`src/lib/utils/document.ts:97` · found by: builder-doc, pdf, dashboard-reports, settings, lens:small-business-tax, lens:rechnungsmerkmale

Only Austrian VAT, EU reverse charge and non-EU exist (check constraint on tax_treatment). A freelancer under the small-business threshold (€55k net since 2025) must issue invoices without VAT with the mandatory exemption note and files no UVA; the data model, getTaxNote and the UI cannot express it, there is no VAT-regime setting, no Steuernummer/tax_number field and no EX-number for the EU cross-border scheme. getTaxNote returns null for at_vat, so an invoice containing a 0 % line (an exempt service, or 0 % used as the Kleinunternehmer workaround) shows 'USt. 0%  € 0,00' without the reason required by § 11 Abs 1 Z 3 lit e ('Hinweis, dass für diese Leistung eine Steuerbefreiung gilt') and the report lists it under 'Steuerpflichtige Umsätze 0%'. Without a Vorsteuer (input VAT) figure the report cannot compute the 'Zahllast'. grep -rniE 'kleinunternehmer|vorsteuer|§ ?6|steuerbefreit|vat_exempt|steuernummer|tax_number' src supabase → no matches.

Evidence: src/lib/utils/document.ts:86-98 `export function getTaxNote(taxTreatment, lang, settings) { if (taxTreatment === 'eu_reverse_charge') {...} if (taxTreatment === 'non_eu') {...} return null }`; src/components/pdf/InvoiceDocument.tsx:299-304 `{doc.tax_treatment === 'at_vat' && doc.totals.vat_groups.map(g => (` renders every vat_group including rate 0 with no note; src/components/forms/DocumentBuilde…

Fix: Add settings.vat_regime ('regelbesteuerung'|'kleinunternehmer') / small_business_exempt (bool), `eu_exemption_number` (EX…) and a tax_number field with its own configurable exemption note text; when enabled force/default 0 % VAT in calcTotals, suppress the USt row and print 'Umsatzsteuerbefreit gemäß § 6 Abs 1 Z 27 UStG' / 'VAT exempt under Austrian small business scheme' on all documents; also print a configurable exemption note (or per-line exemption reason) whenever a 0 % VAT group exists under at_vat; hide the UVA report in favour of a turnover-vs-threshold tracker; add a Vorsteuer input for the Zahllast.

Merged with: [ux] 'USt. 0%  € 0,00' row printed for zero-rated lines without exemption reason

#### ○ [medium] No Anzahlungs-/Teil-/Schlussrechnung workflow (deposit, partial and final invoices with deduction of advances incl. VAT)  <sub>missing-merge-75</sub>

`src/types/index.ts:5` · found by: lens:dunning-payment-terms, lens:freelancer-workflows

Document types are limited to invoice/quote/credit_note; there is no invoice subtype, no link from a final invoice to earlier advance invoices, and no totals block that deducts already-invoiced advances and their VAT (Anzahlungs- und Endrechnung per § 11 UStG). Studio bookings commonly require a deposit (e.g. 50 % on booking) before the session and a Schlussrechnung afterwards; today the owner has to hand-write the deduction, risking wrong VAT on the final invoice. PaymentPanel can record a partial payment against one invoice, but a studio typically invoices the deposit as its own document. grep -rn -i -E 'anzahlung|teilrechnung|schlussrechnung|deposit|retainer' src supabase → no hits.

Evidence: src/types/index.ts:5 `export type DocumentType = 'invoice' | 'quote' | 'credit_note'`; src/components/pdf/InvoiceDocument.tsx:286-319 totals block has subtotal/discount/VAT/total/balance only; grep -rn converted_from_id src → quotes/[id]/convert/route.ts:33 and convert-to-credit-note/route.ts:33 only; src/components/layout/PaymentPanel.tsx:46 `async function addPayment()` is the only partial-payme…

Fix: Add invoice_kind ('standard' | 'advance' | 'partial' | 'final') and `advance_invoice_ids` (or a 'deposit' flag/line, percentage or fixed, on invoices created from a quote); add a 'Create final invoice' action that copies the quote items and on the final invoice prints each advance (number, date, net, VAT) as a deduction with correct VAT.

#### ○ [low] No HTTP security headers (CSP, X-Frame-Options, Referrer-Policy) — public portal is frameable  <sub>missing-merge-69</sub>

`next.config.ts:3` · found by: data-security, shell-ui

next.config.ts is the untouched template and no proxy.ts exists, so responses carry no X-Frame-Options/frame-ancestors, Content-Security-Policy, Referrer-Policy or Permissions-Policy. The token-URL portal (/portal/[token]) with Accept/Decline buttons and the authenticated app can be embedded in a hostile third-party frame (clickjacking of quote acceptance).

Evidence: next.config.ts:3-5 `const nextConfig: NextConfig = { /* config options here */ };`; grep -rn 'headers|X-Frame-Options|frame-ancestors|Content-Security-Policy' src next.config.ts → 0

Fix: Add a `headers()` entry in next.config.ts (X-Frame-Options: DENY or CSP `frame-ancestors 'none'`, Referrer-Policy: strict-origin-when-cross-origin, X-Content-Type-Options: nosniff, a CSP) or set them in proxy.ts.

#### ○ [low] No per-client statement (Kontoauszug / offene Posten) to send or print  <sub>missing-merge-81</sub>

`src/app/(app)/clients/[id]/page.tsx:96` · found by: lens:freelancer-workflows

The client page shows an 'Open balance' number and a document list, but there is no printable/mailable statement listing all open invoices with dates, amounts, paid portions and totals — the standard document a freelancer sends when a label has three unpaid invoices. grep 'statement|kontoauszug|offene posten|aging' src → 0 hits.

Evidence: src/app/(app)/clients/[id]/page.tsx:95-99 `<p className="text-xs ...">Open balance</p> ... {formatMoney(openBalance, client.currency)}` — display only; no route under src/app/api for statements

Fix: Add 'Download statement' on the client page rendering a small react-pdf table of open invoices (number, date, due, total, paid, balance) in the client's language, and an optional Gmail send.

#### ○ [low] Whole tables are shipped to the browser with no server-side limit  <sub>missing-merge-27</sub>

`src/app/(app)/invoices/page.tsx:8` · found by: lists

Each list page loads every document with all line items and every column (`*` includes notes_internal and share_token) and pages only in memory. Fine for a few hundred rows, but the clients page additionally loads every invoice row just to find the last date.

Evidence: src/app/(app)/invoices/page.tsx:8-12 `.select('*, clients(name, company), document_items(…)').eq('type', 'invoice').order('date', …)` (no `.range`); src/app/(app)/clients/page.tsx:8 selects `address_line1, address_line2, zip, city, …, uid_number` never used by ClientList

Fix: Select only the needed columns, compute the last-invoice date with a grouped query/view, and consider `.range()` pagination or a yearly default filter.

#### ○ [low] No expenses/receipts (Ausgaben, Vorsteuer) — the app covers only the income side of the Einnahmen-Ausgaben-Rechnung  <sub>missing-merge-83</sub>

`src/app/(app)/reports/page.tsx:75` · found by: lens:freelancer-workflows

There is no expense entity, receipt upload or Vorsteuer calculation; the 'VAT Report' therefore can only show Umsatzsteuer. Since the user syncs to Bookamat, this may be acceptable, but the report should not present itself as the UVA/Zahllast without input tax, and a minimal expense capture (photo + amount + VAT) with Bookamat push would make the app the single daily tool. grep 'expense|ausgabe|receipt|beleg|vorsteuer' src → 0 hits.

Evidence: src/app/(app)/reports/page.tsx:75 `Umsatzsteuervoranmeldung (UVA)` and :88 `Zahllast USt gesamt`; src/components/layout/Sidebar.tsx:16-23 nav has no Expenses entry

Fix: Either rename the report to 'Umsatzsteuer aus Ausgangsrechnungen' with a note that Vorsteuer lives in Bookamat, or add an Expenses module (receipt upload to Drive, VAT split, Bookamat sync) and a true Zahllast.

#### ○ [low] Share links never expire and cannot be rotated without revoke+recreate  <sub>missing-merge-61</sub>

`src/app/api/documents/[id]/share/route.ts:17` · found by: portal

`share_token` has no `expires_at`; POST always reuses the existing token. grep -rn expires_at src supabase → no results; migration adds only the column.

Evidence: supabase/migrations/20260602_share_token.sql:1 `alter table documents add column if not exists share_token uuid unique;`; src/app/api/documents/[id]/share/route.ts:17 `const token = existing.share_token ?? randomUUID()`

Fix: Optional `share_expires_at` checked by page/pdf/respond, plus a 'Regenerate link' action in the modal.

#### ○ [low] No API input validation despite zod/react-hook-form being dependencies  <sub>missing-merge-70</sub>

`src/app/api/gmail/send/route.ts:17` · found by: data-security, lists

Every route destructures req.json() blindly (to/subject/body/pdfBase64/filename/ids/status/country/year); zod and @hookform/resolvers are installed but never imported.

Evidence: package.json:32 `"zod": "^4.4.3"` and :13 `"@hookform/resolvers"`; grep -rn "from 'zod'|react-hook-form|@hookform" src → no matches; src/app/api/gmail/send/route.ts:17 `const { to, subject, body, pdfBase64, filename } = await req.json()`

Fix: Define zod schemas per route and reject 400 on parse failure (also prevents CRLF header injection in `To:`/`Subject:`).

Merged with: [quality] Bulk route trusts request body shape

#### ○ [low] No 'viewed' tracking for shared documents  <sub>missing-merge-60</sub>

`src/app/portal/[token]/page.tsx:63` · found by: portal

The portal page does not record that the client opened the link, so the owner cannot see 'Client viewed invoice on 03.10.2026' (a common freelancer need before chasing payment). grep -rn 'viewed_at|opened_at' src supabase → no results.

Evidence: src/app/portal/[token]/page.tsx:63-72 performs only reads

Fix: Add `share_viewed_at timestamptz` / `share_view_count int` and update them (fire-and-forget) in the page loader; show on the document detail page.

#### ○ [low] No pay-now option in the client portal: EPC/SEPA QR not rendered on the web view and no card/PayPal/Stripe link  <sub>missing-merge-62</sub>

`src/app/portal/[token]/page.tsx:277` · found by: portal, lens:freelancer-workflows

The PDF embeds a GiroCode but the portal payment box is text only (IBAN/BIC/number); clients on a phone cannot scan from the page, and there is no Stripe/PayPal/SumUp link for international clients who cannot do SEPA. For Austrian B2B clients bank transfer is fine, but US/UK artists paying a USD invoice have no convenient option. grep -n 'generateEpcQr|qr' src/app/portal/[token]/page.tsx → no results; grep 'stripe|paypal|checkout|payment_link' src → 0.

Evidence: src/app/portal/[token]/page.tsx:277-288 payment info block renders company/bank/IBAN/BIC/number only; QR exists only in src/app/portal/[token]/pdf/route.ts:34-46

Fix: Reuse `generateEpcQr` in the page loader and render the data URI as an <img> next to the IBAN; optionally a Stripe Payment Link / PayPal.me URL configured in Settings, writing a payment row on webhook.

#### ○ [low] No catalogue search/filter, 'show hidden' toggle or usage counts  <sub>missing-merge-45</sub>

`src/components/forms/CatalogueManager.tsx:193` · found by: clients-catalogue

With a growing catalogue there is no search box, no way to filter hidden items, and no indication how often an item was used (helps deciding what to delete).

Evidence: src/components/forms/CatalogueManager.tsx:193-196 render starts directly with the group loop; no search state

Fix: Add a search input and a 'Show hidden' toggle; show `document_items` usage count per item (count query).

#### ○ [low] No delete guard / archive flow and no duplicate detection for clients  <sub>missing-merge-42</sub>

`src/components/forms/ClientForm.tsx:121` · found by: clients-catalogue

No pre-check for linked documents before delete and no warning when a client with the same email/UID/company already exists. grep -n 'duplicate|exists' src/components/forms/ClientForm.tsx → no hits.

Evidence: src/components/forms/ClientForm.tsx:121-129 handleDelete; :112 insert without lookup

Fix: Show document count on the client page, replace Delete with Archive when documents exist, and warn on duplicate email/UID at create time.

#### ○ [low] Client notes and payment terms are not surfaced in the document builder  <sub>missing-merge-40</sub>

`src/components/forms/DocumentBuilder.tsx:173` · found by: clients-catalogue

Notes (e.g. 'always bill to HQ', 'PO number required') are only visible on the client page. grep -rn 'client\.notes|client?\.notes' src → only ClientEditSection.tsx:83-84.

Evidence: src/components/layout/ClientEditSection.tsx:83 `{client.notes && (`

Fix: Show client notes (and payment terms) in a small info box under the client selector in the builder; optionally add 'default document note' per client.

#### ○ [low] Per-line discounts: columns exist on every item row but are only used for subtotal rows  <sub>missing-merge-6</sub>

`src/components/forms/DocumentBuilder.tsx:259` · found by: builder-items

The migration adds discount_type/discount_value to document_items and the DocumentItem type carries them, yet buildItemsPayload forces them to null for item lines and no per-line discount UI exists; a 'Rabatt 10 % on this line' is impossible without a subtotal row.

Evidence: src/components/forms/DocumentBuilder.tsx:259-260 `discount_type: l.line_type === 'subtotal' ? (l.discount_type || null) : null,` / `discount_value: l.line_type === 'subtotal' ? (l.discount_value || null) : null,`; supabase/migrations/20260603_item_discount.sql:1-3.

Fix: Either support item-level discounts in calcTotals/PDF or rename the concept (section_discount) to avoid the misleading columns.

#### ○ [low] No Web Share path for the PDF or the portal link; PDF preview relies on target=_blank blob URLs  <sub>missing-merge-86</sub>

`src/components/forms/DocumentBuilder.tsx:446` · found by: lens:ux-mobile

On an iPhone the natural way to hand over an invoice is the share sheet (AirDrop, WhatsApp, Mail, Files). The app offers only clipboard copy for the portal link and, for PDFs, either a `showSaveFilePicker` branch (not available on iOS) or an `<a download>`/`target="_blank"` blob URL; `navigator.share` is never used. Preview opens the blob in a new tab, which in a home-screen PWA has no tab UI.

Evidence: grep -rn 'navigator.share' src → no matches; src/components/layout/ShareLinkButton.tsx:55-61 `async function copyLink() { if (!portalUrl) return; await navigator.clipboard.writeText(portalUrl) ... }`; src/components/forms/DocumentBuilder.tsx:446-460 `async function downloadPdf() { ... const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; ... a.click() }`; :4…

Fix: When `navigator.canShare?.({ files })` is true, offer a 'Share' action that calls `navigator.share({ files: [new File([blob], filename, { type: 'application/pdf' })], title: filename })`; in ShareLinkButton call `navigator.share({ url: portalUrl })` when available, falling back to clipboard.

#### ○ [low] Disconnect does not revoke the Google grant  <sub>missing-merge-50</sub>

`src/components/forms/SettingsForm.tsx:437` · found by: google

Disconnecting only nulls DB columns; the refresh token remains valid at Google until the user removes the app in their Google account.

Evidence: SettingsForm.tsx:437-446 `disconnectGmail` only runs `supabase.from('settings').update({ gmail_email: null, ... })`; grep -rn 'revokeToken' src → none

Fix: Add `POST /api/gmail/disconnect` that calls `oauth2.revokeToken(refresh_token)` then clears the columns.

#### ○ [low] Page transition and other animations ignore prefers-reduced-motion  <sub>missing-merge-87</sub>

`src/components/layout/PageTransition.tsx:8` · found by: lens:ux-a11y-forms

`PageTransition` re-mounts the whole page tree on every route change (`key={pathname}`) and plays a translate+fade animation; list skeletons use `animate-pulse`, the bulk bar slides, and spinners rotate. There is no `prefers-reduced-motion` media query or `motion-safe:` variant anywhere, so users who have enabled 'Reduce Motion' still get every animation.

Evidence: grep -rn 'reduced-motion|motion-reduce|motion-safe' src → no matches; PageTransition.tsx:8 `<div key={pathname} className="animate-fade-in">`; globals.css:141-148 `@keyframes fade-in { from { opacity: 0; transform: translateY(4px); } … } .animate-fade-in { animation: fade-in 0.18s ease-out; }`; InvoiceList.tsx:362 `transition-all duration-200`; invoices/loading.tsx:3 `animate-pulse`

Fix: Wrap `.animate-fade-in` in `@media (prefers-reduced-motion: no-preference)` (or use `motion-safe:animate-fade-in`), and add a global `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }` in globals.css.

#### ○ [low] Payment date is not validated  <sub>missing-merge-66</sub>

`src/components/layout/PaymentPanel.tsx:53` · found by: payments-status

Any date (future, before invoice date, empty) is accepted; an empty date fails with a raw DB error.

Evidence: src/components/layout/PaymentPanel.tsx:53 `.insert({ document_id: documentId, date, amount: amt, note: note || null })` with no validation of `date`

Fix: Require a date, warn on future dates and dates before the invoice date.

#### ○ [low] No re-attach / retry for the Bookamat PDF and no automatic sync despite the settings copy  <sub>missing-merge-58</sub>

`src/components/layout/PaymentPanel.tsx:236` · found by: bookamat

Once bookamatId is set the panel offers only Reset; if the attachment step failed there is no way to retry. No cron job performs the advertised automatic sync.

Evidence: src/components/layout/PaymentPanel.tsx:236-248 only renders the badge and 'Reset sync'; ls src/app/api/cron → `reminders` only; grep -rn -i bookamat src/app/api/cron → none

Fix: Add 'Attach PDF' and optionally a cron that syncs invoices marked paid > N hours ago.

Merged with: [ux] Bookamat card description promises automatic sync but the feature is a manual prompt

#### ○ [low] UI language is English-only with no UI locale setting; only document language exists  <sub>missing-merge-73</sub>

`src/components/layout/Sidebar.tsx:15` · found by: shell-ui

settings.default_language (supabase/schema.sql:33) and documents.language govern generated PDFs/emails only; there is no UI language preference and no i18n layer (grep -rn -i 'language|locale|theme' src/types/index.ts shows only the document Language type). The shell's nav labels and the login page are hard-coded English while the html lang is 'de'.

Evidence: supabase/schema.sql:33 `default_language      text not null default 'de',`; src/components/layout/Sidebar.tsx:15-24 hard-coded English `nav` array

Fix: Either commit to English and set lang="en", or introduce a small dictionary (de/en) for shell copy keyed off a new settings.ui_language column.

#### ○ [low] Clients list lacks per-client outstanding balance, document count and tag/tax filters (tags are write-only)  <sub>missing-merge-26</sub>

`src/components/lists/ClientList.tsx:53` · found by: lists, clients-catalogue

For a studio with recurring clients the list should show open amount and number of invoices; tags and tax treatment are displayed but cannot be filtered or sorted. Tags can be entered and displayed but nothing filters or reports by them (grep -rn 'tags' src --include='*.tsx' --include='*.ts' outside ClientForm/ClientList/ClientEditSection/types/clients page → no hits).

Evidence: src/components/lists/ClientList.tsx:53-61 filter uses only status and the text query; :158 `<th …>Tax</th>` and :160 `<th …>Tags</th>` are plain headers without sort/filter; src/app/(app)/clients/page.tsx:9 only selects `client_id, date` from documents; ClientForm.tsx:42 `<input type="hidden" name="tags" value={tags.join(', ')} />`

Fix: Aggregate open balance and invoice count per client on the server; add a tag filter chip row and tax-treatment filter to the client list (and optionally to invoice list/report).

#### ○ [low] Filters, sort and page are not persisted in the URL  <sub>missing-merge-25</sub>

`src/components/lists/InvoiceList.tsx:77` · found by: lists

Only the initial ?status is read; search text, sort column/direction and page live in component state, so opening an invoice and pressing Back, or sharing a link, loses the view.

Evidence: src/components/lists/InvoiceList.tsx:77-80 `const [q, setQ] = useState('') … const [page, setPage] = useState(0)`; src/app/(app)/invoices/page.tsx:4 `searchParams: Promise<{ status?: string }>` (only status)

Fix: Mirror q/status/sort/page to searchParams with router.replace and read them in the page.

#### ○ [low] Bulk actions and CSV export exist only for invoices; quotes, credit notes and clients have none, invoices lack bulk cancel/reminder/archive, and there is no client import  <sub>missing-merge-24</sub>

`src/components/lists/QuoteList.tsx:48` · found by: lists, clients-catalogue

Quotes, credit notes and clients have no selection, no bulk status change/delete and no export; invoices have no bulk 'Mark cancelled', bulk reminder or bulk PDF/Drive archive. Clients also lack a CSV import for migrating an existing client base. grep -rn -i 'csv' src → only src/components/lists/InvoiceList.tsx.

Evidence: grep -ln 'exportCSV|selected|bulk' src/components/lists/*.tsx → only src/components/lists/InvoiceList.tsx; grep -rn 'bookamat|drive|reminder' src/app/api/invoices/bulk/route.ts → no matches; src/components/lists/ClientList.tsx:88-93 header has only 'New Client'

Fix: Extract a generic DocumentList with selection/bulk/export and reuse it for all document types; add 'Mark cancelled' and 'Send reminder' bulk actions for invoices; add Export CSV (and a simple CSV import) to the client list.

#### ○ [low] No status stamps (Storniert / Bezahlt / Entwurf) on the PDF  <sub>missing-merge-19</sub>

`src/components/pdf/InvoiceDocument.tsx:103` · found by: pdf

Cancelled or paid documents render identically to open ones; drafts have no watermark. grep -rn 'Storno|STORNIERT|watermark' src → 0.

Evidence: src/components/pdf/InvoiceDocument.tsx DocData (103-118) carries no status field

Fix: Pass status and print a diagonal 'ENTWURF' / 'STORNIERT' / 'BEZAHLT' stamp.

#### ○ [low] No time/session tracking that feeds into invoices  <sub>missing-merge-82</sub>

`src/types/index.ts:8` · found by: lens:freelancer-workflows

Units include 'hour' and 'session' but there is no timer, time-entry log or calendar import; hours and sessions must be remembered and typed into the builder. For a studio billing engineers by the hour and mixing by session, an 'unbilled time → invoice' step prevents forgotten hours. grep 'time_entr|timer|timesheet' src → only the autosave timer.

Evidence: src/types/index.ts:8 `export type Unit = 'hour' | 'day' | 'flat' | 'piece' | 'month' | 'session'`; src/components/forms/DocumentBuilder.tsx:1253-1255 quantity is a plain `<Input type="number" value={line.quantity} ...`

Fix: Add a lightweight `time_entries` table (client, project, date, hours, catalogue_item, billed_document_id) with a quick-add on the dashboard and an 'Add unbilled entries' button in the builder.

#### ○ [low] No catalogue item description text (DE/EN)  <sub>missing-merge-43</sub>

`src/types/index.ts:104` · found by: clients-catalogue

Items only have short names; recurring long service descriptions (e.g. what a 'Recording Day' includes) must be retyped on every invoice.

Evidence: src/types/index.ts:104-114 CatalogueItem has `name_de`, `name_en` only; supabase/schema.sql:67-77 no description column

Fix: Add `description_de`/`description_en` and prefill the line description with name + description.

#### ○ [low] No projects/jobs to group quote, deposit, invoices and credit notes for one production  <sub>missing-merge-80</sub>

`src/types/index.ts:133` · found by: lens:freelancer-workflows

Documents are linked only pairwise via `converted_from_id` (quote→invoice, invoice→credit note); there is no project/job entity with a name, client, status and the list of related documents, nor project-level totals. An album production typically spans a quote, a deposit invoice, several session invoices and maybe a credit note; today the owner finds them by scanning the client page. grep 'project_id|projects|job_id' src supabase → 0 hits.

Evidence: src/types/index.ts:133 `converted_from_id: string | null` is the only relation; src/app/(app)/clients/[id]/page.tsx:136-156 flat document list without grouping

Fix: Add a `projects` table (client_id, name, status, notes) and `documents.project_id`; show a project tab with its documents and quoted-vs-invoiced-vs-paid totals; prefill project on conversions.

#### ○ [low] No client number (Kundennummer)  <sub>missing-merge-38</sub>

`supabase/schema.sql:44` · found by: clients-catalogue

No human-readable client identifier for bookkeeping references, Bookamat titles or invoice headers. grep -rn -i 'client_number|customer_number|kundennummer' src supabase → no hits.

Evidence: supabase/schema.sql:44-64 (clients table has no number column); src/app/api/bookamat/sync/route.ts:58-60 builds titles from name/company only

Fix: Add a sequential `client_number` (e.g. K-0001) with a settings-driven prefix and print it on documents.

### UX / design (78)

#### ○ [high] iOS auto-zooms on focus: inputs/selects forced to 14px (text-sm overrides Input's text-base md:text-sm)  <sub>ux-merge-102</sub>

`src/components/ui/input.tsx:12` · found by: lens:ux-mobile, lens:ux-a11y-forms

Input primitive uses text-base md:text-sm but call sites pass className="text-sm" which twMerge keeps; raw selects/inputs in lists, Builder, Settings inp, Catalogue fieldCls, PaymentPanel, ClientForm hard-code text-sm; every tap zooms and leaves page scrollable.

Evidence: ui/input.tsx:12 `… text-base … md:text-sm …`; utils.ts:4-5 `twMerge(clsx(inputs))`; DocumentBuilder.tsx:743 `className="text-sm h-10 w-full"`, :1253-1255, :1007, :1018, :1186; selects :731/:766/:774/:783/:1009/:1027; PaymentPanel.tsx:200/207/217; ClientForm.tsx:216; SettingsForm.tsx:14 `const inp = …`.

Fix: Use md:text-sm overrides (or none), text-base md:text-sm in shared raw-field tokens and selects.

#### ○ [medium] Stat cards (client page, dashboard) use fixed 3-/2-column grids; Euro amounts overflow at 375px  <sub>ux-merge-52</sub>

`src/app/(app)/clients/[id]/page.tsx:90` · found by: lens:ux-mobile, clients-catalogue

Three stat cards at ~72px content width with text-lg '€ 1.234,56' (nbsp, cannot wrap) spill over neighbours; dashboard KPI grid-cols-2 text-2xl overflows six-digit values; client form grids fixed inside 320px detail column.

Evidence: clients/[id]/page.tsx:90 `<div className="grid grid-cols-3 gap-4">`, :93 `text-lg font-semibold`, :108 `lg:grid-cols-[320px_1fr]`; dashboard/page.tsx:181 `grid grid-cols-2 lg:grid-cols-4 gap-4`; ClientForm.tsx:133, :140.

Fix: grid-cols-1 sm:grid-cols-3, text-base sm:text-lg tabular-nums, min-w-0 truncate; dashboard text-xl sm:text-2xl.

#### ○ [medium] Database errors swallowed on list pages and shown as 'No invoices yet.'  <sub>ux-merge-32</sub>

`src/app/(app)/invoices/page.tsx:8` · found by: lists

Pages destructure only data and pass docs ?? []; errors render the empty state with a CTA.

Evidence: invoices/page.tsx:8 `const { data: docs } = await supabase` … :16 `invoices={docs ?? []}`; InvoiceList.tsx:308 `'No invoices yet.'`.

Fix: Capture error and throw to error.tsx or render an error banner.

#### ○ [medium] VAT report labels: 'Zahllast' without Vorsteuer, missing Kennzahlen on rate rows, 0% shown as 'steuerpflichtig'  <sub>ux-merge-39</sub>

`src/app/(app)/reports/page.tsx:88` · found by: lens:small-business-tax, dashboard-reports

Figure shown is output VAT only, copying it as Zahllast (KZ 095) is wrong; only KZ 000 named; at_vat 0% listed as steuerpflichtig though steuerfrei (KZ 011-020).

Evidence: reports/page.tsx:88-89 `Zahllast USt gesamt` / `{formatMoney(totalVat)}`; :81-82 `` `Steuerpflichtige Umsätze ${rate}% (Bemessungsgrundlage)` ``; :85 reverse-charge label.

Fix: Rename 'Umsatzsteuer gesamt (ohne Vorsteuer)', add Vorsteuer input, KZ map (022/029/006), present 0% as steuerfrei.

#### ○ [medium] No loading state for Settings, Reports, Catalogue; quarter/year switch gives no pending feedback  <sub>ux-merge-40</sub>

`src/app/(app)/settings/page.tsx:4` · found by: shell-ui, dashboard-reports

loading.tsx exists only for dashboard/invoices/quotes/credit-notes/clients; ReportControls router.push leaves old numbers until server render.

Evidence: settings/page.tsx:4-6 `export default async function SettingsPage() { ... await supabase.from('settings')`; catalogue/page.tsx:4-7; ReportControls.tsx:19 `router.push(`/reports?${params.toString()}`)`; reports/ has only page.tsx.

Fix: Add loading.tsx (or (app)/loading.tsx) and useTransition in ReportControls.

Merged with: [missing] Reports page has no loading skeleton

#### ○ [medium] Portal accept/decline: no error feedback on failure and header badge stays 'Gesendet' after success  <sub>ux-merge-79</sub>

`src/app/portal/[token]/QuoteActions.tsx:29` · found by: portal

Failed request silently resets to idle; success only updates local buttons while server-rendered badge is stale.

Evidence: QuoteActions.tsx:29 `setStatus(res.ok ? (action === 'accepted' ? 'accepted' : 'rejected') : 'idle')`; portal/[token]/page.tsx:104-106 server-rendered `{STATUS_LABEL[doc.status]?.[lang]}`.

Fix: Add localised error state; router.refresh() on success.

#### ○ [medium] No error.tsx / not-found.tsx anywhere: revoked portal links and missing documents show Next's bare English 404/error screens  <sub>ux-merge-83</sub>

`src/app/portal/[token]/page.tsx:69` · found by: portal, shell-ui

notFound() called in 6 places with no custom page; fetch failures show 'Application error' without shell or retry.

Evidence: portal/[token]/page.tsx:69 `if (!doc) notFound()`; invoices/[id]/page.tsx:24 `if (!doc) notFound()`; clients/[id]/page.tsx:41; `ls src/app/error.tsx src/app/not-found.tsx src/app/(app)/error.tsx` → missing.

Fix: Add portal/not-found.tsx (bilingual), (app)/not-found.tsx, error.tsx with retry, global-error.tsx.

#### ○ [medium] Revenue chart hover-only (no touch/keyboard/SR access), ~5px labels on phones  <sub>ux-merge-42</sub>

`src/components/charts/RevenueChart.tsx:38` · found by: dashboard-reports, lens:ux-mobile

Values only via onMouseEnter; no role/aria; 9px labels in 600-unit viewBox scale to ~4.5px on 300px container.

Evidence: RevenueChart.tsx:17 `const W = 600`; :26-27 viewBox + `className="w-full"`; :38 `onMouseEnter={() => setHovered(i)}`; :65 `fontSize: 9`; :71.

Fix: ResizeObserver-sized viewBox or HTML labels, onClick/touch, role=img + aria-label, visually-hidden table.

#### ○ [medium] Empty catalogue is a dead end: uncategorised 'Add item' hidden when no items; no empty state; empty-state copy inconsistent across pages  <sub>ux-merge-50</sub>

`src/components/forms/CatalogueManager.tsx:200` · found by: clients-catalogue, lens:ux-consistency

Group skipped when empty so a new catalogue offers no way to add an item without first creating a section; other pages use differing empty-state copy/CTAs.

Evidence: CatalogueManager.tsx:200 `if (!group.length && !isPending && !isAddingHere) return null`; :36 `const groupKeys = [...allCatNames, null]`; :317-323 only startAdd trigger; clients/[id]/page.tsx:130-132 vs InvoiceList.tsx:240,244; dashboard/page.tsx:232,267.

Fix: Always render uncategorised group / global Add item; shared EmptyState component.

#### ○ [medium] Catalogue row/section actions hover-only (invisible on touch and keyboard focus); rows are clickable divs without keyboard access; reorder drag-only  <sub>ux-merge-49</sub>

`src/components/forms/CatalogueManager.tsx:283` · found by: lens:ux-a11y-forms, clients-catalogue, lens:ux-mobile

Duplicate/Hide/Delete and Rename/Delete-section are opacity-0 until group-hover, never on focus; on iOS tapping the row toggles edit instead; row div has no role/tabIndex/onKeyDown; sort only via mouse drag; section buttons tiny (p-1 + 11px).

Evidence: CatalogueManager.tsx:282-285 `opacity-0 group-hover/row:opacity-100`; :224 `opacity-0 group-hover/header:opacity-100`; :225 `<Pencil size={11} />`; :246-247 `<div onClick={() => editingId === item.id ? cancelEdit() : startEdit(item)}` (no tabIndex/role); :238-243 `draggable onDragStart=…`.

Fix: Always show actions on touch/small screens plus focus-within; make row a button with aria-expanded; add Move up/down buttons; put Delete/Duplicate/Hide in EditForm.

#### ○ [medium] No way to cancel editing a client  <sub>ux-merge-48</sub>

`src/components/forms/ClientForm.tsx:196` · found by: clients-catalogue

Edit replaces card with form that only has Delete and Save; way back is saving or reloading.

Evidence: ClientEditSection.tsx:17-19 `if (editing) { return <ClientForm client={client} onSaved={() => setEditing(false)} /> }`; ClientForm.tsx:196-205.

Fix: Add onCancel prop and Cancel button.

#### ○ [medium] Validation feedback is toast-only; no inline errors, aria-invalid or focus management  <sub>ux-merge-117</sub>

`src/components/forms/DocumentBuilder.tsx:265` · found by: lens:ux-a11y-forms

Every validation path ends in toast.error; Input styles aria-invalid but it is never set; toasts vanish before user scrolls to the field.

Evidence: DocumentBuilder.tsx:265-266 `if (!clientId) { toast.error('Select a client.'); return }` (also :360-361,:599-600); ClientForm.tsx:80-83; PaymentPanel.tsx:48; grep aria-invalid → none.

Fix: errors map, inline messages with aria-invalid/aria-describedby, focus first invalid field.

#### ○ [medium] Invoice date and due date frozen at draft creation; drafts issued later carry a stale Ausstellungsdatum  <sub>ux-merge-94</sub>

`src/components/forms/DocumentBuilder.tsx:271` · found by: lens:rechnungsmerkmale, lens:dunning-payment-terms

date defaults to today() at mount, persisted by autosave, only replaced on issue if empty; due date computed from creation day, so printed Zahlungsziel shortens and reminders skew.

Evidence: DocumentBuilder.tsx:82 `useState(doc?.date ?? today())`; :84 `useState(doc?.due_date ?? addDays(today(), settings.default_payment_days))`; :271 `const effectiveDate = (status === 'sent' && !date) ? today() : date`; :368; :608-609 autosave.

Fix: On first issue set date=today unless user edited it, recompute due_date; show dates in the Mark-as-sent dialog.

#### ○ [medium] No onboarding or completeness check: invoices can be issued with empty IBAN, UID or address; QR silently omitted  <sub>ux-merge-101</sub>

`src/components/forms/DocumentBuilder.tsx:358` · found by: lens:ux-flows, lens:freelancer-workflows

ensureNumberAndSave validates only client and lines; footer prints empty 'IBAN:'; no setup checklist (grep onboarding → 0).

Evidence: DocumentBuilder.tsx:358-362 ensureNumberAndSave no settings checks; :334 `if (includeQr && type === 'invoice' && settings.iban && …)`; InvoiceDocument.tsx:341-342; epc-qr.ts:60 `if (!params.iban || !params.name) return null`.

Fix: settingsComplete() guard before issuing with link to missing section; dashboard 'Finish setup' checklist.

#### ○ [medium] Icon-only buttons have no accessible name; action labels hidden on mobile (Resend reminder renders empty); low idle contrast  <sub>ux-merge-4</sub>

`src/components/forms/DocumentBuilder.tsx:643` · found by: lens:ux-a11y-forms, builder-items, builder-doc, pdf, dashboard-reports, clients-catalogue, payments-status

Delete-line, remove-discount, calendar, grip, back-arrow, close-X, delete-payment, selection toggles, remove-tag, remove-logo, Share, Convert, catalogue actions have no aria-label (grep → 0), some only title; Delete/Duplicate/Convert/Reminder hide text with hidden sm:inline so on phones they are nameless; Resend button's only content is hidden sm:inline so it renders zero-width on mobile; mobile toolbar labels 10px; delete icons text-neutral-300.

Evidence: DocumentBuilder.tsx:643-646 `<button type="button" onClick={() => removeLine(id)} className="h-9 w-8 ... text-neutral-300 ..."><Trash2 size={14} /></button>`; ReminderButton.tsx:52-59 `<span className="hidden sm:inline">{sending ? 'Sending…' : 'Resend'}</span>`; ShareLinkButton.tsx:91-98 `title="Share"`; ConvertToInvoiceButton.tsx:24-26 `<span className="hidden sm:inline">`; ClientForm.tsx:50-52 `…

Fix: Add aria-label to every icon-only control, replace hidden sm:inline with sr-only sm:not-sr-only, always render an icon in Resend, raise contrast and label sizes.

#### ○ [medium] Muted text and icon controls fall below WCAG contrast in both themes  <sub>ux-merge-116</sub>

`src/components/forms/DocumentBuilder.tsx:644` · found by: lens:ux-a11y-forms

text-neutral-400 on white ≈2.5:1 for headings/captions/badges; dark neutral-500 ≈3.8:1; icon buttons text-neutral-300 ≈1.5:1; 10px labels.

Evidence: DocumentBuilder.tsx:725 `text-xs font-semibold text-neutral-400 dark:text-neutral-500`; :1003; :1300; :644 `text-neutral-300 hover:text-red-500`; :1338; PaymentPanel.tsx:184.

Fix: Use text-muted-foreground, neutral-600/300 badges, ≥neutral-500 icons, 11-12px labels.

#### ○ [medium] All custom modals/popovers (Gmail review, Mark-as-sent, Bookamat, Share, status confirm, bulk confirm, date popover) lack dialog semantics, focus trap, Escape, focus return  <sub>ux-merge-16</sub>

`src/components/forms/DocumentBuilder.tsx:653` · found by: lens:ux-a11y-forms, builder-doc, google, lists, bookamat, portal

Plain fixed divs: no role=dialog/aria-modal, focus stays behind, Tab cycles into background (can activate 'Mark as sent'), Escape does nothing, only ShareLink closes on backdrop; Gmail To field is plain text (no type=email) and labels unassociated; share X close has no name; no PDF preview in Gmail modal.

Evidence: grep -rn 'role="dialog"\|aria-modal' src → none; DocumentBuilder.tsx:653 `<div className="fixed inset-0 bg-black/40 z-50 …">`, :658-659 `<label …>To</label><input value={gmailPreview.to}`, :707; InvoiceList.tsx:416; PaymentPanel.tsx:263-264; ShareLinkButton.tsx:115, :122-124 `<X size={14} />`; DocumentStatusBar.tsx:104; :1410 date popover.

Fix: Use base-ui Dialog/AlertDialog or native <dialog showModal()> with aria-labelledby; htmlFor/id, type=email multiple; aria-label Close.

#### ○ [medium] Form labels not associated with controls (no htmlFor/id) across Builder, Settings, ClientForm, Catalogue, PaymentPanel; desktop line inputs unlabeled  <sub>ux-merge-13</sub>

`src/components/forms/DocumentBuilder.tsx:729` · found by: lens:ux-a11y-forms, builder-items, builder-doc, clients-catalogue, settings

Outside ClientForm.Field and login, labels are visual only; grid rows rely on header spans; Settings has 48 unlabeled inputs, icon-only remove-logo, tabs/nav without ARIA; screen readers announce unnamed fields and clicking a label does nothing.

Evidence: grep -rn htmlFor src → only login/page.tsx:37,48 and ClientForm.tsx:215; DocumentBuilder.tsx:729-731 `<Label>Client *</Label>` / `<select value={clientId}`; :1048-1049 header spans; SettingsForm.tsx:654-655 `<label className={lbl}>Company name</label> <input`; :629-634 remove-logo `<X size={10}`; ClientForm.tsx:153-154; CatalogueManager.tsx:157-158.

Fix: Give every control an id (useId) and htmlFor, aria-label for grid/search inputs, shared Field component; role=tablist/aria-current for Settings tabs/nav.

#### ○ [medium] Native selects and tag input remove focus outline without replacement  <sub>ux-merge-115</sub>

`src/components/forms/DocumentBuilder.tsx:766` · found by: lens:ux-a11y-forms

Twelve selects use focus:outline-none with no ring; ClientForm tag input outline-none with no focus-within on wrapper.

Evidence: DocumentBuilder.tsx:765-766 `<select value={language} … focus:outline-none">`; :774,:783,:1009,:1027,:1257,:1265; InvoiceList.tsx:226; QuoteList.tsx:111; ClientList.tsx:105; CreditNoteList.tsx:100; ReportControls.tsx:42; ClientForm.tsx:61 `outline-none`, :44 wrapper.

Fix: Shared Select token with focus-visible:ring-3; focus-within:ring-2 on TagInput.

#### ○ [medium] Line descriptions and note lines are single-line inputs; no line breaks  <sub>ux-merge-10</sub>

`src/components/forms/DocumentBuilder.tsx:1182` · found by: builder-items

Description and Note rows are <input>s; Enter does nothing and long text is clipped.

Evidence: DocumentBuilder.tsx:1182-1186 `<Input value={line.description} ... placeholder="Description…"`; :1107-1112 `<input ... placeholder="Note…"`.

Fix: Auto-growing textarea; render pre-line in PDF/portal.

#### ○ [medium] Light-only colours in dark mode: tax-note box, report banners, 'Add & use' button, balance/icon colours  <sub>ux-merge-19</sub>

`src/components/forms/DocumentBuilder.tsx:1239` · found by: lens:ux-consistency, lens:ux-mobile, builder-doc, dashboard-reports

Amber reverse-charge note, amber/blue report boxes have no dark: variants; 'Add & use' is bg-neutral-900 on a dark:bg-neutral-900 popover; amber/green balance text and delete icon hover light-only.

Evidence: DocumentBuilder.tsx:797 `<div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 …">`; :984/:1239 `bg-neutral-900 text-white` inside :946/:1201 `dark:bg-neutral-900`; :1380 `'text-amber-600' : 'text-green-600'`; reports/page.tsx:69 `bg-amber-50 … text-amber-800`, :95 `bg-blue-50 … text-blue-800`.

Fix: Add dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-300 (blue equivalents), dark:bg-white dark:text-neutral-900 on 'Add & use', dark variants for balance text.

#### ○ [medium] UI copy mixes German and English (builder labels flip with document language, Settings 'UID-Nummer', Reports UVA/English, toast names mismatch card titles)  <sub>ux-merge-5</sub>

`src/components/forms/DocumentBuilder.tsx:1394` · found by: builder-items, builder-doc, lens:ux-consistency, dashboard-reports, settings, bookamat

Builder totals/notes labels switch to German per document language while neighbouring labels stay English ('Line Items … Subtotal … Netto … Gesamt', 'USt.' on English docs); Settings has 'UID-Nummer', 'Deutsch', 'Erlöskonto', 'From Mein Account → API'; Reports mixes 'VAT Report'/'Umsatzsteuervoranmeldung'/'Net revenue'; toasts say 'Brand saved.' for the 'Company' card, 'Contact & address saved.' for 'Address'.

Evidence: DocumentBuilder.tsx:1394 `{language === 'de' ? 'Anmerkungen (auf Dokument)' : 'Notes (on document)'}` vs :1398 `<Label>Internal notes</Label>`; :1313 `'Netto' : 'Subtotal'`, :1365 `USt. {g.rate}%`, :874 `Subtotal`; SettingsForm.tsx:738 `UID-Nummer`, :1282 `Income account (Erlöskonto)`, :307 `toast.success('Brand saved.')` vs :616 `title="Company"`; reports/page.tsx:61-62, :75, :105-107.

Fix: Keep editor/app chrome in one language (English) and localise only printed content; make toasts match card titles.

#### ○ [medium] 'Send via Superhuman' hard-codes a product name for a mailto fallback; mobile says 'Email'; no feedback for mailto+download  <sub>ux-merge-14</sub>

`src/components/forms/DocumentBuilder.tsx:1497` · found by: builder-items, builder-doc, pdf, google, lens:ux-consistency

Without Gmail the desktop button names a third-party client while mobile says 'Email'; other pairs diverge ('PDF' vs 'Download PDF'); the flow opens mail client and downloads a PDF with no toast about attaching.

Evidence: DocumentBuilder.tsx:1496-1498 `<Mail size={13} /> Send via Superhuman` vs :1454 `{settings.gmail_email ? 'Gmail' : 'Email'}`; :537-546 openInEmail; :1442 `PDF` vs :1484 `Download PDF`.

Fix: Label 'Open in email app' on both layouts, align labels, toast 'PDF downloaded – attach it'.

#### ○ [medium] Settings/ClientForm two- and three-column grids have no mobile breakpoint; numbering grid overflows  <sub>ux-merge-60</sub>

`src/components/forms/SettingsForm.tsx:811` · found by: lens:ux-mobile, settings

DE/EN footer textareas, tax-note inputs, company/owner, Bookamat fields, ClientForm Name/Company etc. use grid-cols-2/3 without sm:, giving ~130px cells on phones; numbering row fixed 100px+72px+72px leaves ~15px for the format input.

Evidence: SettingsForm.tsx:652 `grid grid-cols-2 gap-3`; :716 `grid grid-cols-3 gap-3`; :811 `grid grid-cols-[100px_72px_1fr_72px] gap-3`; :890/:913/:936/:971/:996 `grid grid-cols-2 gap-4`; :1236; ClientForm.tsx:133,145,151,167,179 `grid grid-cols-2 gap-3`.

Fix: grid-cols-1 sm:grid-cols-2/3; stack numbering row below sm; or DE/EN language toggle.

#### ○ [medium] Invoice/quote/credit-note email templates show no default placeholder and no preview  <sub>ux-merge-61</sub>

`src/components/forms/SettingsForm.tsx:1090` · found by: settings

Only Reminder tab shows defaults; other types placeholder undefined so blank = hidden hard-coded text in DocumentBuilder; no rendered preview.

Evidence: SettingsForm.tsx:1090-1094 `placeholder={ activeDocTab === 'reminder' && … ? DEFAULT_SUBJECT_DE : … : undefined }`; DocumentBuilder.tsx:527-528 `const defaultBody = lang === 'de' ? `Guten Tag,…`.

Fix: Shared defaults module, placeholders for all types, reset-to-default and live preview.

#### ○ [medium] Connection status is a permanent green badge with no health information  <sub>ux-merge-71</sub>

`src/components/forms/SettingsForm.tsx:1130` · found by: google

No last-used, test-connection or revoked-token signal; failures only as generic errors or cron logs.

Evidence: SettingsForm.tsx:1130-1144 `{gmailEmail ? (<div className="... border-green-200 ..."> <CheckCircle size={14} />`; cron/reminders/route.ts:163 `console.log(...)`.

Fix: 'Test connection' action, last_error/last_success, red reconnect state on invalid_grant.

#### ○ [medium] Bookamat integration cannot be disconnected or cancelled; Save only reachable after 'Load accounts'  <sub>ux-merge-62</sub>

`src/components/forms/SettingsForm.tsx:1259` · found by: bookamat, settings

Connected card offers only 'Change'; Save appears only in accounts branch which needs non-empty credentials, so credentials cannot be cleared; no Cancel/Disconnect; toast says 'connected' when only mapping changed.

Evidence: SettingsForm.tsx:464 `if (!bookamatUsername || !bookamatApiKey) { toast.error('Enter username and API key first.'); return }`; :1259-1268 `{!bookamatAccounts ? ( <button … onClick={loadBookamatAccounts}`; :1313-1320 Save inside accounts branch.

Fix: Add Cancel and Disconnect (null bookamat_* columns), allow saving without reloading accounts, accurate toast.

Merged with: [missing] No Bookamat disconnect/country control, no Gmail token health display, no 'test email' tooling

#### ○ [medium] Primary/secondary buttons use at least six hand-rolled styles alongside the shadcn Button  <sub>ux-merge-109</sub>

`src/components/layout/DuplicateDocumentButton.tsx:72` · found by: lens:ux-consistency

Document header row mixes four button heights/radii; lists, dashboard, settings hand-roll classes.

Evidence: DuplicateDocumentButton.tsx:72 `text-sm px-2.5 py-1.5 rounded-md border`; DeleteDocumentButton.tsx:58 `px-2.5 py-1 rounded-md`; ConvertToInvoiceButton.tsx:24 `<Button variant="outline" size="sm"`; ShareLinkButton.tsx:95 `p-1.5`; InvoiceList.tsx:210; dashboard/page.tsx:174; SettingsForm.tsx:108.

Fix: Use <Button> variants everywhere; one toolbar size.

#### ○ [medium] Navigation accessibility gaps: unnamed logo links, no aria-current, 'More' sheet without dialog semantics/Escape, unnamed close button  <sub>ux-merge-91</sub>

`src/components/layout/MobileHeader.tsx:108` · found by: shell-ui

grep aria-label/aria-current/role=dialog over Sidebar, MobileHeader, Logo → 0; no Escape handling; More trigger lacks aria-expanded.

Evidence: Sidebar.tsx:39-41 `<Link href="/dashboard" …><Logo /></Link>`; MobileHeader.tsx:108-110 `<button onClick={() => setMoreOpen(false)} …><X size={16} /></button>`; :95 `md:hidden fixed inset-0 z-50 flex flex-col justify-end`.

Fix: aria-label on logo, aria-current=page, aria-label Close, aria-expanded, role=dialog with Escape/focus trap.

#### ○ [medium] PDF generation failure swallowed during Bookamat sync; user sees plain 'Synced to Bookamat.'  <sub>ux-merge-73</sub>

`src/components/layout/PaymentPanel.tsx:139` · found by: bookamat

Errors only console.warn; no hint no PDF attached; no later attach.

Evidence: PaymentPanel.tsx:112-115 `catch (err) { console.warn('PDF pre-generation failed:', err)`; :139-140 `if (!pdfResult) { toast.success('Synced to Bookamat.')`.

Fix: toast.warning and an 'Attach PDF' action.

#### ○ [medium] Destructive actions execute on one click with no confirmation/undo: remove payment (flips status), reset Bookamat sync, revoke share link, remove logo, disconnect Gmail  <sub>ux-merge-74</sub>

`src/components/layout/PaymentPanel.tsx:182` · found by: lens:ux-flows, lens:ux-a11y-forms, bookamat

Payment trash icon (text-neutral-300, no name) deletes immediately and sets invoice back to 'sent'; Reset sync clears booking link (duplicate on resync) at neutral-300 contrast; disconnecting Gmail silently breaks Drive and reminders.

Evidence: PaymentPanel.tsx:182-187 `<button onClick={() => removePayment(p.id)} className="ml-auto text-neutral-300 hover:text-red-500"><Trash2 size={13} />`; :79-91 removePayment no confirm; :244 `text-xs text-neutral-300 dark:text-neutral-600 hover:text-red-400`, :93-101 resetBookamatSync; ShareLinkButton.tsx:159-165 `onClick={revokeLink}`; SettingsForm.tsx:629-635 `onClick={removeLogo}`, :1136-1143 `onCl…

Fix: Confirm dialog or undo toast for each, aria-labels, at least neutral-500 icons, warn about Gmail dependencies.

#### ○ [medium] Many frequently used controls have touch targets far below 44pt (10–28px icon-only buttons)  <sub>ux-merge-103</sub>

`src/components/layout/PaymentPanel.tsx:182` · found by: lens:ux-mobile

Mobile list checkbox 16px, delete-payment 13px, remove-discount 12px, tag X 10px, logo-remove 20px, Share/More-close ~27px, Add payment 28px tall; mis-taps delete payments.

Evidence: InvoiceList.tsx:254-262 `<Square size={16} />`; PaymentPanel.tsx:182-187 `<Trash2 size={13} />`; DocumentBuilder.tsx:642-646 `h-9 w-8`; ClientForm.tsx:50-52 `<X size={10} />`.

Fix: min-h-11 min-w-11 / p-2.5 on icon buttons, h-11 mobile CTAs, touch-manipulation.

#### ○ [medium] Reminder sends instantly with no preview; entry point disappears entirely when Gmail is not connected  <sub>ux-merge-105</sub>

`src/components/layout/ReminderButton.tsx:64` · found by: lens:ux-flows

First click fires the email; no review modal; button returns null without hint when Gmail unconfigured.

Evidence: ReminderButton.tsx:64-67 `<button onClick={sendReminder}`, :28-32 immediate fetch; :18 `if (!gmailConfigured) return null`; InvoicePageClient.tsx:49.

Fix: Reuse review modal; disabled button with 'Connect Gmail' link.

#### ○ [medium] 'Copy' in the share modal silently uploads the PDF to Drive as a side effect  <sub>ux-merge-67</sub>

`src/components/layout/ShareLinkButton.tsx:82` · found by: google, portal

Copy triggers server PDF render and Drive upload when the pre-checked box is on; repeated Copy re-uploads; checkbox sits below the button.

Evidence: ShareLinkButton.tsx:82-87 `async function handleCopyWithDrive() { await copyLink(); if (saveToDrive && driveConfigured) { await uploadToDrive() } }`; :141 `{driveUploading ? 'Saving…' : copied ? 'Copied' : 'Copy'}`; :145-155.

Fix: Separate 'Save to Drive' button; keep Copy clipboard-only.

#### ○ [medium] CSV export unusable in Austrian Excel: comma delimiter, dot decimals, ISO dates, no BOM, gross total only  <sub>ux-merge-35</sub>

`src/components/lists/InvoiceList.tsx:65` · found by: lists, lens:dates-money-i18n

de-AT Excel opens it as one column, umlauts garbled, totals as text; no net/VAT/treatment/paid columns for the Steuerberater.

Evidence: InvoiceList.tsx:53 headers; :60 `calcTotal(...).toFixed(2)`; :65 `.join(',')`; :66 `new Blob([csv], { type: 'text/csv;charset=utf-8;' })` (no BOM).

Fix: BOM, ';' delimiter, comma decimals, dd.mm.yyyy, add Netto/USt/Brutto/Steuerbehandlung/Bezahlt columns.

#### ○ [medium] List controls inaccessible: sortable <th> click-only without aria-sort, icon-only selection toggles without checkbox semantics, hidden bulk bar stays in tab order, unlabeled search/filter  <sub>ux-merge-33</sub>

`src/components/lists/InvoiceList.tsx:186` · found by: lists, lens:ux-a11y-forms

th not focusable, sort icon 12px at 30% opacity; selection buttons have no role=checkbox/aria-checked/label; bulk bar hidden via opacity/translate so 'Delete' remains focusable while invisible; close X unnamed; search/status select have no label. Same in Client/Quote/CreditNote lists.

Evidence: InvoiceList.tsx:186-189 `<th className="… cursor-pointer …" onClick={() => toggleSort(col)}>`; :45 `opacity-30`; :254-262 `<button onClick={() => toggleOne(doc.id)}>{selected.has(doc.id) ? <CheckSquare/> : <Square/>}`; :361-364 `${hasSelection ? 'translate-y-0 opacity-100' : …`; :404-409 `<X size={14} />`; :217-222 search; grep aria-sort → none.

Fix: Button inside th with aria-sort, real checkboxes with aria-label, inert/conditional bulk bar, aria-labels on close/search/filter.

#### ○ [medium] App UI renders raw ISO dates everywhere (lists, dashboard, client page, payments, report period) while PDF uses dd.mm.yyyy; payment list has no empty state  <sub>ux-merge-30</sub>

`src/components/lists/InvoiceList.tsx:337` · found by: lens:ux-consistency, lists, clients-catalogue, dashboard-reports, payments-status

formatDate exists but lists, 'Last Invoice', dashboard last payment, client history, payment rows and report period print '2026-10-12'; payments card shows only header when empty.

Evidence: InvoiceList.tsx:337-338 `{doc.date ?? '—'}` / `{doc.due_date ?? '—'}`; QuoteList.tsx:147,192; CreditNoteList.tsx:141; ClientList.tsx:204 `{lastInvoicedMap[c.id] ?? '—'}`; dashboard/page.tsx:247 `{lastPayment.date}`; clients/[id]/page.tsx:148 `{typeLabel[doc.type]} · {doc.date}`; PaymentPanel.tsx:179 `{p.date}`, :175; reports/page.tsx:70 `Period: <strong>{qStart}</strong>`; document.ts:117 formatDa…

Fix: Use formatDate(d,'de') at every UI date site; add 'No payments recorded yet'; keep ISO only in CSV.

#### ○ [medium] Bulk delete confirmation gives no detail about what will be deleted  <sub>ux-merge-34</sub>

`src/components/lists/InvoiceList.tsx:419` · found by: lists

Only 'Delete N invoices? This cannot be undone.'; no numbers, no issued-invoice warning, no mention of numbering gaps or Drive/Bookamat records.

Evidence: InvoiceList.tsx:419-422 `{bulkConfirm.label} {selected.size} invoice{…}?` … `This cannot be undone.`.

Fix: List numbers/clients and warn about issued invoices.

#### ○ [medium] PDF table header not repeated on continuation pages; rows may split across pages  <sub>ux-merge-23</sub>

`src/components/pdf/InvoiceDocument.tsx:198` · found by: pdf

Header has no fixed prop, rows no wrap={false}.

Evidence: InvoiceDocument.tsx:198 `<View style={s.tableHeader}>`; :260 `<View key={i} style={s.tableRow}>`.

Fix: Add fixed to header, wrap={false} to rows.

#### ○ [medium] PDF: EPC QR has no caption and is small; tax note 8pt grey italic; footer lacks company name/country; prints empty 'IBAN:'/'BIC:'  <sub>ux-merge-24</sub>

`src/components/pdf/InvoiceDocument.tsx:316` · found by: lens:ux-consistency, pdf

Bare 72pt QR with no 'Scan to pay' hint; legally relevant tax note is least prominent text; Contact column omits company_name/country; empty bank lines printed.

Evidence: InvoiceDocument.tsx:13 `qrBelowTotals: { width: 72, height: 72 …}`; :316-318 `<Image src={qrCodeDataUri} style={s.qrBelowTotals} />` (no Text); :50 `taxNote: { fontSize: 8, color: '#6b6b6b', fontStyle: 'italic' }`; :331-334 footer; :341-342 `{'IBAN: '}{settings.iban}{'\n'}{'BIC: '}{settings.bic}`.

Fix: ~90pt QR with localised caption, 9pt tax note, company name/country in Contact, omit empty lines.

#### ○ [medium] formatMoney hard-codes de-AT (and is often called without currency); English docs get German number format and ambiguous en-GB dates  <sub>ux-merge-12</sub>

`src/lib/utils/document.ts:114` · found by: lens:dates-money-i18n, lens:ux-consistency, pdf, builder-items, builder-doc

English invoices show '€ 1.234,56' / '$ 1.234,56' and 'Date: 09/10/2026'; catalogue popover/manager, dashboard KPIs and overdue banner call formatMoney(x) without currency, so USD/GBP values show €; catalogue picker copies default_price unconverted into USD/GBP documents.

Evidence: document.ts:113-115 `export function formatMoney(amount: number, currency = 'EUR'): string { return new Intl.NumberFormat('de-AT', { style: 'currency', currency }).format(amount) }`; :121-123 `lang === 'de' ? 'de-AT' : 'en-GB'`; InvoiceDocument.tsx:141; DocumentBuilder.tsx:1217 `{formatMoney(item.default_price)}/{item.unit}` and :221-228 `unit_price: item.default_price`.

Fix: Add a lang parameter (en-IE/en-GB), pass currency at every call site, warn/convert when document currency is not EUR.

#### ○ [medium] EPC QR printed on USD/GBP invoices with empty amount, inviting an unspecified EUR transfer  <sub>ux-merge-95</sub>

`src/lib/utils/epc-qr.ts:31` · found by: lens:dunning-payment-terms

EPC is SEPA/EUR only; non-EUR docs leave amount blank so client types EUR amount with no conversion.

Evidence: epc-qr.ts:7-9 comment; :31 `const amountStr = amountEur != null && amountEur > 0 ? `EUR${amountEur.toFixed(2)}` : ''`; DocumentBuilder.tsx:339 `amountEur: currency === 'EUR' ? totals.balance_due : undefined`; portal pdf/route.ts:40; drive-pdf/route.ts:45.

Fix: Render QR only for EUR, or encode EUR equivalent with rate note.

#### ○ [low] 'Pending Quotes' includes drafts and never expires old quotes  <sub>ux-merge-45</sub>

`src/app/(app)/dashboard/page.tsx:43` · found by: dashboard-reports

Query includes 'draft'; no valid-until handling.

Evidence: dashboard/page.tsx:43 `.in('status', ['draft', 'sent'])`; :262 `Pending Quotes`.

Fix: Only 'sent'; flag quotes past due_date.

#### ○ [low] Two of four KPI cards are links and two are not, with identical visuals  <sub>ux-merge-47</sub>

`src/app/(app)/dashboard/page.tsx:141` · found by: dashboard-reports

'Paid this month' and 'Revenue' have href null but look like Outstanding/Overdue.

Evidence: dashboard/page.tsx:141 `href: null,`, :151 `href: null,` vs :121 `href: '/invoices?status=outstanding',`.

Fix: Link them or visually distinguish.

#### ○ [low] Overdue alert banner sits at the very bottom of the dashboard  <sub>ux-merge-44</sub>

`src/app/(app)/dashboard/page.tsx:288` · found by: dashboard-reports

Most actionable warning rendered after chart and panels, below the fold.

Evidence: dashboard/page.tsx:287-289 `{/* Overdue alert */}` / `{overdue.length > 0 && (`.

Fix: Move under the page header.

#### ○ [low] Mismatched loading skeletons: list skeleton shown for new-document forms, client skeleton is the invoice skeleton, widths/spacing differ  <sub>ux-merge-56</sub>

`src/app/(app)/invoices/loading.tsx:19` · found by: shell-ui, clients-catalogue

loading.tsx wraps nested routes so /invoices/new shows the 8-row table skeleton; clients/[id] skeleton max-w-4xl vs page max-w-5xl with no stat cards; dashboard space-y-8 vs space-y-6.

Evidence: invoices/loading.tsx:19 `{[...Array(8)].map(` vs invoices/new/page.tsx:15; clients/[id]/loading.tsx:1-3 `export default function InvoiceDetailLoading()` / `max-w-4xl` vs page.tsx:69 `max-w-5xl`; dashboard/loading.tsx:3 `space-y-8` vs page.tsx:167.

Fix: Form-shaped loading.tsx under */new; mirror page structure in skeletons.

Merged with: [quality] Nine loading.tsx files are verbatim copies of two templates with misleading component names and wrong layout

#### ○ [low] Auth redirect loses the deep link; login does not redirect signed-in users  <sub>ux-merge-87</sub>

`src/app/(app)/layout.tsx:10` · found by: shell-ui, data-security

Unauthenticated visits go to /login without return path; login always goes to /dashboard; no getUser on /login.

Evidence: (app)/layout.tsx:10 `if (!user) redirect('/login')`; login/page.tsx:25 `window.location.href = '/dashboard'`.

Fix: /login?next=path, honour same-origin next, redirect signed-in visitors.

#### ○ [low] No way to see which invoices went into the VAT report  <sub>ux-merge-46</sub>

`src/app/(app)/reports/page.tsx:70` · found by: dashboard-reports

Only a count is shown; figures cannot be verified per document.

Evidence: reports/page.tsx:70 `{yearDocs.length} invoice{…} included (sent, paid, overdue)`.

Fix: Collapsible table of included documents with links.

#### ○ [low] Login form flush against screen edges on 375px iPhones  <sub>ux-merge-104</sub>

`src/app/(auth)/login/page.tsx:30` · found by: lens:ux-mobile

max-w-sm (384px) column with no horizontal padding.

Evidence: login/page.tsx:29-30 `<div className="min-h-screen flex items-center justify-center …"> <div className="w-full max-w-sm space-y-6">`.

Fix: Add px-4 to the outer container.

#### ○ [low] Raw Postgres/Bookamat error bodies surfaced verbatim in toasts  <sub>ux-merge-76</sub>

`src/app/api/bookamat/sync/route.ts:122` · found by: bookamat, data-security

Routes forward upstream JSON/HTML; settings/client saves toast error.message ('violates not-null constraint').

Evidence: bookamat/sync/route.ts:121-122 `const text = await bookingRes.text() return NextResponse.json({ error: text }, { status: 500 })`; bookamat/accounts/route.ts:34-35; SettingsForm.tsx:305 `toast.error(error.message)`; ClientForm.tsx:126.

Fix: Map 401/403/400 and PG codes to friendly messages; log raw server-side.

#### ○ [low] Reminder email language follows client record while attached PDF follows invoice language  <sub>ux-merge-113</sub>

`src/app/api/invoices/[id]/reminder/route.ts:34` · found by: lens:ux-consistency

English email with German PDF when languages differ.

Evidence: reminder/route.ts:34 `const lang = client.language === 'en' ? 'en' : 'de'`; cron/reminders/route.ts:49 same, :87 `const invLang = (invoice.language ?? 'de')`.

Fix: Derive from invoice.language with client fallback.

#### ○ [low] Browser/PWA title is always 'Mado Invoice'; no per-page or portal titles, portal inherits lang='de'  <sub>ux-merge-84</sub>

`src/app/layout.tsx:13` · found by: shell-ui, portal

Only root metadata; tabs/app switcher never show invoice number; portal tab reads 'Mado Invoice' and English docs run under German lang.

Evidence: src/app/layout.tsx:13-14 `export const metadata: Metadata = { title: "Mado Invoice",`; grep generateMetadata src → only root; :25 `<html lang="de"`.

Fix: Title template + per-page metadata; portal generateMetadata with noindex and lang wrapper.

#### ○ [low] html lang="de" while the UI is English-only with no i18n layer; section headings are <p>/<span>, bottom bar not <nav>  <sub>ux-merge-92</sub>

`src/app/layout.tsx:25` · found by: shell-ui, lens:freelancer-workflows, lens:ux-a11y-forms

Screen readers use German voice for English UI and Chrome offers translation; no heading outline below h1; landmarks unlabeled.

Evidence: src/app/layout.tsx:25 `<html lang="de" className="h-full antialiased" suppressHydrationWarning>`; Sidebar.tsx:16-23 `label: 'Dashboard'`…; grep i18n/next-intl → 0; DocumentBuilder.tsx:725 `<p className="text-xs font-semibold … uppercase tracking-wider">Client & Dates</p>`, :807, :1391; portal/layout.tsx:4 no lang.

Fix: lang="en" (or follow a ui_language setting), lang on portal wrapper, h2/h3 section titles, <nav aria-label>.

#### ○ [low] PWA manifest inconsistent: start_url /invoices vs /dashboard, forced black theme/background, portrait lock  <sub>ux-merge-93</sub>

`src/app/manifest.ts:8` · found by: shell-ui

Light-theme users get black splash/chrome; tablets cannot use landscape.

Evidence: manifest.ts:8-12 `start_url: '/invoices', display: 'standalone', orientation: 'portrait', background_color: '#0a0a0a', theme_color: '#0a0a0a'`; src/app/page.tsx:4 `redirect('/dashboard')`.

Fix: start_url /dashboard, viewport.themeColor with media queries, light background, orientation any.

#### ○ [low] Portal payment box: empty 'IBAN:'/'BIC:' lines, unlabeled reference, no EPC QR, native confirm(), html lang='de' for English docs, hover on read-only rows  <sub>ux-merge-81</sub>

`src/app/portal/[token]/page.tsx:283` · found by: lens:ux-consistency, portal

Lines rendered unconditionally; number shown without 'Verwendungszweck'; no QR though PDF has one; confirm() for accept/decline; lang inherited.

Evidence: portal/[token]/page.tsx:283-285 `<div>IBAN: <span className="font-mono">{settings.iban}</span></div>` / `BIC:` / `<div className="text-xs text-blue-600 mt-1">{doc.number}</div>`; grep 'qr' page.tsx → none; QuoteActions.tsx:22 `if (!confirm(msg)) return`; app/layout.tsx:25 `<html lang="de"`; :213 `hover:bg-neutral-50`.

Fix: Guard lines, add Verwendungszweck label and amount, render EPC QR <img>, styled inline confirm, lang from doc.language, drop hover.

#### ○ [low] Enter does not save the catalogue item form  <sub>ux-merge-51</sub>

`src/components/forms/CatalogueManager.tsx:182` · found by: clients-catalogue

Save/Cancel are plain buttons outside a form, unlike section rename inputs.

Evidence: CatalogueManager.tsx:182 `<button onClick={onSave} …>` (no form) vs :209 `<form onSubmit={…saveCatRename()}`.

Fix: Wrap EditForm in <form onSubmit>, Save type=submit, Escape cancels.

#### ○ [low] New-client defaults ignore Settings (language hard-coded 'de', country empty)  <sub>ux-merge-54</sub>

`src/components/forms/ClientForm.tsx:144` · found by: clients-catalogue

Form defaults language 'de' not settings.default_language; country '' so Austrian clients get no country on PDF.

Evidence: ClientForm.tsx:160 `defaultValue={client?.language ?? 'de'}`; :144 `defaultValue={client?.country ?? ''}`.

Fix: Pass settings; default country per language.

#### ○ [low] Missing input semantics for phone keyboards: Gmail To not type=email, search inputs not type=search, login lacks autoComplete  <sub>ux-merge-90</sub>

`src/components/forms/DocumentBuilder.tsx:659` · found by: lens:ux-mobile, shell-ui

iOS capitalises recipient and hides @; no clear-x/enterKeyHint on search; password managers may not fill login.

Evidence: DocumentBuilder.tsx:659-663 `<input value={gmailPreview.to} …/>`; InvoiceList.tsx:217-222 search input; login/page.tsx:38-45 no autoComplete (grep → 0).

Fix: type=email inputMode=email autoCapitalize=off; type=search enterKeyHint; autoComplete email/current-password.

#### ○ [low] Client dropdown shows ' (Company)' for company-only clients and lists inactive/lead clients without grouping or search  <sub>ux-merge-20</sub>

`src/components/forms/DocumentBuilder.tsx:733` · found by: builder-doc, clients-catalogue

Option text starts with blank for nameless clients; all statuses mixed in one native select sorted by name; inactive clients billable by accident.

Evidence: DocumentBuilder.tsx:733-734 `{clients.sort(...).map(c => (<option …>{c.name}{c.company ? ` (${c.company})` : ''}</option>`; invoices/new/page.tsx:10 `.select('*').order('name')` no status filter.

Fix: Display company || name helper; searchable combobox; group/hide inactive.

#### ○ [low] Form controls have three heights and two radii, causing misaligned line-item rows  <sub>ux-merge-112</sub>

`src/components/forms/DocumentBuilder.tsx:1253` · found by: lens:ux-consistency

Input h-8 rounded-lg beside selects h-9 rounded-md; Settings/Catalogue h-9; ClientForm selects py-1.5.

Evidence: ui/input.tsx:12 `h-8 … rounded-lg`; DocumentBuilder.tsx:1253-1257 `<Input …/>` then `<select … className="h-9 border … rounded-md …">`; :1005-1009; SettingsForm.tsx:14; CatalogueManager.tsx:17; ClientForm.tsx:22.

Fix: Add a Select primitive matching Input and use Input everywhere.

#### ○ [low] VAT column stays visible and defaults to 20% on reverse-charge / non-EU documents  <sub>ux-merge-15</sub>

`src/components/forms/DocumentBuilder.tsx:1263` · found by: builder-items

Per-line VAT select shown and defaults to 20% though totals ignore it.

Evidence: DocumentBuilder.tsx:1263-1267 `<select value={line.vat_rate}`; :48 `vat_rate: 20`; document.ts:19 `const vatApplies = !taxTreatment || taxTreatment === 'at_vat'`.

Fix: Hide/disable VAT column when taxTreatment !== 'at_vat'.

#### ○ [low] Toggle, chip, tab, quarter and status controls expose no selected/expanded state (aria-pressed/current/expanded missing)  <sub>ux-merge-41</sub>

`src/components/forms/DocumentBuilder.tsx:1324` · found by: lens:ux-a11y-forms, dashboard-reports

Discount %/currency toggles, quick chips, Settings nav/tabs, report quarter buttons, mobile details disclosure, status trigger show state only by colour; year select unlabeled.

Evidence: DocumentBuilder.tsx:1324-1326 `onClick={() => setDiscountType('percent')} className={… discountType === 'percent' ? 'bg-neutral-900 …`; :753-760; SettingsForm.tsx:573-586, :1035-1065; ReportControls.tsx:26-28 `<button key={q} onClick={() => navigate(year, q)}`, :39-42 `<select value={year}`; DocumentStatusBar.tsx:78-84.

Fix: aria-pressed on toggles/chips, role=tablist/tab, aria-expanded/haspopup, aria-label="Year".

#### ○ [low] 'Gmail connected successfully.' toast repeats on every reload (?gmail=connected never stripped)  <sub>ux-merge-70</sub>

`src/components/forms/SettingsForm.tsx:290` · found by: google

Effect fires whenever searchParams contains gmail=.

Evidence: SettingsForm.tsx:290-294 `useEffect(() => { const status = searchParams.get('gmail'); if (status === 'connected') toast.success(...) }, [searchParams])`.

Fix: router.replace('/settings') after toast.

#### ○ [low] Toast wording inconsistent in form, punctuation and naming  <sub>ux-merge-110</sub>

`src/components/forms/SettingsForm.tsx:307` · found by: lens:ux-consistency

'Deleted.' vs 'Client deleted.'; missing periods; 'Brand saved.' for Company card; raw enums in status toasts; 'Item added.' vs 'Item added to catalogue.'.

Evidence: SettingsForm.tsx:307 `'Brand saved.'`, :327 `'Contact & address saved.'`, :495 `'Bookamat connected.'`; DocumentStatusBar.tsx:73; InvoiceList.tsx:150 `marked as ${newStatus}.`; ShareLinkButton.tsx:47,59; CatalogueManager.tsx:66,84; DocumentBuilder.tsx:213,314.

Fix: One pattern '<Object> <verb>.' with label map for interpolations.

#### ○ [low] Logo upload unreachable by keyboard (file input display:none inside non-focusable label)  <sub>ux-merge-118</sub>

`src/components/forms/SettingsForm.tsx:645` · found by: lens:ux-a11y-forms

hidden input removed from tab order; label not focusable.

Evidence: SettingsForm.tsx:643-646 `<label className="cursor-pointer …"> … <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} …/></label>`.

Fix: sr-only input with focus-within ring, or a button calling inputRef.click().

#### ○ [low] Numbering card lacks guidance on consequences; payment-days input has no min  <sub>ux-merge-66</sub>

`src/components/forms/SettingsForm.tsx:783` · found by: settings

No warning about changing format after issuing, counter not resetting per year, lowering Next # colliding; 0 payment days silently becomes 14.

Evidence: SettingsForm.tsx:783 description text; :845 `<input type="number" … value={defaults.default_payment_days}`; :368 `parseInt(...) || 14`.

Fix: Helper text, confirm on lowering counter, min=0 and inline validation.

#### ○ [low] Tax Notes card hidden under the 'PDF Footer' nav item  <sub>ux-merge-64</sub>

`src/components/forms/SettingsForm.tsx:961` · found by: settings

Legally relevant RC/non-EU texts only visible when 'PDF Footer' selected.

Evidence: SettingsForm.tsx:72 `{ id: 'footer', label: 'PDF Footer', Icon: FileText }`; :961-962 `<SectionCard title="Tax Notes"`.

Fix: Add a 'Tax' nav item or rename to 'PDF texts'.

#### ○ [low] Gmail connect/disconnect gives no loading or detailed error state  <sub>ux-merge-88</sub>

`src/components/forms/SettingsForm.tsx:1146` · found by: data-security

Failures only ?gmail=error with generic toast.

Evidence: SettingsForm.tsx:1146 `<a href="/api/gmail/auth"`; :290-294 `toast.error('Gmail connection failed. Please try again.')`; gmail/callback/route.ts:8,23 both `/settings?gmail=error`.

Fix: Pass reason codes in redirect and show them.

#### ○ [low] Bookamat connected card can render a stray '0' after saving with the placeholder selected  <sub>ux-merge-77</sub>

`src/components/forms/SettingsForm.tsx:1224` · found by: bookamat

Number('') = 0 and `{0 && …}` prints '0'.

Evidence: SettingsForm.tsx:1224 `{bookamatBankId && <span …>· accounts configured</span>}`; :1274 `setBookamatBankId(Number(e.target.value))`.

Fix: Ternary with null; keep '' for placeholder; block Save until chosen.

#### ○ [low] Status-change confirm copy inaccurate ('hard to reverse'); default DE reminder greeting 'Sehr geehrte(r) {{client}}' addresses companies as persons  <sub>ux-merge-85</sub>

`src/components/layout/DocumentStatusBar.tsx:108` · found by: lens:ux-consistency, payments-status

Dropdown allows reversing instantly; {{client}} resolves to company ?? name.

Evidence: DocumentStatusBar.tsx:108 `This action is hard to reverse.` with :88-99 all statuses selectable; reminder-templates.ts:35 `Sehr geehrte(r) {{client}},`; reminder/route.ts:48 `clientName: client.company ?? client.name`.

Fix: Truthful modal text; separate {{contact}}/{{company}} tokens, 'Sehr geehrte Damen und Herren' for companies.

#### ○ [low] After Bookamat sync only a badge is shown; no link, year or date of the booking  <sub>ux-merge-78</sub>

`src/components/layout/PaymentPanel.tsx:238` · found by: bookamat

User cannot see where the booking went or open it before 'Reset sync'.

Evidence: PaymentPanel.tsx:238-240 `<CheckCircle2 size={13} /> Synced to Bookamat`.

Fix: Store and show year/date/id with a link.

#### ○ [low] Only the number cell is clickable in desktop table rows  <sub>ux-merge-37</sub>

`src/components/lists/InvoiceList.tsx:332` · found by: lists

Link wraps only the number; mobile cards make whole row a link.

Evidence: InvoiceList.tsx:332-334 `<Link href={`/invoices/${doc.id}`} …>{doc.number ?? …}</Link>`; :336-342 plain td.

Fix: Row onClick/router.push or per-cell links.

#### ○ [low] Headings and button labels switch between Title Case and sentence case  <sub>ux-merge-111</sub>

`src/components/lists/InvoiceList.tsx:376` · found by: lens:ux-consistency

'Mark Sent' bulk button vs its own confirm 'Mark as sent'; 'Credit Note' tab vs 'Credit note' table.

Evidence: InvoiceList.tsx:376 `Mark Sent`, :383 `Mark Paid` vs :372 `label: 'Mark as sent'`; dashboard/page.tsx:212,227,262 vs :134; SettingsForm.tsx:61 `'Credit Note'` vs :808 `'Credit note'`.

Fix: Sentence case for buttons/labels; Title Case for page titles/nav.

#### ○ [low] No progress indication during bulk requests; Confirm button not disabled  <sub>ux-merge-38</sub>

`src/components/lists/InvoiceList.tsx:431` · found by: lists

bulkLoading only disables bar buttons; double click on Confirm can fire twice.

Evidence: InvoiceList.tsx:371-374 `disabled={bulkLoading}` bar only; :431-436 Confirm has no disabled.

Fix: Disable Confirm while loading and show spinner.

#### ○ [low] PDF label table asymmetric/wrong per document type: colons DE only, 'Sub-Total', 'Rechnungsempfänger' and 'Rechnungsnummer' on quotes/credit notes, 'Fälligkeitsdatum' on credit notes  <sub>ux-merge-26</sub>

`src/components/pdf/InvoiceDocument.tsx:65` · found by: lens:ux-consistency, pdf

English 'Invoice No.' lacks colon while 'Date:' has one; credit notes fall back to invoice-number label; quotes/credit notes say 'Rechnungsempfänger/Billed to'; editor says 'Valid until' but PDF 'Fälligkeitsdatum'.

Evidence: InvoiceDocument.tsx:65-66 `invoice_no: { de: 'Rechnungsnummer:', en: 'Invoice No.' }`; :75 `en: 'Sub-Total'`; :142 `doc.type === 'quote' ? L('quote_no') : L('invoice_no')`; :64 `bill_to: { de: 'Rechnungsempfänger', en: 'Billed to' }` at :186; :281.

Fix: Normalise colons, 'Subtotal', add credit_note_no, 'Empfänger/Recipient' for non-invoices, relabel date for credit notes.

#### ○ [low] No sender block near the top; supplier identity only in 8pt footer  <sub>ux-merge-29</sub>

`src/components/pdf/InvoiceDocument.tsx:167` · found by: pdf

Recipient block not positioned for window envelope; sender hard to find on page 1.

Evidence: InvoiceDocument.tsx:167-182 top row logo/title only; :329-348 footer.

Fix: Add a one-line sender address above recipient (DIN 5008).

#### ○ [low] 'Zahlungsinformationen' with supplier IBAN printed on quotes and credit notes  <sub>ux-merge-27</sub>

`src/components/pdf/InvoiceDocument.tsx:337` · found by: pdf

Footer payment column unconditional; credit note invites client to pay.

Evidence: InvoiceDocument.tsx:336-344 `{L('payment', lang)} ... {'IBAN: '}{settings.iban}`.

Fix: Bank details only for invoices; refund text for credit notes.

#### ○ [low] PDF payment block has no explicit Zahlungsreferenz/Verwendungszweck line or payment-terms sentence  <sub>ux-merge-97</sub>

`src/components/pdf/InvoiceDocument.tsx:337` · found by: lens:dunning-payment-terms

Number only in QR remittance field; portal shows bare number; no 'Zahlbar bis … ohne Abzug'.

Evidence: InvoiceDocument.tsx:337-343 footer prints company/bank/IBAN/BIC only; DocumentBuilder.tsx:340 `reference: docData.number,`; portal/[token]/page.tsx:285 `{doc.number}` unlabeled.

Fix: Add 'Verwendungszweck: {number}' and payment-terms line under totals; label on portal.

### Code quality (31)

#### ○ [high] Three divergent persistence paths (save, ensureNumberAndSave, autoSave) each rebuild docFields and the issue flow  <sub>quality-merge-3</sub>

`src/components/forms/DocumentBuilder.tsx:278` · found by: builder-items, builder-doc

save('sent'), ensureNumberAndSave() and autoSave each assemble the same update payload, allocate the number, update/insert the document and replace items, but differ in subtle details: autoSave omits status; ensureNumberAndSave hard-codes 'sent' and uses a different due-date fallback; save uses client.payment_days only when sent; toasts, redirect path and where setDate is called differ. Every fix must be made two or three times; bugs like the credit-note basePath/redirect and the silent autosave error come directly from this spread.

Evidence: src/components/forms/DocumentBuilder.tsx:264-318 (save) vs :358-397 (ensureNumberAndSave): :278-283 `const docFields = { client_id: clientId, date: effectiveDate, ...`, :370-375 `const docFields = { ... status: 'sent' as const, ...`, :607-612 `supabase.from('documents').update({ client_id: clientId, date, ...` (autoSave); basePath recomputed at :269, :432, :481, :495, :589 with one wrong value.

Fix: One `persist({ status?, issue?: boolean, issueNumber? })` function that builds the payload, serialises writes, returns { id, number } and is used by Mark-as-sent, PDF, Drive, Gmail and autosave; one `pathFor(type)` helper; one shared blobToBase64 in lib.

#### ○ [high] Entire line-item editor is duplicated for mobile and desktop (~470 lines), including the catalogue popup and discount controls  <sub>quality-merge-1</sub>

`src/components/forms/DocumentBuilder.tsx:809` · found by: builder-items, builder-doc

Every special-line renderer, the item row, the catalogue popup/popover with its inline 'new item' form, and the section-subtotal/document discount UI exist twice (sm:hidden mobile tree and hidden sm:block desktop tree) with only class-name differences. Any change to catalogue search, discount controls, line validation, keyboard support, aria-labels or rounding must be applied in two places; the two copies have already diverged (`w-20` vs `w-24`, popover width/left logic, button sizes).

Evidence: src/components/forms/DocumentBuilder.tsx:809 `<div className="sm:hidden space-y-0">{lines.map((line, idx) => {` (through :1043) vs :1046 `<div className="hidden sm:block overflow-x-auto -mx-1 px-1">` (through :1283) with the same branches; catalogue popup at :943-996 and again at :1198-1251.

Fix: Extract <LineRow>, <CataloguePopover>, <SectionSubtotal>/<SectionDiscount> and <DocumentDiscount> components rendered once with a `layout` prop or responsive classes, or render one list with CSS-only layout differences.

#### ○ [medium] No shared Bookamat client; auth header and base URL are rebuilt in three routes  <sub>quality-merge-38</sub>

`src/app/api/bookamat/sync/route.ts:56` · found by: bookamat

Any change (API version, auth scheme, error mapping) must be made in three places; error handling already diverges (accounts returns 400, sync 500, attach 500).

Evidence: src/app/api/bookamat/sync/route.ts:56 `const authHeader = \`ApiKey ${settings.bookamat_username}:${settings.bookamat_api_key}\``; attach-pdf/route.ts:22-23; accounts/route.ts:22-23 same construction

Fix: Create src/lib/bookamat.ts with bookamatFetch(settings, year, path, init) that centralises URL, auth, year handling and error normalisation.

#### ○ [medium] Drive verify→search→update/create logic duplicated in drive/upload and drive-pdf routes with different error handling  <sub>quality-merge-34</sub>

`src/app/api/drive/upload/route.ts:49` · found by: google, data-security

drive/upload and documents/[id]/drive-pdf contain the same ~55-60 line dedup/upload sequence (trashed check of the stored file ID, name search with quote escaping, update vs create, persist drive_file_id); one is wrapped in try/catch and returns JSON errors, the other is not. They already diverge (upload checks `documentId &&`, drive-pdf checks `settings.drive_folder_id` again); the reminder/cron routes build their own PDF pipeline a third way.

Evidence: src/app/api/drive/upload/route.ts:49-114 (`try { // 1. Verify stored file ID ... } catch (err) {...}`) vs src/app/api/documents/[id]/drive-pdf/route.ts:97-152 (same steps, no try/catch)

Fix: Extract `upsertDocumentPdf({ drive, supabase, documentId, filename, buffer, folderId, existingId })` into src/lib/google/drive.ts and call it from both routes.

#### ○ [medium] Reminder context/template assembly duplicated between manual route and cron  <sub>quality-merge-44</sub>

`src/app/api/invoices/[id]/reminder/route.ts:33` · found by: payments-status

Thirty lines (language pick, daysOverdue, discount, totals, ctx, template selection) are copy-pasted; the balance_due bug exists in both and any fix must be applied twice.

Evidence: src/app/api/invoices/[id]/reminder/route.ts:33-64 vs src/app/api/cron/reminders/route.ts:46-78 (identical blocks)

Fix: Extract `buildReminderEmail(invoice, settings)` into src/lib/utils/reminder.ts returning {subject, body, ctx}.

#### ○ [medium] PDF input assembly and rendering duplicated across four call sites with three different render APIs, already diverging  <sub>quality-merge-12</sub>

`src/app/portal/[token]/pdf/route.ts:25` · found by: pdf, portal, google

The portal PDF route, drive-pdf route, cron reminders route and DocumentBuilder each rebuild the same DocData object, totals, EPC QR parameters and getTaxNote call; the portal and drive-pdf blocks are line-for-line identical. They use three different render paths: the builder renders client-side with `pdf().toBlob()`, the routes use `renderToBuffer`, and the cron uses `pdf().toBuffer()` (which returns a stream, see the library's own TODO) plus hand-rolled chunk collection, the most fragile variant and the only one without a helper. The cron copy has already diverged (no payments, hand-mapped items dropping discount fields, qrCodeDataUri null). The Gmail attachment comes from in-memory form state while the Drive copy from the share modal comes from DB state, so the archived PDF can differ f…

Evidence: src/app/portal/[token]/pdf/route.ts:25-73 identical to src/app/api/documents/[id]/drive-pdf/route.ts:29-72 (`const discount = doc.discount_type && doc.discount_value ? …` … `renderToBuffer(React.createElement(InvoiceDocument, …`); src/app/api/cron/reminders/route.ts:55-112 and :114-126 `const stream = await pdf(...).toBuffer(); const chunks: Buffer[] = []; await new Promise<void>((resolve, reject)…

Fix: Create src/lib/pdf/build-document.ts exporting `loadDocumentForRender(supabase, filter)`, `buildPdfInput(doc, settings, { includeQr })` and `renderDocumentPdf()` (renderToBuffer) used by all server routes and the builder; render once server-side from DB state (`/api/documents/[id]/pdf`) after an exp…

#### ○ [medium] ClientForm bypasses the project's form stack (react-hook-form + zod) with untyped FormData casts  <sub>quality-merge-27</sub>

`src/components/forms/ClientForm.tsx:77` · found by: clients-catalogue

react-hook-form, zod and @hookform/resolvers are dependencies, but the client form reads FormData with `as string` casts, has no schema, no per-field errors and an unused `required` prop on `Field`; `data` from the insert is unused.

Evidence: package.json dependencies `"react-hook-form": "^7.76.0"`, `"zod": "^4.4.3"`; src/components/forms/ClientForm.tsx:77-104 `const fd = new FormData(e.currentTarget)` ... `payment_days: parseInt(fd.get('payment_days') as string, 10)`; :112 `const { data, error } = ...` (data unused); :210-211 `required = false` never set by callers

Fix: Define a zod schema (name-or-company refinement, email, integer payment_days >= 0, UID pattern when reverse charge) and render field-level errors via react-hook-form.

#### ○ [medium] calcSectionSubtotal and the section-discount math are implemented three/four times with divergent null filters  <sub>quality-merge-2</sub>

`src/components/forms/DocumentBuilder.tsx:55` · found by: builder-items, builder-doc, pdf

Identical section-subtotal logic lives in the builder, in src/lib/utils/document.ts (exported but unused by the builder) and in the PDF component; the discount-amount formula is repeated in the two builder layouts, the PDF and flushSection. The copies ignore the shared export and already diverge: the builder copy lacks null guards, and calcTotals additionally filters `vat_rate != null`, so a row with a null vat_rate is counted in the section subtotal row but excluded from totals, making the PDF's section numbers and its total disagree.

Evidence: src/components/forms/DocumentBuilder.tsx:55 `function calcSectionSubtotal(lines: LineItem[], upToIdx: number): number {`; src/lib/utils/document.ts:102 `export function calcSectionSubtotal(items: SectionItem[], upToIdx: number): number {`; src/components/pdf/InvoiceDocument.tsx:127 `function calcSectionSubtotal(items: DocItem[], upToIdx: number): number {`; discount formula at DocumentBuilder.tsx:…

Fix: Delete the two copies and import calcSectionSubtotal from document.ts; export a shared `sectionDiscount(gross, type, value)` there too; make calcSectionSubtotal and calcTotals share one isItemLine() predicate.

#### ○ [medium] Autosave effect re-arms after every router.refresh() and the keyboard effect re-subscribes every render  <sub>quality-merge-10</sub>

`src/components/forms/DocumentBuilder.tsx:622` · found by: builder-doc

The autosave effect depends on the `doc` prop object, which is a new reference after each router.refresh() (payment added, status changed, Drive upload), so each of those triggers a full delete/re-insert of the items 2 s later. The Cmd+S effect lists the non-memoised `save` function, re-registering the listener on every render. `alreadySent: true` is a constant, leaving the `doc?.status === 'draft' → requestSent()` branch unreachable.

Evidence: src/components/forms/DocumentBuilder.tsx:622-628 `useEffect(() => { if (!doc) return … autoSaveTimer.current = setTimeout(autoSave, 2000) … }, [autoSave, doc])`; :640 `}, [autoSave, doc, save])`; :566 `alreadySent: true` vs :591-595.

Fix: Key autosave on a `dirty` flag set by user edits instead of state identity; memoise save or use a ref for the shortcut; delete the dead branch.

#### ○ [medium] Three separate {{variable}} template engines and hand-maintained variable lists duplicated across four files  <sub>quality-merge-15</sub>

`src/components/forms/SettingsForm.tsx:30` · found by: pdf, settings, payments-status

replaceVars (PDF footer), sub() in buildEmailContent and fillTemplate (reminders) are three implementations of the same substitution; the Settings chips (FOOTER_VARS/EMAIL_VARS/REMINDER_VARS) must stay in sync by hand with the maps in InvoiceDocument.footerVars, DocumentBuilder.buildEmailContent and reminder-templates.fillTemplate. A comment admits it, and they have already drifted (chips omit {{amount}}/{{sender}}; the footer set lacks company/owner/uid).

Evidence: src/components/forms/SettingsForm.tsx:30 `// Used in email template sections (must match buildEmailContent vars exactly)`; SettingsForm.tsx:19-28 FOOTER_VARS; src/components/pdf/InvoiceDocument.tsx:87-89 replaceVars; src/components/forms/DocumentBuilder.tsx:517-519 sub(); src/lib/utils/reminder-templates.ts:17-30 `const map: Record<string, string> = { invoice_number: ..., amount: ..., sender: ... …

Fix: One fillTemplate(tpl, vars) in src/lib/utils/template.ts and a single typed variable registry per template kind from which both the chips and the substitution maps are derived.

Merged with: [ux] Variable chip sets inconsistent with templates: reminder chips omit {{amount}}/{{sender}}, 'Invoice #' label on quote/credit-note tabs

#### ○ [medium] Status/tax/type label and colour maps duplicated across dashboard, lists, client pages and status bar with diverging wording  <sub>quality-merge-22</sub>

`src/components/lists/ClientList.tsx:7` · found by: dashboard-reports, clients-catalogue, lens:ux-consistency, lists, payments-status

statusColor, statusLabel, taxLabel, docStatusColor, typeLabel/typeRoute and TAX_OPTIONS are redefined per file (dashboard, InvoiceList, QuoteList, ClientList, client detail page, ClientEditSection, ClientForm, DocumentStatusBar). Wording already diverges (three different tax labels; dashboard's statusLabel lacks accepted/rejected though quotes can carry them) and any future status addition must be made in several places.

Evidence: src/components/lists/ClientList.tsx:7-17 `const statusColor` / `const taxLabel`; src/app/(app)/dashboard/page.tsx:155-164 `const statusLabel: Record<string, string> = { draft: 'Draft', sent: 'Sent', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled' }`; src/components/lists/InvoiceList.tsx:10-16 `const statusColor: Record<string, string> = {`; src/components/lists/QuoteList.tsx:8 `const stat…

Fix: Export a single STATUS_META / labels module (src/lib/status.ts or src/lib/labels.ts, with DE/EN variants) and import it everywhere.

Merged with: [ux] Tax-treatment enum has five different human labels across the app; [ux] Status badges and dropdown render raw lowercase enum values with five different colour maps; status toast interpolates enum

#### ○ [medium] Four near-identical list components with duplicated header, sort, pagination, badge and empty-state code  <sub>quality-merge-16</sub>

`src/components/lists/QuoteList.tsx:81` · found by: lists

Th, SortIcon, statusColor, the comparator, pagination footer and two copies of the empty state (mobile + desktop) are repeated per list (~800 lines). Fixes such as accessibility, date formatting or URL persistence must be applied four times, and CreditNoteList already lags behind (no mobile layout).

Evidence: src/components/lists/InvoiceList.tsx:44-47, 184-193, 236-248 and 303-317 vs src/components/lists/QuoteList.tsx:41-44, 81-90, 121-133 and 169-183 vs src/components/lists/CreditNoteList.tsx:39-42, 79-85 vs src/components/lists/ClientList.tsx:35-38, 75-84

Fix: Extract shared `useListState` (search/filter/sort/page), `SortableTh`, `StatusBadge`, `Pagination` and `EmptyState` components under src/components/ui and a generic DocumentList.

#### ○ [medium] Google OAuth client + token-refresh persistence copy-pasted five/six times; sendReminderEmail builds its own OAuth2 client instead of getOAuthClient()  <sub>quality-merge-33</sub>

`src/lib/utils/reminder.ts:66` · found by: google, data-security

Identical ~14-line blocks (setCredentials from settings, `oauth2.on('tokens', …update settings…)`) appear in gmail/send, drive/upload, documents/[id]/drive-pdf, invoices/[id]/reminder and cron/reminders; reminder.ts re-implements `getOAuthClient` inline with `new google.auth.OAuth2(...)` instead of importing the shared helper from src/lib/google/client.ts. Any fix (error handling, scope check, storing scope, handling invalid_grant, awaiting the write) must be applied in five or six places.

Evidence: src/lib/utils/reminder.ts:66-70 `const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${process.env.NEXT_PUBLIC_APP_URL}/api/gmail/callback`)` vs src/lib/google/client.ts:3 `export function getOAuthClient() {`; duplicated setCredentials/on('tokens') blocks at src/app/api/gmail/send/route.ts:19-32, src/app/api/drive/upload/route.ts:32-44, src/app/ap…

Fix: Add `getAuthedGoogleClient(settings, supabase)` in src/lib/google/client.ts that sets credentials, registers (and awaits via a tracked promise) the token write-back, and maps invalid_grant to a typed error; use it everywhere including reminder.ts.

#### ○ [low] Fragile date math via mutating Date and toISOString across the subsystem  <sub>quality-merge-21</sub>

`src/app/(app)/reports/page.tsx:14` · found by: dashboard-reports

setMonth(-n) overflow (dashboard:14,19), UTC 'today' (dashboard:11, overdue.ts:4, route.ts:23) and a hand-written quarter-end ternary (reports:14) are each individually small but have already produced one wrong KPI; a single date helper module would remove the class of bug.

Evidence: src/app/(app)/reports/page.tsx:14 `const qEnd = `${year}-${String(qEndMonth).padStart(2, '0')}-${qEndMonth === 3 || qEndMonth === 12 ? 31 : qEndMonth === 6 ? 30 : qEndMonth === 9 ? 30 : 31}``

Fix: Use `new Date(Date.UTC(year, quarter*3, 0))` / a tz-aware today() helper.

#### ○ [low] Account list parsing guesses response shape and field names  <sub>quality-merge-41</sub>

`src/app/api/bookamat/accounts/route.ts:50` · found by: bookamat

toArray probes objects/results/data/any array and title/name/description/label/bezeichnung; it will silently return wrong titles or an empty list if Bookamat's shape changes, and ignores pagination.

Evidence: src/app/api/bookamat/accounts/route.ts:50-56 `if (Array.isArray(d.objects)) arr = d.objects … for (const v of Object.values(d)) { if (Array.isArray(v)) { arr = v; break } }` and :64 `String(o.title ?? o.name ?? o.description ?? o.label ?? o.bezeichnung ?? id)`

Fix: Pin the documented response shape, handle `next` pagination, and fail loudly on unexpected shape.

#### ○ [low] Token write-back is fire-and-forget inside an event handler  <sub>quality-merge-36</sub>

`src/app/api/gmail/send/route.ts:26` · found by: google

The async `on('tokens')` handler is neither awaited nor error-checked; on Vercel the function may be frozen after the response, so a refreshed access token is sometimes not persisted (every call then refreshes again) and write errors are swallowed.

Evidence: send/route.ts:26-32 `oauth2.on('tokens', async (tokens) => { await supabase.from('settings').update({...}).eq('id', settings.id) })` — nothing awaits this promise before `return NextResponse.json({ ok: true })` at :39

Fix: Capture the handler's promise in a variable and `await` it before responding (or use `after()` from next/server).

#### ○ [low] Request bodies read before auth and no shared auth helper  <sub>quality-merge-48</sub>

`src/app/api/invoices/[id]/reminder/route.ts:13` · found by: data-security

Routes parse JSON (and in the reminder route the PDF base64) before checking the user, and each route re-implements the getUser()/401 block, which is how four routes ended up without one.

Evidence: src/app/api/invoices/[id]/reminder/route.ts:13-17 `const body = await req.json().catch(() => ({}))` … `const { data: { user } } = await supabase.auth.getUser(); if (!user) return ... 401`

Fix: `const { supabase, user } = await requireUser()` helper that throws a 401 Response; call it first in every handler.

#### ○ [low] `as any` casts around React.createElement(InvoiceDocument) hide prop-type mismatches  <sub>quality-merge-14</sub>

`src/app/portal/[token]/pdf/route.ts:73` · found by: pdf

Both server routes cast the element to any, so DocumentItem (unit: Unit | null, discount fields optional) vs DocItem differences and future prop changes are not type-checked.

Evidence: src/app/portal/[token]/pdf/route.ts:67-73: `// eslint-disable-next-line @typescript-eslint/no-explicit-any ... }) as any)`; same in src/app/api/documents/[id]/drive-pdf/route.ts:70-76

Fix: Type InvoiceDocument's props so DocumentItem is assignable (or map explicitly) and drop the casts.

#### ○ [low] Portal 'light' wrapper is a no-op against the global dark variant  <sub>quality-merge-43</sub>

`src/app/portal/layout.tsx:4` · found by: portal

Tailwind's dark variant is `.dark *`; next-themes sets `.dark` on <html> from the *client's* OS preference, so the `light` class on the wrapper does nothing. The portal works today only because its JSX uses no `dark:` utilities; the first `dark:` class added (or any shared component with dark styles) will render dark for clients with dark-mode OS, and the body background outside the 100vh wrapper is already dark on overscroll.

Evidence: src/app/portal/layout.tsx:4 `<div className="light" style={{ colorScheme: 'light', background: '#f5f5f5', … }}>`; src/app/globals.css:5 `@custom-variant dark (&:is(.dark *));`; src/components/ui/ThemeProvider.tsx `attribute="class" defaultTheme="system" enableSystem`

Fix: Give the portal its own root layout (route group without ThemeProvider) or define the dark variant as `.dark:not(.light *) *`, and set `forcedTheme="light"` for /portal.

#### ○ [low] saveEdit writes the entire draft object including `id`  <sub>quality-merge-26</sub>

`src/components/forms/CatalogueManager.tsx:54` · found by: clients-catalogue

Sending the whole row (including the primary key and any future server-managed columns) to update() is fragile; new columns added to CatalogueItem will be written back blindly.

Evidence: src/components/forms/CatalogueManager.tsx:54 `const { error } = await supabase.from('catalogue_items').update(draft).eq('id', editingId)`; :42 `setDraft({ ...item })`

Fix: Pick only editable fields ({name_de, name_en, default_price, unit, vat_rate, category}) for the update.

#### ○ [low] showSaveFilePicker is called after awaits, so it always loses the user gesture and falls back silently  <sub>quality-merge-11</sub>

`src/components/forms/DocumentBuilder.tsx:471` · found by: builder-doc

Chrome requires a user activation for showSaveFilePicker; after ensureNumberAndSave and the PDF render the activation is gone, so the call throws (not AbortError), is swallowed, and the anchor download runs; the File System Access branch is effectively dead code with a hidden double-save risk if it ever succeeds.

Evidence: src/components/forms/DocumentBuilder.tsx:471-488 `if ('showSaveFilePicker' in window) { try { const handle = await (…).showSaveFilePicker({ … }) … } catch (e) { if ((e as Error).name === 'AbortError') return } }` preceded by `await ensureNumberAndSave()` at :463 and `await buildPdfBlob` at :465.

Fix: Either request the file handle synchronously on click before any await, or drop the branch and keep the anchor download.

#### ○ [low] blobToBase64 duplicated inline without error handling; FileReader failure hangs sendViaGmail  <sub>quality-merge-5</sub>

`src/components/forms/DocumentBuilder.tsx:560` · found by: builder-items

A proper blobToBase64 with onerror exists in the builder, but sendViaGmail and InvoicePageClient re-implement it without onerror, so a reader error leaves the promise pending forever (no toast, no UI reset).

Evidence: src/components/forms/DocumentBuilder.tsx:560-564 `const reader = new FileReader()` / `const pdfBase64 = await new Promise<string>((resolve) => { reader.onload = ...` (no reject) vs :437-444 `async function blobToBase64(blob: Blob)` with onerror; src/components/layout/InvoicePageClient.tsx:40-44.

Fix: Move blobToBase64 to src/lib/utils and use it in all three places.

#### ○ [low] clients prop is sorted in place during render  <sub>quality-merge-6</sub>

`src/components/forms/DocumentBuilder.tsx:733` · found by: builder-items, builder-doc

Array.prototype.sort mutates the array passed from the server component on every render instead of sorting a copy (harmless today because the server already orders by name, but a side effect in render and a foot-gun once sorting changes).

Evidence: src/components/forms/DocumentBuilder.tsx:733 `{clients.sort((a, b) => a.name.localeCompare(b.name)).map(c => (`

Fix: `useMemo(() => [...clients].sort(...), [clients])`, or rely on the server ordering (pages already `.order('name')`).

#### ○ [low] Dirty-state keys do not match section ids; dead refs and dead bookamatCountry state  <sub>quality-merge-31</sub>

`src/components/forms/SettingsForm.tsx:618` · found by: settings, bookamat

Nav ids are company/address/numbering but dirty/saving keys are 'brand'/'contact'/'docs', making it easy to wire a card to the wrong flag. `subjectRef`/`bodyRef` are attached but never read. `bookamatCountry` has state, is sent to the test endpoint and persisted to the effectively constant bookamat_country column, but no control ever changes it (setter never referenced).

Evidence: SettingsForm.tsx:618-619 `dirty={!!dirty.brand}\n            saving={saving === 'brand'}` vs :67 `{ id: 'company', ...}`; SettingsForm.tsx:531-532 `const subjectRef = useRef<HTMLInputElement>(null)\n  const bodyRef    = useRef<HTMLTextAreaElement>(null)`; SettingsForm.tsx:253 `const [bookamatCountry, setBookamatCountry] = useState(settings?.bookamat_country ?? 'at')` (setBookamatCountry never refe…

Fix: Use the nav id as the section key everywhere (`type SectionId = typeof NAV_ITEMS[number]['id']`), delete the unused refs, and either add a country select or remove the state and hard-code 'at'.

#### ○ [low] ConvertToInvoiceButton and ConvertToCreditNoteButton are near-identical copies  <sub>quality-merge-23</sub>

`src/components/layout/ConvertToInvoiceButton.tsx:13` · found by: dashboard-reports

Same fetch/confirm/toast/redirect logic with different strings; both share the unguarded res.json() and native confirm.

Evidence: src/components/layout/ConvertToInvoiceButton.tsx:13-21 vs src/components/layout/ConvertToCreditNoteButton.tsx:13-21

Fix: One ConvertDocumentButton({ endpoint, label, confirmText, resultKey, basePath }) with a styled confirm modal.

#### ○ [low] Counter-restore detection assumes the sequence is the trailing digits  <sub>quality-merge-46</sub>

`src/components/layout/DeleteDocumentButton.tsx:31` · found by: payments-status

The regex takes the last digit run of the number; with formats such as '{prefix}-{NNN}-{YYYY}' or '{prefix}{YYYY}{NNN}' it compares the year or a combined digit string with the counter and never offers a rollback, silently.

Evidence: src/components/layout/DeleteDocumentButton.tsx:31 `const seqMatch = docNumber.match(/(\d+)$/)`; supported formats in supabase/migrations/20260520_number_format.sql

Fix: Store the integer sequence in a `sequence_no` column at issue time and compare that.

#### ○ [low] Navigation, sign-out and theme-toggle logic duplicated between Sidebar and MobileHeader  <sub>quality-merge-49</sub>

`src/components/layout/MobileHeader.tsx:16` · found by: shell-ui

The route list is declared three times (Sidebar `nav`, MobileHeader `PRIMARY_NAV` + `MORE_NAV`) and the signOut/theme-toggle handlers are copy-pasted. Adding or renaming a route (e.g. a future 'Expenses' page) requires three coordinated edits; the two toggles already share the same resolvedTheme bug.

Evidence: src/components/layout/Sidebar.tsx:15-24 `const nav = [ { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }, ...` ; src/components/layout/MobileHeader.tsx:16-29 `const PRIMARY_NAV = [...]` / `const MORE_NAV = [...]` ; Sidebar.tsx:32-35 and MobileHeader.tsx:38-42 identical `signOut()`

Fix: Export a single NAV_ITEMS array (with a `primary` flag for the mobile bar) and a useSignOut/useThemeToggle hook from src/components/layout/nav.ts and consume it in both components.

#### ○ [low] Document label tables duplicated between PDF, portal page and QuoteActions with divergent wording  <sub>quality-merge-13</sub>

`src/components/pdf/InvoiceDocument.tsx:60` · found by: pdf, portal

InvoiceDocument LABELS, the portal page's L map and QuoteActions' L map define the same de/en client-facing strings independently and already disagree ('Nettobetrag/Subtotal' vs 'Sub-Total', 'MwSt.' vs 'USt.', hard-coded 'Subtotal'/'Net' in both).

Evidence: src/components/pdf/InvoiceDocument.tsx:60-81 `const LABELS: Record<string, Record<'de' | 'en', string>> = {`; src/app/portal/[token]/page.tsx:35-55 `const L: Record<string, { de: string; en: string }> = {`; src/app/portal/[token]/QuoteActions.tsx:6-13

Fix: Move labels to src/lib/i18n/document-labels.ts and import in the PDF, portal page and QuoteActions.

#### ○ [low] Leftover create-next-app template assets and an undefined toast class  <sub>quality-merge-50</sub>

`src/components/ui/sonner.tsx:41` · found by: shell-ui

public/next.svg, vercel.svg, globe.svg, file.svg and window.svg are unreferenced (`grep -rn 'next.svg|vercel.svg|globe.svg|file.svg|window.svg' src` -> 0), the default favicon.ico is still present (see bugs), and sonner.tsx assigns the class `cn-toast` which is defined nowhere (`grep -rn cn-toast src` only hits the assignment).

Evidence: src/components/ui/sonner.tsx:39-43 `toastOptions={{ classNames: { toast: "cn-toast", }, }}` ; public/ listing: file.svg globe.svg next.svg vercel.svg window.svg

Fix: Delete the unused public/*.svg files and either define .cn-toast in globals.css or remove the classNames option.

#### ○ [low] Hand-rolled MIME is only loosely RFC-compliant  <sub>quality-merge-35</sub>

`src/lib/utils/reminder.ts:21` · found by: google

In the multipart branch the text part has no Content-Transfer-Encoding and carries raw 8-bit UTF-8 (umlauts/€), the PDF base64 is a single unwrapped line (RFC 2045 asks for ≤76-char lines), header values are not folded/encoded, and the plain-text branch base64-encodes the body while the multipart branch does not. Gmail tolerates this today, but it is fragile and the inconsistency suggests it was already hit once.

Evidence: reminder.ts:21-23 `'Content-Type: text/plain; charset=UTF-8', '', body,`; :30 `pdfBase64,`; :43-45 `'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64'),`

Fix: Use nodemailer's MailComposer (or `mimetext`) to build the raw message: it handles encodings, folding, display names and attachments.

#### ○ [low] Settings singleton not enforced; every page assumes exactly one row  <sub>quality-merge-47</sub>

`supabase/schema.sql:40` · found by: data-security

schema.sql seeds one row but nothing prevents 0 or 2 rows; all pages call `.single()` and pass `settings!` into the builder, so a missing/duplicate row crashes every document page instead of showing an onboarding state.

Evidence: supabase/schema.sql:40-41 `-- Only ever one row` / `insert into settings (id) values (uuid_generate_v4());` (no constraint); src/app/(app)/invoices/[id]/page.tsx:19 `.select('*').single()` → :55 `settings={settings!}`

Fix: Add `id boolean primary key default true check (id)`-style singleton or a unique index on a constant, and handle null settings with an onboarding redirect.
