// Terminal integration smoke test (PTY / xterm): drives the real app through CDP.
// Covers: xterm rendering, native PowerShell state, Chinese output, second tab,
// independent scrollback and tab close. Usage: node scripts/smoke-terminal.mjs [port]
const port = Number(process.argv[2] ?? 9223)

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
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw')
  return r?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

async function buffer(sessionId) {
  return evaluate(`window.envthaw.terminal.buffer(${JSON.stringify(sessionId)})`)
}

async function waitFor(sessionId, needle, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await buffer(sessionId)
    if (typeof text === 'string' && text.includes(needle)) return text
    await sleep(200)
  }
  return null
}

const type = (sessionId, text) =>
  evaluate(`window.envthaw.terminal.write(${JSON.stringify(sessionId)}, ${JSON.stringify(text)})`)

// Reset to a known state: navigate away, close every session, create exactly one,
// then mount the page so the UI starts from a single tab.
await evaluate(`[...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent?.includes('总览'))?.click()`)
await sleep(300)
await evaluate(`(async () => {
  const list = await window.envthaw.terminal.list()
  for (const session of list) await window.envthaw.terminal.close(session.id)
  await window.envthaw.terminal.create()
  return true
})()`)
await evaluate(`[...document.querySelectorAll('nav button, aside button')].find((b) => b.textContent?.includes('命令行'))?.click()`)
await sleep(1200)

const dom = await evaluate(`(() => ({
  hasPage: !!document.querySelector('.term-page'),
  hasXterm: !!document.querySelector('.xterm'),
  hasInput: !!document.querySelector('.term-input'),
  rows: document.querySelectorAll('.xterm-rows > div').length
}))()`)
check('xterm is rendered', dom.hasPage === true && dom.hasXterm === true && dom.rows > 0, JSON.stringify(dom))
check('no custom input box', dom.hasInput === false, String(dom.hasInput))

const sessions = await evaluate('window.envthaw.terminal.list()')
check('exactly one tab after first mount', sessions.length === 1, `count=${sessions.length}`)
const first = sessions[0]
check('powerShell pty is running', first.running === true, first.id)

await type(first.id, 'echo hello-pty')
await type(first.id, '\r')
check('command output streams to xterm', Boolean(await waitFor(first.id, 'hello-pty')), 'echo ok')

// A real shell keeps state between lines (the old pipe version could not).
await type(first.id, '$envthawState = 41')
await type(first.id, '\r')
await type(first.id, 'Write-Output ($envthawState + 1)')
await type(first.id, '\r')
check('powershell state persists', Boolean(await waitFor(first.id, '42')), 'state ok')

await type(first.id, 'Set-Location data')
await type(first.id, '\r')
await type(first.id, 'Write-Output (Get-Location).Path')
await type(first.id, '\r')
check('Set-Location works in the shell', Boolean(await waitFor(first.id, '\\data')), 'cwd ok')

await type(first.id, 'Write-Output "中文 pty 测试"')
await type(first.id, '\r')
check('unicode output renders', Boolean(await waitFor(first.id, '中文 pty 测试')), 'zh ok')

await evaluate(`document.querySelector('.term-new')?.click()`)
await sleep(1200)
const two = await evaluate('window.envthaw.terminal.list()')
check('second tab spawns another shell', two.length === 2 && two.every((item) => item.running), two.map((s) => s.title).join(' | '))
const second = two.find((item) => item.id !== first.id)

await type(second.id, 'node -v')
await type(second.id, '\r')
const nodeOut = await waitFor(second.id, 'v2')
check('second tab runs node', Boolean(nodeOut), nodeOut?.split('\n').find((line) => line.trim().startsWith('v')) ?? 'timeout')

const firstBuffer = await buffer(first.id)
const secondBuffer = await buffer(second.id)
check('tabs keep independent scrollback', firstBuffer.includes('hello-pty') && !secondBuffer.includes('hello-pty'), 'buffers separated')

const tabsDom = await evaluate(`document.querySelectorAll('.term-tab').length`)
check('two tabs in UI', tabsDom === 2, `tabs=${tabsDom}`)

// Close the second tab through the UI (confirm dialog included).
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.term-tab')]
  tabs[tabs.length - 1]?.querySelector('.term-tab-close')?.click()
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
check('closing a tab removes the session', afterClose.length === 1 && !afterClose.some((item) => item.id === second.id), `count=${afterClose.length}`)

const failed = checks.filter((item) => !item.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
socket.close()
process.exit(failed === 0 ? 0 : 1)
