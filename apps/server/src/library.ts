import express, { Router } from 'express';
import { z } from 'zod';
import type { Storage } from './storage.js';
import {
  LIBRARY_LIMITS,
  documentPatchSchema,
  type LibraryDocument,
  type LibrarySummary,
  type Citation,
} from '../../../packages/contracts/library.js';
import { extractDocument } from '../../../packages/knowledge/extract.js';
export function libraryRoutes(store: Storage) {
  const router = Router();
  let extracting = 0;
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', async (_req, res) =>
    res.json(await store.library<LibrarySummary[]>({ action: 'list' })),
  );
  router.post(
    '/upload',
    express.raw({ type: 'application/octet-stream', limit: LIBRARY_LIMITS.fileBytes }),
    async (req, res) => {
      let title: string;
      try {
        title = z
          .string()
          .trim()
          .min(1)
          .max(200)
          .parse(decodeURIComponent(String(req.headers['x-file-name'] ?? '')))
          .replace(/[\\/\r\n\0]/g, '_');
      } catch {
        return res.status(400).json({ error: '文件名无效' });
      }
      if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: '请上传文件内容' });
      if (extracting >= 2) return res.status(429).json({ error: '正在整理其他资料，请稍后重试' });
      extracting++;
      try {
        const extracted = await extractDocument(title, req.body);
        res.json(
          await store.library<LibraryDocument>({
            action: 'create',
            title,
            ...extracted,
            original: req.body,
          }),
        );
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : '资料未能保存' });
      } finally {
        extracting--;
      }
    },
  );
  router.post('/collect', async (req, res) => {
    const input = z
      .object({
        conversationId: z.string(),
        messageId: z.string(),
        attachmentIndex: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(req.body);
    const conversation = store.state.conversations.find((c) => c.id === input.conversationId),
      message = conversation?.messages.find((m) => m.id === input.messageId);
    if (!conversation || !message) return res.status(404).json({ error: '原会话或消息已不存在' });
    const attachment =
      input.attachmentIndex === undefined
        ? undefined
        : message.attachments?.[input.attachmentIndex];
    if (input.attachmentIndex !== undefined && !attachment)
      return res.status(404).json({ error: '原附件已不存在' });
    const text = (attachment?.content ?? message.content).trim(),
      title = (attachment?.name ?? conversation.title + '.md').slice(0, 200);
    if (!text || text.length > LIBRARY_LIMITS.textCharacters)
      return res.status(400).json({ error: '资料为空或超过 20 万字符' });
    if (message.status === 'streaming')
      return res.status(409).json({ error: '请等待回复完成后保存' });
    res.json(
      await store.library<LibraryDocument>({
        action: 'create',
        title,
        text,
        format: attachment ? attachment.name.split('.').at(-1)?.toLowerCase() || 'txt' : 'md',
        source: { ...input, conversationTitle: conversation.title },
      }),
    );
  });
  router.post('/search', async (req, res) => {
    const input = z
      .object({
        query: z.string().trim().min(1).max(LIBRARY_LIMITS.queryCharacters),
        documentIds: z.array(z.string().uuid()).max(200).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(await store.library<Citation[]>({ action: 'search', ...input }));
  });
  router.get('/:id/download', async (req, res) => {
    const data = await store.library<{
      title: string;
      format: string;
      original: Uint8Array;
    } | null>({ action: 'download', id: req.params.id });
    if (!data) return res.status(404).json({ error: '资料已不存在' });
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(data.title).replace(/'/g, '%27')}`,
    );
    res.type('application/octet-stream').send(Buffer.from(data.original));
  });
  router.get('/:id', async (req, res) => {
    const doc = await store.library<LibraryDocument | null>({ action: 'get', id: req.params.id });
    return doc ? res.json(doc) : res.status(404).json({ error: '资料已不存在' });
  });
  router.patch('/:id', async (req, res) => {
    const doc = await store.library<LibraryDocument | null>({
      action: 'patch',
      id: req.params.id,
      patch: documentPatchSchema.parse(req.body),
    });
    return doc ? res.json(doc) : res.status(404).json({ error: '资料已不存在' });
  });
  return router;
}
