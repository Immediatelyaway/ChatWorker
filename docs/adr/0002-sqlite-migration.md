# ADR-0002：SQLite 生产存储、旧数据升级与中断恢复

日期：2026-10-22 · 对应任务：CW-003 · 状态：已实现并通过本机验证。

## 决策与范围

沿用 [ADR-0001](0001-storage-and-sqlite.md) 验证过的内置 `node:sqlite`，将生产历史存储切换到关系表。SQLite 同步调用放入独立工作线程；服务端维护已提交的内存快照，所有修改排队提交，保存成功后才更新内存并返回成功。保留原 API 的数据形状和 v1 JSON 导出格式，便于后续逐步实现稳定草稿、Run 与事件日志。

每个资料目录只允许一个新版服务持有写入权。旧 JSON 迁移必须通过明确入口开始，保留原文件和经过哈希校验的备份，数据库切换后禁止自动回退旧数据。没有采用长期双写：它会引入两个可独立失败的权威数据源。

这是小规模单用户存储的过渡实现。当前每次保存仍重写全部关系记录、加载完整快照，没有声称已经实现增量写入、消息分页、Blob 分离、跨窗口 revision 或完整 Agent 恢复。

## 模块与运行边界

| 模块                                    | 职责                                                 |
| --------------------------------------- | ---------------------------------------------------- |
| `packages/contracts/state.ts`           | 共用 schema、旧版本解码、ID 和引用校验；不依赖应用层 |
| `apps/server/src/storage.ts`            | 初始化、中断消息恢复、串行变更、提交后发布内存快照   |
| `packages/storage/state-repository.ts`  | 异步 load/save/close 与稳定 storeId                  |
| `packages/storage/worker-repository.ts` | 线程生命周期、请求编号、错误与退出传播               |
| `packages/storage/state-worker.ts`      | 在线程内执行数据库操作；关闭后释放消息端口           |
| `packages/storage/state-database.ts`    | 版本检查、迁移、事务、恢复和数据库关闭               |
| `packages/storage/state-tables.ts`      | 表定义、参数绑定、关系记录与现有 State 的转换        |
| `packages/storage/directory-lock.ts`    | 跨进程目录写入权；不删除锁文件                       |
| `apps/server/src/migrate.ts`            | 显式离线升级入口                                     |

生产 worker 使用编译后的 JavaScript，开发模式才加载 tsx。worker 启动失败时等待退出；运行中异常终止时拒绝所有未完成请求，不偷偷重新打开数据库。关闭按已排队请求的顺序执行。线程承担同步 SQL 和等待数据库锁，但主线程仍承担完整状态克隆和校验，大量历史数据的 CPU 成本尚未消除。[Node worker_threads](https://nodejs.org/download/release/v22.21.1/docs/api/worker_threads.html)

## 资料目录与版本

Web 默认为工作目录 `.chatworker`；桌面默认为 Electron userData。环境变量可指定目录，二者默认独立，不自动同步。

| 文件                         | 用途与生命周期                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `writer.lock.sqlite`         | 持久锁文件；以 SQLite EXCLUSIVE 锁持有目录写入权；正常关闭和进程死亡后释放锁，文件保留 |
| `state.sqlite`               | 启用后的唯一业务数据库                                                                 |
| `state.sqlite-journal`       | SQLite 回滚日志；异常退出时可能需要恢复，不能随意删除                                  |
| `storage.json`               | 激活标记，含 version=1、backend=sqlite、storeId                                        |
| `migration.json`             | 迁移计划，含 version=1、storeId、sourceHash；作为来源记录保留                          |
| `state.sqlite.migrating`     | 尚未激活的暂存数据库；仅有匹配迁移计划时可重建                                         |
| `state.json`                 | 原数据，升级后保留但不继续更新                                                         |
| `state.json.backup-<sha256>` | 升级时原始字节备份，macOS 权限设为 0400；不是防篡改存储或持续备份                      |
| `*.tmp`                      | 标记和备份写入时的临时文件；成功时同步、重命名并同步目录                               |

数据库 `user_version=1`，`application_id=0x43574b52`；metadata 保存独立的 stateVersion=1 和 UUID storeId。状态、JSON 备份、客户端草稿仍为 v1；能力接口因保存方式和 databaseVersion 字段升级为 v2。应用版本独立读取 package.json，不能用应用版本替代数据迁移版本。

新目录默认权限 0700，创建的数据库、锁和标记默认 0600；已存在目录不会被递归改权限。关键文件拒绝非普通文件；目录先 realpath 再锁定。此检查不是对同账户恶意进程的隔离或完整文件系统沙箱。

## 表结构与保留规则

| 表              | 主键 / 关联                             | 保留信息                                       |
| --------------- | --------------------------------------- | ---------------------------------------------- |
| metadata        | key                                     | storeId、stateVersion                          |
| projects        | id，position 唯一                       | 名称、说明、顺序                               |
| conversations   | id，project_id 外键                     | 标题、模式、归档、时间、顺序                   |
| messages        | conversation_id + id，位置唯一          | 正文、角色、状态、模型、时间、附件字段是否存在 |
| attachments     | conversation_id + message_id + position | 文件名与完整文本，关联消息                     |
| activities      | conversation_id + position              | 原 ID、文字和时间；旧活动 ID 不要求唯一        |
| providers       | id，position 唯一                       | 名称、协议、Base URL                           |
| provider_models | provider_id + position                  | 模型 ID 与顺序                                 |
| preferences     | singleton=1，provider_id 外键           | 主题、默认供应商、模型与系统指令               |

使用 STRICT 表、外键、唯一位置和绑定参数。完整状态在写入前和读回后均校验。迁移保留旧 ID、归档、项目关联、消息与附件顺序，以及 `attachments` 缺省与空数组的区别；不会把整份 State 塞入一个 JSON 字段。API Key 从不写入业务数据库。

当前事务按外键依赖顺序清空旧记录，再插入完整快照；任一约束或写入失败则回滚整笔事务。这保留了原有全状态 API 的行为，但不是面向大量历史的最终仓储设计。

## 目录唯一写入权与数据库启动

锁文件的 SQLite 连接使用 EXCLUSIVE locking mode，并在服务整个生命周期保持独占锁。锁基于操作系统文件锁，不根据容易失效的 PID 文件判断存活；绝不删除再创建锁文件，以免两个进程锁到不同文件。跨进程争用和杀死锁持有者后的重开已验证。[SQLite locking mode](https://sqlite.org/pragma.html#pragma_locking_mode)

**旧 JSON 版本不认识这个锁。** 升级前需要停止使用该目录的所有旧版桌面/Web 服务，升级后也不能让它们再写此目录。迁移前后哈希比对能发现部分并发修改，不能证明旧服务不存在或阻止非协作进程。第二个新版服务则会明确失败。

已有数据库先只读检查 SQLite 文件头、应用 ID、版本以及回滚日志模式；不支持的版本、损坏文件头和 WAL 格式拒绝打开。通过检查后才以可写连接打开，让 SQLite 恢复已知版本的 hot rollback journal，再验证实际 PRAGMA、quick_check、外键、业务结构和 storeId。因此“文件头预检只读”不等于“整个启动过程只读”。[SQLite 文件格式](https://www.sqlite.org/fileformat2.html)、[回滚日志恢复](https://sqlite.org/lockingv3.html)

业务库固定 DELETE 日志、FULL 同步、外键开启，等待数据库锁上限 1000ms。Node 22.21.1 的旧 SQLite 不启用 WAL；底层试验对 WAL 的版本保护继续保留。FULL 与 fsync 不构成所有硬件故障下永不丢失数据的保证。

## 升级入口与迁移步骤

Web 在停止旧服务后执行：

```bash
npm run storage:migrate -- /absolute/path/to/data-directory
```

也可通过 CHATWORKER_DATA_DIR 指定目录。没有旧文件的新目录直接初始化 SQLite；检测到旧 JSON 且没有迁移计划时，普通服务启动会提示先升级。桌面提供「备份并升级 / 退出」对话框，默认退出；确认后使用同一存储迁移流程。

1. 获得目录锁，校验激活标记、迁移计划与已有数据库。已激活却缺少数据库时拒绝启动，不能当作首次运行。
2. 校验旧 JSON 全部内容；接受无版本旧格式和 v1，拒绝未知版本。持久化带固定 storeId、源 SHA-256 的迁移计划。
3. 复制旧 JSON 原始字节到独立备份并校验哈希。已存在备份必须匹配，不能覆盖损坏备份。
4. 在暂存数据库中 BEGIN IMMEDIATE，建表并导入全部关系记录，COMMIT。回读完整状态逐项比对，再做 quick_check 和外键检查。
5. 关闭并同步暂存数据库，再次检查旧 JSON 哈希未变化；原子重命名为 state.sqlite，并同步目录。
6. 验证正式数据库，写激活标记。业务 Storage 将残留 streaming 消息标记 failed，追加一次中断记录并提交。
7. 以后只使用正式数据库；不双写旧 JSON，不自动删除备份。正常生成结束前不周期保存 token 增量，崩溃仍可能丢失当次增量。

如果数据库已经出现，即使激活标记还未写入，它也是恢复时的权威来源。标记或计划的 storeId 与数据库不匹配时拒绝继续。

| 中断位置（测试实际 SIGKILL） | 下次启动行为                                     |
| ---------------------------- | ------------------------------------------------ |
| planned                      | 使用已记录的 ID 与哈希，继续制作或验证备份       |
| backup-created               | 校验备份，重建未启用的暂存库                     |
| importing                    | 丢弃计划所属的未启用暂存库及其日志，重新事务导入 |
| import-committed             | 同样重新导入并校验，不向正式库追加重复记录       |
| before-switch                | 正式库不存在，按计划重建并切换                   |
| after-switch                 | 打开正式库，补写激活标记，不重新导入旧 JSON      |
| ready                        | 正常打开已启用数据库；中断消息恢复不会重复追加   |

测试故障注入只能经进程内选项调用，不暴露为 HTTP 或环境变量开关。迁移阶段的 SIGKILL 证明进程中断恢复，不等同于真实断电与存储设备故障。

## API、失败与退出语义

`Storage.update()` 在串行队列内克隆最新已提交状态，执行同步变更，校验结果并等待 worker 提交；之后才替换内存。路由在队列内复查引用和生成状态，避免排队期间的过期判断。失败不会污染当前内存，也不会阻塞后续队列项。

发送消息先预留活动状态，再事务保存用户消息和助手占位消息；成功之后才发 SSE 响应头并调用模型。初始保存失败返回错误且释放活动状态，不调用模型。增量只进入当前请求快照和页面。终态事务成功才发 `done`；保存失败发带 `persistence_failed` 的 error，不发 done。页面保留当前可见回复并提示先复制，刷新或离开后仍可能丢失，不能把它当作已保存历史。

不同会话的终态更新基于最新状态，只替换对应会话，保留期间发生的其他项目或偏好修改。停止生成和关闭服务也需要保存终态；关闭先拒绝新请求，再取消并等待活动流、关闭 HTTP 连接、排空存储队列，最后关闭 worker 和目录锁。启动端口占用时也释放已打开的存储。Express 5 的 listen 回调可能接收错误，必须检查它而不是直接视为启动成功。[Express 5 迁移说明](https://expressjs.com/en/guide/migrating-5.html)

凭据仓库与 SQLite 无跨介质事务。显式修改 Key 时先清除旧 Key，再提交配置，最后保存新 Key；若后一步失败，配置可能已经提交，但旧 Key 不会跟随新地址，需要重新填写。保存期间拒绝同供应商新请求与并发编辑；已开始的请求继续使用自己的配置和凭据快照。环境变量 Key 仅用于对应预设默认地址，不用于自定义地址。

## 人工恢复与回退

日常备份继续使用「设置 → 数据与归档」导出 v1 JSON。它包含项目、会话、消息、附件和活动，不含模型配置或凭据；导入添加独立副本。迁移产生的原始 JSON 备份包含升级时的旧状态与模型配置，二者用途不同。

迁移失败时保留原目录；先根据错误检查版本、锁持有者、空间、权限与备份哈希，再重试升级入口。不要删除 storage.json 或 migration.json 来强行初始化，也不要用旧 JSON 覆盖活动数据库。

必须从升级前快照恢复时：停止相关服务，另建一个空资料目录，将哈希匹配的迁移备份复制为其中的 state.json，对新目录执行离线升级并核对记录，确认后才把应用指向新目录。原目录保留供排查；这一恢复点不包含升级后的新会话，不能宣称无损回滚。

复制完整数据库作为人工备份应先正常停止全部写入者；如果来源经历异常退出，不要丢弃其回滚日志，应先在隔离副本中让兼容版本完成恢复并核对。没有实现在线全库备份/恢复按钮，也没有自动恢复任意损坏数据库的能力。数据库和备份均为本机明文，非整库加密。

## 验证与未覆盖范围

`npm test` 验证旧数据内容、备份字节、未来版本和损坏拒绝、七个迁移中断点、跨进程目录锁、写事务 SIGKILL 后 hot journal 恢复、SQL 故障导致的整笔回滚、并发变更、工作线程等锁时 HTTP 仍可响应、流式保存失败及退出清理。故障触发器用于模拟写入失败，不代表真实磁盘耗尽试验。

`npm run verify:storage` 在 Node、Electron 主进程和真实 ASAR 打包测试应用中调用生产 Storage/worker，完成旧数据升级、第二实例拒绝、写入与重开、storeId 稳定和原 JSON 保留，同时保留驱动事务检查。结果与运行版本见 [验证记录](../verification.md)。所有试验使用独立临时目录，不读取或迁移用户现有历史。

本轮验证平台是 macOS arm64。Windows/Linux、真实断电、磁盘硬件故障、大规模历史性能、完整桌面升级对话框操作和安装程序尚未验收；Windows 没有实现目录 fsync，也未验证 ACL。Node 22 的 node:sqlite 仍会发实验性提示。没有调用真实付费模型，也没有实现自动恢复模型请求、Run、事件重放和跨端草稿；下一步为 CW-004。
