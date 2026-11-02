import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AppInfo, AppSettings, UpdateProgress, UpdateState } from '../../../shared/ipc-types'
import { api, errorText, formatTime } from '../lib/api'
import { useToast } from '../components/Toast'

const STATUS_TEXT: Record<UpdateState['status'], string> = {
  idle: '尚未检查',
  checking: '正在检查更新…',
  'up-to-date': '已是最新版本',
  available: '发现新版本',
  downloading: '正在下载…',
  downloaded: '安装包已下载',
  error: '检查失败'
}

const STATUS_TONE: Record<UpdateState['status'], string> = {
  idle: '',
  checking: 'blue',
  'up-to-date': 'green',
  available: 'amber',
  downloading: 'blue',
  downloaded: 'green',
  error: 'red'
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function SettingsPage(): ReactElement {
  const toast = useToast()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [current, appInfo, updateState] = await Promise.all([api.settings.get(), api.app.info(), api.update.getState()])
      setSettings(current)
      setInfo(appInfo)
      setUpdate(updateState)
      setProgress(updateState.progress ?? null)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const offState = api.update.onState((state) => {
      setUpdate(state)
      if (state.progress) setProgress(state.progress)
    })
    const offProgress = api.update.onProgress(setProgress)
    return () => {
      offState()
      offProgress()
    }
  }, [])

  function patch(changes: Partial<AppSettings>): void {
    setSettings((current) => (current ? { ...current, ...changes } : current))
  }

  async function save(): Promise<void> {
    if (!settings) return
    setBusy(true)
    try {
      const saved = await api.settings.save(settings)
      setSettings(saved)
      setUpdate(await api.update.getState())
      toast('success', '设置已保存')
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function checkUpdate(): Promise<void> {
    setBusy(true)
    setProgress(null)
    try {
      const state = await api.update.check()
      setUpdate(state)
      if (state.status === 'error') toast('error', `检查更新失败：${state.error ?? ''}`)
      else if (state.status === 'up-to-date') toast('success', '已经是最新版本')
      else if (state.status === 'available') toast('success', `发现新版本 ${state.release?.version ?? ''}`)
      else if (!state.configured) toast('info', '还没有配置更新源')
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function download(): Promise<void> {
    setBusy(true)
    try {
      const state = await api.update.download()
      setUpdate(state)
      if (state.status === 'downloaded') toast('success', '安装包已下载完成')
      else if (state.status === 'error') toast('error', `下载失败：${state.error ?? ''}`)
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

  const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0

  return (
    <div className="stack">
      <div className="grid cols-2">
        <div className="card stack" style={{ gap: 16 }}>
          <div>
            <h3 className="card-title">配置目录</h3>
            <p className="card-sub">
              所有配置与状态都写在项目目录下的 <code>config/</code>，不会脱离项目；该目录已在 .gitignore 中。
            </p>
          </div>

          <div className="field">
            <label className="field-label">config</label>
            <div className="row">
              <input className="input mono" value={info?.configDir ?? ''} readOnly />
              <button className="btn" onClick={() => void api.app.openConfigDir()}>
                打开
              </button>
            </div>
          </div>
          <div className="field">
            <label className="field-label">data（重定向目录的默认位置）</label>
            <div className="row">
              <input className="input mono" value={info?.dataDir ?? ''} readOnly />
              <button className="btn" onClick={() => void api.app.openDataDir()}>
                打开
              </button>
            </div>
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
            <h3 className="card-title">检查更新</h3>
            <p className="card-sub">从 HTTPS 更新清单读取最新版本，下载后校验 SHA-256。网站上线前会显示「未配置更新源」。</p>
          </div>

          <div className="field">
            <label className="field-label">更新清单地址</label>
            <input
              className="input mono"
              placeholder="https://example.com/envthaw/latest.json"
              value={settings?.updateFeedUrl ?? ''}
              onChange={(event) => patch({ updateFeedUrl: event.target.value })}
            />
            <span className="field-hint">
              清单格式：{'{ "version": "0.2.0", "url": "https://…/EnvThaw-0.2.0.exe", "sha256": "…", "notes": "…" }'}
            </span>
          </div>

          <div className="update-head">
            <span className={`status-dot ${STATUS_TONE[update?.status ?? 'idle']}`} />
            <strong>{STATUS_TEXT[update?.status ?? 'idle']}</strong>
            <span className="muted">当前版本 {update?.currentVersion ?? info?.appVersion ?? '—'}</span>
            {update?.release?.version ? <span className="badge amber">最新 {update.release.version}</span> : null}
            {update?.checkedAt ? <span className="muted">· {formatTime(update.checkedAt)}</span> : null}
          </div>

          {update?.status === 'downloading' || (update?.status === 'downloaded' && progress) ? (
            <div className="stack" style={{ gap: 6 }}>
              <div className="progress">
                <span style={{ width: `${percent}%` }} />
              </div>
              <span className="muted">
                {progress ? `${formatBytes(progress.received)} / ${progress.total ? formatBytes(progress.total) : '未知大小'}` : ''}
                {percent ? ` · ${percent}%` : ''}
              </span>
            </div>
          ) : null}

          {update?.release?.notes ? <div className="release-notes">{update.release.notes}</div> : null}

          {update?.error ? (
            <div className="badge red" style={{ height: 'auto', padding: '8px 10px', whiteSpace: 'normal' }}>
              {update.error}
            </div>
          ) : null}

          {update?.status === 'downloaded' && update.filePath ? (
            <div className="field">
              <label className="field-label">安装包</label>
              <input className="input mono" value={update.filePath} readOnly />
            </div>
          ) : null}

          <div className="row wrap">
            <button className="btn" onClick={() => void checkUpdate()} disabled={busy || !settings?.updateFeedUrl}>
              检查更新
            </button>
            <button
              className="btn primary"
              onClick={() => void download()}
              disabled={busy || update?.status === 'downloading' || update?.status !== 'available'}
            >
              下载新版本
            </button>
            <button className="btn" onClick={() => void api.update.openDownloadFolder()}>
              打开下载目录
            </button>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card stack" style={{ gap: 14 }}>
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
              <div>
                Electron：{info?.electron ?? '—'} · Node {info?.node ?? '—'} · Chromium {info?.chrome ?? '—'}
              </div>
              <div>
                系统：{info?.platform ?? '—'} {info?.osRelease ?? ''}
              </div>
              <div>权限：{info?.isElevated ? '管理员' : '普通用户'}</div>
              <div>预设目录：{info?.presetsDir ?? '—'}</div>
            </dl>
          </div>
        </div>

        <div className="card stack" style={{ gap: 12 }}>
          <div>
            <h3 className="card-title">数据文件</h3>
            <p className="card-sub">都在 config/ 下，随项目目录一起备份或迁移。</p>
          </div>
          <dl className="muted mono" style={{ lineHeight: 1.9, margin: 0, wordBreak: 'break-all' }}>
            <div>设置：{info?.dataFiles.settings ?? '—'}</div>
            <div>快照：{info?.dataFiles.snapshots ?? '—'}</div>
            <div>脚本：{info?.dataFiles.scripts ?? '—'}</div>
            <div>审计：{info?.dataFiles.audit ?? '—'}</div>
            <div>回滚点：{info?.dataFiles.rollbacks ?? '—'}</div>
            <div>更新包：{info?.dataFiles.updates ?? '—'}</div>
          </dl>
        </div>
      </div>
    </div>
  )
}
