import { z } from 'zod';
import { providerDefaults, type State } from '../../../packages/shared/types.js';

export const STATE_VERSION = 1;
const id = z.string().min(1).max(200);
const date = z.string().datetime();
const project = z.object({ id, name: z.string().min(1).max(60), description: z.string().max(500) });
const message = z.object({
  id,
  role: z.enum(['user', 'assistant']),
  content: z.string().max(200_000),
  attachments: z
    .array(z.object({ name: z.string().min(1).max(200), content: z.string().max(100_000) }))
    .max(5)
    .optional(),
  createdAt: date,
  status: z.enum(['streaming', 'completed', 'cancelled', 'failed']).optional(),
  model: z.string().max(300).optional(),
});
const conversation = z.object({
  id,
  title: z.string().min(1).max(100),
  projectId: id.nullable(),
  mode: z.enum(['chat', 'work']),
  messages: z.array(message),
  activities: z.array(z.object({ id, label: z.string().max(2000), at: date })),
  createdAt: date,
  updatedAt: date,
  archived: z.boolean(),
});
export const recordsSchema = z
  .object({ projects: z.array(project), conversations: z.array(conversation) })
  .superRefine((data, ctx) => {
    const projects = new Set(data.projects.map((p) => p.id));
    const conversations = new Set(data.conversations.map((c) => c.id));
    if (projects.size !== data.projects.length || conversations.size !== data.conversations.length)
      ctx.addIssue({ code: 'custom', message: '记录 ID 重复' });
    for (const c of data.conversations) {
      if (c.projectId !== null && !projects.has(c.projectId))
        ctx.addIssue({ code: 'custom', message: '会话引用了不存在的项目' });
      if (new Set(c.messages.map((m) => m.id)).size !== c.messages.length)
        ctx.addIssue({ code: 'custom', message: '消息 ID 重复' });
    }
  });
const stateSchema = z.object({
  schemaVersion: z.literal(STATE_VERSION),
  projects: z.array(project),
  conversations: z.array(conversation),
  providers: z.array(
    z.object({
      id,
      name: z.string().min(1).max(100),
      protocol: z.enum(['demo', 'responses', 'openai', 'anthropic']),
      baseUrl: z.string(),
      models: z.array(z.string().min(1).max(150)),
    }),
  ),
  preferences: z.object({
    theme: z.enum(['light', 'dark', 'system']),
    providerId: id,
    model: z.string().max(150),
    systemPrompt: z.string().max(8000),
  }),
});

export function decodeState(value: unknown): State {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('工作空间数据格式不正确');
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== STATE_VERSION)
    throw new Error('工作空间数据版本不受支持，请使用兼容版本的 ChatWorker');
  const result = stateSchema.parse({ ...raw, schemaVersion: STATE_VERSION });
  recordsSchema.parse(result);
  if (
    new Set(result.providers.map((p) => p.id)).size !== result.providers.length ||
    !result.providers.some((p) => p.id === result.preferences.providerId)
  )
    throw new Error('模型服务配置引用无效');
  return result;
}

export function initialState(): State {
  return {
    schemaVersion: STATE_VERSION,
    conversations: [],
    projects: [],
    providers: structuredClone(providerDefaults),
    preferences: {
      theme: 'light',
      providerId: 'demo',
      model: '本地演示',
      systemPrompt:
        '你是 ChatWorker，一位清晰、可靠的助手。优先使用用户的语言，明确区分事实、建议和未完成的操作。',
    },
  };
}
