// One-off UI capture helper: reloads the renderer, navigates, clicks, screenshots.
// usage: node scripts/ui-capture.mjs 9223 out.png
const port = Number(process.argv[2] ?? 9223)
const file = process.argv[3] ?? 'ui.png'
const { writeFileSync } = await import('node:fs')

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no target')
}

const page = await target()
const socket = await new Promise((resolve, reject) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let id = 1
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const messageId = id++
    const handler = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== messageId) return
      socket.removeEventListener('message', handler)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
    socket.addEventListener('message', handler)
    socket.send(JSON.stringify({ id: messageId, method, params }))
  })
}

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'threw')
  return result.result?.value
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.bringToFront').catch(() => {})
await send('Page.reload').catch(() => {})
await sleep(3000)
await send('Page.enable').catch(() => {})
await evaluate(`(async () => {
  const nav = [...document.querySelectorAll('.nav-item')].find((item) => item.textContent.includes('脚本库'))
  nav?.click()
  await new Promise((r) => setTimeout(r, 900))
  return true
})()`)
await evaluate(`(async () => {
  const item = document.querySelector('.list-item')
  item?.click()
  await new Promise((r) => setTimeout(r, 900))
  return true
})()`)
await evaluate(`(async () => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Dry-run')
  button?.click()
  await new Promise((r) => setTimeout(r, 2500))
  return true
})()`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(file, Buffer.from(shot.data, 'base64'))
console.log(`saved ${file}`)
socket.close()
