import { app, dialog, ipcMain, shell } from 'electron'
import os from 'node:os'
import { IPC, type AppInfo } from '../../shared/ipc-types'
import { appSettingsSchema } from '../../shared/config-schema'
import { runPowerShell } from '../utils/powershell'
import { ensureLayout, readSettings, writeSettings } from '../services/storage'
import { configDir, dataDir, presetsDir } from '../services/paths'
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
      configDir: configDir(),
      userDir: layout.userRoot,
      user: layout.user,
      dataDir: dataDir(),
      presetsDir: presetsDir(),
      dataFiles: layout.files,
      isElevated: await isElevated(),
      packaged: app.isPackaged
    }
  })

  ipcMain.handle(IPC.appOpenConfig, async () => {
    await shell.openPath(ensureLayout().root)
  })

  ipcMain.handle(IPC.appOpenData, async () => {
    await shell.openPath(ensureLayout().dataDir)
  })

  ipcMain.handle(IPC.appChooseDirectory, async (_event, defaultPath: unknown) => {
    const result = await dialog.showOpenDialog({
      title: '选择目录',
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : dataDir(),
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
    const saved = writeSettings(parsed)
    audit('settings.save', `更新源 ${saved.updateFeedUrl || '（未配置）'}`)
    return saved
  })
}
