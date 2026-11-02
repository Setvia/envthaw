import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { DiffEntry, RedirectConfig, RedirectItem } from '../../../shared/ipc-types'
import { api, errorText } from '../lib/api'
import { useToast } from '../components/Toast'
import { Modal } from '../components/Modal'
import { DiffTable } from '../components/DiffTable'

const EMPTY: RedirectConfig = {
  pythonVenvHome: '',
  pipCacheDir: '',
  nodePrefix: '',
  nodeCache: '',
  gitConfigPath: '',
  gitUserName: '',
  gitUserEmail: ''
}

export function RedirectPage(): ReactElement {
  const toast = useToast()
  const [config, setConfig] = useState<RedirectConfig>(EMPTY)
  const [items, setItems] = useState<RedirectItem[]>([])
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<DiffEntry[] | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [current, descriptors] = await Promise.all([api.redirect.get(), api.redirect.items()])
      setConfig(current)
      setItems(descriptors)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  function patch(key: keyof RedirectConfig, value: string): void {
    setConfig((current) => ({ ...current, [key]: value }))
  }

  async function pickDirectory(key: keyof RedirectConfig): Promise<void> {
    try {
      const chosen = await api.app.chooseDirectory(config[key] || undefined)
      if (chosen) patch(key, chosen)
    } catch (error) {
      toast('error', errorText(error))
    }
  }

  async function doPreview(): Promise<void> {
    setBusy(true)
    try {
      const entries = await api.redirect.preview(config)
      setPreview(entries)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function apply(): Promise<void> {
    setBusy(true)
    try {
      const result = await api.redirect.apply(config)
      if (result.failed.length > 0) {
        toast('error', `部分失败：${result.failed.map((item) => `${item.name}: ${item.error}`).join('；')}`)
      } else {
        toast('success', `已应用 ${result.applied} 项环境变量，目录已就绪`)
      }
      setPreview(null)
    } catch (error) {
      toast('error', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <h3 className="card-title">路径重定向</h3>
        <p className="card-sub">
          优先通过应用自身支持的环境变量把缓存/全局目录挪到非保护盘，不修改应用内部路径，也不创建符号链接。
        </p>
      </div>

      <div className="grid cols-2">
        <div className="card stack" style={{ gap: 16 }}>
          <h3 className="card-title">目录</h3>
          {items
            .filter((item) => !item.key.startsWith('gitUser'))
            .map((item) => (
              <div className="field" key={item.key}>
                <label className="field-label">
                  {item.label} <span className="badge">{item.envName}</span>
                </label>
                <div className="row">
                  <input
                    className="input mono"
                    value={config[item.key]}
                    onChange={(event) => patch(item.key, event.target.value)}
                    placeholder="D:\\EnvThaw\\…"
                  />
                  <button className="btn" onClick={() => void pickDirectory(item.key)}>
                    选择…
                  </button>
                </div>
                <span className="field-hint">{item.description}</span>
              </div>
            ))}
        </div>

        <div className="card stack" style={{ gap: 16 }}>
          <h3 className="card-title">Git 身份（可选）</h3>
          <p className="card-sub">
            机房公用电脑上用临时身份提交，配置写入上面的 GIT_CONFIG_GLOBAL 文件，不影响本机其他账号。
          </p>
          <div className="field">
            <label className="field-label">user.name</label>
            <input
              className="input"
              value={config.gitUserName}
              onChange={(event) => patch('gitUserName', event.target.value)}
              placeholder="例如：Zhang San"
            />
          </div>
          <div className="field">
            <label className="field-label">user.email</label>
            <input
              className="input"
              value={config.gitUserEmail}
              onChange={(event) => patch('gitUserEmail', event.target.value)}
              placeholder="例如：zhangsan@example.com"
            />
          </div>
          <div className="hr" />
          <div className="muted" style={{ lineHeight: 1.8 }}>
            应用时会自动创建上述目录，并把对应变量写入 HKCU\Environment，重启后仍然有效（除非用户级变量本身被还原）。
          </div>
          <div className="row">
            <button className="btn" onClick={() => void doPreview()} disabled={busy}>
              预览变更
            </button>
            <button className="btn primary" onClick={() => void apply()} disabled={busy}>
              应用重定向
            </button>
          </div>
        </div>
      </div>

      {preview ? (
        <Modal
          title="将写入的用户环境变量"
          subtitle="仅列出与当前状态不同的项；应用前会自动创建这些目录。"
          width={900}
          onClose={() => setPreview(null)}
          footer={
            <>
              <button className="btn" onClick={() => setPreview(null)}>
                取消
              </button>
              <button className="btn primary" onClick={() => void apply()} disabled={busy || preview.length === 0}>
                应用 {preview.length} 项
              </button>
            </>
          }
        >
          <DiffTable entries={preview} emptyText="当前环境已经与配置一致，无需变更。" />
        </Modal>
      ) : null}
    </div>
  )
}
