// Terminal integration smoke test: drives the real app through CDP.
// Covers: tab creation, command execution, cwd builtin, independent scrollback,
// tab close. Usage: node scripts/smoke-terminal.mjs [cdpPort]
const port = Number(process.argv[2] ?? 9223)

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let id = 1
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const callId = id++
    const handler = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== callId) return
      socket.removeEventListener('message', handler)
      if (message.error) return reject(new Error(message.error.message))
      if (message.result?.exceptionDetails) {
        return reject(new Error(message.result.exceptionDetails.exception?.description ?? 'threw'))
      }
      resolve(message.result)
    }
    socket.addEventListener('message', handler)
    socket.send(JSON.stringify({ id: callId, method, params }))
  })
}

const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

async function waitForIdle(sessionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await evaluate('window.envthaw.terminal.list()')
    const session = (list ?? []).find((item) => item.id === sessionId)
    if (session && !session.running) return true
    await sleep(200)
  }
  return false
}

async function waitForBuffer(sessionId, needle, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const buffer = await evaluate(`window.envthaw.terminal.buffer(${JSON.stringify(sessionId)})`)
    if (typeof buffer === 'string' && buffer.includes(needle)) return buffer
    await sleep(300)
  }
  return null
}

// Remount the page (navigate away and back) so its state is rebuilt from the
// main process; a blocked in-app reload would not remount React.
await evaluate(`[...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent?.includes('总览'))?.click()`)
await sleep(300)
await evaluate(`[...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent?.includes('命令行'))?.click()`)
await sleep(900)

const pageState = await evaluate(`(() => ({
  hasPage: !!document.querySelector('.term-page'),
  tabs: document.querySelectorAll('.term-tab').length,
  hasInput: !!document.querySelector('.term-input')
}))()`)
check('terminal page renders with a tab', pageState?.hasPage === true && pageState.tabs >= 1 && pageState.hasInput === true, JSON.stringify(pageState))

let sessions = await evaluate('window.envthaw.terminal.list()')
check('main process has a session', Array.isArray(sessions) && sessions.length >= 1, `count=${sessions?.length}`)

const first = sessions[0]
await evaluate(`window.envthaw.terminal.run(${JSON.stringify(first.id)}, 'echo hello-envthaw')`)
const echoBuffer = await waitForBuffer(first.id, 'hello-envthaw')
await waitForIdle(first.id)
check('runs a command and streams output', Boolean(echoBuffer), echoBuffer ? 'echo ok' : 'timeout')

await evaluate(`window.envthaw.terminal.run(${JSON.stringify(first.id)}, 'cd data')`)
await waitForIdle(first.id)
await sleep(300)
sessions = await evaluate('window.envthaw.terminal.list()')
const moved = sessions.find((item) => item.id === first.id)
check('cd updates the tab cwd', Boolean(moved?.cwd) && /[\\/]data$/.test(moved.cwd), moved?.cwd ?? '')
check('cd output is echoed', Boolean(await waitForBuffer(first.id, '工作目录')), 'cd echo')

await evaluate(`document.querySelector('.term-new')?.click()`)
await sleep(700)
sessions = await evaluate('window.envthaw.terminal.list()')
const second = sessions.find((item) => item.id !== first.id)
check('creates a second tab', Boolean(second?.id), second?.title ?? '')

await evaluate(`window.envthaw.terminal.run(${JSON.stringify(second.id)}, 'node -v')`)
const nodeOut = await waitForBuffer(second.id, 'v2')
await waitForIdle(second.id)
check('second tab runs node -v', Boolean(nodeOut), nodeOut?.split('\n').find((line) => line.startsWith('v')) ?? 'timeout')

const firstBuffer = await evaluate(`window.envthaw.terminal.buffer(${JSON.stringify(first.id)})`)
const secondBuffer = await evaluate(`window.envthaw.terminal.buffer(${JSON.stringify(second.id)})`)
check(
  'tabs keep independent scrollback',
  firstBuffer.includes('hello-envthaw') && !secondBuffer.includes('hello-envthaw') && secondBuffer.includes('node -v'),
  'buffers separated'
)

const domTabs = await evaluate('document.querySelectorAll(".term-tab").length')
check('UI shows both tabs', domTabs >= 2, `tabs=${domTabs}`)

await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.term-tab')]
  const tab = tabs[tabs.length - 1]
  tab?.querySelector('.term-tab-close')?.click()
  return Boolean(tab)
})()`)
await sleep(400)
const confirmClicked = await evaluate(`(() => {
  const button = document.querySelector('.modal-footer .btn.danger')
  button?.click()
  return !!button
})()`)
await sleep(600)
check('closing a tab asks for confirmation', confirmClicked === true, String(confirmClicked))
const afterClose = await evaluate('window.envthaw.terminal.list()')
check('closing a tab removes the session', !afterClose.some((item) => item.id === second.id), `count=${afterClose.length}`)

// Close the remaining tabs through the UI so renderer and main stay in sync.
for (let guard = 0; guard < 10; guard += 1) {
  const openTabs = await evaluate('document.querySelectorAll(\'.term-tab\').length')
  if (!openTabs) break
  await evaluate(`document.querySelector('.term-tab .term-tab-close')?.click()`)
  await sleep(300)
  await evaluate(`document.querySelector('.modal-footer .btn.danger')?.click()`)
  await sleep(400)
}

const failed = checks.filter((item) => !item.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
socket.close()
process.exit(failed === 0 ? 0 : 1)
