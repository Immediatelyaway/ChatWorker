import { citationSchema } from './library.js';
import { z } from 'zod';
import { CHAT_LIMITS } from './limits.js';
export const modelOptionsSchema = z
  .object({
    thinking: z.enum(['default', 'disabled', 'enabled']).optional(),
    effort: z.enum(['low', 'high', 'max']).optional(),
  })
  .strict();
export const executionEventSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum([
    'context',
    'connection',
    'reasoning',
    'response',
    'tool',
    'search',
    'completion',
    'error',
  ]),
  label: z.string().max(200),
  detail: z.string().max(2000).optional(),
  status: z.enum(['running', 'completed', 'failed', 'blocked']),
  at: z.string().datetime(),
});
export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export const executionSchema = z.object({
  citations: z.array(citationSchema).max(6).optional(),
  events: z.array(executionEventSchema).max(100),
  reasoning: z.string().max(CHAT_LIMITS.responseCharacters).optional(),
  durationMs: z.number().nonnegative().optional(),
  usage: usageSchema.optional(),
  options: modelOptionsSchema.optional(),
});
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
export type Execution = z.infer<typeof executionSchema>;
export type ModelUsage = z.infer<typeof usageSchema>;
