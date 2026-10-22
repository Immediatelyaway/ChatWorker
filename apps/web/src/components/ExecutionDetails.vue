<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';
import type { Message } from '../../../../packages/shared/types';
const props = defineProps<{ message: Message }>();
const execution = computed(() => props.message.execution);
const active = computed(() =>
  execution.value?.events
    .slice()
    .reverse()
    .find((e) => e.status === 'running'),
);
const label = computed(() =>
  props.message.status === 'streaming'
    ? (active.value?.label ?? '等待模型响应')
    : props.message.status === 'failed'
      ? '本次执行未完成'
      : props.message.status === 'cancelled'
        ? '本次执行已停止'
        : '查看执行过程',
);
const icons: Record<string, string> = {
  context: 'file',
  connection: 'globe',
  reasoning: 'sparkles',
  response: 'chat',
  tool: 'code',
  search: 'search',
  completion: 'checks',
  error: 'info',
};
</script>
<template>
  <details v-if="execution?.events.length || execution?.reasoning" class="execution-details">
    <summary>
      <Icon
        :name="message.status === 'streaming' ? 'loading' : 'activity'"
        :class="{ spin: message.status === 'streaming' }"
        :size="16"
      /><span>{{ label }}</span
      ><small v-if="execution?.durationMs !== undefined"
        >{{ (execution.durationMs / 1000).toFixed(1) }} 秒</small
      ><Icon class="disclosure-arrow" name="right" :size="14" />
    </summary>
    <div class="execution-content">
      <ol class="execution-timeline">
        <li v-for="event in execution?.events" :key="event.id" :class="event.status">
          <span class="trace-icon"
            ><Icon
              :name="event.status === 'running' ? 'loading' : icons[event.kind]"
              :class="{ spin: event.status === 'running' }"
              :size="15"
          /></span>
          <div>
            <div class="trace-title">
              <strong>{{ event.label }}</strong
              ><time>{{ new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false }) }}</time>
            </div>
            <p v-if="event.detail">{{ event.detail }}</p>
            <small v-if="event.status === 'blocked'">{{
              event.kind === 'tool' ? '未执行' : '已停止'
            }}</small>
          </div>
        </li>
      </ol>
      <details v-if="execution?.reasoning" class="reasoning-details">
        <summary>
          <Icon name="sparkles" :size="15" />模型返回的思考<Icon
            class="disclosure-arrow"
            name="right"
            :size="14"
          />
        </summary>
        <p class="reasoning-disclaimer">来自模型服务的输出，不代表已执行工具或验证事实。</p>
        <pre>{{ execution.reasoning }}</pre>
      </details>
      <div v-if="execution?.usage" class="usage-strip">
        <span v-if="execution.usage.inputTokens !== undefined"
          >输入 {{ execution.usage.inputTokens.toLocaleString() }} tokens</span
        ><span v-if="execution.usage.outputTokens !== undefined"
          >输出 {{ execution.usage.outputTokens.toLocaleString() }} tokens</span
        ><span v-if="execution.usage.reasoningTokens !== undefined"
          >其中思考 {{ execution.usage.reasoningTokens.toLocaleString() }} tokens</span
        >
      </div>
      <p class="trace-footnote">记录实际请求阶段；当前尚未启用文件工具与联网搜索。</p>
    </div>
  </details>
</template>
