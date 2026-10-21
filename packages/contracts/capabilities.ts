import { z } from 'zod';
import { CAPABILITIES_VERSION } from './versions.js';

const feature = z.object({
  status: z.enum(['available', 'limited', 'unavailable']),
  detail: z.string().min(1).max(500),
});
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Public metadata only: no credentials, endpoints, paths or conversation content. */
export const capabilitiesSchema = z.object({
  contractVersion: z.literal(CAPABILITIES_VERSION),
  appVersion: z.string().min(1).max(100),
  environment: z.enum(['web', 'desktop']),
  scope: z.literal('local'),
  protocols: z
    .array(z.enum(['demo', 'responses', 'openai', 'anthropic']))
    .min(1)
    .max(4),
  storage: z.object({
    history: z.literal('json-file'),
    drafts: z.literal('browser-local'),
    keyPersistence: z.enum(['memory', 'persistent']),
    stateVersion: positiveInteger,
    backupVersion: positiveInteger,
    draftVersion: positiveInteger,
  }),
  execution: z.object({
    engine: z.literal('text-chat'),
    onDisconnect: z.literal('cancel'),
    onRestart: z.literal('mark-interrupted-failed'),
  }),
  features: z.object({
    chat: feature,
    attachments: feature,
    projects: feature,
    branches: feature,
    backups: feature,
    drafts: feature,
    workspaceFiles: feature,
    terminal: feature,
    runRecovery: feature,
    mcp: feature,
    multiAgent: feature,
  }),
  limits: z.object({
    inputCharacters: positiveInteger,
    attachmentsPerMessage: positiveInteger,
    attachmentNameCharacters: positiveInteger,
    attachmentFileBytes: positiveInteger,
    attachmentCharacters: positiveInteger,
    contextCharacters: positiveInteger,
    responseCharacters: positiveInteger,
    generationMilliseconds: positiveInteger,
    backupBytes: positiveInteger,
  }),
});

export type RuntimeCapabilities = z.infer<typeof capabilitiesSchema>;
export type FeatureId = keyof RuntimeCapabilities['features'];

export function decodeCapabilities(value: unknown): RuntimeCapabilities {
  if (
    value &&
    typeof value === 'object' &&
    'contractVersion' in value &&
    value.contractVersion !== CAPABILITIES_VERSION
  )
    throw new Error('服务与当前界面的能力协议版本不兼容，请更新后重试。');
  const parsed = capabilitiesSchema.safeParse(value);
  if (!parsed.success) throw new Error('服务返回的运行信息不完整或格式不正确，请更新服务后重试。');
  return parsed.data;
}
