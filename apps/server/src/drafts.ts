import { Router } from 'express';
import {
  draftKeySchema,
  draftWriteSchema,
  draftCopySchema,
} from '../../../packages/contracts/drafts.js';
import { DRAFT_VERSION } from '../../../packages/contracts/versions.js';
import type { Storage } from './storage.js';

export function draftRoutes(store: Storage) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/identity', (_req, res) =>
    res.json({ storeId: store.storeId, version: DRAFT_VERSION }),
  );
  router.use((req, res, next) => {
    if (req.headers['x-chatworker-store'] !== store.storeId)
      return res
        .status(409)
        .json({ code: 'STORE_CHANGED', error: '连接的资料库已变化，请保留草稿后刷新页面' });
    next();
  });
  router.post('/:key/recoveries', async (req, res) => {
    await store.archiveDraft(draftKeySchema.parse(req.params.key), draftCopySchema.parse(req.body));
    res.json({ ok: true });
  });
  router.get('/:key/recoveries', async (req, res) =>
    res.json(await store.listDraftRecoveries(draftKeySchema.parse(req.params.key))),
  );
  router.get('/:key', async (req, res) => {
    res.json(await store.readDraft(draftKeySchema.parse(req.params.key)));
  });
  router.put('/:key', async (req, res) => {
    const result = await store.writeDraft(
      draftKeySchema.parse(req.params.key),
      draftWriteSchema.parse(req.body),
    );
    res.status(result.ok ? 200 : 409).json(result);
  });
  return router;
}
