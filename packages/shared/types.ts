import type { ModelOptions } from './model-catalog.js';
import type { Execution, ExecutionEvent, ModelUsage } from '../contracts/execution.js';
export type Protocol = 'responses' | 'openai' | 'anthropic' | 'demo';
export interface Provider {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  models: string[];
  configured?: boolean;
  modelOptions?: Record<string, ModelOptions>;
}
export interface Attachment {
  name: string;
  content: string;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  createdAt: string;
  status?: 'streaming' | 'completed' | 'cancelled' | 'failed';
  model?: string;
  execution?: Execution;
}
export interface Activity {
  id: string;
  label: string;
  at: string;
}
export interface Conversation {
  id: string;
  title: string;
  projectId: string | null;
  mode: 'chat' | 'work';
  messages: Message[];
  activities: Activity[];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}
export interface Project {
  id: string;
  name: string;
  description: string;
}
export interface Preferences {
  theme: 'light' | 'dark' | 'system';
  providerId: string;
  model: string;
  systemPrompt: string;
}
export interface State {
  schemaVersion: number;
  conversations: Conversation[];
  projects: Project[];
  providers: Provider[];
  preferences: Preferences;
}
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'execution'; event: ExecutionEvent }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'activity'; activity: Activity }
  | { type: 'done'; conversation: Conversation }
  | { type: 'error'; message: string; code?: 'persistence_failed' };
export const providerDefaults: Provider[] = [
  {
    id: 'demo',
    name: '演示模式',
    protocol: 'demo',
    baseUrl: '',
    models: ['本地演示'],
    configured: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  { id: 'custom', name: '自定义接口', protocol: 'openai', baseUrl: '', models: [] },
];
