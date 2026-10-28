# Mado Invoice

Quotes, invoices and credit notes for one Austrian freelancer (VAT-registered, Ist-Besteuerung,
EUR only): client portal, payment reminders, recurring invoices, Gmail and Google Drive, and
booking export to Bookamat, which stays the bookkeeping system. The UI switches between German
and English; each document uses its own language.

## Stack

Next.js 16 (App Router, React 19, TypeScript, Tailwind 4), Supabase (Postgres with row-level
security, Auth, Storage), `@react-pdf/renderer`, deployed on Vercel with Vercel Cron.

This Next.js version differs from older ones (for example `src/proxy.ts` instead of middleware).
Read the guides in `node_modules/next/dist/docs/` before changing Next-specific code.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill it in; every variable is explained there.
3. Database, in the Supabase SQL editor:
   - new project: run `supabase/schema.sql`;
   - existing database: run the files in `supabase/migrations/` that are not applied yet, in
     filename order.
4. Create the owner account in Supabase Auth, then run the `insert into app_users ...` line from
   `supabase/schema.sql`. Only users listed in `app_users` can read or change data.
5. `npm run dev`

## Checks

```bash
npx tsc --noEmit
npm run lint
```

## Deploy

Vercel, with the same environment variables as `.env.local`. `vercel.json` schedules the
reminder run (`/api/cron/reminders`) and the recurring-invoice run (`/api/cron/recurring`) once a
day; both refuse requests without `CRON_SECRET`.
