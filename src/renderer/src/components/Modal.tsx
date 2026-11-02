import type { ReactElement, ReactNode } from 'react'

interface ModalProps {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  width?: number
}

export function Modal({ title, subtitle, children, footer, onClose, width }: ModalProps): ReactElement {
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{title}</h2>
            {subtitle ? <div className="page-desc">{subtitle}</div> : null}
          </div>
          <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  )
}
