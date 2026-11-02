/**
 * EnvThaw IPC contract.
 *
 * This file is the single source of truth for every channel crossing the
 * renderer <-> main boundary. Both sides import it; nothing here may import
 * electron or node built-ins.
 */

export type EnvValueKind = 'String' | 'ExpandString' | 'Other'

export interface EnvVarEntry {
  name: string
  value: string
  kind: EnvValueKind
}

export interface EnvSnapshot {
  id: string
  name: string
  note?: string
  createdAt: number
  /** HKCU\Environment only. System (HKLM) variables are never captured. */
  userVars: Record<string, string>
}

export type DiffKind = 'added' | 'modified' | 'removed'

export interface DiffEntry {
  kind: DiffKind
  name: string
  before: string | null
  after: string | null
}

export interface ApplyFailure {
  name: string
  error: string
}

export interface ApplyResult {
  applied: number
  failed: ApplyFailure[]
  /** Id of the auto rollback point created before the change. */
  rollbackId: string | null
}

export type ScriptType = 'batch' | 'powershell'

export interface ScriptEntry {
  id: string
  name: string
  type: ScriptType
  content: string
  createdAt: number
  lastRunAt?: number
  lastExitCode?: number
}

export type DryRunKind = 'set' | 'delete' | 'mkdir' | 'registry' | 'other'

export interface DryRunChange {
  kind: DryRunKind
  target: string
  detail: string
  line: number
  raw: string
}

export interface DryRunReport {
  changes: DryRunChange[]
  warnings: string[]
}

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface RedirectConfig {
  pythonVenvHome: string
  pipCacheDir: string
  nodePrefix: string
  nodeCache: string
  gitConfigPath: string
  gitUserName: string
  gitUserEmail: string
}

export type RedirectKey = keyof RedirectConfig

export interface RedirectItem {
  key: RedirectKey
  envName: string
  label: string
  description: string
  value: string
  /** Environment variables that are not env-var based (e.g. gitconfig file content). */
  fileOnly?: boolean
}

export interface AppSettings {
  storageRoot: string
  autoSnapshotBeforeRun: boolean
  autoSnapshotBeforeRestore: boolean
}

export interface AuditEntry {
  id: string
  at: number
  action: string
  detail: string
  ok: boolean
}

export interface DataFiles {
  settings: string
  snapshots: string
  scripts: string
  audit: string
  rollbacks: string
}

export interface AppInfo {
  appVersion: string
  electron: string
  node: string
  chrome: string
  platform: string
  osRelease: string
  storageRoot: string
  dataFiles: DataFiles
  isElevated: boolean
}

export interface ExportBundle {
  kind: 'envthaw-config'
  version: 1
  exportedAt: number
  settings?: AppSettings
  redirect?: RedirectConfig
  snapshots?: EnvSnapshot[]
  scripts?: ScriptEntry[]
}

export interface ImportResult {
  snapshots: number
  scripts: number
}

export interface EnvThawApi {
  app: {
    info(): Promise<AppInfo>
    openStorage(): Promise<void>
    chooseDirectory(defaultPath?: string): Promise<string | null>
  }
  env: {
    list(): Promise<EnvVarEntry[]>
    set(name: string, value: string): Promise<void>
    remove(name: string): Promise<void>
    snapshots(): Promise<EnvSnapshot[]>
    saveSnapshot(name: string, note?: string): Promise<EnvSnapshot>
    deleteSnapshot(id: string): Promise<void>
    diff(snapshotId: string): Promise<DiffEntry[]>
    apply(snapshotId: string): Promise<ApplyResult>
    rollback(rollbackId: string): Promise<ApplyResult>
  }
  scripts: {
    list(): Promise<ScriptEntry[]>
    save(entry: Omit<ScriptEntry, 'createdAt' | 'lastRunAt' | 'lastExitCode'> & { createdAt?: number }): Promise<ScriptEntry>
    remove(id: string): Promise<void>
    dryRun(id: string): Promise<DryRunReport>
    run(id: string): Promise<RunResult>
  }
  redirect: {
    get(): Promise<RedirectConfig>
    items(): Promise<RedirectItem[]>
    preview(config: RedirectConfig): Promise<DiffEntry[]>
    apply(config: RedirectConfig): Promise<ApplyResult>
  }
  settings: {
    get(): Promise<AppSettings>
    save(settings: AppSettings): Promise<AppSettings>
  }
  audit: {
    list(limit?: number): Promise<AuditEntry[]>
  }
  transfer: {
    exportBundle(): Promise<ExportBundle>
    importBundle(bundle: ExportBundle): Promise<ImportResult>
    saveBundleToDisk(): Promise<string | null>
    loadBundleFromDisk(): Promise<ExportBundle | null>
  }
}

/** Channel names, grouped so a typo cannot silently create a dead channel. */
export const IPC = {
  appInfo: 'app:info',
  appOpenStorage: 'app:open-storage',
  appChooseDirectory: 'app:choose-directory',
  envList: 'env:list',
  envSet: 'env:set',
  envRemove: 'env:remove',
  envSnapshots: 'env:snapshots',
  envSaveSnapshot: 'env:save-snapshot',
  envDeleteSnapshot: 'env:delete-snapshot',
  envDiff: 'env:diff',
  envApply: 'env:apply',
  envRollback: 'env:rollback',
  scriptList: 'script:list',
  scriptSave: 'script:save',
  scriptRemove: 'script:remove',
  scriptDryRun: 'script:dry-run',
  scriptRun: 'script:run',
  redirectGet: 'redirect:get',
  redirectItems: 'redirect:items',
  redirectPreview: 'redirect:preview',
  redirectApply: 'redirect:apply',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  auditList: 'audit:list',
  transferExport: 'transfer:export',
  transferImport: 'transfer:import',
  transferSave: 'transfer:save',
  transferLoad: 'transfer:load'
} as const
