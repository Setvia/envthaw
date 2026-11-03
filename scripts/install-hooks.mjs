// 启用仓库自带的 git 钩子（.githooks/pre-commit、pre-push）。
// 由 package.json 的 prepare 脚本在 npm install 时自动执行；
// 在非 git 目录（CI tarball、npm pack）中静默跳过。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
if (!existsSync(path.join(root, '.git'))) process.exit(0)

const hooks = path.join(root, '.githooks')
if (!existsSync(path.join(hooks, 'pre-commit'))) {
  console.warn('[envthaw] .githooks 缺失，跳过钩子安装')
  process.exit(0)
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' })
  console.log('[envthaw] git hooks 已启用：.githooks（阻止后端代码/密钥提交与推送）')
} catch {
  console.warn('[envthaw] 无法自动启用 git hooks，请手动执行：git config core.hooksPath .githooks')
}
