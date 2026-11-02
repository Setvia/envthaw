# EnvThaw · 环境管理器

面向学生开发者的、**冰点还原环境下的可持久化开发工作区编排工具**。
把公共机房电脑变成自己熟悉的开发环境，重启后重新登录即可恢复。

> 实现自《环境管理器（EnvMgr）开发文档（草案）》v0.1 的本地 MVP（P0 + 部分 P1）。
> 仓库：<https://github.com/Setvia/envthaw>

![总览](docs/screenshots/dashboard.png)

## 功能

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 环境变量管理 | ✅ | 读取 / 搜索 / 新增 / 修改 / 删除 `HKCU\Environment`，保留 `REG_EXPAND_SZ` 语义，写入后广播 `WM_SETTINGCHANGE` |
| 快照与恢复 | ✅ | 保存用户级变量快照；恢复前展示 diff，只改差异项；每次变更自动生成回滚点，可一键撤销 |
| 路径重定向 | ✅ | `WORKON_HOME` / `PIP_CACHE_DIR` / `NPM_CONFIG_PREFIX` / `NPM_CONFIG_CACHE` / `GIT_CONFIG_GLOBAL`，自动建目录并写 Git 身份 |
| 脚本库 | ✅ | 批处理 / PowerShell 脚本保存到非保护盘；执行前自动 dry-run 预览写操作；超时 180s 结束整个进程树；执行前自动快照 |
| 配置包 | ✅ | 导出 / 导入 JSON（设置、重定向、快照、脚本） |
| 审计日志 | ✅ | 所有写操作落 `audit.jsonl`，UI 可查 |
| 内嵌命令行 | ⬜ | 文档中为 P1，本期未实现 |
| 云同步 / 账号 | ⬜ | 文档中为付费能力（M6+），本期未实现 |
| Agent 辅助 | ⬜ | 文档中为付费能力（M8），本期未实现 |

### 界面

| 环境变量 | 脚本 + dry-run |
| --- | --- |
| ![环境变量](docs/screenshots/env-vars.png) | ![脚本库](docs/screenshots/scripts-dryrun.png) |

| 路径重定向 | 快照恢复 |
| --- | --- |
| ![路径重定向](docs/screenshots/redirect.png) | ![快照](docs/screenshots/snapshots.png) |

## 技术栈

- **electron-vite 6 + Vite 8 + TypeScript 7 + React 19**
- 主进程只使用 Node 内置模块（`fs` / `child_process`），注册表读写走 PowerShell（无需 native 依赖）
- 参数校验：`zod`（`src/shared/config-schema.ts`）
- 打包：`electron-builder`（portable target，见 `package.json#build`）

## 目录结构

```
src/
├── main/                 # 主进程：窗口、IPC、服务
│   ├── index.ts          # 入口、窗口安全配置、生命周期
│   ├── ipc/              # env / script / path / transfer / app / audit handlers
│   ├── services/
│   │   ├── env-service.ts      # 变量读写 + 快照 + 回滚
│   │   ├── restore-engine.ts   # 纯 diff / 逆向 diff
│   │   ├── script-runner.ts    # dry-run 解析 + 执行引擎
│   │   ├── path-redirect.ts    # 重定向配置与落地
│   │   └── storage.ts          # 存储根、JSON 持久化、审计
│   └── utils/            # powershell / registry
├── preload/              # contextBridge：window.envthaw
├── renderer/             # React 界面
└── shared/               # IPC 类型与 zod schema（唯一真相源）
```

## 开发

```bash
npm install
npm run dev      # electron-vite dev（HMR）
npm start        # 构建后以生产模式启动
npm run build    # 只构建
npm run typecheck
```

### Windows 启动器说明（`scripts/launch.js`）

这台机器上踩到的三个坑，启动器里都做了处理，不必手动干预：

1. **`ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`** —— 由 IDE 调试终端或 npm 钩子注入，会让 `electron.exe` 变成纯 Node（`require('electron')` 返回字符串），或者预加载调试 bootloader 吞掉主进程日志。启动器对子进程删除这两个变量。
2. **Chromium 沙箱在特定目录下无法初始化** —— 当 `electron.exe` 位于被安全过滤驱动特殊处理的工作区目录时，浏览器进程会在 `app.whenReady()` 之前崩溃（`0xC0000005` / `0x80000003`）。首次启动会把 electron 运行时镜像到
   `%LOCALAPPDATA%\EnvThaw\runtime\<version>`，再用目录联接（junction）接回 `node_modules/electron/dist`，沙箱即可正常工作。想跳过镜像：`ENVTHAW_LOCAL_RUNTIME=1 npm run dev`。
3. **兜底**：如果沙箱仍然起不来，会自动用 `--no-sandbox` 重试一次。此时进程是 **Low 完整性级别**，只能读环境变量、不能写。界面会在写入失败时直接展示错误原因。

> 正常桌面环境（非受限目录、非受限 shell）不需要上述任何处理，`npm run dev` 直接可用。

## 数据位置

默认 `D:\EnvThaw\`（不可写时依次退回便携目录、应用数据目录、`~/EnvThaw`）。

```
D:\EnvThaw\
├── settings.json      # 设置
├── snapshots.json     # 环境快照
├── scripts.json       # 脚本库
├── redirect.json      # 路径重定向配置
├── audit.jsonl        # 审计日志
├── rollbacks\         # 每次变更前的回滚点
└── tmp\               # 脚本执行临时文件
```

Chromium 的 profile 在开发模式下放在项目内的 `.electron-profile/`，打包后使用默认的 `%APPDATA%`。

## 安全设计

- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webviewTag: false`
- 渲染进程只能通过 `window.envthaw` 调用 IPC；**每个 handler 都用 zod 校验参数**
- 禁止新窗口与外部导航（`setWindowOpenHandler` 拒绝 + `will-navigate` 拦截）
- 只操作 `HKCU\Environment`，**从不触碰系统级变量**（HKLM）
- 脚本不会自动执行；dry-run 预览 → 用户确认 → 执行 → 自动快照 + 审计
- 所有写入前创建回滚点，支持一键撤销

## 测试

应用启动后可以跑两个基于 DevTools 协议的冒烟测试（需要调试端口）：

```bash
# 启动时打开调试端口
set ENVTHAW_DEBUG_PORT=9223 && npm start

# 只读检查：preload 桥、IPC、注册表读取、重定向配置
node scripts/smoke.mjs 9223

# 写路径检查：注册表写入（含中文值）、快照 diff/恢复/回滚、dry-run、脚本执行
node scripts/smoke-functional.mjs 9223
```

实测结果：只读 10/10、功能 13/13 通过（Windows 10 22H2，Electron 45.2.0）。

## 已知限制

- 云同步、账号、课程模板市场、Agent 辅助均未实现（文档中的付费/后置能力）
- 内嵌命令行未实现
- 系统级环境变量仅做只读展示，修改需要管理员权限，按文档要求不做
- `--no-sandbox` 兜底模式下无法写环境变量（Windows 完整性级别限制）
- `npm run package` 需要先安装 `electron-builder`（未随依赖安装）

## License

Business Source License 1.1（见 [LICENSE](LICENSE)）：客户端代码禁止用于提供竞争性托管/管理服务，
Change Date 2030-11-02 之后自动转为 Apache License 2.0。
