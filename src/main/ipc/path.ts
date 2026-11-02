import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-types'
import { redirectConfigSchema } from '../../shared/config-schema'
import { applyRedirect, describeItems, getRedirectConfig, previewRedirect, saveRedirectConfig } from '../services/path-redirect'

export function registerPathHandlers(): void {
  ipcMain.handle(IPC.redirectGet, () => getRedirectConfig())

  ipcMain.handle(IPC.redirectItems, () => describeItems(getRedirectConfig()))

  ipcMain.handle(IPC.redirectPreview, (_event, config: unknown) => {
    const parsed = redirectConfigSchema.parse(config)
    return previewRedirect(parsed)
  })

  ipcMain.handle(IPC.redirectApply, (_event, config: unknown) => {
    const parsed = redirectConfigSchema.parse(config)
    saveRedirectConfig(parsed)
    return applyRedirect(parsed)
  })
}
