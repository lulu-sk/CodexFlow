# Windows Codex 多行输入丢失换行调查

## 结论

这是 CodexFlow 发送方式与 Codex CLI 的 Windows 输入后端之间的兼容问题，正文在到达模型请求前就已经丢失换行，并非历史消息的显示问题。

在 Windows 的 ConPTY（伪终端）中，Codex 使用 Crossterm 的 Win32 按键记录后端。该后端不能像 Unix 的字节流解析器一样，将显式 bracketed paste（带边界标记的粘贴）直接转换成完整粘贴事件。不能仅靠 `ESC[200~ ... ESC[201~` 保护正文里的换行。

CodexFlow 直接写入的 `LF`（`\n`）在这条输入链路中丢失；简单换成 `CR`（`\r`）或 `CRLF` 也不可靠，可能把正文中的换行当成提交。

## Git 历史证据

| 仓库 | 提交 | 相关行为 |
| --- | --- | --- |
| CodexFlow | `ea3eec1`，2026-03-25 | 为避免多行被拆成多条消息，Windows Codex 开始绕过终端组件，直接发送带边界标记的原始文本，覆盖自动提交与仅写入。 |
| CodexFlow | `ef80006`，2026-04-29 | 多行文本开始等待屏幕确认，并延迟提交；未改变正文换行编码。 |
| CodexFlow | `533aaa0`，2026-08-10 | 显式粘贴扩大到所有非空 Windows Codex 正文。 |
| CodexFlow | `25490b8`，2026-08-10 | 根据实际回显等待粘贴保护窗口结束；解决提交抢跑，但未改变换行编码。 |
| Codex CLI | `36912ce3de`，2026-05-04 | 将 Windows 粘贴突发检测的字符间隔由 30ms 改回 8ms；历史说明明确提到 Windows 多行粘贴曾被误判成提交。 |
| Codex CLI | `bbad09a83b`，2026-07-21 | 启动及轮询时强制恢复 Win32 输入记录模式，避免导航键变成转义字符。 |
| Codex CLI | `58d2daba45`，2026-08-14 | 更新 Crossterm 固定版本并加强启动阶段输入处理。当前依赖为 `45fecb9508105988f42fe6ff0441783ed3717f92`。 |
| Codex CLI | `3685a61dad`，2026-08-15 | 在已收到粘贴事件后先合并 CRLF，再转换 CR，防止双换行。无法恢复输入后端已经丢失的 LF。 |

以上历史能说明兼容问题的形成过程，但未逐一运行历史版本，不能把首次出现时间归因于某个升级版本。已在本机 Codex CLI **0.155.0** 实际复现。调查时 Codex 源码为 `7498521d28`，仅只读访问。

对应源码位置：

- CodexFlow：`web/src/lib/TerminalManager.ts` 的 `sendText`、`sendCodexWindowsFastTextAndEnter`、`sendCodexWindowsTextAndEnter`。
- 终端组件：`@xterm/xterm/src/browser/Clipboard.ts` 的 `prepareTextForTerminal` 会把 LF/CRLF 转为 CR，但这里不能直接复用普通回车。
- Codex：`codex-rs/tui/src/tui/windows_console.rs`、`tui/event_stream.rs`、`keymap.rs`、`bottom_pane/chat_composer/paste_input.rs`。
- Crossterm 固定版本：`src/event/source/windows.rs` 读取控制台输入记录；`src/event/sys/windows/parse.rs` 按虚拟键码解析回车和控制字符。

## 修复边界

在公共发送工具 `buildBracketedPastePayload` 中增加可选的目标 CLI 和终端环境。仅对 Windows Codex，将正文的 CRLF、LF、CR 各转换成一次 `Alt+Enter`（`ESC + CR`），由 ConPTY 解码成 Codex 默认支持的“插入换行”按键。

正文转换在写入终端前进行，屏幕确认、草稿和长度计算继续使用原始文本。最终提交仍单独发送 Enter，并保留原有等待策略。发送、仅写入、输入区异常兜底均复用同一编码；异常兜底也保留必要的粘贴保护等待。

不改变单行文本、WSL、Claude、Gemini、Antigravity、Grok 的正文编码，不修改 Codex 源码或用户配置，不增加版本号判断。

## 验证方法与结果

真实验证使用项目的 node-pty 和已安装的 Codex 0.155.0，每个用例使用独立临时工作目录及独立配置。模型服务指向本机 HTTP 模拟服务，通过截获 `/responses` 请求检查正文；不调用真实模型。粘贴后等待，再单独发送提交键，并记录请求是否提前发生。

| 输入方式 | 实际模型请求中的正文 |
| --- | --- |
| 原实现：带粘贴边界的 `你好\n牛号\n你好` | `你好牛号你好` |
| 仅把 LF 换成 CR 或 CRLF | 提前提交第一行 `你好` |
| 修复后的 Windows 编码 | `你好\n牛号\n你好`，在最终提交后才产生请求 |
| 修复后的空行、混合换行、空格缩进、英文、表情、代码片段 | 与规范化为 LF 的预期正文一致 |
| 修复后的超过 3000 字符多行文本 | 正文完整，空行与行尾内容保留 |
| 修复后的单行文本 | 正文保持原样 |

回归单测覆盖三种 Windows 终端配置、无适配器发送、仅写入、提交时序、末尾换行、WSL 以及其他 CLI 的兼容边界。此验证覆盖默认 Codex 换行快捷键；用户自定义取消 `Alt+Enter` 绑定的情况不在实测范围内。

工程检查结果：

- `terminal-send.test.ts` 21 项、`terminal-manager-send.test.ts` 29 项全部通过，包含本次新增的 16 项回归用例。
- 前端类型检查、`npm run i18n:check`、`npm run build:web`、`git diff --check` 通过；前端构建产物已刷新。
- 全量测试出现两项历史索引失败：`electron/indexer.test.ts:133` 和 `:537`。导出修复前的 `HEAD`（`d8288b2`）到独立目录后，两项失败同样复现；未扩展修改索引模块。
- 全量测试另一次运行在 300 秒上限后终止，未取得完整汇总，不能宣称全量测试通过。相关发送测试和上述两项失败的独立对照均已完成。
