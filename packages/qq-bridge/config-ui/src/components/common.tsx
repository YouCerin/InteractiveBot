import { useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { X, AlertTriangle, Info, OctagonAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── 危险操作二次确认 ──────────────────────────────────────────────────────

export interface ConfirmRequest {
  title: string
  description: ReactNode
  confirmText?: string
  onConfirm: () => void
}

export function ConfirmDialog({
  req,
  onClose,
}: {
  req: ConfirmRequest | null
  onClose: () => void
}) {
  return (
    <AlertDialog open={!!req} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <OctagonAlert className="h-5 w-5 text-red-500" />
            {req?.title}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm leading-relaxed text-foreground/80">{req?.description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 hover:bg-red-700"
            onClick={() => {
              req?.onConfirm()
              onClose()
            }}
          >
            {req?.confirmText ?? '确定'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ── 字段行：标签 + 控件 + 说明 ────────────────────────────────────────────

export function FieldRow({
  label,
  hint,
  star,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  star?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('grid gap-1.5 py-3 sm:grid-cols-[220px_1fr] sm:gap-4', className)}>
      <div className="pt-1">
        <Label className="text-sm font-medium">
          {star && <span className="mr-1 text-amber-500" title="与账号存活有关">★</span>}
          {label}
        </Label>
        {hint && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

// ── 数字输入 ──────────────────────────────────────────────────────────────

export function NumInput({
  value,
  onChange,
  unit,
  min,
  max,
  className,
}: {
  value: number
  onChange: (n: number) => void
  unit?: string
  min?: number
  max?: number
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        className="w-32"
        onChange={(e) => {
          const n = Number(e.target.value)
          if (e.target.value !== '' && Number.isFinite(n)) onChange(n)
        }}
      />
      {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
    </div>
  )
}

// ── 标签输入（关键词 / 管理员 QQ 号）──────────────────────────────────────

export function TagInput({
  values,
  onChange,
  placeholder,
  warnWords = [],
  validate,
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  /** 需要标黄的词 */
  warnWords?: string[]
  /** 自定义校验，返回警告文案 */
  validate?: (word: string) => string | null
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim()
    if (!v) return
    if (!values.includes(v)) onChange([...values, v])
    setDraft('')
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5">
        {values.map((v) => {
          const warn = warnWords.includes(v) ? '命中风险词' : validate?.(v)
          return (
            <Badge
              key={v}
              variant={warn ? 'outline' : 'secondary'}
              className={cn(
                'gap-1 py-1 text-xs',
                warn && 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40',
              )}
              title={warn ?? undefined}
            >
              {warn && <AlertTriangle className="h-3 w-3" />}
              {v}
              <button
                type="button"
                className="ml-0.5 rounded-full hover:bg-black/10"
                onClick={() => onChange(values.filter((x) => x !== v))}
                aria-label={`删除 ${v}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )
        })}
        <input
          className="min-w-28 flex-1 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
          value={draft}
          placeholder={values.length === 0 ? placeholder : '回车添加'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
              onChange(values.slice(0, -1))
            }
          }}
          onBlur={add}
        />
      </div>
    </div>
  )
}

// ── 行内提示条 ────────────────────────────────────────────────────────────

export function InlineNote({
  level,
  children,
  className,
}: {
  level: 'warn' | 'danger' | 'info'
  children: ReactNode
  className?: string
}) {
  const styles = {
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
    danger: 'border-red-300 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200',
    info: 'border-sky-300 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
  }
  const Icon = level === 'info' ? Info : AlertTriangle
  return (
    <div className={cn('flex gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed', styles[level], className)}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  )
}
