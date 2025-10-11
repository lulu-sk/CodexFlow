// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { app, BrowserWindow, ipcMain } from 'electron';
import { EventEmitter } from 'node:events';
import settings from './settings';
import fs from 'node:fs';
import path from 'node:path';

// 支持语言列表（如需扩展在此添加）
export const SUPPORTED_LOCALES = ["en", "zh"] as const;
export type Locale = typeof SUPPORTED_LOCALES[number] | string;

// 事件中心：跨窗口广播语言变更
const bus = new EventEmitter();

// 规范化 locale：将系统/浏览器返回的 zh-CN/zh-Hans 等映射到 zh；en-US 映射到 en
export function normalizeLocale(input?: string): Locale {
  const raw = String(input || '').trim();
  if (!raw) return 'en';
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('en')) return 'en';
  // 宽松处理：返回语言代码主部分（如 ja-JP -> ja），不强制回退
  const m = lower.match(/^([a-z]{2,8})([-_].*)?$/);
  if (m) return m[1];
  return lower;
}

// 当前语言：优先用户设置；否则取系统语言；最终回退 en
export function getCurrentLocale(): Locale {
  try {
    const s = settings.getSettings() as any;
    if (s && typeof s.locale === 'string' && s.locale.trim()) return normalizeLocale(s.locale);
  } catch {}
  try { return normalizeLocale(app.getLocale()); } catch { return 'en'; }
}

export function setCurrentLocale(next: string) {
  const locale = normalizeLocale(next);
  try {
    // 仅更新设置中的 locale 字段，其它保持不变
    const cur = (settings as any).updateSettings ? (settings as any).updateSettings({ locale }) : null;
  } catch {}
  // 广播给所有窗口
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('i18n:localeChanged', { locale }); } catch {}
    }
  } catch {}
  // 同时触发本地事件（备用）
  setImmediate(() => bus.emit('localeChanged', locale));
}

export function onLocaleChanged(handler: (locale: string) => void): () => void {
  bus.on('localeChanged', handler);
  return () => bus.off('localeChanged', handler);
}

// 注册 IPC：供渲染进程读取/设置语言
export function registerI18nIPC() {
  try { ipcMain.removeHandler('i18n.getLocale'); } catch {}
  try { ipcMain.removeHandler('i18n.setLocale'); } catch {}
  try { ipcMain.removeHandler('i18n.userLocales.list'); } catch {}
  try { ipcMain.removeHandler('i18n.userLocales.read'); } catch {}
  try { ipcMain.removeHandler('i18n.userLocales.dir'); } catch {}
  ipcMain.handle('i18n.getLocale', async () => {
    try { return { ok: true, locale: getCurrentLocale() }; } catch (e: any) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('i18n.setLocale', async (_e, { locale }: { locale: string }) => {
    try { setCurrentLocale(locale); return { ok: true, locale: getCurrentLocale() }; } catch (e: any) { return { ok: false, error: String(e) }; }
  });
  // 用户自定义语言包（userData/locales/<lng>/<ns>.json）
  ipcMain.handle('i18n.userLocales.dir', async () => {
    try { return { ok: true, dir: path.join(app.getPath('userData'), 'locales') }; } catch (e: any) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('i18n.userLocales.list', async () => {
    try {
      const dir = path.join(app.getPath('userData'), 'locales');
      if (!fs.existsSync(dir)) return { ok: true, languages: [] };
      const langs: string[] = [];
      for (const d of fs.readdirSync(dir)) {
        const p = path.join(dir, d);
        try { if (fs.statSync(p).isDirectory()) langs.push(d); } catch {}
      }
      return { ok: true, languages: langs };
    } catch (e: any) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('i18n.userLocales.read', async (_e, { lng, ns }: { lng: string; ns: string }) => {
    try {
      const file = path.join(app.getPath('userData'), 'locales', String(lng), `${String(ns)}.json`);
      if (!fs.existsSync(file)) return { ok: true, data: null };
      const text = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(text);
      return { ok: true, data: json };
    } catch (e: any) { return { ok: false, error: String(e) }; }
  });
}

export default {
  SUPPORTED_LOCALES,
  normalizeLocale,
  getCurrentLocale,
  setCurrentLocale,
  onLocaleChanged,
  registerI18nIPC,
};
