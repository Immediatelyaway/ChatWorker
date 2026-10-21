import type { Provider } from '../shared/types.js';
export type ChatInput = { role: 'user' | 'assistant'; content: string };
export interface ModelRequest {
  provider: Provider;
  key: string;
  model: string;
  messages: ChatInput[];
  system: string;
  signal: AbortSignal;
}

/** Decode SSE frames across arbitrary byte boundaries, including CRLF streams. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
      if (buffer.length > 2_000_000) throw new Error('模型事件超过大小限制');
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function buildRequest(r: ModelRequest) {
  const { provider: p, key, model, messages, system } = r;
  const base = p.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (p.protocol === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    return {
      url: base + '/messages',
      headers,
      body: { model, system, messages, max_tokens: 4096, stream: true },
    };
  }
  headers.Authorization = `Bearer ${key}`;
  if (p.protocol === 'responses')
    return {
      url: base + '/responses',
      headers,
      body: { model, instructions: system, input: messages, stream: true, store: false },
    };
  return {
    url: base + '/chat/completions',
    headers,
    body: { model, messages: [{ role: 'system', content: system }, ...messages], stream: true },
  };
}
export async function* streamModel(r: ModelRequest): AsyncGenerator<string> {
  if (r.provider.protocol === 'demo') {
    const prompt = r.messages.at(-1)?.content ?? '';
    const reply = `这是 **ChatWorker 本地演示**，没有调用真实模型。\n\n你刚才提出了：\n\n> ${prompt.split('\n')[0].slice(0, 180)}\n\n### 我们可以从这里开始\n\n1. **明确目标**：把问题拆成一个可验证的小任务。\n2. **整理上下文**：通过输入框旁的附件按钮加入文本或代码文件。\n3. **连接模型**：打开「设置 → 模型服务」，填写 API Key 和模型 ID。\n\n连接后，这里会逐字显示模型的真实回复。当前版本支持会话管理、项目分组、Markdown、附件、导出与停止生成。\n\n\`\`\`ts\nconst idea = '从一个小任务开始';\nconsole.log(idea);\n\`\`\`\n\n工作模式会帮助整理目标和步骤；文件修改与命令执行将在后续版本接入。`;
    for (let i = 0; i < reply.length; i += 5) {
      r.signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 18));
      yield reply.slice(i, i + 5);
    }
    return;
  }
  const req = buildRequest(r);
  const response = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: r.signal,
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    const hints: Record<number, string> = {
      401: 'API Key 无效或已过期',
      403: '当前账户无权访问此模型',
      404: '请检查 Base URL 和模型 ID',
      429: '请求频率或账户额度受限',
    };
    throw new Error(`${hints[response.status] ?? '模型服务请求失败'}（HTTP ${response.status}）`);
  }
  if (!response.body) throw new Error('模型服务未返回响应流');
  let completed = false;
  for await (const raw of parseSSE(response.body)) {
    if (raw === '[DONE]') {
      completed = true;
      break;
    }
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new Error('模型服务返回了无效事件');
    }
    if (event.error || event.type === 'error' || event.type === 'response.failed')
      throw new Error('模型服务在生成时返回错误，请检查配置或稍后重试');
    if (event.type === 'response.incomplete') throw new Error('模型输出未完成，可能超过输出限制');
    if (event.type === 'response.completed' || event.type === 'message_stop') completed = true;
    if (event.choices?.[0]?.finish_reason) {
      completed = true;
      if (event.choices[0].finish_reason === 'length')
        throw new Error('回复达到输出上限，已保留生成内容');
    }
    const text =
      event.type === 'response.output_text.delta'
        ? event.delta
        : event.type === 'content_block_delta'
          ? event.delta?.text
          : event.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text) yield text;
  }
  if (!completed) throw new Error('连接中断，回复可能不完整；已保留生成内容');
}
