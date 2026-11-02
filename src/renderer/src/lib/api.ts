import type { DiffEntry, EnvThawApi } from '../../../shared/ipc-types'

export const api: EnvThawApi = window.envthaw

/** Electron wraps handler errors as "Error invoking remote method 'x': Error: ...". */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}

export function formatTime(timestamp?: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function diffSummary(entries: DiffEntry[]): { added: number; modified: number; removed: number } {
  return {
    added: entries.filter((entry) => entry.kind === 'added').length,
    modified: entries.filter((entry) => entry.kind === 'modified').length,
    removed: entries.filter((entry) => entry.kind === 'removed').length
  }
}

export function kindLabel(kind: DiffEntry['kind']): string {
  if (kind === 'added') return '新增'
  if (kind === 'modified') return '修改'
  return '删除'
}
