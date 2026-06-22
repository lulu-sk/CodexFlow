# Antigravity CLI 引擎接入功能报告

日期：2026-06-21

## 结论

Antigravity CLI 已按内置代理引擎接入 CodexFlow。入口顺序为 Codex、Claude、Gemini、Antigravity、Terminal；默认启动命令为 `agy`；历史继续命令为 `agy --conversation <conversationId>`。

本次接入以低资源占用为原则：历史列表阶段只做轻量摘要解析，Antigravity 历史扫描只收集 conversation DB，监听与索引复用现有 debounce、批量和并发限制。

## 已接入功能

- Provider 列表：新增 `antigravity` 内置代理引擎，图标显示在 Gemini 右侧、Terminal 左侧。
- 默认命令：新建控制台默认使用 `agy`。
- YOLO 预设：Antigravity 使用 `agy --dangerously-skip-permissions`，并纳入一次性 YOLO 引导和设置页预设判断。
- 输入发送：Antigravity 复用 Gemini 类 CLI 的多行粘贴、局部屏幕 ACK、分块 bracketed paste 和延迟回车策略，避免长文本/多行 prompt 过早提交或换行丢失。
- Worktree 创建：单引擎、多引擎计数、任务快照、主进程过滤、偏好保存、刷新草稿恢复均支持 Antigravity。
- 初始提示词注入：worktree 创建后的首次启动复用 Gemini 类交互方式，使用 `-i` 传入初始 prompt。
- 历史发现：扫描 `.gemini/antigravity-cli/conversations` 下的 `*.db`，忽略 `*.db-wal` 和 `*.db-shm`。
- 历史索引：索引器支持 Antigravity roots、files、summaryOnly 解析、watch 监听和增量刷新。
- 历史详情：`history.read` 可按 `antigravity` 解析 SQLite DB，生成结构化摘要、步骤顺序、状态信息和 raw fallback 消息；不承诺完整复原原生会话详情。
- 继续会话：历史页继续会话使用 `agy --conversation <conversationId>`，按 WSL、PowerShell、CMD 分别做安全参数拼接。
- 设置页根目录：`settings.sessionRoots({ providerId: "antigravity" })` 可返回已探测到的 Antigravity 会话根目录，并在设置页“数据与存储”中只读展示；Antigravity 不显示规则文件编辑入口。
- i18n：英文、中文 Provider 名称和设置页相关文案已同步。

## 历史详情能力边界

当前可承诺的是：CodexFlow 能离线读取 Antigravity 本地会话 DB，恢复会话 ID、步骤顺序、步骤数量、状态摘要、部分结构字段和继续会话 ID。

当前不承诺：完整复原 Antigravity 原生会话详情，或与 Antigravity 原生 UI 做字段级、渲染级 100% 完全一致。原因是 Antigravity 的会话载荷使用 protobuf，当前缺少官方 `.proto`、字段语义映射、完整解密/封装说明或稳定本地导出 API，无法可靠恢复完整正文、角色、模型名、工具参数/输出、token 用量、精确时间、附件语义和隐藏上下文。

工程实现要求未知字段不丢失：无法语义化的 payload 会以 `raw_protobuf` 形式保留 idx、step_type、status、长度和 SHA-256，不输出原始 bytes。

`agy --conversation` 只作为展示层冒烟验证，不作为完整复原证明。实测中该命令能识别 conversation ID 入口，但即使用假 ID 启动也会刷新 `.db-shm` 修改时间，不是严格只读；终端输出也只代表客户端渲染后的可见内容，不能证明 metadata、protobuf payload、工具原始参数、隐藏上下文等底层字段已完整复原。

## 性能与资源策略

- 发现阶段只扫描 Antigravity conversation 根目录下的 `*.db` 文件。
- 列表阶段使用 `summaryOnly`，最多读取有限 step 用于 preview/cwd 推断。
- SQLite 只读打开：`readonly`、`fileMustExist`、`PRAGMA query_only = ON`、`busy_timeout`。
- 历史 watch 复用现有 `WATCH_DEBOUNCE_MS`、`WATCH_BATCH_LIMIT`、`WATCH_CONCURRENCY`。
- Antigravity watch 只监听根目录 `*.db`，不递归监听子目录，减少无关文件监听成本。
- 详情解析按需触发，并复用已有详情缓存。
- 空会话清理对 Antigravity 采取保守策略：解析失败或存在 skippedLines 时不纳入可清理候选。

## 验证结果

已通过：

- `npm run typecheck:web`
- `npm run build:electron`
- `npm run i18n:check`
- 定向 Vitest：Antigravity discovery/parser/resume command、Provider YOLO、runtime default、worktree prefs、renderer draft recovery、terminal send、TerminalManager 真实发送路径、Antigravity 屏幕 ACK、indexer、changeSaver。
- 修复后定向结果：11 个测试文件、54 个用例通过。

全量 `npm run test` 结果：

- 1139 个测试通过。
- 2 个 Git 相关慢测在全量并发下触发 5 秒用例超时。
- 两个超时用例单独重跑均通过，判断为并发负载下的既有慢测超时，不是 Antigravity 接入回归。

交叉验收：

- 第一轮子代理 1 从功能完整性角度审查，发现 Antigravity 未走 `TerminalManager.sendTextAndEnter()` 的 Gemini 类真实发送路径，结论 FAIL。
- 已修复：`TerminalManager` 对 Antigravity 启用 Gemini 类普通粘贴/屏幕 ACK/延迟回车策略，并补充 Antigravity 的真实路径模拟测试。
- 已修复：`App.tsx` 发送异常兜底也改用 Gemini 类 Provider 判断，避免 Antigravity 在兜底路径退化为普通 PTY 写入。
- 已补齐：设置页“数据与存储”展示 Antigravity 会话根目录，并且只提供打开目录，不提供无证据的规则文件编辑按钮。
- 第一轮子代理 2 从生产可用、性能、隐私、回归、测试覆盖角度审查，结论 PASS。
- 最终交叉验收：2 个干净上下文子代理均 PASS。
  - 子代理 1 从功能完整性角度核验 Provider 顺序、默认命令、YOLO、Worktree、历史、发送路径、设置页、i18n、README 和测试覆盖，结论 PASS。
  - 子代理 2 从生产风险、性能/资源、隐私安全、回归风险、历史能力口径和测试充分性角度核验，结论 PASS。

## 新增/更新测试覆盖

- `electron/agentSessions/antigravity/discovery.test.ts`
- `electron/agentSessions/antigravity/parser.test.ts`
- `web/src/providers/antigravity/commands.test.ts`
- `web/src/lib/providers/yolo.test.ts`
- `electron/providers/runtime.test.ts`
- `web/src/lib/worktree-create-prefs.test.ts`
- `web/src/lib/renderer-draft-recovery.test.ts`
- `web/src/lib/terminal-send.test.ts`
- `web/src/lib/terminal-manager-send.test.ts`

测试使用临时目录和合成 SQLite/载荷，不包含真实会话正文、账号、令牌、邮箱或个人路径。

## 非阻塞风险

- Antigravity 原生规则文件名尚无充分证据，本次未把 Antigravity 加入规则文件编辑入口，避免误导用户。
- 历史 parser 当前是生产可用的轻量解析与 raw fallback 方案；未来如需字段名级完整复原，应继续接入 descriptor 自动映射。
- Antigravity CLI 启动本身可能进行鉴权或网络检查；CodexFlow 不主动发送 prompt，但不能把 `agy --conversation` 声明为完全离线验证。
