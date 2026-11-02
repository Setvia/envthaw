import { BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC, type ExportBundle, type ImportResult } from '../../shared/ipc-types'
import { exportBundleSchema } from '../../shared/config-schema'
import { audit } from '../services/env-service'
import { getRedirectConfig, saveRedirectConfig } from '../services/path-redirect'
import {
  ensureLayout,
  readScripts,
  readSettings,
  readSnapshots,
  writeScripts,
  writeSettings,
  writeSnapshots
} from '../services/storage'

function buildBundle(): ExportBundle {
  return {
    kind: 'envthaw-config',
    version: 1,
    exportedAt: Date.now(),
    settings: readSettings(),
    redirect: getRedirectConfig(),
    snapshots: readSnapshots(),
    scripts: readScripts()
  }
}

function mergeById<T extends { id: string }>(stored: T[], incoming: T[]): T[] {
  const map = new Map(stored.map((item) => [item.id, item]))
  for (const item of incoming) map.set(item.id, item)
  return [...map.values()]
}

function importBundle(raw: unknown): ImportResult {
  const bundle = exportBundleSchema.parse(raw)

  if (bundle.settings) {
    writeSettings({ ...readSettings(), ...bundle.settings, storageRoot: readSettings().storageRoot })
  }
  if (bundle.redirect) {
    saveRedirectConfig(bundle.redirect)
  }

  const snapshots = bundle.snapshots ? mergeById(readSnapshots(), bundle.snapshots) : readSnapshots()
  const scripts = bundle.scripts ? mergeById(readScripts(), bundle.scripts) : readScripts()
  writeSnapshots(snapshots)
  writeScripts(scripts)

  audit('transfer.import', `快照 ${bundle.snapshots?.length ?? 0} 个，脚本 ${bundle.scripts?.length ?? 0} 个`)
  return { snapshots: bundle.snapshots?.length ?? 0, scripts: bundle.scripts?.length ?? 0 }
}

function parentWindow(sender: Electron.WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? undefined
}

export function registerTransferHandlers(): void {
  ipcMain.handle(IPC.transferExport, () => buildBundle())

  ipcMain.handle(IPC.transferImport, (_event, raw: unknown) => importBundle(raw))

  ipcMain.handle(IPC.transferSave, async (event) => {
    const win = parentWindow(event.sender)
    const defaultName = `envthaw-${new Date().toISOString().slice(0, 10)}.json`
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: '导出配置包',
          defaultPath: path.join(ensureLayout().root, defaultName),
          filters: [{ name: 'EnvThaw 配置包', extensions: ['json'] }]
        })
      : await dialog.showSaveDialog({ title: '导出配置包', defaultPath: defaultName })

    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, JSON.stringify(buildBundle(), null, 2), 'utf8')
    audit('transfer.export', result.filePath)
    return result.filePath
  })

  ipcMain.handle(IPC.transferLoad, async (event) => {
    const win = parentWindow(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '导入配置包',
      properties: ['openFile'],
      filters: [{ name: 'EnvThaw 配置包', extensions: ['json'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null

    const raw = fs.readFileSync(result.filePaths[0], 'utf8')
    return exportBundleSchema.parse(JSON.parse(raw))
  })
}
