import { spawn, spawnSync } from "child_process";
import { nativeTheme } from "electron";
import * as path from "path";

type MacTerminalThemePalette = {
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

type MacTerminalThemeFont = {
  family: string;
  size: number;
};

type MacTerminalThemePayload = {
  palette: MacTerminalThemePalette;
  font?: MacTerminalThemeFont;
};

type MacTerminalThemePaletteSourceKey = Exclude<keyof MacTerminalThemePalette, "cursorAccent">;
type MacTerminalThemeTone = "dark" | "light";

export interface MacTerminalThemeResult {
  ok: boolean;
  supported?: boolean;
  theme?: {
    id: "macos-system";
    tone: "dark" | "light";
    palette: MacTerminalThemePalette;
    font?: MacTerminalThemeFont;
  };
  error?: string;
}

const INITIAL_SETTINGS_DIRS = [
  "/System/Applications/Utilities/Terminal.app/Contents/Resources/Initial Settings",
  "/Applications/Utilities/Terminal.app/Contents/Resources/Initial Settings",
];

const COLOR_KEY_MAP = {
  background: "BackgroundColor",
  foreground: "TextColor",
  cursor: "CursorColor",
  selectionBackground: "SelectionColor",
  black: "ANSIBlackColor",
  red: "ANSIRedColor",
  green: "ANSIGreenColor",
  yellow: "ANSIYellowColor",
  blue: "ANSIBlueColor",
  magenta: "ANSIMagentaColor",
  cyan: "ANSICyanColor",
  white: "ANSIWhiteColor",
  brightBlack: "ANSIBrightBlackColor",
  brightRed: "ANSIBrightRedColor",
  brightGreen: "ANSIBrightGreenColor",
  brightYellow: "ANSIBrightYellowColor",
  brightBlue: "ANSIBrightBlueColor",
  brightMagenta: "ANSIBrightMagentaColor",
  brightCyan: "ANSIBrightCyanColor",
  brightWhite: "ANSIBrightWhiteColor",
} satisfies Record<MacTerminalThemePaletteSourceKey, string>;

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

function shouldUseDarkMacAppearance(): boolean {
  try {
    if (typeof nativeTheme?.shouldUseDarkColors === "boolean") {
      return nativeTheme.shouldUseDarkColors;
    }
  } catch {}

  try {
    const result = spawnSync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf8",
    });
    return String(result.stdout || "").trim().toLowerCase() === "dark";
  } catch {
    return false;
  }
}

function buildFallbackPalette(tone: "dark" | "light"): MacTerminalThemePalette {
  if (tone === "light") {
    return {
      background: "rgba(255, 255, 255, 0.93)",
      foreground: "#2d3840",
      cursor: "#2d3840",
      cursorAccent: "rgba(255, 255, 255, 0.93)",
      selectionBackground: "#dfe8ee",
      black: "#2d3840",
      red: "#b45648",
      green: "#6caa71",
      yellow: "#c4ac62",
      blue: "#3769cc",
      magenta: "#ad4fd9",
      cyan: "#4697a8",
      white: "#d8e2e8",
      brightBlack: "#6e7b85",
      brightRed: "#df6c5a",
      brightGreen: "#79be7e",
      brightYellow: "#e5c872",
      brightBlue: "#538afc",
      brightMagenta: "#c768f0",
      brightCyan: "#68bfd0",
      brightWhite: "#f5f8fa",
    };
  }

  return {
    background: "rgba(25, 29, 39, 0.95)",
    foreground: "#e0e0e0",
    cursor: "#e0e0e0",
    cursorAccent: "rgba(25, 29, 39, 0.95)",
    selectionBackground: "#273d4c",
    black: "#35424c",
    red: "#b45648",
    green: "#6caa71",
    yellow: "#c4ac62",
    blue: "#6d96b4",
    magenta: "#bd7bcd",
    cyan: "#7ccbcd",
    white: "#dee5eb",
    brightBlack: "#465c6d",
    brightRed: "#df6c5a",
    brightGreen: "#79be7e",
    brightYellow: "#e5c872",
    brightBlue: "#67b5ed",
    brightMagenta: "#d389e5",
    brightCyan: "#84dde0",
    brightWhite: "#e5eff5",
  };
}

function parseCssColorRgb(input?: string | null): { r: number; g: number; b: number } | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hexMatch = trimmed.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  const rgbaMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbaMatch) return null;
  const parts = rgbaMatch[1].split(",").map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((value) => !Number.isFinite(value))) return null;
  return {
    r: Math.max(0, Math.min(255, Math.round(parts[0]))),
    g: Math.max(0, Math.min(255, Math.round(parts[1]))),
    b: Math.max(0, Math.min(255, Math.round(parts[2]))),
  };
}

async function getMacTerminalPalette(tone?: MacTerminalThemeTone): Promise<MacTerminalThemePayload | null> {
  if (!isMacOS() || !process.env.HOME) return null;

  const plistPath = path.join(process.env.HOME, "Library", "Preferences", "com.apple.Terminal.plist");
  const prefersDarkAppearance = tone ? tone === "dark" : shouldUseDarkMacAppearance();
  const fallbackPaletteName = prefersDarkAppearance ? "Clear Dark" : "Clear Light";

  const jxaScript = `
    ObjC.import('Foundation');

    var plistPath = ${JSON.stringify(plistPath)};
    var initialSettingsDirs = ${JSON.stringify(INITIAL_SETTINGS_DIRS)};
    var basicFallbackName = ${JSON.stringify(fallbackPaletteName)};
    var colorKeys = ${JSON.stringify(COLOR_KEY_MAP)};

    function loadPlistAt(targetPath) {
      try {
        var data = $.NSData.dataWithContentsOfFile(targetPath);
        if (!data) return null;
        return $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(data, 0, null, null);
      } catch (e) {
        return null;
      }
    }

    function findInitialProfile(profileName) {
      for (var i = 0; i < initialSettingsDirs.length; i += 1) {
        var dirPath = initialSettingsDirs[i];
        var candidate = $(dirPath).stringByAppendingPathComponent($(profileName + '.terminal'));
        var dict = loadPlistAt(candidate.js);
        if (dict) return dict;
      }
      return null;
    }

    function dataToString(data) {
      try {
        var text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
        if (!text) return null;
        return ObjC.unwrap(text).replace(/\u0000/g, '').trim();
      } catch (e) {
        return null;
      }
    }

    function clamp01(value) {
      if (!(value >= 0)) return 0;
      if (value > 1) return 1;
      return value;
    }

    function padHex(value) {
      var hex = value.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }

    function colorTextToCss(text) {
      if (!text) return null;
      var parts = text.split(/\s+/);
      var values = [];
      for (var i = 0; i < parts.length; i += 1) {
        var parsed = parseFloat(parts[i]);
        if (isNaN(parsed)) continue;
        values.push(parsed);
      }
      if (values.length < 3) return null;
      var r = Math.round(clamp01(values[0]) * 255);
      var g = Math.round(clamp01(values[1]) * 255);
      var b = Math.round(clamp01(values[2]) * 255);
      var alpha = values.length >= 4 ? clamp01(values[3]) : 1;
      if (alpha < 0.999) {
        var alphaText = alpha.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
        return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alphaText + ')';
      }
      return '#' + padHex(r) + padHex(g) + padHex(b);
    }

    function parseColorArchive(rawData) {
      if (!rawData) return null;
      try {
        var archive = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(rawData, 0, null, null);
        if (!archive) return null;
        var objects = archive.objectForKey('$objects');
        if (!objects || objects.count < 2) return null;
        var payload = objects.objectAtIndex(1);
        if (!payload) return null;
        var raw = payload.objectForKey('NSRGB');
        if (!raw) raw = payload.objectForKey('NSComponents');
        if (!raw) return null;
        return colorTextToCss(dataToString(raw));
      } catch (e) {
        return null;
      }
    }

    function parseFontArchive(rawData) {
      if (!rawData) return null;
      try {
        var archive = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(rawData, 0, null, null);
        if (!archive) return null;
        var objects = archive.objectForKey('$objects');
        if (!objects || objects.count < 3) return null;
        var meta = objects.objectAtIndex(1);
        var name = null;
        try {
          name = ObjC.unwrap(objects.objectAtIndex(2));
        } catch (e) {}
        if (!name) {
          for (var i = 2; i < objects.count; i += 1) {
            try {
              var candidate = ObjC.unwrap(objects.objectAtIndex(i));
              if (typeof candidate === 'string' && candidate.length > 0) {
                name = candidate;
                break;
              }
            } catch (e) {}
          }
        }
        if (!name) return null;
        var sizeRaw = meta ? meta.objectForKey('NSSize') : null;
        var size = sizeRaw ? Number(ObjC.unwrap(sizeRaw)) : NaN;
        if (!isFinite(size) || size <= 0) return null;
        return { family: name, size: size };
      } catch (e) {
        return null;
      }
    }

    function mergePalette(target, source, overwrite) {
      if (!source) return;
      for (var key in colorKeys) {
        var raw = source.objectForKey(colorKeys[key]);
        if (!raw) continue;
        var color = parseColorArchive(raw);
        if (!color) continue;
        if (overwrite || !target[key]) {
          target[key] = color;
        }
      }
    }

    function run() {
      try {
        var dict = loadPlistAt(plistPath);
        if (!dict) return null;

        var defaultName = dict.objectForKey('Default Window Settings');
        var settings = dict.objectForKey('Window Settings');
        if (!settings || !defaultName) return null;

        var profileName = ObjC.unwrap(defaultName);
        var profile = settings.objectForKey(defaultName);
        if (!profile) return null;

        var initialProfile = findInitialProfile(profileName);
        var semanticBasicProfile = profileName === 'Basic' ? findInitialProfile(basicFallbackName) : null;
        var result = {
          profileName: profileName,
          palette: {},
          font: null,
        };

        mergePalette(result.palette, initialProfile, true);
        mergePalette(result.palette, semanticBasicProfile, false);
        mergePalette(result.palette, profile, true);

        var font = parseFontArchive(profile.objectForKey('Font'));
        if (!font && initialProfile) font = parseFontArchive(initialProfile.objectForKey('Font'));
        if (!font && semanticBasicProfile) font = parseFontArchive(semanticBasicProfile.objectForKey('Font'));
        if (font) result.font = font;

        return JSON.stringify(result);
      } catch (err) {
        return null;
      }
    }

    run();
  `;

  return new Promise((resolve) => {
    const child = spawn("osascript", ["-l", "JavaScript"]);
    let stdout = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.on("error", () => {
      resolve(null);
    });

    child.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim()) as {
          palette?: Partial<MacTerminalThemePalette>;
          font?: MacTerminalThemeFont | null;
        };
        const tone = prefersDarkAppearance ? "dark" : "light";
        const fallbackPalette = buildFallbackPalette(tone);
        const palette = {
          ...fallbackPalette,
          ...(parsed.palette || {}),
        };

        resolve({
          palette: {
            ...palette,
            cursor: palette.cursor || palette.foreground,
            cursorAccent: palette.cursorAccent || palette.background,
            selectionBackground: palette.selectionBackground || fallbackPalette.selectionBackground,
          },
          font: parsed.font || undefined,
        });
      } catch {
        resolve(null);
      }
    });

    child.stdin.write(jxaScript);
    child.stdin.end();
  });
}

export function refreshMacTerminalThemeCache(): void {
  // 当前按需实时读取系统配置，保留该导出仅为兼容后续调用点。
}

export async function getMacTerminalTheme(tone?: MacTerminalThemeTone): Promise<MacTerminalThemeResult> {
  if (!isMacOS()) return { ok: false, error: "not macOS platform", supported: false };

  const terminalData = await getMacTerminalPalette(tone);
  if (!terminalData || !terminalData.palette) {
    return { ok: false, error: "Failed to read Terminal.app configuration", supported: true };
  }

  const backgroundRgb = parseCssColorRgb(terminalData.palette.background);
  const backgroundLuminance = backgroundRgb
    ? backgroundRgb.r * 0.299 + backgroundRgb.g * 0.587 + backgroundRgb.b * 0.114
    : (shouldUseDarkMacAppearance() ? 0 : 255);
  const isDark = tone ? tone === "dark" : backgroundLuminance < 128;

  return {
    ok: true,
    supported: true,
    theme: {
      id: "macos-system",
      tone: isDark ? "dark" : "light",
      palette: terminalData.palette,
      font: terminalData.font,
    },
  };
}
