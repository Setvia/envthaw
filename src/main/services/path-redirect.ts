import fs from 'node:fs'
import path from 'node:path'
import type { ApplyResult, DiffEntry, RedirectConfig, RedirectItem } from '../../shared/ipc-types'
import { readUserEnv, toEnvRecord } from '../utils/registry'
import { applyDiffEntries, audit } from './env-service'
import { diffVars } from './restore-engine'
import { ensureLayout, getLayout, readJson, writeJson } from './storage'

interface RedirectDescriptor {
  key: Exclude<keyof RedirectConfig, 'gitUserName' | 'gitUserEmail'>
  envName: string
  label: string
  description: string
  directory: boolean
}

export const REDIRECT_DESCRIPTORS: RedirectDescriptor[] = [
  {
    key: 'pythonVenvHome',
    envName: 'WORKON_HOME',
    label: 'Python 虚拟环境目录',
    description: 'virtualenvwrapper / 课程用 venv 的统一存放位置',
    directory: true
  },
  {
    key: 'pipCacheDir',
    envName: 'PIP_CACHE_DIR',
    label: 'pip 缓存目录',
    description: '避免每次重装都重新下载 wheel',
    directory: true
  },
  {
    key: 'nodePrefix',
    envName: 'NPM_CONFIG_PREFIX',
    label: 'Node 全局安装目录',
    description: 'npm i -g 的落地位置，不写 C 盘',
    directory: true
  },
  {
    key: 'nodeCache',
    envName: 'NPM_CONFIG_CACHE',
    label: 'npm 缓存目录',
    description: 'npm 包缓存，可显著减少重复下载',
    directory: true
  },
  {
    key: 'gitConfigPath',
    envName: 'GIT_CONFIG_GLOBAL',
    label: 'Git 全局配置文件的路径',
    description: '把 .gitconfig 重定向到非保护盘，按文件路径处理',
    directory: false
  }
]

function redirectFile(): string {
  return path.join(getLayout().root, 'redirect.json')
}

export function defaultRedirectConfig(): RedirectConfig {
  const layout = ensureLayout()
  return {
    pythonVenvHome: path.join(layout.dataDir, 'venvs'),
    pipCacheDir: path.join(layout.dataDir, 'cache', 'pip'),
    nodePrefix: path.join(layout.dataDir, 'node', 'global'),
    nodeCache: path.join(layout.dataDir, 'cache', 'npm'),
    gitConfigPath: path.join(layout.dataDir, 'git', '.gitconfig'),
    gitUserName: '',
    gitUserEmail: ''
  }
}

export function getRedirectConfig(): RedirectConfig {
  const stored = readJson<Partial<RedirectConfig>>(redirectFile(), {})
  return { ...defaultRedirectConfig(), ...stored }
}

export function saveRedirectConfig(config: RedirectConfig): RedirectConfig {
  ensureLayout()
  writeJson(redirectFile(), config)
  return config
}

export function describeItems(config: RedirectConfig): RedirectItem[] {
  return REDIRECT_DESCRIPTORS.map((descriptor) => ({
    key: descriptor.key,
    envName: descriptor.envName,
    label: descriptor.label,
    description: descriptor.description,
    value: config[descriptor.key]
  }))
}

function targetEnv(config: RedirectConfig): Record<string, string> {
  const target: Record<string, string> = {}
  for (const descriptor of REDIRECT_DESCRIPTORS) {
    const value = config[descriptor.key].trim()
    if (value) target[descriptor.envName] = value
  }
  return target
}

/**
 * Redirects only ever ADD or UPDATE their own variables.
 *
 * A plain diff would also report every unrelated user variable (PATH, TEMP, ...)
 * as "removed", and applying that diff would wipe the user's environment. That
 * is never what a path redirect is supposed to do, so removals are filtered out
 * here - the preview and the applied change therefore always match.
 */
export async function previewRedirect(config: RedirectConfig): Promise<DiffEntry[]> {
  const current = await readUserEnv()
  return diffVars(targetEnv(config), toEnvRecord(current)).filter((entry) => entry.kind !== 'removed')
}

function ensureDirectory(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return null
  } catch (error) {
    return (error as Error).message
  }
}

/** Rewrites only the [user] block, leaving the rest of the file untouched. */
export function mergeGitConfig(file: string, name: string, email: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })

  let content = ''
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    content = ''
  }

  const kept: string[] = []
  let inUserSection = false
  for (const line of content.split(/\r?\n/)) {
    const isSection = /^\s*\[[^\]]+\]\s*$/.test(line)
    if (isSection) inUserSection = /^\s*\[user\]\s*$/.test(line)
    if (!inUserSection) kept.push(line)
  }

  const block: string[] = ['[user]']
  if (name.trim()) block.push(`\tname = ${name.trim()}`)
  if (email.trim()) block.push(`\temail = ${email.trim()}`)

  const body = [...kept]
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  const merged = [...body, ...(body.length > 0 ? [''] : []), ...block, ''].join('\n')
  fs.writeFileSync(file, merged, 'utf8')
}

export async function applyRedirect(config: RedirectConfig): Promise<ApplyResult> {
  const failures: { name: string; error: string }[] = []

  for (const descriptor of REDIRECT_DESCRIPTORS) {
    const value = config[descriptor.key].trim()
    if (!value) continue
    if (descriptor.directory) {
      const error = ensureDirectory(value)
      if (error) failures.push({ name: descriptor.envName, error })
    } else {
      const error = ensureDirectory(path.dirname(value))
      if (error) failures.push({ name: descriptor.envName, error })
    }
  }

  if (config.gitConfigPath.trim() && (config.gitUserName.trim() || config.gitUserEmail.trim())) {
    try {
      mergeGitConfig(config.gitConfigPath.trim(), config.gitUserName, config.gitUserEmail)
    } catch (error) {
      failures.push({ name: 'gitconfig', error: (error as Error).message })
    }
  }

  const entries = await previewRedirect(config)
  const result = await applyDiffEntries(entries, '应用路径重定向')
  failures.push(...result.failed)

  saveRedirectConfig(config)
  audit('redirect.apply', `重定向 ${entries.length} 项`, failures.length === 0)

  return { applied: result.applied, failed: failures, rollbackId: result.rollbackId }
}
