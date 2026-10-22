<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';
import { createCapabilitiesClient } from '../composables/capabilities';
import type { FeatureId } from '../../../../packages/contracts/capabilities';
const client = createCapabilitiesClient();
const state = client.state;
const labels: Record<FeatureId, string> = {
  chat: '模型对话',
  attachments: '文本与代码附件',
  projects: '项目与会话整理',
  branches: '分支与重新生成',
  backups: '备份与导入',
  drafts: '输入草稿',
  library: '空间与资料检索',
  workspaceFiles: '项目文件工具',
  terminal: '终端与测试执行',
  runRecovery: '任务断点恢复',
  mcp: 'MCP 工具连接',
  multiAgent: '多智能体协作',
};
const statuses = { available: '可用', limited: '有限支持', unavailable: '尚未支持' };
const groups = computed(() => {
  if (!state.data) return [];
  const entries = (Object.keys(labels) as FeatureId[]).map((id) => ({
    id,
    label: labels[id],
    ...(state.data!.features[id] ?? {
      status: 'unavailable' as const,
      detail: '当前服务未提供此能力',
    }),
  }));
  return [
    { title: '当前功能', items: entries.filter((item) => item.status !== 'unavailable') },
    { title: '后续能力', items: entries.filter((item) => item.status === 'unavailable') },
  ].filter((group) => group.items.length);
});
onMounted(() => void client.load());
onUnmounted(client.dispose);
</script>

<template>
  <section class="capabilities-panel" aria-label="运行能力" :aria-busy="state.status === 'loading'">
    <div class="capabilities-heading">
      <h2>运行能力</h2>
      <button
        type="button"
        class="secondary-button"
        :disabled="state.status === 'loading'"
        @click="client.load"
      >
        <Icon v-if="state.status === 'loading'" name="loading" class="spin" :size="15" />
        {{
          state.status === 'loading'
            ? '读取中…'
            : state.status === 'error'
              ? '重试读取'
              : '刷新状态'
        }}
      </button>
    </div>
    <p class="fine-print">以下信息来自当前连接的服务，反映这个版本实际支持的范围。</p>
    <p v-if="state.status === 'loading'" class="capabilities-notice" role="status">
      正在读取运行信息…
    </p>
    <p v-if="state.status === 'error'" class="capabilities-notice" role="alert">
      {{ state.error }}
    </p>
    <template v-if="state.data">
      <div class="settings-card capabilities-summary">
        <div class="setting-row">
          <strong>应用版本</strong><span>{{ state.data.appVersion }}</span>
        </div>
        <div class="setting-row">
          <strong>运行方式</strong
          ><span
            >{{ state.data.environment === 'desktop' ? 'Electron 桌面版' : 'Web 版' }} ·
            本机服务</span
          >
        </div>
        <div class="setting-row">
          <div>
            <strong>会话保存</strong>
            <p>保存在本机数据库中，保存失败会明确提示，可以导出会话备份。</p>
          </div>
          <span>本机保存</span>
        </div>
        <div class="setting-row">
          <div>
            <strong>模型密钥</strong>
            <p>
              {{
                state.data.storage.keyPersistence === 'persistent'
                  ? '由本机凭据存储保存。'
                  : '界面输入的 Key 仅保留在服务内存中，重启后需要重填；环境变量配置单独生效。'
              }}
            </p>
          </div>
          <span>{{
            state.data.storage.keyPersistence === 'persistent' ? '可持久保存' : '仅当前服务'
          }}</span>
        </div>
      </div>
      <template v-for="group in groups" :key="group.title">
        <h3 class="setting-section-title">{{ group.title }}</h3>
        <div class="settings-card">
          <div v-for="item in group.items" :key="item.id" class="setting-row capability-row">
            <div>
              <strong>{{ item.label }}</strong>
              <p>{{ item.detail }}</p>
            </div>
            <span
              class="badge"
              :class="{
                green: item.status === 'available',
                'capability-limited': item.status === 'limited',
              }"
              >{{ statuses[item.status] }}</span
            >
          </div>
        </div>
      </template>
      <h3 class="setting-section-title">当前使用限制</h3>
      <div class="settings-card">
        <div class="setting-row">
          <strong>单条消息</strong
          ><span>最多 {{ state.data.limits.inputCharacters.toLocaleString('zh-CN') }} 字符</span>
        </div>
        <div class="setting-row">
          <strong>文本附件</strong
          ><span
            >每条 {{ state.data.limits.attachmentsPerMessage }} 个，每个
            {{ state.data.limits.attachmentFileBytes / 1000 }} KB</span
          >
        </div>
        <div class="setting-row">
          <strong>单次生成</strong
          ><span>最长 {{ state.data.limits.generationMilliseconds / 60_000 }} 分钟</span>
        </div>
        <div class="setting-row">
          <strong>备份文件</strong
          ><span>最多 {{ state.data.limits.backupBytes / 1024 / 1024 }} MiB</span>
        </div>
      </div>
      <details class="capabilities-formats">
        <summary>数据格式版本</summary>
        <p>
          能力接口 v{{ state.data.contractVersion }} · 会话数据 v{{
            state.data.storage.stateVersion
          }}
          · 数据库 v{{ state.data.storage.databaseVersion }} · 备份 v{{
            state.data.storage.backupVersion
          }}
          · 草稿 v{{ state.data.storage.draftVersion }}
        </p>
        <p>各格式独立演进，应用升级不一定改变数据格式。</p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.capabilities-panel {
  margin-top: 28px;
}
.capabilities-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.capabilities-heading h2 {
  font-size: 16px;
  font-weight: 550;
}
.capabilities-summary {
  margin-top: 18px;
}
.capabilities-notice {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  margin-top: 16px;
  font-size: 13px;
  line-height: 1.7;
}
.setting-row > div {
  min-width: 0;
}
.setting-row p {
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.setting-row > span {
  flex-shrink: 0;
}
.capability-row {
  align-items: flex-start;
}
.setting-row > .badge.green {
  color: #476b53;
}
.capability-limited {
  color: var(--text);
  background: var(--soft);
}
.capabilities-formats {
  margin-top: 24px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--muted);
}
.capabilities-formats summary {
  cursor: pointer;
  color: var(--text);
}
.capabilities-formats p {
  margin-top: 8px;
}
@media (max-width: 600px) {
  .setting-row {
    flex-wrap: wrap;
    gap: 8px;
  }
  .capability-row {
    flex-wrap: nowrap;
  }
  .settings-card {
    padding: 0 14px;
  }
}
</style>
