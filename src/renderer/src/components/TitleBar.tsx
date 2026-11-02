import { useEffect, useState, type ReactElement } from 'react'
import { api } from '../lib/api'

/**
 * In-page title bar: the window is frameless, so dragging, double-click
 * maximise and the three window buttons are all handled here. Layout follows the
 * DSH desktop app - brand on the left, controls on the right.
 */
export function TitleBar({ section }: { section: string }): ReactElement {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void api.window.isMaximized().then(setMaximized)
    return api.window.onMaximizedChange(setMaximized)
  }, [])

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <span className="brand-mark tiny">E</span>
        <span className="titlebar-app">EnvThaw</span>
        <span className="titlebar-divider" />
        <span className="titlebar-section">{section}</span>
      </div>

      <div className="titlebar-drag" />

      <div className="window-controls">
        <button className="win-btn" title="最小化" aria-label="最小化" onClick={() => void api.window.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className="win-btn"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void api.window.toggleMaximize().then(setMaximized)}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2.5 2.5h5v5h-5z" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M4 2.5V1h5v5H7.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button className="win-btn close" title="关闭" aria-label="关闭" onClick={() => void api.window.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </header>
  )
}
