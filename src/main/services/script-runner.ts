import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type {
  DryRunChange,
  DryRunReport,
  RunResult,
  ScriptEntry,
  ScriptImportResult,
  ScriptImportWarning,
  ScriptType
} from '../../shared/ipc-types'
import { mergeEnv, readMachinePath, readUserEnv, toEnvRecord } from '../utils/registry'
import { audit } from './env-service'
import { consoleEncoding, createDecoder, decodeText } from '../utils/encoding'
import {
  deleteScriptFile,
  ensureLayout,
  extensionForType,
  newId,
  readScriptFile,
  readScriptRecords,
  readScripts,
  readSettings,
  scriptsDir,
  writeScriptFile,
  writeScriptRecords
} from './storage'
import { saveSnapshot } from './env-service'

const RUN_TIMEOUT_MS = 180_000
const MAX_IMPORT_BYTES = 5 * 1024 * 1024

/** Extensions that can actually be executed by the runner. */
const SCRIPT_EXTENSIONS: Record<string, ScriptType> = {
  '.bat': 'batch',
  '.cmd': 'batch',
  '.ps1': 'powershell'
}

function typeForFileName(fileName: string): ScriptType {
  return SCRIPT_EXTENSIONS[path.extname(fileName).toLowerCase()] ?? 'other'
}

interface Line {
  number: number
  text: string
}

function toLines(content: string): Line[] {
  return content
    .split(/\r?\n/)
    .map((text, index) => ({ number: index + 1, text }))
    .filter((line) => line.text.trim() !== '')
}

function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function stripComment(raw: string, type: ScriptType): string {
  const marker = type === 'batch' ? '::' : '#'
  const index = raw.indexOf(marker)
  return index >= 0 ? raw.slice(0, index) : raw
}

/** Static analysis of the write operations a script would perform. Never executes anything. */
export function dryRun(content: string, type: ScriptType): DryRunReport {
  if (type === 'other') {
    return {
      changes: [],
      warnings: ['这不是可执行的脚本文件（仅支持 .bat / .cmd / .ps1），无法分析写操作，也不能执行。']
    }
  }

  const changes: DryRunChange[] = []
  const warnings: string[] = []
  const lines = toLines(content)

  for (const line of lines) {
    const raw = line.text
    const code = stripComment(raw, type).trim()
    if (!code) continue

    if (type === 'batch') {
      let match = /^@?set\s+([^=\s][^=]*)=(.*)$/i.exec(code)
      if (match) {
        changes.push({
          kind: 'set',
          target: match[1].trim(),
          detail: `${match[1].trim()} = ${unquote(match[2])}`,
          line: line.number,
          raw
        })
        continue
      }
      match = /^@?setx\s+(\S+)\s+(.*)$/i.exec(code)
      if (match) {
        changes.push({
          kind: 'set',
          target: match[1],
          detail: `${match[1]} = ${unquote(match[2])}（永久写入用户变量）`,
          line: line.number,
          raw
        })
        continue
      }
      match = /^@?reg\s+add\s+("([^"]+)"|\S+)(.*)$/i.exec(code)
      if (match) {
        const key = match[2] ?? match[1]
        const valueName = /\/v\s+("[^"]+"|\S+)/i.exec(match[3])?.[1] ?? ''
        const data = /\/d\s+("[^"]*"|\S+)/i.exec(match[3])?.[1] ?? ''
        changes.push({
          kind: 'registry',
          target: key,
          detail: `${key} ${unquote(valueName)} = ${unquote(data)}`,
          line: line.number,
          raw
        })
        if (/hklm/i.test(key)) warnings.push(`第 ${line.number} 行修改系统级注册表（HKLM），需要管理员权限`)
        continue
      }
      match = /^@?(mkdir|md)\s+(.+)$/i.exec(code)
      if (match) {
        changes.push({ kind: 'mkdir', target: unquote(match[2]), detail: `创建目录 ${unquote(match[2])}`, line: line.number, raw })
        continue
      }
      if (/^@?(reg\s+delete|rd\s|rmdir\s|del\s|format\s|diskpart)/i.test(code)) {
        warnings.push(`第 ${line.number} 行包含删除类操作：${code.slice(0, 60)}`)
      }
      continue
    }

    let match = /^\$env:([A-Za-z_][\w]*)\s*=\s*(.+)$/i.exec(code)
    if (match) {
      changes.push({ kind: 'set', target: match[1], detail: `${match[1]} = ${unquote(match[2])}（仅当前会话）`, line: line.number, raw })
      continue
    }
    match = /\[(?:System\.)?Environment\]::SetEnvironmentVariable\(\s*['"]([^'"]+)['"]\s*,\s*(.+?)\s*,\s*['"]User['"]\s*\)/i.exec(code)
    if (match) {
      const value = unquote(match[2].replace(/^\$null$/i, ''))
      changes.push({
        kind: value ? 'set' : 'delete',
        target: match[1],
        detail: value ? `${match[1]} = ${value}（永久写入用户变量）` : `删除用户变量 ${match[1]}`,
        line: line.number,
        raw
      })
      continue
    }
    match = /^new-item\b.*-itemtype\s+directory.*$/i.exec(code)
    if (match) {
      const target = /-path\s+("[^"]+"|'[^']+'|\S+)/i.exec(code)?.[1] ?? ''
      changes.push({ kind: 'mkdir', target: unquote(target), detail: `创建目录 ${unquote(target)}`, line: line.number, raw })
      continue
    }
    match = /set-itemproperty\b.*-path\s+['"]HKCU:\\Environment['"].*-name\s+(\S+).*-value\s+(.+)$/i.exec(code)
    if (match) {
      changes.push({ kind: 'registry', target: 'HKCU:\\Environment', detail: `${match[1]} = ${unquote(match[2])}`, line: line.number, raw })
      continue
    }
    if (/remove-itemproperty|remove-item\b.*environment/i.test(code)) {
      changes.push({ kind: 'delete', target: 'HKCU:\\Environment', detail: code.slice(0, 80), line: line.number, raw })
      continue
    }
    if (/^(remove-item|rm|del|rd|rmdir|format|stop-process|set-executionpolicy)/i.test(code)) {
      warnings.push(`第 ${line.number} 行包含高风险操作：${code.slice(0, 60)}`)
    }
  }

  if (changes.length === 0 && warnings.length === 0) {
    warnings.push('未能从脚本中识别出写操作；执行前请确认脚本内容。')
  }

  return { changes, warnings }
}

function scriptExtension(type: ScriptType): string {
  return type === 'batch' ? '.cmd' : '.ps1'
}

function writeTempScript(script: ScriptEntry): string {
  const layout = ensureLayout()
  const dir = path.join(layout.root, 'tmp')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${script.id}-${Date.now()}${scriptExtension(script.type)}`)
  if (script.type === 'batch') {
    // cmd reads a .bat using the current code page; switching to UTF-8 first keeps
    // Chinese in the file readable and matches how we decode the output.
    fs.writeFileSync(file, `@chcp 65001 >nul\r\n${script.content}\r\n`, 'utf8')
    return file
  }
  // PowerShell 5.1 decodes .ps1 without BOM as ANSI, so Chinese content needs the BOM.
  fs.writeFileSync(file, `\uFEFF${script.content}\r\n`, 'utf8')
  return file
}

export async function shellEnv(): Promise<NodeJS.ProcessEnv> {
  // Expanded values only: an unexpanded Path (%SystemRoot%\...) cannot be used to
  // resolve powershell.exe and children would fail with ENOENT.
  const userEnv = toEnvRecord(await readUserEnv(true))
  const merged = mergeEnv(process.env, userEnv)

  // Rebuild the effective PATH the way Windows does: machine entries first.
  const machinePath = await readMachinePath()
  const userPath = userEnv.Path ?? userEnv.PATH ?? ''
  if (machinePath || userPath) {
    merged.Path = [machinePath, userPath].filter(Boolean).join(';')
    delete merged.PATH
  }
  return merged
}

function spawnAndCollect(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  encoding: string
): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    // Scripts are non-interactive: give them no stdin so a `pause` inside a .bat
    // sees EOF and returns instead of blocking until the timeout.
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      cwd: process.env.USERPROFILE,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // cmd.exe speaks the console code page (GBK on zh-CN); our PowerShell wrapper
    // forces UTF-8. Decode per source instead of assuming one encoding.
    const outDecoder = createDecoder(encoding)
    const errDecoder = createDecoder(encoding)
    const stdout: string[] = []
    const stderr: string[] = []
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      // Kill the whole tree: a script may have spawned long-running children.
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
    }, RUN_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => stdout.push(outDecoder.push(chunk)))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(errDecoder.push(chunk)))

    const collect = (): { out: string; err: string } => ({
      out: stdout.join('') + outDecoder.flush(),
      err: stderr.join('') + errDecoder.flush()
    })

    const finish = (code: number | null): void => {
      clearTimeout(timer)
      const { out, err } = collect()
      resolve({
        exitCode: code ?? -1,
        stdout: out,
        stderr: err,
        durationMs: Date.now() - startedAt,
        timedOut
      })
    }

    child.on('error', (error) => {
      clearTimeout(timer)
      const { out, err } = collect()
      resolve({
        exitCode: -1,
        stdout: out,
        stderr: `${err}\n${error.message}`,
        durationMs: Date.now() - startedAt,
        timedOut: false
      })
    })
    child.on('close', finish)
  })
}

export async function runScript(script: ScriptEntry): Promise<RunResult> {
  if (script.type === 'other') {
    throw new Error('该文件不是可执行的脚本类型（仅支持 .bat / .cmd / .ps1），不能运行')
  }

  const settings = readSettings()
  if (settings.autoSnapshotBeforeRun) {
    try {
      await saveSnapshot(`运行前：${script.name}`, '脚本执行前的自动快照')
    } catch {
      // a snapshot failure must not block the run; it is reported through audit
    }
  }

  const file = writeTempScript(script)
  const env = await shellEnv()

  const result =
    script.type === 'batch'
      ? // No manual quoting: Node quotes the path when it contains spaces, and
        // `cmd /s` strips that outer pair. Adding quotes here would be escaped
        // into literal \" and cmd would fail to find the file.
        await spawnAndCollect('cmd.exe', ['/d', '/s', '/c', file], env, 'utf-8')
      : await spawnAndCollect(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '${file.replace(/'/g, "''")}'`
          ],
          env,
          'utf-8'
        )

  const records = readScriptRecords()
  const target = records.find((item) => item.id === script.id)
  if (target) {
    target.lastRunAt = Date.now()
    target.lastExitCode = result.exitCode
    writeScriptRecords(records)
  }

  audit('script.run', `${script.name}（exit=${result.exitCode}${result.timedOut ? '，超时' : ''}）`, result.exitCode === 0)
  return result
}

export function saveScript(input: { id: string; name: string; type: ScriptType; content: string; createdAt?: number }): ScriptEntry {
  ensureLayout()
  const records = readScriptRecords()
  const existing = records.find((item) => item.id === input.id)

  if (existing) {
    // Keep the file in sync with the editor; rename it when the type changed.
    const desiredExtension = extensionForType(input.type)
    if (path.extname(existing.file).toLowerCase() !== desiredExtension) {
      deleteScriptFile(existing.file)
      existing.file = `${existing.id}${desiredExtension}`
    }
    existing.name = input.name
    existing.type = input.type
    writeScriptFile(existing.file, input.content)
    writeScriptRecords(records)
    audit('script.save', `更新脚本「${input.name}」`)
    return { ...existing, content: input.content }
  }

  const id = input.id || newId('script')
  const file = `${id}${extensionForType(input.type)}`
  const record = {
    id,
    name: input.name,
    type: input.type,
    file,
    createdAt: input.createdAt ?? Date.now()
  }
  writeScriptFile(file, input.content)
  records.push(record)
  writeScriptRecords(records)
  audit('script.save', `新建脚本「${record.name}」`)
  return { ...record, content: input.content }
}

export function deleteScript(id: string): void {
  const records = readScriptRecords()
  const target = records.find((item) => item.id === id)
  if (!target) return
  deleteScriptFile(target.file)
  writeScriptRecords(records.filter((item) => item.id !== id))
  audit('script.delete', target.name)
}

function uniqueFileName(desired: string): string {
  const dir = scriptsDir()
  const parsed = path.parse(desired)
  let candidate = desired
  let counter = 2
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${parsed.name}-${counter}${parsed.ext}`
    counter += 1
  }
  return candidate
}

/**
 * Copies dropped files into the user's script folder. The original path is never
 * referenced afterwards, so moving/deleting the source does not break the entry.
 * Non-script files are accepted but flagged and cannot be executed.
 */
export function importScripts(paths: string[]): ScriptImportResult {
  ensureLayout()
  const records = readScriptRecords()
  const added: ScriptEntry[] = []
  const warnings: ScriptImportWarning[] = []

  for (const source of paths) {
    try {
      const stat = fs.statSync(source)
      if (!stat.isFile()) {
        warnings.push({ file: source, reason: '不是文件，已跳过' })
        continue
      }
      if (stat.size > MAX_IMPORT_BYTES) {
        warnings.push({ file: path.basename(source), reason: '文件超过 5MB，已跳过' })
        continue
      }

      const type = typeForFileName(source)
      const targetName = uniqueFileName(path.basename(source))
      fs.copyFileSync(source, path.join(scriptsDir(), targetName))

      const record = {
        id: newId('script'),
        name: path.basename(source, path.extname(source)),
        type,
        file: targetName,
        createdAt: Date.now()
      }
      records.push(record)
      const imported = fs.readFileSync(path.join(scriptsDir(), targetName))
      added.push({ ...record, content: decodeText(imported) })

      if (type === 'other') {
        warnings.push({
          file: path.basename(source),
          reason: '不是可执行的脚本后缀（.bat / .cmd / .ps1），已作为普通文件保存，不能运行'
        })
      }
    } catch (error) {
      warnings.push({ file: path.basename(source), reason: (error as Error).message })
    }
  }

  if (added.length > 0) writeScriptRecords(records)
  audit(
    'script.import',
    `导入 ${added.length} 个文件${warnings.length > 0 ? `，${warnings.length} 条告警` : ''}`,
    added.length > 0
  )
  return { added, warnings }
}
