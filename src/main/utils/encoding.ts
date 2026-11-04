import { execFileSync } from 'node:child_process'

/**
 * Windows console tools emit bytes in the console code page (936 / GBK on a
 * Chinese system), while PowerShell scripts are forced to UTF-8 by our preamble.
 * Decoding therefore has to follow the output source instead of assuming UTF-8.
 */

export interface StreamDecoder {
  push(chunk: Buffer): string
  flush(): string
}

export function createDecoder(encoding: string): StreamDecoder {
  const normalized = encoding.toLowerCase()
  const decoder = new TextDecoder(normalized === 'utf8' ? 'utf-8' : normalized)
  return {
    push: (chunk) => decoder.decode(chunk, { stream: true }),
    flush: () => decoder.decode()
  }
}

/**
 * Decodes a whole text file that may come from Windows tooling: UTF-8 when it is
 * valid UTF-8, otherwise the console code page (GBK on a Chinese system).
 */
export function decodeText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder(consoleEncoding()).decode(buffer)
  }
}

let cached: string | null = null

/** Code page used by console tools spawned from this process. */
export function consoleEncoding(): string {
  if (process.platform !== 'win32') return 'utf-8'
  if (cached) return cached
  try {
    const output = execFileSync('cmd.exe', ['/d', '/c', 'chcp'], { windowsHide: true, encoding: 'utf8' })
    const page = Number(/(\d{3,5})/.exec(output)?.[1] ?? 0)
    cached = page === 65001 ? 'utf-8' : page === 54936 ? 'gb18030' : page === 950 ? 'big5' : 'gbk'
  } catch {
    cached = 'gbk'
  }
  return cached
}
