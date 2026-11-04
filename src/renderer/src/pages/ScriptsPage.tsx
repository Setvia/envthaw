import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react'
import type {
  DryRunReport,
  RunResult,
  ScriptEntry,
  ScriptImportWarning,
  ScriptTemplate,
  ScriptType
} from '../../../shared/ipc-types'
import { api, errorText, formatTime } from '../lib/api'
import { useToast } from '../components/Toast'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Modal } from '../components/Modal'

interface Draft {
  id: string
  name: string
  type: ScriptType
  content: string
  createdAt?: number
}

function typeLabel(type: ScriptType): string {
  if (type === 'batch') return '批处理'
  if (type === 'powershell') return 'PowerShell'
  return '其他文件'
}

function draftFromTemplate(template: ScriptTemplate): Draft {
  return {
    id: `script-${Date.now().toString(36)}`,
    name: template.name,
    type: template.type,
    content: template.content
  }
}

function emptyDraft(): Draft {
  return { id: `script-${Date.now().toString(36)}`, name: '新脚本', type: 'powershell', content: '# 在这里编写脚本\r\n' }
}

export function ScriptsPage(): ReactElement {
  const toast = useToast()
  const [scripts, setScripts] = useState<ScriptEntry[]>([])
  const [templates, setTemplates] = useState<ScriptTemplate[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'run' | 'delete' | null>(null)
  const [report, setReport] = useState<DryRunReport | null>(null)
  const [run, setRun] = useState<RunResult | null>(null)
  const [dirty, setDirty] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [importWarnings, setImportWarnings] = useState<ScriptImportWarning[]>([])
  const dragDepth = useRef(0)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [list, templateList] = await Promise.all([api.scripts.list(), api.scripts.templates()])
      setScripts(list)
      setTemplates(templateList)
      setDraft((current) => current ?? (list[0] ? { ...list[0] } : null))
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  function select(entry: ScriptEntry): void {
    setDraft({ ...entry })
    setReport(null)
    setRun(null)
    setDirty(false)
  }

  function patch(changes: Partial<Draft>): void {
    setDraft((current) => (current ? { ...current, ...changes } : current))
    setDirty(true)
  }

  async function save(): Promise<ScriptEntry | null> {
    if (!draft) return null
    if (!draft.name.trim()) {
      toast('error', '脚本名不能为空')
      return null
    }
    setBusy(true)
    try {
      const saved = await api.scripts.save({
        id: draft.id,
        name: draft.name.trim(),
        type: draft.type,
        content: draft.content,
        createdAt: draft.createdAt
      })
      setDraft({ ...saved })
      setDirty(false)
      await load()
      toast('success', `已保存「${saved.name}」`)
      return saved
    } catch (error) {
      toast('error', errorText(error))
      return null
    } finally {
      setBusy(false)
    }
  }

  async function dryRun(): Promise<void> {
    const saved = dirty || !draft?.createdAt ? await save() : draft
    if (!saved) return
    setBusy(true)
    setRun(null)
    try {
      setReport(await api.scripts.dryRun(saved.id))
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function execute(): Promise<void> {
    if (!draft) return
    if (dirty || !draft.createdAt) {
      const saved = await save()
      if (!saved) return
    }
    setConfirmAction('run')
  }

  async function runConfirmed(): Promise<void> {
    if (!draft) return
    setConfirmAction(null)
    setBusy(true)
    setRun(null)
    try {
      const result = await api.scripts.run(draft.id)
      setRun(result)
      if (result.exitCode === 0) toast('success', '脚本执行完成（exit 0）')
      else toast('error', `脚本退出码 ${result.exitCode}${result.timedOut ? '（超时）' : ''}`)
      await load()
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!draft) return
    setConfirmAction('delete')
  }

  async function removeConfirmed(): Promise<void> {
    if (!draft) return
    setConfirmAction(null)
    setBusy(true)
    try {
      await api.scripts.remove(draft.id)
      setDraft(null)
      setReport(null)
      setRun(null)
      await load()
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function openFolder(): Promise<void> {
    try {
      await api.scripts.openFolder()
    } catch (error) {
      toast('error', errorText(error))
    }
  }

  async function importDropped(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      toast('error', '没有拿到文件路径，无法导入')
      return
    }
    setBusy(true)
    try {
      const result = await api.scripts.importFiles(paths)
      setImportWarnings(result.warnings)
      await load()
      if (result.added.length > 0) {
        const last = result.added[result.added.length - 1]
        setDraft({ ...last })
        setReport(null)
        setRun(null)
        setDirty(false)
        toast('success', `已添加 ${result.added.length} 个文件（已拷贝到脚本库）`)
      }
      for (const warning of result.warnings) {
        toast('warn', `${warning.file}：${warning.reason}`)
      }
      if (result.added.length === 0 && result.warnings.length === 0) {
        toast('error', '没有可添加的文件')
      }
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    dragDepth.current += 1
    if (event.dataTransfer.types.includes('Files')) setDragging(true)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    // File objects cannot cross the bridge; resolve absolute paths in preload.
    const paths = files.map((file) => api.files.pathFor(file)).filter((value): value is string => Boolean(value))
    await importDropped(paths)
  }

  const runnable = draft ? draft.type !== 'other' : false

  return (
    <div
      className="stack drop-zone"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      {dragging ? (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-icon">⇩</div>
            <strong>拖拽到此处以添加脚本</strong>
            <span>文件会被拷贝到当前用户的脚本库目录；非脚本文件也可以添加，但不能执行</span>
          </div>
        </div>
      ) : null}

      <div className="toolbar">
        <span className="muted">脚本只在手动点击执行时运行；执行前强制 dry-run 预览写操作。</span>
        <div className="spacer" />
        <button className="btn" onClick={() => void openFolder()} disabled={busy}>
          在资源管理器中查看
        </button>
        <button className="btn primary" onClick={() => setPickerOpen(true)} disabled={busy}>
          新建脚本
        </button>
      </div>

      {importWarnings.length > 0 ? (
        <div className="card" style={{ padding: '12px 14px' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong style={{ fontSize: 13 }}>导入告警</strong>
            <button className="btn small ghost" onClick={() => setImportWarnings([])}>
              知道了
            </button>
          </div>
          <ul className="muted" style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
            {importWarnings.map((warning, index) => (
              <li key={`${warning.file}-${index}`}>
                <span className="mono">{warning.file}</span>：{warning.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="split" style={{ gridTemplateColumns: '270px minmax(0, 1fr)' }}>
        <div className="list">
          {scripts.length === 0 ? (
            <div className="card">
              <div className="empty" style={{ padding: '20px 10px' }}>
                还没有脚本
              </div>
            </div>
          ) : (
            scripts.map((entry) => (
              <button
                key={entry.id}
                className={`list-item ${draft?.id === entry.id ? 'active' : ''}`}
                onClick={() => select(entry)}
              >
                <span className="list-item-title">{entry.name}</span>
                <span className="list-item-sub">
                  {typeLabel(entry.type)}
                  {entry.lastExitCode !== undefined ? ` · exit ${entry.lastExitCode}` : ''}
                  {entry.lastRunAt ? ` · ${formatTime(entry.lastRunAt)}` : ''}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="stack">
          {draft ? (
            <>
              <div className="card stack" style={{ gap: 14 }}>
                <div className="row">
                  <input
                    className="input"
                    style={{ maxWidth: 360 }}
                    value={draft.name}
                    onChange={(event) => patch({ name: event.target.value })}
                    placeholder="脚本名称"
                  />
                  <select
                    className="select"
                    style={{ width: 160 }}
                    value={draft.type === 'other' ? 'other' : draft.type}
                    disabled={draft.type === 'other'}
                    onChange={(event) => {
                      const type = event.target.value as ScriptType
                      patch({ type, content: draft.content.trim() ? draft.content : '' })
                    }}
                  >
                    <option value="powershell">PowerShell</option>
                    <option value="batch">批处理 (.cmd)</option>
                    {draft.type === 'other' ? <option value="other">其他文件</option> : null}
                  </select>
                  <div className="spacer" style={{ flex: 1 }} />
                  <button className="btn" onClick={() => void save()} disabled={busy}>
                    保存
                  </button>
                  <button className="btn" onClick={() => void dryRun()} disabled={busy || !runnable}>
                    Dry-run
                  </button>
                  <button className="btn primary" onClick={() => void execute()} disabled={busy || !runnable}>
                    执行
                  </button>
                  <button className="btn danger" onClick={() => void remove()} disabled={busy}>
                    删除
                  </button>
                </div>
                {draft.type === 'other' ? (
                  <div className="badge amber" style={{ height: 'auto', padding: '8px 10px', whiteSpace: 'normal' }}>
                    这个文件不是可执行的脚本后缀（.bat / .cmd / .ps1），已经拷贝进脚本库但无法运行。
                  </div>
                ) : null}
                <textarea
                  className="textarea"
                  rows={14}
                  spellCheck={false}
                  value={draft.content}
                  onChange={(event) => patch({ content: event.target.value })}
                />
                <span className="field-hint">
                  {dirty ? '有未保存的修改（执行/dry-run 前会自动保存）。' : '已保存。'} 超时时间 180 秒，超时后会结束整个进程树。
                </span>
              </div>

              {report ? (
                <div className="card">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <h3 className="card-title">Dry-run 预览</h3>
                    <span className="badge blue">{report.changes.length} 项写操作</span>
                  </div>
                  <p className="card-sub">静态分析脚本中的 set / setx / reg add / mkdir / SetEnvironmentVariable 等写操作，不执行任何命令。</p>

                  {report.changes.length > 0 ? (
                    <div className="table-wrap" style={{ marginTop: 12, maxHeight: 260, border: '1px solid var(--border)', borderRadius: 10 }}>
                      <table className="table">
                        <thead>
                          <tr>
                            <th style={{ width: 60 }}>行</th>
                            <th style={{ width: 90 }}>类型</th>
                            <th>目标</th>
                            <th>变更内容</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.changes.map((change, index) => (
                            <tr key={`${change.line}-${index}`}>
                              <td className="muted">{change.line}</td>
                              <td>
                                <span className={`badge ${change.kind === 'delete' ? 'red' : change.kind === 'mkdir' ? 'purple' : 'blue'}`}>
                                  {change.kind}
                                </span>
                              </td>
                              <td className="mono">{change.target}</td>
                              <td className="cell-value mono">{change.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {report.warnings.length > 0 ? (
                    <div style={{ marginTop: 12 }}>
                      {report.warnings.map((warning) => (
                        <div key={warning} className="badge amber" style={{ display: 'block', height: 'auto', padding: '6px 10px', marginBottom: 6, whiteSpace: 'normal' }}>
                          {warning}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {run ? (
                <div className="card">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <h3 className="card-title">执行输出</h3>
                    <div className="row">
                      <span className={`badge ${run.exitCode === 0 ? 'green' : 'red'}`}>exit {run.exitCode}</span>
                      <span className="badge">{run.durationMs} ms</span>
                      {run.timedOut ? <span className="badge amber">已超时终止</span> : null}
                    </div>
                  </div>
                  <div className="console" style={{ marginTop: 12 }}>
                    {run.stdout ? <div>{run.stdout}</div> : <div className="dim">（无标准输出）</div>}
                    {run.stderr ? <div style={{ color: '#ffb4b4' }}>{run.stderr}</div> : null}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="card">
              <div className="empty">
                <strong>选择或新建一个脚本</strong>
                示例脚本与模板都在项目配置里维护，不再写死在界面中。
              </div>
            </div>
          )}
        </div>
      </div>

      {pickerOpen ? (
        <Modal
          title="从模板新建脚本"
          subtitle="模板来自 presets/script-templates.json，改模板不用改代码。"
          width={720}
          onClose={() => setPickerOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setPickerOpen(false)}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setDraft(emptyDraft())
                  setReport(null)
                  setRun(null)
                  setDirty(true)
                  setPickerOpen(false)
                }}
              >
                空白脚本
              </button>
            </>
          }
        >
          {templates.length === 0 ? (
            <div className="empty">
              <strong>没有可用模板</strong>
              请检查 presets/script-templates.json 是否存在且格式正确。
            </div>
          ) : (
            <div className="template-grid">
              {templates.map((template) => (
                <button
                  key={template.id}
                  className="template-card"
                  onClick={() => {
                    setDraft(draftFromTemplate(template))
                    setReport(null)
                    setRun(null)
                    setDirty(true)
                    setPickerOpen(false)
                  }}
                >
                  <strong>{template.name}</strong>
                  <span>{template.type === 'batch' ? '批处理' : 'PowerShell'} · {template.id}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      ) : null}

      {confirmAction ? (
        <ConfirmDialog
          title={confirmAction === 'run' ? '执行脚本' : '删除脚本'}
          tone={confirmAction === 'run' ? 'default' : 'danger'}
          confirmLabel={confirmAction === 'run' ? '执行' : '删除'}
          busy={busy}
          message={
            confirmAction === 'run' ? `执行脚本「${draft?.name ?? ''}」？` : `删除脚本「${draft?.name ?? ''}」？`
          }
          detail={
            confirmAction === 'run'
              ? '执行前会自动保存一份环境快照，脚本输出会在下方显示。'
              : '脚本文件与记录都会被移除，且不可恢复。'
          }
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => (confirmAction === 'run' ? void runConfirmed() : void removeConfirmed())}
        />
      ) : null}
    </div>
  )
}
