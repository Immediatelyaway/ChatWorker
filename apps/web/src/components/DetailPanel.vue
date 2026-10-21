<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import { current, ui, state, exportConversation } from '../composables/workspace';
const tab = ref('activity');
const files = computed(() => current.value?.messages.flatMap((m) => m.attachments ?? []) ?? []);
const project = computed(() => state.projects.find((p) => p.id === current.value?.projectId));
</script>
<template>
  <aside class="detail-panel">
    <div class="detail-heading">
      <strong>会话详情</strong
      ><button class="icon-button" aria-label="关闭详情" @click="ui.details = false">
        <Icon name="x" :size="17" />
      </button>
    </div>
    <div class="detail-summary">
      <div class="detail-project">
        <Icon name="folder" :size="17" />{{ project?.name ?? '独立会话' }}
      </div>
      <h3>{{ current?.title ?? '从一个想法开始' }}</h3>
      <span
        >{{ current?.messages.length ?? 0 }} 条消息 ·
        {{ current?.mode === 'work' ? '工作模式' : '聊天模式' }}</span
      >
    </div>
    <div class="detail-tabs">
      <button :class="{ active: tab === 'activity' }" @click="tab = 'activity'">活动</button
      ><button :class="{ active: tab === 'files' }" @click="tab = 'files'">
        文件 <span>{{ files.length }}</span>
      </button>
    </div>
    <div v-if="tab === 'activity'" class="timeline">
      <div v-for="a in current?.activities ?? []" :key="a.id" class="timeline-item">
        <i></i>
        <div>
          <p>{{ a.label }}</p>
          <time>{{
            new Date(a.at).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
          }}</time>
        </div>
      </div>
      <div v-if="!current?.activities.length" class="panel-empty">
        <Icon name="activity" :size="25" />
        <p>执行过程，在这里看见</p>
        <span>发送消息后显示真实活动记录。</span>
      </div>
    </div>
    <div v-else class="detail-files">
      <details v-for="(f, i) in files" :key="i">
        <summary><Icon name="file" :size="16" />{{ f.name }}</summary>
        <pre>{{ f.content }}</pre>
      </details>
      <p v-if="!files.length" class="muted">通过输入框添加文本或代码文件。</p>
    </div>
    <button
      class="secondary-button export-button"
      :disabled="!current?.messages.length"
      @click="exportConversation"
    >
      <Icon name="download" :size="16" />导出会话 Markdown
    </button>
  </aside>
</template>
