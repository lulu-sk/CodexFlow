// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { sanitizeHtml } from "@/lib/sanitize";
import { CANONICAL_DONATION_ITEMS, enforceDonationIntegrity, verifyDonationSignature } from "@/lib/donate";

// 远端 JSON 默认地址
export const DEFAULT_REMOTE_URL = "https://cdn.jsdelivr.net/gh/lulu-sk/codexFlow-ConfigStore@main/config9.json"; // 请在部署时替换为固定的线上地址

export type DonateItem = { name: string; url?: string; image?: string; nameLocales?: Record<string, string> };
export type AnnounceItem = { id: string; text: string; textLocales?: Record<string, string> };
export type LatestInfo = { version: string; notes?: string; notesLocales?: Record<string, string>; url?: string; minSupported?: string };
export type RemoteAbout = {
  aboutHtml?: string | Record<string, string>;
  aboutHtmlLocale?: string;
  aboutLocales?: Record<string, string>;
  donate?: DonateItem[];
  announces?: AnnounceItem[];
  latest?: LatestInfo;
};

export type AboutIntegrity = {
  donationSignatureValid: boolean;
  extrasAppended: number;
};

export type AboutData = {
  aboutHtml: string; // 已经过 sanitize
  aboutHtmlLocale?: string;
  aboutHtmlLocales?: Record<string, string>;
  donate: DonateItem[];
  announces: AnnounceItem[];
  latest?: LatestInfo;
  integrity: AboutIntegrity;
};

// 本地默认内容（离线显示）
export const LOCAL_DEFAULT_ABOUT: AboutData = {
  aboutHtml: sanitizeHtml(""),
  aboutHtmlLocales: {},
  donate: Array.from(CANONICAL_DONATION_ITEMS),
  announces: [],
  integrity: {
    donationSignatureValid: true,
    extrasAppended: 0
  }
};

const LS_KEY = "CF_ABOUT_REMOTE_CACHE_V1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
export const REMOTE_TIMEOUT_MS = 10000; // 10 秒（遵循约束）

export type RemoteAboutFetchErrorType = "network" | "timeout" | "invalid" | "unknown";

export type RemoteAboutFetchResult = {
  data: AboutData;
  from: "network" | "cache" | "local";
  error?: { type: RemoteAboutFetchErrorType; message?: string };
};

function normalizeFetchError(err: unknown): { type: RemoteAboutFetchErrorType; message?: string } {
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") {
    return { type: "timeout", message: err.message };
  }
  if (err instanceof SyntaxError) {
    return { type: "invalid", message: err.message };
  }
  if (err instanceof Error) {
    const msg = err.message || err.name;
    return { type: "network", message: msg };
  }
  return { type: "unknown" };
}

function logUpdateEvent(event: string, details: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const perfLog = (window as any)?.host?.utils?.perfLog;
    if (typeof perfLog !== "function") return;
    const safeDetails: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined) continue;
      if (value instanceof Error) {
        safeDetails[key] = { message: value.message, stack: value.stack };
        continue;
      }
      if (typeof value === "object" && value !== null) {
        try { safeDetails[key] = JSON.parse(JSON.stringify(value)); } catch { safeDetails[key] = String(value); }
        continue;
      }
      safeDetails[key] = value;
    }
    const payload = `[update] ${event} ${JSON.stringify(safeDetails)}`;
    const ret = perfLog(payload);
    if (ret && typeof (ret as Promise<any>).catch === "function") {
      (ret as Promise<unknown>).catch(() => {});
    }
  } catch {}
}

export function semverCompare(a: string, b: string): number {
  const pa = String(a || '').split('.').map((s) => parseInt(s, 10) || 0);
  const pb = String(b || '').split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function cleanDonateItems(raw?: DonateItem[]): DonateItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: DonateItem[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || "").trim();
    if (!name) continue;
    const url = item.url ? String(item.url).trim() : undefined;
    const image = item.image ? String(item.image).trim() : undefined;
    if (!url && !image) continue;
    const nameLocalesRaw = (item as any).nameLocales;
    let nameLocales: Record<string, string> | undefined;
    if (nameLocalesRaw && typeof nameLocalesRaw === "object") {
      const map: Record<string, string> = {};
      for (const [locale, value] of Object.entries(nameLocalesRaw)) {
        const key = normalizeLocaleKey(locale);
        const text = String(value || "").trim();
        if (!key || !text) continue;
        map[key] = text;
      }
      if (Object.keys(map).length > 0) nameLocales = map;
    }
    result.push({ name, url, image, nameLocales });
  }
  return result;
}

function normalizeLocaleKey(input?: string): string | undefined {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return undefined;
  return raw;
}

function normalizeAboutData(source: Partial<AboutData> | Partial<RemoteAbout> | undefined, donationSignatureValid: boolean): AboutData {
  const donation = enforceDonationIntegrity(cleanDonateItems(source?.donate as DonateItem[] | undefined));

  const aboutLocales: Record<string, string> = {};
  let primaryLocale = normalizeLocaleKey((source as any)?.aboutHtmlLocale);
  let aboutHtml = "";

  const addLocaleHtml = (locale: string | undefined, html?: string) => {
    const sanitized = sanitizeHtml(String(html || ""));
    if (!sanitized.trim()) return;
    const key = normalizeLocaleKey(locale) || primaryLocale || undefined;
    if (key) {
      aboutLocales[key] = sanitized;
      if (!primaryLocale) primaryLocale = key;
    }
    if (!aboutHtml) {
      aboutHtml = sanitized;
    }
  };

  if (source) {
    const rawAbout = (source as RemoteAbout)?.aboutHtml;
    if (typeof rawAbout === "string") {
      addLocaleHtml((source as RemoteAbout)?.aboutHtmlLocale || primaryLocale || "zh", rawAbout);
    } else if (rawAbout && typeof rawAbout === "object") {
      for (const [locale, html] of Object.entries(rawAbout)) {
        addLocaleHtml(locale, html);
      }
    }

    const extraLocales = (source as RemoteAbout)?.aboutLocales;
    if (extraLocales && typeof extraLocales === "object") {
      for (const [locale, html] of Object.entries(extraLocales)) {
        addLocaleHtml(locale, html);
      }
    }

    const normalizedLocales = (source as AboutData)?.aboutHtmlLocales;
    if (normalizedLocales && typeof normalizedLocales === "object") {
      for (const [locale, html] of Object.entries(normalizedLocales)) {
        addLocaleHtml(locale, html);
      }
    }
  }

  if (!aboutHtml && LOCAL_DEFAULT_ABOUT.aboutHtml) {
    aboutHtml = LOCAL_DEFAULT_ABOUT.aboutHtml;
  }

  const aboutHtmlLocales = Object.keys(aboutLocales).length > 0 ? aboutLocales : undefined;
  const aboutHtmlLocale = primaryLocale || (aboutHtmlLocales ? Object.keys(aboutHtmlLocales)[0] : undefined);

  const announces: AnnounceItem[] = [];
  if (Array.isArray(source?.announces)) {
    for (const raw of source.announces.slice(0, 50)) {
      if (!raw || typeof raw !== "object") continue;
      const id = String((raw as any).id || "").trim();
      if (!id) continue;
      const textLocalesMap: Record<string, string> = {};
      let primaryTextLocale = normalizeLocaleKey((raw as any).textLocale);
      const applyText = (locale: string | undefined, value?: string) => {
        const key = normalizeLocaleKey(locale);
        const text = String(value || "").trim();
        if (!text) return;
        if (key) {
          textLocalesMap[key] = text;
          if (!primaryTextLocale) primaryTextLocale = key;
        } else if (!primaryTextLocale) {
          primaryTextLocale = "zh";
          textLocalesMap[primaryTextLocale] = text;
        }
      };
      applyText((raw as any).textLocale, (raw as any).text);
      const extraTextLocales = (raw as any).textLocales;
      if (extraTextLocales && typeof extraTextLocales === "object") {
        for (const [locale, value] of Object.entries(extraTextLocales)) {
          applyText(locale, value as string);
        }
      }
      let text = String((raw as any).text || "").trim();
      if (primaryTextLocale && textLocalesMap[primaryTextLocale]) {
        text = textLocalesMap[primaryTextLocale];
      } else if (!text && Object.keys(textLocalesMap).length > 0) {
        text = textLocalesMap[Object.keys(textLocalesMap)[0]];
      }
      if (!text) continue;
      const textLocales = Object.keys(textLocalesMap).length > 0 ? textLocalesMap : undefined;
      announces.push({ id, text, textLocales });
    }
  }
  if (announces.length === 0 && LOCAL_DEFAULT_ABOUT.announces.length > 0) {
    announces.push(...LOCAL_DEFAULT_ABOUT.announces);
  }

  let latest: LatestInfo | undefined;
  if (source?.latest && typeof source.latest === "object" && source.latest.version) {
    const notesLocalesMap: Record<string, string> = {};
    let primaryNotesLocale = normalizeLocaleKey((source.latest as any).notesLocale);
    const applyNotes = (locale: string | undefined, value?: string) => {
      const key = normalizeLocaleKey(locale);
      const text = String(value || "").trim();
      if (!text) return;
      if (key) {
        notesLocalesMap[key] = text;
        if (!primaryNotesLocale) primaryNotesLocale = key;
      } else if (!primaryNotesLocale) {
        primaryNotesLocale = "zh";
        notesLocalesMap[primaryNotesLocale] = text;
      }
    };
    applyNotes((source.latest as any).notesLocale, source.latest.notes);
    const extraNotesLocales = (source.latest as any).notesLocales;
    if (extraNotesLocales && typeof extraNotesLocales === "object") {
      for (const [locale, value] of Object.entries(extraNotesLocales)) {
        applyNotes(locale, value as string);
      }
    }
    let notes = String(source.latest.notes || "").trim();
    if (primaryNotesLocale && notesLocalesMap[primaryNotesLocale]) {
      notes = notesLocalesMap[primaryNotesLocale];
    } else if (!notes && Object.keys(notesLocalesMap).length > 0) {
      notes = notesLocalesMap[Object.keys(notesLocalesMap)[0]];
    }
    const notesLocales = Object.keys(notesLocalesMap).length > 0 ? notesLocalesMap : undefined;
    latest = {
      version: String(source.latest.version || "").trim(),
      notes,
      notesLocales,
      url: source.latest.url ? String(source.latest.url) : undefined,
      minSupported: source.latest.minSupported ? String(source.latest.minSupported) : undefined
    };
  }

  return {
    aboutHtml,
    aboutHtmlLocale,
    aboutHtmlLocales,
    donate: donation.items,
    announces,
    latest,
    integrity: {
      donationSignatureValid,
      extrasAppended: donation.extrasAppended
    }
  };
}

export async function fetchRemoteAbout(opts?: { force?: boolean; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<RemoteAboutFetchResult> {
  const now = Date.now();
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? REMOTE_TIMEOUT_MS);
  const fetchImpl = opts?.fetchImpl || fetch;
  const donationSignatureValid = await verifyDonationSignature().catch(() => false);

  // 尝试命中缓存
  if (!opts?.force) {
    try {
      const cachedRaw = localStorage.getItem(LS_KEY);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw) as { at: number; data?: Partial<AboutData> };
        if (cached && cached.at && (now - cached.at) < CACHE_TTL_MS && cached.data) {
          const data = normalizeAboutData(cached.data, donationSignatureValid);
          logUpdateEvent("fetchRemoteAbout.cacheHit", { at: cached.at, ageMs: now - cached.at, force: !!opts?.force });
          return { data, from: "cache" };
        }
      }
    } catch {}
  }

  // 拉取远端
  try {
    const primary = new URL(DEFAULT_REMOTE_URL);
    if (opts?.force) primary.searchParams.set("_ts", String(now));
    const fallback = new URL(DEFAULT_REMOTE_URL.replace("cdn.jsdelivr.net", "fastly.jsdelivr.net"));
    if (opts?.force) fallback.searchParams.set("_ts", String(now));
    const targets = [primary, fallback];
    const hostFetch: ((args: { url: string; timeoutMs?: number; headers?: Record<string, string> }) => Promise<{ ok: boolean; status?: number; data?: any; error?: string }>) | undefined =
      typeof window !== "undefined" ? (window as any)?.host?.utils?.fetchJson : undefined;
    let lastError: unknown;
    for (const urlObj of targets) {
      const requestUrl = urlObj.toString();
      const headers: Record<string, string> = { Accept: "application/json" };
      if (opts?.force) {
        headers["Cache-Control"] = "no-cache";
        headers["Pragma"] = "no-cache";
      }
      const methods: Array<"host" | "fetch"> = hostFetch ? ["host", "fetch"] : ["fetch"];
      for (const via of methods) {
        try {
          let remote: RemoteAbout | undefined;
          if (via === "host") {
            const res = await hostFetch!({ url: requestUrl, timeoutMs, headers });
            if (!res || !res.ok || !res.data) {
              throw new Error(res?.error || `HTTP ${res?.status ?? "unknown"}`);
            }
            remote = res.data as RemoteAbout;
          } else {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const res = await fetchImpl(requestUrl, { signal: controller.signal, headers });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              remote = await res.json() as RemoteAbout;
            } finally {
              clearTimeout(timer);
            }
          }
          const data = normalizeAboutData(remote, donationSignatureValid);
          try { localStorage.setItem(LS_KEY, JSON.stringify({ at: now, data })); } catch {}
          logUpdateEvent("fetchRemoteAbout.network", { ok: true, force: !!opts?.force, timeoutMs, donationSignatureValid, latestVersion: data.latest?.version, url: requestUrl, via });
          return { data, from: "network" };
        } catch (err) {
          lastError = err;
          logUpdateEvent("fetchRemoteAbout.networkRetry", { url: requestUrl, error: err instanceof Error ? err.message : String(err), via });
          continue;
        }
      }
    }
    if (lastError) throw lastError;
  } catch (err) {
    // 失败回退到本地默认（不报错）
    const fallback = normalizeAboutData(LOCAL_DEFAULT_ABOUT, donationSignatureValid);
    const normalized = normalizeFetchError(err);
    logUpdateEvent("fetchRemoteAbout.fallback", { force: !!opts?.force, timeoutMs, errorType: normalized.type, errorMessage: normalized.message, url: DEFAULT_REMOTE_URL });
    return { data: fallback, from: "local", error: normalized };
  }
  // 理论上不会到达此处；为满足类型检查提供兜底返回
  const fallback = normalizeAboutData(LOCAL_DEFAULT_ABOUT, donationSignatureValid);
  return { data: fallback, from: "local" };
}

export type UpdateCheckStatus = "update" | "no-update" | "failed";
export type UpdateCheckErrorType = RemoteAboutFetchErrorType;

export type UpdateCheck = {
  status: UpdateCheckStatus;
  hasUpdate: boolean;
  current: string;
  latest?: LatestInfo;
  source?: "network" | "cache" | "local";
  error?: { type: UpdateCheckErrorType; message?: string };
};

export async function checkForUpdate(currentVersion: string, opts?: { force?: boolean; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<UpdateCheck> {
  try {
    logUpdateEvent("checkForUpdate.start", { currentVersion, force: !!opts?.force, timeoutMs: opts?.timeoutMs });
    const result = await fetchRemoteAbout({ force: opts?.force, timeoutMs: opts?.timeoutMs, fetchImpl: opts?.fetchImpl });
    const forceFallback = Boolean(opts?.force) && result.from !== "network";
    const errorPayload = result.error ?? (forceFallback ? { type: "network" as RemoteAboutFetchErrorType, message: undefined } : undefined);
    if (errorPayload) {
      logUpdateEvent("checkForUpdate.failed", { currentVersion, source: result.from, errorType: errorPayload.type, errorMessage: errorPayload.message, latestVersion: result.data.latest?.version });
      return {
        status: "failed",
        hasUpdate: false,
        current: currentVersion,
        latest: result.data.latest,
        source: result.from,
        error: errorPayload
      };
    }
    const latest = result.data.latest;
    if (latest && latest.version && semverCompare(latest.version, currentVersion) > 0) {
      logUpdateEvent("checkForUpdate.update", { currentVersion, source: result.from, latestVersion: latest.version });
      return { status: "update", hasUpdate: true, current: currentVersion, latest, source: result.from };
    }
    logUpdateEvent("checkForUpdate.noUpdate", { currentVersion, source: result.from, latestVersion: latest?.version });
    return { status: "no-update", hasUpdate: false, current: currentVersion, latest, source: result.from };
  } catch (err) {
    const normalized = normalizeFetchError(err);
    logUpdateEvent("checkForUpdate.exception", { currentVersion, errorType: normalized.type, errorMessage: normalized.message });
    return { status: "failed", hasUpdate: false, current: currentVersion, error: normalized };
  }
}
