# CLI Hook 会话结束检测调研（2026-05-29）

## 结论

CodexFlow 用 hook 判断“本轮代理是否完成”，核心目标不是判断 CLI 进程退出，而是判断一次用户请求对应的 agent turn 已经结束。

- Claude Code：继续使用 `Stop` 判断主代理完成，机制正确。
- Gemini CLI：继续使用 `AfterAgent` 判断本轮代理完成，机制正确。
- OpenAI Codex：新版应使用 `Stop` 判断主代理完成；`SubagentStop` 只能作为“子代理完成”提醒，不能结束主任务计时。旧版不支持新版 hooks 时才回退到 legacy `notify`。

## OpenAI Codex

### 当前可用 hook

本地源码 `G:\Projects\OpenAICodex\codex\codex-rs\hooks\src\lib.rs` 列出的事件：

- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `PreCompact`
- `PostCompact`
- `SessionStart`
- `UserPromptSubmit`
- `SubagentStart`
- `SubagentStop`
- `Stop`

配置格式在 `config.toml` 的 `[hooks]` 下，例如：

```toml
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "node /path/to/codexflow_lifecycle_notify.cjs"
timeout = 5
```

### 对“会话结束”的准确性

`core/src/hook_runtime.rs` 的 `run_turn_stop_hooks` 逻辑明确区分：

- 根线程/root turn 结束：触发 `Stop`
- thread-spawned 子代理结束：触发 `SubagentStop`
- 内部/合成子代理：不暴露用户 lifecycle hook

因此 CodexFlow 的主任务完成检测应只把 `Stop` 当作结束信号。`SubagentStop` 如果当成主任务结束，会在子代理回复完成时提前中断主任务计时。

TUI 中用户按 `Esc` 主动中断属于前端中断计时场景，不应依赖 `Stop`。从 Codex 源码路径看，`Stop` 是正常 turn stop hook；主动 abort 不等价于正常完成。

### 版本策略

CodexFlow 采用保守阈值：

- `Stop`：Codex CLI `>= 0.116.0`
- `SubagentStop`：Codex CLI `>= 0.133.0`

实际运行时会执行 `codex --version`（兼容 `npx @openai/codex...` 启动命令）判断。如果探测失败或版本过低，不写新版 hooks，继续使用 legacy `notify`。

新版 hooks 支持信任状态，CodexFlow 写入 `hooks.state` 的 `trusted_hash`，避免用户每次手动确认自己的 CodexFlow lifecycle hook。

## Claude Code

### 常见 hook

本地 `G:\Projects\claude-code\plugins\plugin-dev\skills\hook-development\SKILL.md` 与校验脚本列出核心事件：

- `PreToolUse`
- `PostToolUse`
- `UserPromptSubmit`
- `Stop`
- `SubagentStop`
- `SessionStart`
- `SessionEnd`
- `PreCompact`
- `Notification`

### 对“会话结束”的准确性

Claude Code 的 `Stop` 是主代理准备停止时触发，适合作为 CodexFlow 的主任务完成信号。`SubagentStop` 是子代理停止，语义上不能结束主任务计时。

CodexFlow 当前 Claude 逻辑写 `Stop` hook 并监听 JSONL，是正确方向。

## Gemini CLI

### 当前可用 hook

本地 `G:\Projects\gemini-cli\docs\hooks\reference.md` 中包含：

- `BeforeTool`
- `AfterTool`
- `BeforeAgent`
- `AfterAgent`
- `BeforeModel`
- `AfterModel`
- `BeforeToolSelection`
- `SessionStart`
- `SessionEnd`
- `Notification`
- `PreCompress`

### 对“会话结束”的准确性

Gemini 的 `AfterAgent` 文档定义为“每轮模型生成最终响应之后触发”，适合判断本轮代理完成。`SessionEnd` 是 CLI 退出或清理会话，不适合用来判断每次任务完成。

CodexFlow 当前 Gemini 逻辑写 `AfterAgent` hook 并监听 JSONL，是正确方向。

## CodexFlow 当前实现

- Codex：根据实际 Codex CLI 版本选择新版 `Stop`/`SubagentStop` hooks 或旧 `notify`。
- Claude：使用 `Stop` hook。
- Gemini：使用 `AfterAgent` hook。
- `SubagentStop` 通知默认关闭；开启后通知内容会明确标记“子代理”，并尽量带 `agent_type` / `agent_id`。
- `SubagentStop` 不结束主任务计时、不增加主任务完成徽标、不触发自动提交。
