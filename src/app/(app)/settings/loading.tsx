export default function SettingsLoading() {
  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-7 w-28 bg-neutral-200 dark:bg-neutral-800 rounded-md" />
        <div className="h-4 w-72 max-w-full bg-neutral-100 dark:bg-neutral-800 rounded" />
      </div>
      <div className="flex gap-10 items-start">
        <div className="hidden lg:flex flex-col gap-1 w-40 shrink-0">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-8 bg-neutral-100 dark:bg-neutral-800 rounded-lg" />
          ))}
        </div>
        <div className="flex-1 min-w-0 space-y-5">
          <div className="lg:hidden flex gap-1 overflow-hidden">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-8 w-24 shrink-0 bg-neutral-100 dark:bg-neutral-800 rounded-lg" />
            ))}
          </div>
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
            <div className="px-6 py-4 border-b border-neutral-100 dark:border-neutral-800 space-y-1.5">
              <div className="h-4 w-24 bg-neutral-100 dark:bg-neutral-800 rounded" />
              <div className="h-3 w-56 max-w-full bg-neutral-100 dark:bg-neutral-800 rounded" />
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="flex items-start gap-4">
                <div className="h-16 w-16 bg-neutral-100 dark:bg-neutral-800 rounded-xl" />
                <div className="h-8 w-28 bg-neutral-100 dark:bg-neutral-800 rounded-lg" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[...Array(2)].map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="h-3 w-20 bg-neutral-100 dark:bg-neutral-800 rounded" />
                    <div className="h-9 bg-neutral-100 dark:bg-neutral-800 rounded-lg" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
