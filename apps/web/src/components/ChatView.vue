<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Icon from './Icon.vue';
import Composer from './Composer.vue';
import { ui, current, notify, forkConversation, send } from '../composables/workspace';
const composer = ref<InstanceType<typeof Composer>>(),
  scroller = ref<HTMLElement>();
const suggestions = [
  {
    icon: 'code',
    title: '读懂一段代码',
    text: '梳理逻辑，发现更好的写法',
    prompt: '请帮我梳理代码的主要逻辑。我会添加代码文件，请先告诉我你会从哪些方面分析。',
  },
  {
    icon: 'edit',
    title: '把想法写下来',
    text: '从模糊的灵感到清晰的表达',
    prompt: '我想把一个想法写成清晰的方案，请引导我明确目标、受众和主要内容。',
  },
  {
    icon: 'idea',
    title: '一起解决问题',
    text: '拆解难题，找到下一步',
    prompt: '请帮我把一个复杂任务拆成可以执行的小步骤，先问我最关键的问题。',
  },
];
function markdown(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify('已复制');
  } catch {
    notify('复制失败，请手动选择文本');
  }
}
watch(
  () => current.value?.messages.at(-1)?.content,
  async () => {
    const el = scroller.value;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 180) {
      await nextTick();
      el.scrollTop = el.scrollHeight;
    }
  },
);
watch(
  () => ui.activeId,
  async () => {
    await nextTick();
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  },
);
</script>
<template>
  <section class="chat-view" :class="{ welcome: !current?.messages.length }">
    <div v-if="!current?.messages.length" class="welcome-content">
      <div class="welcome-kicker"><span class="mini-mark">✳</span> 一处空间，无限可能</div>
      <h1>{{ ui.mode === 'work' ? '我们一起，做点什么？' : '今天，想聊些什么？' }}</h1>
      <p class="welcome-subtitle">把想法带到这里，让下一步更清晰。</p>
      <Composer ref="composer" />
      <div class="suggestion-grid">
        <button v-for="s in suggestions" :key="s.title" @click="composer?.fill(s.prompt)">
          <Icon :name="s.icon" :size="21" /><span>{{ s.title }}</span
          ><small>{{ s.text }}</small
          ><Icon class="suggestion-arrow" name="arrow" :size="16" />
        </button>
      </div>
      <div class="welcome-note">
        <Icon name="shield" :size="14" />会话保存在本机 · 模型服务由你选择
      </div>
    </div>
    <template v-else
      ><div ref="scroller" class="messages-scroll">
        <div class="messages">
          <article v-for="m in current.messages" :key="m.id" class="message" :class="m.role">
            <div v-if="m.role === 'assistant'" class="assistant-label">
              <span class="assistant-mark">W</span><strong>ChatWorker</strong
              ><span>{{ m.model?.split(' / ')[0] }}</span>
            </div>
            <div v-if="m.role === 'user'" class="user-bubble">
              {{ m.content }}
              <div v-if="m.attachments?.length" class="message-files">
                <span v-for="a in m.attachments" :key="a.name"
                  ><Icon name="file" :size="14" />{{ a.name }}</span
                >
              </div>
            </div>
            <div v-else class="assistant-body">
              <div v-if="m.content" class="markdown" v-html="markdown(m.content)"></div>
              <div v-else-if="m.status === 'streaming'" class="thinking">
                <span></span><span></span><span></span>
              </div>
              <span v-if="m.status === 'streaming' && m.content" class="typing-cursor"></span>
              <p v-if="m.status === 'cancelled' || m.status === 'failed'" class="message-status">
                {{
                  m.status === 'cancelled'
                    ? '已停止生成'
                    : '本次生成未完成，可以在新分支中重新生成。'
                }}
              </p>
              <div v-if="m.status !== 'streaming'" class="message-actions">
                <button
                  v-if="m.content"
                  class="icon-button copy-button"
                  title="复制回复"
                  aria-label="复制回复"
                  @click="copy(m.content)"
                >
                  <Icon name="copy" :size="15" />
                </button>
                <button
                  class="text-button"
                  :disabled="!!ui.busyId || ui.preparing"
                  title="保留当前回复及之前的消息，在独立分支继续对话"
                  @click="forkConversation(m.id, 'continue')"
                >
                  <Icon name="arrow" :size="15" />从此继续
                </button>
                <button
                  class="text-button"
                  :disabled="!!ui.busyId || ui.preparing"
                  title="使用当前选定模型在新分支重新回答，真实模型可能产生 API 费用"
                  @click="forkConversation(m.id, 'retry')"
                >
                  <Icon name="retry" :size="15" />重新生成（新分支）
                </button>
              </div>
            </div>
          </article>
        </div>
      </div>
      <div class="bottom-composer">
        <div
          v-if="current.messages.at(-1)?.role === 'user' && !ui.busyId && !ui.preparing"
          class="pending-reply"
        >
          <span>这条问题尚无回复。</span>
          <button class="text-button" @click="send('', [], true)">使用当前模型生成回复</button>
        </div>
        <Composer />
        <p class="disclaimer">
          {{
            current.mode === 'work'
              ? '工作模式提供规划与文本协作，当前不会修改文件或执行命令。'
              : 'AI 的回答可能不准确，请核实重要信息。'
          }}
        </p>
      </div></template
    >
    <div v-if="ui.error" class="error-banner" role="alert">
      <span>{{ ui.error }}</span
      ><button class="icon-button" aria-label="关闭提示" @click="ui.error = ''">
        <Icon name="x" :size="15" />
      </button>
    </div>
  </section>
</template>
