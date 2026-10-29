import * as React from "react"

import { cn } from "@/lib/utils"
import { CONTROL_MIN_HEIGHT, controlClass } from "./control"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(controlClass, CONTROL_MIN_HEIGHT, "flex field-sizing-content py-2", className)}
      {...props}
    />
  )
}

export { Textarea }
