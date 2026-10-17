// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { perfLogger } from "../log";
import { winToWslAsync } from "../wsl";

export type ClaudeUsageWindow = {
  /** 剩余百分比（0-100），不可用时为 null。 */
  remainingPercent: number | null;
  /** 已用百分比（0-100），不可用时为 null。 */
  usedPercent: number | null;
  /** 重置时间文本（Claude TUI 原始/解析结果），不可用时为 null。 */
  resetText?: string | null;
  /** 当前窗口自己的绝对重置时间（ms）。 */
  resetAt?: number | null;
};

export type ClaudeUsageSnapshot = {
  providerId: "claude";
  /** 数据来源：优先官方接口，缓存与 WSL 终端抓取用于兜底。 */
  source: "oauth-api" | "oauth-api-cache" | "ccline-cache" | "tmux-capture";
  /** 抓取时间（ms）。 */
  collectedAt: number;
  /** 缓存计算/抓取时间（ms），仅 cache 源可用。 */
  cachedAt?: number | null;
  /** 下次重置时间（ms），仅 cache 源可用（Claude TUI 的 reset 可能仅提供文本）。 */
  resetAt?: number | null;
  /** 5 小时与 7 天窗口（与 Claude Code 常见用量口径一致）。 */
  windows: {
    fiveHour: ClaudeUsageWindow;
    sevenDay: ClaudeUsageWindow;
    weekOpus?: ClaudeUsageWindow | null;
  };
};

type ProviderRuntimeEnv = { terminal: "wsl" | "windows" | "pwsh" | "cmd"; distro?: string };

let lastVerifiedUsage: { identity: string; snapshot: ClaudeUsageSnapshot } | null = null;

/** 解析有效百分比，缺失值保留未知，不能当作零消耗。 */
function clampPercent(value: unknown): number | null {
  if (value == null || (typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const num = typeof value === "number" ? value : Number(String(value ?? ""));
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

/** 解析可选的 ISO 时间。 */
function toMs(dateText: unknown): number | null {
  const text = String(dateText ?? "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 在 Windows 下执行 wsl.exe，并附带超时，避免无限等待。
 */
function execWslWithTimeoutAsync(
  args: string[],
  timeoutMs: number,
  allowErrorOutput = false,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "wsl.exe",
      args,
      { windowsHide: true, timeout: Math.max(1000, timeoutMs), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (!allowErrorOutput || !String(stdout ?? "").trim())) return reject(err);
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
        });
      },
    );
  });
}

/** 转义传给 POSIX shell 的单个参数。 */
function shEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 定位当前 Windows 环境使用的 Claude 配置目录。 */
function resolveClaudeConfigDirWindows(): string {
  const base = String(process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || "").trim();
  return base || path.join(os.homedir(), ".claude");
}

/** 从当前终端环境读取 Claude OAuth 身份，不跨环境读取或修改凭据。 */
async function readClaudeOAuthTokenAsync(env: ProviderRuntimeEnv): Promise<{ token: string; expired: boolean } | null> {
  let raw: string;
  if (env.terminal === "wsl") {
    const script = 'if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then printf "%s" "$CLAUDE_CODE_OAUTH_TOKEN"; else cat "${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-$HOME/.claude}}/.credentials.json" 2>/dev/null || true; fi';
    const args = [...(env.distro ? ["-d", env.distro] : []), "--", "sh", "-lc", script];
    raw = (await execWslWithTimeoutAsync(args, 5000)).stdout;
  } else {
    const token = String(process.env.CLAUDE_CODE_OAUTH_TOKEN || "").trim();
    if (token) return { token, expired: false };
    const configDir = resolveClaudeConfigDirWindows();
    raw = await fs.readFile(path.join(configDir, ".credentials.json"), "utf8").catch(() => "");
  }
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  if (!text.startsWith("{")) return { token: text, expired: false };
  try {
    const oauth = JSON.parse(text)?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.trim()) return null;
    return { token: oauth.accessToken.trim(), expired: typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now() };
  } catch {
    return null;
  }
}

/** 将官方接口的单个额度窗口转换为界面数据。 */
function parseClaudeApiWindow(value: any): ClaudeUsageWindow {
  const usedPercent = clampPercent(value?.utilization);
  return {
    usedPercent,
    remainingPercent: usedPercent == null ? null : 100 - usedPercent,
    resetAt: toMs(value?.resets_at),
  };
}

/** 使用官方 OAuth 用量接口读取当前账号的实时额度。 */
async function fetchClaudeUsageAsync(token: string): Promise<ClaudeUsageSnapshot> {
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw Object.assign(new Error(`Claude 用量请求失败：HTTP ${response.status}`), { status: response.status });
  const data = await response.json() as any;
  const fiveHour = parseClaudeApiWindow(data?.five_hour);
  const sevenDay = parseClaudeApiWindow(data?.seven_day);
  const weekOpus = data?.seven_day_opus ? parseClaudeApiWindow(data.seven_day_opus) : null;
  if (fiveHour.usedPercent == null && sevenDay.usedPercent == null && weekOpus?.usedPercent == null)
    throw new Error("Claude 用量接口未返回有效额度");
  return { providerId: "claude", source: "oauth-api", collectedAt: Date.now(), windows: { fiveHour, sevenDay, weekOpus } };
}

/** 定位随应用打包的 Claude 终端抓取脚本。 */
function resolveBundledClaudeCaptureScriptPath(): string | null {
  const cands: string[] = [];
  try {
    cands.push(path.join(process.resourcesPath || "", "bin", "claude_usage_capture.sh"));
    cands.push(path.join(process.resourcesPath || "", "app.asar.unpacked", "bin", "claude_usage_capture.sh"));
  } catch {}
  try {
    cands.push(path.join(process.cwd(), "build", "bin", "claude_usage_capture.sh"));
  } catch {}
  for (const p of cands) {
    try {
      if (p && fsSync.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

/** 在当前 WSL 发行版启动独立终端会话并抓取官方用量界面。 */
async function runClaudeUsageCaptureWslAsync(
  distro?: string,
  timeoutMs = 30_000,
): Promise<ClaudeUsageSnapshot | null> {
  if (os.platform() !== "win32") return null;
  const scriptWin = resolveBundledClaudeCaptureScriptPath();
  if (!scriptWin) return null;

  const scriptWsl = await winToWslAsync(scriptWin, distro);
  if (!scriptWsl) return null;

  const cmd = [
    `WORKDIR=/tmp`,
    `MODEL=sonnet`,
    `TIMEOUT_SECS=10`,
    `SLEEP_BOOT=0.4`,
    `SLEEP_AFTER_USAGE=2.0`,
    `bash ${shEscape(scriptWsl)}`,
  ].join(" ");

  const args = distro ? ["-d", distro, "--", "sh", "-lc", cmd] : ["--", "sh", "-lc", cmd];

  const { stdout } = await execWslWithTimeoutAsync(args, timeoutMs, true);
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  const obj = JSON.parse(text) as any;
  if (!obj || typeof obj !== "object") return null;
  if (obj.ok === false) {
    const hint = String(obj.hint ?? "").trim();
    const code = String(obj.error ?? "").trim();
    throw new Error(hint ? `${code}: ${hint}` : (code || "Claude usage capture failed"));
  }
  const sessionLeft = clampPercent(obj?.session_5h?.pct_left);
  const weekLeft = clampPercent(obj?.week_all_models?.pct_left);
  const opusLeft = clampPercent(obj?.week_opus?.pct_left);
  const sessionReset = typeof obj?.session_5h?.resets === "string" ? obj.session_5h.resets : null;
  const weekReset = typeof obj?.week_all_models?.resets === "string" ? obj.week_all_models.resets : null;
  const opusReset = typeof obj?.week_opus?.resets === "string" ? obj.week_opus.resets : null;

  if (sessionLeft == null && weekLeft == null && opusLeft == null) return null;
  return {
    providerId: "claude",
    source: "tmux-capture",
    collectedAt: Date.now(),
    windows: {
      fiveHour: {
        remainingPercent: sessionLeft,
        usedPercent: sessionLeft == null ? null : clampPercent(100 - sessionLeft),
        resetText: sessionReset,
      },
      sevenDay: {
        remainingPercent: weekLeft,
        usedPercent: weekLeft == null ? null : clampPercent(100 - weekLeft),
        resetText: weekReset,
      },
      weekOpus: obj?.week_opus
        ? {
            remainingPercent: opusLeft,
            usedPercent: opusLeft == null ? null : clampPercent(100 - opusLeft),
            resetText: opusReset,
          }
        : null,
    },
  };
}

/**
 * 优先读取官方实时用量，仅复用相同凭据的短时成功缓存；WSL 下保留终端抓取兜底。
 */
export async function getClaudeUsageSnapshotAsync(env: ProviderRuntimeEnv): Promise<ClaudeUsageSnapshot> {
  return perfLogger.time("[claude] usage snapshot", async () => {
    const terminal = env.terminal;
    let apiError: unknown = null;
    const credential = await readClaudeOAuthTokenAsync(env).catch(() => null);
    if (credential && !credential.expired) {
      const identity = createHash("sha256").update(`${terminal}:${env.distro || ""}\0${credential.token}`).digest("hex");
      if (lastVerifiedUsage?.identity !== identity) lastVerifiedUsage = null;
      try {
        const snapshot = await fetchClaudeUsageAsync(credential.token);
        lastVerifiedUsage = { identity, snapshot };
        return snapshot;
      }
      catch (error) {
        if ([401, 403].includes(Number((error as { status?: number })?.status))) {
          lastVerifiedUsage = null;
          throw error;
        }
        const cached = lastVerifiedUsage?.identity === identity ? lastVerifiedUsage.snapshot : null;
        if (cached && Date.now() - cached.collectedAt >= 0 && Date.now() - cached.collectedAt <= 5 * 60_000)
          return { ...cached, source: "oauth-api-cache", cachedAt: cached.collectedAt, collectedAt: Date.now() };
        apiError = error;
      }
    } else lastVerifiedUsage = null;
    if (terminal === "wsl") {
      const viaScript = await runClaudeUsageCaptureWslAsync(env.distro).catch((e) => {
        // 脚本错误直接向上抛（用于 UI 显示）
        throw e;
      });
      if (viaScript) return viaScript;
      if (apiError) throw apiError;
      throw new Error("Claude 用量信息不可用（未找到缓存，且 WSL 抓取失败）");
    }

    if (terminal === "windows" || terminal === "pwsh" || terminal === "cmd") {
      if (apiError) throw apiError;
      if (credential?.expired) throw new Error("Claude 登录凭据已过期，请先在当前运行环境重新登录 Claude Code");
      throw new Error("Claude 用量信息不可用，请先在当前运行环境登录 Claude Code");
    }

    throw new Error("Claude 用量信息不可用：未知运行环境");
  });
}

