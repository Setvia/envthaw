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
  resizeSession,
  stopSession,
  writeInput
} from '../services/terminal-service'

const idSchema = z.string().min(3).max(80)
const titleSchema = z.string().min(1).max(40)
const inputSchema = z.string().max(16384)
const sizeSchema = z.number().int().min(2).max(1000)

export function registerTerminalHandlers(): void {
  ipcMain.handle(IPC.terminalList, () => listSessions())
  ipcMain.handle(IPC.terminalCreate, () => createSession())
  ipcMain.handle(IPC.terminalClose, (_event, id: unknown) => {
    closeSession(idSchema.parse(id))
  })
  ipcMain.handle(IPC.terminalRename, (_event, id: unknown, title: unknown) => {
    renameSession(idSchema.parse(id), titleSchema.parse(title))
  })
  ipcMain.handle(IPC.terminalWrite, (_event, id: unknown, data: unknown) => {
    writeInput(idSchema.parse(id), inputSchema.parse(data))
  })
  ipcMain.handle(IPC.terminalResize, (_event, id: unknown, cols: unknown, rows: unknown) => {
    resizeSession(idSchema.parse(id), sizeSchema.parse(cols), sizeSchema.parse(rows))
  })
  ipcMain.handle(IPC.terminalStop, (_event, id: unknown) => {
    stopSession(idSchema.parse(id))
  })
  ipcMain.handle(IPC.terminalClear, (_event, id: unknown) => {
    clearSession(idSchema.parse(id))
  })
  ipcMain.handle(IPC.terminalBuffer, (_event, id: unknown) => readBuffer(idSchema.parse(id)))
}
