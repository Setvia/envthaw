import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AppInfo, AppSettings } from '../../../shared/ipc-types'
import { api, errorText } from '../lib/api'
import { useToast } from '../components/Toast'

export function SettingsPage(): ReactElement {
  const toast = useToast()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [current, appInfo] = await Promise.all([api.settings.get(), api.app.info()])
      setSettings(current)
      setInfo(appInfo)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  function patch(changes: Partial<AppSettings>): void {
    setSettings((current) => (current ? { ...current, ...changes } : current))
  }

  async function chooseRoot(): Promise<void> {
    if (!settings) return
    try {
      const chosen = await api.app.chooseDirectory(settings.storageRoot)
      if (chosen) patch({ storageRoot: chosen })
    } catch (error) {
      toast('error', errorText(error))
    }
  }

  async function save(): Promise<void> {
    if (!settings) return
    setBusy(true)
    try {
      const saved = await api.settings.save(settings)
      setSettings(saved)
      await load()
      toast('success', '设置已保存')
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function exportBundle(): Promise<void> {
    setBusy(true)
    try {
      const saved = await api.transfer.saveBundleToDisk()
      if (saved) toast('success', `已导出到 ${saved}`)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function importBundle(): Promise<void> {
    setBusy(true)
    try {
      const bundle = await api.transfer.loadBundleFromDisk()
      if (!bundle) return
      const result = await api.transfer.importBundle(bundle)
      await load()
      toast('success', `已导入：快照 ${result.snapshots} 个，脚本 ${result.scripts} 个`)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="grid cols-2">
        <div className="card stack" style={{ gap: 16 }}>
          <div>
            <h3 className="card-title">存储位置</h3>
            <p className="card-sub">快照、脚本、审计日志都会写入这里。C 盘会被冰点还原，建议放在 D 盘或 U 盘。</p>
          </div>
          <div className="field">
            <label className="field-label">数据目录</label>
            <div className="row">
              <input className="input mono" value={settings?.storageRoot ?? ''} onChange={(event) => patch({ storageRoot: event.target.value })} />
              <button className="btn" onClick={() => void chooseRoot()}>
                选择…
              </button>
            </div>
            <span className="field-hint">切换目录后，已有数据不会自动迁移；请手动复制旧目录下的 JSON 文件。</span>
          </div>
          <div className="hr" />
          <div className="field">
            <label className="field-label">执行脚本前自动保存快照</label>
            <label className="row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={settings?.autoSnapshotBeforeRun ?? true}
                onChange={(event) => patch({ autoSnapshotBeforeRun: event.target.checked })}
              />
              <span className="muted">脚本改环境前先留一份可回退的状态</span>
            </label>
          </div>
          <div className="field">
            <label className="field-label">恢复快照前自动保存回滚点</label>
            <label className="row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={settings?.autoSnapshotBeforeRestore ?? true}
                onChange={(event) => patch({ autoSnapshotBeforeRestore: event.target.checked })}
              />
              <span className="muted">应用 diff 之前记录当前变量，便于一键撤销</span>
            </label>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => void save()} disabled={busy}>
              保存设置
            </button>
            <button className="btn" onClick={() => void load()} disabled={busy}>
              重置
            </button>
          </div>
        </div>

        <div className="card stack" style={{ gap: 16 }}>
          <div>
            <h3 className="card-title">配置包</h3>
            <p className="card-sub">导出为 JSON，可以拷进 U 盘、放进网盘，或者下节课直接导入。</p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => void exportBundle()} disabled={busy}>
              导出配置包…
            </button>
            <button className="btn" onClick={() => void importBundle()} disabled={busy}>
              导入配置包…
            </button>
          </div>
          <div className="hr" />
          <div>
            <h3 className="card-title">运行环境</h3>
            <dl className="muted" style={{ lineHeight: 2, margin: 0 }}>
              <div>EnvThaw：{info?.appVersion ?? '—'}</div>
              <div>Electron：{info?.electron ?? '—'} · Node {info?.node ?? '—'} · Chromium {info?.chrome ?? '—'}</div>
              <div>系统：{info?.platform ?? '—'} {info?.osRelease ?? ''}</div>
              <div>权限：{info?.isElevated ? '管理员' : '普通用户'}</div>
            </dl>
          </div>
          <div className="hr" />
          <div>
            <h3 className="card-title">数据文件</h3>
            <dl className="muted mono" style={{ lineHeight: 1.9, margin: 0, wordBreak: 'break-all' }}>
              <div>快照：{info?.dataFiles.snapshots ?? '—'}</div>
              <div>脚本：{info?.dataFiles.scripts ?? '—'}</div>
              <div>审计：{info?.dataFiles.audit ?? '—'}</div>
              <div>回滚点：{info?.dataFiles.rollbacks ?? '—'}</div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}
