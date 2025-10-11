English | [简体中文](./CONTRIBUTING.zh-CN.md)

# Contributing to CodexFlow

Thank you for your interest in CodexFlow. Please read this guide to keep contributions safe, maintainable, and consistent.

- License: by contributing you agree to license your work under Apache-2.0. Any redistribution must include both `LICENSE` and `NOTICE` files.

## Communication & Triage

- Q&A and general discussion: use GitHub Discussions (categories like Q&A, Ideas, Show & Tell).
- Bugs and feature requests: open GitHub Issues using the provided templates.
- Security issues: do not open public issues. Follow SECURITY.md for private reporting.
- PR policy: for non-trivial changes, please open an Issue first to align scope. Small fixes/docs can go straight to PR.
- Branch protection & reviews: all contributions must go through Pull Requests and require maintainer review/approval before merge. The default branch is protected; do not force-push to it.
- SLA: maintainers usually respond within 3–5 days.

## Developer Workflow

- Install: `npm i` (compiles Electron main to `dist/electron` and rebuilds native deps).
- Dev: `npm run dev` (start Vite and Electron together).
- Build: `npm run build` (equivalent to `npm run build:web && electron-builder`).
- Rebuild main only: `npx tsc -p tsconfig.electron.json`.
- Electron version changes or ABI issues: `npm run postinstall` to rebuild native modules such as `node-pty`.

## Repository Layout & Boundaries

- `electron/`: main (`main.ts`), preload (`preload.ts`), PTY bridge (`pty.ts`), WSL/path utils (`wsl.ts`), `settings`, `projects`, `history`, `fileIndex`, `log`.
  - Projects entry point: `electron/projects/index.ts` currently re-exports the `projects.fast.ts` implementation. To switch, only change this entry.
  - Boot log: writes a line to `perf.log`: `[BOOT] Using projects implementation: fast` to confirm the active implementation.
  - Import note: always `import projects from "./projects/index"` in main to avoid resolving a peer `projects.ts` file.
- `web/`: Vite + React + Tailwind. Key paths: `src/components/ui/*`, `src/adapters/TerminalAdapter.tsx`, `src/lib`, `src/types`.
- Root config: `package.json`, `tsconfig*.json`, `tailwind.config.js`, `postcss.config.js`.

## Code Style & Naming

- TypeScript strict mode; 2 spaces; double quotes; semicolons.
- Naming: functions `camelCase`, types `PascalCase`, constants `UPPER_SNAKE`.
- React: filenames lowercase (e.g. `button.tsx`), export PascalCase components (e.g. `Button`).
- Exports: prefer named exports; avoid unnecessary defaults.
- Imports (web): use alias `@` for `web/src` (e.g. `@/components/ui/button`).
- IPC: channel names `module.action` or `module:event`; return `{ ok: boolean, ... }` across processes—avoid throwing through IPC.
- Host API surface: expose the minimum in `preload.ts`, and keep `web/src/types/host.d.ts` in sync.

## Security Rules (must not break)

- Renderer must not access Node APIs directly; all capabilities go through `contextBridge.exposeInMainWorld`.
- Keep `contextIsolation: true` and `nodeIntegration: false`.
- Validate IPC inputs and apply least-privilege design; avoid arbitrary FS access and command injection.

## Windows + WSL Paths

- For Windows absolute paths like `C:\\Users\\you\\code\\app` and UNC like `\\\\wsl.localhost\\Distro\\path`:
  - In main: use `electron/wsl.ts` helpers `winToWsl`, `uncToWsl`, and `execInWsl` variants.
  - In web: follow existing rules in `web/src/lib/wsl.ts`, `lib/dragDrop.ts`, and `components/ui/path-chips-input.tsx` for parsing/paste/drag.

## i18n Gate (required)

- Baseline UI language is `en`. Resources live at `web/src/locales/<lng>/<namespace>.json` using i18next + ICU.
- Any new UI string must update `en` and, when possible, keep `zh` in sync.
- Before committing: run `npm run i18n:report` (diff) and `npm run i18n:check` (strict). A Husky pre-commit hook already enforces `i18n:check`.

## DCO Sign-off (required)

- All commits must be signed off to affirm the Developer Certificate of Origin.
- Use: `git commit -s -m "feat: add foo"`.
- If you forgot: `git commit --amend -s` and force-push the branch.
- Enforcement: the repository installs the DCO GitHub App; PRs without valid sign-offs will be blocked by checks.

## Branching & Merging Rules

- Create topic branches: `feat/*`, `fix/*`, etc. Don’t commit to `main`.
- No force-push to protected branches. For your own PR branches, prefer `--force-with-lease` only when necessary (e.g., to add missing `-s`). Avoid history rewrites after review has started.
- Prefer Squash & Merge unless preserving history is essential.

## PR Content & Self-check

- Branch names: `feat/<short>`, `fix/<short>`, `chore/<short>`, `docs/<short>`, `refactor/<short>`, `test/<short>`.
- Conventional commits are encouraged: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`.
- A good PR explains the motivation/scope, impacted modules, migration notes, UI screenshots/video (if applicable), and whether `postinstall` is needed.
- Pre-merge checklist:
  - Build/dev run pass. If `electron/*` changed, ensure it compiles to `dist/electron`.
  - i18n checks pass. Remove unused code and any debug/noise logs. You may use the `perfLogger` for local diagnosis but avoid committing noisy traces.
  - Source files include the project’s copyright header where applicable. Do not break renderer security.
  - Windows/WSL path handling is correct. If Projects entry changes, update `electron/projects/index.ts` and verify the boot log line.

## Release & Versioning

- We follow SemVer: `MAJOR.MINOR.PATCH`.
- Tags: use `vX.Y.Z` and create a GitHub Release with notes.
- Release checklist (minimum):
  - `npm ci && npm run build` on a clean workspace.
  - If Electron version changed: run `npm run postinstall` to rebuild native deps (`node-pty`, etc.).
  - Verify artifacts include `LICENSE` and `NOTICE` as configured in `package.json > build.files`.
  - Verify perf and basic flows on Windows 11 + WSL default distro.
  - Run `npm run i18n:check`; update docs/screenshots if UI changed.
  - Ensure preload surface remains minimal and type-safe; review IPC inputs.

— Thanks for contributing! Keep changes focused, testable, and reversible to speed up reviews and merges.
