// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { DonateItem } from "@/lib/about";
import { ALIPAY_QR_DATA_URL, WECHAT_QR_DATA_URL, PAYPAL_ME_URL } from "@/lib/donate-assets";

const canonicalItems: DonateItem[] = [
  { name: "支付宝", image: ALIPAY_QR_DATA_URL, nameLocales: { zh: "支付宝", en: "Alipay" } },
  { name: "微信", image: WECHAT_QR_DATA_URL, nameLocales: { zh: "微信", en: "WeChat" } },
  { name: "PayPal.me", url: PAYPAL_ME_URL, nameLocales: { zh: "PayPal.me", en: "PayPal.me" } }
];

export const CANONICAL_DONATION_ITEMS = Object.freeze(
  canonicalItems.map((item) => Object.freeze({ ...item }))
) as ReadonlyArray<DonateItem>;

export const DONATION_CANONICAL_NAMES = CANONICAL_DONATION_ITEMS.map((item) => item.name);

const CANONICAL_DONATION_JSON = JSON.stringify(
  canonicalItems.map((item) => ({ name: item.name, url: item.url, image: item.image }))
);

export const DONATION_SIGNATURE = "sha256-dtYfLIu8Vgtfn1dGwJMSJBpqccyPY0Jhf1sOchP8zKk=";

export type DonationIntegrity = {
  items: DonateItem[];
  extrasAppended: number;
};

export function enforceDonationIntegrity(raw?: DonateItem[]): DonationIntegrity {
  if (!raw || !Array.isArray(raw)) {
    return { items: [...CANONICAL_DONATION_ITEMS], extrasAppended: 0 };
  }

  const fallback = new Set(DONATION_CANONICAL_NAMES);
  const extras: DonateItem[] = [];

  const sanitizeNameLocales = (locales?: Record<string, string>): Record<string, string> | undefined => {
    if (!locales || typeof locales !== "object") return undefined;
    const map: Record<string, string> = {};
    for (const [locale, value] of Object.entries(locales)) {
      const key = String(locale || "").trim().toLowerCase();
      const text = String(value || "").trim();
      if (!key || !text) continue;
      map[key] = text;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || "").trim();
    if (!name) continue;
    if (fallback.has(name)) continue;
    const normalized: DonateItem = { name };
    if (item.url) normalized.url = String(item.url);
    if (item.image) normalized.image = String(item.image);
    const nameLocales = sanitizeNameLocales((item as any).nameLocales || item.nameLocales);
    if (nameLocales) normalized.nameLocales = nameLocales;
    extras.push(normalized);
  }

  return {
    items: [...CANONICAL_DONATION_ITEMS, ...extras.slice(0, 17)].map((item) => {
      const clone: DonateItem = { name: item.name };
      if (item.url) clone.url = item.url;
      if (item.image) clone.image = item.image;
      if (item.nameLocales) {
        const sanitized = sanitizeNameLocales(item.nameLocales);
        if (sanitized) clone.nameLocales = sanitized;
      }
      return clone;
    }),
    extrasAppended: extras.length
  };
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function verifyDonationSignature(signature: string = DONATION_SIGNATURE): Promise<boolean> {
  if (typeof crypto === "undefined" || !crypto.subtle) return false;
  try {
    const encoded = new TextEncoder().encode(CANONICAL_DONATION_JSON);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    const hash = bufferToBase64(digest);
    return `sha256-${hash}` === signature;
  } catch {
    return false;
  }
}
