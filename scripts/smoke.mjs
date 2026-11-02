// End-to-end smoke test against the running app through the Chrome DevTools
// Protocol: verifies preload bridge, IPC handlers and registry access without
// needing a human to click around.
const port = Number(process.argv[2] ?? 9223)

async function waitForTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // devtools endpoint not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('devtools target not found')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', (event) => reject(new Error(`websocket error: ${event.message ?? 'unknown'}`)), { once: true })
  })
}

let nextId = 1
function evaluate(socket, expression) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`timeout evaluating ${expression}`)), 20000)
    const handler = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', handler)
      if (message.error) {
        reject(new Error(message.error.message))
        return
      }
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.exception?.description ?? 'evaluation threw'))
        return
      }
      resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', handler)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

const target = await waitForTarget()
const socket = await connect(target.webSocketDebuggerUrl)

const checks = []
function record(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}

const bridge = await evaluate(socket, "typeof window.envthaw === 'object' && typeof window.envthaw.env.list === 'function'")
record('preload bridge exposed', bridge === true, String(bridge))

const windowApi = await evaluate(
  socket,
  "typeof window.envthaw.window.minimize === 'function' && typeof window.envthaw.window.onMaximizedChange === 'function'"
)
record('window controls bridge', windowApi === true, String(windowApi))

const info = JSON.parse(await evaluate(socket, 'window.envthaw.app.info().then((info) => JSON.stringify(info))'))
record('app.info config dir in project', info.configDir.includes('config'), info.configDir)
record('app.info data dir in project', info.dataDir.includes('data'), info.dataDir)
record('app.info versions', Boolean(info.electron), `electron=${info.electron} node=${info.node}`)
record('frameless (packaged flag readable)', typeof info.packaged === 'boolean', `packaged=${info.packaged}`)

const vars = JSON.parse(await evaluate(socket, 'window.envthaw.env.list().then((vars) => JSON.stringify(vars))'))
record('env.list via HKCU', Array.isArray(vars), `count=${vars.length} sample=${vars.slice(0, 3).map((v) => v.name).join(',')}`)

const snapshots = JSON.parse(await evaluate(socket, 'window.envthaw.env.snapshots().then((s) => JSON.stringify(s))'))
record('env.snapshots', Array.isArray(snapshots), `count=${snapshots.length}`)

const templates = JSON.parse(await evaluate(socket, 'window.envthaw.scripts.templates().then((t) => JSON.stringify(t))'))
record('script templates loaded from presets', templates.length > 0, `count=${templates.length} ids=${templates.map((t) => t.id).join(',')}`)

const scripts = JSON.parse(await evaluate(socket, 'window.envthaw.scripts.list().then((s) => JSON.stringify(s))'))
record('scripts seeded from presets', scripts.length > 0, `count=${scripts.length}`)

const redirect = JSON.parse(await evaluate(socket, 'window.envthaw.redirect.get().then((c) => JSON.stringify(c))'))
record('redirect defaults live in config dir', redirect.pythonVenvHome.includes('data'), redirect.pythonVenvHome)

const items = JSON.parse(await evaluate(socket, 'window.envthaw.redirect.items().then((i) => JSON.stringify(i))'))
record('redirect.items', items.length === 5, `count=${items.length}`)

const settings = JSON.parse(await evaluate(socket, 'window.envthaw.settings.get().then((s) => JSON.stringify(s))'))
record('settings.get', typeof settings.updateFeedUrl === 'string', `feed=${settings.updateFeedUrl || '(empty)'}`)

const update = JSON.parse(await evaluate(socket, 'window.envthaw.update.getState().then((u) => JSON.stringify(u))'))
record('update.getState', update.configured === false && update.currentVersion === info.appVersion, `status=${update.status}`)

const audit = JSON.parse(await evaluate(socket, 'window.envthaw.audit.list(10).then((a) => JSON.stringify(a))'))
record('audit.list', Array.isArray(audit), `count=${audit.length}`)

socket.close()

const failed = checks.filter((check) => !check.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exit(1)
