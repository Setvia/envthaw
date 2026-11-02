/**
 * Validation schemas for every value crossing the IPC boundary.
 * The main process never trusts renderer input; each handler parses its
 * arguments through one of these before touching the system.
 */
import { z } from 'zod'

/** Windows environment variable names: printable, no '=' and no NUL. */
export const envNameSchema = z
  .string()
  .min(1, '变量名不能为空')
  .max(255, '变量名过长')
  .regex(/^[^=\u0000\r\n]+$/, '变量名不能包含 = 或换行')

export const envValueSchema = z.string().max(32767, '变量值过长').refine((v) => !v.includes('\u0000'), '变量值包含非法字符')

export const snapshotIdSchema = z.string().min(1).max(64)
export const scriptIdSchema = z.string().min(1).max(64)
export const rollbackIdSchema = z.string().min(1).max(64)

export const envVarMapSchema = z.record(z.string(), z.string())

export const envSnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
  createdAt: z.number(),
  userVars: envVarMapSchema
})

export const scriptEntrySchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  type: z.enum(['batch', 'powershell']),
  content: z.string().max(200_000),
  createdAt: z.number(),
  lastRunAt: z.number().optional(),
  lastExitCode: z.number().optional()
})

export const scriptSaveSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  type: z.enum(['batch', 'powershell']),
  content: z.string().min(1, '脚本内容不能为空').max(200_000),
  createdAt: z.number().optional()
})

export const redirectConfigSchema = z.object({
  pythonVenvHome: z.string().max(500),
  pipCacheDir: z.string().max(500),
  nodePrefix: z.string().max(500),
  nodeCache: z.string().max(500),
  gitConfigPath: z.string().max(500),
  gitUserName: z.string().max(200),
  gitUserEmail: z.string().max(200)
})

export const appSettingsSchema = z.object({
  autoSnapshotBeforeRun: z.boolean(),
  autoSnapshotBeforeRestore: z.boolean(),
  // Empty until the project site exists; https, or loopback http for local testing.
  updateFeedUrl: z
    .string()
    .max(500)
    .refine(
      (value) =>
        value === '' ||
        /^https:\/\/[^\s]+$/i.test(value) ||
        /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^\s]*)?$/i.test(value),
      '更新源必须是 https 地址（本地测试可用 http://127.0.0.1）'
    )
})

export const exportBundleSchema = z.object({
  kind: z.literal('envthaw-config'),
  version: z.literal(1),
  exportedAt: z.number(),
  settings: appSettingsSchema.partial().optional(),
  redirect: redirectConfigSchema.optional(),
  snapshots: z.array(envSnapshotSchema).max(500).optional(),
  scripts: z.array(scriptEntrySchema).max(500).optional()
})
