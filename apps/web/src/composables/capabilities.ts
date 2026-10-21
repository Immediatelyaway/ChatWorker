import { reactive } from 'vue';
import {
  decodeCapabilities,
  type RuntimeCapabilities,
} from '../../../../packages/contracts/capabilities';

type RequestCapabilities = (signal: AbortSignal) => Promise<Response>;

export function createCapabilitiesClient(
  request: RequestCapabilities = (signal) =>
    fetch('/api/v1/capabilities', { headers: { 'X-ChatWorker': '1' }, cache: 'no-store', signal }),
) {
  const state = reactive({
    data: null as RuntimeCapabilities | null,
    status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    error: '',
  });
  let controller: AbortController | undefined;
  async function load() {
    if (state.status === 'loading') return;
    const current = new AbortController();
    controller = current;
    state.status = 'loading';
    state.data = null;
    state.error = '';
    const timer = setTimeout(() => current.abort(), 10_000);
    try {
      const response = await request(current.signal);
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? '当前服务尚不支持能力查询，请更新并重启服务后重试。'
            : `无法读取运行信息（${response.status}），请稍后重试。`,
        );
      const value: unknown = await response.json().catch(() => {
        throw new Error('服务没有返回有效的运行信息，请更新并重启服务后重试。');
      });
      const data = decodeCapabilities(value);
      if (controller !== current) return;
      current.signal.throwIfAborted();
      state.data = data;
      state.status = 'ready';
    } catch (error) {
      if (controller !== current) return;
      state.error = current.signal.aborted
        ? '读取运行信息超时，请确认本地服务正在运行后重试。'
        : error instanceof TypeError
          ? '无法连接本地服务，请确认服务正在运行后重试。'
          : error instanceof Error
            ? error.message
            : '无法读取运行信息，请重试。';
      state.status = 'error';
    } finally {
      clearTimeout(timer);
      if (controller === current) controller = undefined;
    }
  }
  function dispose() {
    const current = controller;
    controller = undefined;
    current?.abort();
    state.data = null;
    state.status = 'idle';
    state.error = '';
  }
  return { state, load, dispose };
}
