# ChatWorker

一个 Vue 3 + Electron 的个人 AI 工作空间。Web 与桌面共用界面，支持主流模型 API、流式聊天、项目分组和本地会话记录。

## 快速启动

环境：Node.js 22.12+、npm。首次运行需要下载依赖；真实模型请求需要自己的 API Key。

```bash
npm ci
npm run dev
```

浏览器打开 http://127.0.0.1:5173 。没有 Key 也可使用明确标注的本地演示模式。

生产构建与本地运行：

```bash
npm run build
npm start
```

打开 http://127.0.0.1:4317 。只监听本机地址，不是公网部署方案。

桌面版：

```bash
npm run desktop
```

生成当前平台的应用产物：

```bash
npm run desktop:pack
```

产物位于 `release/`；macOS 生成 `ChatWorker-mac-arm64.zip`（Intel 为 x64），解压后得到应用。打包脚本先在临时目录签名，避免同步目录的 Finder 元数据干扰。macOS、Windows、Linux 的安装包目标已配置；本次验证平台为 macOS Apple Silicon，Windows/Linux 需要在对应平台验证。正式分发前还需平台签名与发布流程。

## 配置模型

打开「设置 → 模型服务」，选择供应商，填写 Base URL、API Key、模型 ID，再点「保存并使用」。多个模型 ID 用英文逗号分隔。可以选择：

- OpenAI：Responses 协议。
- Anthropic：原生 Messages 协议。
- Google Gemini：OpenAI 兼容协议。
- DeepSeek：OpenAI 兼容协议。
- 自定义服务：支持上述三种协议，可连接本机 HTTP 接口。

接口适配已实现并通过模拟流测试。真实账户权限、余额和模型是否可用需使用自己的 Key 进行测试；测试按钮会产生一条简短 API 请求。

Web 模式的 Key 仅存服务端内存，重启后需重填；也可使用 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY` 环境变量。`.env` 不自动加载；可在构建后使用 `node --env-file=.env dist/apps/server/src/cli.js`。不要提交 `.env`。

桌面版在系统加密可用时，通过 Electron `safeStorage` 加密保存 Key；不可用时退回内存模式，设置页显示实际存储方式。

## 已实现

- 聊天与工作两种提示模式，Markdown 和代码块展示。
- 流式响应、停止生成、错误提示与部分结果保存。
- 项目创建、会话搜索、重命名、归档、恢复和删除。
- 文本/代码附件，每个最多 100 KB，每条最多 5 个。
- 会话 Markdown 导出、回复复制、实际活动记录。
- 模型服务设置、连接测试、系统指令及浅色/深色/系统主题。
- Web 与 Electron 共用前端、本地服务和模型适配层。

工作模式当前是规划和文本协作，不执行终端命令，不读取未选择的本地文件，不自动修改项目代码。MCP、Agent 工具循环及多 Agent 属于后续阶段。

## 项目结构

```text
apps/web/          Vue 页面、组件、状态与样式
apps/server/       本地 API、会话保存、请求校验、流式编排
apps/desktop/      Electron 生命周期与加密凭据
packages/shared/   跨端数据类型和供应商配置
packages/providers/三类模型协议与 SSE 解析
tests/            协议、异常、取消、持久化等测试
docs/             设计、验证与后续计划
```

```bash
npm run typecheck
npm test
npm run build
npm run format
```

详细说明见 [完整设计文档](docs/design.md) 与 [验证记录](docs/verification.md)。

数据：Web 默认写入运行目录 `.chatworker/state.json`；桌面版默认写入 Electron 的应用用户数据目录。两者默认独立，不自动同步。可通过 `CHATWORKER_DATA_DIR`（Web）或 `CHATWORKER_DESKTOP_DATA_DIR`（桌面）指定目录；不要让两个进程同时写同一目录。

### 备份与迁移

在「设置 → 数据与归档」导出 JSON 备份，或选择备份文件预览后导入（最大 20 MiB）。包含项目、消息、文本附件和活动，不包含 API Key 和模型配置。导入添加独立副本，不覆盖现有数据；重复导入会产生重复副本。Web 与 Electron 可以通过备份迁移会话。

### 项目管理

侧栏项目区的管理按钮或「设置 → 项目管理」可以编辑名称和说明。删除项目会保留所有会话（含归档）、消息和附件。在「会话详情 → 所属项目」可移动会话或改为独立会话。生成期间的相关操作会被阻止，以保持状态一致。

### 会话分支与重新生成

回复下的「从此继续」把该回复和之前的消息复制为独立会话。「重新生成（新分支）」保留原会话，在新分支中使用当前选定模型重新回答原问题，包含原附件，不带入之后的对话。真实模型可能产生 API 费用。若分支创建成功但模型请求尚未开始，可修正设置后点击「使用当前模型生成回复」。

### 输入草稿

未发送的文字与文本附件按会话分别保存，新会话按项目和模式区分。发送失败保留草稿，服务端接收后清除；可在输入框下手动清空。草稿为当前浏览器地址下的本地明文，不包含在会话备份中。存储不可用时界面会提示。

Web 使用相同地址可刷新恢复；Electron 随机端口下暂只保证同一次启动内的刷新恢复，不保证退出后恢复。
