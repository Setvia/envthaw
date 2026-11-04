// Verifies interactive stdin support and Ctrl+C / Ctrl+D behaviour.
const port = 9223
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'))
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
      resolve(message.result)
    }
    socket.addEventListener('message', handler)
    socket.send(JSON.stringify({ id: callId, method, params }))
  })
}
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'threw')
  return result?.result?.value
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

async function runningOf(sessionId) {
  const list = await evaluate('window.envthaw.terminal.list()')
  return (list ?? []).find((item) => item.id === sessionId)?.running === true
}

async function waitIdle(sessionId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await runningOf(sessionId))) return true
    await sleep(150)
  }
  return false
}

await evaluate(`[...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent?.includes('命令行'))?.click()`)
await sleep(700)
// Make sure the tab we drive is the active one (Ctrl+C targets the active tab).
await evaluate(`document.querySelector('.term-tab')?.click()`)
await sleep(400)
const sessions = await evaluate('window.envthaw.terminal.list()')
const session = sessions[0]
check('terminal available', Boolean(session?.id), session?.id ?? '')
check('exactly one tab after first mount', sessions.length === 1, `count=${sessions.length}`)

// --- 1) stdin reaches a waiting command (pause) ---
await evaluate(`window.envthaw.terminal.run(${JSON.stringify(session.id)}, 'cmd /c pause')`)
await sleep(1000)
check('pause is waiting for input', await runningOf(session.id), 'running')

const writeResult = await evaluate(`(async () => {
  try { await window.envthaw.terminal.write(${JSON.stringify(session.id)}, '\\r\\n'); return 'ok' }
  catch (error) { return String(error) }
})()`)
check('write to stdin accepted', writeResult === 'ok', String(writeResult))
check('pause exits after Enter', await waitIdle(session.id, 5000), 'idle')
const pauseBuffer = await evaluate(`window.envthaw.terminal.buffer(${JSON.stringify(session.id)})`)
check('pause output was captured', /请按任意键|Press any key/i.test(pauseBuffer ?? ''), (pauseBuffer ?? '').split('\n').slice(-3).join(' | '))

// --- 2) Ctrl+C kills a long-running command from outside the input ---
await evaluate(`window.envthaw.terminal.run(${JSON.stringify(session.id)}, 'ping -n 30 127.0.0.1')`)
await sleep(1200)
check('long command is running', await runningOf(session.id), 'running')

const keyProbe = await evaluate(`(() => {
  window.__keyProbe = 0
  document.addEventListener('keydown', () => { window.__keyProbe += 1 }, true)
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
  return window.__keyProbe
})()`)
check('keydown reaches document listeners', keyProbe > 0, 'probe=' + keyProbe)
await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))`)
check('Ctrl+C terminates the command', await waitIdle(session.id, 8000), 'idle after Ctrl+C')

// --- 3) Ctrl+D closes stdin (EOF) so readers can finish ---
await evaluate(`window.envthaw.terminal.run(${JSON.stringify(session.id)}, 'cmd /c pause')`)
await sleep(900)
const dResult = await evaluate(`(async () => {
  const input = document.querySelector('.term-input')
  if (!input) return 'no-input'
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))
  return 'dispatched'
})()`)
check('Ctrl+D dispatched on input', dResult === 'dispatched', String(dResult))
check('Ctrl+D ends the waiting command', await waitIdle(session.id, 6000), 'idle after EOF')

// --- 4) Typing into the input while a command waits sends it to stdin ---
await evaluate(`window.envthaw.terminal.run(${JSON.stringify(session.id)}, 'cmd /c pause')`)
await sleep(900)
const typed = await evaluate(`(() => {
  const input = document.querySelector('.term-input')
  const form = document.querySelector('.term-input-row')
  if (!input || !form) return 'missing'
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, 'hello')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  form.requestSubmit()
  return 'submitted'
})()`)
check('UI sends typed input while running', typed === 'submitted', String(typed))
check('typed line satisfies pause', await waitIdle(session.id, 6000), 'idle after keyboard send')
const typedBuffer = await evaluate(`window.envthaw.terminal.buffer(${JSON.stringify(session.id)})`)
check('pause output present after UI send', /请按任意键|Press any key/i.test(typedBuffer ?? ''), 'ok')

const failed = checks.filter((item) => !item.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
socket.close()
process.exit(failed === 0 ? 0 : 1)
