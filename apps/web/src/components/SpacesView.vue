<script setup lang="ts">
import { computed, onMounted, onUnmounted, nextTick, watch, ref } from 'vue';
import Icon from './Icon.vue';
import { ui, state, api, openConversation } from '../composables/workspace';
import {
  library,
  loadLibrary,
  collectMaterial,
  askDocument,
  downloadDocument,
  downloadBlob,
  sourceConversation,
} from '../composables/library';
import {
  LIBRARY_LIMITS,
  type LibraryDocument,
  type LibrarySummary,
} from '../../../../packages/contracts/library';
const previewPanel = ref<HTMLElement>(),
  notePanel = ref<HTMLElement>();
const query = ref(''),
  input = ref<HTMLInputElement>(),
  uploading = ref(false),
  uploadStatus = ref(''),
  error = ref(''),
  selected = ref<LibraryDocument>(),
  previewLoading = ref(false),
  editingTitle = ref(''),
  saving = ref(false),
  noteOpen = ref(false),
  noteTitle = ref(''),
  noteText = ref('');
let previewGeneration = 0;
const titles: Record<string, string> = {
  all: '全部资料',
  uploads: '上传的资料',
  history: '对话中的资料',
  favorites: '收藏',
  trash: '回收站',
};
const history = computed(() =>
  state.conversations.flatMap((c) =>
    c.messages.flatMap((m) =>
      (m.attachments ?? []).map((a, i) => ({
        id: `${c.id}:${m.id}:${i}`,
        title: a.name,
        text: a.content,
        conversation: c,
        messageId: m.id,
        index: i,
        createdAt: m.createdAt,
      })),
    ),
  ),
);
const filteredHistory = computed(() =>
  history.value.filter((x) =>
    (x.title + ' ' + x.conversation.title).toLowerCase().includes(query.value.toLowerCase()),
  ),
);
const documents = computed(() =>
  library.documents.filter(
    (d) =>
      (ui.spaceFilter === 'trash' ? d.deleted : !d.deleted) &&
      (ui.spaceFilter !== 'favorites' || d.favorite) &&
      (ui.spaceFilter !== 'uploads' || !d.source) &&
      (d.title + ' ' + (d.source?.conversationTitle ?? ''))
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
const count = computed(() => library.documents.filter((d) => !d.deleted).length);
onMounted(loadLibrary);
function escape(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    close();
    noteOpen.value = false;
  }
}
onMounted(() => window.addEventListener('keydown', escape));
onUnmounted(() => window.removeEventListener('keydown', escape));
watch(noteOpen, async (value) => {
  if (value) {
    await nextTick();
    notePanel.value?.querySelector<HTMLInputElement>('input')?.focus();
  }
});
async function upload(file: File) {
  if (file.size > LIBRARY_LIMITS.fileBytes) throw new Error(`${file.name} 超过 5 MiB`);
  const response = await fetch('/api/library/upload', {
    method: 'POST',
    headers: {
      'X-ChatWorker': '1',
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '上传失败');
  return data as LibraryDocument;
}
async function files(files: FileList | null) {
  if (!files?.length || uploading.value) return;
  uploading.value = true;
  error.value = '';
  const failures: string[] = [];
  let completed = 0;
  for (const file of Array.from(files).slice(0, 10)) {
    uploadStatus.value = `正在整理 ${file.name}…`;
    try {
      await upload(file);
      completed++;
    } catch (e) {
      failures.push((e as Error).message);
    }
  }
  if (files.length > 10) failures.push('每批最多处理 10 个文件，其余文件请分批上传');
  uploadStatus.value = completed ? `已整理 ${completed} 份资料，可以开始提问。` : '';
  error.value = failures.join('；');
  uploading.value = false;
  await loadLibrary();
  if (input.value) input.value.value = '';
}
async function open(doc: LibrarySummary) {
  const token = ++previewGeneration;
  previewLoading.value = true;
  error.value = '';
  try {
    const value = await api<LibraryDocument>('/library/' + doc.id);
    if (token === previewGeneration) {
      selected.value = value;
      editingTitle.value = value.title;
      await nextTick();
      previewPanel.value?.focus();
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    if (token === previewGeneration) previewLoading.value = false;
  }
}
function close() {
  previewGeneration++;
  selected.value = undefined;
  previewLoading.value = false;
}
async function patch(doc: LibrarySummary, values: Partial<LibraryDocument>) {
  saving.value = true;
  error.value = '';
  try {
    const updated = await api<LibraryDocument>('/library/' + doc.id, 'PATCH', values);
    if (selected.value?.id === doc.id) selected.value = updated;
    await loadLibrary();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
async function collect(item: (typeof history.value)[number]) {
  try {
    error.value = '';
    const doc = await collectMaterial(item.conversation.id, item.messageId, item.index);
    await open(doc);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function download(doc: LibrarySummary) {
  try {
    await downloadDocument(doc);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function saveNote() {
  if (!noteTitle.value.trim() || !noteText.value.trim()) return;
  saving.value = true;
  error.value = '';
  try {
    const name = noteTitle.value.trim().replace(/\.md$/i, '') + '.md';
    const doc = await upload(new File([noteText.value], name, { type: 'text/markdown' }));
    await loadLibrary();
    noteOpen.value = false;
    noteTitle.value = '';
    noteText.value = '';
    await open(doc);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
function downloadHistory(text: string, title: string) {
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), title);
}
const date = (value: string) =>
  new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
</script>
<template>
  <section
    class="spaces-view"
    @dragover.prevent
    @drop.prevent="files($event.dataTransfer?.files ?? null)"
  >
    <header class="spaces-heading">
      <div>
        <span class="spaces-eyebrow">YOUR KNOWLEDGE, CONNECTED</span>
        <h1>{{ titles[ui.spaceFilter] || '全部资料' }}</h1>
        <p>把资料留在这里，让每一次对话有所依据。</p>
      </div>
      <div class="spaces-actions">
        <button class="secondary-button" @click="noteOpen = true">
          <Icon name="edit" :size="16" />新建笔记</button
        ><button class="primary-button" :disabled="uploading" @click="input?.click()">
          <Icon :name="uploading ? 'loading' : 'plus'" :class="{ spin: uploading }" :size="17" />{{
            uploading ? '整理中…' : '上传资料'
          }}
        </button>
      </div>
    </header>
    <input
      ref="input"
      type="file"
      accept=".txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.jsx,.tsx,.vue,.py,.rs,.go,.java,.c,.cpp,.h,.sql,.log,.pdf,.docx"
      multiple
      hidden
      @change="files(($event.target as HTMLInputElement).files)"
    />
    <div class="spaces-mobile-tabs">
      <button
        v-for="(label, id) in titles"
        :key="id"
        :class="{ active: ui.spaceFilter === id }"
        @click="ui.spaceFilter = String(id)"
      >
        {{ label }}
      </button>
    </div>
    <div v-if="ui.spaceFilter === 'all'" class="spaces-intro">
      <div class="space-intro-mark"><Icon name="library" :size="30" /></div>
      <div>
        <h2>让你的资料，成为回答的起点</h2>
        <p>
          上传文档或保存对话中的资料，提问时开启「参考空间资料」。相关片段会随问题发送给当前模型，并在回答下方留下来源。
        </p>
        <span>{{ count }} 份资料 · 保存在本机</span>
      </div>
      <Icon class="space-intro-star" name="sparkles" :size="40" />
    </div>
    <div class="spaces-list-toolbar">
      <div class="spaces-section-title">
        <h2>{{ ui.spaceFilter === 'history' ? '历史附件' : '资料库' }}</h2>
        <span>{{ ui.spaceFilter === 'history' ? filteredHistory.length : documents.length }}</span>
      </div>
      <label class="spaces-search"
        ><Icon name="search" :size="17" /><input
          v-model="query"
          aria-label="搜索空间资料"
          placeholder="搜索名称或来源…" /></label
      ><button class="icon-button" aria-label="刷新空间资料" @click="loadLibrary">
        <Icon name="retry" :class="{ spin: library.loading }" :size="17" />
      </button>
    </div>
    <p v-if="error || library.error" class="space-error" role="alert">
      {{ error || library.error }}
    </p>
    <p v-if="uploadStatus" class="space-status" role="status">{{ uploadStatus }}</p>
    <template v-if="ui.spaceFilter === 'history'"
      ><p class="space-hint">
        浏览之前会话中的附件。加入资料库会保存独立副本，之后删除原会话不影响它。
      </p>
      <div v-for="item in filteredHistory" :key="item.id" class="space-row">
        <span class="space-file-icon"><Icon name="file" :size="21" /></span>
        <div class="space-row-title">
          <strong>{{ item.title }}</strong
          ><small>{{ item.conversation.title }}</small>
          <details>
            <summary>查看原文</summary>
            <pre class="space-history-text">{{ item.text }}</pre>
          </details>
        </div>
        <button class="text-button" @click="downloadHistory(item.text, item.title)">下载</button
        ><button class="text-button" @click="openConversation(item.conversation)">回到会话</button
        ><button class="secondary-button" @click="collect(item)">
          <Icon name="plus" :size="14" />加入资料库
        </button>
      </div>
      <div v-if="!filteredHistory.length" class="spaces-empty">
        <Icon name="chat" :size="34" />
        <h3>对话中的资料，会出现在这里</h3>
        <p>之前上传到会话的文本附件可在此查看、下载和收藏到资料库。</p>
      </div></template
    >
    <template v-else
      ><div v-if="documents.length" class="space-table-heading">
        <span>名称</span><span>来源</span><span>更新</span><span></span>
      </div>
      <div v-for="doc in documents" :key="doc.id" class="space-row">
        <button class="space-row-main" @click="open(doc)">
          <span class="space-file-icon" :class="doc.format"
            ><Icon :name="doc.source ? 'chat' : 'file'" :size="21" /></span
          ><span class="space-row-title"
            ><strong>{{ doc.title }}</strong
            ><small
              >{{ doc.format.toUpperCase() }} · {{ doc.characters.toLocaleString() }} 字符 ·
              {{ doc.enabled && !doc.deleted ? '可供回答参考' : '未参与检索' }}</small
            ></span
          ></button
        ><span class="space-origin truncate">{{ doc.source?.conversationTitle || '本机上传' }}</span
        ><time>{{ date(doc.updatedAt) }}</time
        ><button
          class="icon-button"
          :aria-label="(doc.favorite ? '取消收藏 ' : '收藏 ') + doc.title"
          :class="{ favorited: doc.favorite }"
          :disabled="saving"
          @click="patch(doc, { favorite: !doc.favorite })"
        >
          <Icon name="star" :size="17" />
        </button>
      </div>
      <div v-if="!documents.length && !library.loading" class="spaces-empty">
        <Icon :name="ui.spaceFilter === 'trash' ? 'trash' : 'library'" :size="38" />
        <h3>
          {{
            ui.spaceFilter === 'trash'
              ? '回收站是空的'
              : query
                ? '没有找到匹配资料'
                : '从一份资料开始'
          }}
        </h3>
        <p>拖入文件，或把有价值的对话回复保存到空间。</p>
        <button
          v-if="!query && ui.spaceFilter !== 'trash'"
          class="secondary-button"
          @click="input?.click()"
        >
          上传第一份资料
        </button>
      </div></template
    >
    <p class="spaces-formats">
      支持文本、Markdown、代码、PDF、DOCX · 单文件 5 MiB / 提取文字 20 万字符 · 扫描件需先做 OCR
    </p>
    <div v-if="selected || previewLoading" class="space-preview-overlay" @click.self="close">
      <section
        ref="previewPanel"
        tabindex="-1"
        class="space-preview"
        role="dialog"
        aria-modal="true"
        aria-label="资料预览"
        @keydown.esc="close"
      >
        <header>
          <span>资料预览</span
          ><button class="icon-button" aria-label="关闭资料预览" @click="close">
            <Icon name="x" />
          </button>
        </header>
        <p v-if="error" role="alert" class="space-error">{{ error }}</p>
        <p v-if="previewLoading">正在读取…</p>
        <template v-else-if="selected"
          ><div class="space-preview-title">
            <Icon name="file" :size="28" />
            <h2>{{ selected.title }}</h2>
          </div>
          <p class="space-hint">
            {{ selected.format.toUpperCase() }} · {{ selected.characters.toLocaleString() }} 字符 ·
            {{ selected.chunks }} 个可检索片段
          </p>
          <div class="space-preview-actions">
            <button
              class="primary-button"
              :disabled="selected.deleted || !selected.enabled"
              @click="askDocument(selected)"
            >
              <Icon name="sparkles" :size="16" />用这份资料提问</button
            ><button class="secondary-button" @click="download(selected)">
              <Icon name="download" :size="16" />下载原文件</button
            ><button
              v-if="sourceConversation(selected)"
              class="text-button"
              @click="openConversation(sourceConversation(selected)!)"
            >
              原会话 <Icon name="arrow" :size="14" />
            </button>
          </div>
          <label class="space-toggle"
            ><input
              type="checkbox"
              :checked="selected.enabled"
              :disabled="saving || selected.deleted"
              @change="patch(selected, { enabled: !selected.enabled })"
            /><span>允许在空间检索中参考此资料</span></label
          >
          <details class="space-rename">
            <summary>整理资料</summary>
            <form @submit.prevent="patch(selected, { title: editingTitle })">
              <input v-model="editingTitle" maxlength="200" required aria-label="资料名称" /><button
                class="secondary-button"
                :disabled="saving"
              >
                保存名称
              </button>
            </form>
            <button
              class="text-button"
              :disabled="saving"
              @click="patch(selected, { deleted: !selected.deleted })"
            >
              <Icon :name="selected.deleted ? 'retry' : 'trash'" :size="15" />{{
                selected.deleted ? '从回收站恢复' : '移入回收站'
              }}
            </button>
          </details>
          <p class="space-hint">提取的文字 · 原文仅作资料，不作为执行指令</p>
          <pre class="space-preview-text">{{ selected.text }}</pre>
        </template>
      </section>
    </div>
    <div v-if="noteOpen" class="modal-overlay" @click.self="noteOpen = false">
      <form
        ref="notePanel"
        class="dialog space-note-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新建空间笔记"
        @submit.prevent="saveNote"
      >
        <h2>把想法留在空间</h2>
        <input
          v-model="noteTitle"
          placeholder="笔记标题"
          aria-label="笔记标题"
          maxlength="180"
          required
        /><textarea
          v-model="noteText"
          placeholder="记录内容，支持 Markdown…"
          aria-label="笔记内容"
          :maxlength="LIBRARY_LIMITS.textCharacters"
          required
        ></textarea>
        <p v-if="error" role="alert" class="space-error">{{ error }}</p>
        <div class="form-actions">
          <button type="button" class="secondary-button" @click="noteOpen = false">取消</button
          ><button class="primary-button" :disabled="saving">
            {{ saving ? '保存中…' : '保存到空间' }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>
