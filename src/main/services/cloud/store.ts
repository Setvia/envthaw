import { safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { CloudConflict } from '../../../shared/ipc-types'
import { getLayout, readJson, writeJson } from '../storage'

export const DEFAULT_SERVER_URL = process.env['ENVTHAW_CLOUD_URL'] ?? 'http://127.0.0.1:8787'

export interface CloudAccount {
  email: string
  userId: string
  deviceId: string
}

export interface SyncedEntry {
  version: number
  hash: string
}

export interface CloudState {
  serverUrl: string
  cursor: number
  synced: Record<string, SyncedEntry>
  conflicts: CloudConflict[]
  lastSyncAt?: number
}

function cloudDir(): string {
  const dir = path.join(getLayout().userRoot, 'cloud')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const file = (name: string): string => path.join(cloudDir(), name)

export function defaultState(): CloudState {
  return { serverUrl: DEFAULT_SERVER_URL, cursor: 0, synced: {}, conflicts: [] }
}

export function readState(): CloudState {
  const state = readJson<CloudState>(file('state.json'), defaultState())
  return {
    serverUrl: state.serverUrl || DEFAULT_SERVER_URL,
    cursor: Number(state.cursor) || 0,
    synced: state.synced ?? {},
    conflicts: state.conflicts ?? [],
    lastSyncAt: state.lastSyncAt
  }
}

export function writeState(state: CloudState): void {
  writeJson(file('state.json'), state)
}

export function readAccount(): CloudAccount | null {
  const account = readJson<CloudAccount | null>(file('account.json'), null)
  if (!account || !account.userId || !account.deviceId) return null
  return account
}

export function writeAccount(account: CloudAccount): void {
  writeJson(file('account.json'), account)
}

export function clearAccount(): void {
  fs.rmSync(file('account.json'), { force: true })
}

/**
 * Refresh token at rest: DPAPI via safeStorage when available, otherwise a plain
 * file inside the (gitignored) per-user config directory.
 */
export function readRefreshToken(): string | null {
  try {
    const raw = fs.readFileSync(file('token.bin'))
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(raw)
    return raw.toString('utf8').replace(/^plain:/, '')
  } catch {
    return null
  }
}

export function writeRefreshToken(token: string): void {
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(`plain:${token}`, 'utf8')
  fs.writeFileSync(file('token.bin'), payload)
}

export function clearRefreshToken(): void {
  fs.rmSync(file('token.bin'), { force: true })
}
