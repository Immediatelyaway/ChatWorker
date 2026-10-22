import { Worker } from 'node:worker_threads';
import { LIBRARY_LIMITS } from '../contracts/library.js';
export const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'jsx',
  'tsx',
  'vue',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'sql',
  'log',
]);
export async function extractDocument(
  name: string,
  bytes: Uint8Array,
): Promise<{ text: string; format: string }> {
  const format = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (!TEXT_EXTENSIONS.has(format) && !['pdf', 'docx'].includes(format))
    throw new Error('支持文本、Markdown、代码、PDF 和 DOCX 文件');
  if (!bytes.length || bytes.length > LIBRARY_LIMITS.fileBytes)
    throw new Error('文件不能为空，且不能超过 5 MiB');
  let entry = new URL('./extract-worker.js', import.meta.url);
  if (import.meta.url.endsWith('.ts'))
    entry = new URL(
      'data:text/javascript,' +
        encodeURIComponent(
          `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register(); await import(${JSON.stringify(new URL('./extract-worker.ts', import.meta.url).href)});`,
        ),
    );
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, {
      workerData: { format, bytes },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(error) : resolve({ text: text!, format });
    };
    const timer = setTimeout(() => finish(new Error('资料解析超时，请拆分文件后重试')), 15_000);
    worker.once('message', (result) =>
      finish(result.error ? new Error(result.error) : undefined, result.text),
    );
    worker.once('error', () => finish(new Error('资料无法解析，请检查格式、大小或换成文本文件')));
    worker.once('exit', () => {
      if (!settled) finish(new Error('资料解析未完成，请换成文本文件后重试'));
    });
  });
}
