// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { ipcMain, type BrowserWindow } from "electron";

export type QuitConfirmRequestPayload = {
  token: string;
  count: number;
};

type Pending = {
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout | null;
};

const pendingByToken = new Map<string, Pending>();

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
      if (!p) return { ok: false, error: "not_found" };
      pendingByToken.delete(token);
      try { if (p.timer) clearTimeout(p.timer); } catch {}
      try { p.resolve(ok); } catch {}
      return { ok: true };
    } catch (e: any) {
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
    if (!target) return null;
    if (!target.webContents || target.webContents.isDestroyed()) return null;

    const token = uidToken();
    const payload: QuitConfirmRequestPayload = { token, count: Math.max(0, Math.floor(Number(count) || 0)) };
    const timeoutMs = Math.max(1500, Math.min(120_000, Number(opts.timeoutMs) || 0)) || 30_000;

    const done = await new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingByToken.delete(token);
        resolve(null);
      }, timeoutMs);
      pendingByToken.set(token, { resolve: (ok) => resolve(ok), timer });
      try {
        target.webContents.send("app:quitConfirm", payload);
      } catch {
        pendingByToken.delete(token);
        try { clearTimeout(timer); } catch {}
        resolve(null);
      }
    });
    return done;
  } catch {
    return null;
  }
}

