// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Notification, nativeImage, Event } from 'electron';
import settings from './settings';
import { perfLogger } from './log';

type BadgePayload = { count?: number };

type CompletionPayload = {
  tabId: string;
  tabName?: string;
  projectName?: string;
  preview?: string;
  title?: string;
  body?: string;
  appTitle?: string;
};

const OVERLAY_CACHE = new Map<string, Electron.NativeImage>();
const BADGE_CANVAS_SIZE = 32;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_SCALE = 2;
const GLYPH_GAP = 2;
const GLYPHS: Record<string, number[]> = {
  '0': [
    0b01110,
    0b10001,
    0b10011,
    0b10101,
    0b11001,
    0b10001,
    0b01110,
  ],
  '1': [
    0b00100,
    0b01100,
    0b00100,
    0b00100,
    0b00100,
    0b00100,
    0b01110,
  ],
  '2': [
    0b01110,
    0b10001,
    0b00001,
    0b00110,
    0b01000,
    0b10000,
    0b11111,
  ],
  '3': [
    0b11110,
    0b00001,
    0b00001,
    0b01110,
    0b00001,
    0b00001,
    0b11110,
  ],
  '4': [
    0b00010,
    0b00110,
    0b01010,
    0b10010,
    0b11111,
    0b00010,
    0b00010,
  ],
  '5': [
    0b11111,
    0b10000,
    0b10000,
    0b11110,
    0b00001,
    0b00001,
    0b11110,
  ],
  '6': [
    0b01110,
    0b10000,
    0b10000,
    0b11110,
    0b10001,
    0b10001,
    0b01110,
  ],
  '7': [
    0b11111,
    0b00001,
    0b00010,
    0b00010,
    0b00100,
    0b00100,
    0b00100,
  ],
  '8': [
    0b01110,
    0b10001,
    0b10001,
    0b01110,
    0b10001,
    0b10001,
    0b01110,
  ],
  '9': [
    0b01110,
    0b10001,
    0b10001,
    0b01111,
    0b00001,
    0b00001,
    0b01110,
  ],
  '+': [
    0b00100,
    0b00100,
    0b00100,
    0b11111,
    0b00100,
    0b00100,
    0b00100,
  ],
};
const FALLBACK_GLYPH = [
  0b11111,
  0b10001,
  0b00010,
  0b00100,
  0b01000,
  0b10001,
  0b11111,
];

type NotificationIconCache = { image?: Electron.NativeImage; filePath?: string };

let notificationIconCache: NotificationIconCache | null = null;
const ACTIVE_NOTIFICATIONS = new Set<Electron.Notification>();

function escapeXml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&apos;';
      default: return ch;
    }
  });
}

function resolveNotificationIcon(): NotificationIconCache {
  if (notificationIconCache) return notificationIconCache;
  const cache: NotificationIconCache = {};
  const iconNames = process.platform === 'win32' ? ['icon.png', 'icon.ico'] : ['icon.png', 'icon.ico'];
  const candidates: string[] = [];
  try {
    if (app.isPackaged) {
      for (const name of iconNames) {
        candidates.push(path.join(process.resourcesPath, name));
        candidates.push(path.join(process.resourcesPath, 'build', name));
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'build', name));
      }
    } else {
      for (const name of iconNames) {
        candidates.push(path.join(process.cwd(), 'build', name));
      }
    }
  } catch (error) {
    logNotification(`resolveNotificationIcon candidates failed: ${String(error)}`);
  }
  for (const candidate of candidates) {
    try {
      if (!candidate) continue;
      if (!fs.existsSync(candidate)) continue;
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        cache.image = image;
        let effectivePath = candidate;
        if (/\.ico$/i.test(candidate)) {
          try {
            const pngBuffer = image.toPNG();
            const tmpDir = path.join(app.getPath('temp'), 'codexflow');
            try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
            const tmpFile = path.join(tmpDir, 'toast-icon.png');
            fs.writeFileSync(tmpFile, pngBuffer);
            effectivePath = tmpFile;
            logNotification(`notification icon converted ico->png src=${candidate} dst=${tmpFile}`);
          } catch (error) {
            logNotification(`notification icon convert failed path=${candidate} error=${String(error)}`);
          }
        }
        cache.filePath = effectivePath;
        logNotification(`notification icon resolved path=${effectivePath}`);
        notificationIconCache = cache;
        return cache;
      }
    } catch (error) {
      logNotification(`notification icon load error path=${candidate} error=${String(error)}`);
    }
  }
  notificationIconCache = cache;
  return cache;
}

function setPixel(buffer: Buffer, x: number, y: number, r: number, g: number, b: number, a: number) {
  if (x < 0 || y < 0 || x >= BADGE_CANVAS_SIZE || y >= BADGE_CANVAS_SIZE) return;
  const offset = (y * BADGE_CANVAS_SIZE + x) * 4;
  buffer[offset] = b;
  buffer[offset + 1] = g;
  buffer[offset + 2] = r;
  buffer[offset + 3] = a;
}

function drawCircle(buffer: Buffer) {
  const radius = BADGE_CANVAS_SIZE / 2 - 1;
  const cx = BADGE_CANVAS_SIZE / 2 - 0.5;
  const cy = BADGE_CANVAS_SIZE / 2 - 0.5;
  for (let y = 0; y < BADGE_CANVAS_SIZE; y += 1) {
    for (let x = 0; x < BADGE_CANVAS_SIZE; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(buffer, x, y, 209, 67, 67, 255);
      }
    }
  }
}

function drawGlyph(buffer: Buffer, glyph: number[], startX: number, startY: number) {
  for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
    const mask = glyph[row] ?? 0;
    for (let col = 0; col < GLYPH_WIDTH; col += 1) {
      const bit = (mask >> (GLYPH_WIDTH - 1 - col)) & 1;
      if (!bit) continue;
      for (let sy = 0; sy < GLYPH_SCALE; sy += 1) {
        for (let sx = 0; sx < GLYPH_SCALE; sx += 1) {
          setPixel(buffer, startX + col * GLYPH_SCALE + sx, startY + row * GLYPH_SCALE + sy, 255, 255, 255, 255);
        }
      }
    }
  }
}

function renderBadgeBitmap(text: string): Buffer {
  const label = text || '1';
  const buffer = Buffer.alloc(BADGE_CANVAS_SIZE * BADGE_CANVAS_SIZE * 4, 0);
  drawCircle(buffer);
  const glyphWidthPx = GLYPH_WIDTH * GLYPH_SCALE;
  const glyphHeightPx = GLYPH_HEIGHT * GLYPH_SCALE;
  const totalWidth = label.length * glyphWidthPx + (label.length - 1) * GLYPH_GAP;
  const startX = Math.max(0, Math.floor((BADGE_CANVAS_SIZE - totalWidth) / 2));
  const startY = Math.max(0, Math.floor((BADGE_CANVAS_SIZE - glyphHeightPx) / 2));
  let cursor = startX;
  for (const ch of label) {
    const glyph = GLYPHS[ch] ?? FALLBACK_GLYPH;
    drawGlyph(buffer, glyph, cursor, startY);
    cursor += glyphWidthPx + GLYPH_GAP;
  }
  return buffer;
}

function logNotification(message: string) {
  try { perfLogger.log(`[notifications] ${message}`); } catch {}
}

function coerceCount(input?: number): number {
  if (typeof input !== 'number' || Number.isNaN(input) || !Number.isFinite(input)) return 0;
  return Math.max(0, Math.floor(input));
}

function labelForCount(count: number): string {
  if (count >= 100) return '99+';
  return String(count);
}

function createOverlayIcon(label: string): Electron.NativeImage {
  const cached = OVERLAY_CACHE.get(label);
  if (cached) return cached;
  const text = label.length > 3 ? label.slice(0, 3) : label;
  const bitmap = renderBadgeBitmap(text);
  let image = nativeImage.createFromBitmap(bitmap, {
    width: BADGE_CANVAS_SIZE,
    height: BADGE_CANVAS_SIZE,
    scaleFactor: 1,
  });
  if (!image.isEmpty()) {
    image = image.resize({ width: 32, height: 32, quality: 'best' });
  }
  OVERLAY_CACHE.set(label, image);
  logNotification(`overlay icon generated label=${label} size=${JSON.stringify(image.getSize())} empty=${image.isEmpty()}`);
  return image;
}

function shouldEnableBadge(): boolean {
  try {
    const cfg = settings.getSettings();
    return cfg.notifications?.badge ?? true;
  } catch {
    logNotification('badge preference fallback -> true');
    return true;
  }
}

function shouldEnableSystemNotification(): boolean {
  try {
    const cfg = settings.getSettings();
    return cfg.notifications?.system ?? true;
  } catch {
    logNotification('system preference fallback -> true');
    return true;
  }
}

function shouldMuteSystemNotificationSound(): boolean {
  try {
    const cfg = settings.getSettings();
    const override = (cfg.notifications as any)?.systemSound;
    if (typeof override === 'boolean') {
      return !override;
    }
    if (cfg.notifications?.sound) {
      // 前端会播放自定义提示音，系统通知保持静音避免重复提示。
      return true;
    }
    // 未开启提示音时同样静音系统通知，确保完全无声。
    return true;
  } catch (error) {
    logNotification(`system notification sound mute fallback -> true: ${String(error)}`);
    return true;
  }
}

type NotificationOptions = {
  appUserModelId?: string;
  protocolScheme?: string;
};

export function registerNotificationIPC(getWindow: () => BrowserWindow | null, options?: NotificationOptions) {
  const appUserModelId = typeof options?.appUserModelId === 'string'
    ? options.appUserModelId.trim()
    : '';
  const protocolScheme = (() => {
    const scheme = typeof options?.protocolScheme === 'string' ? options.protocolScheme.trim() : '';
    return scheme || 'codexflow';
  })();
  logNotification(`register IPC appUserModelId=${appUserModelId || 'none'}`);
  const updateBadge = (count: number) => {
    const enabled = shouldEnableBadge();
    const safe = enabled ? count : 0;
    logNotification(`updateBadge count=${count} effective=${safe} enabled=${enabled} platform=${process.platform}`);
    try { app.setBadgeCount(safe); } catch {}
    if (process.platform === 'win32') {
      const win = getWindow();
      if (!win) return;
      if (safe > 0) {
        const label = labelForCount(safe);
        const icon = createOverlayIcon(label);
        try {
          win.setOverlayIcon(icon, `${label}`);
          logNotification(`setOverlayIcon label=${label}`);
        } catch (error) {
          logNotification(`setOverlayIcon failed: ${String(error)}`);
        }
      } else {
        try {
          win.setOverlayIcon(null, '');
          logNotification('clear overlay icon');
        } catch (error) {
          logNotification(`clear overlay icon failed: ${String(error)}`);
        }
      }
    }
  };

  ipcMain.on('notifications:setBadge', (_event, payload: BadgePayload) => {
    const count = coerceCount(payload?.count);
    logNotification(`setBadge IPC count=${count}`);
    updateBadge(count);
  });

  ipcMain.on('notifications:agentComplete', (_event, payload: CompletionPayload) => {
    if (!payload || typeof payload.tabId !== 'string') return;
    logNotification(`agentComplete IPC tabId=${payload.tabId} previewLength=${payload?.preview ? payload.preview.length : 0}`);
    if (!shouldEnableSystemNotification()) {
      logNotification('system notification skipped: disabled in settings');
      return;
    }
    const muteSystemSound = shouldMuteSystemNotificationSound();
    const supported = typeof Notification === 'function' && typeof Notification.isSupported === 'function'
      ? Notification.isSupported()
      : false;
    logNotification(`Notification.isSupported=${supported}`);
    if (!supported) {
      logNotification('system notification skipped: API not supported');
      return;
    }
    const appTitle = payload.appTitle && payload.appTitle.trim() ? payload.appTitle.trim() : (app.getName() || 'CodexFlow');
    const title = payload.title && payload.title.trim() ? payload.title.trim() : appTitle;
    const rawBody = payload.body && payload.body.trim() ? payload.body.trim() : '';
    const preview = payload.preview && payload.preview.trim() ? payload.preview.trim() : '';
    const body = rawBody || preview;
    const icon = resolveNotificationIcon();
    logNotification(`show notification title="${title}" bodyLength=${body.length} displayName="${appTitle}" iconPath=${icon.filePath || 'none'}`);
    let note: Electron.Notification;
    if (process.platform === 'win32') {
      // Windows 通知中心对 click 事件存在长期缺陷，采用协议激活保证 Action Center 点击能回传 tabId
      const scheme = protocolScheme.toLowerCase();
      const launchUrl = `${scheme}://focus-tab?tabId=${encodeURIComponent(payload.tabId)}`;
      const parts: string[] = [];
      parts.push(`<toast launch="${escapeXml(launchUrl)}" activationType="protocol">`);
      parts.push('<visual><binding template="ToastGeneric">');
      parts.push(`<text>${escapeXml(title)}</text>`);
      if (body) parts.push(`<text>${escapeXml(body)}</text>`);
      if (icon.filePath) {
        try {
          const iconUrl = pathToFileURL(icon.filePath).toString();
          parts.push(`<image placement="appLogoOverride" src="${escapeXml(iconUrl)}" />`);
        } catch (error) {
          logNotification(`toast icon to url failed: ${String(error)}`);
        }
      }
      parts.push('</binding></visual>');
      if (muteSystemSound) {
        parts.push('<audio silent="true" />');
      }
      parts.push('</toast>');
      const toastXml = parts.join('');
      const txOpts = { toastXml, silent: muteSystemSound } as Electron.NotificationConstructorOptions & { toastXml: string; appID?: string };
      if (appUserModelId) txOpts.appID = appUserModelId;
      note = new Notification(txOpts);
    } else {
      const noteOptions = {
        title,
        body,
        silent: muteSystemSound,
        timeoutType: 'default' as const,
      } as Electron.NotificationConstructorOptions & { appID?: string; timeoutType?: 'default' | 'never' };
      if (appUserModelId) noteOptions.appID = appUserModelId;
      if (icon.image && !icon.image.isEmpty()) {
        noteOptions.icon = icon.image;
      } else if (icon.filePath) {
        noteOptions.icon = icon.filePath;
      }
      note = new Notification(noteOptions);
    }
    let activated = false;
    const teardown = () => {
      if (!ACTIVE_NOTIFICATIONS.has(note)) return;
      ACTIVE_NOTIFICATIONS.delete(note);
      logNotification(`notification disposed tabId=${payload.tabId}`);
    };
    const focusTab = (source: string, opts?: { skipClose?: boolean }) => {
      if (!activated) {
        activated = true;
        logNotification(`notification focus source=${source} tabId=${payload.tabId}`);
        const win = getWindow();
        if (win) {
          if (win.isMinimized()) {
            try { win.restore(); } catch {}
          }
          try { win.show(); win.focus(); } catch {}
          try { win.webContents.send('notifications:focus-tab', { tabId: payload.tabId }); } catch {}
        } else {
          logNotification(`notification focus skipped (window missing) source=${source} tabId=${payload.tabId}`);
        }
      } else {
        logNotification(`notification focus duplicate source=${source} tabId=${payload.tabId}`);
      }
      if (!opts?.skipClose) {
        try { note.close(); } catch {}
      }
    };
    note.on('click', () => focusTab('click'));
    note.on('action', (_event, index) => focusTab(`action:${index}`));
    const handleClose = (event: Event, rawReason?: string) => {
      // Windows 通知中心在关闭回调里可能通过第二个参数或 event.reason 提供激活状态
      const eventReason = (event as any)?.reason;
      const source = typeof rawReason === 'string' && rawReason.trim()
        ? rawReason
        : (typeof eventReason === 'string' ? eventReason : '');
      const reason = source.trim().toLowerCase();
      logNotification(`notification close reason=${reason || 'n/a'} tabId=${payload.tabId}`);
      if (!activated && reason && reason.includes('activat')) {
        // 部分 Windows 版本在通知中心点击时仅触发 close(reason=activated/activation)
        // 这里仍视为点击并调用 focusTab（会执行 note.close()），确保 Action Center 条目正确清理
        focusTab(`close:${reason}`);
      }
      teardown();
    };
    note.on('close', handleClose as any);
    note.on('failed', (event, error) => {
      logNotification(`notification failed error=${error}`);
      teardown();
    });
    ACTIVE_NOTIFICATIONS.add(note);
    try {
      note.show();
      logNotification(`notification shown tabId=${payload.tabId} muteSound=${muteSystemSound ? '1' : '0'}`);
    } catch (error) {
      logNotification(`notification show failed: ${String(error)}`);
      teardown();
    }
  });
}
