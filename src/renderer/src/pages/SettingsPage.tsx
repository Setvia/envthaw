import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AppInfo, AppSettings, CloudStatus, UpdateProgress, UpdateState } from '../../../shared/ipc-types'
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
  const [cloud, setCloud] = useState<CloudStatus | null>(null)
  const [cloudServer, setCloudServer] = useState('')
  const [cloudEmail, setCloudEmail] = useState('')
  const [cloudCode, setCloudCode] = useState('')
  const [cloudDevCode, setCloudDevCode] = useState('')
  const [cloudBusy, setCloudBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [current, appInfo, updateState, cloudState] = await Promise.all([
        api.settings.get(),
        api.app.info(),
        api.update.getState(),
        api.cloud.status()
      ])
      setSettings(current)
      setInfo(appInfo)
      setUpdate(updateState)
      setCloud(cloudState)
      setCloudServer(cloudState.serverUrl)
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

  async function saveCloudServer(): Promise<void> {
    setCloudBusy(true)
    try {
      const state = await api.cloud.setServer(cloudServer)
      setCloud(state)
      setCloudServer(state.serverUrl)
      toast('success', '服务器地址已保存')
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setCloudBusy(false)
    }
  }

  async function sendCloudCode(): Promise<void> {
    setCloudBusy(true)
    setCloudDevCode('')
    try {
      const result = await api.cloud.loginStart(cloudEmail)
      if (result.devCode) setCloudDevCode(result.devCode)
      toast('success', result.devCode ? `开发模式验证码：${result.devCode}` : '验证码已发送，请查收邮箱')
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setCloudBusy(false)
    }
  }

  async function verifyCloudCode(): Promise<void> {
    setCloudBusy(true)
    try {
      const state = await api.cloud.loginVerify(cloudEmail, cloudCode)
      setCloud(state)
      setCloudCode('')
      setCloudDevCode('')
      toast('success', '已登录云同步')
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setCloudBusy(false)
    }
  }

  async function syncCloud(): Promise<void> {
    setCloudBusy(true)
    try {
      const report = await api.cloud.syncNow()
      setCloud(await api.cloud.status())
      toast(
        'success',
        `同步完成：上传 ${report.pushed} 个，下载 ${report.pulled} 个${report.conflicts ? `，${report.conflicts} 个待解决` : ''}`
      )
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setCloudBusy(false)
    }
  }

  async function signOutCloud(): Promise<void> {
    setCloudBusy(true)
    try {
      setCloud(await api.cloud.logout())
      toast('success', '已退出云同步')
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setCloudBusy(false)
    }
  }

  async function resolveCloudConflict(id: string, choice: 'local' | 'remote'): Promise<void> {
    setCloudBusy(true)
    try {
      await api.cloud.resolveConflict(id, choice)
      setCloud(await api.cloud.status())
      toast('success', choice === 'local' ? '已保留本地版本' : '已采用云端版本')
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setCloudBusy(false)
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

      <div className="card stack" style={{ gap: 14 }}>
        <div>
          <h3 className="card-title">云同步</h3>
          <p className="card-sub">
            把快照同步到自建后端；未登录时所有功能仍然本地可用。默认地址 <code>{cloud?.serverUrl ?? '—'}</code>。
          </p>
        </div>

        <div className="field">
          <label className="field-label">服务器地址</label>
          <div className="row">
            <input
              className="input mono"
              value={cloudServer}
              placeholder="http://127.0.0.1:8787"
              onChange={(event) => setCloudServer(event.target.value)}
            />
            <button className="btn" onClick={() => void saveCloudServer()} disabled={cloudBusy}>
              保存
            </button>
          </div>
        </div>

        {!cloud?.signedIn ? (
          <>
            <div className="field">
              <label className="field-label">邮箱</label>
              <div className="row">
                <input
                  className="input"
                  placeholder="you@example.edu"
                  value={cloudEmail}
                  onChange={(event) => setCloudEmail(event.target.value)}
                />
                <button className="btn" onClick={() => void sendCloudCode()} disabled={cloudBusy || !cloudEmail.trim()}>
                  发送验证码
                </button>
              </div>
            </div>
            <div className="field">
              <label className="field-label">验证码</label>
              <div className="row">
                <input
                  className="input mono"
                  placeholder="6 位数字"
                  maxLength={6}
                  value={cloudCode}
                  onChange={(event) => setCloudCode(event.target.value.replace(/\D/g, ''))}
                />
                <button
                  className="btn primary"
                  onClick={() => void verifyCloudCode()}
                  disabled={cloudBusy || cloudCode.length !== 6}
                >
                  登录
                </button>
              </div>
              {cloudDevCode ? <span className="field-hint">开发模式验证码：{cloudDevCode}</span> : null}
            </div>
          </>
        ) : (
          <>
            <div className="update-head">
              <span className="status-dot green" />
              <strong>{cloud.email}</strong>
              <span className="muted">待同步 {cloud.pending} 个快照</span>
              {cloud.lastSyncAt ? <span className="muted">· {formatTime(cloud.lastSyncAt)}</span> : null}
            </div>

            {cloud.conflicts.length > 0 ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="badge amber" style={{ height: 'auto', padding: '8px 10px', whiteSpace: 'normal' }}>
                  {cloud.conflicts.length} 个快照需要手动解决冲突
                </div>
                {cloud.conflicts.map((conflict) => (
                  <div key={conflict.id} className="row wrap" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <strong>{conflict.snapshotName}</strong>
                      <div className="muted">
                        {conflict.keys.length > 0 ? conflict.keys.map((item) => item.key).join('、') : '两端都改过，无法自动合并'}
                      </div>
                    </div>
                    <div className="row">
                      <button className="btn" onClick={() => void resolveCloudConflict(conflict.id, 'local')} disabled={cloudBusy}>
                        保留本地
                      </button>
                      <button className="btn" onClick={() => void resolveCloudConflict(conflict.id, 'remote')} disabled={cloudBusy}>
                        使用云端
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="row wrap">
              <button className="btn primary" onClick={() => void syncCloud()} disabled={cloudBusy}>
                立即同步
              </button>
              <button className="btn" onClick={() => void signOutCloud()} disabled={cloudBusy}>
                退出登录
              </button>
            </div>
          </>
        )}
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
