// Multi-profile + script-import smoke test.
// Verifies: profile create/switch/remove, per-profile script seeding,
// drag-drop style import (copy, not reference), and non-script warnings.
const port = Number(process.argv[2] ?? 9223)
const { existsSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const path = await import('node:path')

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
    const timer = setTimeout(() => reject(new Error(`timeout: ${expression}`)), 30000)
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

const info = await json('window.envthaw.app.info()')
const configDir = info.configDir
const work = mkdtempSync(path.join(tmpdir(), 'envthaw-import-'))
const scriptSource = path.join(work, 'hello.ps1')
const textSource = path.join(work, 'notes.txt')
writeFileSync(scriptSource, "Write-Output 'imported script'\n", 'utf8')
writeFileSync(textSource, 'just a note\n', 'utf8')

try {
  // ---- profiles ----
  const before = await json('window.envthaw.users.list()')
  check('only default profile initially', before.length === 1 && before[0].name === 'default', `users=${before.map((u) => u.name).join(',')}`)

  await evaluate(`window.envthaw.users.create('alice')`)
  const created = await json('window.envthaw.users.list()')
  check('profile created', created.some((u) => u.name === 'alice'), `users=${created.map((u) => u.name).join(',')}`)
  check('profile dir exists on disk', existsSync(path.join(configDir, 'alice', 'settings.json')), path.join(configDir, 'alice'))
  check(
    'new profile seeded with scripts',
    existsSync(path.join(configDir, 'alice', 'scripts')) && readdirSync(path.join(configDir, 'alice', 'scripts')).length > 0,
    `files=${readdirSync(path.join(configDir, 'alice', 'scripts')).length}`
  )

  await evaluate(`window.envthaw.users.switch('alice')`)
  const active = await json('window.envthaw.users.list()')
  check('profile switched', active.find((u) => u.active)?.name === 'alice', `active=${active.find((u) => u.active)?.name}`)
  const aliceInfo = await json('window.envthaw.app.info()')
  check('app.info follows active profile', aliceInfo.user === 'alice' && aliceInfo.userDir.endsWith('alice'), aliceInfo.userDir)

  await evaluate(`window.envthaw.users.switch('default')`)

  // ---- script import (in the default profile) ----
  const imported = await json(`window.envthaw.scripts.importFiles(${JSON.stringify([scriptSource, textSource])})`)
  check('import copies both files', imported.added.length === 2, `added=${imported.added.map((s) => s.file).join(',')}`)
  check('non-script file warns', imported.warnings.length === 1 && /不能运行/.test(imported.warnings[0].reason), imported.warnings[0]?.reason ?? '')

  const importedScript = imported.added.find((entry) => entry.file.endsWith('.ps1'))
  const importedText = imported.added.find((entry) => entry.type === 'other')
  check('script typed as powershell', importedScript?.type === 'powershell', importedScript?.type ?? '')
  check('text typed as other', importedText?.type === 'other', importedText?.type ?? '')

  const scriptsDir = path.join(configDir, info.user, 'scripts')
  check('copy exists in profile scripts dir', existsSync(path.join(scriptsDir, importedScript.file)), path.join(scriptsDir, importedScript.file))
  check(
    'content copied, not referenced',
    readFileSync(path.join(scriptsDir, importedScript.file), 'utf8').includes('imported script'),
    'content ok'
  )

  const runResult = await evaluate(
    `window.envthaw.scripts.run(${JSON.stringify(importedText.id)}).then(() => 'ran').catch((error) => String(error.message))`
  )
  check('running a non-script errors', /不是可执行的脚本类型/.test(String(runResult)), String(runResult).slice(0, 60))

  for (const entry of imported.added) {
    await evaluate(`window.envthaw.scripts.remove(${JSON.stringify(entry.id)})`)
  }
  check(
    'import cleanup removed files',
    !existsSync(path.join(scriptsDir, importedScript.file)),
    importedScript.file
  )

  // ---- profile removal ----
  await evaluate(`window.envthaw.users.remove('alice')`)
  const after = await json('window.envthaw.users.list()')
  check('profile removed', !after.some((u) => u.name === 'alice'), `users=${after.map((u) => u.name).join(',')}`)
  check('profile dir removed', !existsSync(path.join(configDir, 'alice')), path.join(configDir, 'alice'))
} finally {
  await evaluate(`window.envthaw.users.switch('default').catch(() => {})`)
  socket.close()
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
