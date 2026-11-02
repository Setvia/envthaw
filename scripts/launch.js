// Dev/preview launcher.
//
// Two Windows-specific problems are handled here, both of which only matter for
// development runs (a packaged build lives in its own directory):
//
//  1. Electron's Chromium sandbox refuses to start when electron.exe sits inside
//     a directory that a security filter driver treats specially (this workspace
//     is one such directory). The browser dies with 0xC0000005 / 0x80000003
//     before any window appears. Mirroring the runtime outside the project and
//     exposing it through a directory junction fixes the sandbox, and keeps the
//     process at Medium integrity - which is required to write HKCU\Environment.
//  2. If the sandbox still cannot start, the run is retried once with
//     --no-sandbox so the UI is at least usable. Such a process runs at Low
//     integrity and cannot write environment variables; the UI reports that.
//
// NODE_OPTIONS / ELECTRON_RUN_AS_NODE are also cleared: IDE debug tooling and
// npm hooks leave values there that either hijack console output or turn
// electron.exe into plain node.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const bin = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const mode = process.argv[2] === 'dev' ? 'dev' : 'preview'
const extra = process.argv.slice(3)

delete process.env.ELECTRON_RUN_AS_NODE
delete process.env.NODE_OPTIONS

function log(message) {
  console.log(`[envthaw] ${message}`)
}

function isJunction(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Moves the electron runtime outside the project and links it back in, so the
 * sandboxed browser process does not run from a filtered directory.
 * Returns true when the local runtime is ready to use.
 */
function ensureExternalRuntime() {
  if (process.env.ENVTHAW_LOCAL_RUNTIME === '1') return true

  const dist = path.join(root, 'node_modules', 'electron', 'dist')
  if (!fs.existsSync(dist) || isJunction(dist)) return true

  const versionFile = path.join(root, 'node_modules', 'electron', 'dist', 'version')
  let version = 'unknown'
  try {
    version = fs.readFileSync(versionFile, 'utf8').trim()
  } catch {
    // fall back to the package version
    try {
      version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
    } catch {
      version = 'unknown'
    }
  }

  const mirror = path.join(process.env.LOCALAPPDATA || os.homedir(), 'EnvThaw', 'runtime', version)
  const mirrorExe = path.join(mirror, 'electron.exe')
  const backup = `${dist}.original`

  try {
    if (!fs.existsSync(mirrorExe)) {
      log(`copying electron ${version} runtime to ${mirror}`)
      fs.mkdirSync(mirror, { recursive: true })
      fs.cpSync(dist, mirror, { recursive: true })
    }

    fs.renameSync(dist, backup)
    try {
      fs.symlinkSync(mirror, dist, 'junction')
    } catch (error) {
      fs.renameSync(backup, dist)
      throw error
    }
    fs.rmSync(backup, { recursive: true, force: true })
    return true
  } catch (error) {
    log(`runtime mirror skipped: ${error.message}`)
    return false
  }
}

function run(index, noSandbox) {
  return new Promise((resolve) => {
    const started = Date.now()
    const env = { ...process.env }
    if (noSandbox) {
      env.NO_SANDBOX = '1'
    } else {
      delete env.NO_SANDBOX
    }

    const child = spawn(process.execPath, [bin, mode, ...extra], { cwd: root, stdio: 'inherit', env })

    child.on('error', (error) => {
      log(`failed to start electron-vite: ${error.message}`)
      resolve({ code: 1, durationMs: Date.now() - started, crashed: true })
    })
    child.on('close', (code, signal) => {
      const durationMs = Date.now() - started
      // A window that opened and was closed by the user exits with 0; a browser
      // process that dies during startup never reaches that point.
      const crashed = durationMs < 6000 && (code === null ? true : code !== 0)
      resolve({ code: code ?? 1, durationMs, crashed, signal })
    })

    log(index === 0 ? 'starting EnvThaw (Chromium sandbox enabled)' : 'starting EnvThaw with --no-sandbox (environment variables will be read-only)')
  })
}

async function main() {
  ensureExternalRuntime()

  const first = await run(0, false)
  if (!first.crashed) {
    process.exit(first.code)
  }

  log(`electron exited during startup (code ${first.code}); retrying with --no-sandbox`)
  const second = await run(1, true)
  process.exit(second.code)
}

void main()

