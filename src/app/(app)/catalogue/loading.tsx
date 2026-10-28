export default function CatalogueLoading() {
  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-7 w-44 bg-neutral-200 dark:bg-neutral-800 rounded-md" />
        <div className="h-4 w-80 max-w-full bg-neutral-100 dark:bg-neutral-800 rounded" />
      </div>
      <div className="flex gap-3">
        <div className="h-9 flex-1 max-w-sm bg-neutral-100 dark:bg-neutral-800 rounded-lg" />
        <div className="h-9 w-28 bg-neutral-100 dark:bg-neutral-800 rounded" />
      </div>
      {[3, 2].map((rows, b) => (
        <div key={b} className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
          <div className="px-4 py-2.5 bg-neutral-50 dark:bg-neutral-800/80 border-b border-neutral-100 dark:border-neutral-800">
            <div className="h-3 w-20 bg-neutral-200 dark:bg-neutral-700 rounded" />
          </div>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800/80">
            {[...Array(rows)].map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                <div className="h-4 w-4 bg-neutral-100 dark:bg-neutral-800 rounded" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-40 max-w-full bg-neutral-100 dark:bg-neutral-800 rounded" />
                  <div className="h-3 w-24 bg-neutral-100 dark:bg-neutral-800 rounded" />
                </div>
                <div className="h-4 w-16 bg-neutral-100 dark:bg-neutral-800 rounded" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
