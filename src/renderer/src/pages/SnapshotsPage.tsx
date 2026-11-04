import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { DiffEntry, EnvSnapshot } from '../../../shared/ipc-types'
import { api, diffSummary, errorText, formatTime } from '../lib/api'
import { useToast } from '../components/Toast'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Modal } from '../components/Modal'
import { DiffTable } from '../components/DiffTable'

export function SnapshotsPage(): ReactElement {
  const toast = useToast()
  const [snapshots, setSnapshots] = useState<EnvSnapshot[]>([])
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<{ snapshot: EnvSnapshot; entries: DiffEntry[] } | null>(null)
  const [rollbackId, setRollbackId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<EnvSnapshot | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setSnapshots(await api.env.snapshots())
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function create(): Promise<void> {
    setBusy(true)
    try {
      const snapshot = await api.env.saveSnapshot(name.trim() || `快照 ${new Date().toLocaleString()}`)
      setName('')
      setCreateOpen(false)
      await load()
      toast('success', `已保存快照「${snapshot.name}」`)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function openDiff(snapshot: EnvSnapshot): Promise<void> {
    setBusy(true)
    try {
      const entries = await api.env.diff(snapshot.id)
      setDiff({ snapshot, entries })
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function apply(): Promise<void> {
    if (!diff) return
    setBusy(true)
    try {
      const result = await api.env.apply(diff.snapshot.id)
      if (result.failed.length > 0) {
        toast('error', `部分失败：${result.failed.map((item) => `${item.name}: ${item.error}`).join('；')}`)
      } else {
        toast('success', `已应用 ${result.applied} 项变更`)
      }
      setRollbackId(result.rollbackId)
      setDiff({ snapshot: diff.snapshot, entries: await api.env.diff(diff.snapshot.id) })
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function rollback(): Promise<void> {
    if (!rollbackId) return
    setBusy(true)
    try {
      const result = await api.env.rollback(rollbackId)
      toast('success', `已回滚 ${result.applied} 项变更`)
      setRollbackId(null)
      setDiff(null)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function remove(snapshot: EnvSnapshot): Promise<void> {
    setPendingDelete(null)
    setBusy(true)
    try {
      await api.env.deleteSnapshot(snapshot.id)
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
        <span className="muted">快照保存在非保护盘，重启/冰点还原后仍可用于恢复。</span>
        <div className="spacer" />
        <button className="btn" onClick={() => void load()} disabled={busy}>
          刷新
        </button>
        <button className="btn primary" onClick={() => setCreateOpen(true)}>
          保存当前环境
        </button>
      </div>

      {snapshots.length === 0 ? (
        <div className="card">
          <div className="empty">
            <strong>还没有快照</strong>
            先在「环境变量」页面配置好环境，再回到这里保存一份。
          </div>
        </div>
      ) : (
        <div className="grid cols-3">
          {snapshots.map((snapshot) => (
            <div key={snapshot.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <h3 className="card-title">{snapshot.name}</h3>
                <span className="badge blue">{Object.keys(snapshot.userVars).length} 变量</span>
              </div>
              <p className="card-sub">{formatTime(snapshot.createdAt)}</p>
              {snapshot.note ? <p className="muted" style={{ marginTop: 8 }}>{snapshot.note}</p> : null}
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn small primary" onClick={() => void openDiff(snapshot)} disabled={busy}>
                  查看差异 / 恢复
                </button>
                <button className="btn small danger" onClick={() => setPendingDelete(snapshot)} disabled={busy}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {createOpen ? (
        <Modal
          title="保存当前环境为快照"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button className="btn primary" onClick={() => void create()} disabled={busy}>
                保存
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label">快照名称</label>
            <input className="input" value={name} placeholder="例如：机房 A 标准环境" onChange={(event) => setName(event.target.value)} autoFocus />
          </div>
        </Modal>
      ) : null}

      {diff ? (
        <Modal
          title={`恢复「${diff.snapshot.name}」`}
          subtitle={`${diffSummary(diff.entries).added} 项新增 · ${diffSummary(diff.entries).modified} 项修改 · ${diffSummary(diff.entries).removed} 项删除`}
          width={980}
          onClose={() => {
            setDiff(null)
            setRollbackId(null)
          }}
          footer={
            <>
              <button
                className="btn"
                onClick={() => {
                  setDiff(null)
                  setRollbackId(null)
                }}
              >
                关闭
              </button>
              {rollbackId ? (
                <button className="btn danger" onClick={() => void rollback()} disabled={busy}>
                  撤销这次恢复
                </button>
              ) : null}
              <button className="btn primary" onClick={() => void apply()} disabled={busy || diff.entries.length === 0}>
                应用 {diff.entries.length} 项变更
              </button>
            </>
          }
        >
          <DiffTable entries={diff.entries} />
          <p className="muted">应用前会自动创建回滚点，失败或误操作时可一键撤销。</p>
        </Modal>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="删除快照"
          tone="danger"
          confirmLabel="删除快照"
          busy={busy}
          message={`删除快照「${pendingDelete.name}」？`}
          detail="只删除这份快照记录，不会改动当前环境变量。"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void remove(pendingDelete)}
        />
      ) : null}
    </div>
  )
}
