import type { Provider } from './types.js';

export type ThinkingMode = 'default' | 'disabled' | 'enabled';
export type ReasoningEffort = 'low' | 'high' | 'max';
export interface ModelOptions {
  thinking?: ThinkingMode;
  effort?: ReasoningEffort;
}
export const deepseekModels = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash', description: '日常协作与快速迭代', tag: '灵活' },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: '复杂问题与深入分析',
    tag: '进阶',
  },
];
export const effortLevels = [
  { value: 'low', label: '轻量', description: '更快开始回答' },
  { value: 'high', label: '深入', description: '适合分析与推理' },
  { value: 'max', label: '充分', description: '可能增加耗时与用量' },
] as const;
export function supportsThinking(provider: Pick<Provider, 'protocol' | 'baseUrl'>, model: string) {
  try {
    const url = new URL(provider.baseUrl);
    return (
      provider.protocol === 'openai' &&
      url.hostname === 'api.deepseek.com' &&
      [
        'deepseek-flash',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'deepseek-v4-flash-vision-exp',
      ].includes(model)
    );
  } catch {
    return false;
  }
}
export function modelLabel(model: string) {
  return deepseekModels.find((m) => m.id === model)?.name ?? model;
}
export function modelOptions(provider: Provider, model: string): ModelOptions {
  return provider.modelOptions?.[model] ?? {};
}
