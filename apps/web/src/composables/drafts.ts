import { reactive } from 'vue';
import type { Attachment } from '../../../../packages/shared/types';
import { DRAFT_VERSION } from '../../../../packages/contracts/versions';
import { CHAT_LIMITS } from '../../../../packages/contracts/limits';

export interface Draft {
  text: string;
  attachments: Attachment[];
}
interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const prefix = `chatworker:draft:v${DRAFT_VERSION}:`;
const blank = (): Draft => ({ text: '', attachments: [] });
const copy = (draft: Draft): Draft => ({
  text: draft.text,
  attachments: draft.attachments.map((a) => ({ ...a })),
});
export function draftKey(conversationId: string, projectId: string, mode: string) {
  return conversationId ? `conversation:${conversationId}` : `new:${mode}:${projectId}`;
}
function parse(raw: string): Draft {
  const value = JSON.parse(raw);
  if (
    value.version !== DRAFT_VERSION ||
    typeof value.text !== 'string' ||
    value.text.length > CHAT_LIMITS.inputCharacters ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > CHAT_LIMITS.attachmentsPerMessage ||
    value.attachments.some(
      (a: Attachment) =>
        !a ||
        typeof a.name !== 'string' ||
        !a.name ||
        a.name.length > CHAT_LIMITS.attachmentNameCharacters ||
        typeof a.content !== 'string' ||
        a.content.length > CHAT_LIMITS.attachmentCharacters,
    )
  )
    throw new Error('Invalid draft');
  return {
    text: value.text,
    attachments: value.attachments.map((a: Attachment) => ({ name: a.name, content: a.content })),
  };
}

/** Client drafts are separate from model credentials and server conversation history. */
export class DraftStore {
  readonly records = reactive<Record<string, Draft>>({});
  readonly warnings = reactive<Record<string, string>>({});
  constructor(private storage?: DraftStorage) {}
  get(key: string): Draft {
    if (!this.records[key]) {
      this.records[key] = blank();
      try {
        const raw = this.storage?.getItem(prefix + key);
        if (raw) this.records[key] = parse(raw);
      } catch {
        this.warnings[key] = '无法读取已保存的草稿，请先检查客户端存储。';
      }
    }
    return this.records[key];
  }
  snapshot(key: string) {
    return copy(this.get(key));
  }
  set(key: string, draft: Draft) {
    this.records[key] = copy(draft);
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      if (!draft.text && !draft.attachments.length) this.storage.removeItem(prefix + key);
      else this.storage.setItem(prefix + key, JSON.stringify({ version: DRAFT_VERSION, ...draft }));
      delete this.warnings[key];
    } catch {
      this.warnings[key] =
        '草稿仅保留在当前窗口内存中，请勿刷新或关闭。客户端存储不可用或空间不足。';
    }
  }
  clear(key: string) {
    this.set(key, blank());
  }
  clearIfUnchanged(key: string, expected: Draft) {
    if (JSON.stringify(this.get(key)) === JSON.stringify(expected)) this.clear(key);
  }
  move(from: string, to: string) {
    if (from === to) return;
    const value = this.snapshot(from);
    this.set(to, value);
    // Do not discard the persisted source when the target could not be saved.
    if (!this.warnings[to]) this.clear(from);
  }
}
let storage: DraftStorage | undefined;
try {
  if (typeof window !== 'undefined') storage = window.localStorage;
} catch {
  /* Fall back to memory. */
}
export const drafts = new DraftStore(storage);
