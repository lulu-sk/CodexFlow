// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 中文说明：写入渲染层生命周期诊断日志。
 */
function logRendererLifecycle(message: string): void {
  try {
    void (window as any)?.host?.utils?.perfLogCritical?.(`[renderer.lifecycle] ${message}`);
  } catch {}
}

const RENDERER_LIFECYCLE_LOG_INSTALLED_KEY = "__cf_renderer_lifecycle_log_installed__";

/**
 * 中文说明：安装渲染层刷新/导航日志。
 * - 记录启动时的 navigation type；
 * - 记录 `beforeunload` / `pagehide`，用于定位“界面突然刷新”的前置动作；
 * - 记录页面被切到隐藏态，辅助排查外部导航或异常重载前状态。
 * - 仅安装一次，避免 HMR 或重复执行时产生日志放大。
 */
export function installRendererLifecycleLogging(): void {
  if (typeof window === "undefined") return;
  const globalWindow = window as typeof window & { [RENDERER_LIFECYCLE_LOG_INSTALLED_KEY]?: boolean };
  if (globalWindow[RENDERER_LIFECYCLE_LOG_INSTALLED_KEY]) return;
  globalWindow[RENDERER_LIFECYCLE_LOG_INSTALLED_KEY] = true;
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const navType = typeof entry?.type === "string" ? entry.type : "unknown";
    logRendererLifecycle(`boot href=${window.location.href} navType=${navType} referrer=${document.referrer || ""}`);
  } catch {}
  window.addEventListener("beforeunload", () => {
    logRendererLifecycle(`beforeunload href=${window.location.href} visibility=${document.visibilityState}`);
  });
  window.addEventListener("pagehide", (event) => {
    const persisted = (event as PageTransitionEvent).persisted ? 1 : 0;
    logRendererLifecycle(`pagehide href=${window.location.href} persisted=${persisted}`);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    logRendererLifecycle(`visibility hidden href=${window.location.href}`);
  });
}
