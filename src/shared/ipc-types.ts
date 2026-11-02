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

export type ScriptType = 'batch' | 'powershell' | 'other'

export interface ScriptEntry {
  id: string
  name: string
  type: ScriptType
  /** File name inside <config>/<user>/scripts/ - scripts are always copies. */
  file: string
  content: string
  createdAt: number
  lastRunAt?: number
  lastExitCode?: number
}

export interface ScriptImportWarning {
  file: string
  reason: string
}

export interface ScriptImportResult {
  added: ScriptEntry[]
  warnings: ScriptImportWarning[]
}

/** Loaded from presets/script-templates.json - never hardcoded in the renderer. */
export interface ScriptTemplate {
  id: string
  name: string
  type: ScriptType
  content: string
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
  autoSnapshotBeforeRun: boolean
  autoSnapshotBeforeRestore: boolean
  /** https URL of the release manifest. Empty until the project site exists. */
  updateFeedUrl: string
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
  scriptsDir: string
  audit: string
  rollbacks: string
  updates: string
}

export interface UserProfile {
  name: string
  active: boolean
  dir: string
}

export interface AppInfo {
  appVersion: string
  electron: string
  node: string
  chrome: string
  platform: string
  osRelease: string
  /** Fixed: always <project>/config, never outside the project directory. */
  configDir: string
  /** Active user's directory: <config>/<user>. */
  userDir: string
  /** Currently active profile name; "default" is the temporary/not-signed-in one. */
  user: string
  /** Working data referenced by redirects (venvs, caches), always in-project. */
  dataDir: string
  /** Directory the bundled example configs are seeded from. */
  presetsDir: string
  dataFiles: DataFiles
  isElevated: boolean
  packaged: boolean
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

/* ------------------------------------------------------------------ update */

export interface UpdateRelease {
  version: string
  notes?: string
  url: string
  sha256?: string
  size?: number
  publishedAt?: number
}

export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateProgress {
  received: number
  total: number
}

export interface UpdateState {
  configured: boolean
  feedUrl: string
  currentVersion: string
  status: UpdateStatus
  release?: UpdateRelease
  progress?: UpdateProgress
  filePath?: string
  error?: string
  checkedAt?: number
}

export interface EnvThawApi {
  app: {
    info(): Promise<AppInfo>
    openConfigDir(): Promise<void>
    openDataDir(): Promise<void>
    chooseDirectory(defaultPath?: string): Promise<string | null>
  }
  files: {
    /** Absolute path of a dropped/picked File (webUtils.getPathForFile). */
    pathFor(file: File): string
  }
  users: {
    list(): Promise<UserProfile[]>
    current(): Promise<string>
    create(name: string): Promise<UserProfile[]>
    remove(name: string): Promise<UserProfile[]>
    switch(name: string): Promise<UserProfile[]>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    onMaximizedChange(callback: (maximized: boolean) => void): () => void
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
    templates(): Promise<ScriptTemplate[]>
    save(entry: {
      id: string
      name: string
      type: ScriptType
      content: string
      createdAt?: number
    }): Promise<ScriptEntry>
    remove(id: string): Promise<void>
    dryRun(id: string): Promise<DryRunReport>
    run(id: string): Promise<RunResult>
    openFolder(): Promise<void>
    /** Copies dropped/picked files into <user>/scripts/ (never references the original). */
    importFiles(paths: string[]): Promise<ScriptImportResult>
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
  update: {
    getState(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    openDownloadFolder(): Promise<void>
    onProgress(callback: (progress: UpdateProgress) => void): () => void
    onState(callback: (state: UpdateState) => void): () => void
  }
}

/** Channel names, grouped so a typo cannot silently create a dead channel. */
export const IPC = {
  appInfo: 'app:info',
  appOpenConfig: 'app:open-config',
  appOpenData: 'app:open-data',
  appChooseDirectory: 'app:choose-directory',
  usersList: 'users:list',
  usersCurrent: 'users:current',
  usersCreate: 'users:create',
  usersRemove: 'users:remove',
  usersSwitch: 'users:switch',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaximizedChanged: 'window:maximized-changed',
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
  scriptTemplates: 'script:templates',
  scriptSave: 'script:save',
  scriptRemove: 'script:remove',
  scriptDryRun: 'script:dry-run',
  scriptRun: 'script:run',
  scriptOpenFolder: 'script:open-folder',
  scriptImport: 'script:import',
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
  transferLoad: 'transfer:load',
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateOpenFolder: 'update:open-folder',
  updateProgress: 'update:progress',
  updateState: 'update:state'
} as const
