import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ToastProvider } from './components/Toast'
import { TitleBar } from './components/TitleBar'
import { UserSwitcher } from './components/UserSwitcher'
import { Dashboard } from './pages/Dashboard'
import { EnvironmentPage } from './pages/EnvironmentPage'
import { RedirectPage } from './pages/RedirectPage'
import { ScriptsPage } from './pages/ScriptsPage'
import { TerminalPage } from './pages/TerminalPage'
import { SnapshotsPage } from './pages/SnapshotsPage'
import { SettingsPage } from './pages/SettingsPage'
import { AuditPage } from './pages/AuditPage'

type PageId = 'dashboard' | 'env' | 'redirect' | 'scripts' | 'terminal' | 'snapshots' | 'settings' | 'audit'

interface PageMeta {
  id: PageId
  label: string
  icon: string
  title: string
  desc: string
}

const PAGES: PageMeta[] = [
  { id: 'dashboard', label: '总览', icon: '◈', title: '总览', desc: '当前机器的环境状态与快捷操作' },
  { id: 'env', label: '环境变量', icon: '⌘', title: '环境变量', desc: '管理当前用户的 HKCU\\Environment' },
  { id: 'redirect', label: '路径重定向', icon: '⇄', title: '路径重定向', desc: '把 Python / Node / Git 的目录收进项目内' },
  { id: 'scripts', label: '脚本库', icon: '⌨', title: '脚本库', desc: '保存常用脚本，执行前先 dry-run' },
  { id: 'terminal', label: '命令行', icon: '▮', title: '命令行', desc: '内嵌多标签命令行，每个标签独立工作目录' },
  { id: 'snapshots', label: '快照与恢复', icon: '⧉', title: '快照与恢复', desc: '对比差异，只改需要改的变量' },
  { id: 'settings', label: '设置', icon: '⚙', title: '设置', desc: '配置目录、更新源与配置包' },
  { id: 'audit', label: '操作日志', icon: '☰', title: '操作日志', desc: '所有写操作的审计记录' }
]

function App(): ReactElement {
  const [page, setPage] = useState<PageId>('dashboard')
  const meta = PAGES.find((item) => item.id === page) ?? PAGES[0]
  const shellRef = useRef<HTMLDivElement>(null)

  // Keep the initial/returning focus on the shell instead of letting Chromium
  // park it on the first focusable control (the "总览" nav button).
  useEffect(() => {
    shellRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div className="app" ref={shellRef} tabIndex={-1}>
      <TitleBar section={meta.label} />

      <div className="app-body">
        <aside className="sidebar">
          {PAGES.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${item.id === page ? 'active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}

          <div className="sidebar-footer">
            <UserSwitcher />
            <div className="sidebar-version">v0.1 · 本地 MVP</div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div>
              <h1 className="page-title">{meta.title}</h1>
              <div className="page-desc">{meta.desc}</div>
            </div>
          </header>

          <main className="content">
            {page === 'dashboard' ? <Dashboard onNavigate={(next) => setPage(next as PageId)} /> : null}
            {page === 'env' ? <EnvironmentPage /> : null}
            {page === 'redirect' ? <RedirectPage /> : null}
            {page === 'scripts' ? <ScriptsPage /> : null}
            {page === 'terminal' ? <TerminalPage /> : null}
            {page === 'snapshots' ? <SnapshotsPage /> : null}
            {page === 'settings' ? <SettingsPage /> : null}
            {page === 'audit' ? <AuditPage /> : null}
          </main>
        </div>
      </div>
    </div>
  )
}

export default function Root(): ReactElement {
  return (
    <ToastProvider>
      <App />
    </ToastProvider>
  )
}
