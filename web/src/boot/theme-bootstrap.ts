// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { applyTheme, getCachedThemeSetting, type ThemeSetting } from "@/lib/theme";

/**
 * 中文说明：在 React 入口加载前尽早应用主题设置，尽量减少首帧闪烁。
 * - 立即设置 html 元素的 class/dataset 与背景色
 * - 若 body 尚未就绪，则在 DOMContentLoaded 时再补一次（保持与旧版内联脚本一致）
 */
export function applyInitialThemeBootstrap(): void {
  const setting: ThemeSetting = getCachedThemeSetting() ?? "system";
  applyTheme(setting);

  // body 在 <head> 执行脚本时可能尚未创建，需在 DOMReady 后补齐 body 的 class/style。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => applyTheme(setting), { once: true });
  }
}

applyInitialThemeBootstrap();
