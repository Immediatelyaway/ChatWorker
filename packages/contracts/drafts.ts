import { z } from 'zod';
import { CHAT_LIMITS } from './limits.js';
import { DRAFT_VERSION } from './versions.js';

export const draftKeySchema = z
  .string()
  .max(220)
  .refine(
    (key) => /^conversation:.{1,200}$/.test(key) || /^new:(chat|work):.{0,200}$/.test(key),
    '草稿位置不正确',
  );
export const draftContentSchema = z
  .object({
    text: z.string().max(CHAT_LIMITS.inputCharacters),
    attachments: z
      .array(
        z
          .object({
            name: z.string().min(1).max(CHAT_LIMITS.attachmentNameCharacters),
            content: z.string().max(CHAT_LIMITS.attachmentCharacters),
          })
          .strict(),
      )
      .max(CHAT_LIMITS.attachmentsPerMessage),
  })
  .strict();
export const draftSnapshotSchema = z.object({
  key: draftKeySchema,
  revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  updatedAt: z.string().datetime().nullable(),
  draft: draftContentSchema,
});
export const draftWriteSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 2),
    draft: draftContentSchema,
    preservePrevious: z.boolean().optional(),
  })
  .strict();
export const draftIdentitySchema = z.object({
  storeId: z.string().uuid(),
  version: z.literal(DRAFT_VERSION),
});
export const draftResultSchema = z.object({ ok: z.boolean(), current: draftSnapshotSchema });
export const draftRecoverySchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  draft: draftContentSchema,
  createdAt: z.string().datetime(),
});
export const draftCopySchema = draftSnapshotSchema.pick({ revision: true, draft: true }).strict();
export type DraftCopy = z.infer<typeof draftCopySchema>;
export type DraftRecovery = z.infer<typeof draftRecoverySchema>;
export type Draft = z.infer<typeof draftContentSchema>;
export type DraftSnapshot = z.infer<typeof draftSnapshotSchema>;
export type DraftWrite = z.infer<typeof draftWriteSchema>;
export type DraftResult = z.infer<typeof draftResultSchema>;
export interface DraftRepository {
  archiveDraft(key: string, input: DraftCopy): Promise<void>;
  listDraftRecoveries(key: string): Promise<DraftRecovery[]>;
  readDraft(key: string): Promise<DraftSnapshot>;
  writeDraft(key: string, input: DraftWrite): Promise<DraftResult>;
}
export const blankDraft = (): Draft => ({ text: '', attachments: [] });
export const copyDraft = (draft: Draft): Draft => ({
  text: draft.text,
  attachments: draft.attachments.map((a) => ({ ...a })),
});
export const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);
