import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DryRunChange, DryRunReport, RunResult, ScriptEntry, ScriptType } from '../../shared/ipc-types'
import { mergeEnv, readMachinePath, readUserEnv, toEnvRecord } from '../utils/registry'
import { audit } from './env-service'
import { readScripts, writeScripts, ensureLayout, newId, readSettings } from './storage'
import { saveSnapshot } from './env-service'

const RUN_TIMEOUT_MS = 180_000

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
  // PowerShell 5.1 decodes .ps1 without BOM as ANSI, so Chinese content needs the BOM.
  const bom = script.type === 'powershell' ? '\uFEFF' : ''
  fs.writeFileSync(file, `${bom}${script.content}\r\n`, 'utf8')
  return file
}

async function childEnv(): Promise<NodeJS.ProcessEnv> {
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

function spawnAndCollect(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, { env, windowsHide: true, cwd: process.env.USERPROFILE })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
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

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    const finish = (code: number | null): void => {
      clearTimeout(timer)
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - startedAt,
        timedOut
      })
    }

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        exitCode: -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}\n${error.message}`,
        durationMs: Date.now() - startedAt,
        timedOut: false
      })
    })
    child.on('close', finish)
  })
}

export async function runScript(script: ScriptEntry): Promise<RunResult> {
  const settings = readSettings()
  if (settings.autoSnapshotBeforeRun) {
    try {
      await saveSnapshot(`运行前：${script.name}`, '脚本执行前的自动快照')
    } catch {
      // a snapshot failure must not block the run; it is reported through audit
    }
  }

  const file = writeTempScript(script)
  const env = await childEnv()

  const result =
    script.type === 'batch'
      ? await spawnAndCollect('cmd.exe', ['/d', '/s', '/c', `"${file}"`], env)
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
          env
        )

  const scripts = readScripts()
  const target = scripts.find((item) => item.id === script.id)
  if (target) {
    target.lastRunAt = Date.now()
    target.lastExitCode = result.exitCode
    writeScripts(scripts)
  }

  audit('script.run', `${script.name}（exit=${result.exitCode}${result.timedOut ? '，超时' : ''}）`, result.exitCode === 0)
  return result
}

export function saveScript(input: { id: string; name: string; type: ScriptType; content: string; createdAt?: number }): ScriptEntry {
  const scripts = readScripts()
  const existing = scripts.find((item) => item.id === input.id)
  if (existing) {
    existing.name = input.name
    existing.type = input.type
    existing.content = input.content
    writeScripts(scripts)
    audit('script.save', `更新脚本「${input.name}」`)
    return existing
  }

  const entry: ScriptEntry = {
    id: input.id || newId('script'),
    name: input.name,
    type: input.type,
    content: input.content,
    createdAt: input.createdAt ?? Date.now()
  }
  scripts.push(entry)
  writeScripts(scripts)
  audit('script.save', `新建脚本「${entry.name}」`)
  return entry
}

export function deleteScript(id: string): void {
  const scripts = readScripts()
  const target = scripts.find((item) => item.id === id)
  writeScripts(scripts.filter((item) => item.id !== id))
  if (target) audit('script.delete', target.name)
}
