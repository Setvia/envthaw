import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-types'
import {
  clearSession,
  closeSession,
  createSession,
  listSessions,
  readBuffer,
  renameSession,
  runCommand,
  stopSession
} from '../services/terminal-service'

const idSchema = z.string().min(3).max(80)
const commandSchema = z.string().min(1).max(8000)
const titleSchema = z.string().min(1).max(40)

export function registerTerminalHandlers(): void {
  ipcMain.handle(IPC.terminalList, () => listSessions())
  ipcMain.handle(IPC.terminalCreate, () => createSession())
  ipcMain.handle(IPC.terminalClose, (_event, id: unknown) => {
    closeSession(idSchema.parse(id))
  })
  ipcMain.handle(IPC.terminalRename, (_event, id: unknown, title: unknown) => {
    renameSession(idSchema.parse(id), titleSchema.parse(title))
  })
  ipcMain.handle(IPC.terminalRun, (_event, id: unknown, command: unknown) =>
    runCommand(idSchema.parse(id), commandSchema.parse(command))
  )
  ipcMain.handle(IPC.terminalStop, (_event, id: unknown) => {
    stopSession(idSchema.parse(id))
  })
  ipcMain.handle(IPC.terminalClear, (_event, id: unknown) => {
    clearSession(idSchema.parse(id))
  })
  ipcMain.handle(IPC.terminalBuffer, (_event, id: unknown) => readBuffer(idSchema.parse(id)))
}
