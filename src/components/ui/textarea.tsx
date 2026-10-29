import * as React from "react"

import { cn } from "@/lib/utils"
import { controlClass } from "./control"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(controlClass, "flex field-sizing-content min-h-16 py-2", className)}
      {...props}
    />
  )
}

export { Textarea }
