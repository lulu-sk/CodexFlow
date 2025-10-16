// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { perfLogger } from "../log";
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
  windowMinutes: number | null;
  resetsInSeconds: number | null;
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

let proxyConfigured = false;
function configureProxyIfNeeded() {
  if (proxyConfigured) return;
  proxyConfigured = true;
  const raw =
    process.env.CODEXFLOW_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    "";
  if (!raw) return;
  try {
    setGlobalDispatcher(new ProxyAgent(raw));
    let printable = raw;
    try {
      const parsed = new URL(raw);
      printable = `${parsed.protocol}//${parsed.hostname}${
        parsed.port ? `:${parsed.port}` : ""
      }`;
    } catch {
      printable = raw.replace(/\/\/([^@]+)@/, "//***@");
    }
    perfLogger.log(`[codex] Using proxy: ${printable}`);
  } catch (err) {
    perfLogger.log(
      `[codex] Proxy setup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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

function resolveBinaryPath(mode: "native" | "wsl"): string {
  const hint = process.env.CODEXFLOW_CODEX_BIN;
  if (hint && fs.existsSync(hint)) return hint;

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
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      continue;
    }
  }
  throw new Error("未找到 Codex CLI，可设置 CODEXFLOW_CODEX_BIN 环境变量指向 codex 可执行文件");
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
    configureProxyIfNeeded();
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
    const limitSeconds = Number(raw.limit_window_seconds ?? NaN);
    return {
      usedPercent: Number.isFinite(raw.used_percent) ? Number(raw.used_percent) : null,
      windowMinutes: Number.isFinite(limitSeconds) ? limitSeconds / 60 : null,
      resetsInSeconds: Number.isFinite(raw.reset_after_seconds)
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
    if (!token) throw new Error("尚未登录 ChatGPT，无法获取速率限制");
    const maxRetry = 2;
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < maxRetry) {
      try {
        const url = this.normalizeEndpoint(endpoint);
        const currentToken = token;
        if (!currentToken) throw new Error("尚未登录 ChatGPT，无法获取速率限制");
        const headers = this.buildHeaders(currentToken);
        const res = await fetch(url, { method: "GET", headers });
        if (res.status === 401 && attempt === 0) {
          token = await this.ensureToken(true);
          if (!token) throw new Error("无法刷新 ChatGPT 登录状态");
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
      `请求速率限制失败：${
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
    if (!force && this.lastToken && now - this.tokenFetchedAt < 120_000) {
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
      throw new Error(`未找到 codex CLI：${binary}`);
    }
    if (this.mode === "native" && !pathExistsExecutable(binary)) {
      throw new Error(`codex CLI 不可执行：${binary}`);
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
      throw new Error("codex 子进程未就绪");
    }
    const serialized = JSON.stringify(payload) + "\n";
    this.proc.stdin.write(serialized);
  }

  private spawnWslProcess(binary: string): ChildProcessWithoutNullStreams {
    if (process.platform !== "win32") {
      throw new Error("当前环境不支持 WSL 模式");
    }
    const distroArg = this.wslDistro ? ["-d", this.wslDistro] : [];
    const wslPath = winToWsl(binary);
    if (!wslPath || !wslPath.startsWith("/")) {
      throw new Error("无法转换 codex CLI 路径以供 WSL 使用");
    }
    const escapedBin = shEscape(wslPath);
    const exports: string[] = [
      `export CODEX_INTERNAL_ORIGINATOR_OVERRIDE=${shEscape(ORIGINATOR)}`,
    ];
    const proxyVars = ["CODEXFLOW_PROXY", "HTTPS_PROXY", "HTTP_PROXY"];
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
