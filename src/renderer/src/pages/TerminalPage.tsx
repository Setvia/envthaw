import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSessionInfo } from '../../../shared/ipc-types'
import { api, errorText } from '../lib/api'
import { useToast } from '../components/Toast'
import { ConfirmDialog } from '../components/ConfirmDialog'

/**
 * Tabbed terminal built the way VS Code does it: xterm.js in the renderer and a
 * real ConPTY (node-pty) in the main process. Keystrokes go straight to the
 * shell, so PowerShell prompts, colours, tab-completion and Ctrl+C are native.
 */
export function TerminalPage(): ReactElement {
  const toast = useToast()
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [closing, setClosing] = useState<TerminalSessionInfo | null>(null)
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

  const applyList = useCallback((list: TerminalSessionInfo[]): void => {
    setSessions(list)
    setRunning(Object.fromEntries(list.map((session) => [session.id, session.running])))
    setActiveId((current) => (current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null))
  }, [])

  const bootstrap = useCallback(async () => {
    try {
      let list = await api.terminal.list()
      if (list.length === 0) {
        await api.terminal.create()
        list = await api.terminal.list()
      }
      applyList(list)
    } catch (error) {
      toast('error', errorText(error))
    }
  }, [applyList, toast])

  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    const offData = api.terminal.onData(({ id, chunk }) => {
      if (id === activeRef.current) termRef.current?.write(chunk)
    })
    const offExit = api.terminal.onExit(({ id }) => {
      setRunning((current) => ({ ...current, [id]: false }))
    })
    const offCleared = api.terminal.onCleared(({ id }) => {
      if (id !== activeRef.current) return
      termRef.current?.clear()
      termRef.current?.write('\x1b[2J\x1b[H')
    })
    return () => {
      offData()
      offExit()
      offCleared()
    }
  }, [])

  // One xterm instance per active tab; switching tabs replays the main-process
  // scrollback so nothing is lost.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !activeId) return

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#070f21',
        foreground: '#d6e2f5',
        cursor: '#7fd1a8',
        cursorAccent: '#070f21',
        selectionBackground: 'rgba(125, 209, 168, 0.28)',
        black: '#0f1729',
        red: '#ff6b6b',
        green: '#7fd1a8',
        yellow: '#f0c674',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#d6e2f5',
        brightBlack: '#5f6f8c'
      }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    termRef.current = terminal

    const resize = (): void => {
      try {
        fit.fit()
      } catch {
        // host not laid out yet
      }
      void api.terminal.resize(activeId, terminal.cols, terminal.rows).catch(() => {})
    }

    requestAnimationFrame(() => {
      resize()
      void api.terminal
        .buffer(activeId)
        .then((buffer) => {
          if (buffer) terminal.write(buffer)
        })
        .catch(() => {})
      terminal.focus()
    })

    terminal.onData((data) => {
      void api.terminal.write(activeId, data).catch(() => {})
    })
    terminal.onResize(({ cols, rows }) => {
      void api.terminal.resize(activeId, cols, rows).catch(() => {})
    })

    window.addEventListener('resize', resize)
    const observer = new ResizeObserver(resize)
    observer.observe(host)

    // The host can still be 0x0 on the first frame after mounting (page switch),
    // which makes FitAddon fall back to the default 80 columns. Re-fit shortly
    // after mount and once the monospace font is ready.
    const retries = [setTimeout(resize, 60), setTimeout(resize, 300)]
    void document.fonts?.ready.then(() => resize()).catch(() => {})

    return () => {
      window.removeEventListener('resize', resize)
      observer.disconnect()
      for (const timer of retries) clearTimeout(timer)
      terminal.dispose()
      termRef.current = null
    }
  }, [activeId])

  async function createTab(): Promise<void> {
    try {
      await api.terminal.create()
      applyList(await api.terminal.list())
    } catch (error) {
      toast('error', errorText(error))
    }
  }

  async function closeTab(session: TerminalSessionInfo): Promise<void> {
    setClosing(null)
    try {
      await api.terminal.close(session.id)
      let list = await api.terminal.list()
      if (list.length === 0) {
        await api.terminal.create()
        list = await api.terminal.list()
      }
      setSessions(list)
      setRunning(Object.fromEntries(list.map((item) => [item.id, item.running])))
      setActiveId((current) => (current === session.id ? (list[0]?.id ?? null) : current))
    } catch (error) {
      toast('error', errorText(error))
    }
  }

  async function commitRename(): Promise<void> {
    if (!editing) return
    const title = editing.title.trim()
    setEditing(null)
    if (!title) return
    try {
      await api.terminal.rename(editing.id, title)
      setSessions((current) => current.map((session) => (session.id === editing.id ? { ...session, title } : session)))
    } catch (error) {
      toast('error', errorText(error))
    }
  }

  async function clearScreen(): Promise<void> {
    if (!activeId) return
    termRef.current?.clear()
    termRef.current?.write('\x1b[2J\x1b[H')
    await api.terminal.clear(activeId).catch(() => {})
  }

  const isRunning = activeId ? Boolean(running[activeId]) : false

  return (
    <div className="stack term-page">
      <div className="term-toolbar">
        <div className="term-tabs">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`term-tab ${session.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(session.id)}
              onDoubleClick={() => setEditing({ id: session.id, title: session.title })}
              title="双击重命名"
            >
              <span className={`term-dot ${running[session.id] ? 'busy' : ''}`} />
              {editing?.id === session.id ? (
                <input
                  className="term-tab-input"
                  value={editing.title}
                  autoFocus
                  onChange={(event) => setEditing({ id: session.id, title: event.target.value })}
                  onBlur={() => void commitRename()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitRename()
                    if (event.key === 'Escape') setEditing(null)
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <span className="term-tab-title">{session.title}</span>
              )}
              <button
                className="term-tab-close"
                onClick={(event) => {
                  event.stopPropagation()
                  setClosing(session)
                }}
                title="关闭标签页"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <button className="term-new" onClick={() => void createTab()} title="新建标签页">
          +
        </button>

        <div className="term-actions">
          <span className={`badge ${isRunning ? 'green' : 'red'}`}>{isRunning ? '运行中' : '已退出'}</span>
          <button className="btn small" onClick={() => void clearScreen()} disabled={!activeId}>
            清屏
          </button>
        </div>
      </div>

      <div className="term-body">
        <div className="term-surface" ref={hostRef} onMouseDown={() => termRef.current?.focus()} />
      </div>

      {closing ? (
        <ConfirmDialog
          title="关闭标签页"
          tone="danger"
          confirmLabel="关闭"
          message={`关闭「${closing.title}」？`}
          detail="该标签页里的 PowerShell 进程会被终止。"
          onCancel={() => setClosing(null)}
          onConfirm={() => void closeTab(closing)}
        />
      ) : null}
    </div>
  )
}
