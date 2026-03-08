// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { execFile } from "node:child_process";

/**
 * 终端运行模式枚举：
 * - native: macOS/Linux 原生 shell (zsh/bash/fish 等)
 * - wsl: Windows Subsystem for Linux
 * - windows: Windows PowerShell 5
 * - pwsh: PowerShell 7 (跨平台)
 */
export type TerminalMode = "native" | "wsl" | "windows" | "pwsh";

export type WindowsShellKind = "powershell" | "pwsh";

export type WindowsShellResolution = {
  command: string;
  kind: WindowsShellKind;
};

/**
 * 归一化终端模式，支持平台感知默认值：
 * - 明确指定的模式直接返回
 * - 未指定时根据平台返回默认值：Windows -> wsl，macOS/Linux -> native
 */
export function normalizeTerminal(raw: unknown): TerminalMode {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "native") return "native";
  if (v === "pwsh") return "pwsh";
  if (v === "windows") return "windows";
  if (v === "wsl") return "wsl";
  // 平台感知默认值
  if (process.platform === "win32") return "wsl";
  return "native";
}

/**
 * 按宿主平台裁剪终端模式，避免读取到其它平台保存的无效值。
 * - Windows: `native` 自动回退到 `wsl`
 * - macOS/Linux: 统一回退到 `native`
 */
export function coerceTerminalModeForPlatform(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): TerminalMode {
  const normalized = normalizeTerminal(raw);
  if (platform === "win32") {
    if (normalized === "native") return "wsl";
    return normalized;
  }
  return "native";
}

/**
 * 获取当前平台的默认终端模式
 */
export function getDefaultTerminalForPlatform(): TerminalMode {
  return normalizeTerminal(undefined);
}

const PWSH_CACHE_TTL_MS = 10_000;
const PWSH_CANDIDATES = [
  "pwsh.exe",
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
];
let cachedPwsh: string | null = null;
let cachedPwshCheckedAt = 0;
let pwshRefreshPromise: Promise<string | null> | null = null;

async function execFileAsync(file: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: 1_500 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout || ""));
      },
    );
  });
}

function setPwshCache(value: string | null): string | null {
  cachedPwsh = value;
  cachedPwshCheckedAt = Date.now();
  return value;
}

function cacheFresh(): boolean {
  return cachedPwshCheckedAt > 0 && Date.now() - cachedPwshCheckedAt < PWSH_CACHE_TTL_MS;
}

function tryFastLocalPwsh(): string | null {
  for (const candidate of PWSH_CANDIDATES) {
    try {
      if (candidate.includes("\\") && fs.existsSync(candidate)) {
        return setPwshCache(candidate);
      }
    } catch {}
  }
  return null;
}

async function refreshPwshCache(): Promise<string | null> {
  if (pwshRefreshPromise) return pwshRefreshPromise;
  pwshRefreshPromise = (async () => {
    const fast = tryFastLocalPwsh();
    if (fast) return fast;
    for (const candidate of PWSH_CANDIDATES) {
      try {
        const out = await execFileAsync("where.exe", [candidate]);
        const hit = out
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((s) => !!s);
        if (hit) return setPwshCache(hit);
      } catch {}
    }
    return setPwshCache(null);
  })().finally(() => {
    pwshRefreshPromise = null;
  });
  return pwshRefreshPromise;
}

export async function detectPwshExecutable(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  if (cacheFresh()) return cachedPwsh;
  const fast = tryFastLocalPwsh();
  if (fast) return fast;
  return await refreshPwshCache();
}

export async function hasPwsh(): Promise<boolean> {
  const hit = await detectPwshExecutable();
  return !!hit;
}

export function resolveWindowsShell(mode: "windows" | "pwsh"): WindowsShellResolution {
  if (mode === "pwsh") {
    const fast = cacheFresh() ? cachedPwsh : tryFastLocalPwsh();
    if (fast) return { command: fast, kind: "pwsh" };
    if (!cacheFresh()) {
      // 异步刷新，避免阻塞主线程；结果用于后续调用
      void detectPwshExecutable();
    }
  }
  return { command: "powershell.exe", kind: "powershell" };
}

