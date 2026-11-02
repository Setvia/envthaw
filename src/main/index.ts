import { app, BrowserWindow, Menu } from 'electron'
import path from 'node:path'
import { registerAppHandlers, registerSettingsHandlers } from './ipc/app'
import { registerAuditHandlers } from './ipc/audit'
import { registerEnvHandlers } from './ipc/env'
import { registerPathHandlers } from './ipc/path'
import { registerScriptHandlers } from './ipc/script'
import { registerTransferHandlers } from './ipc/transfer'
import { registerUpdateHandlers } from './ipc/update'
import { registerUserHandlers } from './ipc/users'
import { registerWindowHandlers, wireWindowState } from './ipc/window'

// Chromium's profile lives under %APPDATA% by default, which is exactly the disk
// this tool exists to avoid - and on locked-down machines it may not even be
// creatable. Dev runs keep it inside the project so a reboot/restore cannot
// corrupt the working copy.
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getAppPath(), '.electron-profile'))
}

// Opt-in DevTools protocol endpoint, used by scripts/smoke.mjs.
if (process.env.ENVTHAW_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.ENVTHAW_DEBUG_PORT)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1024,
    minHeight: 660,
    show: false,
    // The window chrome is drawn by the renderer (components/TitleBar.tsx), the
    // same way the DSH desktop app does it.
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    backgroundColor: '#f4f6fb',
    title: 'EnvThaw · 环境管理器',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  window.once('ready-to-show', () => window.show())
  window.setMenuBarVisibility(false)
  wireWindowState(window)

  // The renderer is a pure web app; it must never navigate away or open windows.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (!devServer || !url.startsWith(devServer)) {
      event.preventDefault()
    }
  })

  // Keep a way into DevTools even though the menu is hidden.
  window.webContents.on('before-input-event', (_event, input) => {
    const isToggle = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (isToggle && input.type === 'keyDown') {
      window.webContents.toggleDevTools()
    }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)

  registerAppHandlers()
  registerSettingsHandlers()
  registerUserHandlers()
  registerEnvHandlers()
  registerScriptHandlers()
  registerPathHandlers()
  registerTransferHandlers()
  registerAuditHandlers()
  registerWindowHandlers()
  registerUpdateHandlers()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (error) => {
  console.error('[EnvThaw] uncaught exception:', error)
})
