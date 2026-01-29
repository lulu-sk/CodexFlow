// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import ICU from "i18next-icu";
import resourcesToBackend from "i18next-resources-to-backend";

// 统一的初始化函数：启动预加载内置命名空间（避免首屏 key 闪烁），其余仍按需加载
// - 资源路径：@/locales/<lng>/<ns>.json
// - 语言来源：主进程设置（window.host.i18n），否则 navigator.language

const SUPPORTED_LNGS = ["en", "zh"] as const;

/**
 * 规范化 locale 输入，统一为 i18n 使用的语言码。
 * @param input 任意 locale 字符串（如 zh-CN、en-US）
 * @returns 规范化后的语言码（如 zh、en）
 */
function normalizeLocale(input?: string): string {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return "en";
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("en")) return "en";
  const m = raw.match(/^([a-z]{2,8})([-_].*)?$/);
  if (m) return m[1];
  return raw;
}

/**
 * 探测应用启动时的初始语言：
 * - 优先读取主进程持久化的语言设置
 * - 失败时回退到浏览器环境的 navigator.language
 * @returns 规范化后的语言码
 */
async function detectInitialLanguage(): Promise<string> {
  try {
    const res = await (window as any)?.host?.i18n?.getLocale?.();
    if (res && res.ok && res.locale) return normalizeLocale(res.locale);
  } catch {}
  try { return normalizeLocale(navigator.language); } catch { return "en"; }
}

// 通过 Vite 的 import.meta.glob 预注册所有本地 JSON 资源，避免运行时路径无法解析
// Vite 专用：通过 import.meta.glob 预注册本地 JSON 模块（非 Vite 环境下类型不包含 glob，需断言 any）
const LOCALE_MODULES: Record<string, () => Promise<any>> = (import.meta as any).glob("../locales/**/*.json");

/**
 * 从打包内 locale JSON 模块中推导可用语言列表。
 * @returns 语言码数组（如 ["en","zh"]）
 */
function detectedCompiledLanguages(): string[] {
  const set = new Set<string>();
  for (const k of Object.keys(LOCALE_MODULES)) {
    const m = k.match(/\.\.\/locales\/([^/]+)\//);
    if (m) set.add(m[1]);
  }
  return Array.from(set);
}

/**
 * 从打包内 locale JSON 模块中推导可用命名空间列表。
 * - 目的：在首屏渲染前预加载所有内置命名空间，避免短暂显示 key（如 "settings:title"）
 * @returns 命名空间数组（保证包含 "common"，并按稳定顺序排序）
 */
function detectedCompiledNamespaces(): string[] {
  const set = new Set<string>();
  for (const k of Object.keys(LOCALE_MODULES)) {
    const m = k.match(/\.\.\/locales\/[^/]+\/([^/]+)\.json$/);
    if (m) set.add(m[1]);
  }
  const list = Array.from(set);
  if (!list.includes("common")) list.unshift("common");
  list.sort((a, b) => {
    if (a === "common") return -1;
    if (b === "common") return 1;
    return a.localeCompare(b);
  });
  return list.length ? list : ["common"];
}

/**
 * 初始化渲染进程 i18n：
 * - 启动阶段预加载所有内置命名空间，避免首屏 key 闪烁
 * - 支持从用户目录覆盖语言包
 * @returns i18next 实例
 */
export async function initI18n(): Promise<I18nInstance> {
  const lng = await detectInitialLanguage();
  const allNamespaces = detectedCompiledNamespaces();
  if (i18next.isInitialized) {
    try { await i18next.changeLanguage(lng); } catch {}
    try { await i18next.loadNamespaces(allNamespaces); } catch {}
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
      ns: allNamespaces,
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
        i18next
          .changeLanguage(next)
          .then(() => i18next.loadNamespaces(allNamespaces))
          .catch(() => {});
      }
    });
  } catch {}

  // 将当前语言应用到 <html lang>，便于可访问性与字体回退
  /**
   * 将当前语言写入到 DOM（<html lang>），用于可访问性与字体回退。
   * @param lang 语言码（不传则使用 i18next.language）
   */
  const applyLangToDOM = (lang?: string) => {
    try {
      const el = document?.documentElement;
      if (!el) return;
      el.setAttribute("lang", (lang || i18next.language || "en"));
      el.setAttribute("dir", "ltr");
    } catch {}
  };
  applyLangToDOM(lng);
  try { i18next.on("languageChanged", (l) => applyLangToDOM(l)); } catch {}

  return i18next;
}

/**
 * 切换应用语言（同时写入主进程持久化设置）。
 * @param locale 目标语言（如 zh、en、zh-CN）
 */
export async function changeAppLanguage(locale: string) {
  const next = normalizeLocale(locale);
  try { await (window as any)?.host?.i18n?.setLocale?.(next); } catch {}
  try {
    await i18next.changeLanguage(next);
    await i18next.loadNamespaces(detectedCompiledNamespaces());
  } catch {}
}

/**
 * 列出可用语言（打包内 + 用户目录）。
 * @returns 语言码数组
 */
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
