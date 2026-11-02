import type { ReactElement } from 'react'
import type { DiffEntry } from '../../../shared/ipc-types'
import { kindLabel } from '../lib/api'

export function DiffTable({ entries, emptyText }: { entries: DiffEntry[]; emptyText?: string }): ReactElement {
  if (entries.length === 0) {
    return <div className="empty">{emptyText ?? '当前状态与目标一致，无需变更。'}</div>
  }

  return (
    <div className="table-wrap" style={{ maxHeight: 420, border: '1px solid var(--border)', borderRadius: 10 }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 74 }}>变更</th>
            <th style={{ width: 200 }}>变量名</th>
            <th>当前值</th>
            <th>目标值</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={`${entry.kind}-${entry.name}`} className={`diff-row ${entry.kind}`}>
              <td>
                <span className={`badge ${entry.kind === 'added' ? 'green' : entry.kind === 'removed' ? 'red' : 'amber'}`}>
                  {kindLabel(entry.kind)}
                </span>
              </td>
              <td className="mono">{entry.name}</td>
              <td className="cell-value mono">{entry.before ?? <span className="muted">（不存在）</span>}</td>
              <td className="cell-value mono">{entry.after ?? <span className="muted">（将删除）</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
