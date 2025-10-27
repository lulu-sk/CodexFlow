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

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export type CodexAccountInfo = {
  accountId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
};

export type CodexRateLimitWindow = {
  usedPercent: number | null;
  limitWindowSeconds: number | null;  // 原始字段（秒），UI 层转换为分钟/小时/天
  resetAfterSeconds: number | null;   // 原始字段，统一命名
};

export type CodexRateLimitSnapshot = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

const INITIALIZE_ID = "cf-init";
const ORIGINATOR = "codex_vscode";
const CLIENT_INFO = { name: "CodexFlow", title: "CodexFlow", version: "0.0.0" };

export type CodexBridgeOptions = {
  mode?: "native" | "wsl";
  wslDistro?: string;
};

type AuthPayload = {
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_user_id?: string;
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
      const isCmd = lower.endsWith(".cmd") || lower.endsWith(".bat");
      const isPs1 = lower.endsWith(".ps1");
      const isSh = !isExe && !isCmd && !isPs1; // 其他情况按 shell 脚本处理

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
      if (!fs.existsSync(vendorDir)) continue;

      // 在 vendor 目录内自适应选择子目录与可执行文件
      const selected = selectVendorBinary(vendorDir, mode);
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
  private lastToken: string | null = null;
  private tokenFetchedAt = 0;
  private readonly mode: "native" | "wsl";
  private readonly wslDistro?: string;

  constructor(options: CodexBridgeOptions = {}) {
    this.mode = options.mode ?? "native";
    this.wslDistro = options.wslDistro;
  }

  async getAccountInfo(): Promise<CodexAccountInfo> {
    const token = await this.ensureToken(false);
    return this.decodeAccount(token);
  }

  async getRateLimit(): Promise<CodexRateLimitSnapshot> {
    const payload = await this.requestJson("/wham/usage");
    const rate = payload?.rate_limit ?? null;
    return {
      primary: this.mapWindow(rate?.primary_window),
      secondary: this.mapWindow(rate?.secondary_window),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending.forEach(({ reject }) => reject(new Error("CodexBridge disposed")));
    this.pending.clear();
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

  private mapWindow(raw: any): CodexRateLimitWindow | null {
    if (!raw || typeof raw !== "object") return null;
    // 保留原始字段，UI 层负责单位转换与展示
    return {
      usedPercent: Number.isFinite(raw.used_percent) ? Number(raw.used_percent) : null,
      limitWindowSeconds: Number.isFinite(raw.limit_window_seconds)
        ? Number(raw.limit_window_seconds)
        : null,
      resetAfterSeconds: Number.isFinite(raw.reset_after_seconds)
        ? Number(raw.reset_after_seconds)
        : null,
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
        userId: auth.chatgpt_user_id ?? null,
        plan: auth.chatgpt_plan_type ?? null,
        email: profile.email ?? null,
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
        const res = await fetch(url, { method: "GET", headers });
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
        attempt += 1;
        if (attempt >= maxRetry) break;
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

  private async ensureToken(force: boolean): Promise<string | null> {
    await this.ensureProcess();
    const now = Date.now();
    // 延长缓存到 1 小时，降低请求频率；401 时会强刷
    if (!force && this.lastToken && now - this.tokenFetchedAt < 3_600_000) {
      return this.lastToken;
    }
    try {
      const result = await this.sendRequest("auth", "getAuthStatus", {
        includeToken: true,
        refreshToken: force,
      });
      const token =
        result && typeof (result as any).authToken === "string"
          ? (result as any).authToken
          : null;
      if (token) {
        this.lastToken = token;
        this.tokenFetchedAt = Date.now();
      }
      return token;
    } catch (err) {
      perfLogger.log(`[codex] getAuthStatus failed: ${String(err)}`);
      return null;
    }
  }

  private async ensureProcess(): Promise<void> {
    if (this.disposed) throw new Error("CodexBridge disposed");
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.startProcess().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async startProcess(): Promise<void> {
    const binary = resolveBinaryPath(this.mode);
    if (!fs.existsSync(binary)) {
      throw new Error(`Codex CLI not found: ${binary}`);
    }
    if (this.mode === "native" && !pathExistsExecutable(binary)) {
      throw new Error(`Codex CLI not executable: ${binary}`);
    }
    const binDir = path.dirname(binary);
    let child: ChildProcessWithoutNullStreams;
    if (this.mode === "wsl") {
      child = this.spawnWslProcess(binary);
    } else {
      child = spawn(binary, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
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
      perfLogger.log(`[codex] process error: ${String(err)}`);
    });
    this.proc.on("exit", (code, signal) => {
      perfLogger.log(`[codex] process exit code=${code} signal=${signal ?? ""}`);
      this.initPromise = null;
      this.proc = null;
      this.rl?.close();
      this.rl = null;
      const error = createCliExitedError();
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) perfLogger.log(`[codex stderr] ${text}`);
    });

    await new Promise<void>((resolve, reject) => {
      this.pending.set(INITIALIZE_ID, {
        resolve: () => resolve(),
        reject,
      });
      this.writeMessage({
        id: INITIALIZE_ID,
        method: "initialize",
        params: { clientInfo: CLIENT_INFO },
      });
    });
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
      if (message.method === "codex/event/auth_status_change") {
        this.tokenFetchedAt = 0;
      }
      return;
    }
    if (message.method === "codex/event/auth_status_change") {
      this.tokenFetchedAt = 0;
    }
  }

  private sendRequest(namespace: string, method: string, params: any): Promise<any> {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      return Promise.reject(new Error("codex 子进程未就绪"));
    }
    const id = `${namespace}:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.writeMessage({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private writeMessage(payload: Record<string, unknown>) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("Codex subprocess not ready");
    }
    const serialized = JSON.stringify(payload) + "\n";
    this.proc.stdin.write(serialized);
  }

  private spawnWslProcess(binary: string): ChildProcessWithoutNullStreams {
    if (process.platform !== "win32") {
      throw new Error("WSL mode not supported on this platform");
    }
    const distroArg = this.wslDistro ? ["-d", this.wslDistro] : [];
    const wslPath = winToWsl(binary);
    if (!wslPath || !wslPath.startsWith("/")) {
      throw new Error("Unable to convert Codex CLI path for WSL usage");
    }
    const escapedBin = shEscape(wslPath);
    const exports: string[] = [
      `export CODEX_INTERNAL_ORIGINATOR_OVERRIDE=${shEscape(ORIGINATOR)}`,
    ];
    const proxyVars = ["CODEXFLOW_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
    for (const name of proxyVars) {
      const value = process.env[name];
      if (value) exports.push(`export ${name}=${shEscape(value)}`);
    }
    const binDir = path.posix.dirname(wslPath.replace(/\\/g, "/"));
    if (binDir && binDir !== "/") {
      exports.unshift(`export PATH="$PATH:${escapeForDoubleQuotes(binDir)}"`);
    }
    const script = [
      `if [ ! -x ${escapedBin} ]; then chmod +x ${escapedBin} 2>/dev/null || true; fi`,
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
