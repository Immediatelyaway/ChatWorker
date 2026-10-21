<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import Icon from './Icon.vue';
import BackupPanel from './BackupPanel.vue';
import ProjectManager from './ProjectManager.vue';
import {
  ui,
  state,
  preference,
  saveProvider,
  api,
  notify,
  updateConversation,
  deleteConversation,
  openConversation,
} from '../composables/workspace';
import type { Protocol } from '../../../../packages/shared/types';
const selected = ref('openai'),
  baseUrl = ref(''),
  models = ref(''),
  protocol = ref<Protocol>('responses'),
  apiKey = ref(''),
  saving = ref(false),
  testing = ref(false),
  system = ref(''),
  deleteId = ref('');
const chosen = computed(() => state.providers.find((p) => p.id === selected.value));
watch(
  [selected, () => state.providers],
  () => {
    baseUrl.value = chosen.value?.baseUrl ?? '';
    models.value = chosen.value?.models.join(', ') ?? '';
    protocol.value = chosen.value?.protocol ?? 'openai';
    apiKey.value = '';
  },
  { immediate: true, deep: true },
);
watch(
  () => state.preferences.systemPrompt,
  (value) => (system.value = value),
  { immediate: true },
);
async function save() {
  saving.value = true;
  try {
    const list = models.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await saveProvider(selected.value, {
      baseUrl: baseUrl.value.trim(),
      protocol: protocol.value,
      models: list,
      ...(apiKey.value ? { apiKey: apiKey.value } : {}),
    });
    await preference({ providerId: selected.value, model: list[0] });
    apiKey.value = '';
    notify('已保存并设为当前模型');
  } catch (e) {
    notify((e as Error).message);
  } finally {
    saving.value = false;
  }
}
async function test() {
  testing.value = true;
  try {
    await api(`/providers/${selected.value}/test`, 'POST', { model: chosen.value?.models[0] });
    notify('连接成功，模型已返回响应');
  } catch (e) {
    notify((e as Error).message);
  } finally {
    testing.value = false;
  }
}
async function clearKey() {
  try {
    const result = await api(`/providers/${selected.value}/key`, 'DELETE');
    if (chosen.value) chosen.value.configured = result.configured;
    notify(result.configured ? '已清除保存的 Key，环境变量仍然有效' : 'API Key 已清除');
  } catch (e) {
    notify((e as Error).message);
  }
}
const titles: Record<string, string> = {
  providers: '模型服务',
  general: '常规',
  appearance: '外观',
  data: '数据与归档',
  projects: '项目管理',
  about: '关于 ChatWorker',
};
</script>
<template>
  <section class="settings-scroll">
    <div class="settings-content">
      <div class="eyebrow">让工作空间适合你</div>
      <h1>{{ titles[ui.setting] }}</h1>
      <template v-if="ui.setting === 'providers'"
        ><p class="settings-description">连接你喜欢的模型。一个工作空间，多种思考方式。</p>
        <div class="provider-tabs">
          <button
            v-for="p in state.providers.filter((p) => p.id !== 'demo')"
            :key="p.id"
            :class="{ active: selected === p.id }"
            @click="selected = p.id"
          >
            <span class="provider-letter" :class="p.id">{{
              p.id === 'anthropic'
                ? 'A'
                : p.id === 'gemini'
                  ? '✦'
                  : p.id === 'deepseek'
                    ? 'D'
                    : p.id === 'custom'
                      ? '+'
                      : 'O'
            }}</span
            >{{ p.name }}<span v-if="p.configured" class="status-dot"></span>
          </button>
        </div>
        <form class="settings-card provider-form" @submit.prevent="save">
          <div class="card-title">
            <div>
              <h2>{{ chosen?.name }}</h2>
              <p>
                {{ chosen?.configured ? '已配置，可以发送消息' : '填写连接信息，开始真实对话' }}
              </p>
            </div>
            <span class="badge" :class="{ green: chosen?.configured }">{{
              chosen?.configured ? '已配置' : '待连接'
            }}</span>
          </div>
          <label
            >接口协议<select v-model="protocol">
              <option value="responses">OpenAI Responses</option>
              <option value="openai">OpenAI Chat Completions 兼容</option>
              <option value="anthropic">Anthropic Messages</option>
            </select></label
          ><label
            >Base URL<input
              v-model="baseUrl"
              type="url"
              placeholder="https://api.example.com/v1"
              required
            /><small>填写接口根地址，不包含 /chat/completions 或 /messages。</small></label
          ><label
            >API Key
            <div class="key-field">
              <Icon name="key" :size="16" /><input
                v-model="apiKey"
                type="password"
                autocomplete="new-password"
                :placeholder="chosen?.configured ? '已配置 · 留空保持不变' : '输入你的 API Key'"
                spellcheck="false"
              />
            </div>
            <small>{{
              ui.runtime.persistentKeys
                ? 'Key 由桌面端使用系统加密能力保存在本机。'
                : 'Key 仅保留在本地服务内存中，重启服务后需重新填写。'
            }}</small></label
          ><label
            >模型 ID<input
              v-model="models"
              placeholder="填写账户可用的模型 ID，多个用英文逗号分隔"
              required
            /><small>按供应商控制台填写；模型可用性由你的 API 账户决定。</small></label
          >
          <div class="form-actions">
            <button
              v-if="chosen?.configured"
              type="button"
              class="text-button danger"
              @click="clearKey"
            >
              清除 Key</button
            ><span class="spacer"></span
            ><button
              type="button"
              class="secondary-button"
              :disabled="!chosen?.configured || testing || saving"
              @click="test"
            >
              <Icon v-if="testing" name="loading" class="spin" :size="15" />{{
                testing ? '连接中…' : '测试已保存配置'
              }}</button
            ><button class="primary-button" :disabled="saving">
              {{ saving ? '保存中…' : '保存并使用' }}
            </button>
          </div>
          <p class="fine-print">连接测试会发送一条简短请求，可能产生少量 API 费用。</p>
        </form>
        <div class="info-card">
          <Icon name="shield" :size="20" />
          <div>
            <strong>你的模型，你来选择</strong>
            <p>Key 不写入聊天记录，也不存入浏览器。你发送的消息与附件会交给选定的模型服务处理。</p>
          </div>
        </div>
        <button
          class="text-button demo-link"
          @click="
            preference({ providerId: 'demo', model: '本地演示' });
            notify('已切换到本地演示');
          "
        >
          暂不连接，使用本地演示 <Icon name="arrow" :size="15" /></button
      ></template>
      <template v-if="ui.setting === 'general'"
        ><p class="settings-description">调整助手的表达方式，让每一次协作更顺手。</p>
        <div class="settings-card">
          <div class="setting-row">
            <div>
              <strong>工作空间</strong>
              <p>会话与项目保存在运行服务的这台电脑。</p>
            </div>
            <span class="badge">本地模式</span>
          </div>
          <div class="setting-row">
            <div>
              <strong>界面语言</strong>
              <p>当前版本使用简体中文。</p>
            </div>
            <span>简体中文</span>
          </div>
          <div class="setting-row">
            <div>
              <strong>发送快捷键</strong>
              <p>Shift + Enter 换行</p>
            </div>
            <kbd>Enter</kbd>
          </div>
        </div>
        <h2 class="setting-section-title">助手指令</h2>
        <div class="settings-card">
          <label class="system-label"
            >为所有新请求提供默认指令<textarea
              v-model="system"
              rows="6"
              maxlength="8000"
            ></textarea>
          </label>
          <div class="form-actions">
            <span class="spacer"></span
            ><button
              class="primary-button"
              @click="
                preference({ systemPrompt: system });
                notify('助手指令已保存');
              "
            >
              保存指令
            </button>
          </div>
        </div></template
      >
      <template v-if="ui.setting === 'appearance'"
        ><p class="settings-description">选择一个让你专注的界面。</p>
        <div class="theme-grid">
          <button
            v-for="t in [
              { id: 'light', name: '浅色', icon: 'sun' },
              { id: 'dark', name: '深色', icon: 'moon' },
              { id: 'system', name: '跟随系统', icon: 'monitor' },
            ] as const"
            :key="t.id"
            :class="{ active: state.preferences.theme === t.id }"
            @click="preference({ theme: t.id })"
          >
            <div class="theme-preview" :class="t.id">
              <i></i>
              <div><b></b><span></span><span></span></div>
            </div>
            <p>
              <Icon :name="t.icon" :size="17" />{{ t.name
              }}<Icon v-if="state.preferences.theme === t.id" name="check" :size="17" />
            </p>
          </button></div
      ></template>
      <ProjectManager v-if="ui.setting === 'projects'" />
      <template v-if="ui.setting === 'data'"
        ><p class="settings-description">让重要的对话留得下来，也能随时重新开始。</p>
        <div class="settings-card">
          <div class="setting-row">
            <div>
              <strong>本地数据</strong>
              <p>{{ state.conversations.length }} 个会话 · {{ state.projects.length }} 个项目</p>
            </div>
            <span class="badge">本机保存</span>
          </div>
        </div>
        <BackupPanel />
        <h2 class="setting-section-title">已归档的会话</h2>
        <div class="settings-card">
          <p v-if="!state.conversations.some((c) => c.archived)" class="muted empty-archive">
            还没有归档会话。
          </p>
          <div
            v-for="c in state.conversations.filter((c) => c.archived)"
            :key="c.id"
            class="setting-row"
          >
            <button class="text-button truncate" @click="openConversation(c)">{{ c.title }}</button
            ><button
              class="secondary-button"
              @click="updateConversation(c.id, { archived: false })"
            >
              恢复
            </button>
          </div>
        </div>
        <h2 class="setting-section-title">管理会话</h2>
        <div class="settings-card">
          <div v-for="c in state.conversations" :key="c.id" class="setting-row">
            <span class="truncate">{{ c.title }}</span
            ><button
              class="icon-button danger"
              aria-label="删除会话"
              title="删除会话"
              @click="deleteId = c.id"
            >
              <Icon name="trash" :size="17" />
            </button>
          </div>
          <p v-if="!state.conversations.length" class="muted empty-archive">暂无会话数据。</p>
        </div></template
      >
      <template v-if="ui.setting === 'about'"
        ><div class="about-mark">W<span></span></div>
        <h2>从想法，到下一步。</h2>
        <p class="settings-description">
          ChatWorker 是一个以学习和日常协作为目标的个人 AI 工作空间。Web 与 Electron
          桌面版共享同一套 Vue 界面。
        </p>
        <div class="settings-card">
          <div class="setting-row"><strong>版本</strong><span>0.1.0 · MVP</span></div>
          <div class="setting-row">
            <strong>技术栈</strong><span>Vue 3 / TypeScript / Electron</span>
          </div>
          <div class="setting-row">
            <strong>当前能力</strong><span>聊天、附件、项目与模型配置</span>
          </div>
        </div>
        <p class="fine-print">
          设计借鉴编程助手的会话与工作流思路。当前版本不含终端执行、文件编辑、MCP 和多 Agent 编排。
        </p></template
      >
    </div>
  </section>
  <div v-if="deleteId" class="modal-overlay" @click.self="deleteId = ''">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <h2 id="delete-title">删除这个会话？</h2>
      <p>消息和附件内容将从本机记录中删除，无法撤销。</p>
      <div class="form-actions">
        <button class="secondary-button" @click="deleteId = ''">取消</button
        ><button
          class="primary-button destructive"
          @click="
            deleteConversation(deleteId);
            deleteId = '';
          "
        >
          删除会话
        </button>
      </div>
    </div>
  </div>
</template>
