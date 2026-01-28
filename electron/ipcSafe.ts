// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { BrowserWindow, WebContents } from "electron";

export type SafeIpcSendOptions = {
  /**
   * 中文说明：当探测到渲染侧暂不可发送时，抑制后续发送的时长（毫秒）。
   * 默认 500ms。
   */
  suppressMs?: number;

  /**
   * 中文说明：可选的调试日志函数（仅在发生抑制/失败时调用）。
   */
  logger?: (message: string) => void;

  /**
   * 中文说明：日志 tag，用于区分调用方。
   */
  tag?: string;
};

const suppressedUntilByWebContents = new WeakMap<WebContents, number>();

/**
 * 中文说明：安全发送 `channel` 到指定窗口的渲染进程。
 * - 在窗口关闭、渲染进程 reload、主 Frame 暂不可用时会直接跳过；
 * - 若检测到不可发送状态，会进入短暂抑制期，避免高频重试导致日志刷屏与额外 CPU 开销；
 * - 该函数不会抛出异常（“尽力而为”语义）。
 *
 * @param win - 目标窗口（可为空）
 * @param channel - IPC 通道名
 * @param payload - 发送的负载（需可序列化）
 * @param opts - 可选配置（抑制窗口/日志）
 * @returns 是否实际执行了发送（成功发送返回 true；被跳过/失败返回 false）
 */
export function safeWindowSend(
  win: BrowserWindow | null | undefined,
  channel: string,
  payload: unknown,
  opts: SafeIpcSendOptions = {},
): boolean {
  const target = win && typeof (win as any).isDestroyed === "function" && !win.isDestroyed() ? win : null;
  if (!target) return false;

  const wc = (target as any).webContents as WebContents | undefined;
  if (!wc || (typeof (wc as any).isDestroyed === "function" && wc.isDestroyed())) return false;

  const now = Date.now();
  const until = suppressedUntilByWebContents.get(wc) || 0;
  if (now < until) return false;

  const suppressMs = clampSuppressMs(opts.suppressMs);
  const tag = opts.tag ? String(opts.tag) : "ipc";

  try {
    // 关键点：reload/导航切换过程中 mainFrame 可能暂不可访问。
    // 先探测可访问性再发送，避免 Electron 内部反复输出：
    // "Error sending from webFrameMain: Render frame was disposed ..."
    const frame: any = (wc as any).mainFrame;
    if (!frame || (typeof frame.isDestroyed === "function" && frame.isDestroyed())) return false;
    frame.send(channel, payload as any);
    return true;
  } catch (err: any) {
    suppressedUntilByWebContents.set(wc, now + suppressMs);
    if (opts.logger) {
      const msg = String(err?.message || err || "");
      opts.logger(`[${tag}] IPC 发送失败，已抑制 ${suppressMs}ms channel=${String(channel)} err=${msg}`);
    }
    return false;
  }
}

/**
 * 中文说明：将 suppressMs 限制在合理范围，避免误配置导致长时间“失联”或频繁重试。
 */
function clampSuppressMs(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 500;
  return Math.max(50, Math.min(10_000, n));
}

