// Functional smoke test: exercises the write path (registry write + broadcast,
// snapshot diff/apply/rollback, dry-run, script execution) through the real
// renderer bridge. It creates and then removes one temporary user variable.
// Run against a launched app:  node scripts/smoke-functional.mjs 9223
const port = Number(process.argv[2] ?? 9223)
const TEST_VAR = 'ENVTHAW_SMOKE_TEST'
const TEST_SCRIPT = 'envthaw-smoke-script'

async function waitForTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('devtools target not found')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
  })
}

let nextId = 1
function evaluate(socket, expression) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`timeout: ${expression}`)), 30000)
    const handler = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', handler)
      if (message.error) return reject(new Error(message.error.message))
      if (message.result?.exceptionDetails) {
        return reject(new Error(message.result.exceptionDetails.exception?.description ?? 'threw'))
      }
      resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', handler)
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

const json = async (socket, expression) => JSON.parse(await evaluate(socket, `${expression}.then((value) => JSON.stringify(value))`))

const target = await waitForTarget()
const socket = await connect(target.webSocketDebuggerUrl)

const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

// clean slate
await json(socket, `window.envthaw.env.list()`)
await evaluate(socket, `window.envthaw.env.remove(${JSON.stringify(TEST_VAR)}).catch(() => {})`)

const snapshot = await json(socket, `window.envthaw.env.saveSnapshot('smoke-test', 'automated functional test')`)
check('save snapshot', Boolean(snapshot.id), `id=${snapshot.id} vars=${Object.keys(snapshot.userVars).length}`)

await evaluate(socket, `window.envthaw.env.set(${JSON.stringify(TEST_VAR)}, 'hello-环境变量')`)
const afterSet = await json(socket, `window.envthaw.env.list()`)
const written = afterSet.find((entry) => entry.name === TEST_VAR)
check('registry write + unicode value', written?.value === 'hello-环境变量', `value=${written?.value}`)

// diff(snapshot) is expressed as "current -> snapshot", so a variable that only
// exists now must be reported as a removal when the snapshot is restored.
const diff = await json(socket, `window.envthaw.env.diff(${JSON.stringify(snapshot.id)})`)
const added = diff.find((entry) => entry.name === TEST_VAR)
check('diff detects variable added after snapshot', added?.kind === 'removed' && added?.before === 'hello-环境变量', `kind=${added?.kind}`)

const applied = await json(socket, `window.envthaw.env.apply(${JSON.stringify(snapshot.id)})`)
const afterApply = await json(socket, `window.envthaw.env.list()`)
check(
  'apply restores snapshot (temp var removed)',
  applied.failed.length === 0 && !afterApply.some((entry) => entry.name === TEST_VAR),
  `applied=${applied.applied} rollback=${applied.rollbackId}`
)

const rolled = await json(socket, `window.envthaw.env.rollback(${JSON.stringify(applied.rollbackId)})`)
const afterRollback = await json(socket, `window.envthaw.env.list()`)
check('rollback brings the temp var back', rolled.failed.length === 0 && afterRollback.some((entry) => entry.name === TEST_VAR), `applied=${rolled.applied}`)

await evaluate(socket, `window.envthaw.env.remove(${JSON.stringify(TEST_VAR)})`)
const afterCleanup = await json(socket, `window.envthaw.env.list()`)
check('cleanup', !afterCleanup.some((entry) => entry.name === TEST_VAR))

// ---- scripts ----
const info = await json(socket, `window.envthaw.app.info()`)
const smokeDir = `${info.dataDir}\\smoke-dir`
const scriptContent = `$env:ENVTHAW_SMOKE = '1'\nWrite-Output 'hello from script'\nNew-Item -ItemType Directory -Path '${smokeDir}' -Force | Out-Null`
const savedScript = await json(
  socket,
  `window.envthaw.scripts.save({ id: ${JSON.stringify(TEST_SCRIPT)}, name: 'smoke script', type: 'powershell', content: ${JSON.stringify(scriptContent)} })`
)
check('script save', savedScript.id === TEST_SCRIPT, `id=${savedScript.id}`)

const dry = await json(socket, `window.envthaw.scripts.dryRun(${JSON.stringify(TEST_SCRIPT)})`)
check('dry-run detects env write', dry.changes.some((change) => change.target === 'ENVTHAW_SMOKE'), `changes=${dry.changes.length}`)
check('dry-run detects mkdir', dry.changes.some((change) => change.kind === 'mkdir'), `warnings=${dry.warnings.length}`)

const run = await json(socket, `window.envthaw.scripts.run(${JSON.stringify(TEST_SCRIPT)})`)
check('script executes', run.exitCode === 0 && run.stdout.includes('hello from script'), `exit=${run.exitCode} stdout=${JSON.stringify(run.stdout.trim().slice(0, 60))}`)

await evaluate(socket, `window.envthaw.scripts.remove(${JSON.stringify(TEST_SCRIPT)})`)
const scriptsLeft = await json(socket, `window.envthaw.scripts.list()`)
check('script cleanup', !scriptsLeft.some((entry) => entry.id === TEST_SCRIPT))

// ---- snapshots cleanup + audit ----
const snapshots = await json(socket, `window.envthaw.env.snapshots()`)
const auto = snapshots.filter((entry) => entry.name.startsWith('运行前：'))
for (const entry of [...snapshots.filter((item) => item.name === 'smoke-test'), ...auto]) {
  await evaluate(socket, `window.envthaw.env.deleteSnapshot(${JSON.stringify(entry.id)})`)
}
const snapshotsLeft = await json(socket, `window.envthaw.env.snapshots()`)
check(
  'snapshot cleanup',
  !snapshotsLeft.some((entry) => entry.name === 'smoke-test' || entry.name.startsWith('运行前：')),
  `left=${snapshotsLeft.length}`
)

const audit = await json(socket, `window.envthaw.audit.list(50)`)
check('audit log recorded operations', audit.length >= 5, `entries=${audit.length}`)

socket.close()

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
