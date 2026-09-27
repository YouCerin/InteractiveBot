/**
 * Config persistence: user edits from the UI are saved as `config.json` in the
 * plugin data directory and merged over the cordis Config at boot.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'

export function configDirOf(dataDir: string): string {
  return dataDir ? expandHomePath(dataDir) : dshHomePath('storages', 'qq-bot')
}

export function loadConfigJson<T>(dataDir: string): Partial<T> {
  try {
    const file = join(configDirOf(dataDir), 'config.json')
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, 'utf8')) as Partial<T>
  } catch {
    return {}
  }
}

export function saveConfigJson(dataDir: string, cfg: unknown): void {
  const dir = configDirOf(dataDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
}

/** Deep merge `override` over `base` (arrays and scalars are replaced wholesale). */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base
  if (Array.isArray(base) || Array.isArray(override)) return override as T
  if (typeof base === 'object' && base !== null && typeof override === 'object' && override !== null) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const key of Object.keys(override as Record<string, unknown>)) {
      out[key] = deepMerge(out[key], (override as Record<string, unknown>)[key])
    }
    return out as T
  }
  return override as T
}
