import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type EnvThawApi, type RedirectConfig } from '../shared/ipc-types'

/**
 * The only bridge between the sandboxed renderer and the main process.
 * No business logic here - every call is a typed, validated IPC round-trip.
 */
const api: EnvThawApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openStorage: () => ipcRenderer.invoke(IPC.appOpenStorage),
    chooseDirectory: (defaultPath) => ipcRenderer.invoke(IPC.appChooseDirectory, defaultPath)
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
    save: (entry) => ipcRenderer.invoke(IPC.scriptSave, entry),
    remove: (id) => ipcRenderer.invoke(IPC.scriptRemove, id),
    dryRun: (id) => ipcRenderer.invoke(IPC.scriptDryRun, id),
    run: (id) => ipcRenderer.invoke(IPC.scriptRun, id)
  },
  redirect: {
    get: () => ipcRenderer.invoke(IPC.redirectGet),
    items: () => ipcRenderer.invoke(IPC.redirectItems),
    preview: (config: RedirectConfig) => ipcRenderer.invoke(IPC.redirectPreview, config),
    apply: (config: RedirectConfig) => ipcRenderer.invoke(IPC.redirectApply, config)
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
  }
}

contextBridge.exposeInMainWorld('envthaw', api)
