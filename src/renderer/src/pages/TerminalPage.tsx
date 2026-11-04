import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { TerminalSessionInfo } from '../../../shared/ipc-types'
import { api, errorText } from '../lib/api'
import { useToast } from '../components/Toast'
import { ConfirmDialog } from '../components/ConfirmDialog'

/**
 * Tabbed embedded console. Each tab is an independent session in the main
 * process (its own cwd, scrollback and running child), so switching tabs never
 * loses output and one tab can keep working while another runs a command.
 */
export function TerminalPage(): ReactElement {
  const toast = useToast()
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [buffers, setBuffers] = useState<Record<string, string>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<Record<string, string[]>>({})
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [closing, setClosing] = useState<TerminalSessionInfo | null>(null)
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null)

  const outputRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const stickToBottom = useRef(true)
  const activeIdRef = useRef<string | null>(null)

  const active = useMemo(() => sessions.find((item) => item.id === activeId) ?? null, [sessions, activeId])
  activeIdRef.current = activeId

  // Ctrl+C must work even when focus is outside the input (e.g. the user clicked
  // the output pane). Capture phase so it beats any input-level handler; the
  // main process ignores it when nothing is running.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.key.toLowerCase() !== 'c') return
      const id = activeIdRef.current
      if (!id) return
      event.preventDefault()
      void api.terminal.stop(id).catch(() => {})
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const scrollToBottom = useCallback(() => {
    const node = outputRef.current
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [])

  const loadBuffers = useCallback(async (list: TerminalSessionInfo[]) => {
    const entries = await Promise.all(
      list.map(async (session) => [session.id, await api.terminal.buffer(session.id)] as const)
    )
    setBuffers(Object.fromEntries(entries))
    setRunning(Object.fromEntries(list.map((session) => [session.id, session.running])))
  }, [])

  const bootstrap = useCallback(async () => {
    try {
      let list = await api.terminal.list()
      if (list.length === 0) {
        const created = await api.terminal.create()
        list = [created]
      }
      setSessions(list)
      setActiveId((current) => (current && list.some((item) => item.id === current) ? current : list[0].id))
      await loadBuffers(list)
    } catch (error) {
      toast('error', errorText(error))
    }
  }, [loadBuffers, toast])

  // React StrictMode double-invokes effects in dev; without this guard the
  // first mount would create two tabs (list() returns empty for both calls).
  const bootstrapped = useRef(false)

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    const offData = api.terminal.onData(({ id, chunk }) => {
      setBuffers((current) => ({ ...current, [id]: ((current[id] ?? '') + chunk).slice(-400_000) }))
      if (id === activeIdRef.current) requestAnimationFrame(scrollToBottom)
    })
    const offExit = api.terminal.onExit(({ id }) => {
      setRunning((current) => ({ ...current, [id]: false }))
      if (id === activeIdRef.current) requestAnimationFrame(scrollToBottom)
    })
    const offCwd = api.terminal.onCwd(({ id, cwd }) => {
      setSessions((current) => current.map((session) => (session.id === id ? { ...session, cwd } : session)))
    })
    const offCleared = api.terminal.onCleared(({ id }) => {
      setBuffers((current) => ({ ...current, [id]: '' }))
    })
    return () => {
      offData()
      offExit()
      offCwd()
      offCleared()
    }
  }, [scrollToBottom])

  useEffect(() => {
    stickToBottom.current = true
    requestAnimationFrame(() => {
      scrollToBottom()
      inputRef.current?.focus()
    })
  }, [activeId, scrollToBottom])

  async function createTab(): Promise<void> {
    try {
      const created = await api.terminal.create()
      setSessions((current) => [...current, created])
      setActiveId(created.id)
      setBuffers((current) => ({ ...current, [created.id]: '' }))
      setRunning((current) => ({ ...current, [created.id]: false }))
      const buffer = await api.terminal.buffer(created.id)
      setBuffers((current) => ({ ...current, [created.id]: buffer }))
    } catch (error) {
      toast('error', errorText(error))
    }
  }

  async function closeTab(session: TerminalSessionInfo): Promise<void> {
    setClosing(null)
    try {
      await api.terminal.close(session.id)
      let list = await api.terminal.list()
      // Never leave the page in a dead "no terminal" state: closing the last tab
      // immediately opens a fresh one.
      if (list.length === 0) {
        const created = await api.terminal.create()
        list = [created]
        setBuffers((current) => ({ ...current, [created.id]: '' }))
        setRunning((current) => ({ ...current, [created.id]: false }))
        const buffer = await api.terminal.buffer(created.id)
        setBuffers((current) => ({ ...current, [created.id]: buffer }))
      }
      setSessions(list)
      setBuffers((current) => {
        const next = { ...current }
        if (!list.some((item) => item.id === session.id)) delete next[session.id]
        return next
      })
      setActiveId((current) => (current === session.id ? (list[0]?.id ?? null) : current))
    } catch (error) {
      toast('error', errorText(error))
    }
  }

  async function submit(): Promise<void> {
    if (!activeId) return

    // Ask the main process whether this tab is busy instead of trusting React
    // state: a command may have been started elsewhere, and a stale `running`
    // flag would otherwise try to start a second command and get rejected.
    const busy =
      (await api.terminal
        .list()
        .then((list) => list.find((session) => session.id === activeId)?.running)
        .catch(() => false)) ?? running[activeId]

    // A command is waiting for input (pause / Read-Host / choice): send the line
    // to its stdin instead of starting a new command. Empty Enter still counts.
    if (busy) {
      const line = input
      setInput('')
      try {
        await api.terminal.write(activeId, `${line}\r\n`)
      } catch (error) {
        toast('error', errorText(error))
      }
      return
    }

    const command = input.trim()
    if (!command) return
    setInput('')
    setHistoryIndex(-1)
    setHistory((current) => {
      const list = current[activeId] ?? []
      return { ...current, [activeId]: [...list.filter((item) => item !== command), command].slice(-100) }
    })
    stickToBottom.current = true
    setRunning((current) => ({ ...current, [activeId]: true }))
    try {
      await api.terminal.run(activeId, command)
    } catch (error) {
      setRunning((current) => ({ ...current, [activeId]: false }))
      toast('error', errorText(error))
    }
  }

  async function stop(): Promise<void> {
    if (!activeId) return
    try {
      await api.terminal.stop(activeId)
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

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (!activeId) return
    const list = history[activeId] ?? []

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (list.length === 0) return
      const next = historyIndex < 0 ? list.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      setInput(list[next] ?? '')
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (list.length === 0 || historyIndex < 0) return
      const next = historyIndex + 1
      if (next >= list.length) {
        setHistoryIndex(-1)
        setInput('')
      } else {
        setHistoryIndex(next)
        setInput(list[next] ?? '')
      }
      return
    }
    if (event.key.toLowerCase() === 'd' && event.ctrlKey) {
      if (activeId) {
        event.preventDefault()
        // No-op in the main process when nothing is running.
        void api.terminal.closeInput(activeId).catch(() => {})
      }
      return
    }
    if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault()
      void api.terminal.clear(activeId)
      return
    }
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
          <span className={`badge ${isRunning ? 'blue' : 'green'}`}>{isRunning ? '执行中' : '就绪'}</span>
          <button
            className="btn small"
            onClick={() => activeId && void api.terminal.clear(activeId)}
            disabled={!activeId}
          >
            清屏
          </button>
        </div>
      </div>

      <div className="term-body">
        <pre
          className="term-output"
          ref={outputRef}
          onScroll={(event) => {
            const node = event.currentTarget
            stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
          }}
        >
          {activeId ? (buffers[activeId] ?? '') : '没有打开的终端'}
        </pre>

        <form
          className="term-input-row"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <span className="term-prompt" title={active?.cwd}>
            PS {active ? shortenPath(active.cwd) : ''}&gt;
          </span>
          <input
            ref={inputRef}
            className="term-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={
              isRunning
                ? '输入内容回车发送给进程 · Ctrl+D 结束输入 · Ctrl+C 终止'
                : '输入命令，Enter 执行；↑↓ 翻历史，Ctrl+L 清屏'
            }
            spellCheck={false}
            autoComplete="off"
            disabled={!activeId}
          />
          {isRunning ? (
            <>
              <button type="submit" className="btn small primary" title="把输入发送给正在运行的命令">
                发送
              </button>
              <button type="button" className="btn small danger" onClick={() => void stop()} title="终止当前命令">
                停止
              </button>
            </>
          ) : (
            <button type="submit" className="btn small primary" disabled={!input.trim()}>
              执行
            </button>
          )}
        </form>
      </div>

      {closing ? (
        <ConfirmDialog
          title="关闭标签页"
          tone="danger"
          confirmLabel="关闭"
          message={`关闭「${closing.title}」？`}
          detail={running[closing.id] ? '该标签页还有命令在执行，关闭会一并终止。' : '滚动记录会一并清除。'}
          onCancel={() => setClosing(null)}
          onConfirm={() => void closeTab(closing)}
        />
      ) : null}
    </div>
  )
}

/** Prompt shows only the trailing folder; the full cwd is in the tooltip. */
function shortenPath(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : value
}
