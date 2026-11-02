import { createContext, useCallback, useContext, useMemo, useState, type ReactElement, type ReactNode } from 'react'

type ToastKind = 'info' | 'success' | 'error' | 'warn'

interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

type PushToast = (kind: ToastKind, text: string) => void

const ToastContext = createContext<PushToast>(() => {})

export function useToast(): PushToast {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([])

  const push = useCallback<PushToast>((kind, text) => {
    const id = Date.now() + Math.random()
    setItems((current) => [...current, { id, kind, text }])
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id))
    }, 4200)
  }, [])

  const value = useMemo(() => push, [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-wrap">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            {item.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
