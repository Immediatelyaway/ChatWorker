<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Project } from '../../../../packages/shared/types';
import { api, load, notify, state, ui } from '../composables/workspace';
const editing = ref(false),
  editingId = ref(''),
  name = ref(''),
  description = ref('');
const deleting = ref<Project>();
const busy = ref(false),
  error = ref('');
const count = computed(
  () => state.conversations.filter((c) => c.projectId === deleting.value?.id).length,
);
function edit(project?: Project) {
  editingId.value = project?.id ?? '';
  name.value = project?.name ?? '';
  description.value = project?.description ?? '';
  editing.value = true;
  error.value = '';
}
async function save() {
  busy.value = true;
  error.value = '';
  try {
    const p = await api<Project>(
      editingId.value ? `/projects/${editingId.value}` : '/projects',
      editingId.value ? 'PATCH' : 'POST',
      {
        name: name.value.trim(),
        description: description.value,
      },
    );
    const index = state.projects.findIndex((project) => project.id === p.id);
    if (index >= 0) state.projects[index] = p;
    else state.projects.push(p);
    editing.value = false;
    notify('项目已保存');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!deleting.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api(`/projects/${deleting.value.id}`, 'DELETE');
    if (ui.projectId === deleting.value.id) ui.projectId = '';
    await load();
    deleting.value = undefined;
    notify('项目已删除，会话已保留为独立会话');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <p class="settings-description">
    整理项目名称和说明，让相关对话各归其位。项目目前用于分组，不绑定本地文件夹。
  </p>
  <button class="primary-button" @click="edit()">创建项目</button>
  <div class="settings-card project-list">
    <p v-if="!state.projects.length" class="muted">还没有项目，创建一个来整理你的对话。</p>
    <div v-for="p in state.projects" :key="p.id" class="setting-row">
      <div class="project-description">
        <strong>{{ p.name }}</strong>
        <p>{{ p.description || '暂无说明' }}</p>
        <small
          >{{
            state.conversations.filter((c) => c.projectId === p.id).length
          }}
          个会话（含归档）</small
        >
      </div>
      <div class="project-actions">
        <button class="secondary-button" :aria-label="`编辑项目 ${p.name}`" @click="edit(p)">
          编辑
        </button>
        <button
          class="text-button danger"
          :aria-label="`删除项目 ${p.name}`"
          @click="
            deleting = p;
            error = '';
          "
        >
          删除
        </button>
      </div>
    </div>
  </div>
  <div v-if="editing" class="modal-overlay" @click.self="!busy && (editing = false)">
    <form
      class="dialog project-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-title"
      @submit.prevent="save"
    >
      <h2 id="project-title">{{ editingId ? '编辑项目' : '创建项目' }}</h2>
      <label
        >项目名称<input v-model="name" required maxlength="60" autofocus :disabled="busy"
      /></label>
      <label
        >项目说明<textarea
          v-model="description"
          rows="4"
          maxlength="500"
          :disabled="busy"
          placeholder="记录项目目标或范围，仅用于整理，不作为模型指令。"
        ></textarea>
      </label>
      <p v-if="error" role="alert" class="danger">{{ error }}</p>
      <div class="form-actions">
        <button type="button" class="secondary-button" :disabled="busy" @click="editing = false">
          取消</button
        ><button class="primary-button" :disabled="busy || !name.trim()">
          {{ busy ? '保存中…' : '保存项目' }}
        </button>
      </div>
    </form>
  </div>
  <div v-if="deleting" class="modal-overlay" @click.self="!busy && (deleting = undefined)">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="project-delete-title">
      <h2 id="project-delete-title">删除项目「{{ deleting.name }}」？</h2>
      <p>项目分组及说明会被删除。{{ count }} 个会话（含归档）、消息和附件将保留为独立会话。</p>
      <p v-if="error" role="alert" class="danger">{{ error }}</p>
      <div class="form-actions">
        <button class="secondary-button" :disabled="busy" @click="deleting = undefined">取消</button
        ><button class="primary-button destructive" :disabled="busy" @click="remove">
          {{ busy ? '处理中…' : '删除项目，保留会话' }}
        </button>
      </div>
    </div>
  </div>
</template>
