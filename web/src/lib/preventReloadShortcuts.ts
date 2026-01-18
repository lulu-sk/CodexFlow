// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 中文说明：阻止意外触发的“页面刷新/强制刷新”快捷键（Ctrl/Cmd+R、F5）。
 *
 * 背景
 * - CodexFlow 的终端（xterm）内 Ctrl+R 是常用快捷键（反向搜索等）。
 * - 若被浏览器默认行为拦截，会导致渲染进程 reload，表现为“白屏重载、标签页丢失、控制台清空”。
 *
 * 设计
 * - 仅 `preventDefault()`，不 `stopPropagation()`：确保按键事件仍能被 xterm/输入框接收。
 * - 使用捕获阶段监听，尽量在默认行为执行前拦截。
 */

/**
 * 中文说明：安装“阻止刷新快捷键”拦截器。
 * @returns 卸载函数（调用后移除监听）。
 */
export function installPreventReloadShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    try {
      if (!e) return;
      if (e.defaultPrevented) return;
      const key = String(e.key || "");
      const keyLower = key.toLowerCase();
      const code = String((e as any).code || "");

      const isMod = !!(e.ctrlKey || e.metaKey);
      // 避免误伤 AltGr（部分键盘布局下等价于 Ctrl+Alt），因此要求不按下 Alt
      const isReloadCombo = isMod && !e.altKey && keyLower === "r";
      const isF5 = key === "F5" || code === "F5";
      const isBrowserReloadKey = keyLower === "browserreload" || keyLower === "reload";

      if (!isReloadCombo && !isF5 && !isBrowserReloadKey) return;
      // 仅阻止默认刷新；不阻断事件传播，确保终端/输入框仍能收到 Ctrl+R 等组合键
      e.preventDefault();
    } catch {
      // noop
    }
  };

  try {
    window.addEventListener("keydown", handler, true);
  } catch {
    // noop
  }

  return () => {
    try {
      window.removeEventListener("keydown", handler, true);
    } catch {
      // noop
    }
  };
}
