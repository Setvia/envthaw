// Diagnostic: runs a PowerShell script through the app's own script runner so we
// can inspect the token/registry rights of processes spawned by Electron.
const port = Number(process.argv[2] ?? 9223)

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
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const messageId = id++
    const handler = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== messageId) return
      socket.removeEventListener('message', handler)
      if (message.error) reject(new Error(message.error.message))
      else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description ?? 'threw'))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', handler)
    socket.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}

const content = [
  'Write-Output ("whoami=" + (whoami))',
  "whoami /groups | Select-String 'Mandatory|Restricted|Integrity' | ForEach-Object { Write-Output ('grp=' + $_) }",
  'try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true); Write-Output ("env-open=" + ($k -ne $null)); if ($k) { $k.Close() } } catch { Write-Output ("env-open-fail=" + $_.Exception.Message) }',
  'try { $k2 = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\\EnvThawSmoke", $true); $k2.SetValue("x", "1"); $k2.Close(); Write-Output "software-write=ok" } catch { Write-Output ("software-write-fail=" + $_.Exception.Message) }',
  'Write-Output ("user=" + [Security.Principal.WindowsIdentity]::GetCurrent().Name)'
].join('\n')

const scriptId = `diag-${Date.now()}`
await evaluate(
  `window.envthaw.scripts.save({ id: ${JSON.stringify(scriptId)}, name: 'diag', type: 'powershell', content: ${JSON.stringify(content)} })`
)
const run = JSON.parse(await evaluate(`window.envthaw.scripts.run(${JSON.stringify(scriptId)}).then((r) => JSON.stringify(r))`))
console.log('exit =', run.exitCode)
console.log('stdout:\n' + run.stdout)
console.log('stderr:\n' + run.stderr)
await evaluate(`window.envthaw.scripts.remove(${JSON.stringify(scriptId)})`)
socket.close()
