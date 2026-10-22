<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch, ref } from 'vue';
import Icon from './components/Icon.vue';
import Sidebar from './components/Sidebar.vue';
import ChatView from './components/ChatView.vue';
import SpacesView from './components/SpacesView.vue';
import SettingsView from './components/SettingsView.vue';
import DetailPanel from './components/DetailPanel.vue';
import {
  ui,
  state,
  current,
  load,
  newChat,
  openConversation,
  updateConversation,
  exportConversation,
} from './composables/workspace';
const menu = ref(false),
  rename = ref(false),
  title = ref('');
const results = computed(() =>
  state.conversations.filter(
    (c) =>
      !c.archived &&
      (c.title + ' ' + c.messages.map((m) => m.content).join(' '))
        .toLowerCase()
        .includes(ui.search.toLowerCase()),
  ),
);
const projectName = computed(
  () => state.projects.find((p) => p.id === ui.projectId)?.name ?? '工作空间',
);
const scheme = window.matchMedia('(prefers-color-scheme: dark)');
function theme() {
  document.documentElement.dataset.theme =
    state.preferences.theme === 'system'
      ? scheme.matches
        ? 'dark'
        : 'light'
      : state.preferences.theme;
}
watch(() => state.preferences.theme, theme);
function keys(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    settings();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    ui.searchOpen = !ui.searchOpen;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newChat();
  }
  if (e.key === 'Escape') {
    ui.searchOpen = false;
    ui.profileOpen = false;
    menu.value = false;
    rename.value = false;
  }
}
onMounted(() => {
  void load();
  window.addEventListener('keydown', keys);
  scheme.addEventListener('change', theme);
});
onUnmounted(() => {
  window.removeEventListener('keydown', keys);
  scheme.removeEventListener('change', theme);
});
function settings() {
  ui.page = 'settings';
  ui.setting = 'providers';
  ui.profileOpen = false;
}
</script>
<template>
  <div class="app-shell">
    <nav class="rail" aria-label="主导航">
      <button class="rail-logo" title="ChatWorker" aria-label="ChatWorker 首页" @click="newChat">
        w<span></span>
      </button>
      <div class="rail-divider"></div>
      <button
        class="rail-button"
        :class="{ active: ui.page === 'chat' }"
        title="工作空间"
        aria-label="工作空间"
        @click="ui.page = 'chat'"
      >
        <Icon name="home" :size="21" /></button
      ><button
        class="rail-button"
        :class="{ active: ui.page === 'spaces' }"
        title="空间"
        aria-label="空间"
        @click="ui.page = 'spaces'"
      >
        <Icon name="library" :size="21" /></button
      ><button
        class="rail-button"
        title="搜索会话"
        aria-label="搜索会话"
        @click="ui.searchOpen = true"
      >
        <Icon name="search" :size="21" /></button
      ><button
        class="rail-button"
        title="归档会话"
        aria-label="归档会话"
        @click="
          ui.page = 'settings';
          ui.setting = 'data';
        "
      >
        <Icon name="archive" :size="21" />
      </button>
      <div class="rail-spacer"></div>
      <button
        class="rail-button"
        :class="{ active: ui.page === 'settings' }"
        title="设置"
        aria-label="设置"
        @click="settings"
      >
        <Icon name="settings" :size="21" /></button
      ><button
        class="avatar"
        title="个人菜单"
        aria-label="个人菜单"
        @click="ui.profileOpen = !ui.profileOpen"
      >
        K
      </button>
    </nav>
    <Sidebar />
    <main class="main-panel">
      <header class="topbar">
        <div class="topbar-left">
          <button
            v-if="!ui.sidebar"
            class="icon-button"
            aria-label="展开侧栏"
            @click="ui.sidebar = true"
          >
            <Icon name="sidebar" /></button
          ><template v-if="ui.page === 'chat'"
            ><span class="breadcrumb">{{ projectName }}</span
            ><Icon name="right" :size="13" /><span class="top-title truncate">{{
              current?.title ?? '新会话'
            }}</span></template
          ><span v-else-if="ui.page === 'spaces'" class="breadcrumb"
            >空间 <span class="breadcrumb-slash">/</span> 我的资料</span
          ><span v-else class="breadcrumb"
            >设置 <span class="breadcrumb-slash">/</span> 偏好与连接</span
          >
        </div>
        <div v-if="ui.page === 'chat' && !current?.messages.length" class="mode-switch">
          <button :class="{ active: ui.mode === 'chat' }" @click="ui.mode = 'chat'">
            <Icon name="chat" :size="14" />聊天</button
          ><button :class="{ active: ui.mode === 'work' }" @click="ui.mode = 'work'">
            <Icon name="checks" :size="14" />工作
          </button>
        </div>
        <div class="top-actions">
          <span v-if="state.preferences.providerId === 'demo'" class="demo-badge"
            ><span></span>演示模式</span
          ><button
            v-if="ui.page === 'chat'"
            class="icon-button"
            :class="{ toggled: ui.details }"
            aria-label="会话详情"
            title="会话详情"
            @click="ui.details = !ui.details"
          >
            <Icon name="details" />
          </button>
          <div class="menu-anchor">
            <button
              class="icon-button"
              aria-label="会话菜单"
              title="会话菜单"
              @click="menu = !menu"
            >
              <Icon name="more" />
            </button>
            <div v-if="menu" class="popover conversation-menu">
              <button
                @click="
                  newChat();
                  menu = false;
                "
              >
                <Icon name="edit" :size="16" />新会话</button
              ><button
                @click="
                  ui.searchOpen = true;
                  menu = false;
                "
              >
                <Icon name="search" :size="16" />搜索会话</button
              ><button
                @click="
                  ui.page = 'spaces';
                  menu = false;
                "
              >
                <Icon name="library" :size="16" />空间</button
              ><button
                @click="
                  settings();
                  menu = false;
                "
              >
                <Icon name="settings" :size="16" />设置</button
              ><button
                :disabled="!current || !!ui.busyId"
                @click="
                  title = current?.title ?? '';
                  rename = true;
                  menu = false;
                "
              >
                <Icon name="pencil" :size="16" />重命名</button
              ><button
                :disabled="!current || !!ui.busyId"
                @click="
                  current && updateConversation(current.id, { archived: true });
                  menu = false;
                "
              >
                <Icon name="archive" :size="16" />归档会话</button
              ><button
                :disabled="!current"
                @click="
                  exportConversation();
                  menu = false;
                "
              >
                <Icon name="download" :size="16" />导出 Markdown
              </button>
            </div>
          </div>
        </div>
      </header>
      <div class="main-content">
        <SpacesView v-if="ui.page === 'spaces'" /><SettingsView
          v-else-if="ui.page === 'settings'"
        /><ChatView v-else /><DetailPanel v-if="ui.details && ui.page === 'chat'" />
      </div>
    </main>
    <div v-if="ui.profileOpen" class="popover profile-menu">
      <div class="profile-identity">
        <span class="avatar">K</span>
        <div><strong>我的工作空间</strong><small>个人 · 本地版</small></div>
      </div>
      <button @click="settings"><Icon name="settings" :size="17" />设置<span>⌘ ,</span></button
      ><button
        @click="
          ui.page = 'settings';
          ui.setting = 'data';
          ui.profileOpen = false;
        "
      >
        <Icon name="archive" :size="17" />数据与归档</button
      ><button
        @click="
          ui.page = 'settings';
          ui.setting = 'about';
          ui.profileOpen = false;
        "
      >
        <Icon name="idea" :size="17" />关于 ChatWorker
      </button>
    </div>
    <div v-if="ui.toast" class="toast" role="status">
      <Icon name="check" :size="17" />{{ ui.toast }}
    </div>
    <div v-if="ui.searchOpen" class="modal-overlay" @click.self="ui.searchOpen = false">
      <div class="search-dialog" role="dialog" aria-modal="true" aria-label="搜索会话">
        <div class="search-input">
          <Icon name="search" /><input
            v-model="ui.search"
            placeholder="搜索标题或消息内容…"
            aria-label="搜索内容"
            autofocus
          /><button class="icon-button" aria-label="关闭搜索" @click="ui.searchOpen = false">
            <kbd>Esc</kbd>
          </button>
        </div>
        <div class="search-results">
          <button v-for="c in results" :key="c.id" @click="openConversation(c)">
            <Icon name="chat" :size="18" />
            <div>
              <strong>{{ c.title }}</strong
              ><small
                >{{ new Date(c.updatedAt).toLocaleDateString('zh-CN') }} ·
                {{ c.mode === 'work' ? '工作' : '聊天' }}</small
              >
            </div>
            <Icon name="right" :size="15" />
          </button>
          <p v-if="!results.length" class="muted">没有找到匹配的会话。</p>
        </div>
      </div>
    </div>
    <div v-if="rename" class="modal-overlay" @click.self="rename = false">
      <form
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="重命名会话"
        @submit.prevent="
          current && updateConversation(current.id, { title });
          rename = false;
        "
      >
        <h2>重命名会话</h2>
        <input v-model="title" required maxlength="100" aria-label="会话名称" autofocus />
        <div class="form-actions">
          <button type="button" class="secondary-button" @click="rename = false">取消</button
          ><button class="primary-button">保存</button>
        </div>
      </form>
    </div>
  </div>
</template>
