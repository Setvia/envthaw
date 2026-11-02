import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-types'
import { scriptIdSchema, scriptSaveSchema } from '../../shared/config-schema'
import { deleteScript, dryRun, importScripts, runScript, saveScript } from '../services/script-runner'
import { ensureLayout, readScriptTemplates, readScripts, scriptsDir } from '../services/storage'

const importPathsSchema = z.array(z.string().min(1).max(1024)).min(1).max(50)

export function registerScriptHandlers(): void {
  ipcMain.handle(IPC.scriptList, () => readScripts().sort((a, b) => b.createdAt - a.createdAt))

  // Templates live in presets/script-templates.json, not in the renderer bundle.
  ipcMain.handle(IPC.scriptTemplates, () => readScriptTemplates())

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

  ipcMain.handle(IPC.scriptOpenFolder, async () => {
    ensureLayout()
    await shell.openPath(scriptsDir())
  })

  ipcMain.handle(IPC.scriptImport, (_event, paths: unknown) => {
    return importScripts(importPathsSchema.parse(paths))
  })
}
