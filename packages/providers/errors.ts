export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly category: string,
    message: string,
    readonly parameter?: string,
  ) {
    super(`${message}（模型服务 HTTP ${status}）`);
  }
}
/** Classify a bounded error body; never expose the provider's raw message or echoed inputs. */
export async function providerError(response: Response): Promise<ProviderError> {
  let raw = '';
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (bytes < 8192) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += decoder.decode(value.subarray(0, 8192 - bytes), { stream: true });
        bytes += value.length;
      }
    } catch {
      /* The HTTP status still provides a safe diagnosis. */
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  let error: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw);
    error = parsed?.error ?? {};
  } catch {
    /* Non-JSON errors are not displayed. */
  }
  const description = [error.code, error.type, error.message]
    .filter((x) => typeof x === 'string')
    .join(' ')
    .toLowerCase();
  const allowed = [
    'model',
    'messages',
    'max_tokens',
    'thinking',
    'reasoning_effort',
    'temperature',
    'tools',
    'reasoning_content',
  ];
  const parameter =
    typeof error.param === 'string' && allowed.includes(error.param) ? error.param : undefined;
  let category = 'upstream';
  const hints: Record<number, string> = {
    400: '模型拒绝了请求格式，请检查模型 ID、接口协议及选项',
    401: 'API Key 无效或已过期',
    402: '模型账户余额不足',
    403: '当前账户无权访问此模型',
    404: '请检查接口根地址和模型 ID',
    422: '模型参数不受支持，请检查当前模型的选项',
    429: '请求频率或账户额度受限',
    500: '模型服务内部错误，请稍后重试',
    502: '模型服务暂时不可用',
    503: '模型服务繁忙，请稍后重试',
  };
  let message = hints[response.status] ?? '模型服务请求失败';
  if ([400, 404, 422].includes(response.status)) {
    if (
      /model.{0,40}(not.?found|not.?exist|invalid|unsupported|unavailable)|invalid.{0,10}model|model_not_found/.test(
        description,
      )
    ) {
      category = 'model';
      message = '模型 ID 不存在或当前账户不可用，请核对供应商提供的模型 ID';
    } else if (/reasoning_content/.test(description)) {
      category = 'reasoning_history';
      message = '模型要求完整的思考/工具历史，请新建会话并核对工具协议';
    } else if (/context.{0,20}(length|limit)|maximum context|too many tokens/.test(description)) {
      category = 'context';
      message = '上下文超过模型限制，请新建会话或减少附件';
    } else if (parameter || /invalid.{0,15}(parameter|argument)|unsupported/.test(description)) {
      category = 'parameter';
      message = `模型不接受当前参数${parameter ? '：' + parameter : ''}，请调整模型选项`;
    }
  }
  return new ProviderError(response.status, category, message, parameter);
}
