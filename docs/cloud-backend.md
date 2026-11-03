# EnvThaw 云后端方案（M6）

> 版本：v1.0（设计稿）
> 对应路线图：**M6 · 云同步最小闭环（账号 + 快照同步），预估 3 周**
> 目标读者：服务端开发、客户端开发、后续接手运维的人
> 关联文档：《环境管理器（EnvMgr）开发文档（草案）》4.4 / 5.x / 7

---

## 0. 一页结论（TL;DR）

| 项 | 决策 |
| --- | --- |
| 形态 | **单体服务 + PostgreSQL + 对象存储 + Redis**，不做微服务 |
| 语言/框架 | TypeScript + Fastify（与客户端同栈，团队零学习成本） |
| 同步模型 | **本地优先 + 服务端游标增量同步**，客户端用 outbox 队列，断网可继续用 |
| 冲突 | 版本号乐观锁；服务端做**三路合并**（普通模式），冲突逐键让用户选（E2EE 模式全部客户端合并） |
| 账号 | 邮箱验证码（国内主路径）+ GitHub OAuth Device Flow（极客路径），预留微信 |
| 令牌 | 15 分钟 Access JWT（EdDSA）+ 旋转 Refresh Token（设备绑定 + 重放检测） |
| 加密 | 传输 TLS；静态加密走 KMS 信封加密；**E2EE 作为 M6.5 的可选能力**，密钥不落服务端 |
| 端 | 桌面客户端用 Electron `safeStorage` 存 refresh token（DPAPI） |
| 部署 | 国内单区域（阿里云/腾讯云），2×API 容器 + 1×worker + RDS PG + OSS + Redis，Terraform + GitHub Actions |
| 成本 | 1k MAU 量级约 **¥300~800/月** |
| 合规 | ICP 备案、隐私政策、数据导出/删除、数据不出境 |

M6 的验收标准只有三条：

1. 同一账号在 A 机保存快照，B 机登录后能看到并一键恢复；
2. 断网期间的所有改动，联网后自动补齐，不丢数据、不重复；
3. 两台机器同时改同一个快照，能给出可理解的差异并让用户选择，而不是静默覆盖。

---

## 1. 背景与范围

### 1.1 当前进度（M1–M5 已完成的部分）

客户端已经把"本地闭环"做完了，云端要接的是这些既有对象：

| 本地已有能力 | 代码位置 | 云端对应 |
| --- | --- | --- |
| 用户级环境变量读写 + diff | `src/main/services/env-service.ts`、`restore-engine.ts` | 快照内容来源 |
| 环境快照（`EnvSnapshot`） | `src/main/services/storage.ts` | **M6 同步的核心对象** |
| 多用户本地档案 `config/<user>/` | `src/main/services/paths.ts` | 一个本地档案 ↔ 一个云账号（映射见 §9） |
| 脚本库（文件 + 元数据） | `script-runner.ts` | M7 同步对象（本期只留接口） |
| 更新检查（HTTPS 清单） | `update-service.ts` | 后端顺带托管 `/v1/updates/latest` |
| IPC 契约 / zod 校验 | `src/shared/*` | 保持不变，新增 `cloud:*` 通道 |

现有 `EnvSnapshot` 结构（同步载荷的最小单元）：

```ts
interface EnvSnapshot {
  id: string                 // 客户端本地 id，作为 client_ref
  name: string
  note?: string
  createdAt: number
  userVars: Record<string, string>   // HKCU\Environment 的用户级变量
}
```

### 1.2 M6 范围

**做：**

- 账号注册/登录/登出、设备管理
- 快照的创建、更新、删除、跨设备同步
- 增量同步协议、离线队列、幂等与重试
- 冲突检测与合并（普通模式三路合并 / E2EE 模式客户端合并）
- 配额、限流、审计、备份
- 最小管理后台（查用户、封禁、看用量）

**不做（留给后续）：**

- 脚本库/配置包同步（M7，接口先占位）
- 课程模板市场、班级/教师端（v1.0 / v1.x）
- Agent 对话（M8，需要服务端代理 LLM）
- 订阅支付（v1.0 再上，M6 只做 `plan` 字段与配额钩子）

### 1.3 非目标

- 不做通用网盘、不做 Git 式历史浏览（只保留最近 N 个版本）
- 不做实时协同（不需要 WebSocket 推流，轮询足够）
- 不在服务端执行任何用户脚本（安全边界）

---

## 2. 设计原则

1. **本地优先（local-first）**：云端是同步层，不是依赖。断网、服务挂了，客户端全功能可用。
2. **永不静默覆盖**：任何冲突都产生可见的版本/差异，自动合并仅限"无重叠"的改动。
3. **可丢失范围最小化**：服务端版本只增不删（软删除 + 30 天回收站），客户端本地数据永远保留。
4. **默认不信任客户端**：所有入参 zod 校验、大小/数量配额、权限按 `user_id` 强制过滤（`WHERE user_id = $1` 写在仓储层，不靠调用方自觉）。
5. **一套栈**：TypeScript 全栈，团队一个人能维护；M6 不引入消息队列中间件（用 Postgres `SKIP LOCKED` 做任务队列）。
6. **可替换**：对象存储走 S3 兼容接口，换阿里云 OSS / 腾讯云 COS / MinIO 只改配置。

---

## 3. 总体架构

### 3.1 组件图

```
┌──────────────────────────────────────────────────────────────────┐
│                       EnvThaw 桌面客户端 (Electron)               │
│  renderer ──IPC──► main: cloud-service (outbox / cursor / merge)  │
│                         │  safeStorage(DPAPI) 存 refresh token    │
└─────────────────────────┼────────────────────────────────────────┘
                          │ HTTPS + JSON（TLS1.2+）
                 ┌────────▼─────────┐
                 │  CDN / WAF / LB  │  限流、防 CC、证书、静态加速
                 └────────┬─────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │        API 服务（Fastify, 无状态）   │  ×2 容器
        │  auth │ sync │ blobs │ me │ admin   │
        │  统一中间件：请求 ID / 日志 / 鉴权 / 限额│
        └───┬───────────┬───────────┬─────────┘
            │           │           │
     ┌──────▼───┐ ┌─────▼─────┐ ┌───▼──────────────┐
     │PostgreSQL│ │   Redis   │ │  对象存储 (S3 兼容)│
     │ 主数据   │ │限流/OTP/  │ │  快照密文 blob     │
     │ change_log│ │幂等/缓存  │ │  预签名直传        │
     └──────┬───┘ └───────────┘ └──────────────────┘
            │
     ┌──────▼──────────────────────────────┐
     │  Worker（同镜像，不同启动参数）       │
     │  邮件、清理、配额重算、回收站清理、   │
     │  指标汇总、更新清单发布               │
     └─────────────────────────────────────┘

  旁路：KMS（信封密钥）· 日志/Trace/Sentry · 备份（PITR）· 管理后台（内网）
```

### 3.2 组件职责

| 组件 | 职责 | 说明 |
| --- | --- | --- |
| CDN/WAF/LB | TLS 终止、静态资源、限流、防 CC | 国内用云厂商 CDN+WAF，海外可换 Cloudflare |
| API（Fastify） | 认证、同步、blob 签名、账号、管理接口 | 完全无状态，JWT 校验后按用户隔离 |
| Worker | 异步任务：发信、GC、配额、指标 | 与 API 同镜像，`ROLE=worker` 启动；用 `FOR UPDATE SKIP LOCKED` 抢占任务 |
| PostgreSQL | 用户、设备、令牌、快照元数据、版本、变更日志、任务表 | 唯一有状态的核心，PITR 备份 |
| Redis | 限流计数、邮箱验证码、幂等短缓存、会话黑名单 | 允许丢失（降级为"限流失效"而非服务不可用） |
| 对象存储 | 快照密文（普通模式为服务端加密，E2EE 模式为客户端密文） | 私有桶，预签名 URL 直传直取，服务端不中转大文件 |
| KMS | 普通模式的 DEK 信封加密；签发 JWT 的密钥托管 | 生产禁止把密钥写进环境变量 |
| 可观测 | OpenTelemetry → Tempo/Loki/Prometheus；Sentry | 每个请求带 `request_id`，客户端上报 `device_id` |

### 3.3 技术选型与备选

| 选择 | 理由 | 备选与否决原因 |
| --- | --- | --- |
| Fastify + zod | 与客户端共享校验思路；性能足够；插件生态成熟 | NestJS 太重；Go 招人成本高 |
| PostgreSQL | JSONB 存变量、`BIGSERIAL` 天然做变更序列、事务保证快照版本原子性 | MongoDB 无强事务，版本号容易写乱 |
| 对象存储 + 预签名 | 快照可能 100KB+，走 API 转发浪费带宽 | 直接把 blob 存 PG 会让备份/成本失控 |
| 自建而非 Firebase/Supabase | 国内访问、数据出境合规、成本可控 | Supabase 海外节点延迟高；Firebase 国内不可用 |
| 单体 + worker | M6 只有 5 个领域，拆微服务只会增加运维 | —— |

### 3.4 关键请求链路（上传一次快照）

```
client                      api                     storage           pg
  │ POST /v1/blobs (sha,size)│                        │                │
  │──────────────────────────►│ 建 pending blob 记录   │                │
  │◄── {blob_id, upload_url}──│ (OSS 预签名 PUT, 15min)│                │
  │ PUT upload_url (body)     │                        │                │
  │───────────────────────────┼───────────────────────►│                │
  │ POST /v1/blobs/{id}/commit│                        │                │
  │──────────────────────────►│ HEAD 校验大小/摘要 ────►│                │
  │                           │ 标记 ready ────────────┼───────────────►│
  │ POST /v1/sync/mutations   │                        │                │
  │ {snapshot, base_version}  │ 事务：版本+change_log  │                │
  │──────────────────────────►│────────────────────────┼───────────────►│
  │◄── {version: 4, seq: 812} │                        │                │
```

---

## 4. 数据模型

### 4.1 ER 概览

```
users 1─┬─* identities          （GitHub / email / 未来的微信）
        ├─* devices             （每台机器一条，可吊销）
        ├─* refresh_tokens      （挂在 device 下，旋转链）
        ├─* snapshots 1─* snapshot_versions ──► blobs
        ├─* change_log          （同步游标来源）
        └─1 e2ee_accounts       （可选，E2EE 开启时才有）
```

### 4.2 DDL（PostgreSQL 15）

```sql
create extension if not exists citext;
create extension if not exists pgcrypto;

-- 账号
create table users (
  id              uuid primary key default gen_random_uuid(),
  email           citext unique,
  display_name    text not null default '',
  status          text not null default 'active'
                  check (status in ('active','suspended','deleted')),
  plan            text not null default 'free',        -- free | plus | class
  plan_expires_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table identities (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  provider   text not null check (provider in ('github','email','wechat')),
  subject    text not null,          -- 第三方 uid / 邮箱小写
  email      citext,
  profile    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (provider, subject)
);
create index identities_user_idx on identities(user_id);

-- 设备
create table devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,                 -- "机房 A 的教学机"
  platform     text not null,                 -- win32 | darwin | linux
  app_version  text,
  public_key   text,                          -- 预留：设备密钥，做请求签名
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);
create index devices_user_idx on devices(user_id);

-- 刷新令牌（只存哈希）
create table refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  device_id   uuid not null references devices(id) on delete cascade,
  family_id   uuid not null,          -- 一条轮换链，重放时整链吊销
  token_hash  bytea not null,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  rotated_to  uuid,
  revoked_at  timestamptz
);
create index refresh_device_idx on refresh_tokens(device_id);

-- 快照（逻辑对象）
create table snapshots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  client_ref     text not null,               -- 客户端本地 id，保证幂等映射
  name           text not null,
  note           text,
  schema_version int  not null default 1,
  latest_version int  not null default 0,
  content_hash   text,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, client_ref)
);
create index snapshots_user_idx on snapshots(user_id) where deleted_at is null;

-- 快照版本（不可变）
create table snapshot_versions (
  snapshot_id       uuid not null references snapshots(id) on delete cascade,
  version           int  not null,
  parent_version    int,
  blob_id           uuid not null references blobs(id),
  size_bytes        int  not null,
  content_hash      text not null,           -- 未加密载荷的 sha256（E2EE 时为密文摘要）
  encryption        text not null default 'server'
                    check (encryption in ('server','e2ee-v1')),
  vars              jsonb,                   -- 普通模式：明文变量表，供服务端合并/展示
  created_by_device uuid references devices(id),
  created_at        timestamptz not null default now(),
  primary key (snapshot_id, version)
);

-- Blob（对象存储里的一个文件）
create table blobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  object_key   text not null,
  sha256       text not null,
  size_bytes   bigint not null,
  state        text not null default 'pending'
               check (state in ('pending','ready','deleted')),
  created_at   timestamptz not null default now(),
  committed_at timestamptz,
  unique (user_id, sha256)                  -- 同用户内容去重
);

-- 变更日志：客户端拉取的唯一来源
create table change_log (
  seq       bigserial primary key,
  user_id   uuid not null references users(id) on delete cascade,
  entity    text not null,                  -- snapshot | script(未来) | template(未来)
  entity_id uuid not null,
  op        text not null check (op in ('upsert','delete')),
  version   int,
  created_at timestamptz not null default now()
);
create index change_log_user_seq_idx on change_log(user_id, seq);

-- 每台设备的拉取游标（可选，客户端也自己存一份）
create table device_sync_state (
  device_id     uuid primary key references devices(id) on delete cascade,
  last_pull_seq bigint not null default 0,
  last_push_at  timestamptz
);

-- 幂等表：同一 client_mutation_id 只处理一次
create table mutations (
  user_id            uuid not null references users(id) on delete cascade,
  client_mutation_id text not null,
  request_hash       text not null,
  response           jsonb not null,
  created_at         timestamptz not null default now(),
  primary key (user_id, client_mutation_id)
);

-- 任务队列（worker 用，避免引入 MQ）
create table jobs (
  id          bigserial primary key,
  kind        text not null,               -- send_email | gc_blobs | purge_trash | rollup
  payload     jsonb not null default '{}',
  run_at      timestamptz not null default now(),
  attempts    int not null default 0,
  locked_by   text,
  locked_until timestamptz,
  finished_at timestamptz,
  last_error  text
);
create index jobs_ready_idx on jobs(run_at) where finished_at is null;

-- E2EE（可选）
create table e2ee_accounts (
  user_id             uuid primary key references users(id) on delete cascade,
  kdf                 text not null check (kdf in ('argon2id','recovery-code')),
  kdf_params          jsonb not null,
  kdf_salt            bytea not null,
  wrapped_mk          bytea not null,      -- MK 被 KEK 包裹，服务端解不开
  recovery_wrapped_mk bytea,
  created_at          timestamptz not null default now()
);
```

### 4.3 设计说明

- **`change_log` 是同步的心脏**：任何写操作在同一事务里插一条记录，客户端只按 `seq` 增量拉。`seq` 用全局序列（不是每用户序列），跨用户空洞无害，换来实现简单。
- **版本不可变**：`snapshot_versions` 只插不改；`snapshots.latest_version` 只是指针，回滚 = 把指针指回旧版本（生成新版本号，保留审计）。
- **`client_ref` 唯一约束**：客户端断网重放同一快照不会产生重复对象，配合 `mutations` 幂等表构成双保险。
- **`vars` 只在普通模式写**：E2EE 模式下服务端只有密文，`vars` 为 null，合并下放客户端。
- **软删除**：`snapshots.deleted_at` + `change_log(op='delete')`，30 天后由 `purge_trash` 物理删除并清理 blob。

---

## 5. 账号、设备与令牌

### 5.1 登录方式

| 方式 | 流程 | 说明 |
| --- | --- | --- |
| **邮箱验证码**（国内主路径） | `POST /v1/auth/email/start` → 6 位码（Redis，10 分钟，5 次尝试）→ `POST /v1/auth/email/verify` → 首次登录自动建号 | 不依赖第三方，机房网络也能用；发信走阿里云邮件推送 |
| **GitHub OAuth Device Flow** | `POST /v1/auth/github/device/start` → 返回 `user_code` + `verification_uri` → 客户端打开浏览器 → 轮询 `poll` | 桌面端不需要 loopback 端口，规避防火墙；海外/极客用户 |
| 微信 | 预留 `identities.provider='wechat'` | v1.x，需要企业主体 |

### 5.2 令牌

```
Access JWT (15min)   : { sub, did, plan, jti, iat, exp }  EdDSA，公钥由 /v1/.well-known/jwks.json 暴露
Refresh token (30d)  : 32 字节随机，base64url；服务端只存 sha256；按 device 绑定
```

- **轮换**：每次刷新签发新 refresh token 并把旧的标记 `rotated_to`；若旧 token 被再次使用 → 判定泄露，**吊销整个 family + 该设备所有会话**，返回 401 并让用户重新登录。
- **存储**：客户端用 Electron `safeStorage.encryptString()`（Windows 走 DPAPI）写入 `config/<user>/cloud/token.bin`，明文不落盘、不进日志。
- **吊销**：`DELETE /v1/devices/{id}` 立即失效该设备所有 refresh token；access token 最多再存活 15 分钟（可接受）。
- **JWT 校验**：API 只验签+过期，不查库；`did`（device_id）用于审计与同步游标。

### 5.3 设备

- 首次登录自动注册设备，名称默认取 `os.hostname()`，可改名（"机房 A 的教学机"便于用户在多设备列表里辨认）。
- 设备列表返回：名称、平台、应用版本、最后活跃时间、当前设备标记。
- 设备上限：免费 5 台，超出需在旧设备上登出（MVP 直接拒绝并提示）。

---

## 6. 同步协议（核心）

### 6.1 模型

- 每个快照是一条"对象"，服务端维护 `latest_version`。
- 客户端本地记录每个快照 `last_synced_version` 和内容 hash。
- 服务端把所有变更写进 `change_log`，客户端按 `seq` 拉增量。
- 上传走 mutation 批次，携带 `base_version` 做乐观锁。

### 6.2 推送（客户端 → 服务端）

```http
POST /v1/sync/mutations
Authorization: Bearer <access>
Idempotency-Key: <batch uuid>

{
  "device_id": "d_01H...",
  "mutations": [
    {
      "client_mutation_id": "m_01H...",
      "entity": "snapshot",
      "client_ref": "snap-mvyp3oi2-66y8et",
      "op": "upsert",
      "base_version": 3,
      "name": "Python 数据分析课",
      "note": "机房 A",
      "blob_id": "b_01H...",
      "content_hash": "sha256:9f2c...",
      "schema_version": 1
    }
  ]
}
```

响应（逐条结果，允许部分成功）：

```json
{
  "results": [
    { "client_mutation_id": "m_01H...", "status": "applied", "version": 4, "seq": 812 }
  ],
  "server_seq": 812
}
```

状态码语义：

| status | 含义 | 客户端动作 |
| --- | --- | --- |
| `applied` | 成功 | 更新本地 `last_synced_version` |
| `conflict` | `base_version` 与服务器不一致 | 拉取服务器版本，三路合并后重试 |
| `duplicate` | `client_mutation_id` 已处理 | 当作成功，使用返回的 version |
| `rejected` | 校验失败（配额/大小/格式） | 标记该项失败并提示，不重试 |

**服务端处理单条 mutation 的事务：**

```sql
begin;
-- 1) 幂等
select response from mutations
 where user_id=$1 and client_mutation_id=$2 for update;   -- 命中直接返回
-- 2) 找快照（client_ref 唯一）
select id, latest_version from snapshots
 where user_id=$1 and client_ref=$3 for update;
-- 3a) 不存在 → insert，version = 1
-- 3b) 存在 → 若 base_version <> latest_version → 返回 conflict
--      否则 version = latest_version + 1，insert snapshot_versions，更新指针
-- 4) 记 change_log(entity='snapshot', op='upsert', version)
-- 5) 写 mutations(response) 作为幂等结果
commit;
```

### 6.3 拉取（服务端 → 客户端）

```http
GET /v1/sync?cursor=812&limit=200
```

```json
{
  "changes": [
    {
      "seq": 815,
      "entity": "snapshot",
      "op": "upsert",
      "snapshot": {
        "id": "s_01H...",
        "client_ref": "snap-mvyp3oi2-66y8et",
        "name": "Python 数据分析课",
        "latest_version": 4,
        "content_hash": "sha256:9f2c...",
        "encryption": "server",
        "size_bytes": 1287,
        "updated_at": 1793589944522,
        "deleted": false
      }
    }
  ],
  "next_cursor": 815,
  "has_more": false
}
```

- 客户端按 `client_ref` 找到本地快照：
  - 本地没有 → 新建（"来自云端"）；
  - 本地有且 `last_synced_version < latest_version` → 需要拉 blob 比对内容（hash 相同则直接更新版本号，不下载）。
- blob 下载：`GET /v1/blobs/{id}/download` 返回 302 预签名 URL（或直接返回 JSON 里的 URL），客户端流式下载 → 校验 sha256 → 应用。
- 删除：`op=delete` 只标记本地快照为"云端已删除"，**不物理删除本地**（用户可能还要用），UI 上灰显并提示。

### 6.4 冲突与合并

**判定**：`base_version != server.latest_version` 即为冲突。

**普通模式（服务端有 `vars`）** —— 服务端直接返回三路合并结果：

```json
{
  "status": "conflict",
  "conflict": {
    "base_version": 3,
    "server_version": 5,
    "mergeable": true,
    "merged_vars": { "JAVA_HOME": "D:\\jdk\\17", "PATH": "..." },
    "conflicts": [
      { "key": "PYTHON_HOME", "base": "C:\\py311", "local": "D:\\py312", "remote": "D:\\py311" }
    ]
  }
}
```

三路合并规则（对 `userVars` 这个 map）：

```
对每个 key：
  local == remote      → 取值
  local == base        → 取 remote（远端是新改动）
  remote == base       → 取 local（本地是新改动）
  base 不存在 & local&remote 都存在 → 冲突
  其他                 → 冲突
```

- `mergeable=true` 且 `conflicts=[]` → 客户端自动以 `server_version` 为 `base_version` 重试 mutation，提示"已自动合并"。
- 有冲突 → 客户端弹差异面板，逐键选择"用本地/用云端"，合并结果作为新版本提交（`base_version = server_version`）。

**E2EE 模式** —— 服务端看不到明文，只返回 `conflict` + 服务器版本号；客户端下载两份 blob、解密、本地三路合并，再上传新版本。合并逻辑复用同一份代码（客户端是唯一实现，服务端只在普通模式下用镜像实现保证 API 行为一致）。

**冲突产生的版本历史**：每次合并都追加一个新版本（不覆盖），所以 30 天内都能回滚。

### 6.5 离线与重试

客户端 outbox（`config/<user>/cloud/outbox.jsonl`）：

```
{"id":"m_01H...","at":1793589944522,"kind":"snapshot.upsert","payload":{...},"attempts":0}
```

- 本地写操作立即成功（本地优先），同时入队；
- 同步循环：指数退避（1s → 2s → 4s … 上限 5min）+ ±20% 抖动，最多重试 10 次后标记 `failed` 并在 UI 上提示；
- 应用启动、网络恢复（`online` 事件）、用户点"立即同步"都会触发冲刷；
- 队列按 `client_mutation_id` 去重，重放安全。

### 6.6 游标与一致性

- `cursor` 是全局 `change_log.seq`，客户端持久化在 `config/<user>/cloud/cursor.json`。
- 拉取是"至少一次"：客户端处理变更必须幂等（按 `client_ref + version` 去重）。
- 同一用户并发 push 用行级锁（`select ... for update`）串行化，避免版本号竞争。
- 分页：单次最多 200 条，`has_more` 为 true 时继续拉。

### 6.7 配额（M6）

| 项 | 免费 | 说明 |
| --- | --- | --- |
| 快照数量 | 50 | 超出返回 `rejected: quota_snapshots` |
| 单快照大小 | 256 KB | 环境变量远小于此 |
| 存储总量 | 20 MB | 含历史版本 |
| 版本保留 | 每快照最近 20 个 + 30 天 | 老的 GC |
| 设备数 | 5 | |
| 请求频率 | 60 req/min/用户；sync 10 req/min | Redis 令牌桶 |

---

## 7. 端到端加密（M6.5，可选开关）

### 7.1 密钥层级

```
用户口令 / 恢复码
      │ Argon2id(salt, m=64MB, t=3, p=1)
      ▼
     KEK ──AES-KW──► wrapped_mk（存服务端）
                     │
                     ▼
                    MK（32B，客户端内存）
                     │ AES-KW
                     ▼
        每条快照的 DK（32B 随机） ──AES-256-GCM──► 密文 blob
```

- `MK` 只在客户端出现；服务端仅存 `kdf_salt`、`kdf_params`、`wrapped_mk`（以及恢复码包裹的另一份）。
- 开启 E2EE 时生成 12 个词的恢复码（BIP39 词表），强制用户抄写；丢失恢复码 = 数据不可恢复（UI 必须明确警告）。
- 新设备加入：输入口令/恢复码解锁 MK，或由已登录设备扫码/输码传递 MK（`POST /v1/e2ee/enroll` 只传递客户端加密后的包裹）。

### 7.2 服务端可见性

| 数据 | 服务端可见 |
| --- | --- |
| 快照名称/备注 | 默认可见（便于列表）；可勾选"加密名称"（M7） |
| 变量内容 | 不可见（只有密文 blob） |
| 大小、版本、时间 | 可见 |
| 冲突 | 只能判定版本冲突，合并由客户端完成 |

### 7.3 取舍

- 代价：服务端无法做搜索/合并/去重（按密文 hash 去重仍可）、忘记密码不可找回。
- 收益：环境变量里可能有 `OPENAI_API_KEY`、数据库口令，E2EE 是这类产品的信任基础。
- 策略：普通模式默认可用（服务端 KMS 信封加密），E2EE 作为"隐私模式"开关，文案讲清楚两者区别。

---

## 8. API 契约（v1）

统一约定：

- Base：`https://api.envthaw.com/v1`
- 认证：`Authorization: Bearer <access_token>`
- 内容：`application/json; charset=utf-8`
- 错误体：`{ "error": { "code": "quota_exceeded", "message": "快照数量已达上限", "request_id": "..." } }`
- 时间：Unix 毫秒（与客户端一致）
- 版本：路径带 `v1`，破坏性变更走 `v2`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/email/start` | 发送验证码 |
| POST | `/auth/email/verify` | 校验验证码，返回令牌 |
| POST | `/auth/github/device/start` | 开始设备码流程 |
| POST | `/auth/github/device/poll` | 轮询授权结果 |
| POST | `/auth/refresh` | 刷新令牌（轮换） |
| POST | `/auth/logout` | 吊销当前设备会话 |
| GET | `/me` | 当前用户信息 + 配额用量 |
| PATCH | `/me` | 改昵称/邮箱 |
| DELETE | `/me` | 注销（软删 + 30 天冷静期） |
| GET | `/devices` | 设备列表 |
| PATCH | `/devices/{id}` | 重命名 |
| DELETE | `/devices/{id}` | 吊销设备 |
| GET | `/sync` | 增量拉取 |
| POST | `/sync/mutations` | 批量推送 |
| POST | `/blobs` | 初始化上传，返回预签名 URL |
| POST | `/blobs/{id}/commit` | 确认上传（校验大小/摘要） |
| GET | `/blobs/{id}/download` | 获取下载 URL |
| DELETE | `/snapshots/{id}` | 删除快照（软删，记 change_log） |
| GET | `/snapshots/{id}/versions` | 版本列表（普通模式） |
| POST | `/snapshots/{id}/restore` | 回滚到指定版本（普通模式） |
| GET | `/updates/latest` | 客户端更新清单（替代手写 JSON） |
| GET | `/healthz` `/readyz` | 探针 |
| GET | `/metrics` | Prometheus（内网） |
| GET | `/.well-known/jwks.json` | JWT 公钥 |

### 8.1 示例：邮箱登录

```http
POST /v1/auth/email/start
{ "email": "student@example.edu" }
→ 202 { "expires_in": 600 }

POST /v1/auth/email/verify
{ "email": "student@example.edu", "code": "482913", "device": {
    "name": "机房 A 的教学机", "platform": "win32", "app_version": "0.1.0" } }
→ 200 {
  "access_token": "eyJ...",
  "expires_in": 900,
  "refresh_token": "rt_9f2c...",
  "user": { "id": "u_01H...", "email": "student@example.edu", "plan": "free" },
  "device": { "id": "d_01H..." }
}
```

### 8.2 示例：更新清单

```http
GET /v1/updates/latest?channel=stable&platform=win32&arch=x64
→ 200 {
  "version": "0.1.1",
  "url": "https://dl.envthaw.com/EnvThaw-0.1.1-portable.zip",
  "sha256": "…64 hex…",
  "size": 154902747,
  "notes": "修复便携版配置路径…",
  "publishedAt": 1793590000000,
  "minimumVersion": "0.1.0"
}
```

> 客户端 `update-service.ts` 目前读用户手填的 HTTPS 清单地址，M6 后默认指向这里即可，无需改协议。

---

## 9. 客户端接入方案（现有代码如何改）

### 9.1 新增模块

```
src/main/services/cloud/
├── cloud-service.ts     # 对外：login/logout/status/syncNow/resolveConflict
├── client.ts            # fetch 封装：重试、超时、401 自动刷新
├── outbox.ts            # outbox.jsonl 读写 + 重放
├── merge.ts             # 三路合并（与 §6.4 同算法）
├── token-store.ts       # safeStorage 加密读写 token.bin
└── types.ts             # 与服务端共享的 DTO（可用 openapi 生成）
```

### 9.2 本地文件布局（每个本地档案独立）

```
config/<user>/cloud/
├── account.json     # { userId, email, deviceId, plan }
├── token.bin        # safeStorage(DPAPI) 加密的 refresh token
├── cursor.json      # { seq: 812 }
└── outbox.jsonl     # 待上传变更
```

匿名用户（`default`）也可以登录云端 —— 登录后把当前档案里的快照打上 `client_ref` 同步上去；不登录则完全本地。

### 9.3 IPC / preload 契约（新增）

```ts
interface CloudApi {
  status(): Promise<{ signedIn: boolean; email?: string; pending: number; lastSyncAt?: number }>
  loginWithEmail(email: string): Promise<void>          // 发码
  verifyEmail(email: string, code: string): Promise<void>
  loginWithGithub(): Promise<void>                       // 返回 user_code + 打开浏览器
  logout(): Promise<void>
  syncNow(): Promise<SyncReport>
  conflicts(): Promise<ConflictView[]>
  resolveConflict(id: string, choices: Record<string, 'local' | 'remote'>): Promise<void>
}
```

### 9.4 UI 落点

- 侧边栏底部用户区：未登录显示"登录以同步"；已登录显示待同步数量与最近同步时间。
- 新增「云同步」页面：设备列表、立即同步、冲突列表、配额用量、E2EE 开关（M6.5）。
- 快照页：每条快照加同步状态点（已同步/待上传/有冲突/仅本地）。

### 9.5 触发时机

| 时机 | 行为 |
| --- | --- |
| 应用启动 | 若已登录 → 拉增量 |
| 本地快照变更 | 防抖 2s 入队并推送 |
| 每 5 分钟 | 轻量拉取（`GET /v1/sync?limit=1` 只看 `next_cursor`） |
| 网络恢复 | 冲刷 outbox |
| 用户手动 | "立即同步" |

---

## 10. 部署与运维

### 10.1 环境

| 环境 | 用途 | 数据 |
| --- | --- | --- |
| `dev` | 本地 docker compose（PG + MinIO + Redis） | 假数据 |
| `staging` | 每次 main 合并自动部署 | 可清空 |
| `prod` | 北京/杭州单区域 | 真实数据，PITR |

### 10.2 拓扑（M6 预算内）

```
云厂商（阿里云示例）
├── SLB（HTTPS 443）→ WAF → API 容器 ×2（2c2g，最小规格）
├── RDS PostgreSQL 15（2c4g 高可用版，100GB）
├── Redis 4G 标准版（限流 + OTP）
├── OSS 私有桶（标准存储，生命周期：pending 24h 清理）
├── KMS（信封密钥 + JWT 私钥托管，或用 Secrets Manager）
├── 日志服务 SLS + ARMS（Trace）+ Sentry（前端/主进程异常）
└── 备份：RDS 自动备份 7 天 + 每日逻辑备份到 OSS（异地桶）
```

容器镜像只一个，用 `ROLE=api|worker` 区分；M6 不引入 k8s，`docker compose` + 云主机即可，扩容时再迁移。

### 10.3 CI/CD

```
push → GitHub Actions
  ├─ lint + typecheck + unit（含 merge 算法单测）
  ├─ 集成测试（testcontainers: PG + MinIO）
  ├─ 构建镜像 → 推送 ACR
  ├─ 迁移（prisma/drizzle migrate deploy，expand-contract）
  ├─ 部署 staging → 冒烟（登录→push→pull 脚本）
  └─ 手动批准 → 滚动更新 prod（先停 worker，再换 API，最后起 worker）
```

### 10.4 可观测与 SLO

| 指标 | 目标 |
| --- | --- |
| API 可用性 | 99.5%（月度） |
| `POST /sync/mutations` p95 | < 300ms |
| `GET /sync` p95 | < 150ms |
| 同步成功率（服务端 2xx/全部） | > 99.9% |
| 数据丢失 | 0 容忍；RPO ≤ 5min，RTO ≤ 1h |

关键埋点：`sync.pull.count`、`sync.push.conflict`、`sync.push.duplicate`、`blob.upload.bytes`、`auth.refresh.reuse`（安全告警）、`quota.reject`。

日志字段统一：`request_id`、`user_id`、`device_id`、`route`、`status`、`latency_ms`。**日志中禁止出现 token、邮箱验证码、变量明文。**

### 10.5 成本估算（M6，1k MAU）

| 项 | 规格 | 月成本（约） |
| --- | --- | --- |
| 应用服务器 | 2×2c2g | ¥120 |
| RDS PG 高可用 | 2c4g + 100GB | ¥250 |
| Redis | 4G 标准版 | ¥80 |
| OSS + 流量 | 5GB 存储 + 20GB 出网 | ¥30 |
| CDN/WAF | 基础版 | ¥50 |
| 日志/监控 | SLS + Sentry 免费额度 | ¥0~50 |
| 域名 + 证书 + 备案 | —— | ¥10 |
| **合计** | | **¥540~590/月** |

---

## 11. 安全与合规

### 11.1 威胁模型（M6 关注项）

| 威胁 | 缓解 |
| --- | --- |
| 撞库/暴力破解 | 邮箱验证码 5 次限制 + IP/邮箱双维度限流；refresh token 重放检测 |
| 令牌泄露 | 短 Access + 设备绑定 Refresh + 旋转 + 一键吊销设备 |
| 越权访问 | 所有查询强制 `user_id = $auth.sub`；路由层用 `preHandler` 注入，禁止裸 SQL 传 user_id |
| 对象存储遍历 | 私有桶，禁止 list；下载只走预签名且 15 分钟过期 |
| 恶意大包 | body 限制 1MB；blob 上传声明大小 + commit 时 HEAD 校验；单用户配额 |
| 依赖投毒 | lockfile 锁定 + `npm audit` + 镜像扫描 + SBOM |
| 供应链（客户端） | 发布包签名 + SHA256SUMS（已有），后续加代码签名证书 |
| 审计缺失 | 管理操作与服务端关键事件写 `audit_events`（保留 180 天） |

### 11.2 合规要点（国内）

- **ICP 备案**：域名 + 服务器在境内必须先备案；`api.envthaw.com` 与下载域名都要。
- **隐私政策**：明示收集范围（邮箱、设备名、快照密文/明文）、用途、保留期限、删除方式。
- **数据最小化**：默认只收邮箱；不采集机器指纹、不采集环境变量明文（E2EE 模式）。
- **数据导出/删除**：`GET /me/export`（打包 JSON）与 `DELETE /me`（30 天后物理删除）。
- **未成年人**：目标用户是学生，隐私政策需包含监护人条款（v1.0 前补齐）。
- **数据出境**：M6 全部数据留在境内；若未来用海外 CDN，只允许静态资源，不涉及用户数据。

---

## 12. 配额与计费接口（为 v1.0 预留）

M6 只实现"读 `users.plan` 决定配额"，不接支付：

```ts
const QUOTAS = {
  free:  { snapshots: 50,  bytes: 20 * MB, devices: 5 },
  plus:  { snapshots: 500, bytes: 2 * GB,  devices: 10 },
  class: { snapshots: 2000, bytes: 20 * GB, devices: 50 },
}
```

- `GET /me` 返回 `usage: { snapshots, bytes, devices }` 与 `limit`，客户端展示进度条。
- 支付接入（v1.0）：微信/支付宝 → 回调 → 更新 `plan` 与 `plan_expires_at`，服务端定时任务过期降级（数据不删，只停写）。
- 订阅状态放独立表 `subscriptions`，M6 不建，先预留字段。

---

## 13. 测试策略

| 层级 | 内容 |
| --- | --- |
| 单元 | 三路合并（10+ 用例：新增/删除/同时修改/一方回退）、配额计算、令牌轮换状态机 |
| 集成 | testcontainers 起 PG + MinIO，跑完整 push→pull→conflict→resolve 流程 |
| 契约 | OpenAPI 生成客户端类型，CI 校验兼容性（破坏性变更必须 v2） |
| 端到端 | 两个客户端实例（不同 `config/<user>`）+ 本地服务端，模拟"A 机保存 → B 机恢复" |
| 故障注入 | 上传中断、commit 超时、并发 push 同一快照、Redis 挂掉（限流降级） |
| 负载 | k6：100 并发用户 × 5 分钟混合读写，验证 p95 与错误率 |
| 安全 | 越权用例（A 用户 token 访问 B 用户 snapshot）、超大 body、伪造签名 |

---

## 14. 排期（对齐 M6 的 3 周）

| 周 | 后端 | 客户端 | 交付 |
| --- | --- | --- | --- |
| W1 | 仓库/CI/DB 迁移框架；auth（邮箱+GitHub）；设备与令牌；`/sync` 拉取 | 登录 UI、token 存储、启动拉取 | 能登录、能看到云端快照列表 |
| W2 | `/blobs` 预签名 + commit；`/sync/mutations`；冲突检测与三路合并；配额限流 | outbox、推送、冲突面板、同步状态 | A→B 恢复跑通；冲突可解决 |
| W3 | staging、监控告警、备份演练、管理后台最小版、压测与修缺 | 设备管理页、手动同步、错误提示打磨 | 内测（5~10 人） |
| M6.5 | E2EE（密钥派生、包裹、enroll）+ 审计 | 隐私模式开关、恢复码流程 | 隐私模式可选 |

**里程碑验收**：用两台机器 + 一个断网场景演示一遍，录制 3 分钟视频存档。

---

## 15. 风险与备选

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 国内访问 GitHub OAuth 不稳定 | 极客用户登录失败 | 邮箱登录作为默认路径；GitHub 失败给明确提示 |
| E2EE 让"忘记密码=数据丢失" | 用户投诉 | 恢复码 + 二次确认 + 默认关闭 E2EE；文档写清楚 |
| 冲突体验差 | 用户不敢用 | 自动合并优先；只有同 key 冲突才打扰用户；提供"保留两份"选项 |
| 服务端被滥用刷存储 | 成本 | 配额 + 限流 + 异常检测（单用户日增 > 50MB 告警） |
| 备案/合规延误 | 无法上线 | W1 就提交备案，staging 用境外测试域名先跑 |
| 单区域故障 | 短时不可用 | 客户端本地优先，故障时只影响同步；RDS 高可用 + PITR |

**备选方案（不采用但记录）：**

- **Supabase/Firebase**：3 天能出原型，但国内延迟、数据出境、成本随量上涨，长期不可控。
- **Cloudflare Workers + D1/R2**：便宜且边缘快，但国内访问质量不稳定，Postgres 能力弱于 D1。
- **纯文件同步（WebDAV/S3 直连）**：实现最省，但无账号、无冲突解决、无配额，无法支撑后续订阅与模板市场。

---

## 16. 附录

### 16.1 错误码

| code | HTTP | 说明 |
| --- | --- | --- |
| `unauthorized` | 401 | 令牌无效/过期 |
| `device_revoked` | 401 | 设备被吊销 |
| `forbidden` | 403 | 越权访问 |
| `not_found` | 404 | 对象不存在 |
| `conflict` | 409 | 版本冲突，见 §6.4 |
| `quota_exceeded` | 422 | 超出配额，带 `quota` 字段 |
| `payload_too_large` | 413 | 超过 256KB |
| `rate_limited` | 429 | 带 `retry_after` |
| `internal` | 500 | 记录 request_id，提示稍后重试 |

### 16.2 待定问题（需要在 W1 前拍板）

1. 域名与备案主体：个人还是公司？（影响支付与微信登录）
2. 邮箱发信服务：阿里云邮件推送 vs 自建 SMTP（前者需要域名 SPF/DKIM 配置）
3. E2EE 是否在 M6 就作为卖点？（建议 M6.5，先跑通普通模式）
4. 免费额度是否 50 个快照够用？（按学生一个学期 5~8 门课估算，够）
5. 客户端 `plan` 展示是否需要"到期时间"（v1.0 再补）

### 16.3 与客户端现有代码的对应关系

| 服务端概念 | 客户端现状 | 改动 |
| --- | --- | --- |
| `snapshots.client_ref` | `EnvSnapshot.id` | 直接复用，无需迁移 |
| `snapshot_versions.vars` | `EnvSnapshot.userVars` | 上传时展开为 map |
| 设备 | 无 | 新增 `cloud/account.json` |
| 更新清单 | `settings.updateFeedUrl` | 默认填服务端地址 |
| 本地档案 | `config/<user>/` | 一个档案对应一个云端账号 |

---

*文档状态：设计稿。W1 开始后按实际实现更新本文件，重大变更记入文末变更记录。*
