export default function DashboardLoading() {
  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-8 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-7 w-28 bg-neutral-200 dark:bg-neutral-800 rounded-md" />
        <div className="flex gap-2">
          <div className="h-8 w-24 bg-neutral-200 dark:bg-neutral-800 rounded-md" />
          <div className="h-8 w-24 bg-neutral-200 dark:bg-neutral-800 rounded-md" />
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 space-y-3">
            <div className="flex justify-between">
              <div className="h-4 w-20 bg-neutral-100 dark:bg-neutral-800 rounded" />
              <div className="h-7 w-7 bg-neutral-100 dark:bg-neutral-800 rounded-md" />
            </div>
            <div className="h-7 w-24 bg-neutral-100 dark:bg-neutral-800 rounded" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700">
          <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
            <div className="h-4 w-32 bg-neutral-100 dark:bg-neutral-800 rounded" />
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center px-5 py-3 gap-3">
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-24 bg-neutral-100 dark:bg-neutral-800 rounded" />
                  <div className="h-3 w-16 bg-neutral-100 dark:bg-neutral-800 rounded" />
                </div>
                <div className="h-4 w-16 bg-neutral-100 dark:bg-neutral-800 rounded" />
                <div className="h-5 w-14 bg-neutral-100 dark:bg-neutral-800 rounded-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700">
          <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800">
            <div className="h-4 w-28 bg-neutral-100 dark:bg-neutral-800 rounded" />
          </div>
          <div className="divide-y divide-neutral-50 dark:divide-neutral-800">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex items-center px-5 py-3 gap-3">
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-20 bg-neutral-100 dark:bg-neutral-800 rounded" />
                  <div className="h-3 w-14 bg-neutral-100 dark:bg-neutral-800 rounded" />
                </div>
                <div className="h-5 w-12 bg-neutral-100 dark:bg-neutral-800 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
