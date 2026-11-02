import fs from 'node:fs'
import path from 'node:path'
import type {
  AppSettings,
  AuditEntry,
  DataFiles,
  EnvSnapshot,
  ScriptEntry,
  ScriptTemplate,
  ScriptType,
  UserProfile
} from '../../shared/ipc-types'
import { DEFAULT_USER, configDir, dataDir, expandDeep, presetsDir, sessionFile, userDir } from './paths'

export interface StorageLayout {
  /** config/ */
  root: string
  /** config/<user>/ */
  userRoot: string
  user: string
  dataDir: string
  files: DataFiles
}

/** What actually gets persisted in scripts.json - file contents live on disk. */
export interface ScriptRecord {
  id: string
  name: string
  type: ScriptType
  file: string
  createdAt: number
  lastRunAt?: number
  lastExitCode?: number
}

export interface RollbackPoint {
  id: string
  createdAt: number
  reason: string
  vars: Record<string, string>
}

const RESERVED_NAMES = new Set(['session', 'updates', 'data', 'tmp'])
const USER_NAME_RE = /^[\w\u4e00-\u9fa5.-]{1,32}$/

export function isValidUserName(name: string): boolean {
  return USER_NAME_RE.test(name) && !RESERVED_NAMES.has(name.toLowerCase()) && !name.startsWith('.')
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

/* ------------------------------------------------------------------ users */

export function getActiveUser(): string {
  const raw = readJson<{ activeUser?: string }>(sessionFile(), {})
  const name = typeof raw.activeUser === 'string' ? raw.activeUser : DEFAULT_USER
  if (!isValidUserName(name)) return DEFAULT_USER
  return fs.existsSync(userDir(name)) ? name : DEFAULT_USER
}

export function setActiveUser(name: string): void {
  if (!isValidUserName(name)) throw new Error('用户名不合法')
  if (!fs.existsSync(userDir(name))) throw new Error('用户不存在')
  writeJson(sessionFile(), { activeUser: name })
}

export function listUsers(): UserProfile[] {
  const active = getActiveUser()
  const root = configDir()
  let names: string[] = []
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          isValidUserName(entry.name) &&
          // A profile always has a settings.json; this also hides legacy temp dirs.
          fs.existsSync(path.join(root, entry.name, 'settings.json'))
      )
      .map((entry) => entry.name)
  } catch {
    names = []
  }
  if (!names.includes(DEFAULT_USER)) names.push(DEFAULT_USER)
  names.sort((left, right) => {
    if (left === DEFAULT_USER) return -1
    if (right === DEFAULT_USER) return 1
    return left.localeCompare(right)
  })
  return names.map((name) => ({ name, active: name === active, dir: userDir(name) }))
}

export function createUser(rawName: string): void {
  const name = rawName.trim()
  if (!isValidUserName(name)) throw new Error('用户名只能包含字母、数字、中文、下划线和短横线（1-32 位）')
  if (fs.existsSync(userDir(name))) throw new Error('该用户已存在')
  seedUser(name)
}

export function removeUser(name: string): void {
  if (name === DEFAULT_USER) throw new Error('default 用户不可删除')
  if (!isValidUserName(name)) throw new Error('用户名不合法')
  const dir = userDir(name)
  if (!fs.existsSync(dir)) return
  fs.rmSync(dir, { recursive: true, force: true })
  if (getActiveUser() === name) writeJson(sessionFile(), { activeUser: DEFAULT_USER })
}

/* --------------------------------------------------------------- layout */

export function getLayout(): StorageLayout {
  const user = getActiveUser()
  const root = configDir()
  const userRoot = userDir(user)
  return {
    root,
    userRoot,
    user,
    dataDir: dataDir(),
    files: {
      settings: path.join(userRoot, 'settings.json'),
      snapshots: path.join(userRoot, 'snapshots.json'),
      scripts: path.join(userRoot, 'scripts.json'),
      scriptsDir: path.join(userRoot, 'scripts'),
      audit: path.join(userRoot, 'audit.jsonl'),
      rollbacks: path.join(userRoot, 'rollbacks'),
      updates: path.join(root, 'updates')
    }
  }
}

export function scriptsDir(): string {
  return getLayout().files.scriptsDir
}

function fileExtension(type: ScriptType): string {
  if (type === 'batch') return '.cmd'
  if (type === 'powershell') return '.ps1'
  return '.txt'
}

export function extensionForType(type: ScriptType): string {
  return fileExtension(type)
}

/**
 * v0.1 kept everything directly in config/. Move those files into
 * config/default/ once, so an existing install keeps its data.
 */
function migrateLegacyLayout(): void {
  const root = configDir()
  const legacySettings = path.join(root, 'settings.json')
  const defaultDir = userDir(DEFAULT_USER)
  if (!fs.existsSync(legacySettings) || fs.existsSync(defaultDir)) return

  fs.mkdirSync(defaultDir, { recursive: true })
  for (const name of ['settings.json', 'redirect.json', 'snapshots.json', 'scripts.json', 'audit.jsonl']) {
    const from = path.join(root, name)
    if (fs.existsSync(from)) fs.renameSync(from, path.join(defaultDir, name))
  }
  const legacyRollbacks = path.join(root, 'rollbacks')
  if (fs.existsSync(legacyRollbacks)) fs.renameSync(legacyRollbacks, path.join(defaultDir, 'rollbacks'))

  // Old scripts.json embedded the content; split it into real files now.
  const legacyScriptsFile = path.join(defaultDir, 'scripts.json')
  const legacyScripts = readJson<Array<ScriptRecord & { content?: string }>>(legacyScriptsFile, [])
  if (legacyScripts.length === 0) return

  const dir = path.join(defaultDir, 'scripts')
  fs.mkdirSync(dir, { recursive: true })
  const records: ScriptRecord[] = legacyScripts.map((entry) => {
    const type: ScriptType = entry.type === 'batch' || entry.type === 'powershell' ? entry.type : 'other'
    const file = `${entry.id}${fileExtension(type)}`
    fs.writeFileSync(path.join(dir, file), entry.content ?? '', 'utf8')
    const { content: _content, ...rest } = entry
    return { ...rest, type, file }
  })
  writeJson(legacyScriptsFile, records)
}

/** Creates a profile directory with the bundled example configuration. */
function seedUser(name: string): void {
  const dir = userDir(name)
  const scriptsFolder = path.join(dir, 'scripts')
  fs.mkdirSync(scriptsFolder, { recursive: true })
  fs.mkdirSync(path.join(dir, 'rollbacks'), { recursive: true })

  if (!fs.existsSync(path.join(dir, 'settings.json'))) writeJson(path.join(dir, 'settings.json'), defaultSettings())
  if (!fs.existsSync(path.join(dir, 'redirect.json'))) {
    writeJson(path.join(dir, 'redirect.json'), readPreset<Record<string, string>>('redirect.json', {}))
  }

  const scriptsFile = path.join(dir, 'scripts.json')
  if (!fs.existsSync(scriptsFile)) {
    const presets = readPreset<Array<ScriptRecord & { content?: string }>>('scripts.json', [])
    const records: ScriptRecord[] = []
    for (const preset of presets) {
      const type: ScriptType = preset.type === 'batch' || preset.type === 'powershell' ? preset.type : 'other'
      const file = `${preset.id}${fileExtension(type)}`
      try {
        fs.writeFileSync(path.join(scriptsFolder, file), preset.content ?? '', 'utf8')
        const { content: _content, ...rest } = preset
        records.push({ ...rest, type, file })
      } catch {
        // a single unreadable example must not block profile creation
      }
    }
    writeJson(scriptsFile, records)
  }
}

/**
 * Creates the config tree on first run, seeds the active profile and migrates a
 * v0.1 flat layout. Only missing files are written, so user edits/deletions are
 * never resurrected on the next start.
 */
export function ensureLayout(): StorageLayout {
  const root = configDir()
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.mkdirSync(path.join(root, 'updates'), { recursive: true })
  migrateLegacyLayout()

  const user = getActiveUser()
  if (!fs.existsSync(userDir(user))) {
    seedUser(user)
  } else {
    const layout = getLayout()
    fs.mkdirSync(layout.files.scriptsDir, { recursive: true })
    fs.mkdirSync(layout.files.rollbacks, { recursive: true })
  }

  return getLayout()
}

export function defaultSettings(): AppSettings {
  return {
    autoSnapshotBeforeRun: true,
    autoSnapshotBeforeRestore: true,
    updateFeedUrl: ''
  }
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

/* -------------------------------------------------------------- scripts */

export function readScriptRecords(): ScriptRecord[] {
  return readJson<ScriptRecord[]>(getLayout().files.scripts, [])
}

export function writeScriptRecords(records: ScriptRecord[]): void {
  ensureLayout()
  writeJson(getLayout().files.scripts, records)
}

export function readScriptFile(file: string): string {
  try {
    return fs.readFileSync(path.join(scriptsDir(), file), 'utf8')
  } catch {
    return ''
  }
}

export function writeScriptFile(file: string, content: string): void {
  const dir = scriptsDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), content, 'utf8')
}

export function deleteScriptFile(file: string): void {
  try {
    fs.rmSync(path.join(scriptsDir(), file), { force: true })
  } catch {
    // ignore missing files
  }
}

/** Metadata + content, for the renderer. Entries whose file vanished are skipped. */
export function readScripts(): ScriptEntry[] {
  return readScriptRecords()
    .filter((record) => fs.existsSync(path.join(scriptsDir(), record.file)))
    .map((record) => ({ ...record, content: readScriptFile(record.file) }))
}

/** Used by config-package import: writes the files and merges the metadata. */
export function upsertScriptEntries(entries: ScriptEntry[]): void {
  ensureLayout()
  const records = readScriptRecords()
  const byId = new Map(records.map((record) => [record.id, record]))
  for (const entry of entries) {
    const file = entry.file && entry.file.length > 0 ? entry.file : `${entry.id}${extensionForType(entry.type)}`
    writeScriptFile(file, entry.content ?? '')
    byId.set(entry.id, {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      file,
      createdAt: entry.createdAt,
      lastRunAt: entry.lastRunAt,
      lastExitCode: entry.lastExitCode
    })
  }
  writeScriptRecords([...byId.values()])
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

/* ---------------------------------------------------------------- audit */

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
