import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-types'
import {
  clearSession,
  closeInput,
  closeSession,
  createSession,
  listSessions,
  readBuffer,
  renameSession,
  runCommand,
  stopSession,
  writeInput
} from '../services/terminal-service'

const idSchema = z.string().min(3).max(80)
const commandSchema = z.string().min(1).max(8000)
const titleSchema = z.string().min(1).max(40)
const inputSchema = z.string().max(4096)

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
  ipcMain.handle(IPC.terminalWrite, (_event, id: unknown, data: unknown) => {
    writeInput(idSchema.parse(id), inputSchema.parse(data))
  })
  ipcMain.handle(IPC.terminalCloseInput, (_event, id: unknown) => {
    closeInput(idSchema.parse(id))
  })
  ipcMain.handle(IPC.terminalClear, (_event, id: unknown) => {
    clearSession(idSchema.parse(id))
  })
  ipcMain.handle(IPC.terminalBuffer, (_event, id: unknown) => readBuffer(idSchema.parse(id)))
}
