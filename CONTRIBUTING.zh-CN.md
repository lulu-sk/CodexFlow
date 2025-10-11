简体中文 | [English](./CONTRIBUTING.md)

# CodexFlow 贡献指南

感谢你对 CodexFlow 的关注与贡献。为保证安全、可维护与一致性，请在提交前阅读本指南。

- 许可：一旦贡献，你的代码与文档即默认按 Apache-2.0 授权；任何再分发请附带 `LICENSE` 与 `NOTICE` 文件。

## 沟通与分流

- 问答/想法：请使用 GitHub Discussions（建议分类：Q&A、Ideas、Show & Tell）。
- Bug / 功能请求：请在 GitHub Issues 中按模板提交。
- 安全问题：请勿开公开 Issue。参见 SECURITY.md，使用私下渠道。
- PR 策略：除小型修复/文档外，建议先开 Issue 对齐范围与方案。
- 分支保护与评审：所有改动均须通过 Pull Request，并在维护者审核通过后合并。默认分支已开启保护，禁止强推。
- 响应 SLA：通常在 3–5 天内回复。

## 开发流程

- 安装依赖：`npm i`（会编译主进程到 `dist/electron` 并重建原生依赖）。
- 启动开发：`npm run dev`（同时启动 Vite 与 Electron）。
- 生产构建：`npm run build`（等价 `npm run build:web && electron-builder`）。
- 仅重新编译主进程：`npx tsc -p tsconfig.electron.json`。
- 若 Electron 版本变更或 ABI 异常：执行 `npm run postinstall` 重建 `node-pty` 等原生模块。

## 目录结构与边界

- `electron/`：主进程（`main.ts`）、预加载（`preload.ts`）、PTY 桥（`pty.ts`）、WSL/路径工具（`wsl.ts`）、`settings`、`projects`、`history`、`fileIndex`、`log`。
  - Projects 统一入口：`electron/projects/index.ts` 当前默认导出 `projects.fast.ts`。切换实现仅需修改此入口。
  - 启动日志：`perf.log` 会写入一行 `[BOOT] Using projects implementation: fast` 以确认实现。
  - 导入提示：主进程需显式 `import projects from "./projects/index"`，避免解析到同名文件 `projects.ts`。
- `web/`：Vite + React + Tailwind。关键路径：`src/components/ui/*`、`src/adapters/TerminalAdapter.tsx`、`src/lib`、`src/types`。
- 根配置：`package.json`、`tsconfig*.json`、`tailwind.config.js`、`postcss.config.js`。

## 代码风格与命名

- TypeScript 严格模式；2 空格缩进；双引号；分号。
- 命名：函数 `camelCase`，类型 `PascalCase`，常量 `UPPER_SNAKE`。
- React：文件名小写（如 `button.tsx`），导出 PascalCase 组件（如 `Button`）。
- 导出：优先具名导出；避免不必要的默认导出。
- 导入（Web）：使用别名 `@` 指向 `web/src`（如 `@/components/ui/button`）。
- IPC：通道名 `模块.动作` 或 `模块:事件`；跨进程返回 `{ ok: boolean, ... }`，避免抛错穿透。
- Host API：仅在 `preload.ts` 暴露必要最小能力；同步维护 `web/src/types/host.d.ts` 类型。

## 渲染安全（必须遵守）

- 渲染进程不得直接访问 Node API；一切能力通过 `contextBridge.exposeInMainWorld` 桥接。
- 保持 `contextIsolation: true` 与 `nodeIntegration: false`。
- 新增 IPC 必须做参数校验与最小权限设计；避免任意文件读写与命令注入。

## Windows + WSL 路径

- 对 Windows 绝对路径（如 `C:\\Users\\you\\code\\app`）和 UNC（如 `\\\\wsl.localhost\\Distro\\path`）：
  - 主进程：使用 `electron/wsl.ts` 的 `winToWsl`、`uncToWsl`、`execInWsl` 系列工具。
  - Web：遵循 `web/src/lib/wsl.ts`、`lib/dragDrop.ts`、`components/ui/path-chips-input.tsx` 的既有解析与交互规则。

## i18n（提交门禁）

- UI 基线语言为 `en`，资源位于 `web/src/locales/<lng>/<namespace>.json`（i18next + ICU）。
- 新增文案须同步更新 `en`，并尽可能补全 `zh`。
- 提交前：运行 `npm run i18n:report`（差异）与 `npm run i18n:check`（严格）。Husky pre-commit 已强制 `i18n:check`。

## DCO（必须签署）

- 所有提交需签署开发者原始证明（Developer Certificate of Origin）。
- 命令：`git commit -s -m "feat: add foo"`。
- 如忘记签署：`git commit --amend -s` 后强推分支。
- 执行方式：仓库将安装 DCO GitHub App，PR 若缺少有效签署会被校验阻断。

## 分支与合并规则

- 使用主题分支：`feat/*`、`fix/*` 等，勿直接提交到 `main`。
- 禁止对受保护分支强推。个人 PR 分支如因补签 `-s` 等必要情况需改写历史，请使用 `--force-with-lease`，并尽量避免在评审开始后重写历史。
- 合并方式：优先使用 Squash & Merge，除非确需保留详细历史。

## PR 内容与自检

- 分支命名：`feat/<short>`、`fix/<short>`、`chore/<short>`、`docs/<short>`、`refactor/<short>`、`test/<short>`。
- 建议遵循 Conventional Commits：`feat:`、`fix:`、`docs:`、`refactor:`、`chore:`、`test:`。
- PR 应说明动机/范围、影响模块、迁移注意、UI 截图/录屏（如适用）、以及是否需要 `postinstall`。
- 合并前自检：
  - 构建/运行通过；若改动 `electron/*`，确认已编译到 `dist/electron`。
  - i18n 检查通过；移除未使用代码与调试/噪声日志。可用 `perfLogger` 本地诊断，但避免提交噪声痕迹。
  - 源码文件含统一版权声明（适用的源文件）；勿破坏渲染安全。
  - Windows/WSL 路径处理正确。若 Projects 入口调整，请改 `electron/projects/index.ts` 并确认启动日志行生效。

## 发布与版本

- 采用 SemVer：`MAJOR.MINOR.PATCH`。
- 打 Tag：使用 `vX.Y.Z`，并创建对应 GitHub Release 与变更说明。
- 发布自检（最小）：
  - 在干净工作区执行 `npm ci && npm run build`。
  - 若 Electron 版本变更：执行 `npm run postinstall` 重建原生依赖（如 `node-pty`）。
  - 校验产物包含 `LICENSE` 与 `NOTICE`（见 `package.json > build.files`）。
  - 在 Windows 11 + 默认 WSL 发行版验证基础流程与性能。
  - 运行 `npm run i18n:check`；若 UI 有变化，同步更新文档/截图。
  - 确认 `preload` 暴露面保持最小且类型安全；核对 IPC 入参校验。

—— 感谢你的贡献！保持改动聚焦、可验证、可回退，有助于快速评审与合并。
