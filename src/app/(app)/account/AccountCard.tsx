export default function AccountCard({ id, title, description, aside, children }: {
  id: string
  title: string
  description: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{description}</p>
        </div>
        {aside}
      </div>
      <div className="px-4 sm:px-6 py-5">{children}</div>
    </section>
  )
}
