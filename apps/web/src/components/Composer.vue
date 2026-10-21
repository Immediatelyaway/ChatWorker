<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { ui, state, provider, send, cancel, preference, notify } from '../composables/workspace';
import type { Attachment } from '../../../../packages/shared/types';
const props = defineProps<{ suggestion?: string }>();
const text = ref(''),
  attachments = ref<Attachment[]>([]),
  input = ref<HTMLInputElement>(),
  picker = ref(false);
const available = computed(() => state.providers.filter((p) => p.configured));
async function submit() {
  const content = text.value.trim();
  if (!content || ui.busyId || ui.preparing) return;
  const old = text.value;
  const files = [...attachments.value];
  text.value = '';
  attachments.value = [];
  const ok = await send(content, files);
  if (!ok && !text.value) {
    text.value = old;
    attachments.value = files;
  }
}
function keydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
}
async function files(e: Event) {
  const list = Array.from((e.target as HTMLInputElement).files ?? []);
  for (const file of list) {
    if (attachments.value.length >= 5) {
      notify('最多添加 5 个文本附件');
      break;
    }
    if (file.size > 100000) {
      notify(`${file.name} 超过 100 KB`);
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
    attachments.value.push({ name: file.name, content });
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
          }}<button aria-label="移除附件" @click="attachments.splice(i, 1)">
            <Icon name="x" :size="13" /></button
        ></span>
      </div>
      <textarea
        v-model="text"
        aria-label="消息"
        :placeholder="ui.mode === 'work' ? '描述你的想法，让我们一起完成…' : '有什么想聊的？'"
        rows="3"
        maxlength="30000"
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
