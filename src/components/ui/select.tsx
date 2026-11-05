import * as React from "react"

import { cn } from "@/lib/utils"
import { CONTROL_HEIGHT, controlClass } from "./control"

// The chevron is a background image, so the select stays a single element: refs, register()
// and layout classes (flex-1, w-auto, max-w-*) reach it directly.
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`

// Native select styled like Input: same height, border, focus ring, invalid and disabled states.
// Options take the popover colours so the open list stays readable in dark mode.
function Select({ className, style, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        CONTROL_HEIGHT,
        controlClass,
        "appearance-none py-0 pr-8 disabled:pointer-events-none dark:scheme-dark [&_optgroup]:bg-popover [&_option]:bg-popover [&_option]:text-popover-foreground",
        className
      )}
      style={{ backgroundImage: CHEVRON, backgroundRepeat: "no-repeat", backgroundPosition: "right 0.5rem center", backgroundSize: "1rem", ...style }}
      {...props}
    />
  )
}

export { Select }
