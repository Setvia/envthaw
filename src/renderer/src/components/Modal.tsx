import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'

type Tone = 'default' | 'danger'

interface ModalProps {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  width?: number
  tone?: Tone
  /** Single glyph shown in a round badge left of the title. */
  icon?: ReactNode
  /** Narrow dialog (confirmation style). */
  compact?: boolean
}

/**
 * The one dialog shell used everywhere. Visual language mirrors the app window:
 * same panel/border tokens, 14px radius, a header strip like the topbar and a
 * footer strip for actions.
 */
export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  width,
  tone = 'default',
  icon,
  compact = false
}: ModalProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const container = dialogRef.current
    // Don't steal focus from an input the page already autofocused.
    if (container && !container.contains(document.activeElement)) {
      const target = container.querySelector<HTMLElement>('[data-autofocus]') ?? container
      target.focus({ preventScroll: true })
    }
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className={`modal tone-${tone}${compact ? ' compact' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
      >
        <div className="modal-header">
          {icon ? <span className="modal-icon">{icon}</span> : null}
          <div className="modal-heading">
            <h2 className="modal-title">{title}</h2>
            {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭" title="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}
