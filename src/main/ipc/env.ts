import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-types'
import { envNameSchema, envValueSchema, rollbackIdSchema, snapshotIdSchema } from '../../shared/config-schema'
import {
  applySnapshot,
  deleteSnapshot,
  diffSnapshot,
  listEnv,
  listSnapshots,
  removeEnv,
  rollbackTo,
  saveSnapshot,
  setEnv
} from '../services/env-service'

export function registerEnvHandlers(): void {
  ipcMain.handle(IPC.envList, () => listEnv())

  ipcMain.handle(IPC.envSet, async (_event, name: unknown, value: unknown) => {
    await setEnv(envNameSchema.parse(name), envValueSchema.parse(value))
  })

  ipcMain.handle(IPC.envRemove, async (_event, name: unknown) => {
    await removeEnv(envNameSchema.parse(name))
  })

  ipcMain.handle(IPC.envSnapshots, () => listSnapshots())

  ipcMain.handle(IPC.envSaveSnapshot, async (_event, name: unknown, note: unknown) => {
    const safeName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : '未命名快照'
    const safeNote = typeof note === 'string' ? note.slice(0, 500) : undefined
    return saveSnapshot(safeName, safeNote)
  })

  ipcMain.handle(IPC.envDeleteSnapshot, (_event, id: unknown) => {
    deleteSnapshot(snapshotIdSchema.parse(id))
  })

  ipcMain.handle(IPC.envDiff, (_event, id: unknown) => diffSnapshot(snapshotIdSchema.parse(id)))

  ipcMain.handle(IPC.envApply, (_event, id: unknown) => applySnapshot(snapshotIdSchema.parse(id)))

  ipcMain.handle(IPC.envRollback, (_event, id: unknown) => rollbackTo(rollbackIdSchema.parse(id)))
}
