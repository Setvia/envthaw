// Local end-to-end test for the update flow (no real site yet):
// serves a manifest + package over http://127.0.0.1, drives check()/download()
// through the running app, and exercises the SHA-256 verification failure path.
const port = Number(process.argv[2] ?? 9223)
const feedPort = 8877
const { createHash, randomBytes } = await import('node:crypto')
const { createServer } = await import('node:http')
const { readFileSync, existsSync, rmSync } = await import('node:fs')

const payload = randomBytes(1_500_000)
const sha256 = createHash('sha256').update(payload).digest('hex')
let servedSha = sha256

const server = createServer((request, response) => {
  if (request.url === '/latest.json') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        version: '9.9.9',
        url: `http://127.0.0.1:${feedPort}/pkg.exe`,
        sha256: servedSha,
        size: payload.length,
        publishedAt: Date.now(),
        notes: '本地更新流程测试\n- 检查版本\n- 下载并校验 SHA-256'
      })
    )
    return
  }
  if (request.url === '/pkg.exe') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length })
    response.end(payload)
    return
  }
  response.writeHead(404)
  response.end('not found')
})

await new Promise((resolve) => server.listen(feedPort, '127.0.0.1', resolve))
console.log(`feed listening on http://127.0.0.1:${feedPort}`)

async function target() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && !item.url.startsWith('devtools://'))
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
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const messageId = id++
    const timer = setTimeout(() => reject(new Error(`timeout: ${expression}`)), 60000)
    const handler = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== messageId) return
      clearTimeout(timer)
      socket.removeEventListener('message', handler)
      if (message.error) reject(new Error(message.error.message))
      else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description ?? 'threw'))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', handler)
    socket.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

const json = async (expression) => JSON.parse(await evaluate(`${expression}.then((value) => JSON.stringify(value))`))

const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

const original = await json('window.envthaw.settings.get()')
try {
  await evaluate(`window.envthaw.settings.save(${JSON.stringify({ ...original, updateFeedUrl: `http://127.0.0.1:${feedPort}/latest.json` })})`)

  const state = await json('window.envthaw.update.getState()')
  check('state reports configured feed', state.configured === true && state.feedUrl.includes('latest.json'), state.feedUrl)

  const checked = await json('window.envthaw.update.check()')
  check('check finds newer version', checked.status === 'available' && checked.release?.version === '9.9.9', `status=${checked.status}`)
  check('release notes parsed', (checked.release?.notes ?? '').includes('本地更新流程'), `notes=${(checked.release?.notes ?? '').slice(0, 12)}`)

  const downloaded = await json('window.envthaw.update.download()')
  check('download completes', downloaded.status === 'downloaded', `status=${downloaded.status} error=${downloaded.error ?? ''}`)
  check('file exists', Boolean(downloaded.filePath) && existsSync(downloaded.filePath), downloaded.filePath ?? '')
  if (downloaded.filePath && existsSync(downloaded.filePath)) {
    const digest = createHash('sha256').update(readFileSync(downloaded.filePath)).digest('hex')
    check('sha256 matches', digest === sha256, digest.slice(0, 12))
  }

  // negative: the manifest now advertises a wrong digest
  servedSha = 'a'.repeat(64)
  const recheck = await json('window.envthaw.update.check()')
  check('re-check after digest change', recheck.status === 'available', recheck.status)
  const failed = await json('window.envthaw.update.download()')
  check('bad digest is rejected', failed.status === 'error' && /校验失败/.test(failed.error ?? ''), failed.error ?? '')
  check('partial file cleaned up', !(failed.filePath ?? '').endsWith('.part'))
  servedSha = sha256
} finally {
  await evaluate(`window.envthaw.settings.save(${JSON.stringify(original)})`)
  if (existsSync('config/updates')) {
    for (const entry of (await import('node:fs')).readdirSync('config/updates')) {
      rmSync(`config/updates/${entry}`, { force: true })
    }
  }
  socket.close()
  server.close()
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
