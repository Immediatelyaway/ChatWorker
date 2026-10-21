import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { State } from '../../../packages/shared/types.js';
import { recordsSchema } from './state-schema.js';
import { BACKUP_VERSION } from '../../../packages/contracts/versions.js';
import { CHAT_LIMITS } from '../../../packages/contracts/limits.js';

export const BACKUP_LIMIT = CHAT_LIMITS.backupBytes;
const backupSchema = z
  .object({
    format: z.literal('chatworker-backup'),
    version: z.literal(BACKUP_VERSION),
    exportedAt: z.string().datetime(),
    data: recordsSchema,
  })
  .strict();

export function readBackup(input: unknown) {
  return backupSchema.parse(input);
}
export function exportBackup(state: State) {
  // Explicit allowlist: credentials, endpoints and preferences never enter backups.
  return readBackup({
    format: 'chatworker-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: recordsSchema.parse(state),
  });
}
export function importBackup(state: State, input: unknown): State {
  const backup = readBackup(input);
  const ids = new Map(backup.data.projects.map((p) => [p.id, randomUUID()]));
  const projects = backup.data.projects.map((p) => ({ ...p, id: ids.get(p.id)! }));
  const conversations = backup.data.conversations.map((c) => ({
    ...c,
    id: randomUUID(),
    projectId: c.projectId === null ? null : ids.get(c.projectId)!,
    messages: c.messages.map((m) => ({
      ...m,
      id: randomUUID(),
      status: m.status === 'streaming' ? ('failed' as const) : m.status,
    })),
    activities: [
      ...c.activities.map((a) => ({ ...a, id: randomUUID() })),
      { id: randomUUID(), at: new Date().toISOString(), label: '从备份导入为独立副本' },
    ],
  }));
  return {
    ...state,
    projects: [...state.projects, ...projects],
    conversations: [...conversations, ...state.conversations],
  };
}
