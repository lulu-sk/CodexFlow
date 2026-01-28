#!/usr/bin/env node

/**
 * 多 worktree 并行开发启动器：
 * - 自动选择可用端口启动 Vite（避免 5173 冲突）
 * - 为 Electron 传入独立 profile（避免单例锁互相抢占）
 * - 通过 argv 传入 dev server URL（确保 second-instance 转发/拉起时仍能加载正确 worktree 页面）
 *
 * 用法：
 * - npm run dev
 * - npm run dev -- --port 5188
 * - npm run dev -- --profile wt-a
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_BASE_PORT = 5173;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_WAIT_READY_MS = 30_000;

/**
 * 解析命令行参数（仅解析本脚本关注的参数；其它参数将原样透传给 Electron）。
 */
function parseCliArgs(argv) {
  const out = {
    port: null,
    profile: null,
    host: DEFAULT_HOST,
    waitReadyMs: DEFAULT_WAIT_READY_MS,
    passthrough: [],
    showHelp: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.showHelp = true;
      continue;
    }
    if (arg === "--port" || arg === "-p") {
      const next = argv[i + 1];
      i += 1;
      const n = Number(next);
      if (Number.isFinite(n) && n > 0 && n < 65536) out.port = Math.floor(n);
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--port=")) {
      const n = Number(arg.slice("--port=".length));
      if (Number.isFinite(n) && n > 0 && n < 65536) out.port = Math.floor(n);
      continue;
    }
    if (arg === "--profile") {
      const next = argv[i + 1];
      i += 1;
      if (typeof next === "string" && next.trim()) out.profile = next.trim();
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--profile=")) {
      const v = arg.slice("--profile=".length);
      if (v.trim()) out.profile = v.trim();
      continue;
    }
    if (arg === "--host") {
      const next = argv[i + 1];
      i += 1;
      if (typeof next === "string" && next.trim()) out.host = next.trim();
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--host=")) {
      const v = arg.slice("--host=".length);
      if (v.trim()) out.host = v.trim();
      continue;
    }
    if (arg === "--wait-ready-ms") {
      const next = argv[i + 1];
      i += 1;
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.waitReadyMs = Math.floor(n);
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--wait-ready-ms=")) {
      const n = Number(arg.slice("--wait-ready-ms=".length));
      if (Number.isFinite(n) && n > 0) out.waitReadyMs = Math.floor(n);
      continue;
    }
    out.passthrough.push(arg);
  }

  return out;
}

/**
 * 将字符串稳定映射为短 hash（用于生成默认 profileId）。
 */
function shortHash(input, length) {
  const len = Math.max(4, Math.min(32, Math.floor(Number(length) || 8)));
  try {
    return crypto.createHash("sha1").update(String(input || ""), "utf8").digest("hex").slice(0, len);
  } catch {
    // 极端环境 crypto 不可用时回退：仍保证可用但不保证强稳定
    const raw = Buffer.from(String(input || ""), "utf8");
    let acc = 0;
    for (const b of raw) acc = (acc * 131 + b) >>> 0;
    return acc.toString(16).padStart(len, "0").slice(0, len);
  }
}

/**
 * 生成默认 profileId：同一 worktree 目录稳定复用，避免频繁产生新 userData 目录。
 */
function deriveDefaultProfileId(cwd) {
  const h = shortHash(cwd, 10);
  return `wt-${h}`;
}

/**
 * 探测端口是否可用（可监听表示可用）。
 */
function isPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (ok) => {
      try { server.close(); } catch {}
      resolve(ok);
    };
    server.once("error", () => done(false));
    server.listen({ host, port, exclusive: true }, () => done(true));
  });
}

/**
 * 从 basePort 开始向上探测，找到一个可用端口。
 */
async function findAvailablePort(host, basePort, maxTries) {
  const start = Math.max(1, Math.min(65535, Math.floor(Number(basePort) || DEFAULT_BASE_PORT)));
  const tries = Math.max(1, Math.min(500, Math.floor(Number(maxTries) || 50)));
  for (let i = 0; i < tries; i++) {
    const port = start + i;
    if (port >= 65536) break;
    if (await isPortAvailable(host, port)) return port;
  }
  return null;
}

/**
 * 等待端口可连接（用于判定 Vite 已就绪）。
 */
async function waitForPortReady(host, port, timeoutMs) {
  const maxMs = Math.max(200, Math.min(120_000, Math.floor(Number(timeoutMs) || DEFAULT_WAIT_READY_MS)));
  const startAt = Date.now();

  while (Date.now() - startAt < maxMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (v) => {
        try { socket.destroy(); } catch {}
        resolve(v);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(300, () => done(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * 获取当前平台的 npm 可执行文件名。
 */
function resolveNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * 解析用于启动 npm 的命令：
 * - 优先使用 npm 注入的 `npm_execpath`（通过 `node <npm-cli.js>` 启动），避免 Windows 下 `spawn npm.cmd` 兼容性问题
 * - 回退使用 `npm`/`npm.cmd`
 */
function resolveNpmRunner() {
  const npmExecPath = String(process.env.npm_execpath || "").trim();
  if (npmExecPath) {
    return {
      file: process.execPath,
      prefixArgs: [npmExecPath],
    };
  }
  return {
    file: resolveNpmCommand(),
    prefixArgs: [],
  };
}

/**
 * 获取当前平台的 Electron 可执行文件路径（优先使用本地 node_modules）。
 */
function resolveElectronCommand(projectRoot) {
  try {
    // 说明：在 Node 环境下，electron npm 包会导出“electron 可执行文件路径”字符串
    // 这样可以规避 Windows 下 `.cmd` shim 以及 PATH 搜索带来的不确定性
    const electron = require("electron");
    if (typeof electron === "string" && electron.trim()) return electron.trim();
  } catch {}

  // 回退：直接指向 electron 包内的 dist 二进制（跨平台）
  if (process.platform === "darwin") {
    return path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }
  const bin = process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(projectRoot, "node_modules", "electron", "dist", bin);
}

/**
 * 将 Vite 绑定 host 转换为用于本机访问的 host。
 * 说明：当 Vite 绑定到 `0.0.0.0`/`::` 时，`http://0.0.0.0:<port>` 在多数环境不可用；此处自动改用回环地址访问。
 */
function resolveConnectHost(bindHost) {
  const h = String(bindHost || "").trim();
  if (!h) return DEFAULT_HOST;
  if (h === "0.0.0.0") return "127.0.0.1";
  if (h === "::" || h === "[::]") return "::1";
  return h;
}

/**
 * 将 host 安全拼接进 URL（处理 IPv6 的方括号）。
 */
function formatHostForUrl(host) {
  const h = String(host || "").trim();
  if (!h) return DEFAULT_HOST;
  if (h.startsWith("[") && h.endsWith("]")) return h;
  if (h.includes(":")) return `[${h}]`;
  return h;
}

/**
 * 统一格式化 spawn 失败信息，便于定位问题。
 */
function formatSpawnError(err) {
  try {
    const code = err && typeof err === "object" ? err.code : undefined;
    const errno = err && typeof err === "object" ? err.errno : undefined;
    const syscall = err && typeof err === "object" ? err.syscall : undefined;
    const p = err && typeof err === "object" ? err.path : undefined;
    const msg = err && typeof err === "object" && err.message ? err.message : String(err);
    const parts = [
      msg,
      code != null ? `code=${code}` : null,
      errno != null ? `errno=${errno}` : null,
      syscall ? `syscall=${syscall}` : null,
      p ? `path=${p}` : null,
    ].filter(Boolean);
    return parts.join(" ");
  } catch {
    return String(err);
  }
}

/**
 * 打印帮助信息并退出。
 */
function printHelpAndExit(code) {
  // 统一输出中文说明，便于团队使用
  console.log([
    "用法：",
    "  npm run dev",
    "  npm run dev -- --port 5188",
    "  npm run dev -- --profile wt-a",
    "",
    "参数：",
    "  --port/-p <n>          指定 Vite 端口（默认自动选择可用端口）",
    "  --host <host>          指定监听地址（默认 127.0.0.1；当为 0.0.0.0/:: 时将自动用回环地址访问）",
    "  --profile <id>         指定 Electron profileId（默认按 worktree 目录派生）",
    "  --wait-ready-ms <ms>   等待 Vite 就绪的超时时间（默认 30000）",
    "  -h/--help              显示帮助",
    "",
    "说明：",
    "  该命令适合在多个 worktree 中同时运行；每个 worktree 会使用不同端口与不同 profile。",
  ].join("\n"));
  process.exit(code);
}

/**
 * 主入口：启动 Vite 与 Electron，并做就绪等待与退出清理。
 */
async function main() {
  const projectRoot = process.cwd();
  const args = parseCliArgs(process.argv.slice(2));
  if (args.showHelp) printHelpAndExit(0);

  const bindHost = args.host || DEFAULT_HOST;
  const connectHost = resolveConnectHost(bindHost);
  const port = args.port != null ? args.port : await findAvailablePort(bindHost, DEFAULT_BASE_PORT, 100);
  if (!port) {
    console.error(`[dev-worktree] 无法找到可用端口（host=${bindHost} basePort=${DEFAULT_BASE_PORT}）`);
    process.exit(1);
  }

  const profileId = args.profile || deriveDefaultProfileId(projectRoot);
  const devServerUrl = `http://${formatHostForUrl(connectHost)}:${port}`;

  console.log(`[dev-worktree] 使用端口 ${port}，profile=${profileId}，host=${bindHost}，DEV_SERVER_URL=${devServerUrl}`);

  const npmRunner = resolveNpmRunner();
  const electronCmd = resolveElectronCommand(projectRoot);

  const vite = spawn(npmRunner.file, [...npmRunner.prefixArgs, "run", "dev:web", "--", "--port", String(port), "--strictPort", "--host", bindHost], {
    stdio: "inherit",
    cwd: projectRoot,
    env: { ...process.env },
  });

  let electron = null;
  let exiting = false;

  /**
   * 退出清理：尽量结束子进程，避免残留占用端口。
   */
  const cleanupAndExit = (code) => {
    if (exiting) return;
    exiting = true;
    try { vite.kill("SIGINT"); } catch {}
    try { electron?.kill?.("SIGINT"); } catch {}
    process.exit(code);
  };

  process.on("SIGINT", () => cleanupAndExit(130));
  process.on("SIGTERM", () => cleanupAndExit(143));

  vite.on("error", (e) => {
    console.error(`[dev-worktree] Vite 启动失败：${formatSpawnError(e)}`);
    cleanupAndExit(1);
  });

  vite.on("exit", (code) => {
    // Vite 退出则同步退出（Electron 将无法正常加载）
    cleanupAndExit(typeof code === "number" ? code : 1);
  });

  const ready = await waitForPortReady(connectHost, port, args.waitReadyMs);
  if (!ready) {
    console.error(`[dev-worktree] 等待 Vite 就绪超时（${args.waitReadyMs}ms），请检查端口占用或启动日志`);
    cleanupAndExit(1);
    return;
  }

  // 启动 Electron：同时写入 env + argv，确保 second-instance 转发/拉起时也能拿到 dev URL。
  electron = spawn(
    electronCmd,
    [
      ".",
      "--profile", profileId,
      "--dev-server-url", devServerUrl,
      ...args.passthrough,
    ],
    {
      stdio: "inherit",
      cwd: projectRoot,
      env: { ...process.env, DEV_SERVER_URL: devServerUrl },
    }
  );

  electron.on("error", (e) => {
    console.error(`[dev-worktree] Electron 启动失败：${formatSpawnError(e)}`);
    cleanupAndExit(1);
  });

  electron.on("exit", (code) => {
    cleanupAndExit(typeof code === "number" ? code : 0);
  });
}

main().catch((e) => {
  console.error(`[dev-worktree] 启动失败：${String(e)}`);
  process.exit(1);
});
