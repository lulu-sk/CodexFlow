// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
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
};

export type ClaudeUsageSnapshot = {
  providerId: "claude";
  /** 数据来源：优先读取本地缓存；WSL 下可用 tmux-capture 兜底。 */
  source: "ccline-cache" | "tmux-capture";
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

type ProviderRuntimeEnv = { terminal: "wsl" | "windows" | "pwsh"; distro?: string };

type ClaudeApiUsageCache = {
  five_hour_utilization?: number;
  seven_day_utilization?: number;
  resets_at?: string;
  cached_at?: string;
};

function clampPercent(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(String(value ?? ""));
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, num));
}

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
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "wsl.exe",
      args,
      { windowsHide: true, timeout: Math.max(1000, timeoutMs), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
        });
      },
    );
  });
}

function shEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveClaudeCacheFilePathWindows(): string {
  const base = String(process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || "").trim();
  if (base) return path.join(base, "ccline", ".api_usage_cache.json");
  return path.join(os.homedir(), ".claude", "ccline", ".api_usage_cache.json");
}

async function readClaudeCacheFileWindowsAsync(): Promise<string | null> {
  try {
    const p = resolveClaudeCacheFilePathWindows();
    const buf = await fs.readFile(p, "utf8");
    return String(buf ?? "").trim() || null;
  } catch {
    return null;
  }
}

async function readClaudeCacheFileWslAsync(distro?: string, timeoutMs = 5000): Promise<string | null> {
  if (os.platform() !== "win32") return null;
  const args = distro
    ? ["-d", distro, "--", "sh", "-lc", "cat ~/.claude/ccline/.api_usage_cache.json 2>/dev/null || true"]
    : ["--", "sh", "-lc", "cat ~/.claude/ccline/.api_usage_cache.json 2>/dev/null || true"];
  try {
    const { stdout } = await execWslWithTimeoutAsync(args, timeoutMs);
    const text = String(stdout ?? "").trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

function parseClaudeCclineCache(text: string): ClaudeUsageSnapshot | null {
  try {
    const obj = JSON.parse(String(text || "")) as ClaudeApiUsageCache;
    const fiveUsed = clampPercent(obj.five_hour_utilization);
    const weekUsed = clampPercent(obj.seven_day_utilization);
    if (fiveUsed == null && weekUsed == null) return null;

    const cachedAt = toMs(obj.cached_at);
    const resetAt = toMs(obj.resets_at);
    const fiveRem = fiveUsed == null ? null : clampPercent(100 - fiveUsed);
    const weekRem = weekUsed == null ? null : clampPercent(100 - weekUsed);

    return {
      providerId: "claude",
      source: "ccline-cache",
      collectedAt: Date.now(),
      cachedAt,
      resetAt,
      windows: {
        fiveHour: { usedPercent: fiveUsed, remainingPercent: fiveRem },
        sevenDay: { usedPercent: weekUsed, remainingPercent: weekRem },
        weekOpus: null,
      },
    };
  } catch {
    return null;
  }
}

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

  const { stdout } = await execWslWithTimeoutAsync(args, timeoutMs);
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
 * 获取 Claude Code 用量快照（优先读取本地缓存；WSL 下支持 tmux-capture 兜底）。
 */
export async function getClaudeUsageSnapshotAsync(env: ProviderRuntimeEnv): Promise<ClaudeUsageSnapshot> {
  return perfLogger.time("[claude] usage snapshot", async () => {
    const terminal = env.terminal;
    if (terminal === "wsl") {
      const cache = await readClaudeCacheFileWslAsync(env.distro);
      const parsed = cache ? parseClaudeCclineCache(cache) : null;
      if (parsed) return parsed;

      const viaScript = await runClaudeUsageCaptureWslAsync(env.distro).catch((e) => {
        // 脚本错误直接向上抛（用于 UI 显示）
        throw e;
      });
      if (viaScript) return viaScript;
      throw new Error("Claude 用量信息不可用（未找到缓存，且 WSL 抓取失败）");
    }

    if (terminal === "windows" || terminal === "pwsh") {
      const cache = await readClaudeCacheFileWindowsAsync();
      const parsed = cache ? parseClaudeCclineCache(cache) : null;
      if (parsed) return parsed;
      throw new Error("未找到 Claude 用量缓存文件：~/.claude/ccline/.api_usage_cache.json");
    }

    throw new Error("Claude 用量信息不可用：未知运行环境");
  });
}

