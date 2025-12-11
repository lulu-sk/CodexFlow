// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { execFile } from "node:child_process";

export type TerminalMode = "wsl" | "windows" | "pwsh";

export type WindowsShellKind = "powershell" | "pwsh";

export type WindowsShellResolution = {
  command: string;
  kind: WindowsShellKind;
};

export function normalizeTerminal(raw: unknown): TerminalMode {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "pwsh") return "pwsh";
  if (v === "windows") return "windows";
  return "wsl";
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

