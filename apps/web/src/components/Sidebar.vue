<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import {
  ui,
  state,
  current,
  newChat,
  openConversation,
  createProject,
} from '../composables/workspace';
const projectInput = ref(false),
  name = ref('');
const chats = computed(() =>
  state.conversations
    .filter((c) => !c.archived && (!ui.projectId || c.projectId === ui.projectId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
);
async function add() {
  if (name.value.trim()) {
    await createProject(name.value.trim());
    name.value = '';
    projectInput.value = false;
  }
}
const settings = [
  { id: 'providers', name: '模型服务', icon: 'key' },
  { id: 'general', name: '常规', icon: 'sliders' },
  { id: 'appearance', name: '外观', icon: 'sun' },
  { id: 'projects', name: '项目管理', icon: 'folder' },
  { id: 'data', name: '数据与归档', icon: 'archive' },
  { id: 'about', name: '关于 ChatWorker', icon: 'idea' },
];
</script>
<template>
  <aside class="sidebar" :class="{ hidden: !ui.sidebar }">
    <div class="sidebar-heading">
      <button class="brand" @click="newChat">
        <span class="brand-symbol">W<span></span></span>ChatWorker</button
      ><button
        class="icon-button"
        title="收起侧栏"
        aria-label="收起侧栏"
        @click="ui.sidebar = false"
      >
        <Icon name="sidebar" :size="18" />
      </button>
    </div>
    <template v-if="ui.page === 'settings'"
      ><button class="sidebar-action back" @click="ui.page = 'chat'">
        <Icon name="left" />返回工作空间
      </button>
      <p class="section-label">个人设置</p>
      <button
        v-for="s in settings"
        :key="s.id"
        class="sidebar-action"
        :class="{ selected: ui.setting === s.id }"
        @click="ui.setting = s.id"
      >
        <Icon :name="s.icon" />{{ s.name }}
      </button></template
    >
    <template v-else>
      <button class="sidebar-action new-chat" @click="newChat">
        <Icon name="edit" />新会话<span class="shortcut">⌘ N</span>
      </button>
      <button class="sidebar-action" @click="ui.searchOpen = true">
        <Icon name="search" />搜索会话<span class="shortcut">⌘ K</span>
      </button>
      <div class="section-heading">
        <span>项目</span>
        <button
          class="icon-button small"
          aria-label="管理项目"
          title="管理项目"
          @click="
            ui.page = 'settings';
            ui.setting = 'projects';
          "
        >
          <Icon name="settings" :size="16" /></button
        ><button
          class="icon-button small"
          aria-label="创建项目"
          title="创建项目"
          @click="projectInput = !projectInput"
        >
          <Icon name="plus" :size="16" />
        </button>
      </div>
      <form v-if="projectInput" class="inline-form" @submit.prevent="add">
        <input
          v-model="name"
          autofocus
          placeholder="项目名称"
          maxlength="60"
          aria-label="项目名称"
        /><button class="icon-button" type="submit" aria-label="保存项目">
          <Icon name="check" :size="16" />
        </button>
      </form>
      <button
        class="sidebar-action project-row"
        :class="{ selected: !ui.projectId }"
        @click="
          ui.projectId = '';
          newChat();
        "
      >
        <Icon name="grid" :size="17" />所有会话<span class="count">{{
          state.conversations.filter((c) => !c.archived).length
        }}</span>
      </button>
      <button
        v-for="p in state.projects"
        :key="p.id"
        class="sidebar-action project-row"
        :class="{ selected: ui.projectId === p.id }"
        @click="
          ui.projectId = p.id;
          newChat();
        "
      >
        <Icon name="folder" :size="17" /><span class="truncate">{{ p.name }}</span>
      </button>
      <button v-if="!state.projects.length" class="empty-project" @click="projectInput = true">
        <Icon name="folderPlus" :size="16" />把想法整理成项目
      </button>
      <div class="section-heading recent-label">
        <span>最近会话</span><span class="tiny">{{ chats.length }}</span>
      </div>
      <div class="chat-list">
        <button
          v-for="c in chats"
          :key="c.id"
          class="chat-row"
          :class="{ selected: current?.id === c.id }"
          @click="openConversation(c)"
        >
          <span class="chat-title"
            >{{ c.title }}<span v-if="ui.busyId === c.id" class="live-dot"></span></span
          ><span class="chat-preview">{{
            c.messages
              .filter((m) => m.role === 'assistant')
              .at(-1)
              ?.content.replace(/[#*`\n]/g, '')
              .slice(0, 55) || '开始你的下一段探索'
          }}</span>
        </button>
        <div v-if="!chats.length" class="empty-list">
          <Icon name="chat" :size="23" />
          <p>好想法，从对话开始</p>
          <span>你的会话会保存在这里</span>
        </div>
      </div>
    </template>
    <div class="sidebar-footer">
      <span class="status-dot"></span><span>本地工作空间</span><span class="version">v0.1</span>
    </div>
  </aside>
</template>
