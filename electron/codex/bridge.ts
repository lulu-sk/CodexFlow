// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { perfLogger } from "../log";
import { getDebugConfig } from "../debugConfig";
import { winToWsl } from "../wsl";
import { resolveCodexAuthJsonPathAsync } from "./authPath";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export type CodexAccountInfo = {
  authMode?: string | null;
  accountId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
};

export type CodexRateLimitWindow = {
  usedPercent: number | null;
  limitWindowSeconds: number | null;  // 原始字段（秒），UI 层转换为分钟/小时/天
  resetAfterSeconds: number | null;   // 原始字段，统一命名
  resetsAt?: number | null;           // 绝对重置时间（秒），避免缓存展示随刷新漂移
};

export type CodexRateLimitSnapshot = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

const INITIALIZE_ID = "cf-init";
const ORIGINATOR = "codex_vscode";
const CLIENT_INFO = { name: "CodexFlow", title: "CodexFlow", version: "0.0.0" };
const REQUEST_TIMEOUT_MS = 20_000;

export type CodexBridgeOptions = {
  mode?: "native" | "wsl";
  wslDistro?: string;
};

type AuthPayload = {
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_user_id?: string;
    user_id?: string;
    chatgpt_plan_type?: string;
  };
  "https://api.openai.com/profile"?: { email?: string };
};

// 代理配置已移至 main.ts 应用初始化阶段统一设置

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

const CLI_EXIT_ERROR_CODE = "CODEX_CLI_EXITED";
const CLI_EXIT_ERROR_NAME = "CodexCliExitedError";
const CLI_EXIT_ERROR_MESSAGE = "Codex CLI exited unexpectedly";
function createCliExitedError(): Error {
  const error = new Error(`${CLI_EXIT_ERROR_MESSAGE} (${CLI_EXIT_ERROR_CODE})`);
  error.name = CLI_EXIT_ERROR_NAME;
  (error as Error & { code?: string }).code = CLI_EXIT_ERROR_CODE;
  return error;
}

function compareSemver(a: string, b: string): number {
  const ap = a.split(".").map((v) => Number.parseInt(v, 10));
  const bp = b.split(".").map((v) => Number.parseInt(v, 10));
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i += 1) {
    const ai = Number.isFinite(ap[i]) ? ap[i] : 0;
    const bi = Number.isFinite(bp[i]) ? bp[i] : 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

/**
 * 通过 where.exe 查找 npm 全局安装的 codex，解析脚本定位 vendor 目录
 */
function findCodexViaWhereExe(mode: "native" | "wsl"): string | null {
  if (process.platform !== "win32") return null;
  
  try {
    // 使用 where.exe 查找 codex（极快，C 实现）
    const output = execFileSync("where.exe", ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    
    // 依次尝试每一个 where.exe 的结果，直到成功
    for (const entry of lines) {
      const codexPath = entry;
      if (!fs.existsSync(codexPath)) continue;

      const lower = codexPath.toLowerCase();
      const isExe = lower.endsWith(".exe");

      if (mode === "native" && isExe) return codexPath;

      // 如果 where.exe 直接指向 vendor 下的二进制，则直接使用
      if (/node_modules[\\/]@openai[\\/]codex[\\/]vendor[\\/]/i.test(lower)) {
        // 校验是否与当前模式匹配（WSL 需要 linux 可执行，Windows 需要 exe）
        if (mode === "wsl" && !isExe) {
          // 假设为 linux 可执行
          perfLogger.log(`[codex] Using vendor binary (direct): ${codexPath}`);
          return codexPath;
        }
        if (mode === "native" && isExe) {
          perfLogger.log(`[codex] Using vendor binary (direct): ${codexPath}`);
          return codexPath;
        }
        // 否则继续尝试下一个
        continue;
      }

      // 读取脚本内容，兼容 .cmd/.bat/.ps1/.sh 等
      let scriptContent = "";
      try {
        scriptContent = fs.readFileSync(codexPath, "utf8");
      } catch {
        // 某些 .cmd 是二进制或不可读，跳过
        continue;
      }

      // 解析脚本中的 node_modules 路径片段（兼容反斜杠与正斜杠）
      const hasNodeModulesRef = /node_modules[\\\/]@openai[\\\/]codex/i.test(scriptContent);
      if (!hasNodeModulesRef) continue;

      // 脚本所在目录即为 npm 全局 bin 目录（%~dp0 / $basedir）
      const binDir = path.dirname(codexPath);
      const vendorDir = path.join(binDir, "node_modules", "@openai", "codex", "vendor");
      // 新版 npm 包将二进制拆到了可选的平台包，旧版仍放在 vendor 内。
      const packageName = mode === "wsl"
        ? (process.arch === "arm64" ? "codex-linux-arm64" : "codex-linux-x64")
        : (process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64");
      const platformVendor = path.join(binDir, "node_modules", "@openai", packageName, "vendor");
      const nestedVendor = path.join(binDir, "node_modules", "@openai", "codex", "node_modules", "@openai", packageName, "vendor");
      const selected = [vendorDir, platformVendor, nestedVendor]
        .map((dir) => selectVendorBinary(dir, mode)).find(Boolean);
      if (selected) {
        perfLogger.log(`[codex] Found via where.exe: ${selected}`);
        return selected;
      }
    }
  } catch (err) {
    // where.exe 失败或解析失败，静默降级到插件目录查找（仅在主进程调试开启时记录）
    try {
      if (getDebugConfig()?.global?.diagLog) {
        perfLogger.log(`[codex] where.exe lookup failed: ${String(err)}`);
      }
    } catch {}
  }
  
  return null;
}

// 在 npm vendor 目录中选择最匹配的二进制（按架构/平台自适应，而非硬编码子目录名）
function selectVendorBinary(vendorDir: string, mode: "native" | "wsl"): string | null {
  try {
    const entries = fs.readdirSync(vendorDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const subdirs = entries.map((e) => e.name);
    if (subdirs.length === 0) return null;

    const binaryName = mode === "wsl" ? "codex" : "codex.exe";
    const isWindowsTarget = mode === "native";

    // 归一化匹配 token：架构/平台
    const arch = process.arch; // 'x64' | 'arm64' | ...
    const archTokens = arch === "arm64" ? ["aarch64", "arm64"] : ["x86_64", "amd64", "x64"];
    const osTokens = isWindowsTarget ? ["windows"] : ["linux"];

    // 评分函数：匹配越多分越高；Windows 偏好 msvc；Linux 可微弱偏好 gnu
    const score = (name: string): number => {
      const lower = name.toLowerCase();
      let s = 0;
      if (archTokens.some((t) => lower.includes(t))) s += 2;
      if (osTokens.some((t) => lower.includes(t))) s += 2;
      if (isWindowsTarget && lower.includes("msvc")) s += 1;
      if (!isWindowsTarget && lower.includes("gnu")) s += 1;
      return s;
    };

    const sorted = subdirs
      .map((name) => ({ name, s: score(name) }))
      .sort((a, b) => b.s - a.s);

    for (const { name } of sorted) {
      const candidate = path.join(vendorDir, name, "codex", binaryName);
      if (fs.existsSync(candidate)) return candidate;
    }

    // 兜底：尝试遍历一层子目录查找命名为 codex/codex(.exe) 的路径
    for (const name of subdirs) {
      const p = path.join(vendorDir, name);
      const maybe = path.join(p, "codex", binaryName);
      if (fs.existsSync(maybe)) return maybe;
    }
  } catch {}
  return null;
}

/**
 * 从 Cursor/Windsurf 插件目录查找 Codex CLI（后备方案）
 */
function findCodexInExtensions(mode: "native" | "wsl"): string | null {
  const targetPlatform = mode === "wsl" ? "linux" : process.platform;
  const binName = targetPlatform === "win32" ? "codex.exe" : "codex";
  const arch =
    targetPlatform === "win32"
      ? process.arch === "arm64"
        ? "windows-aarch64"
        : "windows-x86_64"
      : targetPlatform === "darwin"
        ? process.arch === "arm64"
          ? "macos-aarch64"
          : "macos-x86_64"
        : process.arch === "arm64"
          ? "linux-aarch64"
          : "linux-x86_64";

  const baseDirs = [
    process.env.CODEXFLOW_CODEX_EXT_DIR,
    path.join(os.homedir(), ".cursor", "extensions"),
    path.join(os.homedir(), ".windsurf", "extensions"),
  ].filter((v): v is string => !!v);

  for (const dir of baseDirs) {
    try {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
        .map((entry) => entry.name)
        .sort((a, b) => compareSemver(b, a));
      for (const sub of entries) {
        const candidate = path.join(dir, sub, "bin", arch, binName);
        if (fs.existsSync(candidate)) {
          perfLogger.log(`[codex] Found in extensions: ${candidate}`);
          return candidate;
        }
      }
    } catch {
      continue;
    }
  }
  
  return null;
}

function resolveBinaryPath(mode: "native" | "wsl"): string {
  // 1. 优先使用环境变量指定的路径
  const hint = process.env.CODEXFLOW_CODEX_BIN;
  if (hint && fs.existsSync(hint)) {
    perfLogger.log(`[codex] Using CODEXFLOW_CODEX_BIN: ${hint}`);
    return hint;
  }

  // macOS/Linux 的普通全局安装通过 PATH 定位，不依赖编辑器插件。
  if (process.platform !== "win32") {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const candidate = path.resolve(dir || ".", "codex");
      try {
        if (fs.statSync(candidate).isFile() && pathExistsExecutable(candidate)) return candidate;
      } catch {}
    }
  }

  // 2. 尝试通过 where.exe 查找 npm 全局安装的版本（优先）
  const npmGlobal = findCodexViaWhereExe(mode);
  if (npmGlobal) return npmGlobal;

  // 3. 降级到插件目录查找（后备方案）
  const extensionPath = findCodexInExtensions(mode);
  if (extensionPath) return extensionPath;

  throw new Error(
    "未找到 Codex CLI。请尝试：\n" +
    "1. npm install -g @openai/codex\n" +
    "2. 或安装 Cursor/Windsurf 插件\n" +
    "3. 或设置 CODEXFLOW_CODEX_BIN 环境变量"
  );
}

function pathExistsExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

export class CodexBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<string, PendingRequest>();
  private initPromise: Promise<void> | null = null;
  private disposed = false;
  private userAgent: string | null = null;
  private requestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private authPathPromise: Promise<string | null> | null = null;
  private authFingerprint: string | undefined;
  private readonly mode: "native" | "wsl";
  private readonly wslDistro?: string;

  constructor(options: CodexBridgeOptions = {}) {
    this.mode = options.mode ?? "native";
    this.wslDistro = options.wslDistro;
  }

  /**
   * 获取当前 ChatGPT 账号信息。
   * - `forceRefresh=true` 时强制刷新 token（用于“记录账号”等需要及时感知切换的场景）。
   */
  async getAccountInfo(forceRefresh: boolean = false): Promise<CodexAccountInfo> {
    await this.ensureProcess();
    let response: any;
    try {
      response = await this.sendRequest("account", "account/read", { refreshToken: forceRefresh });
    } catch (error) {
      if (!this.isUnsupportedMethod(error)) throw error;
      return this.decodeAccount(await this.ensureToken(forceRefresh));
    }
    const account = response?.account;
    if (!account) return { authMode: null, accountId: null, userId: null, email: null, plan: null };
    if (account.type !== "chatgpt")
      return { authMode: account.type, accountId: null, userId: null, email: null, plan: null };
    // 账号接口负责登录状态和展示信息；旧接口仅补充备份去重需要的身份 ID。
    const decoded = this.decodeAccount(await this.ensureToken(false, false).catch(() => null));
    return {
      ...decoded,
      authMode: "chatgpt",
      email: account.email || decoded.email,
      plan: account.planType || decoded.plan,
    };
  }

  /** 使用官方额度接口，并仅在旧 CLI 不支持时回退到历史接口。 */
  async getRateLimit(): Promise<CodexRateLimitSnapshot> {
    await this.ensureProcess();
    try {
      const payload = await this.sendRequest("usage", "account/rateLimits/read", {});
      const rate = payload?.rateLimitsByLimitId?.codex ?? payload?.rateLimits;
      if (!rate || typeof rate !== "object") throw new Error("Codex rate limits unavailable");
      return { primary: this.mapWindow(rate.primary, true), secondary: this.mapWindow(rate.secondary, true) };
    } catch (error) {
      if (!this.isUnsupportedMethod(error)) throw error;
      const payload = await this.requestJson("/wham/usage");
      const rate = payload?.rate_limit;
      if (!rate || typeof rate !== "object") throw new Error("Codex rate limits unavailable");
      return { primary: this.mapWindow(rate.primary_window), secondary: this.mapWindow(rate.secondary_window) };
    }
  }

  /** 关闭后台查询进程，并结束所有待处理请求。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending.forEach(({ reject }) => reject(new Error("CodexBridge disposed")));
    this.pending.clear();
    this.clearRequestTimers();
    this.rl?.close();
    this.rl = null;
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {}
    }
    this.proc = null;
    this.initPromise = null;
  }

  /** 统一新旧额度窗口的单位，并保留绝对重置时间。 */
  private mapWindow(raw: any, modern = false): CodexRateLimitWindow | null {
    if (!raw || typeof raw !== "object") return null;
    // 保留原始字段，UI 层负责单位转换与展示
    const used = modern ? raw.usedPercent : raw.used_percent;
    const duration = modern ? raw.windowDurationMins : raw.limit_window_seconds;
    const resetsAt = modern ? raw.resetsAt : raw.reset_at;
    const resetAfter = Number.isFinite(resetsAt)
      ? Math.max(0, resetsAt - Math.floor(Date.now() / 1000)) : raw.reset_after_seconds;
    return {
      usedPercent: Number.isFinite(used) ? Number(used) : null,
      limitWindowSeconds: Number.isFinite(duration)
        ? Number(duration) * (modern ? 60 : 1)
        : null,
      resetAfterSeconds: Number.isFinite(resetAfter)
        ? Number(resetAfter)
        : null,
      resetsAt: Number.isFinite(resetsAt) ? Number(resetsAt) : null,
    };
  }

  private decodeAccount(token: string | null): CodexAccountInfo {
    if (!token) {
      return { accountId: null, userId: null, plan: null, email: null };
    }
    try {
      const [, payload] = token.split(".");
      if (!payload) throw new Error("invalid token");
      const decoded = JSON.parse(base64UrlDecode(payload)) as AuthPayload;
      const auth = decoded["https://api.openai.com/auth"] ?? {};
      const profile = decoded["https://api.openai.com/profile"] ?? {};
      return {
        accountId: auth.chatgpt_account_id ?? null,
        userId: auth.chatgpt_user_id ?? auth.user_id ?? null,
        plan: auth.chatgpt_plan_type ?? null,
        email: profile.email ?? decoded.email ?? null,
      };
    } catch (err) {
      perfLogger.log(`[codex] decode token failed: ${String(err)}`);
      return { accountId: null, userId: null, plan: null, email: null };
    }
  }

  private async requestJson(endpoint: string): Promise<any> {
    await this.ensureProcess();
    let token = await this.ensureToken(false);
    if (!token) throw new Error("Not signed in to ChatGPT, unable to fetch rate limit");
    const maxRetry = 2;
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < maxRetry) {
      try {
        const url = this.normalizeEndpoint(endpoint);
        const currentToken = token;
        if (!currentToken) throw new Error("Not signed in to ChatGPT, unable to fetch rate limit");
        const headers = this.buildHeaders(currentToken);
        const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (res.status === 401 && attempt === 0) {
          token = await this.ensureToken(true);
          if (!token) throw new Error("Unable to refresh ChatGPT login status");
          attempt += 1;
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch (err) {
        lastErr = err;
        perfLogger.log(
          `[codex] fetch ${endpoint} error: ${
            err instanceof Error ? err.stack ?? err.message : String(err)
          }`,
        );
        break;
      }
    }
    throw new Error(
      `Rate limit request failed: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown")
      }`,
    );
  }

  private normalizeEndpoint(endpoint: string): string {
    if (/^https?:\/\//i.test(endpoint)) return endpoint;
    const suffix = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    return `https://chatgpt.com/backend-api${suffix}`;
  }

  private buildHeaders(token: string): Record<string, string> {
    const info = this.decodeAccount(token);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      originator: ORIGINATOR,
      Accept: "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
    };
    if (this.userAgent) headers["User-Agent"] = this.userAgent;
    if (info.accountId) headers["ChatGPT-Account-Id"] = info.accountId;
    return headers;
  }

  private async ensureToken(force: boolean, checkProcess = true): Promise<string | null> {
    if (checkProcess) await this.ensureProcess();
    try {
      const result = await this.sendRequest("auth", "getAuthStatus", {
        includeToken: true,
        refreshToken: force,
      });
      const token =
        result && typeof (result as any).authToken === "string"
          ? (result as any).authToken
          : null;
      return token;
    } catch (err) {
      perfLogger.log(`[codex] getAuthStatus failed: ${String(err)}`);
      throw err;
    }
  }

  private async ensureProcess(): Promise<void> {
    if (this.disposed) throw new Error("CodexBridge disposed");
    await this.checkAuthFileChanged();
    if (this.disposed) throw new Error("CodexBridge disposed");
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.startProcess().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  /** 凭据文件变化后重启空闲查询进程，让外部登录、退出和账号切换及时生效。 */
  private async checkAuthFileChanged(): Promise<void> {
    this.authPathPromise ??= resolveCodexAuthJsonPathAsync({
      key: this.mode, options: { mode: this.mode, wslDistro: this.wslDistro },
    }).then((result) => result.ok ? result.authJsonPath : null);
    const authPath = await this.authPathPromise;
    if (!authPath) {
      this.authPathPromise = null;
      return;
    }
    const stat = await fs.promises.stat(authPath).catch(() => null);
    const fingerprint = stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : "missing";
    if (this.authFingerprint === fingerprint) return;
    // 已发出的请求先按原身份完成，下次空闲查询再重载，避免打断并发的账号/额度请求。
    if (this.pending.size > 0) return;
    if (this.authFingerprint !== undefined && this.proc) {
      const previous = this.proc;
      this.proc = null;
      this.rl?.close();
      this.rl = null;
      this.initPromise = null;
      previous.kill();
    }
    this.authFingerprint = fingerprint;
  }

  private async startProcess(): Promise<void> {
    const binary = this.mode === "wsl" ? "" : resolveBinaryPath(this.mode);
    if (this.mode !== "wsl" && !fs.existsSync(binary)) {
      throw new Error(`Codex CLI not found: ${binary}`);
    }
    if (this.mode === "native" && !pathExistsExecutable(binary)) {
      throw new Error(`Codex CLI not executable: ${binary}`);
    }
    const binDir = path.dirname(binary);
    let child: ChildProcessWithoutNullStreams;
    if (this.mode === "wsl") {
      child = this.spawnWslProcess();
    } else {
      child = spawn(binary, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PATH: process.env.PATH
            ? `${process.env.PATH}${path.delimiter}${binDir}`
            : binDir,
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: ORIGINATOR,
        },
      });
    }
    this.proc = child;
    this.proc.on("error", (err) => {
      if (this.proc !== child) return;
      perfLogger.log(`[codex] process error: ${String(err)}`);
      this.pending.forEach(({ reject }) => reject(err));
      this.pending.clear();
      this.clearRequestTimers();
      this.proc = null;
      this.rl?.close();
      this.rl = null;
      this.initPromise = null;
    });
    this.proc.on("exit", (code, signal) => {
      if (this.proc !== child) return;
      perfLogger.log(`[codex] process exit code=${code} signal=${signal ?? ""}`);
      this.initPromise = null;
      this.proc = null;
      this.rl?.close();
      this.rl = null;
      const error = createCliExitedError();
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
      this.clearRequestTimers();
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) perfLogger.log(`[codex stderr] ${text}`);
    });

    try {
      await this.sendRequest("init", "initialize", { clientInfo: CLIENT_INFO }, INITIALIZE_ID);
      this.writeMessage({ method: "initialized" });
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      perfLogger.log(`[codex] invalid json: ${trimmed}`);
      return;
    }
    if (message.id === INITIALIZE_ID) {
      this.clearRequestTimer(INITIALIZE_ID);
      this.userAgent = message?.result?.userAgent ?? null;
      const pending = this.pending.get(INITIALIZE_ID);
      if (pending) {
        this.pending.delete(INITIALIZE_ID);
        if (message.error) {
          pending.reject(
            new Error(
              typeof message.error === "string"
                ? message.error
                : JSON.stringify(message.error),
            ),
          );
        } else {
          pending.resolve(undefined);
        }
      }
      return;
    }
    if (typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.clearRequestTimer(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(
              typeof message.error === "string"
                ? message.error
                : JSON.stringify(message.error),
            ),
          );
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }
  }

  /** 发送带超时的协议请求，防止后台进程失去响应时界面永久等待。 */
  private sendRequest(namespace: string, method: string, params: any, requestId?: string): Promise<any> {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      return Promise.reject(new Error("codex 子进程未就绪"));
    }
    const id = requestId ?? `${namespace}:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.requestTimers.set(id, setTimeout(() => {
        this.pending.delete(id);
        this.requestTimers.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS));
      try {
        this.writeMessage({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        this.clearRequestTimer(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 仅将协议明确报告的方法缺失视为旧版兼容场景。 */
  private isUnsupportedMethod(error: unknown): boolean {
    return /-32601|unknown (?:variant|method)|method not found|unrecognized method/i.test(String(error));
  }

  /** 清理已完成请求的超时计时器。 */
  private clearRequestTimer(id: string): void {
    clearTimeout(this.requestTimers.get(id));
    this.requestTimers.delete(id);
  }

  /** 清理进程关闭时剩余的超时计时器。 */
  private clearRequestTimers(): void {
    this.requestTimers.forEach((timer) => clearTimeout(timer));
    this.requestTimers.clear();
  }

  private writeMessage(payload: Record<string, unknown>) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("Codex subprocess not ready");
    }
    const serialized = JSON.stringify(payload) + "\n";
    this.proc.stdin.write(serialized);
  }

  private spawnWslProcess(): ChildProcessWithoutNullStreams {
    if (process.platform !== "win32") {
      throw new Error("WSL mode not supported on this platform");
    }
    const distroArg = this.wslDistro ? ["-d", this.wslDistro] : [];
    const hint = process.env.CODEXFLOW_CODEX_BIN;
    const wslPath = hint ? (hint.startsWith("/") ? hint : winToWsl(hint)) : null;
    if (hint && (!wslPath || !wslPath.startsWith("/"))) {
      throw new Error("Unable to convert Codex CLI path for WSL usage");
    }
    const escapedBin = wslPath ? shEscape(wslPath) : "codex";
    const exports: string[] = [
      `export CODEX_INTERNAL_ORIGINATOR_OVERRIDE=${shEscape(ORIGINATOR)}`,
    ];
    const proxyVars = ["CODEXFLOW_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
    for (const name of proxyVars) {
      const value = process.env[name];
      if (value) exports.push(`export ${name}=${shEscape(value)}`);
    }
    const binDir = wslPath ? path.posix.dirname(wslPath.replace(/\\/g, "/")) : "";
    if (binDir && binDir !== "/") {
      exports.unshift(`export PATH="$PATH:${escapeForDoubleQuotes(binDir)}"`);
    }
    const script = [
      ...exports,
      `exec ${escapedBin} app-server`,
    ].join("; ");
    const args = [...distroArg, "--", "sh", "-lc", script];
    return spawn("wsl.exe", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
}
