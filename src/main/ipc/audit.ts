import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-types'
import { readAudit } from '../services/storage'

export function registerAuditHandlers(): void {
  ipcMain.handle(IPC.auditList, (_event, limit: unknown) => {
    const safeLimit = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 500) : 200
    return readAudit(safeLimit)
  })
}
