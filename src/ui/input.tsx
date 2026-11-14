import * as React from "react"

// 外观见 theme.css 的 Input 段。运行时脚本直接创建 <input>，两者共用同一份样式。
function Input({ type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" {...props} />
}

export { Input }
