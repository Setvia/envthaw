import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { DryRunReport, RunResult, ScriptEntry, ScriptType } from '../../../shared/ipc-types'
import { api, errorText, formatTime } from '../lib/api'
import { useToast } from '../components/Toast'

interface Draft {
  id: string
  name: string
  type: ScriptType
  content: string
  createdAt?: number
}

const TEMPLATE: Record<ScriptType, string> = {
  batch: `@echo off\r\nREM 示例：把 JDK 指向非保护盘\r\nsetx JAVA_HOME "D:\\EnvThaw\\jdk\\17"\r\nmkdir "D:\\EnvThaw\\maven-repo"\r\n`,
  powershell: `# 示例：把 pip 缓存指向非保护盘（当前用户永久生效）\r\n[Environment]::SetEnvironmentVariable('PIP_CACHE_DIR', 'D:\\EnvThaw\\cache\\pip', 'User')\r\nNew-Item -ItemType Directory -Path 'D:\\EnvThaw\\cache\\pip' -Force | Out-Null\r\n`
}

function newDraft(): Draft {
  return {
    id: `script-${Date.now().toString(36)}`,
    name: '新脚本',
    type: 'powershell',
    content: TEMPLATE.powershell
  }
}

export function ScriptsPage(): ReactElement {
  const toast = useToast()
  const [scripts, setScripts] = useState<ScriptEntry[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<DryRunReport | null>(null)
  const [run, setRun] = useState<RunResult | null>(null)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const list = await api.scripts.list()
      setScripts(list)
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
    if (!window.confirm(`执行脚本「${draft.name}」？\n执行前会自动保存一份环境快照。`)) return

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
    if (!window.confirm(`删除脚本「${draft.name}」？`)) return
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

  return (
    <div className="stack">
      <div className="toolbar">
        <span className="muted">脚本只在手动点击执行时运行；执行前强制 dry-run 预览写操作。</span>
        <div className="spacer" />
        <button
          className="btn"
          onClick={() => {
            setDraft(newDraft())
            setReport(null)
            setRun(null)
            setDirty(true)
          }}
          disabled={busy}
        >
          新建脚本
        </button>
      </div>

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
                  {entry.type === 'batch' ? '批处理' : 'PowerShell'}
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
                    value={draft.type}
                    onChange={(event) => {
                      const type = event.target.value as ScriptType
                      patch({ type, content: draft.content.trim() ? draft.content : TEMPLATE[type] })
                    }}
                  >
                    <option value="powershell">PowerShell</option>
                    <option value="batch">批处理 (.cmd)</option>
                  </select>
                  <div className="spacer" style={{ flex: 1 }} />
                  <button className="btn" onClick={() => void save()} disabled={busy}>
                    保存
                  </button>
                  <button className="btn" onClick={() => void dryRun()} disabled={busy}>
                    Dry-run
                  </button>
                  <button className="btn primary" onClick={() => void execute()} disabled={busy}>
                    执行
                  </button>
                  <button className="btn danger" onClick={() => void remove()} disabled={busy}>
                    删除
                  </button>
                </div>
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
                脚本保存在非保护盘，可作为课程环境的“一键准备”脚本。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
