import metadata from '../../../package.json' with { type: 'json' };
import {
  capabilitiesSchema,
  type RuntimeCapabilities,
} from '../../../packages/contracts/capabilities.js';
import { CHAT_LIMITS } from '../../../packages/contracts/limits.js';
import {
  CAPABILITIES_VERSION,
  STATE_VERSION,
  BACKUP_VERSION,
  DRAFT_VERSION,
  DATABASE_VERSION,
} from '../../../packages/contracts/versions.js';

export function describeCapabilities(runtime: {
  desktop: boolean;
  persistentKeys: boolean;
}): RuntimeCapabilities {
  return capabilitiesSchema.parse({
    contractVersion: CAPABILITIES_VERSION,
    appVersion: metadata.version,
    environment: runtime.desktop ? 'desktop' : 'web',
    scope: 'local',
    protocols: ['demo', 'responses', 'openai', 'anthropic'],
    storage: {
      history: 'sqlite',
      drafts: 'server-sqlite',
      keyPersistence: runtime.persistentKeys ? 'persistent' : 'memory',
      stateVersion: STATE_VERSION,
      databaseVersion: DATABASE_VERSION,
      backupVersion: BACKUP_VERSION,
      draftVersion: DRAFT_VERSION,
    },
    execution: {
      engine: 'text-chat',
      onDisconnect: 'cancel',
      onRestart: 'mark-interrupted-failed',
    },
    features: {
      chat: {
        status: 'available',
        detail:
          '支持流式聊天与停止生成。真实模型需要配置可用的账户与模型；工作模式当前提供规划和文本协作。',
      },
      attachments: {
        status: 'limited',
        detail: `支持用户选择的文本和代码文件，每条最多 ${CHAT_LIMITS.attachmentsPerMessage} 个，每个文件最多 ${CHAT_LIMITS.attachmentFileBytes / 1000} KB；不读取未选择的文件。`,
      },
      projects: {
        status: 'available',
        detail: '创建、编辑项目并整理会话；项目分组尚未绑定本机工作目录。',
      },
      branches: {
        status: 'available',
        detail: '从选定回复建立独立分支，或在新分支中重新生成，保留原会话。',
      },
      backups: {
        status: 'available',
        detail:
          '导出会话备份，预览后导入独立副本；不包含密钥、模型配置、草稿和空间资料；空间原文件可单独下载。',
      },
      library: {
        status: 'limited',
        detail:
          '空间支持上传文本、PDF、DOCX，收藏历史附件和回复；开启参考后按词汇检索相关片段并显示来源。暂不支持扫描件 OCR、向量语义检索或外网搜索。',
      },
      drafts: {
        status: 'available',
        detail:
          '草稿保存到当前本机资料库，重启或端口变化后可恢复已保存内容；多窗口版本冲突会保留双方内容并提示处理。离线缓存仍受浏览器地址限制。',
      },
      workspaceFiles: {
        status: 'unavailable',
        detail: '尚未接入本机目录授权、文件读取和补丁应用工具。',
      },
      terminal: { status: 'unavailable', detail: '当前不会运行终端命令或项目测试。' },
      runRecovery: {
        status: 'unavailable',
        detail: '页面连接断开会停止生成；服务重启后会标记中断，不会自动继续。',
      },
      mcp: { status: 'unavailable', detail: '尚未接入 MCP 服务或外部工具。' },
      multiAgent: { status: 'unavailable', detail: '尚未实现子任务委派或多个智能体协作。' },
    },
    limits: CHAT_LIMITS,
  });
}
