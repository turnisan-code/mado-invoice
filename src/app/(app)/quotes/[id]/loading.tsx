export default function InvoiceDetailLoading() {
  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-6 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 bg-neutral-200 dark:bg-neutral-800 rounded" />
        <div className="h-7 w-32 bg-neutral-200 dark:bg-neutral-800 rounded-md" />
        <div className="h-6 w-16 bg-neutral-100 dark:bg-neutral-800 rounded-full" />
      </div>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6 space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <div className="h-9 bg-neutral-100 dark:bg-neutral-800 rounded-md" />
          <div className="grid grid-cols-2 gap-3">
            <div className="h-9 bg-neutral-100 dark:bg-neutral-800 rounded-md" />
            <div className="h-9 bg-neutral-100 dark:bg-neutral-800 rounded-md" />
          </div>
        </div>
        <div className="space-y-2 pt-4 border-t border-neutral-100 dark:border-neutral-800">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-9 bg-neutral-100 dark:bg-neutral-800 rounded-md" />
          ))}
        </div>
        <div className="flex justify-end space-y-1 pt-4 border-t border-neutral-100 dark:border-neutral-800">
          <div className="w-48 space-y-2">
            <div className="h-4 w-full bg-neutral-100 dark:bg-neutral-800 rounded" />
            <div className="h-4 w-full bg-neutral-100 dark:bg-neutral-800 rounded" />
            <div className="h-6 w-full bg-neutral-100 dark:bg-neutral-800 rounded" />
          </div>
        </div>
      </div>
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6">
        <div className="h-4 w-20 bg-neutral-100 dark:bg-neutral-800 rounded mb-4" />
        <div className="h-9 bg-neutral-100 dark:bg-neutral-800 rounded-md" />
      </div>
    </div>
  )
}
