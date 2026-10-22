import { parentPort, workerData } from 'node:worker_threads';
import { LIBRARY_LIMITS } from '../contracts/library.js';
const { format, bytes } = workerData as { format: string; bytes: Uint8Array };
class ExtractionError extends Error {}
function checkText(text: string) {
  if (text.length > LIBRARY_LIMITS.textCharacters)
    throw new ExtractionError('提取文字超过 20 万字符，请拆分后上传');
}
try {
  let text = '';
  if (format === 'pdf') {
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-')
      throw new ExtractionError('文件不是有效的 PDF');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({
      data: bytes,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      useWorkerFetch: false,
      verbosity: 0,
    });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 200) throw new ExtractionError('PDF 超过 200 页，请拆分后上传');
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p),
          content = await page.getTextContent();
        text +=
          `\n第 ${p} 页\n` +
          content.items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
            .join('') +
          '\n';
        checkText(text);
        page.cleanup();
      }
      if (!text.replace(/第 \d+ 页/g, '').trim())
        throw new ExtractionError('PDF 没有可提取文字，扫描件请先进行 OCR');
    } finally {
      await task.destroy();
    }
  } else if (format === 'docx') {
    // Bound ZIP expansion before handing the document to the XML/text parser.
    const data = Buffer.from(bytes),
      end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > data.length) throw new ExtractionError('DOCX 压缩结构无效');
    const count = data.readUInt16LE(end + 10);
    let pos = data.readUInt32LE(end + 16),
      expanded = 0;
    if (count > 2000) throw new ExtractionError('DOCX 内容过于复杂，请导出文本后上传');
    for (let i = 0; i < count; i++) {
      if (pos + 46 > data.length || data.readUInt32LE(pos) !== 0x02014b50)
        throw new ExtractionError('DOCX 压缩结构无效');
      expanded += data.readUInt32LE(pos + 24);
      if (expanded > 20 * 1024 * 1024)
        throw new ExtractionError('DOCX 解压内容超过限制，请拆分后上传');
      pos +=
        46 +
        data.readUInt16LE(pos + 28) +
        data.readUInt16LE(pos + 30) +
        data.readUInt16LE(pos + 32);
    }
    const mammoth = await import('mammoth');
    text = (await mammoth.extractRawText({ buffer: data })).value;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ExtractionError('文本需使用 UTF-8 编码，请转换编码后上传');
    }
    if (text.includes('\0')) throw new ExtractionError('文件包含二进制内容，不能作为文本解析');
  }
  text = text.replace(/\r\n?/g, '\n').trim();
  checkText(text);
  if (!text) throw new ExtractionError('资料中没有可用文字');
  parentPort!.postMessage({ text });
} catch (error) {
  parentPort!.postMessage({
    error:
      error instanceof ExtractionError
        ? error.message
        : '文件无法提取文字，可能已加密、损坏或格式不受支持',
  });
}
