import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-types'
import { audit } from '../services/env-service'
import { createUser, getActiveUser, listUsers, removeUser, setActiveUser } from '../services/storage'

const userNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[\w\u4e00-\u9fa5.-]+$/, '用户名只能包含字母、数字、中文、下划线和短横线')

export function registerUserHandlers(): void {
  ipcMain.handle(IPC.usersList, () => listUsers())

  ipcMain.handle(IPC.usersCurrent, () => getActiveUser())

  ipcMain.handle(IPC.usersCreate, (_event, name: unknown) => {
    const parsed = userNameSchema.parse(name)
    createUser(parsed)
    audit('user.create', parsed)
    return listUsers()
  })

  ipcMain.handle(IPC.usersRemove, (_event, name: unknown) => {
    const parsed = userNameSchema.parse(name)
    removeUser(parsed)
    audit('user.remove', parsed)
    return listUsers()
  })

  ipcMain.handle(IPC.usersSwitch, (_event, name: unknown) => {
    const parsed = userNameSchema.parse(name)
    setActiveUser(parsed)
    audit('user.switch', parsed)
    return listUsers()
  })
}
