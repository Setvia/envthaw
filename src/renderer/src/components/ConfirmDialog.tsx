import type { ReactElement, ReactNode } from 'react'
import { Modal } from './Modal'

interface ConfirmDialogProps {
  title: string
  message: ReactNode
  /** Extra context shown in muted text under the message. */
  detail?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * In-app replacement for window.confirm so destructive prompts match the rest
 * of the window instead of dropping to a native Windows message box.
 */
export function ConfirmDialog({
  title,
  message,
  detail,
  confirmLabel = '确定',
  cancelLabel = '取消',
  tone = 'default',
  busy = false,
  onCancel,
  onConfirm
}: ConfirmDialogProps): ReactElement {
  return (
    <Modal
      title={title}
      tone={tone}
      compact
      icon={tone === 'danger' ? '!' : '?'}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`btn ${tone === 'danger' ? 'danger' : 'primary'}`}
            onClick={onConfirm}
            disabled={busy}
            data-autofocus
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="confirm-message">{message}</p>
      {detail ? <p className="confirm-detail">{detail}</p> : null}
    </Modal>
  )
}
