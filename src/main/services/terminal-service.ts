import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { IPC, type TerminalExitEvent, type TerminalSessionInfo } from '../../shared/ipc-types'
import { projectRoot } from './paths'
import { shellEnv } from './script-runner'
import { newId } from './storage'
import { consoleEncoding, createDecoder } from '../utils/encoding'

/** Keep at most this much scrollback per tab (oldest output is dropped). */
const MAX_BUFFER_CHARS = 400_000
const RUN_TIMEOUT_MS = 10 * 60 * 1000
const MAX_COMMAND_LENGTH = 8000

interface Session {
  id: string
  title: string
  cwd: string
  buffer: string
  child: ChildProcess | null
  startedAt: number
  timer: NodeJS.Timeout | null
  createdAt: number
}

const sessions = new Map<string, Session>()
let counter = 0

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function toInfo(session: Session): TerminalSessionInfo {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    running: session.child !== null,
    createdAt: session.createdAt
  }
}

function append(session: Session, text: string): void {
  session.buffer += text
  if (session.buffer.length > MAX_BUFFER_CHARS) {
    session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_CHARS)
  }
  broadcast(IPC.terminalData, { id: session.id, chunk: text })
}

function getSession(id: string): Session {
  const session = sessions.get(id)
  if (!session) throw new Error('终端不存在或已关闭')
  return session
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    // A command may have spawned children; kill the whole tree.
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

function finish(session: Session, code: number | null, timedOut: boolean): void {
  const durationMs = Date.now() - session.startedAt
  if (session.timer) clearTimeout(session.timer)
  session.timer = null
  session.child?.stdin?.end()
  session.child = null

  const seconds = (durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)
  append(session, `${timedOut ? '\n[超时，已终止]' : ''}\n[退出码 ${code ?? '—'} · ${seconds}s]\n`)

  const event: TerminalExitEvent = { id: session.id, code, durationMs, timedOut }
  broadcast(IPC.terminalExit, event)
}

export function listSessions(): TerminalSessionInfo[] {
  return [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt).map(toInfo)
}

export function createSession(): TerminalSessionInfo {
  counter += 1
  const session: Session = {
    id: newId('term'),
    title: `终端 ${counter}`,
    cwd: projectRoot(),
    buffer: '',
    child: null,
    startedAt: 0,
    timer: null,
    createdAt: Date.now()
  }
  sessions.set(session.id, session)
  append(session, `EnvThaw 命令行 · ${process.platform === 'win32' ? 'PowerShell' : 'bash'}\n工作目录：${session.cwd}\n`)
  return toInfo(session)
}

export function renameSession(id: string, title: string): void {
  const session = getSession(id)
  session.title = title.trim().slice(0, 40) || session.title
}

export function closeSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  if (session.child) killTree(session.child)
  if (session.timer) clearTimeout(session.timer)
  sessions.delete(id)
}

export function stopSession(id: string): void {
  const session = getSession(id)
  if (session.child) {
    append(session, '\n[已请求终止当前命令]\n')
    killTree(session.child)
  }
}

export function clearSession(id: string): void {
  const session = getSession(id)
  session.buffer = ''
  broadcast(IPC.terminalCleared, { id })
}

export function readBuffer(id: string): string {
  return getSession(id).buffer
}

/** Sends typed text to the running command's stdin (pause / Read-Host / choice...). */
export function writeInput(id: string, data: string): void {
  const session = getSession(id)
  const stdin = session.child?.stdin
  if (!stdin || stdin.destroyed) throw new Error('当前没有正在运行的命令可以接收输入')
  stdin.write(data)
}

/** Closes stdin so commands that read until EOF (more, sort, findstr) can finish. */
export function closeInput(id: string): void {
  const session = getSession(id)
  if (!session.child?.stdin) return
  session.child.stdin.end()
  append(session, '\n[已关闭标准输入]\n')
}

/** Builtins that must not spawn a process. Returns true when handled. */
function runBuiltin(session: Session, command: string): boolean {
  const trimmed = command.trim()

  if (/^(clear|cls)$/i.test(trimmed)) {
    clearSession(session.id)
    return true
  }

  if (/^pwd$/i.test(trimmed)) {
    append(session, `${session.cwd}\n`)
    return true
  }

  const cd = /^cd(?:\s+(.+))?$/i.exec(trimmed)
  if (cd) {
    const raw = (cd[1] ?? '').trim().replace(/^"|"$/g, '')
    const target = raw ? path.resolve(session.cwd, raw) : projectRoot()
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      append(session, `cd: 目录不存在：${target}\n`)
      return true
    }
    session.cwd = target
    append(session, `工作目录：${target}\n`)
    broadcast(IPC.terminalCwd, { id: session.id, cwd: target })
    return true
  }

  return false
}

export async function runCommand(id: string, rawCommand: string): Promise<void> {
  const session = getSession(id)
  const command = rawCommand.replace(/\r?\n/g, ' ').trim()

  if (!command) return
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('命令过长')
  if (session.child) throw new Error('当前标签页还有命令在执行，先停止或等待结束')

  append(session, `\nPS ${session.cwd}> ${command}\n`)
  if (runBuiltin(session, command)) {
    broadcast(IPC.terminalExit, { id: session.id, code: 0, durationMs: 0, timedOut: false } satisfies TerminalExitEvent)
    return
  }

  const env = await shellEnv()
  const isWindows = process.platform === 'win32'
  const child = isWindows
    ? spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          // Leave the console encoding alone: PowerShell then writes in the same
          // code page as the native tools it runs, so one decoder handles both.
          command
        ],
        { cwd: session.cwd, env, windowsHide: true }
      )
    : spawn('bash', ['-lc', command], { cwd: session.cwd, env })

  session.child = child
  session.startedAt = Date.now()

  const decoder = createDecoder(consoleEncoding())
  const stream = (chunk: Buffer): void => append(session, decoder.push(chunk))
  child.stdout?.on('data', stream)
  child.stderr?.on('data', stream)

  let finished = false
  let timedOut = false
  const finishOnce = (code: number | null): void => {
    if (finished) return
    finished = true
    finish(session, code, timedOut)
  }

  child.on('error', (error) => {
    append(session, `\n无法启动命令：${error.message}\n`)
    finishOnce(null)
  })

  child.on('close', (code) => {
    const rest = decoder.flush()
    if (rest) append(session, rest)
    finishOnce(code)
  })

  session.timer = setTimeout(() => {
    if (!session.child) return
    timedOut = true
    append(session, `\n[超过 ${RUN_TIMEOUT_MS / 60000} 分钟，正在终止]\n`)
    killTree(session.child)
  }, RUN_TIMEOUT_MS)

  broadcast(IPC.terminalCwd, { id: session.id, cwd: session.cwd })
}
