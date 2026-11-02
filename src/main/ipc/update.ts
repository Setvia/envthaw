import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-types'
import { checkForUpdates, downloadUpdate, getUpdateState, openDownloadFolder } from '../services/update-service'

export function registerUpdateHandlers(): void {
  ipcMain.handle(IPC.updateGet, () => getUpdateState())
  ipcMain.handle(IPC.updateCheck, () => checkForUpdates())
  ipcMain.handle(IPC.updateDownload, () => downloadUpdate())
  ipcMain.handle(IPC.updateOpenFolder, () => openDownloadFolder())
}
