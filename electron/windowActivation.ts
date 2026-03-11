import { app, type BrowserWindow } from "electron";

export type WindowActivationSnapshot = {
  wasMinimized: boolean;
  wasVisible: boolean;
  wasFullScreen: boolean;
  usedRestore: boolean;
  usedShow: boolean;
  usedAlwaysOnTopHack: boolean;
  usedMoveTop: boolean;
  focusedWindow: boolean;
  focusedApp: boolean;
};

type ActivateWindowOptions = {
  platform?: NodeJS.Platform;
};

/**
 * 中文说明：安全读取窗口布尔状态，读取失败时回退到给定默认值。
 */
function readWindowFlag(read: () => boolean, fallback: boolean): boolean {
  try {
    return !!read();
  } catch {
    return fallback;
  }
}

/**
 * 中文说明：尝试让应用进入前台；在支持时优先请求 steal 模式，失败后回退到普通 focus。
 */
function focusApplication(): boolean {
  try {
    app.focus({ steal: true } as any);
    return true;
  } catch {
    try {
      app.focus();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 中文说明：唤醒主窗口到前台，同时尽量保持原有窗口状态不变。
 * - 已可见的全屏窗口只做应用/窗口聚焦，避免执行可能导致退出全屏的 show、moveTop、置顶抖动。
 * - 最小化窗口优先 restore；隐藏窗口仅在确有需要时 show。
 */
export function activateWindowPreservingState(win: BrowserWindow, options?: ActivateWindowOptions): WindowActivationSnapshot {
  const platform = options?.platform ?? process.platform;
  const wasMinimized = readWindowFlag(() => win.isMinimized(), false);
  const wasVisible = readWindowFlag(() => win.isVisible(), true);
  const wasFullScreen = readWindowFlag(() => win.isFullScreen(), false);

  let usedRestore = false;
  let usedShow = false;
  let usedAlwaysOnTopHack = false;
  let usedMoveTop = false;
  let focusedWindow = false;

  if (wasMinimized) {
    try {
      win.restore();
      usedRestore = true;
    } catch {}
  }

  if (!wasMinimized && !wasVisible) {
    try {
      win.show();
      usedShow = true;
    } catch {}
  }

  if (platform === "win32" && !wasFullScreen) {
    const wasAlwaysOnTop = readWindowFlag(() => win.isAlwaysOnTop(), false);
    if (!wasAlwaysOnTop) {
      let enabled = false;
      try {
        win.setAlwaysOnTop(true);
        enabled = true;
      } catch {}
      if (enabled) {
        try {
          win.setAlwaysOnTop(false);
          usedAlwaysOnTopHack = true;
        } catch {}
      }
    }
  }

  const focusedApp = focusApplication();

  try {
    win.focus();
    focusedWindow = true;
  } catch {}

  if (platform === "win32" && !wasFullScreen) {
    try {
      win.moveTop();
      usedMoveTop = true;
    } catch {}
  }

  return {
    wasMinimized,
    wasVisible,
    wasFullScreen,
    usedRestore,
    usedShow,
    usedAlwaysOnTopHack,
    usedMoveTop,
    focusedWindow,
    focusedApp,
  };
}
