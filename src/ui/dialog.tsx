import * as React from "react"
import { cn } from "./utils"

// shadcn/ui Dialog 的版式部分。开关由原生 <dialog> 和页面脚本负责，外观见 theme.css。
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-2 text-left", className)} {...props} />
}

function DialogTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 data-slot="dialog-title" className={cn("text-lg leading-none font-semibold", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
}

// 确认按钮在 DOM 中靠前，表单按回车时才会提交它；视觉上用反向排列放到右侧。
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex flex-col gap-2 sm:flex-row-reverse sm:justify-start", className)} {...props} />
}

export { DialogHeader, DialogTitle, DialogDescription, DialogFooter }
