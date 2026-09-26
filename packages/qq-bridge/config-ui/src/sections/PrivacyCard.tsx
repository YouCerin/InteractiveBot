import { useEffect, useState } from 'react'
import { ShieldCheck, ScanSearch, RefreshCw } from 'lucide-react'

import {
  api,
  isNotImplemented,
  type PrivacyAuditResult,
  type PrivacyScanResult,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * 隐私拦截（0.2.1，规格见 CONFIG-UI.md §2.5）。
 *
 * 隐私是**双侧硬闸**：写入侧拒绝落盘 + 输出侧拒绝发送，七类
 * （身份证/手机号/银行卡/密码密钥/住址/健康医疗/生物特征）。
 *
 * ★★ 绝不显示被拦的内容：审计里就没有原文（这是刻意的），
 *   这里也不加"查看原文"入口、不从别处捞回来显示 —— 否则拦截本身就成了泄露通道。
 * ★ 两侧分开计数：写入侧多 = 模型老想记隐私；输出侧多 = 它想往外说隐私，后者更值得报警。
 * ★ 不做"关闭隐私闸门"的开关：做成开关就等于给了一个静默关掉它的入口。
 */
export function PrivacyCard({ demo = false }: { demo?: boolean }) {
  const [audit, setAudit] = useState<PrivacyAuditResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [scan, setScan] = useState<PrivacyScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanErr, setScanErr] = useState<string | null>(null)

  if (demo || unsupported) return null

  const load = async () => {
    setLoading(true)
    setErr(null)
    try {
      setAudit(await api.memoryPrivacy())
      setUnsupported(false)
    } catch (e) {
      if (isNotImplemented(e)) setUnsupported(true)
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const runScan = async () => {
    setScanning(true)
    setScanErr(null)
    try {
      setScan(await api.memoryPrivacyScan())
    } catch (e) {
      if (isNotImplemented(e)) setUnsupported(true)
      else setScanErr(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const catName = (cats: Record<string, string>, c: string) => cats[c] ?? c
  const fmtTime = (iso: string, ts: number) => {
    const d = new Date(ts || iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          隐私拦截
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          双侧硬闸：写入侧拒绝落盘、输出侧拒绝发送（身份证 / 手机号 / 银行卡 / 密码密钥 / 住址 /
          健康医疗 / 生物特征）。<strong>没有开关</strong> —— 这是刻意的，开关等于给了一个静默关掉它的入口。
        </p>

        {err && <div className="text-xs text-red-700">{err}</div>}

        {audit && (
          <>
            {/* 两侧分开计数：输出侧更值得报警 */}
            <div className="flex gap-4 text-xs">
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-muted-foreground">写入侧拦截（想记隐私被拦）</div>
                <div className="text-lg font-semibold tabular-nums">{audit.storeCount}</div>
              </div>
              <div
                className={
                  audit.outputCount > 0
                    ? 'rounded-md border border-red-300 bg-red-50 px-3 py-2'
                    : 'rounded-md border bg-background px-3 py-2'
                }
              >
                <div className="text-muted-foreground">输出侧拦截（想往外说被拦）</div>
                <div className="text-lg font-semibold tabular-nums">{audit.outputCount}</div>
                {audit.outputCount > 0 && (
                  <div className="text-[10px] text-red-700">输出侧出现拦截更值得注意</div>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">最近拦截</div>
              {audit.recent.length === 0 ? (
                <div className="text-xs text-muted-foreground">（还没有拦截记录）</div>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {audit.recent.map((a, i) => (
                    <div
                      key={`${a.ts}-${i}`}
                      className="flex flex-wrap items-center gap-x-2 rounded border bg-background px-2 py-1 text-xs"
                    >
                      <span className="tabular-nums text-muted-foreground">{fmtTime(a.at, a.ts)}</span>
                      <span
                        className={
                          a.side === 'store'
                            ? 'rounded bg-amber-100 px-1 text-amber-800'
                            : 'rounded bg-red-100 px-1 text-red-800'
                        }
                      >
                        {a.side === 'store' ? '写入侧' : '输出侧'}
                      </span>
                      <span>{(a.categories ?? []).map((c) => catName(audit.categories, c)).join('、')}</span>
                      <span className="text-muted-foreground tabular-nums">{a.length} 字</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">
                只记时间、哪一侧、类别与字数 —— <strong>没有原文</strong>（刻意的：
                拦截要是记了原文，拦截本身就成了泄露通道）。
              </p>
            </div>
          </>
        )}

        {/* 扫描现有记忆：列出已经在盘上的隐私条目位置（只回位置，不回原文） */}
        <div className="space-y-2 border-t pt-2">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void runScan()} disabled={scanning}>
              <ScanSearch className="mr-1 h-3.5 w-3.5" />
              {scanning ? '扫描中…' : '扫描现有记忆'}
            </Button>
            <span className="text-[10px] text-muted-foreground">
              只读检查：盘上已有的记忆条目里有没有该被拦的内容（新写入已经被闸门拦住了，这是查存量）
            </span>
          </div>
          {scanErr && <div className="text-xs text-red-700">{scanErr}</div>}
          {scan && (
            <div className="space-y-1">
              {scan.hitCount === 0 ? (
                <div className="text-xs text-emerald-700">
                  ✅ 扫了 {scan.scanned} 条，现有记忆里没有发现七类隐私。
                </div>
              ) : (
                <>
                  <div className="text-xs text-amber-800">
                    ⚠️ 扫了 {scan.scanned} 条，命中 {scan.hitCount} 条（
                    {Object.entries(scan.byCategory)
                      .map(([c, n]) => `${catName(scan.categories, c)} ${n} 条`)
                      .join('、')}
                    ）。这些条目<strong>不会被新写入</strong>（写入侧已拦），但<strong>已经在盘上了</strong>
                    —— 在下面的记忆编辑器里找到对应行删掉即可。
                  </div>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {scan.hits.map((h, i) => (
                      <div
                        key={`${h.rel}-${h.line}-${i}`}
                        className="flex items-center gap-2 rounded border bg-background px-2 py-1 text-xs"
                      >
                        <span className="font-mono">
                          {h.rel}:{h.line}
                        </span>
                        <span className="text-muted-foreground">
                          [{h.categories.map((c) => catName(scan.categories, c)).join('、')}]
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
