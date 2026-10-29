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
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Bypasses RLS for the client portal and the two crons. |
| `CRON_SECRET` | Bearer token Vercel Cron sends; both cron routes refuse to run without it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client for Gmail sending and the Drive archive. |
| `NEXT_PUBLIC_APP_URL` | Public origin, no trailing slash (`http://localhost:3000` locally). Builds the OAuth redirect and links in emails. |

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

## Crons

`vercel.json` schedules two daily runs (the Vercel Hobby plan allows two, once a day each):

| Path | Schedule (UTC) | Does |
|---|---|---|
| `/api/cron/recurring` | `0 6 * * *` | Creates (and optionally issues) the invoices of due recurring schedules. |
| `/api/cron/reminders` | `0 8 * * *` | Syncs paid invoices and refunds to Bookamat when automatic sync is on, marks past-due invoices overdue and sends the reminders that are due. |

Vercel sends `Authorization: Bearer $CRON_SECRET`; a call without it gets 401.

## Checks

```bash
npx tsc --noEmit
npm run lint
```

## Deploy

Vercel, with the environment variables above. Every push to a branch builds a preview.
