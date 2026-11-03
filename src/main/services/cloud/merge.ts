export type VarMap = Record<string, string>

export interface MergeConflict {
  key: string
  base?: string
  local?: string
  remote?: string
}

export interface MergeResult {
  merged: VarMap
  conflicts: MergeConflict[]
  mergeable: boolean
}

const has = (map: VarMap, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key)

/**
 * Three-way merge for env var maps. Same rules as the backend
 * (envthaw-server/src/lib/merge.ts) so both sides agree on what a conflict is.
 */
export function mergeVars(base: VarMap, local: VarMap, remote: VarMap): MergeResult {
  const merged: VarMap = {}
  const conflicts: MergeConflict[] = []
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])
  const valueOf = (map: VarMap, key: string): string | undefined => (has(map, key) ? map[key] : undefined)

  for (const key of keys) {
    const b = valueOf(base, key)
    const l = valueOf(local, key)
    const r = valueOf(remote, key)

    if (l === r) {
      if (l !== undefined) merged[key] = l
      continue
    }
    if (l === b) {
      if (r !== undefined) merged[key] = r
      continue
    }
    if (r === b) {
      if (l !== undefined) merged[key] = l
      continue
    }
    conflicts.push({ key, base: b, local: l, remote: r })
  }

  return { merged, conflicts, mergeable: conflicts.length === 0 }
}
