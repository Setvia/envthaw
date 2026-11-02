import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AppInfo, AuditEntry, EnvSnapshot, EnvVarEntry, ScriptEntry } from '../../../shared/ipc-types'
import { api, errorText, formatTime } from '../lib/api'
import { useToast } from '../components/Toast'
import { Modal } from '../components/Modal'

interface DashboardProps {
  onNavigate: (page: string) => void
}

export function Dashboard({ onNavigate }: DashboardProps): ReactElement {
  const toast = useToast()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [vars, setVars] = useState<EnvVarEntry[]>([])
  const [snapshots, setSnapshots] = useState<EnvSnapshot[]>([])
  const [scripts, setScripts] = useState<ScriptEntry[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [snapshotName, setSnapshotName] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [appInfo, envVars, snapshotList, scriptList, auditList] = await Promise.all([
        api.app.info(),
        api.env.list(),
        api.env.snapshots(),
        api.scripts.list(),
        api.audit.list(6)
      ])
      setInfo(appInfo)
      setVars(envVars)
      setSnapshots(snapshotList)
      setScripts(scriptList)
      setAudit(auditList)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function saveSnapshot(): Promise<void> {
    setBusy(true)
    try {
      const snapshot = await api.env.saveSnapshot(snapshotName.trim() || `快照 ${new Date().toLocaleString()}`)
      setSnapshots((current) => [snapshot, ...current])
      setSnapshotOpen(false)
      setSnapshotName('')
      toast('success', `已保存快照「${snapshot.name}」`)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function openConfigDir(): Promise<void> {
    try {
      await api.app.openConfigDir()
    } catch (error) {
      toast('error', errorText(error))
    }
  }

  return (
    <div className="stack">
      <div className="grid cols-4">
        <div className="card">
          <p className="card-title">用户环境变量</p>
          <div className="stat-value">{vars.length}</div>
          <p className="stat-label">HKCU\Environment</p>
          <button className="btn small ghost" style={{ marginTop: 8, paddingLeft: 0 }} onClick={() => onNavigate('env')}>
            管理 →
          </button>
        </div>
        <div className="card">
          <p className="card-title">环境快照</p>
          <div className="stat-value">{snapshots.length}</div>
          <p className="stat-label">可一键恢复</p>
          <button className="btn small ghost" style={{ marginTop: 8, paddingLeft: 0 }} onClick={() => onNavigate('snapshots')}>
            查看 →
          </button>
        </div>
        <div className="card">
          <p className="card-title">脚本库</p>
          <div className="stat-value">{scripts.length}</div>
          <p className="stat-label">执行前自带 dry-run</p>
          <button className="btn small ghost" style={{ marginTop: 8, paddingLeft: 0 }} onClick={() => onNavigate('scripts')}>
            打开 →
          </button>
        </div>
        <div className="card">
          <p className="card-title">配置目录</p>
          <div
            className="stat-value dash-path"
            title={info?.configDir ?? ''}
            style={{ fontSize: 15, marginTop: 14, fontWeight: 600 }}
          >
            {info?.configDir ?? '读取中…'}
          </div>
          <p className="stat-label" style={{ marginTop: 6 }}>
            固定在项目内 · 已 gitignore
          </p>
          <button className="btn small ghost" style={{ marginTop: 6, paddingLeft: 0 }} onClick={() => void openConfigDir()}>
            在资源管理器中打开 →
          </button>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3 className="card-title">一键动作</h3>
          <p className="card-sub">把当前机器状态存成快照，换机房时直接恢复。</p>
          <div className="row wrap" style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={() => setSnapshotOpen(true)} disabled={busy}>
              保存当前环境为快照
            </button>
            <button className="btn" onClick={() => onNavigate('redirect')} disabled={busy}>
              配置路径重定向
            </button>
            <button className="btn" onClick={() => onNavigate('scripts')} disabled={busy}>
              运行脚本
            </button>
          </div>
          <div className="hr" style={{ margin: '16px 0' }} />
          <dl className="muted" style={{ margin: 0, lineHeight: 1.9 }}>
            <div>版本：EnvThaw {info?.appVersion ?? '—'} · Electron {info?.electron ?? '—'} · Node {info?.node ?? '—'}</div>
            <div>
              权限：{info?.isElevated ? <span className="badge amber">管理员（请谨慎操作）</span> : <span className="badge green">普通用户</span>}{' '}
              <span className="muted">核心功能不需要管理员权限</span>
            </div>
          </dl>
        </div>

        <div className="card tight">
          <div style={{ padding: '16px 18px 8px' }}>
            <h3 className="card-title">最近操作</h3>
            <p className="card-sub">所有写操作都会留下审计记录。</p>
          </div>
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="table">
              <tbody>
                {audit.length === 0 ? (
                  <tr>
                    <td className="muted">还没有操作记录。</td>
                  </tr>
                ) : (
                  audit.map((entry) => (
                    <tr key={entry.id}>
                      <td style={{ width: 128 }} className="muted">
                        {formatTime(entry.at)}
                      </td>
                      <td>
                        <span className={`badge ${entry.ok ? 'green' : 'red'}`}>{entry.action}</span>
                      </td>
                      <td className="cell-value">{entry.detail}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {snapshotOpen ? (
        <Modal
          title="保存当前环境为快照"
          subtitle="只记录用户级变量（HKCU\Environment），不会触碰系统级变量。"
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
              placeholder="例如：Python 数据分析课"
              value={snapshotName}
              onChange={(event) => setSnapshotName(event.target.value)}
              autoFocus
            />
            <span className="field-hint">共将保存 {vars.length} 个用户级环境变量。</span>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
