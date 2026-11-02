import type { ApplyResult, DiffEntry, EnvSnapshot, EnvVarEntry } from '../../shared/ipc-types'
import { applyRegistryOps, readUserEnv, toEnvRecord, type RegistryOp } from '../utils/registry'
import { diffVars, summarizeDiff } from './restore-engine'
import {
  appendAudit,
  newId,
  readRollbackPoint,
  readSnapshots,
  writeRollbackPoint,
  writeSnapshots
} from './storage'

function now(): number {
  return Date.now()
}

export function audit(action: string, detail: string, ok = true): void {
  try {
    appendAudit({ id: newId('audit'), at: now(), action, detail, ok })
  } catch {
    // never let audit failures break a user operation
  }
}

function pickKind(name: string, value: string, current: EnvVarEntry[]): 'String' | 'ExpandString' {
  const existing = current.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
  if (existing?.kind === 'ExpandString') return 'ExpandString'
  return value.includes('%') ? 'ExpandString' : 'String'
}

/** Snapshot of the current user environment, taken before every mutation. */
function createRollbackPoint(reason: string, vars: Record<string, string>): string {
  return writeRollbackPoint({ id: newId('rb'), createdAt: now(), reason, vars })
}

async function applyEntries(entries: DiffEntry[], current: EnvVarEntry[], reason: string): Promise<ApplyResult> {
  if (entries.length === 0) {
    return { applied: 0, failed: [], rollbackId: null }
  }

  const rollbackId = createRollbackPoint(reason, toEnvRecord(current))
  const ops: RegistryOp[] = entries.map((entry) =>
    entry.kind === 'removed'
      ? { op: 'delete', name: entry.name }
      : {
          op: 'set',
          name: entry.name,
          value: entry.after ?? '',
          // Keep the existing kind when present; new values referencing %VAR% use ExpandString.
          kind: pickKind(entry.name, entry.after ?? '', current)
        }
  )

  try {
    await applyRegistryOps(ops)
    audit('env.apply', `${reason}：${summarizeDiff(entries)}`)
    return { applied: ops.length, failed: [], rollbackId }
  } catch (error) {
    audit('env.apply', `${reason} 失败：${(error as Error).message}`, false)
    return {
      applied: 0,
      failed: [{ name: '*', error: (error as Error).message }],
      rollbackId: null
    }
  }
}

export async function listEnv(): Promise<EnvVarEntry[]> {
  return readUserEnv()
}

/** Applies a pre-computed diff against the live user environment (used by path redirects). */
export async function applyDiffEntries(entries: DiffEntry[], reason: string): Promise<ApplyResult> {
  const current = await readUserEnv()
  return applyEntries(entries, current, reason)
}

export async function setEnv(name: string, value: string): Promise<void> {
  const current = await readUserEnv()
  const entry: DiffEntry = { kind: 'modified', name, before: null, after: value }
  const result = await applyEntries([entry], current, `设置 ${name}`)
  if (result.failed.length > 0) throw new Error(result.failed[0].error)
}

export async function removeEnv(name: string): Promise<void> {
  const current = await readUserEnv()
  const entry: DiffEntry = { kind: 'removed', name, before: null, after: null }
  const result = await applyEntries([entry], current, `删除 ${name}`)
  if (result.failed.length > 0) throw new Error(result.failed[0].error)
}

export function listSnapshots(): EnvSnapshot[] {
  return readSnapshots().sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveSnapshot(name: string, note?: string): Promise<EnvSnapshot> {
  const entries = await readUserEnv()
  const snapshot: EnvSnapshot = {
    id: newId('snap'),
    name: name.trim() || `快照 ${new Date().toLocaleString()}`,
    note: note?.trim() || undefined,
    createdAt: now(),
    userVars: toEnvRecord(entries)
  }
  const snapshots = readSnapshots()
  snapshots.push(snapshot)
  writeSnapshots(snapshots)
  audit('snapshot.save', `${snapshot.name}（${Object.keys(snapshot.userVars).length} 个变量）`)
  return snapshot
}

export function deleteSnapshot(id: string): void {
  const snapshots = readSnapshots()
  const target = snapshots.find((snapshot) => snapshot.id === id)
  writeSnapshots(snapshots.filter((snapshot) => snapshot.id !== id))
  if (target) audit('snapshot.delete', target.name)
}

export async function diffSnapshot(id: string): Promise<DiffEntry[]> {
  const snapshot = readSnapshots().find((item) => item.id === id)
  if (!snapshot) throw new Error('快照不存在')
  const current = await readUserEnv()
  return diffVars(snapshot.userVars, toEnvRecord(current))
}

export async function applySnapshot(id: string): Promise<ApplyResult> {
  const snapshot = readSnapshots().find((item) => item.id === id)
  if (!snapshot) throw new Error('快照不存在')
  const current = await readUserEnv()
  const entries = diffVars(snapshot.userVars, toEnvRecord(current))
  return applyEntries(entries, current, `恢复快照「${snapshot.name}」`)
}

export async function rollbackTo(rollbackId: string): Promise<ApplyResult> {
  const point = readRollbackPoint(rollbackId)
  if (!point) throw new Error('回滚点不存在或已被清理')
  const current = await readUserEnv()
  const entries = diffVars(point.vars, toEnvRecord(current))
  return applyEntries(entries, current, `回滚（${point.reason}）`)
}
