import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { UserProfile } from '../../../shared/ipc-types'
import { api, errorText } from '../lib/api'
import { useToast } from '../components/Toast'
import { Modal } from '../components/Modal'

/**
 * Multi-profile switcher. Every profile is a directory under config/, and all
 * per-user data (scripts folder, snapshots, settings, audit, redirect) lives
 * inside it. "default" is the temporary / not-signed-in profile.
 */
export function UserSwitcher(): ReactElement {
  const toast = useToast()
  const [users, setUsers] = useState<UserProfile[]>([])
  const [current, setCurrent] = useState('default')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, active] = await Promise.all([api.users.list(), api.users.current()])
      setUsers(list)
      setCurrent(active)
    } catch (error) {
      toast('error', errorText(error))
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function switchTo(next: string): Promise<void> {
    if (next === current) {
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      await api.users.switch(next)
      // Every page caches data from the previous profile - a reload is the
      // simplest way to guarantee nothing leaks across profiles.
      window.location.reload()
    } catch (error) {
      toast('error', errorText(error))
      setBusy(false)
    }
  }

  async function create(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      const list = await api.users.create(trimmed)
      setUsers(list)
      setName('')
      toast('success', `已创建用户「${trimmed}」，切换后生效`)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove(target: string): Promise<void> {
    if (!window.confirm(`删除用户「${target}」？\n该用户目录下的脚本、快照、设置都会被删除，且不可恢复。`)) return
    setBusy(true)
    try {
      const list = await api.users.remove(target)
      setUsers(list)
      if (target === current) window.location.reload()
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const label = current === 'default' ? '默认（临时）' : current

  return (
    <>
      <button className="user-chip" onClick={() => setOpen(true)} title="切换用户">
        <span className="user-avatar">{current.slice(0, 1).toUpperCase()}</span>
        <span className="user-name">{label}</span>
        <span className="user-switch">切换</span>
      </button>

      {open ? (
        <Modal
          title="用户"
          subtitle="每个用户在 config/ 下有独立目录；default 用于未登录的临时状态。"
          width={640}
          onClose={() => setOpen(false)}
        >
          <div className="stack" style={{ gap: 8 }}>
            {users.map((user) => (
              <div key={user.name} className={`user-row ${user.active ? 'active' : ''}`}>
                <span className="user-avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                <div className="user-row-main">
                  <strong>{user.name === 'default' ? 'default（临时）' : user.name}</strong>
                  <span className="muted mono">{user.dir}</span>
                </div>
                {user.active ? (
                  <span className="badge green">当前</span>
                ) : (
                  <button className="btn small" onClick={() => void switchTo(user.name)} disabled={busy}>
                    切换
                  </button>
                )}
                {user.name !== 'default' ? (
                  <button className="btn small danger" onClick={() => void remove(user.name)} disabled={busy}>
                    删除
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          <div className="hr" />
          <div className="field">
            <label className="field-label">新建用户</label>
            <div className="row">
              <input
                className="input"
                placeholder="例如：zhangsan"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && void create()}
              />
              <button className="btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>
                创建
              </button>
            </div>
            <span className="field-hint">只能包含字母、数字、中文、下划线和短横线。</span>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
