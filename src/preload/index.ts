import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type EnvThawApi, type UpdateProgress, type UpdateState } from '../shared/ipc-types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * The only bridge between the sandboxed renderer and the main process.
 * No business logic here - every call is a typed, validated IPC round-trip.
 */
const api: EnvThawApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openConfigDir: () => ipcRenderer.invoke(IPC.appOpenConfig),
    openDataDir: () => ipcRenderer.invoke(IPC.appOpenData),
    chooseDirectory: (defaultPath) => ipcRenderer.invoke(IPC.appChooseDirectory, defaultPath)
  },
  files: {
    // Electron 32+ removed File.path; this is the supported replacement.
    pathFor: (file) => webUtils.getPathForFile(file)
  },
  users: {
    list: () => ipcRenderer.invoke(IPC.usersList),
    current: () => ipcRenderer.invoke(IPC.usersCurrent),
    create: (name) => ipcRenderer.invoke(IPC.usersCreate, name),
    remove: (name) => ipcRenderer.invoke(IPC.usersRemove, name),
    switch: (name) => ipcRenderer.invoke(IPC.usersSwitch, name)
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
    onMaximizedChange: (callback) => subscribe<boolean>(IPC.windowMaximizedChanged, callback)
  },
  env: {
    list: () => ipcRenderer.invoke(IPC.envList),
    set: (name, value) => ipcRenderer.invoke(IPC.envSet, name, value),
    remove: (name) => ipcRenderer.invoke(IPC.envRemove, name),
    snapshots: () => ipcRenderer.invoke(IPC.envSnapshots),
    saveSnapshot: (name, note) => ipcRenderer.invoke(IPC.envSaveSnapshot, name, note),
    deleteSnapshot: (id) => ipcRenderer.invoke(IPC.envDeleteSnapshot, id),
    diff: (id) => ipcRenderer.invoke(IPC.envDiff, id),
    apply: (id) => ipcRenderer.invoke(IPC.envApply, id),
    rollback: (id) => ipcRenderer.invoke(IPC.envRollback, id)
  },
  scripts: {
    list: () => ipcRenderer.invoke(IPC.scriptList),
    templates: () => ipcRenderer.invoke(IPC.scriptTemplates),
    save: (entry) => ipcRenderer.invoke(IPC.scriptSave, entry),
    remove: (id) => ipcRenderer.invoke(IPC.scriptRemove, id),
    dryRun: (id) => ipcRenderer.invoke(IPC.scriptDryRun, id),
    run: (id) => ipcRenderer.invoke(IPC.scriptRun, id),
    openFolder: () => ipcRenderer.invoke(IPC.scriptOpenFolder),
    importFiles: (paths) => ipcRenderer.invoke(IPC.scriptImport, paths)
  },
  redirect: {
    get: () => ipcRenderer.invoke(IPC.redirectGet),
    items: () => ipcRenderer.invoke(IPC.redirectItems),
    preview: (config) => ipcRenderer.invoke(IPC.redirectPreview, config),
    apply: (config) => ipcRenderer.invoke(IPC.redirectApply, config)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    save: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings)
  },
  audit: {
    list: (limit) => ipcRenderer.invoke(IPC.auditList, limit)
  },
  transfer: {
    exportBundle: () => ipcRenderer.invoke(IPC.transferExport),
    importBundle: (bundle) => ipcRenderer.invoke(IPC.transferImport, bundle),
    saveBundleToDisk: () => ipcRenderer.invoke(IPC.transferSave),
    loadBundleFromDisk: () => ipcRenderer.invoke(IPC.transferLoad)
  },
  update: {
    getState: () => ipcRenderer.invoke(IPC.updateGet),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    openDownloadFolder: () => ipcRenderer.invoke(IPC.updateOpenFolder),
    onProgress: (callback) => subscribe<UpdateProgress>(IPC.updateProgress, callback),
    onState: (callback) => subscribe<UpdateState>(IPC.updateState, callback)
  }
}

contextBridge.exposeInMainWorld('envthaw', api)
