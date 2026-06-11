# 诊断日志开关与定位指南（已统一到 debug.config.jsonc）

自 vNext 起，所有诊断/调试开关已收敛到 `%APPDATA%/codexflow/debug.config.jsonc`：

- 主进程/渲染诊断：`global.diagLog: true`
- 启动强制打开 DevTools：`global.openDevtools: true`

保存后主进程会热加载并广播，少数标注“需重启”的项在下次启动生效。

## 日志位置

- 文件：`%APPDATA%/codexflow/perf.log`
- 内容（示例）：
  - `[WIN] loadURL ...` / `[WIN] loadFile ...`
  - `[WC] did-fail-load ...` / `[WC] did-finish-load`
  - `[WC.console] ...`（渲染端 console 输出）
  - `[renderer:error]` / `[renderer:unhandledrejection]`
  - `[main.eventLoop.blocked]`：主进程事件循环被阻塞，通常指向同步 I/O、CPU 密集任务或原生调用卡住
  - `[main.ipc.slow]`：某个主进程 IPC handler 执行超过阈值，可直接看 `channel=...`
  - `[ipc.invoke.slow]`：渲染侧等待某个 IPC 返回超过阈值，用于和 `[main.ipc.slow]` 对齐
  - `[renderer.runtime] eventLoop.blocked` / `longTask`：渲染进程主线程卡住，通常指向 React 渲染、布局、xterm 写入或同步 JS 任务

## 排查短暂停顿

1. 打开 `%APPDATA%/codexflow/debug.config.jsonc`，将 `global.diagLog` 改为 `true`。
2. 保存配置后复现“卡死几秒”的场景。
3. 查看 `%APPDATA%/codexflow/perf.log` 中同一时间段的标签：
   - 只有 `[renderer.runtime]`：优先排查前端同步计算、DOM/布局、终端渲染。
   - 有 `[main.eventLoop.blocked]`：优先排查主进程同步任务。
   - 有 `[main.ipc.slow]` 且 `channel=...` 明确：优先排查对应 IPC handler。
   - 只有 `[ipc.invoke.slow]`：说明渲染侧等待 IPC 很久，但主进程 handler 本身未记录慢日志，需继续看主进程是否事件循环阻塞或外部进程/系统调用等待。
4. 排查结束后将 `global.diagLog` 改回 `false`，避免持续写入普通性能诊断日志。

> 生产打包默认关闭详细日志；可在 debug.config.jsonc 打开。

