import { randomUUID } from 'node:crypto';
import type { Conversation } from '../../../packages/shared/types.js';

export class BranchError extends Error {}

/** Copy only the selected prefix; every message gets its own identity. */
export function branchConversation(
  source: Conversation,
  messageId: string,
  intent: 'continue' | 'retry',
): Conversation {
  const index = source.messages.findIndex((m) => m.id === messageId);
  if (index < 0) throw new BranchError('消息不存在，请刷新会话后重试');
  const selected = source.messages[index];
  if (selected.role !== 'assistant') throw new BranchError('请从助手回复创建分支');
  if (source.messages.some((m) => m.status === 'streaming')) throw new BranchError('请先停止生成');
  let end = index + 1;
  if (intent === 'retry') {
    if (index === 0 || source.messages[index - 1].role !== 'user')
      throw new BranchError('此回复没有对应的用户消息');
    end = index;
  }
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    title: `${source.title.slice(0, 90)} · ${intent === 'retry' ? '重试' : '分支'}`,
    projectId: source.projectId,
    mode: source.mode,
    archived: false,
    createdAt: at,
    updatedAt: at,
    messages: structuredClone(source.messages.slice(0, end)).map((m) => ({
      ...m,
      id: randomUUID(),
    })),
    activities: [
      {
        id: randomUUID(),
        at,
        label: `从「${source.title}」第 ${index + 1} 条消息创建${intent === 'retry' ? '重新生成' : '对话'}分支；原会话保留`,
      },
    ],
  };
}
