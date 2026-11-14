import * as React from "react"
import { cn } from "./utils"

// 外观见 theme.css 的 Native Select 段。运行时脚本直接创建 <select>，两者共用同一份样式。
function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div
      className="group/native-select relative inline-block max-w-full min-w-0 has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn("w-full", className)}
        {...props}
      />
    </div>
  )
}

export { NativeSelect }
