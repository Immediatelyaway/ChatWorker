<script setup lang="ts">
import { ref } from 'vue';
import { api, load, notify, ui } from '../composables/workspace';
const busy = ref(false);
const input = ref<HTMLInputElement>();
const pending = ref<unknown>();
const preview = ref<{
  projects: number;
  conversations: number;
  messages: number;
  exportedAt: string;
}>();
const error = ref('');
async function download() {
  busy.value = true;
  error.value = '';
  try {
    const backup = await api('/backups');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `ChatWorker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('备份已导出');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function select(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (input.value) input.value.value = '';
  if (!file) return;
  busy.value = true;
  error.value = '';
  pending.value = undefined;
  preview.value = undefined;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('备份文件不能超过 20 MB');
    const data = JSON.parse(await file.text());
    preview.value = await api('/backups/preview', 'POST', data);
    pending.value = data;
  } catch (e) {
    error.value = e instanceof SyntaxError ? '文件不是有效的 JSON 备份' : (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function restore() {
  busy.value = true;
  error.value = '';
  try {
    await api('/backups/import', 'POST', pending.value);
    preview.value = undefined;
    pending.value = undefined;
    await load();
    notify('备份已导入，现有会话和模型配置保持不变');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <h2 class="setting-section-title">备份与迁移</h2>
  <div class="settings-card">
    <div class="setting-row">
      <div>
        <strong>导出完整会话备份</strong>
        <p>包含项目、消息和文本附件。备份为明文，不包含模型配置或 API Key。</p>
      </div>
      <button class="secondary-button" :disabled="busy || !!ui.busyId" @click="download">
        导出备份
      </button>
    </div>
    <div class="setting-row">
      <div>
        <strong>从备份导入</strong>
        <p>支持 Web 与桌面版迁移，文件最大 20 MB。</p>
      </div>
      <input
        ref="input"
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="选择备份文件"
        @change="select"
      />
      <button class="secondary-button" :disabled="busy || !!ui.busyId" @click="input?.click()">
        选择备份
      </button>
    </div>
    <p v-if="ui.busyId" class="fine-print">请先停止生成或等待回复完成。</p>
    <p v-if="error" role="alert" class="danger">{{ error }}</p>
    <div v-if="preview" class="backup-preview">
      <h3>确认导入</h3>
      <p>
        {{ preview.projects }} 个项目 · {{ preview.conversations }} 个会话 ·
        {{ preview.messages }} 条消息
      </p>
      <p class="fine-print">备份时间：{{ new Date(preview.exportedAt).toLocaleString() }}</p>
      <p>将添加为独立副本，保留现有数据。重复导入会产生重复副本；模型连接仍使用本机配置。</p>
      <div class="form-actions">
        <button
          class="secondary-button"
          :disabled="busy"
          @click="
            preview = undefined;
            pending = undefined;
          "
        >
          取消
        </button>
        <button class="primary-button" :disabled="busy || !!ui.busyId" @click="restore">
          {{ busy ? '导入中…' : '确认添加副本' }}
        </button>
      </div>
    </div>
  </div>
</template>
