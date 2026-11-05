import { app, BrowserWindow, shell } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { IPC, type UpdateProgress, type UpdateRelease, type UpdateState } from '../../shared/ipc-types'
import { audit } from './env-service'
import { ensureLayout, readSettings } from './storage'

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024
const CHECK_TIMEOUT_MS = 15_000

let state: UpdateState | null = null
let downloading = false

function currentVersion(): string {
  return app.getVersion()
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    normalizeVersion(value)
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** Updates are fetched over TLS; plain http is only tolerated for local testing. */
function isAllowedUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

function broadcastState(next: UpdateState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.updateState, next)
  }
}

function setState(patch: Partial<UpdateState>): UpdateState {
  const settings = readSettings()
  const base: UpdateState = state ?? {
    configured: Boolean(settings.updateFeedUrl),
    feedUrl: settings.updateFeedUrl,
    currentVersion: currentVersion(),
    status: 'idle'
  }
  state = { ...base, ...patch, configured: Boolean((patch.feedUrl ?? base.feedUrl)), currentVersion: currentVersion() }
  broadcastState(state)
  return state
}

export function getUpdateState(): UpdateState {
  const settings = readSettings()
  if (!state) {
    return {
      configured: Boolean(settings.updateFeedUrl),
      feedUrl: settings.updateFeedUrl,
      currentVersion: currentVersion(),
      status: 'idle'
    }
  }
  // The feed URL may have been edited in settings since the last check.
  return { ...state, configured: Boolean(settings.updateFeedUrl), feedUrl: settings.updateFeedUrl }
}

function parseRelease(raw: unknown): UpdateRelease {
  const data = raw as Record<string, unknown>
  if (!data || typeof data !== 'object') throw new Error('更新清单格式无效')
  const version = typeof data.version === 'string' ? data.version.trim() : ''
  const url = typeof data.url === 'string' ? data.url.trim() : ''
  if (!version) throw new Error('更新清单缺少 version')
  if (!url || !isAllowedUrl(url)) throw new Error('更新清单中的下载地址无效（必须为 https）')

  const release: UpdateRelease = { version, url }
  if (typeof data.notes === 'string') release.notes = data.notes.slice(0, 8000)
  if (typeof data.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(data.sha256)) release.sha256 = data.sha256.toLowerCase()
  if (typeof data.size === 'number' && Number.isFinite(data.size) && data.size > 0) release.size = data.size
  if (typeof data.publishedAt === 'number' && Number.isFinite(data.publishedAt)) release.publishedAt = data.publishedAt
  return release
}

export async function checkForUpdates(): Promise<UpdateState> {
  const settings = readSettings()
  const feedUrl = settings.updateFeedUrl.trim()

  if (!feedUrl) {
    return setState({
      configured: false,
      feedUrl: '',
      status: 'idle',
      release: undefined,
      error: undefined,
      progress: undefined,
      filePath: undefined
    })
  }
  if (!isAllowedUrl(feedUrl)) {
    return setState({ configured: true, feedUrl, status: 'error', error: '更新源必须是 https 地址' })
  }

  setState({ configured: true, feedUrl, status: 'checking', error: undefined, release: undefined, filePath: undefined })

  try {
    const response = await fetch(feedUrl, {
      headers: { accept: 'application/json', 'user-agent': `EnvThaw/${currentVersion()}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`更新源返回 HTTP ${response.status}`)

    const release = parseRelease(await response.json())
    const comparison = compareVersions(release.version, currentVersion())
    audit('update.check', `当前 ${currentVersion()}，远程 ${release.version}`, true)

    return setState({
      status: comparison > 0 ? 'available' : 'up-to-date',
      release,
      checkedAt: Date.now(),
      error: undefined
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    audit('update.check', message, false)
    return setState({ status: 'error', error: message, checkedAt: Date.now() })
  }
}

function downloadFileName(release: UpdateRelease): string {
  let base = 'EnvThaw-update.exe'
  try {
    const parsed = path.basename(new URL(release.url).pathname)
    if (parsed && /\.(exe|zip|msi)$/i.test(parsed)) base = parsed.replace(/[^\w.\-]/g, '_')
  } catch {
    // keep the default name
  }
  return `EnvThaw-${release.version}-${base}`.replace(/[^\w.\-]/g, '_')
}

export async function downloadUpdate(): Promise<UpdateState> {
  const current = getUpdateState()
  if (!current.release) throw new Error('请先检查更新')
  if (downloading) throw new Error('已有下载任务在进行中')
  if (!isAllowedUrl(current.release.url)) throw new Error('下载地址无效')

  const layout = ensureLayout()
  const target = path.join(layout.files.updates, downloadFileName(current.release))
  const partial = `${target}.part`
  downloading = true
  setState({ status: 'downloading', progress: { received: 0, total: current.release.size ?? 0 }, error: undefined })

  try {
    const response = await fetch(current.release.url, {
      headers: { 'user-agent': `EnvThaw/${currentVersion()}` },
      signal: AbortSignal.timeout(10 * 60_000)
    })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)

    const declared = Number(response.headers.get('content-length') ?? 0)
    const total = declared || current.release.size || 0
    if (total > MAX_DOWNLOAD_BYTES) throw new Error('安装包过大，已中止下载')

    let received = 0
    let lastEmit = 0
    const hash = createHash('sha256')

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      hash.update(chunk)
      if (received > MAX_DOWNLOAD_BYTES) {
        source.destroy(new Error('安装包过大，已中止下载'))
        return
      }
      const now = Date.now()
      if (now - lastEmit > 120 || (total > 0 && received >= total)) {
        lastEmit = now
        const progress: UpdateProgress = { received, total }
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(IPC.updateProgress, progress)
        }
        setState({ status: 'downloading', progress })
      }
    })

    await pipeline(source, fs.createWriteStream(partial))

    if (total > 0 && received !== total) throw new Error('下载不完整，请重试')
    const digest = hash.digest('hex')
    if (current.release.sha256 && digest !== current.release.sha256) {
      throw new Error('校验失败：安装包 SHA-256 与清单不一致')
    }

    fs.renameSync(partial, target)
    audit('update.download', `${current.release.version} → ${target}`, true)
    return setState({
      status: 'downloaded',
      filePath: target,
      progress: { received, total: total || received },
      error: undefined
    })
  } catch (error) {
    try {
      if (fs.existsSync(partial)) fs.unlinkSync(partial)
    } catch {
      // ignore cleanup failures
    }
    const message = error instanceof Error ? error.message : String(error)
    audit('update.download', message, false)
    return setState({ status: 'error', error: message })
  } finally {
    downloading = false
  }
}

export async function openDownloadFolder(): Promise<void> {
  const layout = ensureLayout()
  await shell.openPath(layout.files.updates)
}

/** Formats a byte count for the renderer-side log line. */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

