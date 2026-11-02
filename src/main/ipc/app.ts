import { app, dialog, ipcMain, shell } from 'electron'
import os from 'node:os'
import { IPC, type AppInfo } from '../../shared/ipc-types'
import { appSettingsSchema } from '../../shared/config-schema'
import { runPowerShell } from '../utils/powershell'
import { ensureLayout, getLayout, readSettings, setStorageRoot, writeSettings } from '../services/storage'
import { audit } from '../services/env-service'

let elevated: boolean | null = null

async function isElevated(): Promise<boolean> {
  if (elevated !== null) return elevated
  if (process.platform !== 'win32') {
    elevated = false
    return elevated
  }
  try {
    const out = await runPowerShell(
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $id=[Security.Principal.WindowsIdentity]::GetCurrent(); (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    )
    elevated = out.trim().toLowerCase() === 'true'
  } catch {
    elevated = false
  }
  return elevated
}

export function registerAppHandlers(): void {
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => {
    const layout = ensureLayout()
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
      osRelease: os.release(),
      storageRoot: layout.root,
      dataFiles: layout.files,
      isElevated: await isElevated()
    }
  })

  ipcMain.handle(IPC.appOpenStorage, async () => {
    const layout = ensureLayout()
    await shell.openPath(layout.root)
  })

  ipcMain.handle(IPC.appChooseDirectory, async (_event, defaultPath: unknown) => {
    const result = await dialog.showOpenDialog({
      title: '选择存储目录',
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : getLayout().root,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.settingsGet, () => readSettings())

  ipcMain.handle(IPC.settingsSave, (_event, input: unknown) => {
    const parsed = appSettingsSchema.parse(input)
    const current = readSettings()

    if (parsed.storageRoot && parsed.storageRoot !== current.storageRoot) {
      setStorageRoot(parsed.storageRoot)
      ensureLayout()
      audit('settings.storage', `存储目录切换到 ${parsed.storageRoot}`)
    }

    return writeSettings(parsed)
  })
}
