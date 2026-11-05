import type { ProjectStatus } from '@/types'

// The look of the recurring dialogs: 16 px text on phones so iOS does not zoom into a field.
export const inputClass = 'w-full h-10 sm:h-9 text-base md:text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2.5 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400 disabled:opacity-50'
export const textareaClass = 'w-full min-h-16 text-base md:text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2.5 py-1.5 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400 disabled:opacity-50'
export const labelClass = 'block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1'
export const checkboxClass = 'w-4 h-4 rounded border-neutral-300 dark:border-neutral-600 accent-neutral-900 dark:accent-white'
export const iconButtonClass = 'h-11 w-11 sm:h-8 sm:w-8 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40 disabled:pointer-events-none'
export const outlineButtonClass = 'flex items-center justify-center gap-1.5 text-sm px-3 h-10 sm:h-8 rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40 disabled:pointer-events-none'
export const primaryButtonClass = 'flex items-center justify-center gap-1.5 text-sm px-3 h-10 sm:h-8 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors disabled:opacity-40 disabled:pointer-events-none'
export const cardClass = 'bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700'

export const projectStatusColor: Record<ProjectStatus, string> = {
  active: 'text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300',
  done: 'text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300',
  archived: 'text-neutral-500 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-400',
}

// A budget bar turns amber from 80 % and red once it is used up.
export function budgetBarColor(share: number): string {
  if (share >= 1) return 'bg-red-500'
  if (share >= 0.8) return 'bg-amber-500'
  return 'bg-neutral-900 dark:bg-neutral-100'
}
