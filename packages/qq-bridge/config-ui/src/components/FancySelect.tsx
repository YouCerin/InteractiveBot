import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface FancySelectOption {
  value: string
  label: string
  /** 选项右侧的小字（如字数、号码） */
  hint?: string
}

/**
 * 圆润带动画的下拉框（0.2.2 界面美化）。
 *
 * 基于 Radix Select（select.tsx 自带的 fade/zoom/slide 展开动画），
 * 统一加上：胶囊形触发器、圆角浮层、开合时箭头旋转、选项 hover 过渡。
 * 原生 <select> 的弹出层是操作系统画的，既圆不了也动不了 —— 这是换它的原因。
 *
 * ★ 不要给 options 传空串 value（Radix 不允许）；占位文案用 placeholder。
 */
export function FancySelect({
  value,
  onChange,
  options,
  placeholder = '请选择…',
  className,
  contentClassName,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  options: FancySelectOption[]
  placeholder?: string
  className?: string
  contentClassName?: string
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className={cn(
          // 胶囊形 + 平滑过渡；打开时带一圈淡淡的 ring
          'h-9 rounded-full border-input bg-background px-4 shadow-xs transition-all duration-200',
          'hover:border-primary/40 hover:shadow-sm data-[state=open]:border-primary/60 data-[state=open]:ring-[3px] data-[state=open]:ring-primary/15',
          // 开合时箭头旋转 180°
          '[&_svg]:transition-transform [&_svg]:duration-200 data-[state=open]:[&_svg]:rotate-180',
          className,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        position="popper"
        className={cn(
          // 更圆的浮层 + 柔和的阴影；展开/收起动画由 select.tsx 的 animate-in/out 提供
          'rounded-xl border-border/60 p-1.5 shadow-lg shadow-black/5',
          contentClassName,
        )}
      >
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            className="cursor-pointer rounded-lg py-2 pl-3 transition-colors duration-150"
          >
            <span className="flex w-full items-center justify-between gap-3">
              <span>{o.label}</span>
              {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
