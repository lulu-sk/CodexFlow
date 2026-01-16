// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { normalizeLocale } from "../i18n";

export type QuitConfirmLabels = {
  title: string;
  message: string;
  detail: string;
  cancel: string;
  quit: string;
};

export type QuitConfirmDialogText = {
  title: string;
  message: string;
  detail: string;
  cancel: string;
  quit: string;
};

export const QUIT_CONFIRM_LABELS: Record<string, QuitConfirmLabels> = {
  en: {
    title: "Confirm exit",
    message: "There are still {{count}} terminal session(s) running. Quit anyway?",
    detail: "Quitting will close all running terminal sessions.",
    cancel: "Cancel",
    quit: "Quit",
  },
  zh: {
    title: "确认退出",
    message: "还有 {{count}} 个终端会话正在运行，确定要退出吗？",
    detail: "退出将关闭所有仍在运行的终端会话。",
    cancel: "取消",
    quit: "退出",
  },
};

const VALID_KEYS = new Set<keyof QuitConfirmLabels>(["title", "message", "detail", "cancel", "quit"]);

type PartialLabels = Partial<QuitConfirmLabels>;
const userOverrideCache = new Map<string, PartialLabels | null>();

/**
 * 将模板中的 `{{count}}`/`{count}` 替换为数量。
 */
export function formatQuitConfirmMessage(template: string, count: number): string {
  const safeCount = Math.max(0, Number.isFinite(count) ? Math.floor(count) : 0);
  return String(template || "").replace(/\{\{\s*count\s*\}\}|\{\s*count\s*\}/g, String(safeCount));
}

function tryReadUserOverrideFile(lc: string): PartialLabels | null {
  try {
    const dir = path.join(app.getPath("userData"), "locales", lc);
    const file = path.join(dir, "quitConfirm.json");
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    const json = JSON.parse(text);
    const out: PartialLabels = {};
    if (json && typeof json === "object") {
      for (const k of Object.keys(json)) {
        const key = k as keyof QuitConfirmLabels;
        const val = (json as any)[k];
        if (VALID_KEYS.has(key) && typeof val === "string" && val.trim().length > 0) {
          (out as any)[key] = String(val);
        }
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function getUserOverride(lc: string): PartialLabels | null {
  if (userOverrideCache.has(lc)) return userOverrideCache.get(lc)!;
  const ov = tryReadUserOverrideFile(lc);
  userOverrideCache.set(lc, ov);
  return ov;
}

function mergeLabels(base: QuitConfirmLabels, override?: PartialLabels | null): QuitConfirmLabels {
  if (!override) return base;
  return {
    title: override.title ?? base.title,
    message: override.message ?? base.message,
    detail: override.detail ?? base.detail,
    cancel: override.cancel ?? base.cancel,
    quit: override.quit ?? base.quit,
  };
}

/**
 * 基于应用语言返回“退出确认”文案（支持 userData 覆盖并带 en 回退）。
 */
export function getQuitConfirmLabelsForLocale(localeRaw?: string): QuitConfirmLabels {
  const lc = normalizeLocale(localeRaw);
  const base = QUIT_CONFIRM_LABELS[lc] || QUIT_CONFIRM_LABELS["en"];
  const ov = getUserOverride(lc) || (lc !== "en" ? getUserOverride("en") : null);
  return mergeLabels(base, ov);
}

/**
 * 获取适用于对话框展示的最终文案（已将数量注入 message）。
 */
export function getQuitConfirmDialogTextForLocale(localeRaw: string | undefined, count: number): QuitConfirmDialogText {
  const labels = getQuitConfirmLabelsForLocale(localeRaw);
  return {
    title: labels.title,
    message: formatQuitConfirmMessage(labels.message, count),
    detail: labels.detail,
    cancel: labels.cancel,
    quit: labels.quit,
  };
}

/**
 * 清空用户覆盖缓存（例如用户手动更新了 `quitConfirm.json`）。
 */
export function clearQuitConfirmLabelsCache(): void {
  try { userOverrideCache.clear(); } catch {}
}

