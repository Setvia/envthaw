// Cloud integration smoke test: drives the real Electron app through CDP and
// verifies the client <-> backend round trip (login, push, pull, logout).
// Usage: node scripts/smoke-cloud.mjs [cdpPort] [apiBase]
const port = Number(process.argv[2] ?? 9223)
const apiBase = (process.argv[3] ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const { createHash } = await import('node:crypto')

const RUN = Date.now().toString(36)
const EMAIL = `cloud-smoke-${RUN}@example.edu`
const REMOTE_REF = `snap-cloud-remote-${RUN}`

async function waitForTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && !target.url.startsWith('devtools://'))
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
    const timer = setTimeout(() => reject(new Error(`timeout evaluating ${expression}`)), 30000)
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

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

async function http(method, path, body, token) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: response.status, json }
}

async function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function loginViaHttp(deviceName) {
  const start = await http('POST', '/v1/auth/email/start', { email: EMAIL })
  const code = start.json?.dev_code
  if (!code) throw new Error('backend not in DEV_MODE, cannot fetch the email code')
  const verify = await http('POST', '/v1/auth/email/verify', {
    email: EMAIL,
    code,
    device: { name: deviceName, platform: 'win32', app_version: '0.1.0' }
  })
  if (verify.status !== 200) throw new Error(`login failed: ${JSON.stringify(verify.json)}`)
  return verify.json
}

async function pushFromHttp(token, ref, vars) {
  const bytes = JSON.stringify(vars)
  const digest = await sha256(bytes)
  const init = await http('POST', '/v1/blobs', { sha256: digest, size: Buffer.byteLength(bytes) }, token)
  if (!init.json.existing) {
    const put = await fetch(init.json.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from(bytes)
    })
    if (put.status !== 204) throw new Error(`upload failed: ${put.status}`)
  }
  await http('POST', `/v1/blobs/${init.json.blob_id}/commit`, undefined, token)
  const result = await http(
    'POST',
    '/v1/sync/mutations',
    {
      mutations: [
        {
          client_mutation_id: `${ref}-${Date.now()}`,
          entity: 'snapshot',
          client_ref: ref,
          op: 'upsert',
          base_version: 0,
          name: '来自另一台设备',
          blob_id: init.json.blob_id,
          content_hash: `sha256:${digest}`,
          encryption: 'server',
          vars
        }
      ]
    },
    token
  )
  return result.json.results[0]
}

const target = await waitForTarget()
const socket = await connect(target.webSocketDebuggerUrl)

const bridge = await evaluate(
  socket,
  "typeof window.envthaw.cloud === 'object' && typeof window.envthaw.cloud.syncNow === 'function' && typeof window.envthaw.cloud.loginVerify === 'function'"
)
check('cloud bridge exposed', bridge === true, String(bridge))

const serverState = await evaluate(socket, `window.envthaw.cloud.setServer(${JSON.stringify(apiBase)})`)
check('setServer accepted', serverState?.serverUrl === apiBase, JSON.stringify(serverState))

let started = null
try {
  started = await evaluate(socket, `window.envthaw.cloud.loginStart(${JSON.stringify(EMAIL)})`)
} catch (error) {
  check('loginStart', false, error.message)
}
check('loginStart returns a dev code', Boolean(started?.devCode), JSON.stringify(started ?? {}))
if (!started?.devCode) {
  console.log('\nbackend is not reachable or not in DEV_MODE; aborting')
  process.exit(1)
}

const signedIn = await evaluate(socket, `window.envthaw.cloud.loginVerify(${JSON.stringify(EMAIL)}, ${JSON.stringify(started.devCode)})`)
check('loginVerify signs in', signedIn?.signedIn === true, JSON.stringify({ email: signedIn?.email, device: signedIn?.deviceId }))

const snapshot = await evaluate(socket, `window.envthaw.env.saveSnapshot('云同步测试', 'smoke-cloud')`)
check('local snapshot created', Boolean(snapshot?.id), snapshot?.id ?? '')

const firstSync = await evaluate(socket, 'window.envthaw.cloud.syncNow()')
check('syncNow pushes local snapshots', firstSync?.pushed >= 1, JSON.stringify(firstSync))

// Verify from "another device" over plain HTTP that the snapshot really landed.
const deviceB = await loginViaHttp('smoke 另一台设备')
const pullB = await http('GET', '/v1/sync?cursor=0', undefined, deviceB.access_token)
const landed = pullB.json?.changes?.find((change) => change.snapshot.client_ref === snapshot.id)
check('backend received the snapshot', Boolean(landed) && landed.snapshot.latest_version >= 1, JSON.stringify(landed?.snapshot ?? null))

// Push a snapshot from device B, then pull it into the app.
const pushed = await pushFromHttp(deviceB.access_token, REMOTE_REF, { CLOUD_ONLY: 'yes' })
check('device B pushed a snapshot', pushed?.status === 'applied', JSON.stringify(pushed))

const secondSync = await evaluate(socket, 'window.envthaw.cloud.syncNow()')
check('syncNow pulls the remote snapshot', secondSync?.pulled >= 1, JSON.stringify(secondSync))

const snapshots = await evaluate(socket, 'window.envthaw.env.snapshots()')
const remote = (snapshots ?? []).find((item) => item.id === REMOTE_REF)
check(
  'remote snapshot restored locally',
  Boolean(remote) && remote.userVars?.CLOUD_ONLY === 'yes',
  JSON.stringify(remote?.userVars ?? null)
)

const status = await evaluate(socket, 'window.envthaw.cloud.status()')
check('status reports no pending work', status?.pending === 0, JSON.stringify({ pending: status?.pending, conflicts: status?.conflicts?.length }))

const afterLogout = await evaluate(socket, 'window.envthaw.cloud.logout()')
check('logout clears the session', afterLogout?.signedIn === false, JSON.stringify(afterLogout))

// Best-effort cleanup of the snapshots this test created.
for (const id of [snapshot.id, REMOTE_REF]) {
  try {
    await evaluate(socket, `window.envthaw.env.deleteSnapshot(${JSON.stringify(id)})`)
  } catch {
    // ignore
  }
}

const failed = checks.filter((item) => !item.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
