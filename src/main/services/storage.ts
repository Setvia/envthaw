import fs from 'node:fs'
import path from 'node:path'
import type {
  AppSettings,
  AuditEntry,
  DataFiles,
  EnvSnapshot,
  ScriptEntry,
  ScriptTemplate
} from '../../shared/ipc-types'
import { configDir, dataDir, expandDeep, presetsDir } from './paths'

export interface StorageLayout {
  root: string
  dataDir: string
  files: DataFiles
}

export interface RollbackPoint {
  id: string
  createdAt: number
  reason: string
  vars: Record<string, string>
}

export function getLayout(): StorageLayout {
  const root = configDir()
  return {
    root,
    dataDir: dataDir(),
    files: {
      settings: path.join(root, 'settings.json'),
      snapshots: path.join(root, 'snapshots.json'),
      scripts: path.join(root, 'scripts.json'),
      audit: path.join(root, 'audit.jsonl'),
      rollbacks: path.join(root, 'rollbacks'),
      updates: path.join(root, 'updates')
    }
  }
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

/** Reads a bundled example file and expands ${DATA_DIR} style placeholders. */
function readPreset<T>(name: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(path.join(presetsDir(), name), 'utf8')
    return expandDeep(JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function defaultSettings(): AppSettings {
  return {
    autoSnapshotBeforeRun: true,
    autoSnapshotBeforeRestore: true,
    updateFeedUrl: ''
  }
}

/**
 * Creates config/ (and data/) on first run and seeds the example configuration
 * from presets/. Only missing files are written, so user edits and deletions are
 * never resurrected on the next start.
 */
export function ensureLayout(): StorageLayout {
  const layout = getLayout()
  fs.mkdirSync(layout.root, { recursive: true })
  fs.mkdirSync(layout.dataDir, { recursive: true })
  fs.mkdirSync(layout.files.rollbacks, { recursive: true })
  fs.mkdirSync(layout.files.updates, { recursive: true })

  if (!fs.existsSync(layout.files.settings)) {
    writeJson(layout.files.settings, defaultSettings())
  }
  if (!fs.existsSync(layout.files.scripts)) {
    writeJson(layout.files.scripts, readPreset<ScriptEntry[]>('scripts.json', []))
  }
  if (!fs.existsSync(path.join(layout.root, 'redirect.json'))) {
    writeJson(path.join(layout.root, 'redirect.json'), readPreset<Record<string, string>>('redirect.json', {}))
  }

  return layout
}

export function readSettings(): AppSettings {
  const layout = getLayout()
  const stored = readJson<Partial<AppSettings>>(layout.files.settings, {})
  return { ...defaultSettings(), ...stored }
}

export function writeSettings(settings: AppSettings): AppSettings {
  ensureLayout()
  writeJson(getLayout().files.settings, settings)
  return settings
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

/** Templates for "new script" come from presets/script-templates.json. */
export function readScriptTemplates(): ScriptTemplate[] {
  const templates = readPreset<ScriptTemplate[]>('script-templates.json', [])
  return templates.filter(
    (template) =>
      typeof template?.id === 'string' &&
      typeof template?.name === 'string' &&
      (template?.type === 'batch' || template?.type === 'powershell') &&
      typeof template?.content === 'string'
  )
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
