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

> 生产打包默认关闭详细日志；可在 debug.config.jsonc 打开。

