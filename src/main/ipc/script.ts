import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-types'
import { scriptIdSchema, scriptSaveSchema } from '../../shared/config-schema'
import { deleteScript, dryRun, runScript, saveScript } from '../services/script-runner'
import { readScripts } from '../services/storage'

export function registerScriptHandlers(): void {
  ipcMain.handle(IPC.scriptList, () => readScripts().sort((a, b) => b.createdAt - a.createdAt))

  ipcMain.handle(IPC.scriptSave, (_event, input: unknown) => {
    const parsed = scriptSaveSchema.parse(input)
    return saveScript(parsed)
  })

  ipcMain.handle(IPC.scriptRemove, (_event, id: unknown) => {
    deleteScript(scriptIdSchema.parse(id))
  })

  ipcMain.handle(IPC.scriptDryRun, (_event, id: unknown) => {
    const script = readScripts().find((item) => item.id === scriptIdSchema.parse(id))
    if (!script) throw new Error('脚本不存在')
    return dryRun(script.content, script.type)
  })

  ipcMain.handle(IPC.scriptRun, (_event, id: unknown) => {
    const script = readScripts().find((item) => item.id === scriptIdSchema.parse(id))
    if (!script) throw new Error('脚本不存在')
    return runScript(script)
  })
}
