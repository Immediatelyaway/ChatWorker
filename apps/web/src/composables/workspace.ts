import { reactive, computed } from 'vue';
import type {
  State,
  Conversation,
  Attachment,
  Preferences,
  Provider,
  StreamEvent,
} from '../../../../packages/shared/types';
import { drafts, draftKey } from './drafts';
import { parseSSE } from '../../../../packages/providers';
import { STATE_VERSION } from '../../../../packages/contracts/versions';
export const ui = reactive({
  page: 'chat',
  activeId: '',
  projectId: '',
  mode: 'work' as 'chat' | 'work',
  details: false,
  sidebar: true,
  search: '',
  searchOpen: false,
  profileOpen: false,
  setting: 'providers',
  toast: '',
  error: '',
  busyId: '',
  preparing: false,
  ready: false,
  runtime: { desktop: false, persistentKeys: false },
});
export const state = reactive<State>({
  schemaVersion: STATE_VERSION,
  conversations: [],
  projects: [],
  providers: [],
  preferences: { theme: 'light', providerId: 'demo', model: '本地演示', systemPrompt: '' },
});
export const current = computed(() => state.conversations.find((c) => c.id === ui.activeId));
export const provider = computed(() =>
  state.providers.find((p) => p.id === state.preferences.providerId),
);
let toastTimer: ReturnType<typeof setTimeout>;
export function notify(text: string) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast = ''), 3500);
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-ChatWorker': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败（${res.status}）`);
  }
  return res.json();
}
export async function load() {
  try {
    const data = await api<State & { runtime: typeof ui.runtime }>('/state');
    Object.assign(state, data);
    ui.runtime = data.runtime;
    ui.ready = true;
  } catch (e) {
    ui.error = e instanceof Error ? e.message : '无法连接服务';
  }
}
export function openConversation(c: Conversation) {
  ui.activeId = c.id;
  ui.mode = c.mode;
  ui.projectId = c.projectId ?? '';
  ui.page = 'chat';
  ui.searchOpen = false;
  ui.error = '';
}
export function newChat() {
  ui.activeId = '';
  ui.page = 'chat';
  ui.error = '';
}
export async function preference(patch: Partial<Preferences>) {
  try {
    Object.assign(state.preferences, await api('/preferences', 'PATCH', patch));
  } catch (e) {
    notify((e as Error).message);
  }
}
export async function updateConversation(id: string, patch: Partial<Conversation>) {
  try {
    const c = await api<Conversation>('/conversations/' + id, 'PATCH', patch);
    const index = state.conversations.findIndex((c) => c.id === id);
    state.conversations[index] = c;
    if (id === ui.activeId) ui.projectId = c.projectId ?? '';
    if (c.archived && id === ui.activeId) newChat();
    notify(c.archived ? '会话已归档' : '已保存');
  } catch (e) {
    notify((e as Error).message);
  }
}
export async function deleteConversation(id: string) {
  try {
    await api('/conversations/' + id, 'DELETE');
    state.conversations = state.conversations.filter((c) => c.id !== id);
    drafts.clear(draftKey(id, '', ''));
    if (ui.activeId === id) newChat();
    notify('会话已删除');
  } catch (e) {
    notify((e as Error).message);
  }
}
export async function createProject(name: string) {
  try {
    const p = await api('/projects', 'POST', { name });
    state.projects.push(p);
    ui.projectId = p.id;
    newChat();
    notify('项目已创建');
  } catch (e) {
    notify((e as Error).message);
  }
}
export async function send(
  content: string,
  attachments: Attachment[],
  reuseLastUser = false,
  lifecycle: { created?: (id: string) => void; accepted?: () => void } = {},
) {
  if (ui.busyId || ui.preparing) return false;
  ui.error = '';
  if (!provider.value?.configured) {
    ui.page = 'settings';
    ui.setting = 'providers';
    notify('请先配置模型服务');
    return false;
  }
  if (!state.preferences.model) {
    notify('请先填写模型 ID');
    return false;
  }
  let c = current.value;
  let response: Response;
  const selected = {
    id: provider.value!.id,
    name: provider.value!.name,
    model: state.preferences.model,
  };
  ui.preparing = true;
  try {
    if (!c) {
      c = await api<Conversation>('/conversations', 'POST', {
        projectId: ui.projectId || null,
        mode: ui.mode,
      });
      state.conversations.unshift(c);
      lifecycle.created?.(c.id);
      ui.activeId = c.id;
    }
    ui.busyId = c.id;
    response = await fetch(`/api/conversations/${c.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ChatWorker': '1' },
      body: JSON.stringify({
        content,
        attachments,
        providerId: selected.id,
        model: selected.model,
        reuseLastUser,
      }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || '发送失败');
    }
    lifecycle.accepted?.();
    ui.preparing = false;
    const local = state.conversations.find((x) => x.id === c!.id)!;
    if (!reuseLastUser)
      local.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        content,
        attachments,
        createdAt: new Date().toISOString(),
      });
    local.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: new Date().toISOString(),
      model: `${selected.name} / ${selected.model}`,
    });
    if (local.title === '新会话') local.title = content.slice(0, 32);
    const answer = local.messages.at(-1)!;
    let finished = false;
    for await (const raw of parseSSE(response.body!)) {
      const event = JSON.parse(raw) as StreamEvent;
      if (event.type === 'delta') answer.content += event.text;
      if (event.type === 'activity') local.activities.push(event.activity);
      if (event.type === 'error') ui.error = event.message;
      if (event.type === 'done') {
        finished = true;
        const index = state.conversations.findIndex((x) => x.id === c!.id);
        state.conversations[index] = event.conversation;
      }
    }
    if (!finished) {
      await load();
      throw new Error('连接已中断，请查看保存的会话状态');
    }
    return true;
  } catch (e) {
    ui.error = (e as Error).message;
    await load();
    return false;
  } finally {
    ui.preparing = false;
    ui.busyId = '';
  }
}
export async function forkConversation(messageId: string, intent: 'continue' | 'retry') {
  if (!current.value || ui.busyId || ui.preparing) return;
  if (intent === 'retry' && (!provider.value?.configured || !state.preferences.model)) {
    ui.page = 'settings';
    ui.setting = 'providers';
    notify('请先配置模型服务和模型 ID，再重新生成');
    return;
  }
  const sourceId = current.value.id;
  ui.preparing = true;
  ui.error = '';
  try {
    const branch = await api<Conversation>(`/conversations/${sourceId}/branch`, 'POST', {
      messageId,
      intent,
    });
    state.conversations.unshift(branch);
    openConversation(branch);
    notify(intent === 'retry' ? '已创建重试分支，原回复保留' : '已创建分支，可以继续对话');
    ui.preparing = false;
    if (intent === 'retry') await send('', [], true);
  } catch (e) {
    ui.error = (e as Error).message;
  } finally {
    ui.preparing = false;
  }
}
export async function cancel() {
  if (ui.busyId)
    try {
      await api(`/conversations/${ui.busyId}/cancel`, 'POST');
    } catch (e) {
      notify((e as Error).message);
    }
}
export function exportConversation() {
  if (!current.value) return;
  const c = current.value;
  const text =
    `# ${c.title}\n\n` +
    c.messages
      .map((m) => `## ${m.role === 'user' ? '我' : 'ChatWorker'}\n\n${m.content}\n`)
      .join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = c.title.replace(/[^\p{L}\p{N}\-_]/gu, '_') + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('会话已导出');
}
export async function saveProvider(id: string, value: Partial<Provider> & { apiKey?: string }) {
  const p = await api<Provider>('/providers/' + id, 'PUT', value);
  state.providers[state.providers.findIndex((x) => x.id === id)] = p;
  return p;
}
