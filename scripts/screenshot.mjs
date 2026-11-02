// Captures a screenshot of the app's renderer through the DevTools protocol.
// usage: node scripts/screenshot.mjs 9223 out.png ["环境变量"]
const port = Number(process.argv[2] ?? 9223)
const file = process.argv[3] ?? 'screenshot.png'
const navLabel = process.argv[4]
const { writeFileSync } = await import('node:fs')

async function target() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('devtools target not found')
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

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.bringToFront').catch(() => {})
await send('Page.reload').catch(() => {})
await new Promise((resolve) => setTimeout(resolve, 3000))

if (navLabel) {
  await send('Runtime.evaluate', {
    expression: `(async () => {
      const button = [...document.querySelectorAll('.nav-item')].find((item) => item.textContent.includes(${JSON.stringify(navLabel)}))
      if (button) button.click()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      return true
    })()`,
    awaitPromise: true,
    returnByValue: true
  })
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(file, Buffer.from(shot.data, 'base64'))
console.log(`saved ${file}`)
socket.close()
