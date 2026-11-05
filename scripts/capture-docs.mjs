// Regenerates the README screenshots from a running app (dev or packaged).
// Usage: node scripts/capture-docs.mjs [cdpPort]
// Requires the app to be started with ENVTHAW_DEBUG_PORT=<port>.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const port = Number(process.argv[2] ?? 9223)
const outDir = path.resolve('docs/screenshots')
mkdirSync(outDir, { recursive: true })

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'))
if (!page) throw new Error('renderer target not found; start the app with ENVTHAW_DEBUG_PORT')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const handler = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', handler)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
    socket.addEventListener('message', handler)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation threw')
  return result?.result?.value
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function shot(name) {
  await scrubPaths()
  const capture = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outDir, `${name}.png`)
  writeFileSync(file, Buffer.from(capture.data, 'base64'))
  console.log('saved', path.relative(process.cwd(), file))
}

// The README is public: replace the checkout path with a neutral one before
// every capture so no machine-specific directory ends up in the image.
async function scrubPaths() {
  await evaluate(`(() => {
    const from = ${JSON.stringify(process.cwd())}
    const to = 'E:\\\\EnvThaw'
    const replace = (value) => (typeof value === 'string' && value.includes(from) ? value.split(from).join(to) : value)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    for (const node of nodes) {
      const next = replace(node.nodeValue)
      if (next !== node.nodeValue) node.nodeValue = next
    }
    for (const input of document.querySelectorAll('input, textarea')) {
      const next = replace(input.value)
      if (next !== input.value) input.value = next
    }
  })()`)
}

async function navigate(label) {
  await evaluate(`[...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent?.includes(${JSON.stringify(label)}))?.click()`)
  await sleep(800)
}

// --- dashboard ---
await navigate('总览')
await shot('dashboard')

// --- env vars (values blurred so no machine data ends up in the repo) ---
await navigate('环境变量')
await evaluate(`(() => {
  const style = document.createElement('style')
  style.id = 'capture-redact'
  style.textContent = '.cell-value { filter: blur(5px) !important; }'
  document.head.appendChild(style)
})()`)
await sleep(300)
await shot('env-vars')
await evaluate(`document.getElementById('capture-redact')?.remove()`)

// --- redirect ---
await navigate('路径重定向')
await shot('redirect')

// --- snapshots ---
await navigate('快照与恢复')
await shot('snapshots')

// --- scripts with a dry-run preview ---
await navigate('脚本库')
await evaluate(`document.querySelector('.list-item')?.click()`)
await sleep(400)
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Dry-run')?.click()`)
await sleep(900)
await shot('scripts-dryrun')

// --- terminal with real output (fresh session, clean scrollback) ---
await navigate('总览')
await evaluate(`(async () => {
  const list = await window.envthaw.terminal.list()
  for (const session of list) await window.envthaw.terminal.close(session.id)
  await window.envthaw.terminal.create()
  return true
})()`)
await navigate('命令行')
await sleep(1200)
const sessions = await evaluate('window.envthaw.terminal.list()')
if (sessions.length > 0) {
  await evaluate(`window.envthaw.terminal.write(${JSON.stringify(sessions[0].id)}, 'Set-Location $env:SystemDrive\\r')`)
  await sleep(600)
  await evaluate(`window.envthaw.terminal.write(${JSON.stringify(sessions[0].id)}, 'node -v\\r')`)
  await sleep(900)
  await evaluate(`window.envthaw.terminal.write(${JSON.stringify(sessions[0].id)}, 'git --version\\r')`)
  await sleep(900)
}
await shot('terminal')

// --- settings ---
await navigate('设置')
await sleep(400)
await shot('settings')

// --- user switcher modal ---
await evaluate(`document.querySelector('.user-chip')?.click()`)
await sleep(600)
await shot('users')
await evaluate(`document.querySelector('.modal-close')?.click()`)

socket.close()
console.log('done')
