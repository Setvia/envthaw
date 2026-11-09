import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { EnvVarEntry } from '../../../shared/ipc-types'
import { api, errorText } from '../lib/api'
import { useToast } from '../components/Toast'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Modal } from '../components/Modal'

interface EditState {
  mode: 'create' | 'edit'
  name: string
  value: string
  /** 列表模式按行编辑；保存时再拼回分号串。 */
  items: string[]
  editor: 'list' | 'text'
}

/** Windows 用分号分隔多值：Path / PATHEXT / PYTHONPATH 这类变量。 */
function splitPathList(value: string): string[] {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function isPathList(value: string): boolean {
  return value.includes(';') && splitPathList(value).length >= 2
}

const PATH_LIST_PREVIEW = 5

function PathList({ value }: { value: string }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const items = splitPathList(value)
  const visible = expanded ? items : items.slice(0, PATH_LIST_PREVIEW)
  return (
    <div className="path-list">
      {visible.map((item, index) => (
        <div className="path-item" key={`${index}-${item}`}>
          <span className="path-index">{index + 1}</span>
          <span className="path-text">{item}</span>
        </div>
      ))}
      {items.length > PATH_LIST_PREVIEW ? (
        <button className="path-more" onClick={() => setExpanded((current) => !current)}>
          {expanded ? '收起' : `展开全部 ${items.length} 项`}
        </button>
      ) : null}
    </div>
  )
}

/** 一行一个路径，支持增删与上下移动，保存时用分号连接。 */
function PathEditor({ items, onChange }: { items: string[]; onChange: (items: string[]) => void }): ReactElement {
  const inputs = useRef<Array<HTMLInputElement | null>>([])

  function update(index: number, value: string): void {
    const next = items.slice()
    next[index] = value
    onChange(next)
  }

  function remove(index: number): void {
    onChange(items.filter((_item, current) => current !== index))
  }

  function move(index: number, delta: number): void {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = items.slice()
    const moved = next[index]
    next[index] = next[target]
    next[target] = moved
    onChange(next)
  }

  function add(): void {
    onChange([...items, ''])
    requestAnimationFrame(() => inputs.current[items.length]?.focus())
  }

  return (
    <div className="path-editor">
      {items.map((item, index) => (
        <div className="path-editor-row" key={index}>
          <span className="path-index">{index + 1}</span>
          <input
            ref={(element) => {
              inputs.current[index] = element
            }}
            className="input mono"
            value={item}
            placeholder="例如：D:\DevTools\jdk\17\bin"
            autoFocus={index === 0}
            onChange={(event) => update(index, event.target.value)}
          />
          <button className="btn small" onClick={() => move(index, -1)} disabled={index === 0} title="上移">
            ↑
          </button>
          <button
            className="btn small"
            onClick={() => move(index, 1)}
            disabled={index === items.length - 1}
            title="下移"
          >
            ↓
          </button>
          <button className="btn small danger" onClick={() => remove(index)} title="删除这一项">
            ×
          </button>
        </div>
      ))}
      <button className="btn small path-editor-add" onClick={add}>
        + 添加一项
      </button>
    </div>
  )
}

export function EnvironmentPage(): ReactElement {
  const toast = useToast()
  const [vars, setVars] = useState<EnvVarEntry[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [snapshotName, setSnapshotName] = useState('')
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)

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
    const value =
      edit.editor === 'list'
        ? edit.items
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
            .join(';')
        : edit.value
    setBusy(true)
    try {
      await api.env.set(name, value)
      setEdit(null)
      await load()
      toast('success', `已写入 ${name}`)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  /** 新增/编辑都从列表模式打开；只有一条时就是单行。 */
  function openEditor(mode: 'create' | 'edit', entry?: EnvVarEntry): void {
    const value = entry?.value ?? ''
    const items = splitPathList(value)
    setEdit({
      mode,
      name: entry?.name ?? '',
      value,
      items: items.length > 0 ? items : [''],
      editor: 'list'
    })
  }

  /** 列表 ⇄ 总文本：切换时同步另一侧的内容，避免丢改动。 */
  function toggleEditor(): void {
    setEdit((current) => {
      if (!current) return current
      if (current.editor === 'list') {
        const text = current.items
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .join(';')
        return { ...current, editor: 'text', value: text }
      }
      const items = splitPathList(current.value)
      return { ...current, editor: 'list', items: items.length > 0 ? items : [''] }
    })
  }

  async function remove(name: string): Promise<void> {
    setPendingRemove(null)
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
        <button className="btn primary" onClick={() => openEditor('create')}>
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
                    <td className="cell-value mono">
                      {isPathList(entry.value) ? (
                        <PathList value={entry.value} />
                      ) : entry.value ? (
                        entry.value
                      ) : (
                        <span className="muted">（空）</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${entry.kind === 'ExpandString' ? 'blue' : ''}`}>{entry.kind}</span>
                    </td>
                    <td>
                      <div className="cell-actions">
                        <button className="btn small" onClick={() => openEditor('edit', entry)}>
                          编辑
                        </button>
                        <button className="btn small danger" onClick={() => setPendingRemove(entry.name)} disabled={busy}>
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
            <label className="field-label">
              变量值{edit.editor === 'list' ? `（${edit.items.length} 项）` : '（总文本）'}
            </label>
            {edit.editor === 'list' ? (
              <PathEditor items={edit.items} onChange={(items) => setEdit({ ...edit, items })} />
            ) : (
              <textarea
                className="textarea"
                rows={7}
                placeholder="例如：D:\EnvThaw\jdk\17;D:\EnvThaw\git\bin"
                value={edit.value}
                onChange={(event) => setEdit({ ...edit, value: event.target.value })}
                autoFocus
              />
            )}
            <div className="value-editor-tail">
              <span className="field-hint">
                {edit.editor === 'list'
                  ? '每行一个路径，保存时用分号连接；空行会被忽略，顺序即查找优先级。'
                  : '整段文本原样写入；多路径请用分号分隔，包含 %VAR% 时按 REG_EXPAND_SZ 保存。'}
              </span>
              <button
                className="value-mode-toggle"
                onClick={toggleEditor}
                title={edit.editor === 'list' ? '切换为总文本编辑' : '切换为列表编辑'}
                aria-label={edit.editor === 'list' ? '切换为总文本编辑' : '切换为列表编辑'}
              >
                <span className="value-mode-glyph" aria-hidden="true">
                  ⇄
                </span>
              </button>
            </div>
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

      {pendingRemove ? (
        <ConfirmDialog
          title="删除环境变量"
          tone="danger"
          confirmLabel="删除"
          busy={busy}
          message={`确定删除用户环境变量 ${pendingRemove}？`}
          detail="删除前会自动创建回滚点，可在「快照与恢复」里一键撤销。"
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => void remove(pendingRemove)}
        />
      ) : null}
    </div>
  )
}
