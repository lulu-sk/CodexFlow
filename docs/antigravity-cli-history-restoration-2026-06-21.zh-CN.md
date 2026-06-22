# Antigravity CLI 会话详情复原研究记录

日期：2026-06-21

本文记录 Antigravity CLI 本地会话历史的真实验证结果、可承诺范围和后续接入方案。验证过程只读本机数据，不包含真实会话正文、账号、令牌、邮箱或完整个人路径。

## 结论

当前能力等级：只能部分复原。

不能承诺“完整复原 Antigravity 原生会话详情”。本地离线文件可以恢复会话文件清单、SQLite 表结构、会话/轨迹 ID、步骤顺序、步骤类型编号、状态编号、部分 protobuf 字段轮廓和统计信息，但不能可靠还原完整正文、角色语义、模型名、工具参数/输出、token/usage、精确时间、附件语义或隐藏上下文。

## 真实验证结果

- 指定会话目录存在，共 13 个文件：4 个 `.db`、4 个 `.db-shm`、4 个 `.db-wal`、1 个 `.pb`。
- 4 个 `.db` 都是 SQLite 数据库；`.db-wal` 均为 0 字节。
- 4 个数据库对应 4 条本地 trajectory；其中 3 条有步骤，1 条只有元数据无步骤。
- 总步骤数：128。
- `steps` 表字段包括：`idx`、`step_type`、`status`、`has_subtrajectory`、`metadata`、`error_details`、`permissions`、`task_details`、`render_info`、`step_payload`、`step_format`。
- `step_type` 分布：`5:7`、`7:6`、`8:19`、`9:1`、`14:6`、`15:61`、`17:1`、`21:17`、`23:2`、`98:3`、`101:5`。
- 所有步骤 `status=3`、`step_format=0`、`has_subtrajectory=0`。
- `metadata` 和 `step_payload` 均为 protobuf wire format，可以解析字段编号、wire type、长度和哈希，但没有稳定 `.proto` 定义或官方 schema 时，不能安全映射为原生字段名和语义。
- `error_details`、`render_info` 均为空；`permissions` 有 6 条；`task_details` 有 5 条。
- 单独的 `.pb` 文件不是 SQLite、不是 gzip/zlib，直接 protobuf 扫描失败；前 4KB 熵约 7.951，更像加密或专有封装数据。
- 未发现 `ANTIGRAVITY_KEY` 环境变量，也未发现可直接用于解密的 `os_crypt`、`encrypted_key`、`DPAPI` 等线索。
- 本机验证时没有运行中的 Antigravity `language_server` 进程，因此无法通过官方本地 API 做命名字段级导出验证。

## 已能复原

- 会话文件数量、类型、大小、时间戳和 hash。
- SQLite 表结构和行数。
- 每条 DB 会话的 `trajectory_id`、`cascade_id`、`trajectory_type=4`、`source=17`。
- 每条会话的步骤序列顺序，可按 `idx` 排序复原。
- 数字级步骤类型、状态、格式、是否有子轨迹。
- protobuf BLOB 的字段编号、wire type、长度、hash 和部分字符串字段存在性。
- 错误字段是否存在；当前样本中 `error_details` 为空。

## 未能完整复原

- 消息正文、角色、标题、完整用户/助手内容。
- 数字 `step_type` 到 Antigravity 原生命名的可靠映射。
- 精确创建时间、每条消息时间。
- 模型/引擎字段、token/usage。
- 工具调用的完整命令、参数、输出、退出码、文件 diff、搜索结果。
- 附件或文件引用的完整语义。
- 单独 `.pb` 文件内容。

## `agy --conversation` 对照法边界

`agy --conversation <conversationId>` 可以作为辅助验证入口，但不能证明完整复原。

已验证：

- `agy` 存在，版本为 `1.0.10`。
- `agy --help` 明确包含 `--conversation`，说明为按 ID 恢复历史会话。
- 本地 `.db` 文件名是 UUID，等于库内 `trajectory_meta.cascade_id`，不等于 `trajectory_id`。
- 假 ID 启动会被 `agy` 识别，并提示 conversation not found。

限制：

- 没有直接运行真实 ID，因为即使用假 ID、`--log-file NUL`、阻断代理并短超时启动，`agy` 仍会刷新原会话目录中多个 `.db-shm` 文件修改时间，说明启动不是严格只读。
- 终端显示的是 Antigravity 客户端渲染后的展示层内容，不是数据库和 protobuf payload 的完整语义。
- 终端可见内容即使与本地解析结果一致，也只能证明展示层可见片段一致，不能证明隐藏上下文、工具原始参数、metadata、摘要缓存、二进制 payload 等底层字段完整一致。

## 最小风险验证方案

如果后续必须做真实会话 ID 对照，应在隔离环境中完成：

1. 复制完整 Antigravity 会话数据目录到临时副本，原始数据只读保存。
2. 在一次性环境运行，例如临时 Windows 用户、虚拟机快照或 Windows Sandbox。
3. 禁网运行，避免客户端访问远端、同步、上报或刷新会话。
4. 不输入任何 prompt，只执行 `agy --conversation <cascade_id>` 并记录初始终端展示。
5. 设置明确超时时间，避免进程长期挂起。
6. 对比时只使用脱敏指标，例如消息数量、顺序、长度、短 hash、step id 是否匹配。
7. 实验结束后丢弃副本，不把 `.db-shm`、`.db-wal` 等运行后变化文件回写到原始目录。

该实验仍只能验证“终端可见展示层的一致性”，不能提升为“完整复原”的证明。

## 工程接入口径

CodexFlow 应把 Antigravity 历史详情能力描述为：

> 支持基于本地会话数据库进行离线索引与部分复原，可识别会话 ID、步骤顺序、部分状态、结构字段和若干可见历史线索；在缺少官方 schema/protobuf 定义的情况下，不保证恢复完整正文、工具调用详情、模型信息、用量统计、附件语义或隐藏上下文。

实现上应保留 raw fallback：无法语义化的 payload 只保留字段编号、长度、hash 和必要状态摘要，不输出原始 bytes，不泄露真实会话正文。
