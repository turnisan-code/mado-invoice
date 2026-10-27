'use client'

import './globals.css'

export default function GlobalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  return (
    <html lang="de">
      <body className="min-h-screen flex items-center justify-center p-6 bg-neutral-50 text-neutral-900 antialiased">
        <main className="w-full max-w-sm text-center space-y-4">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-neutral-500">
            Mado Invoice could not be loaded. Nothing was lost — try again, or reload the page.
          </p>
          {error.digest && <p className="text-xs text-neutral-500">Reference: {error.digest}</p>}
          <div className="flex justify-center gap-2">
            <a href="/dashboard" className="inline-flex h-8 items-center rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-neutral-50">Dashboard</a>
            <button type="button" onClick={() => unstable_retry()} className="inline-flex h-8 items-center rounded-lg bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-700">Try again</button>
          </div>
        </main>
      </body>
    </html>
  )
}
