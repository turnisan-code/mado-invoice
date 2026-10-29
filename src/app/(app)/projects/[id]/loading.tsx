export default function ProjectLoading() {
  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-7 w-56 bg-neutral-200 dark:bg-neutral-800 rounded-md" />
        <div className="h-4 w-40 bg-neutral-100 dark:bg-neutral-800 rounded" />
      </div>
      <div className="grid grid-cols-2 sm:flex gap-2">
        {[...Array(4)].map((_, i) => <div key={i} className="h-10 sm:h-8 sm:w-32 bg-neutral-100 dark:bg-neutral-800 rounded-md" />)}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 space-y-2">
            <div className="h-3 w-16 bg-neutral-100 dark:bg-neutral-800 rounded" />
            <div className="h-6 w-24 bg-neutral-100 dark:bg-neutral-800 rounded" />
          </div>
        ))}
      </div>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <div className="h-11 border-b border-neutral-100 dark:border-neutral-800" />
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center px-4 py-3 gap-6 border-b border-neutral-50 dark:border-neutral-800 last:border-0">
            <div className="h-4 w-20 bg-neutral-100 dark:bg-neutral-800 rounded" />
            <div className="h-4 w-12 bg-neutral-100 dark:bg-neutral-800 rounded" />
            <div className="h-4 flex-1 bg-neutral-100 dark:bg-neutral-800 rounded" />
            <div className="h-5 w-16 bg-neutral-100 dark:bg-neutral-800 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
