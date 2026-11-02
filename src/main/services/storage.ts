import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings, AuditEntry, DataFiles, EnvSnapshot, ScriptEntry } from '../../shared/ipc-types'

export interface StorageLayout {
  root: string
  files: DataFiles
}

export interface RollbackPoint {
  id: string
  createdAt: number
  reason: string
  vars: Record<string, string>
}

const BOOTSTRAP_FILE = () => path.join(app.getPath('userData'), 'config.json')

function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-test-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * C 盘在机房环境会被冰点还原，所以默认落在非保护盘（D:\EnvThaw）。
 * 便携版（electron-builder portable）优先放在 exe 旁边；如果这些位置都不可写，
 * 依次退回应用数据目录和用户目录，避免应用直接不可用。
 */
export function defaultStorageRoot(): string {
  const candidates: string[] = []

  // Explicit override, also used by the smoke test and by portable deployments.
  if (process.env.ENVTHAW_STORAGE_ROOT) candidates.push(process.env.ENVTHAW_STORAGE_ROOT)
  // electron-builder portable extracts the app and exposes the launcher directory.
  if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'EnvThaw'))

  if (process.platform === 'win32') {
    candidates.push('D:\\EnvThaw')
  }
  candidates.push(path.join(app.getPath('userData'), 'EnvThaw'))
  candidates.push(path.join(os.homedir(), 'EnvThaw'))

  for (const candidate of candidates) {
    if (candidate && isWritable(candidate)) return candidate
  }
  return path.join(os.homedir(), 'EnvThaw')
}

function readBootstrapRoot(): string | null {
  try {
    const raw = fs.readFileSync(BOOTSTRAP_FILE(), 'utf8')
    const parsed = JSON.parse(raw) as { storageRoot?: unknown }
    if (typeof parsed.storageRoot === 'string' && parsed.storageRoot.trim()) {
      return parsed.storageRoot
    }
  } catch {
    // first run, or a corrupt bootstrap file: fall through to the default
  }
  return null
}

export function getStorageRoot(): string {
  return readBootstrapRoot() ?? defaultStorageRoot()
}

export function setStorageRoot(root: string): void {
  fs.mkdirSync(path.dirname(BOOTSTRAP_FILE()), { recursive: true })
  fs.writeFileSync(BOOTSTRAP_FILE(), JSON.stringify({ storageRoot: root }, null, 2), 'utf8')
}

export function getLayout(): StorageLayout {
  const root = getStorageRoot()
  return {
    root,
    files: {
      settings: path.join(root, 'settings.json'),
      snapshots: path.join(root, 'snapshots.json'),
      scripts: path.join(root, 'scripts.json'),
      audit: path.join(root, 'audit.jsonl'),
      rollbacks: path.join(root, 'rollbacks')
    }
  }
}

export function ensureLayout(): StorageLayout {
  const layout = getLayout()
  fs.mkdirSync(layout.root, { recursive: true })
  fs.mkdirSync(layout.files.rollbacks, { recursive: true })
  return layout
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function defaultSettings(): AppSettings {
  return {
    storageRoot: getStorageRoot(),
    autoSnapshotBeforeRun: true,
    autoSnapshotBeforeRestore: true
  }
}

export function readSettings(): AppSettings {
  const layout = getLayout()
  const stored = readJson<Partial<AppSettings>>(layout.files.settings, {})
  return { ...defaultSettings(), ...stored }
}

export function writeSettings(settings: AppSettings): AppSettings {
  const layout = ensureLayout()
  const normalized: AppSettings = { ...settings, storageRoot: layout.root }
  writeJson(layout.files.settings, normalized)
  return normalized
}

export function readSnapshots(): EnvSnapshot[] {
  return readJson<EnvSnapshot[]>(getLayout().files.snapshots, [])
}

export function writeSnapshots(snapshots: EnvSnapshot[]): void {
  ensureLayout()
  writeJson(getLayout().files.snapshots, snapshots)
}

export function readScripts(): ScriptEntry[] {
  return readJson<ScriptEntry[]>(getLayout().files.scripts, [])
}

export function writeScripts(scripts: ScriptEntry[]): void {
  ensureLayout()
  writeJson(getLayout().files.scripts, scripts)
}

export function appendAudit(entry: AuditEntry): void {
  const layout = ensureLayout()
  fs.appendFileSync(layout.files.audit, `${JSON.stringify(entry)}\n`, 'utf8')
}

export function readAudit(limit = 200): AuditEntry[] {
  try {
    const layout = ensureLayout()
    const lines = fs.readFileSync(layout.files.audit, 'utf8').split(/\r?\n/).filter(Boolean)
    const entries = lines
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is AuditEntry => entry !== null)
    return entries.slice(-limit).reverse()
  } catch {
    return []
  }
}

export function writeRollbackPoint(point: RollbackPoint): string {
  const layout = ensureLayout()
  writeJson(path.join(layout.files.rollbacks, `${point.id}.json`), point)
  return point.id
}

export function readRollbackPoint(id: string): RollbackPoint | null {
  const layout = ensureLayout()
  return readJson<RollbackPoint | null>(path.join(layout.files.rollbacks, `${id}.json`), null)
}

export function newId(prefix: string): string {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${stamp}-${rand}`
}
