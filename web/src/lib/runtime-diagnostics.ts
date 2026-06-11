// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const RENDERER_DIAGNOSTICS_INSTALLED_KEY = "__cf_renderer_runtime_diagnostics_installed__";
const RENDERER_HEARTBEAT_INTERVAL_MS = 1000;
const RENDERER_HEARTBEAT_WARN_DRIFT_MS = 700;
const RENDERER_HEARTBEAT_MIN_LOG_GAP_MS = 3000;
const RENDERER_LONG_TASK_WARN_MS = 200;
const RENDERER_LONG_TASK_MIN_LOG_GAP_MS = 1500;

let rendererDiagnosticsEnabled = false;

/**
 * 返回当前单调时间，用于避免系统时间变化影响耗时计算。
 */
function nowMs(): number {
  try { return typeof performance !== "undefined" ? performance.now() : Date.now(); } catch { return Date.now(); }
}

/**
 * 裁剪日志字段，避免异常对象或 URL 放大 perf.log。
 */
function clampLogValue(value: unknown, maxLength = 180): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/**
 * 写入普通渲染诊断日志；仅在 `global.diagLog` 开启后落盘。
 */
function logRendererDiagnostic(message: string): void {
  if (!rendererDiagnosticsEnabled) return;
  try { void window.host?.utils?.perfLog?.(`[renderer.runtime] ${message}`); } catch {}
}

/**
 * 从主进程调试配置同步诊断开关。
 */
async function refreshRendererDiagnosticsEnabled(): Promise<void> {
  try {
    const cfg = await window.host?.debug?.get?.();
    rendererDiagnosticsEnabled = !!cfg?.global?.diagLog;
  } catch {
    rendererDiagnosticsEnabled = false;
  }
}

/**
 * 安装渲染线程心跳漂移探针，用于定位 UI 主线程被同步任务阻塞的时间段。
 */
function installHeartbeatProbe(): void {
  let expectedAt = nowMs() + RENDERER_HEARTBEAT_INTERVAL_MS;
  let lastLoggedAt = 0;
  const timer = window.setInterval(() => {
    try {
      const now = nowMs();
      const driftMs = now - expectedAt;
      expectedAt = now + RENDERER_HEARTBEAT_INTERVAL_MS;
      if (driftMs < RENDERER_HEARTBEAT_WARN_DRIFT_MS) return;
      if (now - lastLoggedAt < RENDERER_HEARTBEAT_MIN_LOG_GAP_MS) return;
      lastLoggedAt = now;
      logRendererDiagnostic(`eventLoop.blocked driftMs=${Math.round(driftMs)} intervalMs=${RENDERER_HEARTBEAT_INTERVAL_MS} visibility=${document.visibilityState}`);
    } catch {}
  }, RENDERER_HEARTBEAT_INTERVAL_MS);
  try { (timer as any).unref?.(); } catch {}
}

/**
 * 安装 Long Task 观察器，用于记录浏览器主线程长任务。
 */
function installLongTaskProbe(): void {
  try {
    const PerformanceObserverCtor = window.PerformanceObserver;
    if (!PerformanceObserverCtor) return;
    const supported = (PerformanceObserverCtor as any).supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes("longtask")) return;
    let lastLoggedAt = 0;
    const observer = new PerformanceObserverCtor((list) => {
      try {
        for (const entry of list.getEntries()) {
          const durationMs = Number(entry.duration || 0);
          if (durationMs < RENDERER_LONG_TASK_WARN_MS) continue;
          const now = nowMs();
          if (now - lastLoggedAt < RENDERER_LONG_TASK_MIN_LOG_GAP_MS) continue;
          lastLoggedAt = now;
          logRendererDiagnostic(
            `longTask durationMs=${Math.round(durationMs)} startMs=${Math.round(Number(entry.startTime || 0))} name=${clampLogValue(entry.name)} visibility=${document.visibilityState}`,
          );
        }
      } catch {}
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {}
}

/**
 * 安装渲染进程运行时诊断探针。
 */
export function installRendererRuntimeDiagnostics(): void {
  if (typeof window === "undefined") return;
  const globalWindow = window as typeof window & { [RENDERER_DIAGNOSTICS_INSTALLED_KEY]?: boolean };
  if (globalWindow[RENDERER_DIAGNOSTICS_INSTALLED_KEY]) return;
  globalWindow[RENDERER_DIAGNOSTICS_INSTALLED_KEY] = true;

  void refreshRendererDiagnosticsEnabled().then(() => {
    logRendererDiagnostic(`installed href=${clampLogValue(window.location.href, 260)}`);
  });
  try {
    window.host?.debug?.onChanged?.(() => {
      void refreshRendererDiagnosticsEnabled();
    });
  } catch {}

  installHeartbeatProbe();
  installLongTaskProbe();
}
