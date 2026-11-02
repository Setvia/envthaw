import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { EnvVarEntry } from '../../../shared/ipc-types'
import { api, errorText } from '../lib/api'
import { useToast } from '../components/Toast'
import { Modal } from '../components/Modal'

interface EditState {
  mode: 'create' | 'edit'
  name: string
  value: string
}

export function EnvironmentPage(): ReactElement {
  const toast = useToast()
  const [vars, setVars] = useState<EnvVarEntry[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [snapshotName, setSnapshotName] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setVars(await api.env.list())
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    if (!keyword) return vars
    return vars.filter((entry) => entry.name.toLowerCase().includes(keyword) || entry.value.toLowerCase().includes(keyword))
  }, [vars, filter])

  async function save(): Promise<void> {
    if (!edit) return
    const name = edit.name.trim()
    if (!name) {
      toast('error', '变量名不能为空')
      return
    }
    setBusy(true)
    try {
      await api.env.set(name, edit.value)
      setEdit(null)
      await load()
      toast('success', `已写入 ${name}`)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove(name: string): Promise<void> {
    if (!window.confirm(`确定删除用户环境变量 ${name}？\n删除前会自动创建回滚点。`)) return
    setBusy(true)
    try {
      await api.env.remove(name)
      await load()
      toast('success', `已删除 ${name}`)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function saveSnapshot(): Promise<void> {
    setBusy(true)
    try {
      const snapshot = await api.env.saveSnapshot(snapshotName.trim() || `快照 ${new Date().toLocaleString()}`)
      setSnapshotOpen(false)
      setSnapshotName('')
      toast('success', `已保存快照「${snapshot.name}」`)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search">
          <input
            className="input"
            placeholder="搜索变量名或值…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <span className="muted">
          共 {vars.length} 个用户级变量{filter ? `，匹配 ${filtered.length} 个` : ''}
        </span>
        <div className="spacer" />
        <button className="btn" onClick={() => setSnapshotOpen(true)} disabled={busy}>
          保存为快照
        </button>
        <button className="btn" onClick={() => void load()} disabled={busy}>
          刷新
        </button>
        <button className="btn primary" onClick={() => setEdit({ mode: 'create', name: '', value: '' })}>
          新增变量
        </button>
      </div>

      <div className="card tight">
        <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 260px)' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 230 }}>变量名</th>
                <th>值</th>
                <th style={{ width: 110 }}>类型</th>
                <th style={{ width: 140 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty">
                    {vars.length === 0 ? '没有读取到用户级环境变量。' : '没有匹配的变量。'}
                  </td>
                </tr>
              ) : (
                filtered.map((entry) => (
                  <tr key={entry.name}>
                    <td className="mono">{entry.name}</td>
                    <td className="cell-value mono">{entry.value || <span className="muted">（空）</span>}</td>
                    <td>
                      <span className={`badge ${entry.kind === 'ExpandString' ? 'blue' : ''}`}>{entry.kind}</span>
                    </td>
                    <td>
                      <div className="cell-actions">
                        <button className="btn small" onClick={() => setEdit({ mode: 'edit', name: entry.name, value: entry.value })}>
                          编辑
                        </button>
                        <button className="btn small danger" onClick={() => void remove(entry.name)} disabled={busy}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {edit ? (
        <Modal
          title={edit.mode === 'create' ? '新增用户环境变量' : `编辑 ${edit.name}`}
          subtitle="写入 HKCU\Environment 并广播 WM_SETTINGCHANGE；只影响当前用户。"
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEdit(null)}>
                取消
              </button>
              <button className="btn primary" onClick={() => void save()} disabled={busy}>
                保存
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label">变量名</label>
            <input
              className="input mono"
              placeholder="例如：JAVA_HOME"
              value={edit.name}
              disabled={edit.mode === 'edit'}
              onChange={(event) => setEdit({ ...edit, name: event.target.value })}
              autoFocus
            />
            {edit.mode === 'edit' ? <span className="field-hint">变量名不可修改；需要改名请新增后删除旧变量。</span> : null}
          </div>
          <div className="field">
            <label className="field-label">变量值</label>
            <textarea
              className="textarea"
              rows={5}
              placeholder="例如：D:\EnvThaw\jdk\17"
              value={edit.value}
              onChange={(event) => setEdit({ ...edit, value: event.target.value })}
            />
            <span className="field-hint">包含 %VAR% 的值会以 REG_EXPAND_SZ 写入，保留变量展开语义。</span>
          </div>
        </Modal>
      ) : null}

      {snapshotOpen ? (
        <Modal
          title="保存为快照"
          subtitle="记录当前全部用户级变量，稍后可一键恢复或对比差异。"
          onClose={() => setSnapshotOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setSnapshotOpen(false)}>
                取消
              </button>
              <button className="btn primary" onClick={() => void saveSnapshot()} disabled={busy}>
                保存快照
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label">快照名称</label>
            <input
              className="input"
              placeholder="例如：Node + Git 开发环境"
              value={snapshotName}
              onChange={(event) => setSnapshotName(event.target.value)}
              autoFocus
            />
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
