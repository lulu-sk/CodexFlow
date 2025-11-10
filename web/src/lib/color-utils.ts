// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 轻量颜色工具：只处理 #RGB/#RRGGBB，为主题派生提供最小依赖。
 */

type RgbTuple = { r: number; g: number; b: number };

function clampByte(value: number): number {
  if (!isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

function normalizeHex(hex?: string | null): string | null {
  if (typeof hex !== "string") return null;
  const trimmed = hex.trim();
  if (!trimmed) return null;
  const full = trimmed.match(/^#([0-9a-f]{6})$/i);
  if (full) {
    return `#${full[1].toUpperCase()}`;
  }
  const short = trimmed.match(/^#([0-9a-f]{3})$/i);
  if (short) {
    const expanded = short[1]
      .split("")
      .map((ch) => `${ch}${ch}`)
      .join("");
    return `#${expanded.toUpperCase()}`;
  }
  return null;
}

function hexToRgb(hex?: string | null): RgbTuple | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const value = Number.parseInt(normalized.slice(1), 16);
  if (!Number.isFinite(value)) return null;
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function rgbToHex(rgb: RgbTuple): string {
  const toHex = (n: number) => clampByte(n).toString(16).padStart(2, "0").toUpperCase();
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * 将 base 与 target 线性混合，targetWeight=0 表示保持 base，1 表示完全 target。
 */
export function mixHexColors(base: string, target: string, targetWeight: number): string {
  const rgbA = hexToRgb(base);
  const rgbB = hexToRgb(target);
  if (!rgbA && !rgbB) return "#000000";
  if (!rgbA) return normalizeHex(target) || "#000000";
  if (!rgbB) return normalizeHex(base) || "#000000";
  const weight = Number.isFinite(targetWeight) ? Math.min(Math.max(targetWeight, 0), 1) : 0;
  const inv = 1 - weight;
  return rgbToHex({
    r: rgbA.r * inv + rgbB.r * weight,
    g: rgbA.g * inv + rgbB.g * weight,
    b: rgbA.b * inv + rgbB.b * weight,
  });
}

/**
 * 基于亮度方向调整颜色：权重>0 提亮（混合白色），<0 变暗（混合黑色）。
 */
export function shiftHexLuminance(base: string, weight: number): string {
  const normalized = normalizeHex(base);
  if (!normalized) return base;
  if (!isFinite(weight) || weight === 0) return normalized;
  const anchor = weight > 0 ? "#FFFFFF" : "#000000";
  const ratio = Math.min(1, Math.max(0, Math.abs(weight)));
  return mixHexColors(normalized, anchor, ratio);
}

/**
 * 将十六进制颜色转换为带透明度的 rgba 字符串，用于生成半透明滚动条。
 */
export function hexToRgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const clamped = Number.isFinite(alpha) ? Math.min(Math.max(alpha, 0), 1) : 1;
  const rounded = Math.round(clamped * 1000) / 1000;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${rounded})`;
}
