export default function ReportsLoading() {
  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-8 animate-pulse">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="space-y-2">
          <div className="h-7 w-32 bg-neutral-200 dark:bg-neutral-800 rounded-md" />
          <div className="h-4 w-64 max-w-full bg-neutral-100 dark:bg-neutral-800 rounded" />
        </div>
        <div className="flex gap-3">
          <div className="h-9 w-56 bg-neutral-100 dark:bg-neutral-800 rounded-lg" />
          <div className="h-9 w-20 bg-neutral-100 dark:bg-neutral-800 rounded-md" />
        </div>
      </div>
      <div className="h-14 bg-neutral-100 dark:bg-neutral-800 rounded-xl" />
      {[4, 3].map((rows, b) => (
        <div key={b} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
            <div className="h-4 w-48 bg-neutral-100 dark:bg-neutral-800 rounded" />
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {[...Array(rows)].map((_, i) => (
              <div key={i} className="px-5 py-3 flex justify-between items-center gap-4">
                <div className="h-4 w-2/3 bg-neutral-100 dark:bg-neutral-800 rounded" />
                <div className="h-4 w-20 bg-neutral-100 dark:bg-neutral-800 rounded" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
