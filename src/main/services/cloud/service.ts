import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import type {
  CloudConflict,
  CloudConflictKey,
  CloudLoginStart,
  CloudStatus,
  CloudSyncReport,
  EnvSnapshot
} from '../../../shared/ipc-types'
import { readSnapshots, writeSnapshots } from '../storage'
import { CloudClient, CloudError } from './client'
import { mergeVars, type VarMap } from './merge'
import {
  clearAccount,
  clearRefreshToken,
  defaultState,
  readAccount,
  readRefreshToken,
  readState,
  writeAccount,
  writeRefreshToken,
  writeState,
  type CloudState
} from './store'

const hashVars = (vars: VarMap): string => createHash('sha256').update(JSON.stringify(vars)).digest('hex')

let accessToken: string | null = null
let accessExpiresAt = 0

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user: { id: string; email: string | null; display_name: string }
  device: { id: string; name: string }
}

interface SyncSnapshotPayload {
  id: string
  client_ref: string
  name: string
  note: string | null
  latest_version: number
  content_hash: string | null
  blob_id: string | null
  deleted: boolean
  updated_at: number
}

interface SyncChange {
  seq: number
  entity: 'snapshot'
  op: 'upsert' | 'delete'
  snapshot: SyncSnapshotPayload
}

interface SyncPage {
  changes: SyncChange[]
  next_cursor: number
  has_more: boolean
}

interface MutationResult {
  client_mutation_id: string
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected'
  version?: number
  seq?: number
  error?: string
  conflict?: {
    base_version: number
    server_version: number
    server_blob_id: string | null
    mergeable: boolean
    merged_vars?: VarMap
    conflicts?: CloudConflictKey[]
    reason?: string
  }
}

function friendly(error: unknown): never {
  if (error instanceof CloudError) {
    throw new Error(error.message)
  }
  throw error
}

async function currentToken(state: CloudState): Promise<string> {
  if (accessToken && Date.now() < accessExpiresAt) return accessToken
  const refresh = readRefreshToken()
  if (!refresh) throw new Error('尚未登录云同步')

  const client = new CloudClient(state.serverUrl)
  try {
    const result = await client.request<TokenResponse>('POST', '/v1/auth/refresh', {
      body: { refresh_token: refresh }
    })
    writeRefreshToken(result.refresh_token)
    accessToken = result.access_token
    accessExpiresAt = Date.now() + Math.max(30, result.expires_in - 10) * 1000
    return accessToken
  } catch (error) {
    if (error instanceof CloudError && error.status === 401) {
      accessToken = null
      throw new Error('登录已过期，请重新登录')
    }
    friendly(error)
  }
}

async function downloadVars(client: CloudClient, token: string, blobId: string | null): Promise<VarMap> {
  if (!blobId) throw new Error('云端快照缺少内容引用')
  const info = await client.request<{ url: string }>('GET', `/v1/blobs/${blobId}/download`, { token })
  const response = await fetch(info.url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`下载云端快照失败（HTTP ${response.status}）`)
  return (await response.json()) as VarMap
}

async function pushSnapshot(
  client: CloudClient,
  token: string,
  snapshot: EnvSnapshot,
  baseVersion: number
): Promise<MutationResult> {
  const bytes = Buffer.from(JSON.stringify(snapshot.userVars), 'utf8')
  const sha = createHash('sha256').update(bytes).digest('hex')

  const init = await client.request<{ blob_id: string; existing: boolean; upload_url: string | null }>('POST', '/v1/blobs', {
    token,
    body: { sha256: sha, size: bytes.length }
  })
  if (!init.existing && init.upload_url) await client.upload(init.upload_url, bytes)
  await client.request('POST', `/v1/blobs/${init.blob_id}/commit`, { token })

  const result = await client.request<{ results: MutationResult[] }>('POST', '/v1/sync/mutations', {
    token,
    body: {
      mutations: [
        {
          client_mutation_id: `${snapshot.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          entity: 'snapshot',
          client_ref: snapshot.id,
          op: 'upsert',
          base_version: baseVersion,
          name: snapshot.name,
          note: snapshot.note,
          blob_id: init.blob_id,
          content_hash: `sha256:${sha}`,
          encryption: 'server',
          vars: snapshot.userVars
        }
      ]
    }
  })
  return result.results[0]
}

function withConflict(list: CloudConflict[], conflict: CloudConflict): CloudConflict[] {
  return [...list.filter((item) => item.id !== conflict.id), conflict]
}

export function cloudStatus(): CloudStatus {
  const state = readState()
  const account = readAccount()
  const signedIn = Boolean(account && readRefreshToken())
  const snapshots = readSnapshots()
  const pending = signedIn
    ? snapshots.filter((snapshot) => {
        const synced = state.synced[snapshot.id]
        return !synced || synced.hash !== hashVars(snapshot.userVars)
      }).length
    : 0

  return {
    serverUrl: state.serverUrl,
    signedIn,
    email: account?.email,
    deviceId: account?.deviceId,
    pending,
    conflicts: signedIn ? state.conflicts : [],
    lastSyncAt: state.lastSyncAt
  }
}

export function setServer(rawUrl: string): CloudStatus {
  const trimmed = rawUrl.trim()
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) throw new Error('服务器地址必须以 http:// 或 https:// 开头')
  const url = trimmed.replace(/\/$/, '')
  const state = readState()
  if (url !== state.serverUrl) {
    clearAccount()
    clearRefreshToken()
    accessToken = null
    writeState({ ...defaultState(), serverUrl: url })
  }
  return cloudStatus()
}

export async function loginStart(email: string): Promise<CloudLoginStart> {
  const state = readState()
  const client = new CloudClient(state.serverUrl)
  const result = await client.request<{ ok: boolean; expires_in: number; dev_code?: string }>(
    'POST',
    '/v1/auth/email/start',
    { body: { email } }
  )
  return { expiresIn: result.expires_in, devCode: result.dev_code }
}

export async function loginVerify(email: string, code: string): Promise<CloudStatus> {
  const state = readState()
  const previous = readAccount()
  const deviceId = previous?.deviceId ?? `dev_${randomUUID().replace(/-/g, '')}`
  const client = new CloudClient(state.serverUrl)

  const result = await client.request<TokenResponse>('POST', '/v1/auth/email/verify', {
    body: {
      email,
      code,
      device: {
        id: deviceId,
        name: os.hostname() || 'EnvThaw 客户端',
        platform: process.platform,
        app_version: app.getVersion()
      }
    }
  })

  writeRefreshToken(result.refresh_token)
  writeAccount({ email: result.user.email ?? email, userId: result.user.id, deviceId: result.device.id })
  accessToken = result.access_token
  accessExpiresAt = Date.now() + Math.max(30, result.expires_in - 10) * 1000

  const next = readState()
  next.serverUrl = state.serverUrl
  writeState(next)
  return cloudStatus()
}

export async function logout(): Promise<CloudStatus> {
  const state = readState()
  const refresh = readRefreshToken()
  if (refresh) {
    try {
      await new CloudClient(state.serverUrl).request('POST', '/v1/auth/logout', { body: { refresh_token: refresh } })
    } catch {
      // server unreachable: local sign-out still wins
    }
  }
  clearRefreshToken()
  clearAccount()
  accessToken = null
  accessExpiresAt = 0
  writeState({ ...defaultState(), serverUrl: state.serverUrl })
  return cloudStatus()
}

export async function syncNow(): Promise<CloudSyncReport> {
  const state = readState()
  const token = await currentToken(state)
  const client = new CloudClient(state.serverUrl)
  const snapshots = readSnapshots()
  let changed = false

  const report: CloudSyncReport = { pushed: 0, pulled: 0, conflicts: 0, cursor: state.cursor, at: Date.now() }

  // ---- pull ----
  let cursor = state.cursor
  for (let page = 0; page < 20; page += 1) {
    let result: SyncPage
    try {
      result = await client.request<SyncPage>('GET', `/v1/sync?cursor=${cursor}&limit=200`, { token })
    } catch (error) {
      friendly(error)
    }

    for (const change of result.changes) {
      if (change.op === 'delete' || change.snapshot.deleted) continue // keep local copies of server-side deletions
      const ref = change.snapshot.client_ref
      const remoteVersion = change.snapshot.latest_version
      const local = snapshots.find((item) => item.id === ref)
      const synced = state.synced[ref]

      if (!local) {
        const vars = await downloadVars(client, token, change.snapshot.blob_id)
        snapshots.push({
          id: ref,
          name: change.snapshot.name || '云端快照',
          createdAt: change.snapshot.updated_at || Date.now(),
          userVars: vars
        })
        state.synced[ref] = { version: remoteVersion, hash: hashVars(vars) }
        changed = true
        report.pulled += 1
        continue
      }

      const localHash = hashVars(local.userVars)
      if (synced && synced.version === remoteVersion && synced.hash === localHash) continue

      if (synced && localHash === synced.hash) {
        const vars = await downloadVars(client, token, change.snapshot.blob_id)
        local.userVars = vars
        local.name = change.snapshot.name || local.name
        state.synced[ref] = { version: remoteVersion, hash: hashVars(vars) }
        changed = true
        report.pulled += 1
        continue
      }

      state.conflicts = withConflict(state.conflicts, {
        id: `${ref}:${remoteVersion}`,
        clientRef: ref,
        snapshotName: local.name,
        serverVersion: remoteVersion,
        localHash,
        remoteBlobId: change.snapshot.blob_id,
        keys: []
      })
    }

    cursor = result.next_cursor
    if (!result.has_more) break
  }
  state.cursor = cursor

  // ---- push ----
  for (const snapshot of snapshots) {
    if (state.conflicts.some((conflict) => conflict.clientRef === snapshot.id)) continue
    const synced = state.synced[snapshot.id]
    const localHash = hashVars(snapshot.userVars)
    if (synced && synced.hash === localHash) continue

    const result = await pushSnapshot(client, token, snapshot, synced?.version ?? 0)

    if (result.status === 'applied' || result.status === 'duplicate') {
      if (typeof result.version === 'number') {
        state.synced[snapshot.id] = { version: result.version, hash: localHash }
      }
      if (result.status === 'applied') report.pushed += 1
      changed = true
      continue
    }

    if (result.status === 'rejected') throw new Error(result.error ?? '推送被云端拒绝')

    const info = result.conflict
    if (!info) throw new Error('云端返回了无法识别的冲突')

    if (info.mergeable && (info.conflicts ?? []).length === 0 && info.merged_vars) {
      snapshot.userVars = info.merged_vars
      const retry = await pushSnapshot(client, token, snapshot, info.server_version)
      if (retry.status === 'applied' && typeof retry.version === 'number') {
        state.synced[snapshot.id] = { version: retry.version, hash: hashVars(snapshot.userVars) }
        report.pushed += 1
        changed = true
        continue
      }
      throw new Error('自动合并后再次推送失败，请手动解决冲突')
    }

    state.conflicts = withConflict(state.conflicts, {
      id: `${snapshot.id}:${info.server_version}`,
      clientRef: snapshot.id,
      snapshotName: snapshot.name,
      serverVersion: info.server_version,
      localHash,
      remoteBlobId: info.server_blob_id,
      keys: info.conflicts ?? []
    })
  }

  if (changed) writeSnapshots(snapshots)
  state.lastSyncAt = report.at
  report.conflicts = state.conflicts.length
  report.cursor = state.cursor
  writeState(state)
  return report
}

export async function resolveConflict(id: string, choice: 'local' | 'remote'): Promise<CloudSyncReport> {
  const state = readState()
  const conflict = state.conflicts.find((item) => item.id === id)
  if (!conflict) throw new Error('冲突已不存在')
  if (choice !== 'local' && choice !== 'remote') throw new Error('未知的解决方式')

  const token = await currentToken(state)
  const client = new CloudClient(state.serverUrl)
  const snapshots = readSnapshots()
  const snapshot = snapshots.find((item) => item.id === conflict.clientRef)
  if (!snapshot) throw new Error('本地快照已被删除，只能放弃这次冲突')

  if (choice === 'remote') {
    const vars = await downloadVars(client, token, conflict.remoteBlobId)
    snapshot.userVars = vars
    state.synced[conflict.clientRef] = { version: conflict.serverVersion, hash: hashVars(vars) }
  } else {
    const result = await pushSnapshot(client, token, snapshot, conflict.serverVersion)
    if (result.status !== 'applied' && result.status !== 'duplicate') {
      throw new Error('保留本地版本时推送失败，请重试')
    }
    if (typeof result.version === 'number') {
      state.synced[conflict.clientRef] = { version: result.version, hash: hashVars(snapshot.userVars) }
    }
  }

  state.conflicts = state.conflicts.filter((item) => item.id !== id)
  writeSnapshots(snapshots)
  writeState(state)
  return { pushed: choice === 'local' ? 1 : 0, pulled: choice === 'remote' ? 1 : 0, conflicts: state.conflicts.length, cursor: state.cursor, at: Date.now() }
}
