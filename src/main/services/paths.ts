import { app } from 'electron'
import path from 'node:path'

/**
 * The project directory. Everything the app writes lives under it:
 * `config/` for configuration and state, `data/` for the payloads that path
 * redirects point at (venvs, caches, ...).
 *
 * In development this is the repository root; in a packaged/portable build it is
 * the directory that contains the executable, so the whole tool stays portable.
 */
export function projectRoot(): string {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()
}

/** Fixed location: never configurable, never outside the project directory. */
export function configDir(): string {
  return path.join(projectRoot(), 'config')
}

/** Working data referenced by redirect presets. */
export function dataDir(): string {
  return path.join(projectRoot(), 'data')
}

/** Shipped example/template configs; in a packaged build they live in resources/. */
export function presetsDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'presets') : path.join(projectRoot(), 'presets')
}

/** `${DATA_DIR}` / `${CONFIG_DIR}` / `${PROJECT_DIR}` placeholders used by presets. */
export function expandTokens(value: string): string {
  return value
    .replace(/\$\{DATA_DIR\}/g, dataDir())
    .replace(/\$\{CONFIG_DIR\}/g, configDir())
    .replace(/\$\{PROJECT_DIR\}/g, projectRoot())
}

/** Recursively expands placeholders in a parsed JSON value. */
export function expandDeep<T>(value: T): T {
  if (typeof value === 'string') return expandTokens(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => expandDeep(item)) as unknown as T
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = expandDeep(item)
    }
    return result as T
  }
  return value
}
