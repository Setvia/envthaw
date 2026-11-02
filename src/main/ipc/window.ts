import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-types'

/**
 * Frameless window controls. The renderer draws its own title bar (see
 * components/TitleBar.tsx), so dragging/clicking is delegated through IPC.
 */
export function registerWindowHandlers(): void {
  ipcMain.handle(IPC.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle(IPC.windowToggleMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  ipcMain.handle(IPC.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle(IPC.windowIsMaximized, (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
}

export function wireWindowState(window: BrowserWindow): void {
  const notify = (): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC.windowMaximizedChanged, window.isMaximized())
  }
  window.on('maximize', notify)
  window.on('unmaximize', notify)
  window.on('enter-full-screen', notify)
  window.on('leave-full-screen', notify)
}
