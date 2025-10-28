// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 跨平台复制：优先尝试主进程 IPC，可按需切换为浏览器优先
export type CopyTextOptions = {
  preferBrowser?: boolean;
  disableFallback?: boolean;
};

// 跨平台读取：默认优先使用浏览器剪贴板
export type ReadTextOptions = {
  preferBrowser?: boolean;
  disableFallback?: boolean;
};

function getHostUtils(): any {
  try {
    return (window as any)?.host?.utils;
  } catch {
    return undefined;
  }
}

async function tryHostCopy(text: string): Promise<boolean> {
  const utils = getHostUtils();
  if (!utils || typeof utils.copyText !== "function") return false;
  try {
    const result = await utils.copyText(text);
    if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "ok")) {
      return !!result.ok;
    }
    return true;
  } catch {
    return false;
  }
}

async function tryBrowserCopy(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  return false;
}

async function tryHostRead(): Promise<{ success: boolean; text: string }> {
  const utils = getHostUtils();
  if (!utils || typeof utils.readText !== "function") {
    return { success: false, text: "" };
  }
  try {
    const result = await utils.readText();
    if (result && typeof result === "object" && !!result.ok) {
      return { success: true, text: String(result.text ?? "") };
    }
  } catch {}
  return { success: false, text: "" };
}

async function tryBrowserRead(): Promise<{ success: boolean; text: string }> {
  try {
    if (navigator?.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      return { success: true, text: String(text ?? "") };
    }
  } catch {}
  return { success: false, text: "" };
}

export async function copyTextCrossPlatform(text: string, options?: CopyTextOptions): Promise<boolean> {
  const normalized = String(text ?? "");
  if (!normalized) return false;
  const preferBrowser = !!options?.preferBrowser;
  const steps = preferBrowser
    ? [() => tryBrowserCopy(normalized), () => tryHostCopy(normalized)]
    : [() => tryHostCopy(normalized), () => tryBrowserCopy(normalized)];
  for (let i = 0; i < steps.length; i++) {
    if (i > 0 && options?.disableFallback) break;
    const step = steps[i];
    try {
      if (await step()) return true;
    } catch {}
  }
  return false;
}

export async function readTextCrossPlatform(options?: ReadTextOptions): Promise<string> {
  const preferBrowser = options?.preferBrowser !== undefined ? !!options.preferBrowser : true;
  const steps = preferBrowser
    ? [() => tryBrowserRead(), () => tryHostRead()]
    : [() => tryHostRead(), () => tryBrowserRead()];
  for (let i = 0; i < steps.length; i++) {
    if (i > 0 && options?.disableFallback) break;
    const step = steps[i];
    try {
      const result = await step();
      if (result.success) {
        return result.text;
      }
    } catch {}
  }
  return "";
}
