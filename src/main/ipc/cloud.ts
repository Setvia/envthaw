import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-types'
import {
  cloudStatus,
  loginStart,
  loginVerify,
  logout,
  resolveConflict,
  setServer,
  syncNow
} from '../services/cloud/service'

const emailSchema = z.string().trim().min(3).max(254)
const codeSchema = z.string().regex(/^\d{6}$/, '验证码是 6 位数字')
const serverSchema = z.string().trim().min(8).max(300)
const conflictIdSchema = z.string().min(1).max(200)

export function registerCloudHandlers(): void {
  ipcMain.handle(IPC.cloudStatus, () => cloudStatus())
  ipcMain.handle(IPC.cloudSetServer, (_event, url: unknown) => setServer(serverSchema.parse(url)))
  ipcMain.handle(IPC.cloudLoginStart, (_event, email: unknown) => loginStart(emailSchema.parse(email)))
  ipcMain.handle(IPC.cloudLoginVerify, (_event, email: unknown, code: unknown) =>
    loginVerify(emailSchema.parse(email), codeSchema.parse(code))
  )
  ipcMain.handle(IPC.cloudLogout, () => logout())
  ipcMain.handle(IPC.cloudSync, () => syncNow())
  ipcMain.handle(IPC.cloudResolve, (_event, id: unknown, choice: unknown) =>
    resolveConflict(conflictIdSchema.parse(id), z.enum(['local', 'remote']).parse(choice))
  )
}
