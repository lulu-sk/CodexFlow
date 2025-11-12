// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { parseFontFamilyList } from "@/lib/font-utils";
import { hexToRgba, mixHexColors, shiftHexLuminance } from "@/lib/color-utils";
import type { TerminalThemeId, TerminalThemeTone } from "@/types/terminal-theme";

export const DEFAULT_TERMINAL_FONT_FAMILY =
  'Cascadia Code, Cascadia Mono, Consolas, ui-monospace, SFMono-Regular, Menlo, Monaco, "Liberation Mono", monospace, "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", "Apple Color Emoji", "Twemoji Mozilla", "Microsoft YaHei UI", "Microsoft YaHei", SimSun, SimHei, "Noto Sans CJK SC", "Source Han Sans SC"';

export const DEFAULT_TERMINAL_THEME_ID: TerminalThemeId = "campbell";

export type TerminalThemePalette = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type TerminalThemeDefinition = {
  id: TerminalThemeId;
  tone: TerminalThemeTone;
  palette: TerminalThemePalette;
};

const TERMINAL_THEME_LIST: TerminalThemeDefinition[] = [
  {
    id: "campbell",
    tone: "dark",
    palette: {
      background: "#0C0C0C",
      foreground: "#CCCCCC",
      cursor: "#FFFFFF",
      cursorAccent: "#0C0C0C",
      selectionBackground: "#3A96DD55",
      black: "#0C0C0C",
      red: "#C50F1F",
      green: "#13A10E",
      yellow: "#C19C00",
      blue: "#0037DA",
      magenta: "#881798",
      cyan: "#3A96DD",
      white: "#CCCCCC",
      brightBlack: "#767676",
      brightRed: "#E74856",
      brightGreen: "#16C60C",
      brightYellow: "#F9F1A5",
      brightBlue: "#3B78FF",
      brightMagenta: "#B4009E",
      brightCyan: "#61D6D6",
      brightWhite: "#F2F2F2",
    },
  },
  {
    id: "dracula",
    tone: "dark",
    palette: {
      background: "#282A36",
      foreground: "#F8F8F2",
      cursor: "#F8F8F0",
      cursorAccent: "#282A36",
      selectionBackground: "#44475A",
      black: "#21222C",
      red: "#FF5555",
      green: "#50FA7B",
      yellow: "#F1FA8C",
      blue: "#BD93F9",
      magenta: "#FF79C6",
      cyan: "#8BE9FD",
      white: "#F8F8F2",
      brightBlack: "#6272A4",
      brightRed: "#FF6E6E",
      brightGreen: "#69FF94",
      brightYellow: "#FFFFA5",
      brightBlue: "#D6ACFF",
      brightMagenta: "#FF92DF",
      brightCyan: "#A4FFFF",
      brightWhite: "#FFFFFF",
    },
  },
  {
    id: "catppuccin-latte",
    tone: "light",
    palette: {
      background: "#EFF1F5",
      foreground: "#4C4F69",
      cursor: "#DC8A78",
      cursorAccent: "#EFF1F5",
      selectionBackground: "#CCD0DA",
      black: "#5C5F77",
      red: "#D20F39",
      green: "#40A02B",
      yellow: "#DF8E1D",
      blue: "#1E66F5",
      magenta: "#8839EF",
      cyan: "#179299",
      white: "#ACB0BE",
      brightBlack: "#6C6F85",
      brightRed: "#E64553",
      brightGreen: "#40A02B",
      brightYellow: "#DF8E1D",
      brightBlue: "#1E66F5",
      brightMagenta: "#8839EF",
      brightCyan: "#179299",
      brightWhite: "#BCC0CC",
    },
  },
];

const TERMINAL_THEME_MAP: Record<TerminalThemeId, TerminalThemeDefinition> = TERMINAL_THEME_LIST.reduce(
  (acc, theme) => {
    acc[theme.id] = theme;
    return acc;
  },
  {} as Record<TerminalThemeId, TerminalThemeDefinition>
);

export const TERMINAL_THEME_OPTIONS = TERMINAL_THEME_LIST;

export type TerminalAppearance = {
  fontFamily: string;
  theme: TerminalThemeId;
};

export function normalizeTerminalFontFamily(raw?: string | null): string {
  if (typeof raw !== "string") return DEFAULT_TERMINAL_FONT_FAMILY;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_TERMINAL_FONT_FAMILY;
}

export function normalizeTerminalTheme(raw?: string | null): TerminalThemeId {
  if (typeof raw !== "string") return DEFAULT_TERMINAL_THEME_ID;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "dracula") return "dracula";
  if (
    trimmed === "catppuccin-latte" ||
    trimmed === "catppuccinlatte" ||
    trimmed === "catppuccin latte" ||
    trimmed === "catppuccin"
  ) {
    return "catppuccin-latte";
  }
  return DEFAULT_TERMINAL_THEME_ID;
}

export function getTerminalTheme(themeId?: TerminalThemeId | null): TerminalThemeDefinition {
  const resolved = themeId ? normalizeTerminalTheme(themeId) : DEFAULT_TERMINAL_THEME_ID;
  return TERMINAL_THEME_MAP[resolved] || TERMINAL_THEME_MAP[DEFAULT_TERMINAL_THEME_ID];
}

export function normalizeTerminalAppearance(
  partial?: Partial<TerminalAppearance>,
  base?: TerminalAppearance
): TerminalAppearance {
  const fontInput = partial?.fontFamily ?? base?.fontFamily;
  const themeInput = partial?.theme ?? base?.theme;
  return {
    fontFamily: normalizeTerminalFontFamily(fontInput),
    theme: normalizeTerminalTheme(themeInput),
  };
}

export type TerminalChromeColors = {
  frameBorder: string;
  frameShadow: string;
  scrollbarThumb: string;
  scrollbarThumbHover: string;
  scrollbarTrack: string;
  scrollbarBorder: string;
  scrollbarGlow: string;
};

const TERMINAL_BG_FALLBACK = TERMINAL_THEME_MAP[DEFAULT_TERMINAL_THEME_ID].palette.background;

/**
 * 依据终端主题推导容器装饰色，保证不同组合下的边框与滚动条对比度。
 */
export function buildTerminalChromeColors(theme?: TerminalThemeDefinition | null): TerminalChromeColors {
  const resolved = theme || TERMINAL_THEME_MAP[DEFAULT_TERMINAL_THEME_ID];
  const tone: TerminalThemeTone = resolved?.tone || "dark";
  const baseBg = resolved?.palette?.background || TERMINAL_BG_FALLBACK;
  const normalizedBg = shiftHexLuminance(baseBg, 0) || TERMINAL_BG_FALLBACK;
  const frameBorder =
    tone === "dark"
      ? mixHexColors(normalizedBg, "#FFFFFF", 0.22)
      : mixHexColors(normalizedBg, "#000000", 0.18);
  const frameShadow =
    tone === "dark"
      ? "inset 0 1px 0 rgba(255, 255, 255, 0.06)"
      : "inset 0 1px 0 rgba(255, 255, 255, 0.65)";
  const overlayBase =
    tone === "dark"
      ? mixHexColors(normalizedBg, "#FFFFFF", 0.52)
      : mixHexColors(normalizedBg, "#000000", 0.42);
  const overlayHover = shiftHexLuminance(overlayBase, tone === "dark" ? 0.18 : -0.18);
  const overlayBorder = shiftHexLuminance(overlayBase, tone === "dark" ? 0.3 : -0.25);
  const overlayGlow =
    tone === "dark"
      ? mixHexColors(normalizedBg, "#000000", 0.4)
      : mixHexColors(normalizedBg, "#000000", 0.25);
  const overlayTrack = mixHexColors(normalizedBg, tone === "dark" ? "#FFFFFF" : "#000000", tone === "dark" ? 0.18 : 0.12);
  const scrollbarThumb = hexToRgba(overlayBase, tone === "dark" ? 0.82 : 0.65);
  const scrollbarThumbHover = hexToRgba(overlayHover, tone === "dark" ? 0.95 : 0.78);
  const scrollbarTrack = hexToRgba(overlayTrack, tone === "dark" ? 0.22 : 0.16);
  const scrollbarBorder = hexToRgba(overlayBorder, tone === "dark" ? 0.7 : 0.48);
  const scrollbarGlow = hexToRgba(overlayGlow, tone === "dark" ? 0.35 : 0.28);
  return {
    frameBorder,
    frameShadow,
    scrollbarThumb,
    scrollbarThumbHover,
    scrollbarTrack,
    scrollbarBorder,
    scrollbarGlow,
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
