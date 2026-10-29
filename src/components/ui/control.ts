// One height for every form control and default button: a 40 px touch target on phones, the
// compact 32 px from sm on.
export const CONTROL_HEIGHT = 'h-10 sm:h-8'
export const CONTROL_MIN_HEIGHT = 'min-h-10 sm:min-h-8'

// The look Input, Select and Textarea share. Native controls that cannot use the primitives
// (filter bars, file pickers) take it too, so they line up with them.
export const controlClass = 'w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40'

export const fieldClass = `${CONTROL_HEIGHT} ${controlClass} py-1`
