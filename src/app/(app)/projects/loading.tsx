export default function ProjectsLoading() {
  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto animate-pulse space-y-4">
      <div className="flex items-center justify-between">
        <div className="h-7 w-40 bg-neutral-200 dark:bg-neutral-800 rounded-md" />
        <div className="h-8 w-56 bg-neutral-100 dark:bg-neutral-800 rounded-md" />
      </div>
      <div className="h-9 w-full sm:max-w-sm bg-neutral-100 dark:bg-neutral-800 rounded-md" />
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        <div className="border-b border-neutral-100 dark:border-neutral-800 px-4 py-3 flex gap-8">
          {['w-32', 'w-24', 'w-16', 'w-20', 'w-20', 'w-16'].map((w, i) => (
            <div key={i} className={`h-3.5 ${w} bg-neutral-100 dark:bg-neutral-800 rounded`} />
          ))}
        </div>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="flex items-center px-4 py-3 gap-8 border-b border-neutral-50 dark:border-neutral-800 last:border-0">
            <div className="h-4 w-32 bg-neutral-100 dark:bg-neutral-800 rounded" />
            <div className="h-4 w-24 bg-neutral-100 dark:bg-neutral-800 rounded" />
            <div className="h-5 w-14 bg-neutral-100 dark:bg-neutral-800 rounded-full" />
            <div className="h-4 w-16 bg-neutral-100 dark:bg-neutral-800 rounded ml-auto" />
          </div>
        ))}
      </div>
    </div>
  )
}
