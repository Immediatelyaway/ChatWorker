<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import type { Citation } from '../../../../packages/contracts/library';
import { ui } from '../composables/workspace';
defineProps<{ citations: Citation[] }>();
const selected = ref<Citation>(),
  panel = ref<HTMLElement>();
watch(selected, async (value) => {
  if (value) {
    await nextTick();
    panel.value?.focus();
  }
});
</script>
<template>
  <section class="citations" aria-label="本次参考资料">
    <p>
      <Icon name="library" :size="14" />本次提供给模型的资料
      <span>{{ citations.length }} 个片段</span>
    </p>
    <div class="citation-cards">
      <button v-for="source in citations" :key="source.label" @click="selected = source">
        <span class="citation-number">{{ source.label }}</span
        ><span
          ><strong>{{ source.title }}</strong
          ><small>第 {{ source.startLine }}–{{ source.endLine }} 行</small></span
        ><Icon name="right" :size="14" />
      </button>
    </div>
    <small>片段用于辅助回答；模型的引用与结论仍需核对。</small>
    <div v-if="selected" class="modal-overlay" @click.self="selected = undefined">
      <section
        ref="panel"
        tabindex="-1"
        class="dialog citation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="引用原文"
        @keydown.esc="selected = undefined"
      >
        <header>
          <h2>[{{ selected.label }}] {{ selected.title }}</h2>
          <button class="icon-button" aria-label="关闭引用原文" @click="selected = undefined">
            <Icon name="x" />
          </button>
        </header>
        <p>第 {{ selected.startLine }}–{{ selected.endLine }} 行 · 本次请求保存的原文快照</p>
        <pre>{{ selected.text }}</pre>
        <button
          class="secondary-button"
          @click="
            ui.page = 'spaces';
            ui.spaceFilter = 'all';
          "
        >
          打开空间
        </button>
      </section>
    </div>
  </section>
</template>
