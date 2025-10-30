// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { parseFontFamilyList } from "@/lib/font-utils";

export const DEFAULT_TERMINAL_FONT_FAMILY =
  'Cascadia Code, Cascadia Mono, Consolas, ui-monospace, SFMono-Regular, Menlo, Monaco, "Liberation Mono", monospace, "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", "Apple Color Emoji", "Twemoji Mozilla", "Microsoft YaHei UI", "Microsoft YaHei", SimSun, SimHei, "Noto Sans CJK SC", "Source Han Sans SC"';

export type TerminalAppearance = {
  fontFamily: string;
};

export function normalizeTerminalFontFamily(raw?: string | null): string {
  if (typeof raw !== "string") return DEFAULT_TERMINAL_FONT_FAMILY;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_TERMINAL_FONT_FAMILY;
}

export function normalizeTerminalAppearance(
  partial?: Partial<TerminalAppearance>
): TerminalAppearance {
  return {
    fontFamily: normalizeTerminalFontFamily(partial?.fontFamily),
  };
}

/**
 * 构建终端字体栈：将 primary 放在首位，并与默认栈去重合并。
 * 注意：即使默认栈已包含该字体，也应置首，避免被其它默认项（如 Cascadia Code）“抢占第一”。
 */
export function buildTerminalFontStack(primary?: string | null): string {
  const head = typeof primary === "string" ? primary.trim() : "";
  if (!head) return DEFAULT_TERMINAL_FONT_FAMILY;
  const needsQuote = /\s/.test(head) && !/^['"].*['"]$/.test(head);
  const first = needsQuote ? `'${head}'` : head;
  const baseList = parseFontFamilyList(DEFAULT_TERMINAL_FONT_FAMILY);
  const dedup = baseList.filter((n) => n.toLowerCase() !== head.toLowerCase());
  return [first, ...dedup].join(", ");
}


