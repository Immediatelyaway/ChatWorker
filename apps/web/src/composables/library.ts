import { reactive } from 'vue';
import { api, ui, state, newChat, notify } from './workspace';
import type { LibrarySummary, LibraryDocument } from '../../../../packages/contracts/library';
export const library = reactive({ documents: [] as LibrarySummary[], loading: false, error: '' });
let generation = 0;
export async function loadLibrary() {
  const current = ++generation;
  library.loading = true;
  library.error = '';
  try {
    const docs = await api<LibrarySummary[]>('/library');
    if (current === generation) library.documents = docs;
  } catch (e) {
    if (current === generation) library.error = (e as Error).message;
  } finally {
    if (current === generation) library.loading = false;
  }
}
export async function collectMaterial(
  conversationId: string,
  messageId: string,
  attachmentIndex?: number,
) {
  const doc = await api<LibraryDocument>('/library/collect', 'POST', {
    conversationId,
    messageId,
    attachmentIndex,
  });
  await loadLibrary();
  notify('已保存到空间，可用于资料检索');
  return doc;
}
export async function saveReply(messageId: string) {
  try {
    await collectMaterial(ui.activeId, messageId);
  } catch (e) {
    notify((e as Error).message);
  }
}
export function askDocument(doc: LibrarySummary) {
  newChat();
  ui.useLibrary = true;
  ui.libraryDocumentIds = [doc.id];
  ui.libraryLabel = doc.title;
}
export async function downloadDocument(doc: LibrarySummary) {
  const response = await fetch(`/api/library/${doc.id}/download`, {
    headers: { 'X-ChatWorker': '1' },
  });
  if (!response.ok) throw new Error('下载失败，请重试');
  downloadBlob(await response.blob(), doc.title);
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function sourceConversation(doc: LibrarySummary) {
  return state.conversations.find((c) => c.id === doc.source?.conversationId);
}
