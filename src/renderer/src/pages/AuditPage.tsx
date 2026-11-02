import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AuditEntry } from '../../../shared/ipc-types'
import { api, errorText, formatTime } from '../lib/api'
import { useToast } from '../components/Toast'

export function AuditPage(): ReactElement {
  const toast = useToast()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setEntries(await api.audit.list(300))
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="stack">
      <div className="toolbar">
        <span className="muted">记录每一次环境变量写入、快照恢复、脚本执行和配置导入导出。</span>
        <div className="spacer" />
        <button className="btn" onClick={() => void load()} disabled={busy}>
          刷新
        </button>
      </div>
      <div className="card tight">
        <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 230px)' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>时间</th>
                <th style={{ width: 170 }}>动作</th>
                <th>详情</th>
                <th style={{ width: 80 }}>结果</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty">
                    还没有审计记录。
                  </td>
                </tr>
              ) : (
                entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="muted">{formatTime(entry.at)}</td>
                    <td className="mono">{entry.action}</td>
                    <td className="cell-value">{entry.detail}</td>
                    <td>
                      <span className={`badge ${entry.ok ? 'green' : 'red'}`}>{entry.ok ? '成功' : '失败'}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
