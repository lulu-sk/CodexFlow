# 诊断日志开关与定位指南

为便于定位白屏/加载失败等问题，我们提供“可开可关”的诊断日志。

## 开关

- 主进程：设置环境变量开启（默认关闭）
  - Windows PowerShell: `$env:CODEX_DIAG_LOG='1'; npm run dev`
  - CMD: `set CODEX_DIAG_LOG=1 && npm run dev`
- 渲染进程：本地存储开关（默认关闭）
  - 在 DevTools 中执行：`localStorage.setItem('CF_DIAG_LOG','1')`
  - 关闭：`localStorage.removeItem('CF_DIAG_LOG')`

## 日志位置

- 文件：`%APPDATA%/codexflow/perf.log`
- 内容（示例）：
  - `[WIN] loadURL ...` / `[WIN] loadFile ...`
  - `[WC] did-fail-load ...` / `[WC] did-finish-load`
  - `[WC.console] ...`（渲染端 console 输出）
  - `[renderer:error]` / `[renderer:unhandledrejection]`

> 生产打包默认关闭详细日志；必要时设置主进程环境变量启用。

