// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { ipcMain, type BrowserWindow } from "electron";
import { perfLogger } from "./log";

export type QuitConfirmRequestPayload = {
  token: string;
  count: number;
};

type Pending = {
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout | null;
};

const pendingByToken = new Map<string, Pending>();

/**
 * 写入退出确认桥接日志。
 */
function logQuitConfirmBridge(message: string): void {
  try { perfLogger.logAlways(`[quitConfirm.bridge] ${message}`); } catch {}
}

function uidToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 注册“退出确认”渲染进程回包 IPC。
 */
export function registerQuitConfirmIPC(): void {
  try { ipcMain.removeHandler("app.quitConfirm.respond"); } catch {}
  ipcMain.handle("app.quitConfirm.respond", async (_e, args: { token: string; ok: boolean }) => {
    try {
      const token = String(args?.token || "");
      const ok = !!args?.ok;
      const p = pendingByToken.get(token);
      if (!p) {
        logQuitConfirmBridge(`respond token=${token || "empty"} ok=${ok ? 1 : 0} result=not_found`);
        return { ok: false, error: "not_found" };
      }
      pendingByToken.delete(token);
      try { if (p.timer) clearTimeout(p.timer); } catch {}
      try { p.resolve(ok); } catch {}
      logQuitConfirmBridge(`respond token=${token} ok=${ok ? 1 : 0}`);
      return { ok: true };
    } catch (e: any) {
      logQuitConfirmBridge(`respond error=${String(e?.message || e)}`);
      return { ok: false, error: String(e) };
    }
  });
}

/**
 * 通过渲染进程弹窗请求用户确认（可自定义 UI 样式）。
 * - 返回 `true/false` 表示用户明确选择
 * - 返回 `null` 表示渲染进程不可用/超时，应回退到原生确认框
 */
export async function requestQuitConfirmFromRenderer(
  win: BrowserWindow | null,
  count: number,
  opts: { timeoutMs?: number } = {},
): Promise<boolean | null> {
  try {
    const target = win && !win.isDestroyed() ? win : null;
    if (!target) {
      logQuitConfirmBridge("skip reason=no-window");
      return null;
    }
    if (!target.webContents || target.webContents.isDestroyed()) {
      logQuitConfirmBridge("skip reason=no-webContents");
      return null;
    }

    const token = uidToken();
    const payload: QuitConfirmRequestPayload = { token, count: Math.max(0, Math.floor(Number(count) || 0)) };
    const timeoutMs = Math.max(1500, Math.min(120_000, Number(opts.timeoutMs) || 0)) || 30_000;

    const done = await new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingByToken.delete(token);
        logQuitConfirmBridge(`timeout token=${token} timeoutMs=${timeoutMs}`);
        resolve(null);
      }, timeoutMs);
      pendingByToken.set(token, { resolve: (ok) => resolve(ok), timer });
      try {
        logQuitConfirmBridge(`send token=${token} count=${payload.count} timeoutMs=${timeoutMs} loading=${target.webContents.isLoading() ? 1 : 0}`);
        target.webContents.send("app:quitConfirm", payload);
      } catch {
        pendingByToken.delete(token);
        try { clearTimeout(timer); } catch {}
        logQuitConfirmBridge(`send failed token=${token}`);
        resolve(null);
      }
    });
    return done;
  } catch {
    logQuitConfirmBridge("request error");
    return null;
  }
}

