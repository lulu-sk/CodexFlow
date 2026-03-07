// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_THEME_ID,
  getTerminalTheme,
  normalizeTerminalAppearance,
  setCachedMacOSTheme,
  buildMacOSSystemThemeByTone,
  resolveMacOSSystemThemeByTone,
  type TerminalThemeDefinition,
} from "./terminal-appearance";

const MAC_THEME: TerminalThemeDefinition = {
  id: "macos-system",
  tone: "dark",
  palette: {
    background: "#101010",
    foreground: "#f5f5f5",
    cursor: "#f5f5f5",
    cursorAccent: "#101010",
    selectionBackground: "#2f2f2f",
    black: "#000000",
    red: "#ff5f56",
    green: "#27c93f",
    yellow: "#ffbd2e",
    blue: "#1e90ff",
    magenta: "#bd5eff",
    cyan: "#67e8f9",
    white: "#f5f5f5",
    brightBlack: "#666666",
    brightRed: "#ff8a80",
    brightGreen: "#6ee7b7",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#a5f3fc",
    brightWhite: "#ffffff",
  },
  font: {
    family: "SF Mono",
    size: 14,
  },
};

const originalNavigatorPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");

function setNavigatorPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

function restoreNavigatorPlatform(): void {
  if (originalNavigatorPlatform) {
    Object.defineProperty(window.navigator, "platform", originalNavigatorPlatform);
    return;
  }
  Object.defineProperty(window.navigator, "platform", {
    value: "",
    configurable: true,
  });
}

describe("terminal-appearance（macOS 系统主题）", () => {
  afterEach(() => {
    setCachedMacOSTheme(null);
    restoreNavigatorPlatform();
    try {
      if (typeof window.localStorage?.removeItem === "function") {
        window.localStorage.removeItem("macos-terminal-theme-cache");
      }
    } catch {}
  });

  it("非 macOS 平台会忽略 macos-system 并回退默认主题", () => {
    setNavigatorPlatform("Win32");
    setCachedMacOSTheme(MAC_THEME);

    expect(getTerminalTheme("macos-system").id).toBe(DEFAULT_TERMINAL_THEME_ID);
  });

  it("macOS 平台会使用已缓存的系统主题与字体", () => {
    setNavigatorPlatform("MacIntel");
    setCachedMacOSTheme(MAC_THEME);

    expect(getTerminalTheme("macos-system")).toMatchObject({
      id: "macos-system",
      font: {
        family: "SF Mono",
        size: 14,
      },
    });
  });

  it("按 tone 共享判断会优先命中对应缓存", () => {
    const lightTheme: TerminalThemeDefinition = {
      ...MAC_THEME,
      tone: "light",
      palette: {
        ...MAC_THEME.palette,
        background: "#f8f8f8",
        foreground: "#202020",
      },
    };
    const themesByTone = {
      ...buildMacOSSystemThemeByTone(MAC_THEME),
      ...buildMacOSSystemThemeByTone(lightTheme),
    };

    expect(resolveMacOSSystemThemeByTone(themesByTone, "dark", lightTheme)).toBe(MAC_THEME);
    expect(resolveMacOSSystemThemeByTone(themesByTone, "light", MAC_THEME)).toBe(lightTheme);
  });

  it("normalizeTerminalAppearance 支持显式清空字号", () => {
    const next = normalizeTerminalAppearance(
      { fontSize: undefined },
      { fontFamily: "Menlo", fontSize: 15, theme: "campbell" }
    );

    expect(next.fontFamily).toBe("Menlo");
    expect(next.fontSize).toBeUndefined();
    expect(next.theme).toBe("campbell");
  });
});
