// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import ICU from "i18next-icu";
import resourcesToBackend from "i18next-resources-to-backend";

// 统一的初始化函数：按需加载命名空间资源，默认 common
// - 资源路径：@/locales/<lng>/<ns>.json
// - 语言来源：主进程设置（window.host.i18n），否则 navigator.language

const SUPPORTED_LNGS = ["en", "zh"] as const;

function normalizeLocale(input?: string): string {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return "en";
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("en")) return "en";
  const m = raw.match(/^([a-z]{2,8})([-_].*)?$/);
  if (m) return m[1];
  return raw;
}

async function detectInitialLanguage(): Promise<string> {
  try {
    const res = await (window as any)?.host?.i18n?.getLocale?.();
    if (res && res.ok && res.locale) return normalizeLocale(res.locale);
  } catch {}
  try { return normalizeLocale(navigator.language); } catch { return "en"; }
}

// 通过 Vite 的 import.meta.glob 预注册所有本地 JSON 资源，避免运行时路径无法解析
const LOCALE_MODULES: Record<string, () => Promise<any>> = import.meta.glob("../locales/**/*.json");

function detectedCompiledLanguages(): string[] {
  const set = new Set<string>();
  for (const k of Object.keys(LOCALE_MODULES)) {
    const m = k.match(/\.\.\/locales\/([^/]+)\//);
    if (m) set.add(m[1]);
  }
  return Array.from(set);
}

export async function initI18n(): Promise<I18nInstance> {
  const lng = await detectInitialLanguage();
  if (i18next.isInitialized) {
    try { await i18next.changeLanguage(lng); } catch {}
    return i18next;
  }

  await i18next
    .use(ICU)
    .use(initReactI18next)
    .use(resourcesToBackend(async (language: string, namespace: string) => {
      // 先尝试用户目录语言包
      try {
        const res = await (window as any)?.host?.i18n?.userLocales?.read?.(language, namespace);
        if (res && res.ok && res.data) return res.data;
      } catch {}
      // 再尝试打包内资源
      const key = `../locales/${language}/${namespace}.json`;
      const mod = LOCALE_MODULES[key];
      if (mod) return mod();
      return {} as any;
    }))
    .init({
      lng,
      fallbackLng: "en",
      supportedLngs: detectedCompiledLanguages(),
      ns: ["common"],
      defaultNS: "common",
      interpolation: { escapeValue: false },
      returnNull: false,
      returnEmptyString: false,
      react: { useSuspense: false },
      // 缺失键时在控制台警告，便于后续补齐
      saveMissing: false,
      missingKeyHandler: (lngs, ns, key) => {
        try { console.warn(`[i18n] missing key: ${ns}:${key} @ ${lngs}`); } catch {}
      }
    });

  // 监听主进程语言变更并同步到 i18next
  try {
    (window as any)?.host?.i18n?.onLocaleChanged?.((payload: { locale: string }) => {
      const next = normalizeLocale(payload?.locale);
      if (next && next !== i18next.language) {
        i18next.changeLanguage(next).catch(() => {});
      }
    });
  } catch {}

  // 将当前语言应用到 <html lang>，便于可访问性与字体回退
  const applyLangToDOM = (lang?: string) => {
    try {
      const el = document?.documentElement;
      if (!el) return;
      el.setAttribute('lang', (lang || i18next.language || 'en'));
      el.setAttribute('dir', 'ltr');
    } catch {}
  };
  applyLangToDOM(lng);
  try { i18next.on('languageChanged', (l) => applyLangToDOM(l)); } catch {}

  return i18next;
}

export async function changeAppLanguage(locale: string) {
  const next = normalizeLocale(locale);
  try { await (window as any)?.host?.i18n?.setLocale?.(next); } catch {}
  try { await i18next.changeLanguage(next); } catch {}
}

export async function listAvailableLanguages(): Promise<string[]> {
  const compiled = detectedCompiledLanguages();
  const user = await (async () => {
    try { const r = await (window as any)?.host?.i18n?.userLocales?.list?.(); if (r && r.ok && Array.isArray(r.languages)) return r.languages; } catch {}
    return [];
  })();
  const set = new Set<string>([...compiled, ...user]);
  return Array.from(set);
}

export default i18next;
