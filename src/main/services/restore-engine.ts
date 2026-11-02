import type { DiffEntry } from '../../shared/ipc-types'

/**
 * Pure diff logic shared by the snapshot restore and the path-redirect engine.
 * Windows variable names are case-insensitive, so matching is done on the
 * lower-cased name while the target keeps its own casing.
 */
export function diffVars(target: Record<string, string>, current: Record<string, string>): DiffEntry[] {
  const currentByKey = new Map<string, { name: string; value: string }>()
  for (const [name, value] of Object.entries(current)) {
    currentByKey.set(name.toLowerCase(), { name, value })
  }

  const entries: DiffEntry[] = []
  const seen = new Set<string>()

  for (const [name, value] of Object.entries(target)) {
    const key = name.toLowerCase()
    seen.add(key)
    const existing = currentByKey.get(key)
    if (!existing) {
      entries.push({ kind: 'added', name, before: null, after: value })
    } else if (existing.value !== value) {
      entries.push({ kind: 'modified', name: existing.name, before: existing.value, after: value })
    }
  }

  for (const [key, existing] of currentByKey) {
    if (!seen.has(key)) {
      entries.push({ kind: 'removed', name: existing.name, before: existing.value, after: null })
    }
  }

  const order: Record<DiffEntry['kind'], number> = { added: 0, modified: 1, removed: 2 }
  return entries.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name))
}

/** Turns a diff into the inverse diff, used for rollback. */
export function invertDiff(entries: DiffEntry[]): DiffEntry[] {
  return entries
    .map((entry) => {
      if (entry.kind === 'added') {
        return { kind: 'removed' as const, name: entry.name, before: entry.after, after: null }
      }
      if (entry.kind === 'removed') {
        return { kind: 'added' as const, name: entry.name, before: null, after: entry.before }
      }
      return { kind: 'modified' as const, name: entry.name, before: entry.after, after: entry.before }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function summarizeDiff(entries: DiffEntry[]): string {
  const added = entries.filter((e) => e.kind === 'added').length
  const modified = entries.filter((e) => e.kind === 'modified').length
  const removed = entries.filter((e) => e.kind === 'removed').length
  return `新增 ${added} · 修改 ${modified} · 删除 ${removed}`
}
