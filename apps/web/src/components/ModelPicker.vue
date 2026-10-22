<script setup lang="ts">
import { computed, ref, nextTick, onMounted, onUnmounted, watch } from 'vue';
import Icon from './Icon.vue';
import {
  state,
  provider,
  ui,
  preference,
  saveModelOptions,
  notify,
} from '../composables/workspace';
import {
  modelLabel,
  modelOptions,
  supportsThinking,
  effortLevels,
  type ModelOptions,
} from '../../../../packages/shared/model-catalog';
const open = ref(false),
  query = ref(''),
  saving = ref(false);
const root = ref<HTMLElement>(),
  trigger = ref<HTMLButtonElement>(),
  search = ref<HTMLInputElement>(),
  panel = ref<HTMLElement>();
const position = ref({ left: '0px', top: '0px' });
function place() {
  if (!trigger.value || !panel.value) return;
  const anchor = trigger.value.getBoundingClientRect(),
    bounds = panel.value.getBoundingClientRect();
  position.value = {
    left:
      Math.max(12, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 12)) +
      'px',
    top:
      Math.max(
        16,
        Math.min(anchor.top - bounds.height - 12, window.innerHeight - bounds.height - 16),
      ) + 'px',
  };
}
const selected = computed(() => state.preferences.model);
const options = computed(() =>
  provider.value ? modelOptions(provider.value, selected.value) : {},
);
const canThink = computed(
  () => !!provider.value && supportsThinking(provider.value, selected.value),
);
const effortIndex = computed(() =>
  effortLevels.findIndex((x) => x.value === (options.value.effort ?? 'high')),
);
const summary = computed(() =>
  !canThink.value
    ? ''
    : options.value.thinking === 'disabled'
      ? '直接回答'
      : effortLevels[effortIndex.value].label + '思考',
);
const groups = computed(() =>
  state.providers
    .filter((p) => p.configured)
    .map((p) => ({
      ...p,
      models: p.models.filter((m) =>
        (modelLabel(m) + m + p.name).toLowerCase().includes(query.value.toLowerCase()),
      ),
    }))
    .filter((p) => p.models.length),
);
async function toggle() {
  open.value = !open.value;
  if (open.value) {
    query.value = '';
    await nextTick();
    place();
    search.value?.focus();
  }
}
function close(restore = false) {
  open.value = false;
  if (restore) trigger.value?.focus();
}
function outside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node) && !panel.value?.contains(event.target as Node))
    close();
}
function escape(event: KeyboardEvent) {
  if (open.value && event.key === 'Escape') {
    event.stopPropagation();
    close(true);
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);
  window.addEventListener('resize', place);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('keydown', escape);
  window.removeEventListener('resize', place);
});
watch([selected, () => options.value.thinking, query], async () => {
  await nextTick();
  place();
});
async function choose(id: string, model: string) {
  await preference({ providerId: id, model });
}
async function configure(patch: ModelOptions) {
  if (!provider.value || saving.value) return;
  const id = provider.value.id,
    model = selected.value;
  saving.value = true;
  try {
    await saveModelOptions(id, model, { ...options.value, ...patch });
  } catch (error) {
    notify((error as Error).message);
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <div ref="root" class="model-picker">
    <button
      ref="trigger"
      class="model-trigger"
      aria-label="选择模型"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="model-dot"></span><span>{{ modelLabel(selected) || '选择模型' }}</span
      ><span v-if="summary" class="model-summary">{{ summary }}</span
      ><Icon name="down" :size="13" />
    </button>
    <Teleport to="body"
      ><Transition name="popover">
        <div
          v-if="open"
          ref="panel"
          :style="position"
          class="model-panel popover"
          role="dialog"
          aria-label="模型与思考设置"
        >
          <div class="model-panel-heading">
            <strong>选择模型</strong
            ><button class="icon-button" aria-label="关闭模型选择" @click="close(true)">
              <Icon name="x" :size="16" />
            </button>
          </div>
          <label class="model-search"
            ><Icon name="search" :size="16" /><input
              ref="search"
              v-model="query"
              aria-label="搜索模型"
              placeholder="搜索模型或服务…"
          /></label>
          <div class="model-list">
            <p v-if="!groups.length" class="muted model-empty">没有匹配的已配置模型</p>
            <section v-for="p in groups" :key="p.id" class="model-group">
              <p>{{ p.name }}</p>
              <button
                v-for="model in p.models"
                :key="model"
                class="model-choice"
                :class="{ selected: provider?.id === p.id && selected === model }"
                :aria-pressed="provider?.id === p.id && selected === model"
                @click="choose(p.id, model)"
              >
                <span
                  ><strong>{{ modelLabel(model) }}</strong
                  ><small>{{ model }}</small></span
                ><Icon v-if="provider?.id === p.id && selected === model" name="check" :size="17" />
              </button>
            </section>
          </div>
          <div v-if="canThink" class="thinking-controls" :aria-busy="saving">
            <div class="thinking-heading">
              <span><Icon name="sparkles" :size="16" />思考方式</span
              ><small>{{ saving ? '保存中…' : '按模型记住' }}</small>
            </div>
            <div class="thinking-segments" role="group" aria-label="思考模式">
              <button
                v-for="mode in [
                  { value: 'default', label: '自动' },
                  { value: 'disabled', label: '直接回答' },
                  { value: 'enabled', label: '思考' },
                ] as const"
                :key="mode.value"
                :disabled="saving"
                :aria-pressed="(options.thinking ?? 'default') === mode.value"
                @click="configure({ thinking: mode.value })"
              >
                {{ mode.label }}
              </button>
            </div>
            <div v-if="options.thinking !== 'disabled'" class="effort-control">
              <div>
                <strong>{{ effortLevels[effortIndex].label }}</strong
                ><small>{{ effortLevels[effortIndex].description }}</small>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="1"
                :value="effortIndex"
                :disabled="saving"
                aria-label="思考强度"
                :aria-valuetext="effortLevels[effortIndex].label"
                :style="{ '--range-fill': `${effortIndex * 50}%` }"
                @change="
                  configure({
                    effort: effortLevels[Number(($event.target as HTMLInputElement).value)].value,
                  })
                "
              />
              <div class="effort-labels"><span>轻量</span><span>深入</span><span>充分</span></div>
            </div>
            <p class="model-footnote">只影响之后的请求。更充分的思考可能增加耗时与用量。</p>
          </div>
          <p v-else class="model-footnote model-default-note">此模型使用服务默认参数。</p>
          <button
            class="model-configure"
            @click="
              ui.page = 'settings';
              ui.setting = 'providers';
              close();
            "
          >
            <Icon name="plus" :size="16" />管理模型服务<Icon name="right" :size="14" />
          </button>
        </div> </Transition
    ></Teleport>
  </div>
</template>
