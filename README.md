# Mado Invoice

Quotes, invoices and credit notes for one Austrian freelancer (VAT-registered, Ist-Besteuerung,
EUR only): numbered issuing with a frozen PDF, client portal, payment reminders (Mahnungen),
recurring invoices, bank-statement import, e-invoices (ebInterface, Peppol UBL), Gmail and
Google Drive, and booking export to Bookamat, which stays the bookkeeping system. A wrong issued
invoice is cancelled with a Storno credit note. The UI switches between German and English;
each document (PDF, portal, email, e-invoice) uses its own language.

## Stack

Next.js 16 (App Router, React 19, TypeScript, Tailwind 4), Supabase (Postgres with row-level
security, Auth, Storage), `@react-pdf/renderer`, deployed on Vercel with Vercel Cron.

This Next.js version differs from older ones (for example `src/proxy.ts` instead of middleware).
Read the guides in `node_modules/next/dist/docs/` before changing Next-specific code.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill it in (see [Environment](#environment)).
3. Create the database (see [Database](#database)).
4. Configure Supabase Auth (see [Supabase Auth](#supabase-auth)) and create the owner account
   under Authentication → Users. Then run the `insert into app_users ...` line from
   `supabase/schema.sql`: only users listed in `app_users` can read or change data.
5. `npm run dev` and sign in at <http://localhost:3000/login>. Fill in Settings (company,
   address, UID, IBAN) before issuing the first document.

## Environment

All keys are listed in `.env.example`; on Vercel set the same keys in the project settings.

| Variable | Used for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (Project Settings → API). Shipped to the browser. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key. Shipped to the browser; data access is enforced by RLS (`is_app_user()`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Bypasses RLS for the client portal, the two crons and the Claude connector (its sign-in at consent, OAuth codes and tokens, connections and request log; Claude's own queries run as the owner under RLS). |
| `CRON_SECRET` | Bearer token Vercel Cron sends; both cron routes refuse to run without it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client for Gmail sending and the Drive archive. |
| `NEXT_PUBLIC_APP_URL` | Public origin, no trailing slash (`http://localhost:3000` locally). Builds the OAuth redirect, links in emails and the Claude connector's URLs. |
| `MCP_SECRET` | Server only. Secret of the Claude connector, at least 32 random bytes in base64 (`openssl rand -base64 48`). Changing it disconnects Claude. |

`NODE_ENV` is set by Next.js itself; do not set it.

## Database

Run SQL in the Supabase SQL editor (the storage policies need the `postgres` role).

- **New, empty project:** run `supabase/schema.sql` once. It is a snapshot of the current schema:
  tables, RPCs (`issue_document`, `create_credit_note`, `convert_quote_to_invoice`, …), RLS pinned
  to `app_users`, the public `logos` bucket and the private `documents` bucket for frozen PDFs.
  The settings table holds exactly one row (`settings_singleton`).
- **Existing database:** run the files in `supabase/migrations/` that are not applied yet, in
  filename order (they are dated, e.g. `20261030_lifecycle.sql` before `20261031_editor.sql`).
  A database from before October 2026 starts at the four `20261019_*` files: they create
  `app_users`, `is_app_user()` and `replace_document_items`, which everything after relies on.
  Then `20261020_schema_alignment.sql` and the rest in filename order. From `20261019_*` on each
  file can be run again (`create table if not exists`, `create or replace`,
  `drop policy if exists`), but only together with every later file, in order: later files change
  some function signatures and return types (e.g. `convert_quote_to_invoice`, `catalogue_usage`),
  so re-running an older file on its own can fail or leave an old overload behind until the later
  files run again. `supabase/add_reminders.sql` and
  `BOOKAMAT_MIGRATION.sql` are history and are never run on their own.
- A new migration also updates `supabase/schema.sql`, so both stay in step. A function that is
  redefined starts from its latest definition (later files win).

## Supabase Auth

Authentication → URL Configuration:

- **Site URL:** the value of `NEXT_PUBLIC_APP_URL`.
- **Redirect URLs:** `https://<your-app>/auth/callback` and, for local development,
  `http://localhost:3000/auth/callback`. Password-reset links land there and continue to
  `/reset-password`.
- Optional: in the “Reset password” email template, link to
  `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`
  so the link also works in another browser or on another device than the one that asked for it.

Turn off public sign-ups (Authentication → Providers → Email); only the owner is listed in
`app_users` anyway. Two-factor sign-in (TOTP) is optional and set up under Account.

## Google

Create an OAuth client (type “Web application”) in Google Cloud and register
`${NEXT_PUBLIC_APP_URL}/api/gmail/callback` as an authorized redirect URI. The app asks for
`gmail.send`, `userinfo.email` and `drive`. Connect the account and choose the Drive folder in
Settings → Google.

## Issued PDFs

Issuing stores the document's PDF once, in the `documents` bucket (the archive copy). Every later
copy is that file: the download in Mado, emails and reminders, the client portal, the Drive copy, the Bookamat
attachment, the PDF inside a Peppol e-invoice and the ZIP of a period's PDFs under Reports.

A cancelled document (an invoice cancelled by its Storno credit note, a cancelled quote) is shown
and sent with a red stamp across its first page, in the document's language: “STORNIERT” with
“Storno GS-… vom …” on an invoice, “CANCELLED” with “Cancelled by GS-… on …” in English (a quote
has no Storno, so only the first line), and a small line at the top of every further page. That
holds for the PDF opened or downloaded in Mado and the editor's preview, the portal's PDF (the
portal page also names the Storno under the status), an emailed PDF and the PDF inside a Peppol
e-invoice. The stamp is laid over the stored copy each time the PDF goes out
(`src/lib/pdf/stamp.ts`); the stored copy itself, the Drive copy, the Bookamat attachment and the
ZIP export stay exactly as issued. Should stamping fail, the PDF goes out unstamped and the server
log says so.

## Claude connector

Claude (claude.ai on the web, desktop and mobile, and Claude Code) works with Mado through the MCP
server at `${NEXT_PUBLIC_APP_URL}/api/mcp`. Mado is its own sign-in server: connecting needs the
owner's password, the authenticator code (a verified TOTP factor is required) and then a fresh
code on the consent page. Each connection gets its own Supabase session, kept encrypted on the
server, so Claude only ever reads and writes what RLS lets the owner do. Claude edits drafts only;
issued documents are corrected with a Storno or a credit note. Issuing, sending, issuing and
sending a draft in one approval, reminders, Storno, cancelling, deleting and the Bookamat sync are
prepared by Claude and wait for the owner's approval.

Setup:

1. Supabase: leave Authentication → OAuth Server off (it is not used). Keep refresh-token
   rotation and reuse detection on, and set no session time-box or inactivity timeout shorter
   than a Claude connection should last. Keep the Email provider enabled: each connection is a
   server-side magic-link session, no email is sent.
2. Database: run `supabase/migrations/20261105_mcp.sql` and `20261105_mcp_drafts.sql`, then
   `supabase/tests/mcp_guards.sql` and `supabase/tests/mcp_drafts_guards.sql`. Each test rolls
   back on its own; the SQL editor shows the row `all MCP guard checks passed` (`all MCP draft
   guard checks passed`), or the first failed check as an error (`FAIL …`). Where an earlier
   version of `20261105_mcp_drafts.sql` was applied (one without `clients.mcp_written_at`), the
   migration treats every client with an address Claude wrote, and every client created since the
   first Claude connection, as changed by Claude until the owner saves it. A change Claude made
   under that version to another client's name, company, VAT ID or terms alone left no trace:
   check and save the clients Claude worked on then.
3. Vercel: add `MCP_SECRET` (Production) and check that `NEXT_PUBLIC_APP_URL` is exactly the
   production origin without a trailing slash; redeploy. Locally, put both in `.env.local`.
4. Check the deployment: `curl -si -X POST https://<your-app>/api/mcp` answers 401 with
   `WWW-Authenticate: Bearer resource_metadata=...`, and
   `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-authorization-server`
   return their JSON documents.
5. claude.ai: Customize → Connectors → Add custom connector, name `Mado Invoice`, URL
   `https://<your-app>/api/mcp`, “Sign in now” with Claude's published identity. On Mado's consent
   page check that the client is Claude, choose the scopes, type a fresh authenticator code and
   approve. In the connector's tool permissions set `confirm_action` to “Needs approval”, never
   “Always allow”.
6. Claude Code: use the synced claude.ai connector, or
   `claude mcp add --transport http mado https://<your-app>/api/mcp` and `/mcp` → Authenticate
   (the consent page warns about the local redirect; that is expected). Never put
   `confirm_action` in a permission allow rule.
7. If signing in fails with “unknown client”, remove the connector and add it again with “Use
   your own OAuth client”, client ID `mado-claude`, no secret.

Approvals: by default every irreversible action is approved in Mado. Claude shows a link to
`/mcp/approve/<id>` with the summary; the page shows exactly what will happen and asks for a
current authenticator code. Pending approvals are also listed at `/mcp/approve` and under Account
→ Connected apps, where each action kind can be switched to “Confirm in Claude” (then the Claude
app's prompt is the only gate). Loosening these settings (a kind to “Confirm in Claude”, or the
approval code off) asks for a current authenticator code; tightening them does not. Whatever a kind
is set to, these are always approved in Mado:

- an email or reminder to an address that is not on the client record;
- one to an address Claude wrote onto a client (`create_client`, `update_client`), until the owner
  saves that client in Mado;
- one to an address on the client record that the owner has never emailed from Mado for that client;
- on Claude Code connections (and an own OAuth client, which has Claude Code's shorter time limit):
  a Bookamat sync, and issuing more than 3 documents at once;
- deleting the template of a recurring schedule. Claude cannot change what the template of any
  schedule bills (issuing automatically or creating drafts, active or paused alike: a schedule that
  creates drafts can be switched to issue them without the template being opened again); the
  owner edits recurring templates in Mado.

A client Claude created or changed (`create_client`, `update_client`, any field) also stays
unconfirmed until the owner saves it in Mado, and its page says so: meanwhile the automatic
reminders skip its invoices, the automatic Bookamat sync skips its documents, and a recurring
schedule that issues invoices automatically creates its invoices as drafts, each with the reason
in the cron log (or the warning of “Generate now”), since a Mahnung, a booking or an issued
invoice would carry the name, recipient block, VAT ID and payment terms Claude wrote. The schedule
checks the client again just before the number is taken and when the archive copy is rendered: a
change Claude makes while the invoice is being issued leaves it a draft, or, once numbered,
without an archive copy until the client is saved (the cron log says which). For the
same reason no archive copy (the frozen PDF of an issued document that has none yet, e.g. one
issued before archive copies existed) is rendered from such a client: downloads, emails and the
portal's PDF of that document fail with a notice until the client is saved (a copy already stored
at issue whose link to the document was not saved is still used), and the portal page
leaves the recipient block out. Addresses Claude wrote are skipped by the reminders on their own
as well (a client whose email Claude wrote gets none, a CC Claude wrote is left out, and until the
client is saved any address on it that is not plain ASCII, as the app cannot match it against the
marks for certain). The pages of its issued invoices, credit notes and quotes say so as well, with
a link to the client. A reminder sent from Gmail, a Storno, a Bookamat sync or an email with an
e-invoice that Claude prepares is refused for such a client until it is saved: the Mahnung prints
its name and address, the Storno credit note is archived with its name, address and VAT ID for
good, the bookings carry its name and VAT ID, the e-invoice its name, address, VAT ID and buyer
reference, and the approval page shows only its name. A change Claude makes to the client after
preparing one of these makes the approval page say so, with a link to the client, and the action
cannot run. A reminder only recorded as sent another way prints nothing of the client, so it is not
refused, and neither a change to the client nor the owner saving it stops it.
Issuing (also issue-and-send without an e-invoice) is not refused, as issuing for a
client Claude has just created is the usual way; the approval page then shows the recipient block
and VAT ID the document is numbered and archived with for good, and the buyer reference the PDF
prints from the client (or a credit note's invoice) when the draft has none of its own, each in
full, however long. A Peppol UBL downloaded in Mado for a document without an archive copy goes
without its PDF while such a client is not saved, and the download says why.

An invoice on which Claude recorded, changed or removed a payment, fee, Skonto, write-off or
applied credit (`record_payment`, `remove_payment`, `settle_balance`, `apply_credit_note`), and a
credit note on which it recorded or removed a refund (`record_refund`, `remove_payment`), stays
unconfirmed until the owner confirms its payments on its page (“Payments are correct”, “Refunds are
correct”; the notice shows whatever the status, also on a paid invoice). Confirming covers what the
page showed: should Claude change the payments again after the page was loaded, nothing is
confirmed and the page reloads with them; payments already confirmed in another tab or on another
device are said to be so. Meanwhile the automatic reminders skip the invoice and the automatic
Bookamat sync skips the document, each with the reason
in the cron log: removing a payment reopens a paid invoice or raises what is open, so the Mahnung
would ask the client, unattended, for money it paid, and a booking takes its date, its amount per
year and its account (bank or Kassa) from those rows, so Claude's payments would become Bookamat
bookings no one approved (a write-off or Skonto alone makes an invoice paid, so bookable). No
archive copy is made of such a document either (downloads, emails and the portal's PDF of one that
has none yet fail with a notice), as the copy keeps the payments up to its issue date for good, and
its share link shows the issued total only, without the payments, the balance due, a paid or
overdue status and the payment details. Nor can Claude email such an invoice with an e-invoice
(`prepare_send_email` is refused, and a change after preparing is shown on the approval page with a
link to the invoice), as the e-invoice states the payments up to its issue date as already paid. A
credit note Claude applied to its invoice (`apply_credit_note`) is held the same way as the
invoice: the credit settles the credit note, and
the Bookamat sync books a settled credit note's refunds. Where an earlier version of
`20261105_mcp_drafts.sql` was applied (no mark yet, or invoices only), the migration marks every
invoice and credit note with a payment or refund recorded or removed from a Claude connection
once; where any earlier version was applied, also every credit note applied from a Claude
connection.

While an action approved in Mado runs (issuing takes seconds per draft: the number, the PDF, the
Drive copy), Claude cannot change the documents it names, the invoice a credit note among them
corrects, their lines and payments, the advance and partial invoices a final invoice among them
deducts (no linking or unlinking one, no payment on one), or their clients: the database refuses
(MI046) until the action has finished, ten minutes after the approval at most. The run also
compares each draft, with its client, once more just before its number is taken, and an
issue-and-send the document and client before the email goes out; one that changed after the
approval stops the run there, what was issued before stays issued and the result lists the rest as
not issued. An action Claude confirms in chat runs on Claude's own connection, which the database
cannot tell apart from Claude's other changes, so there that comparison is the check. Once a
document is numbered (also a Storno credit note), its archive copy is made with the client as it was
when the action started (the owner's own issuing or Storno: when the number was taken) and only if
no payment was recorded on it from Claude since: a client Claude changes or a payment it records on
the document in the meantime (in parallel with an action confirmed in chat) leaves the document
without a copy until the owner saves the client or confirms the payments, and the result says so.
Likewise, an email's e-invoice is built as it is sent: should Claude have changed the client, or an
invoice's payments, since the action started, the email is not sent and the result says why (an
issue-and-send stays issued). A Bookamat sync stops before it books when Claude changed the client,
or the payments, since the action started. A reminder compares the invoice its Mahnung is rendered
from (lines, payments and, from Gmail, the client) with the approved state once more and stops on
any change, before anything is sent or the level moves.

One action runs at a time, approved in Mado or confirmed in chat. While one runs, Claude's
confirmation does not start another and an approval in Mado is refused (“Another action is still
running”; MI047); that action stays prepared, to be confirmed or approved again once the first has
finished (ten minutes after it started at most, should it have stopped without reporting back).
Two at once would get in each other's way: one confirmed in chat runs on Claude's own connection,
where the database refuses what it records while one approved in Mado holds the same invoice (the
email's sent date, the reminder's level, a credit note's credit), and the automatic reminders would
then send the same Mahnung again.

Issuing a credit note (also a Storno) applies it to the invoice it corrects; should that fail, the
toast in Mado, the approval page and Claude's result say so, and the credit note's page offers to
apply it.

An action prepared while its kind was set to “Confirm in Claude” moves to Mado when the kind is set
back to “Approve in Mado” before Claude confirms it. A prepared action expires after 15 minutes.

A quote's status is Claude's to set without an approval in Mado (`set_quote_status`, and
`convert_quote`, which accepts a sent quote), as the owner's or the client's decision it records:
the share link shows it at once and no longer takes the client's own answer, and a sent quote
never becomes sent again. Nothing is numbered, sent, booked or asked for by it. Both tools are
marked destructive, and their descriptions tell Claude to set a status only on the owner's word.

Disconnecting: Account → Connected apps → Revoke takes effect at once; what that connection
prepared can then only be rejected. Signing out in the sidebar ends only this device's session;
“Sign out everywhere” and removing the connector in Claude also disconnect Claude; so does a
password change, on Claude's next request. Limits per connection: an access token lasts 1 hour; the connection ends after 30 days without
use and after 90 days at most; 120 calls a minute and 3000 a day.

## Crons

`vercel.json` schedules two daily runs (the Vercel Hobby plan allows two, once a day each):

| Path | Schedule (UTC) | Does |
|---|---|---|
| `/api/cron/recurring` | `0 6 * * *` | Creates (and optionally issues) the invoices of due recurring schedules; a client changed from a Claude connection and not saved in Mado since gets drafts (checked again just before numbering, and no archive copy is made from it). |
| `/api/cron/reminders` | `0 8 * * *` | Syncs paid invoices and refunds to Bookamat when automatic sync is on, marks past-due invoices overdue and sends the reminders that are due; a client changed from a Claude connection and not saved in Mado since gets neither a booking nor a reminder, nor does an address Claude wrote get a reminder, nor an invoice or credit note whose payments or refunds Claude changed a booking or a reminder until the owner confirms them. |

Vercel sends `Authorization: Bearer $CRON_SECRET`; a call without it gets 401.

## Checks

```bash
npx tsc --noEmit
npm run lint
```

## Deploy

Vercel, with the environment variables above. Every push to a branch builds a preview.
