TerminalManager (轻量说明)

目的
- 将渲染进程中关于 xterm 适配器、持久化 DOM 容器及 PTY I/O 桥接的逻辑封装，便于复用、测试与提取为独立包。

导出
- 默认导出 `TerminalManager` 类
- 同时导出 `HostPtyAPI` 类型用于外部注入宿主 PTY 实现

构造
- new TerminalManager(getPtyId?: (tabId)=>ptyId, hostPty?: HostPtyAPI)
  - `getPtyId`：根据 tabId 获取当前绑定 PTY id 的回调（通常从上层 state 传入）
  - `hostPty`：实现 PTY I/O 的对象（默认为 window.host.pty）

主要方法
- ensurePersistentContainer(tabId): HTMLDivElement
- setPty(tabId, ptyId): void
- attachToHost(tabId, hostEl): void
- disposeTab(tabId, alsoClosePty = true): void
- disposeAll(alsoClosePty = true): void

使用示例（简要）
```ts
const tm = new TerminalManager((tabId) => ptyByTabRef.current[tabId]);
// 新建 pty 后
tm.setPty(tabId, ptyId);
// tab 激活时
tm.attachToHost(tabId, hostEl);
// 关闭 tab 时
tm.disposeTab(tabId);
```

迁移建议
- 若要提取为独立包：将 `createTerminalAdapter` 抽成 peerDependency（或提供接口注入），并把 HostPtyAPI 作为必需注入项，避免直接依赖 `window.host`。


