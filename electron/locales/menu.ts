// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 编辑类菜单标签字典（主进程使用，最小依赖，便于扩展）
// 仅包含 en/zh，其他语言将回退到 en。
export type EditMenuLabels = {
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
};

export const EDIT_MENU_LABELS: Record<string, EditMenuLabels> = {
  en: {
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
  },
  zh: {
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
  },
};

// ---- 用户目录覆盖（userData/locales/<lng>/menu.json）----
// 设计目标：
// - 仅在首次请求某个语言时尝试读取用户覆盖；
// - 读取失败或未找到即缓存为空，避免每次右键都触发磁盘 IO；
// - 仅接受已知键（undo/redo/cut/copy/paste/selectAll）的字符串值。

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { normalizeLocale } from "../i18n";

const VALID_KEYS = new Set<keyof EditMenuLabels>(["undo", "redo", "cut", "copy", "paste", "selectAll"]);

type PartialLabels = Partial<EditMenuLabels>;
const userOverrideCache = new Map<string, PartialLabels | null>();

function tryReadUserMenuFile(lc: string): PartialLabels | null {
  try {
    const dir = path.join(app.getPath("userData"), "locales", lc);
    const file = path.join(dir, "menu.json");
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    const json = JSON.parse(text);
    const out: PartialLabels = {};
    if (json && typeof json === "object") {
      for (const k of Object.keys(json)) {
        const key = k as keyof EditMenuLabels;
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
  const ov = tryReadUserMenuFile(lc);
  userOverrideCache.set(lc, ov);
  return ov;
}

function mergeLabels(base: EditMenuLabels, override?: PartialLabels | null): EditMenuLabels {
  if (!override) return base;
  return {
    undo: override.undo ?? base.undo,
    redo: override.redo ?? base.redo,
    cut: override.cut ?? base.cut,
    copy: override.copy ?? base.copy,
    paste: override.paste ?? base.paste,
    selectAll: override.selectAll ?? base.selectAll,
  };
}

// 基于应用语言返回合并后的编辑菜单标签
export function getEditMenuLabelsForLocale(localeRaw?: string): EditMenuLabels {
  const lc = normalizeLocale(localeRaw);
  const base = EDIT_MENU_LABELS[lc] || EDIT_MENU_LABELS["en"];
  const ov = getUserOverride(lc) || (lc !== "en" ? getUserOverride("en") : null);
  return mergeLabels(base, ov);
}

// 允许外部在必要时手动清空缓存（例如用户手动更新了 menu.json）
export function clearEditMenuLabelsCache() {
  try { userOverrideCache.clear(); } catch {}
}

// 不使用默认导出，遵循“避免不必要的默认导出”的约定
