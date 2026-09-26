import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, UserRound } from 'lucide-react'

import { api, isNotImplemented, type AccountsResult } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { InlineNote } from '@/components/common'
import { cn } from '@/lib/utils'

/**
 * 协议端账号（H13，规格见 CONFIG-UI.md §5.x）。
 *
 * ★★★ **这里永远拿不到 token，也不该设计"显示/复制 token"的功能**：
 *   后端做了字段白名单（即使上游实现不小心把 token 带回来也出不去），
 *   这是刻意的 —— 界面上能看到的凭据等于把它复制到每个能打开这个页面的人手里。
 * ★ 显示"当前在用哪个账号"以及**判定依据**：`matchedByConfig` 表示
 *   "这个账号的凭据与 config.json 里的一致"，那是最可靠的判据；
 *   如果 `why` 非空，说明判定不可靠，要提示使用者去 `onebot.selfId` 里写死账号。
 */
export function AccountsCard({ demo = false }: { demo?: boolean }) {
  const [data, setData] = useState<AccountsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)

  const load = useCallback(async () => {
    if (demo) return
    setLoading(true)
    setErr(null)
    try {
      setData(await api.snowlumaAccounts())
      setUnsupported(false)
    } catch (e) {
      if (isNotImplemented(e)) setUnsupported(true)
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [demo])

  useEffect(() => {
    void load()
  }, [load])

  if (demo || unsupported) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">协议端账号</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('mr-1 h-3.5 w-3.5', loading && 'animate-spin')} />
            {loading ? '读取中…' : '重新读取'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {err && <div className="text-sm text-red-700">读不到账号列表：{err}</div>}
        {data && data.accounts.length === 0 && (
          <div className="text-sm text-muted-foreground">
            没找到账号文件（协议端目录：<code className="text-xs">{data.installDir}</code>）。
          </div>
        )}
        {data?.accounts.map((a) => (
          <div
            key={a.uin}
            className={cn(
              'flex items-center gap-2 rounded-md border p-2 text-sm',
              a.isCurrent && 'border-emerald-300 bg-emerald-50/60',
            )}
          >
            <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="font-mono">{a.uin}</span>
            <span className="text-xs text-muted-foreground">{a.file}</span>
            {a.isCurrent && <span className="ml-auto text-xs font-medium text-emerald-700">当前在用</span>}
          </div>
        ))}
        {data && (
          <div className="pt-1 text-xs text-muted-foreground">
            {data.matchedByConfig ? (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                判定依据：该账号的凭据与 config.json 一致（最可靠的那种判定）。
              </span>
            ) : (
              <span>
                判定依据：{data.current || '（没能确定）'}
                {data.why ? ` —— ${data.why}` : ''}
              </span>
            )}
          </div>
        )}
        {data && !data.matchedByConfig && (
          <InlineNote level="warn">
            判定不够确定时，最稳的做法是在 <code>config.json</code> 的 <code>onebot.selfId</code>
            里写死机器人的 QQ 号 —— 否则协议端目录里有多个账号时可能挑错（症状是令牌被拒、
            机器人完全不说话）。
          </InlineNote>
        )}
        {/* ★ 明说这里看不到 token —— 免得有人以为"界面漏了"，然后去别处找 */}
        <div className="text-[11px] text-muted-foreground">
          ★ 这里**只显示账号，不显示 token**：凭据永远不出本机进程（接口做了字段白名单）。
        </div>
      </CardContent>
    </Card>
  )
}
