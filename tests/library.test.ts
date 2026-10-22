import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import { chunks, retrieve, referenceContext } from '../packages/knowledge/retrieval.js';
import { extractDocument } from '../packages/knowledge/extract.js';
import { Storage } from '../apps/server/src/storage.js';
import { startServer } from '../apps/server/src/index.js';
import { parseSSE } from '../packages/providers/index.js';
import { exportBackup, importBackup } from '../apps/server/src/backup.js';
import { DATABASE_VERSION } from '../packages/contracts/versions.js';
import type { LibraryDocument, LibrarySummary, Citation } from '../packages/contracts/library.js';
const encode = (s: string) => new TextEncoder().encode(s);
const dir = () => mkdtempSync(join(tmpdir(), 'chatworker-library-test-'));
const material = {
  action: 'create' as const,
  title: '星海发布方案.md',
  format: 'md',
  text: '星海项目的发布窗口是周五下午，负责人林舟。\n回滚流程：先暂停部署，再切换上一个稳定版本。',
};
const pdfBytes = () => {
  const content = 'BT /F1 14 Tf 40 150 Td (Orbital satellite launch Friday) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(output.length);
    output += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = output.length;
  output +=
    `xref\n0 6\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return encode(output);
};
async function docxBytes() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>星海项目的负责人是林舟</w:t></w:r></w:p></w:body></w:document>',
  );
  return zip.generateAsync({ type: 'uint8array' });
}

test('local retrieval ranks Chinese and English, retains exact excerpts, bounds context and handles no match', () => {
  const text = material.text.repeat(100),
    parts = chunks(text);
  assert.equal(parts.map((p) => p.text).join(''), text);
  assert.ok(parts.every((p) => p.text.length <= 1400));
  const boundaryText = 'x'.repeat(1400) + '\n' + '下一段'.repeat(600);
  const boundaryParts = chunks(boundaryText);
  assert.ok(boundaryParts.every((p) => p.text.length <= 1400));
  assert.equal(boundaryParts.map((p) => p.text).join(''), boundaryText);
  const rows = parts.map((p, i) => ({
    ...p,
    documentId: '00000000-0000-4000-8000-000000000001',
    title: material.title,
    hash: 'a'.repeat(64),
    chunkIndex: i,
  }));
  const result = retrieve('星海项目怎么回滚？', rows);
  assert.ok(result.length > 0 && result.length <= 3);
  assert.ok(result.every((r) => text.includes(r.text)));
  assert.deepEqual(retrieve('zyxquasar', rows), []);
  assert.match(referenceContext(result), /不可信参考资料/);
  assert.match(referenceContext([]), /没有找到/);
});

test('text, PDF and DOCX extraction runs in a bounded worker and rejects invalid input', async () => {
  assert.equal(
    (await extractDocument('note.md', encode('第一行\r\n第二行'))).text,
    '第一行\n第二行',
  );
  assert.match(
    (await extractDocument('sample.pdf', pdfBytes())).text,
    /Orbital satellite launch Friday/,
  );
  assert.match((await extractDocument('sample.docx', await docxBytes())).text, /星海项目/);
  await assert.rejects(extractDocument('bad.txt', new Uint8Array([255, 254, 0])), /UTF-8/);
  await assert.rejects(extractDocument('bad.pdf', encode('not a PDF')), /有效/);
  await assert.rejects(extractDocument('picture.png', encode('image')), /支持/);
  await assert.rejects(extractDocument('empty.txt', encode('   ')), /没有可用文字/);
});

test('library operations persist independently of history, atomically index, deduplicate, and exclude disabled or trashed documents', async () => {
  const directory = dir();
  let store = await Storage.open(directory);
  try {
    const first = await store.library<LibraryDocument>(material);
    const duplicate = await store.library<LibraryDocument>({ ...material, title: 'another.md' });
    assert.equal(duplicate.id, first.id);
    const list = await store.library<LibrarySummary[]>({ action: 'list' });
    assert.equal(list.length, 1);
    assert.equal('text' in list[0], false);
    assert.equal('original' in list[0], false);
    const search = () => store.library<Citation[]>({ action: 'search', query: '星海项目负责人' });
    assert.equal((await search())[0].documentId, first.id);
    await store.library({ action: 'patch', id: first.id, patch: { enabled: false } });
    assert.deepEqual(await search(), []);
    await store.library({ action: 'patch', id: first.id, patch: { enabled: true, deleted: true } });
    assert.deepEqual(await search(), []);
    await store.library({
      action: 'patch',
      id: first.id,
      patch: { deleted: false, favorite: true },
    });
    await store.update((s) => {
      s.preferences.theme = 'dark';
    });
    const db = new DatabaseSync(join(directory, 'state.sqlite'));
    db.exec(
      "CREATE TRIGGER fail_chunk BEFORE INSERT ON library_chunks BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    await assert.rejects(store.library({ ...material, text: '另一份失败资料' }));
    db.exec('DROP TRIGGER fail_chunk');
    db.close();
    assert.equal((await store.library<LibrarySummary[]>({ action: 'list' })).length, 1);
    await store.close();
    store = await Storage.open(directory);
    assert.equal(
      (await store.library<LibraryDocument>({ action: 'get', id: first.id })).favorite,
      true,
    );
    const raw = await store.library<{ original: Uint8Array }>({ action: 'download', id: first.id });
    assert.equal(Buffer.from(raw.original).toString(), material.text);
    assert.equal((await search()).length, 1);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v3 library upgrade keeps exact backup and history; failure rolls back version and tables', async () => {
  for (const fail of [false, true]) {
    const directory = dir();
    let store = await Storage.open(directory);
    await store.update((s) => {
      s.projects.push({ id: 'p', name: '原项目', description: '' });
    });
    await store.close();
    const file = join(directory, 'state.sqlite'),
      db = new DatabaseSync(file);
    db.exec('DROP TABLE library_chunks; DROP TABLE library_documents; PRAGMA user_version=3;');
    if (fail) db.exec('CREATE TABLE library_documents(conflict TEXT);');
    db.close();
    const bytes = readFileSync(file);
    try {
      if (fail) {
        await assert.rejects(Storage.open(directory));
        const check = new DatabaseSync(file);
        assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 3);
        assert.equal(
          check
            .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='library_chunks'")
            .get()!.n,
          0,
        );
        check.close();
      } else {
        store = await Storage.open(directory);
        assert.equal(store.state.projects[0].name, '原项目');
        await store.library(material);
        await store.close();
        const check = new DatabaseSync(file);
        assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, DATABASE_VERSION);
        check.close();
      }
      const backup = readdirSync(directory).find(
        (n) => n === 'state.sqlite.backup-v3-' + createHash('sha256').update(bytes).digest('hex'),
      )!;
      assert.ok(backup);
      assert.deepEqual(readFileSync(join(directory, backup)), bytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('space API uploads, collects real history and passes only opted-in matching excerpts to the model with durable citations', async () => {
  const directory = dir(),
    runtime = await startServer({ port: 0, dataDir: directory }),
    original = globalThis.fetch;
  const base = `http://127.0.0.1:${runtime.port}/api`;
  const call = (path: string, method = 'GET', body?: unknown) =>
    original(base + path, {
      method,
      headers: { 'X-ChatWorker': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const uploaded = await original(base + '/library/upload', {
      method: 'POST',
      headers: {
        'X-ChatWorker': '1',
        'X-File-Name': encodeURIComponent(material.title),
        'Content-Type': 'application/octet-stream',
      },
      body: encode(material.text),
    });
    assert.equal(uploaded.status, 200);
    const doc = await uploaded.json();
    assert.equal((await original(base + '/library')).status, 403);
    assert.equal(
      (
        await original(base + '/library', {
          headers: { 'X-ChatWorker': '1', Origin: 'https://untrusted.example' },
        })
      ).status,
      403,
    );
    const downloaded = await original(base + `/library/${doc.id}/download`, {
      headers: { 'X-ChatWorker': '1' },
    });
    assert.equal(await downloaded.text(), material.text);
    assert.equal((await call('/library/search', 'POST', { query: '星海项目负责人' })).status, 200);
    await call('/providers/custom', 'PUT', {
      baseUrl: 'http://127.0.0.1:43210',
      protocol: 'openai',
      models: ['test'],
      apiKey: 'fake-key',
    });
    const conversation = await (await call('/conversations', 'POST', { mode: 'chat' })).json();
    let sent: any;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: '负责人是林舟 [S1]。' }, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    };
    const send = async (useLibrary: boolean, content = '星海项目负责人是谁？') => {
      const response = await call(`/conversations/${conversation.id}/messages`, 'POST', {
        content,
        providerId: 'custom',
        model: 'test',
        useLibrary,
      });
      assert.equal(response.status, 200);
      const events = [];
      for await (const data of parseSSE(response.body!)) events.push(JSON.parse(data));
      return events;
    };
    let events = await send(false);
    assert.ok(!JSON.stringify(sent).includes('周五下午'));
    assert.ok(!events.some((e) => e.type === 'citations'));
    events = await send(true);
    assert.ok(JSON.stringify(sent).includes('周五下午'));
    assert.ok(JSON.stringify(sent).includes('不可信参考资料'));
    assert.equal(events.find((e) => e.type === 'citations').citations[0].documentId, doc.id);
    const answer = events.find((e) => e.type === 'done').conversation.messages.at(-1);
    assert.equal(answer.execution.citations[0].title, material.title);
    const imported = importBackup(runtime.store.state, exportBackup(runtime.store.state));
    assert.ok(
      imported.conversations.some((c) =>
        c.messages.some((m) => m.execution?.citations?.[0]?.documentId === doc.id),
      ),
    );
    const collected = await call('/library/collect', 'POST', {
      conversationId: conversation.id,
      messageId: answer.id,
    });
    assert.equal(collected.status, 200);
    const saved = await collected.json();
    await call(`/conversations/${conversation.id}`, 'DELETE');
    assert.equal((await call('/library/' + saved.id)).status, 200);
    await call('/library/' + doc.id, 'PATCH', { deleted: true });
    const matches = await (await call('/library/search', 'POST', { query: '回滚流程' })).json();
    assert.ok(!matches.some((c: Citation) => c.documentId === doc.id));
  } finally {
    globalThis.fetch = original;
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
