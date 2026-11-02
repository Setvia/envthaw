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
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}

const bridge = await evaluate(socket, "typeof window.envthaw === 'object' && typeof window.envthaw.env.list === 'function'")
record('preload bridge exposed', bridge === true, String(bridge))

const info = await evaluate(socket, 'window.envthaw.app.info().then((info) => JSON.stringify(info))')
const infoParsed = JSON.parse(info)
record('app.info', Boolean(infoParsed.storageRoot), `storageRoot=${infoParsed.storageRoot}`)
record('app.info versions', Boolean(infoParsed.electron), `electron=${infoParsed.electron} node=${infoParsed.node}`)

const vars = await evaluate(socket, 'window.envthaw.env.list().then((vars) => JSON.stringify(vars))')
const varList = JSON.parse(vars)
record('env.list via HKCU', Array.isArray(varList), `count=${varList.length} sample=${varList.slice(0, 3).map((v) => v.name).join(',')}`)

const snapshots = await evaluate(socket, 'window.envthaw.env.snapshots().then((s) => JSON.stringify(s))')
record('env.snapshots', Array.isArray(JSON.parse(snapshots)), `count=${JSON.parse(snapshots).length}`)

const redirect = await evaluate(socket, 'window.envthaw.redirect.get().then((c) => JSON.stringify(c))')
const redirectParsed = JSON.parse(redirect)
record('redirect.get', Boolean(redirectParsed.pythonVenvHome), `venv=${redirectParsed.pythonVenvHome}`)

const items = await evaluate(socket, 'window.envthaw.redirect.items().then((i) => JSON.stringify(i))')
record('redirect.items', JSON.parse(items).length === 5, `count=${JSON.parse(items).length}`)

const scripts = await evaluate(socket, 'window.envthaw.scripts.list().then((s) => JSON.stringify(s))')
record('scripts.list', Array.isArray(JSON.parse(scripts)), `count=${JSON.parse(scripts).length}`)

const audit = await evaluate(socket, 'window.envthaw.audit.list(10).then((a) => JSON.stringify(a))')
record('audit.list', Array.isArray(JSON.parse(audit)), `count=${JSON.parse(audit).length}`)

const settings = await evaluate(socket, 'window.envthaw.settings.get().then((s) => JSON.stringify(s))')
record('settings.get', Boolean(JSON.parse(settings).storageRoot), JSON.parse(settings).storageRoot)

socket.close()

const failed = checks.filter((check) => !check.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exit(1)
