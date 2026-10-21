<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { ui, state, provider, send, cancel, preference, notify } from '../composables/workspace';
import { drafts, draftKey } from '../composables/drafts';
import { CHAT_LIMITS } from '../../../../packages/contracts/limits';
const key = computed(() => draftKey(ui.activeId, ui.projectId, ui.mode));
const draft = computed(() => drafts.get(key.value));
const text = computed({
  get: () => draft.value.text,
  set: (value: string) => drafts.set(key.value, { ...draft.value, text: value }),
});
const attachments = computed(() => draft.value.attachments);
const input = ref<HTMLInputElement>(),
  picker = ref(false);
const available = computed(() => state.providers.filter((p) => p.configured));
async function submit() {
  const content = text.value.trim();
  if (!content || ui.busyId || ui.preparing) return;
  const sourceKey = key.value;
  let sendingKey = sourceKey;
  const snapshot = drafts.snapshot(sendingKey);
  await send(content, snapshot.attachments, false, {
    created: (id) => {
      const target = draftKey(id, '', '');
      drafts.move(sendingKey, target);
      sendingKey = target;
    },
    accepted: () => {
      drafts.clearIfUnchanged(sendingKey, snapshot);
      if (sourceKey !== sendingKey) drafts.clearIfUnchanged(sourceKey, snapshot);
    },
  });
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
    if (drafts.get(targetKey).attachments.length >= CHAT_LIMITS.attachmentsPerMessage) {
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
    const target = drafts.get(targetKey);
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
function pick(id: string, model: string) {
  void preference({ providerId: id, model });
  picker.value = false;
}
function fill(value: string) {
  text.value = value;
}
defineExpose({ fill });
</script>
<template>
  <div class="composer-wrap">
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
        :disabled="ui.preparing"
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
          @click="input?.click()"
        >
          <Icon name="plus" :size="22" /></button
        ><input ref="input" type="file" multiple hidden @change="files" /><span
          class="composer-hint"
          ><Icon :name="ui.mode === 'work' ? 'checks' : 'chat'" :size="15" />{{
            ui.mode === 'work' ? '一起想清楚，逐步完成' : '自由探索'
          }}</span
        >
        <div class="model-picker">
          <button class="model-trigger" @click="picker = !picker" aria-label="选择模型">
            <span class="model-dot"></span
            >{{ provider?.id === 'demo' ? '本地演示' : state.preferences.model || '选择模型'
            }}<Icon name="down" :size="13" />
          </button>
          <div v-if="picker" class="popover model-menu">
            <p class="section-label">选择模型</p>
            <template v-for="p in available" :key="p.id"
              ><button v-for="m in p.models" :key="m" @click="pick(p.id, m)">
                <span
                  ><small>{{ p.name }}</small
                  >{{ m }}</span
                ><Icon
                  v-if="state.preferences.providerId === p.id && state.preferences.model === m"
                  name="check"
                  :size="16"
                /></button></template
            ><button
              class="configure-link"
              @click="
                ui.page = 'settings';
                ui.setting = 'providers';
                picker = false;
              "
            >
              <Icon name="plus" :size="16" />添加模型服务
            </button>
          </div>
        </div>
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
          :disabled="!text.trim() || !ui.ready || ui.preparing"
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
    <div v-if="drafts.warnings[key]" class="draft-warning" role="alert">
      {{ drafts.warnings[key] }}
    </div>
    <div v-else-if="text || attachments.length" class="draft-status" role="status">
      <span>草稿已保存，可刷新恢复</span>
      <button type="button" class="text-button" :disabled="ui.preparing" @click="drafts.clear(key)">
        清空草稿
      </button>
    </div>
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
        ><button @click="input?.click()"><Icon name="attach" :size="14" />添加文件</button>
      </div>
      <span class="keyboard-hint">Enter 发送 · Shift Enter 换行</span>
    </div>
  </div>
</template>
