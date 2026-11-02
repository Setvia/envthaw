import { execFile } from 'node:child_process'

/**
 * Runs a PowerShell snippet and resolves its stdout. Every script produced by
 * this app starts by forcing UTF-8 console output, otherwise Chinese values
 * come back mangled by the OEM code page.
 */
export function runPowerShell(script: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr || ''}${stdout || ''}`.trim() || error.message
          reject(new Error(detail))
          return
        }
        resolve(stdout)
      }
    )
  })
}

export const PS_PREAMBLE = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; "

export function toPowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
