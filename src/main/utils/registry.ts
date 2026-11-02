import type { EnvValueKind, EnvVarEntry } from '../../shared/ipc-types'
import { PS_PREAMBLE, runPowerShell } from './powershell'

export type RegistryOp =
  | { op: 'set'; name: string; value: string; kind: 'String' | 'ExpandString' }
  | { op: 'delete'; name: string }

const READ_SCRIPT_TEMPLATE = `${PS_PREAMBLE}
$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$false)
$o=@{}
if($k -ne $null){
  foreach($n in $k.GetValueNames()){
    if(%EXPAND%){ $v=$k.GetValue($n,$null) } else { $v=$k.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    if($v -is [array]){ $v=($v -join ';') }
    $o[$n]=@{ v=[string]$v; t=$k.GetValueKind($n).ToString() }
  }
  $k.Close()
}
ConvertTo-Json -InputObject $o -Depth 4 -Compress`

const WRITE_SCRIPT_TEMPLATE = `${PS_PREAMBLE}
$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('%PAYLOAD%'))
$p=$json | ConvertFrom-Json
$ops=@($p.ops)
$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
if($k -eq $null){ $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
foreach($op in $ops){
  if($op.op -eq 'set'){
    $kind=[Microsoft.Win32.RegistryValueKind]::String
    if($op.kind -eq 'ExpandString'){ $kind=[Microsoft.Win32.RegistryValueKind]::ExpandString }
    $k.SetValue([string]$op.name,[string]$op.value,$kind)
  } elseif($op.op -eq 'delete'){
    $k.DeleteValue([string]$op.name,$false)
  }
}
$k.Close()
# Broadcast WM_SETTINGCHANGE. .NET does the broadcast for us, but always writes
# REG_SZ, so it is used once on the last operation and the exact value kind is
# restored immediately afterwards.
if($ops.Count -gt 0){
  $last=$ops[$ops.Count-1]
  if($last.op -eq 'set'){
    [Environment]::SetEnvironmentVariable([string]$last.name,[string]$last.value,'User')
    $k2=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
    $kind2=[Microsoft.Win32.RegistryValueKind]::String
    if($last.kind -eq 'ExpandString'){ $kind2=[Microsoft.Win32.RegistryValueKind]::ExpandString }
    $k2.SetValue([string]$last.name,[string]$last.value,$kind2)
    $k2.Close()
  } else {
    [Environment]::SetEnvironmentVariable([string]$last.name,$null,'User')
  }
}
'ok'`

function normalizeKind(raw: string): EnvValueKind {
  if (raw === 'String') return 'String'
  if (raw === 'ExpandString') return 'ExpandString'
  return 'Other'
}

/**
 * Reads HKCU\Environment.
 * `expand` resolves REG_EXPAND_SZ references (%USERPROFILE%...), which is what a
 * newly started process would see. Snapshots keep them raw so a restore is exact.
 */
export async function readUserEnv(expand = false): Promise<EnvVarEntry[]> {
  const stdout = await runPowerShell(READ_SCRIPT_TEMPLATE.replace('%EXPAND%', expand ? '$true' : '$false'))
  const trimmed = stdout.replace(/^\uFEFF/, '').trim()
  if (!trimmed || trimmed === '{}') return []

  const parsed = JSON.parse(trimmed) as Record<string, { v: string; t: string }>
  return Object.entries(parsed)
    .map(([name, meta]) => ({ name, value: String(meta.v ?? ''), kind: normalizeKind(String(meta.t ?? 'String')) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Applies a batch of registry operations and broadcasts WM_SETTINGCHANGE once. */
export async function applyRegistryOps(ops: RegistryOp[]): Promise<void> {
  if (ops.length === 0) return
  const payload = Buffer.from(JSON.stringify({ ops }), 'utf8').toString('base64')
  const script = WRITE_SCRIPT_TEMPLATE.replace('%PAYLOAD%', payload)
  await runPowerShell(script)
}

const MACHINE_PATH_SCRIPT = `${PS_PREAMBLE}
$k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',$false)
$v=''
if($k -ne $null){ $v=[string]$k.GetValue('Path','') ; $k.Close() }
Write-Output $v`

/**
 * The effective PATH of a new process is Machine Path + User Path. Reading only
 * the user value drops System32 and breaks executable lookup in child processes.
 */
export async function readMachinePath(): Promise<string> {
  try {
    return (await runPowerShell(MACHINE_PATH_SCRIPT)).trim()
  } catch {
    return ''
  }
}

export function toEnvRecord(entries: EnvVarEntry[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const entry of entries) record[entry.name] = entry.value
  return record
}

/**
 * Merges environments case-insensitively (Windows semantics). Without this the
 * child can end up with both "Path" and "PATH", which breaks executable lookup.
 */
export function mergeEnv(base: NodeJS.ProcessEnv, overlay: Record<string, string>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base }
  const keyByLower = new Map<string, string>()
  for (const key of Object.keys(result)) keyByLower.set(key.toLowerCase(), key)

  for (const [name, value] of Object.entries(overlay)) {
    const existing = keyByLower.get(name.toLowerCase())
    if (existing && existing !== name) delete result[existing]
    result[name] = value
    keyByLower.set(name.toLowerCase(), name)
  }
  return result
}
