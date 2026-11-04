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

/* ------------------------------------------------------------------ terminal */

export interface TerminalSessionInfo {
  id: string
  title: string
  cwd: string
  running: boolean
  createdAt: number
}

export interface TerminalDataEvent {
  id: string
  chunk: string
}

export interface TerminalExitEvent {
  id: string
  code: number | null
  durationMs: number
  timedOut: boolean
}

export interface TerminalCwdEvent {
  id: string
  cwd: string
}

/* ------------------------------------------------------------------ cloud */

export interface CloudConflictKey {
  key: string
  base?: string
  local?: string
  remote?: string
}

export interface CloudConflict {
  id: string
  clientRef: string
  snapshotName: string
  serverVersion: number
  localHash: string
  remoteBlobId: string | null
  keys: CloudConflictKey[]
}

export interface CloudStatus {
  serverUrl: string
  signedIn: boolean
  email?: string
  deviceId?: string
  pending: number
  conflicts: CloudConflict[]
  lastSyncAt?: number
}

export interface CloudLoginStart {
  expiresIn: number
  /** Present only while the backend runs with DEV_MODE=1. */
  devCode?: string
}

export interface CloudSyncReport {
  pushed: number
  pulled: number
  conflicts: number
  cursor: number
  at: number
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
  cloud: {
    status(): Promise<CloudStatus>
    setServer(url: string): Promise<CloudStatus>
    loginStart(email: string): Promise<CloudLoginStart>
    loginVerify(email: string, code: string): Promise<CloudStatus>
    logout(): Promise<CloudStatus>
    syncNow(): Promise<CloudSyncReport>
    resolveConflict(id: string, choice: 'local' | 'remote'): Promise<CloudSyncReport>
  }
  terminal: {
    list(): Promise<TerminalSessionInfo[]>
    create(): Promise<TerminalSessionInfo>
    close(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    run(id: string, command: string): Promise<void>
    stop(id: string): Promise<void>
    clear(id: string): Promise<void>
    buffer(id: string): Promise<string>
    onData(callback: (event: TerminalDataEvent) => void): () => void
    onExit(callback: (event: TerminalExitEvent) => void): () => void
    onCwd(callback: (event: TerminalCwdEvent) => void): () => void
    onCleared(callback: (event: { id: string }) => void): () => void
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
  updateState: 'update:state',
  cloudStatus: 'cloud:status',
  cloudSetServer: 'cloud:set-server',
  cloudLoginStart: 'cloud:login-start',
  cloudLoginVerify: 'cloud:login-verify',
  cloudLogout: 'cloud:logout',
  cloudSync: 'cloud:sync',
  cloudResolve: 'cloud:resolve-conflict',
  terminalList: 'terminal:list',
  terminalCreate: 'terminal:create',
  terminalClose: 'terminal:close',
  terminalRename: 'terminal:rename',
  terminalRun: 'terminal:run',
  terminalStop: 'terminal:stop',
  terminalClear: 'terminal:clear',
  terminalBuffer: 'terminal:buffer',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  terminalCwd: 'terminal:cwd',
  terminalCleared: 'terminal:cleared'
} as const
