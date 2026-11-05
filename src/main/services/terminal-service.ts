import { spawn } from 'node:child_process'
import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { IPC, type TerminalExitEvent, type TerminalSessionInfo } from '../../shared/ipc-types'
import { projectRoot } from './paths'
import { shellEnv } from './script-runner'
import { newId } from './storage'

/** Keep at most this much scrollback per tab (oldest output is dropped). */
const MAX_BUFFER_CHARS = 400_000

interface Session {
  id: string
  title: string
  cwd: string
  buffer: string
  /** null once the shell exited or was killed. */
  shell: IPty | null
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
    running: session.shell !== null,
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

function shellCommand(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }
  }
  return { file: process.env.SHELL ?? 'bash', args: ['-l'] }
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

async function spawnShell(session: Session, cols = 120, rows = 30): Promise<void> {
  const env = sanitizeEnv(await shellEnv())
  const { file, args } = shellCommand()

  const shell = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: session.cwd,
    env,
    useConpty: true
  })

  session.shell = shell
  shell.onData((data) => append(session, data))
  shell.onExit(({ exitCode }) => {
    session.shell = null
    const event: TerminalExitEvent = { id: session.id, code: exitCode, durationMs: 0, timedOut: false }
    broadcast(IPC.terminalExit, event)
  })
}

function killSessionTree(session: Session): void {
  const shell = session.shell
  if (!shell) return
  session.shell = null
  try {
    if (process.platform === 'win32') {
      // ConPTY children are not signalled by kill(); take the tree down.
      spawn('taskkill', ['/pid', String(shell.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else {
      shell.kill()
    }
  } catch {
    // already gone
  }
}

export function listSessions(): TerminalSessionInfo[] {
  return [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt).map(toInfo)
}

export async function createSession(): Promise<TerminalSessionInfo> {
  counter += 1
  const session: Session = {
    id: newId('term'),
    title: `终端 ${counter}`,
    cwd: projectRoot(),
    buffer: '',
    shell: null,
    createdAt: Date.now()
  }
  sessions.set(session.id, session)
  await spawnShell(session)
  return toInfo(session)
}

export function renameSession(id: string, title: string): void {
  const session = getSession(id)
  session.title = title.trim().slice(0, 40) || session.title
}

export function closeSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  killSessionTree(session)
  sessions.delete(id)
}

export function stopSession(id: string): void {
  const session = getSession(id)
  if (!session.shell) return
  append(session, '\n\x1b[31m[已请求终止终端]\x1b[0m\n')
  killSessionTree(session)
}

export function clearSession(id: string): void {
  const session = getSession(id)
  session.buffer = ''
  broadcast(IPC.terminalCleared, { id })
}

export function readBuffer(id: string): string {
  return getSession(id).buffer
}

/** Raw keystrokes from xterm.js go straight into the PTY. */
export function writeInput(id: string, data: string): void {
  const session = getSession(id)
  if (!session.shell) throw new Error('终端已结束，请新建一个标签页')
  session.shell.write(data)
}

export function resizeSession(id: string, cols: number, rows: number): void {
  const session = getSession(id)
  if (!session.shell) return
  try {
    session.shell.resize(Math.max(2, cols), Math.max(2, rows))
  } catch {
    // resize can fail while the shell is exiting
  }
}

/** Called on app quit so no ConPTY host keeps running. */
export function disposeAllSessions(): void {
  for (const session of sessions.values()) killSessionTree(session)
  sessions.clear()
}
