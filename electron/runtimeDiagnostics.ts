// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { ipcMain } from "electron";
import { performance } from "node:perf_hooks";
import { getDebugConfig } from "./debugConfig";
import { perfLogger } from "./log";

type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any;

const MAIN_EVENT_LOOP_INTERVAL_MS = 1000;
const MAIN_EVENT_LOOP_WARN_DRIFT_MS = 700;
const MAIN_EVENT_LOOP_MIN_LOG_GAP_MS = 3000;
const MAIN_SLOW_IPC_WARN_MS = 700;
const MAIN_IPC_PAYLOAD_PREVIEW_LIMIT = 220;

let eventLoopProbeInstalled = false;
let ipcTimingInstalled = false;

/**
 * 判断普通诊断日志是否启用，关闭时跳过低优先级诊断组装。
 */
function isDiagLogEnabled(): boolean {
  try { return !!getDebugConfig()?.global?.diagLog; } catch { return false; }
}

/**
 * 返回当前单调时间，避免系统时间变化影响耗时计算。
 */
function nowMs(): number {
  try { return performance.now(); } catch { return Date.now(); }
}

/**
 * 将日志字段裁剪为稳定长度，避免大型 payload 放大 perf.log。
 */
function clampLogValue(value: unknown, maxLen = MAIN_IPC_PAYLOAD_PREVIEW_LIMIT): string {
  const text = (() => {
    try {
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  const safe = String(text ?? "").replace(/\s+/g, " ").trim();
  return safe.length > maxLen ? `${safe.slice(0, maxLen)}...` : safe;
}

/**
 * 生成 IPC 参数预览，只保留数量、类型和长度，避免记录用户正文内容。
 */
function summarizeIpcArgs(args: any[]): string {
  try {
    if (!Array.isArray(args) || args.length === 0) return "args=0";
    const preview = args.slice(0, 3).map((arg) => {
      if (arg == null) return String(arg);
      if (typeof arg === "string") return `string:${arg.length}`;
      if (typeof arg === "number" || typeof arg === "boolean") return `${typeof arg}:${String(arg)}`;
      if (Array.isArray(arg)) return `array:${arg.length}`;
      if (typeof arg === "object") {
        const keys = Object.keys(arg).slice(0, 8).join(",");
        return `object:${keys}`;
      }
      return typeof arg;
    }).join("|");
    const more = args.length > 3 ? ` more=${args.length - 3}` : "";
    return `args=${args.length} preview=${clampLogValue(preview)}${more}`;
  } catch {
    return `args=${Array.isArray(args) ? args.length : 0}`;
  }
}

/**
 * 记录慢 IPC handler，帮助区分主进程任务耗时和渲染进程等待。
 */
function logSlowIpc(channel: string, durationMs: number, ok: boolean, args: any[], error?: unknown): void {
  if (!isDiagLogEnabled()) return;
  const errorText = error ? ` error="${clampLogValue((error as any)?.message || error, 180)}"` : "";
  try {
    perfLogger.log(`[main.ipc.slow] channel=${channel} ok=${ok ? 1 : 0} durationMs=${Math.round(durationMs)} ${summarizeIpcArgs(args)}${errorText}`);
  } catch {}
}

/**
 * 安装主进程 IPC handler 耗时拦截。
 */
export function installMainIpcTimingDiagnostics(): void {
  if (ipcTimingInstalled) return;
  ipcTimingInstalled = true;
  const originalHandle = ipcMain.handle.bind(ipcMain);
  (ipcMain as any).handle = (channel: string, listener: IpcHandler) => {
    if (typeof listener !== "function") return originalHandle(channel, listener);
    const wrapped: IpcHandler = async (event, ...args) => {
      const startedAt = nowMs();
      try {
        const result = await listener(event, ...args);
        const durationMs = nowMs() - startedAt;
        if (durationMs >= MAIN_SLOW_IPC_WARN_MS && channel !== "utils.perfLog" && channel !== "utils.perfLogCritical")
          logSlowIpc(channel, durationMs, true, args);
        return result;
      } catch (error) {
        const durationMs = nowMs() - startedAt;
        if (durationMs >= MAIN_SLOW_IPC_WARN_MS)
          logSlowIpc(channel, durationMs, false, args, error);
        throw error;
      }
    };
    return originalHandle(channel, wrapped);
  };
}

/**
 * 安装主进程事件循环漂移探针，用于定位主进程被同步任务阻塞的时间段。
 */
export function installMainEventLoopDiagnostics(): void {
  if (eventLoopProbeInstalled) return;
  eventLoopProbeInstalled = true;

  let expectedAt = nowMs() + MAIN_EVENT_LOOP_INTERVAL_MS;
  let lastLoggedAt = 0;
  const timer = setInterval(() => {
    try {
      const now = nowMs();
      const driftMs = now - expectedAt;
      expectedAt = now + MAIN_EVENT_LOOP_INTERVAL_MS;
      if (driftMs < MAIN_EVENT_LOOP_WARN_DRIFT_MS) return;
      if (!isDiagLogEnabled()) return;
      if (now - lastLoggedAt < MAIN_EVENT_LOOP_MIN_LOG_GAP_MS) return;
      lastLoggedAt = now;
      perfLogger.log(`[main.eventLoop.blocked] driftMs=${Math.round(driftMs)} intervalMs=${MAIN_EVENT_LOOP_INTERVAL_MS}`);
    } catch {}
  }, MAIN_EVENT_LOOP_INTERVAL_MS);
  try { (timer as any).unref?.(); } catch {}
}
