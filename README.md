# ChatWorker

一个 Vue 3 + Electron 的个人 AI 工作空间。Web 与桌面共用界面，支持主流模型 API、流式聊天、项目分组和本地会话记录。

## 快速启动

开发与完整验证环境：Node.js 22.21.1+、npm。首次运行需要下载依赖；真实模型请求需要自己的 API Key。

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
- 「关于 ChatWorker → 运行能力」显示服务版本、已支持的功能、保存方式与实际使用限制，可刷新查询。

工作模式当前是规划和文本协作，不执行终端命令，不读取未选择的本地文件，不自动修改项目代码。MCP、Agent 工具循环及多 Agent 属于后续阶段。

## 项目结构

```text
apps/web/          Vue 页面、组件、状态与样式
apps/server/       本地 API、会话保存、请求校验、流式编排
apps/desktop/      Electron 生命周期与加密凭据
packages/contracts/能力接口校验、独立格式版本与共用限制
packages/shared/   跨端数据类型和供应商配置
packages/providers/三类模型协议与 SSE 解析
packages/storage/  SQLite 仓储、存储线程、目录锁与旧数据迁移
tests/            协议、异常、取消、持久化等测试
docs/             设计、验证与后续计划
```

```bash
npm run typecheck
npm test
npm run build
npm run format
```

存储与桌面打包验证（已验证 Node 22.21.1 / macOS arm64，测试环境建议采用该版本或更新的兼容版本）：

```bash
npm run verify:storage
```

该命令在临时目录运行 Node、Electron 主进程和打包后的测试应用，验证真实存储线程、旧数据升级、目录锁与重开持久化，结束后清理，不迁移现有会话。驱动选择见 [ADR-0001](docs/adr/0001-storage-and-sqlite.md)，当前迁移与恢复规则见 [ADR-0002](docs/adr/0002-sqlite-migration.md)。

当前已实现的行为见 [现有设计文档](docs/design.md) 与 [验证记录](docs/verification.md)。后续通用智能体的架构、源码依据、数据与接口契约、异常恢复、界面细节及分阶段验收见 [通用智能体整体设计蓝图](docs/agent-architecture-blueprint.md)；蓝图中的规划不代表现有能力。

数据：Web 默认写入运行目录 `.chatworker/state.sqlite`；桌面版默认写入 Electron 的应用用户数据目录。两者默认独立，不自动同步。可通过 `CHATWORKER_DATA_DIR`（Web）或 `CHATWORKER_DESKTOP_DATA_DIR`（桌面）指定目录。同一资料目录只允许一个新版服务持有写入权，第二个服务会明确报错。

### 备份与迁移

新目录直接初始化 SQLite。已有 `state.json` 时，先关闭使用此目录的旧版 Web 和桌面服务，再离线升级：

```bash
npm run storage:migrate -- /absolute/path/to/data-directory
```

完成后重新启动服务；桌面版也可在启动提示中选择「备份并升级」。旧版本不认识新版目录锁，升级后也不要再用旧程序写此目录。升级保留原 JSON 和经过 SHA-256 校验的独立备份；中断后可重新运行并恢复迁移。数据库损坏、版本不兼容或升级后文件缺失时停止启动，不清空记录，也不自动回退旧 JSON。恢复步骤与限制见 [迁移文档](docs/adr/0002-sqlite-migration.md)。

在「设置 → 数据与归档」导出 JSON 备份，或选择备份文件预览后导入（最大 20 MiB）。包含项目、消息、文本附件和活动，不包含 API Key 和模型配置。导入添加独立副本，不覆盖现有数据；重复导入会产生重复副本。Web 与 Electron 可以通过备份迁移会话。

### 项目管理

侧栏项目区的管理按钮或「设置 → 项目管理」可以编辑名称和说明。删除项目会保留所有会话（含归档）、消息和附件。在「会话详情 → 所属项目」可移动会话或改为独立会话。生成期间的相关操作会被阻止，以保持状态一致。

### 会话分支与重新生成

回复下的「从此继续」把该回复和之前的消息复制为独立会话。「重新生成（新分支）」保留原会话，在新分支中使用当前选定模型重新回答原问题，包含原附件，不带入之后的对话。真实模型可能产生 API 费用。若分支创建成功但模型请求尚未开始，可修正设置后点击「使用当前模型生成回复」。

### 输入草稿

未发送的文字与文本附件按会话分别保存，新会话按项目和模式区分。发送失败保留草稿，服务端接收后清除；可在输入框下手动清空。草稿为当前浏览器地址下的本地明文，不包含在会话备份中。存储不可用时界面会提示。

Web 使用相同地址可刷新恢复；Electron 随机端口下暂只保证同一次启动内的刷新恢复，不保证退出后恢复。
