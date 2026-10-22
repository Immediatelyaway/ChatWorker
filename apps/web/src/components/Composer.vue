<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';
import ModelPicker from './ModelPicker.vue';
import { ui, state, send, cancel, notify } from '../composables/workspace';
import { drafts, draftKey } from '../composables/drafts';
import type { DraftReceipt } from '../composables/synced-drafts';
import { CHAT_LIMITS } from '../../../../packages/contracts/limits';
const key = computed(() => draftKey(ui.activeId, ui.projectId, ui.mode));
const entry = computed(() => drafts.get(key.value));
const draft = computed(() => entry.value.draft);
const preparingDraft = ref(false);
watch(
  key,
  (value) => {
    void drafts.open(value);
  },
  { immediate: true },
);
function refreshDraft() {
  if (document.visibilityState === 'visible') void drafts.refresh(key.value);
}
function leaving() {
  void drafts.flushAll();
}
let refreshTimer: ReturnType<typeof setInterval>;
onMounted(() => {
  refreshTimer = setInterval(refreshDraft, 5000);
  window.addEventListener('focus', refreshDraft);
  window.addEventListener('online', refreshDraft);
  window.addEventListener('pagehide', leaving);
});
onUnmounted(() => {
  clearInterval(refreshTimer);
  window.removeEventListener('focus', refreshDraft);
  window.removeEventListener('online', refreshDraft);
  window.removeEventListener('pagehide', leaving);
  void drafts.flushAll();
});
const statusText = computed(
  () =>
    ({
      loading: '正在读取草稿…',
      saved: '草稿已保存到本机，重启后可恢复',
      dirty: '草稿等待保存…',
      saving: '正在保存草稿…',
      offline: '尚未保存到资料库，请保留当前窗口或下载副本',
      conflict: '另一窗口已修改此草稿，请选择要保留的版本',
    })[entry.value.status],
);
function downloadDraft() {
  const payload = {
    format: 'chatworker-draft-copy',
    version: 1,
    local: drafts.snapshot(key.value),
    saved: entry.value.remote?.draft,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ChatWorker-草稿副本.json';
  anchor.click();
  URL.revokeObjectURL(url);
}
const text = computed({
  get: () => draft.value.text,
  set: (value: string) => drafts.set(key.value, { ...draft.value, text: value }),
});
const attachments = computed(() => draft.value.attachments);
const input = ref<HTMLInputElement>();
async function submit() {
  if (!text.value.trim() || ui.busyId || ui.preparing || preparingDraft.value || entry.value.remote)
    return;
  const sourceKey = key.value;
  let sendingKey = sourceKey;
  preparingDraft.value = true;
  try {
    let receipt: DraftReceipt | undefined = await drafts.flush(sourceKey);
    if (!receipt) {
      notify('请先保存草稿或处理版本冲突，再发送');
      return;
    }
    const sourceReceipt = receipt;
    await send(receipt.draft.text.trim(), receipt.draft.attachments, false, {
      created: async (id) => {
        const target = draftKey(id, '', '');
        const moved = await drafts.move(sourceKey, target, sourceReceipt);
        if (!moved) throw new Error('会话已创建，但草稿转存未完成；原草稿已保留，请重试');
        receipt = moved;
        sendingKey = target;
      },
      accepted: () => {
        preparingDraft.value = false;
        // Acknowledgement only clears the exact saved revision and local edit generation.
        void drafts.clearIfUnchanged(sendingKey, receipt!);
        if (sourceKey !== sendingKey) void drafts.clearIfUnchanged(sourceKey, sourceReceipt);
      },
    });
  } finally {
    preparingDraft.value = false;
  }
}
function removeAttachment(index: number) {
  drafts.set(key.value, {
    ...draft.value,
    attachments: attachments.value.filter((_, i) => i !== index),
  });
}
function keydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
}
async function files(e: Event) {
  const targetKey = key.value;
  const list = Array.from((e.target as HTMLInputElement).files ?? []);
  for (const file of list) {
    if (drafts.get(targetKey).draft.attachments.length >= CHAT_LIMITS.attachmentsPerMessage) {
      notify(`最多添加 ${CHAT_LIMITS.attachmentsPerMessage} 个文本附件`);
      break;
    }
    if (file.size > CHAT_LIMITS.attachmentFileBytes) {
      notify(`${file.name} 超过 ${CHAT_LIMITS.attachmentFileBytes / 1000} KB`);
      continue;
    }
    if (
      !/\.(txt|md|json|csv|ts|tsx|js|jsx|py|html|css|vue|rs|go|java|yaml|yml|xml|log|sql|sh|c|cpp|h)$/i.test(
        file.name,
      )
    ) {
      notify('当前支持文本、Markdown 和代码文件');
      continue;
    }
    const content = await file.text();
    if (content.includes('\u0000')) {
      notify('不能读取二进制文件');
      continue;
    }
    const target = drafts.get(targetKey).draft;
    if (target.attachments.length >= CHAT_LIMITS.attachmentsPerMessage) {
      notify(`最多添加 ${CHAT_LIMITS.attachmentsPerMessage} 个文本附件`);
      break;
    }
    if (file.name.length > CHAT_LIMITS.attachmentNameCharacters) {
      notify(`附件名称不能超过 ${CHAT_LIMITS.attachmentNameCharacters} 个字符`);
      continue;
    }
    drafts.set(targetKey, {
      ...target,
      attachments: [...target.attachments, { name: file.name, content }],
    });
  }
  if (input.value) input.value.value = '';
}
function fill(value: string) {
  text.value = value;
}
defineExpose({ fill });
</script>
<template>
  <div class="composer-wrap">
    <div class="library-composer-bar">
      <button
        :class="{ active: ui.useLibrary }"
        :aria-pressed="ui.useLibrary"
        @click="ui.useLibrary = !ui.useLibrary"
      >
        <Icon name="library" :size="15" />参考空间资料<span v-if="ui.useLibrary">
          · 已开启</span
        ></button
      ><span v-if="ui.useLibrary" class="library-scope truncate"
        >{{ ui.libraryLabel || '全部已启用资料' }} · 相关片段将发送给当前模型</span
      ><button
        v-if="ui.libraryDocumentIds.length"
        class="text-button"
        @click="
          ui.libraryDocumentIds = [];
          ui.libraryLabel = '';
        "
      >
        改用全部
      </button>
    </div>
    <div class="composer">
      <div v-if="attachments.length" class="attachment-chips">
        <span v-for="(a, i) in attachments" :key="i" class="attachment-chip"
          ><Icon name="file" :size="14" />{{ a.name
          }}<button aria-label="移除附件" @click="removeAttachment(i)">
            <Icon name="x" :size="13" /></button
        ></span>
      </div>
      <textarea
        v-model="text"
        :disabled="ui.preparing || preparingDraft || !entry.loaded"
        aria-label="消息"
        :placeholder="ui.mode === 'work' ? '描述你的想法，让我们一起完成…' : '有什么想聊的？'"
        rows="3"
        :maxlength="CHAT_LIMITS.inputCharacters"
        @keydown="keydown"
      ></textarea>
      <div class="composer-toolbar">
        <button
          class="icon-button"
          title="添加文本或代码附件"
          aria-label="添加附件"
          :disabled="ui.preparing || preparingDraft || !entry.loaded"
          @click="input?.click()"
        >
          <Icon name="plus" :size="22" /></button
        ><input ref="input" type="file" multiple hidden @change="files" /><span
          class="composer-hint"
          ><Icon :name="ui.mode === 'work' ? 'checks' : 'chat'" :size="15" />{{
            ui.mode === 'work' ? '一起想清楚，逐步完成' : '自由探索'
          }}</span
        >
        <ModelPicker />
        <button
          v-if="ui.busyId && !ui.preparing"
          class="send-button stop"
          title="停止生成"
          aria-label="停止生成"
          @click="cancel"
        >
          <Icon name="stop" :size="16" /></button
        ><button
          v-else
          class="send-button"
          :disabled="
            !text.trim() ||
            !ui.ready ||
            ui.preparing ||
            preparingDraft ||
            !entry.loaded ||
            !!entry.remote
          "
          title="发送消息"
          aria-label="发送消息"
          @click="submit"
        >
          <Icon
            :name="ui.preparing ? 'loading' : 'send'"
            :class="{ spin: ui.preparing }"
            :size="20"
          />
        </button>
      </div>
    </div>
    <div class="draft-status" role="status">
      <span>{{ statusText }}</span>
      <button
        v-if="text || attachments.length"
        type="button"
        class="text-button"
        :disabled="ui.preparing || preparingDraft || !entry.loaded || !!entry.remote"
        @click="drafts.clear(key)"
      >
        清空草稿
      </button>
    </div>
    <div v-if="entry.warning || entry.cacheWarning" class="draft-warning" role="alert">
      {{ entry.warning || entry.cacheWarning }}
    </div>
    <div v-if="entry.status === 'offline'" class="draft-actions">
      <button
        type="button"
        class="text-button"
        @click="entry.loaded ? drafts.flush(key) : drafts.open(key)"
      >
        重试保存与读取
      </button>
      <button type="button" class="text-button" @click="downloadDraft">下载窗口副本</button>
    </div>
    <div v-if="entry.remote" class="draft-conflict" role="region" aria-label="草稿版本冲突">
      <p>两个版本都保留在这里。选择窗口版本时仍会核对最新版本，避免覆盖后续修改。</p>
      <div class="draft-versions">
        <div>
          <strong>本窗口版本</strong>
          <pre>{{ text || '（无文字）' }}</pre>
          <small v-for="(a, i) in attachments" :key="i">{{ a.name }}</small>
        </div>
        <div>
          <strong>资料库已保存版本</strong>
          <pre>{{ entry.remote.draft.text || '（无文字）' }}</pre>
          <small v-for="(a, i) in entry.remote.draft.attachments" :key="i">{{ a.name }}</small>
        </div>
      </div>
      <div class="draft-actions">
        <button type="button" class="secondary-button" @click="drafts.keepLocal(key)">
          保存本窗口版本
        </button>
        <button type="button" class="secondary-button" @click="drafts.useRemote(key)">
          采用已保存版本
        </button>
        <button type="button" class="text-button" @click="downloadDraft">下载两个版本</button>
      </div>
    </div>
    <details v-if="entry.recoveries.length" class="draft-recoveries">
      <summary>可恢复的草稿副本（{{ entry.recoveries.length }}）</summary>
      <div v-for="copy in entry.recoveries" :key="copy.id">
        <span
          >{{ copy.label }} · {{ copy.draft.text.slice(0, 60) || '附件草稿' }} ·
          {{ copy.draft.attachments.length }} 个附件</span
        >
        <button
          type="button"
          class="text-button"
          :disabled="!entry.loaded || entry.status === 'saving'"
          @click="drafts.recover(key, copy.id)"
        >
          比较并恢复
        </button>
      </div>
    </details>
    <div class="composer-bottom">
      <div>
        <Icon name="folder" :size="14" /><select
          v-model="ui.projectId"
          aria-label="选择项目"
          :disabled="!!ui.activeId"
        >
          <option value="">独立会话</option>
          <option v-for="p in state.projects" :value="p.id" :key="p.id">
            {{ p.name }}
          </option></select
        ><span class="bottom-divider"></span
        ><button
          :disabled="ui.preparing || preparingDraft || !entry.loaded"
          @click="input?.click()"
        >
          <Icon name="attach" :size="14" />添加文件
        </button>
      </div>
      <span class="keyboard-hint">Enter 发送 · Shift Enter 换行</span>
    </div>
  </div>
</template>
