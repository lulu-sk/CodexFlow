// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { toFsPathAbs, toFsPathKey } from "../git/pathKey";

export type BuiltinIdeId = "vscode" | "cursor" | "windsurf" | "rider";

export type ProjectIdePreference = {
  /** 绑定模式：builtin=内置 IDE；custom=自定义命令模板。 */
  mode: "builtin" | "custom";
  /** 内置 IDE 标识（mode=builtin 时有效）。 */
  builtinId?: BuiltinIdeId;
  /** 自定义 IDE 展示名（可选，仅用于 UI 说明）。 */
  customName?: string;
  /** 自定义 IDE 命令模板（mode=custom 时有效）。 */
  customCommand?: string;
};

type ProjectIdeItem = {
  /** 项目根目录（绝对路径，保留原始大小写用于显示/诊断）。 */
  projectPath: string;
  /** 项目绑定的 IDE 配置。 */
  config: ProjectIdePreference;
  /** 更新时间戳（毫秒）。 */
  updatedAt: number;
};

type StoreShape = {
  version: 2;
  items: Record<string, ProjectIdeItem>;
};

/**
 * 中文说明：获取“项目 IDE 绑定”存储文件路径（位于 userData，避免写入仓库）。
 */
function getStorePath(): string {
  const dir = app.getPath("userData");
  return path.join(dir, "project-ide.json");
}

/**
 * 中文说明：将输入值规范化为内置 IDE 标识。
 */
export function normalizeBuiltinIdeId(raw: unknown): BuiltinIdeId | null {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "vscode" || value === "cursor" || value === "windsurf" || value === "rider") {
    return value as BuiltinIdeId;
  }
  return null;
}

/**
 * 中文说明：对项目 IDE 配置做归一化与兼容迁移（支持旧版 ideId 字段）。
 */
export function normalizeProjectIdePreference(raw: unknown): ProjectIdePreference | null {
  if (raw == null) return null;

  // 兼容旧版：直接字符串表示内置 IDE。
  if (typeof raw === "string") {
    const builtinId = normalizeBuiltinIdeId(raw);
    return builtinId ? { mode: "builtin", builtinId } : null;
  }

  const obj = raw && typeof raw === "object" ? (raw as any) : null;
  if (!obj) return null;

  const modeRaw = String(obj.mode || "").trim().toLowerCase();
  const builtinId = normalizeBuiltinIdeId(obj.builtinId ?? obj.ideId);
  const customName = String(obj.customName || "").trim();
  const customCommand = String(obj.customCommand || "").trim();

  if (modeRaw === "builtin") {
    if (!builtinId) return null;
    return { mode: "builtin", builtinId };
  }

  if (modeRaw === "custom") {
    if (!customCommand) return null;
    return {
      mode: "custom",
      customName: customName || undefined,
      customCommand,
    };
  }

  // 兼容“无 mode 但字段可推断”的数据。
  if (builtinId) return { mode: "builtin", builtinId };
  if (customCommand) {
    return {
      mode: "custom",
      customName: customName || undefined,
      customCommand,
    };
  }

  return null;
}

/**
 * 中文说明：对配置对象做浅拷贝，避免外部修改缓存对象。
 */
function clonePreference(config: ProjectIdePreference): ProjectIdePreference {
  return {
    mode: config.mode,
    builtinId: config.builtinId,
    customName: config.customName,
    customCommand: config.customCommand,
  };
}

/**
 * 中文说明：从磁盘读取项目 IDE 绑定（失败时返回空对象）。
 */
function loadStore(): StoreShape {
  try {
    const fp = getStorePath();
    if (!fs.existsSync(fp)) return { version: 2, items: {} };
    const raw = fs.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw || "{}") as any;
    const itemsRaw = parsed && typeof parsed === "object" && parsed.items && typeof parsed.items === "object"
      ? parsed.items
      : {};

    const items: Record<string, ProjectIdeItem> = {};
    for (const [rootKey, itemRaw] of Object.entries(itemsRaw as Record<string, unknown>)) {
      if (!itemRaw || typeof itemRaw !== "object") continue;
      const itemObj = itemRaw as any;
      const config = normalizeProjectIdePreference(itemObj.config ?? itemObj.ideId);
      if (!config) continue;
      const projectPath = String(itemObj.projectPath || "").trim() || String(rootKey || "").trim();
      const updatedAt = Number.isFinite(Number(itemObj.updatedAt)) ? Math.floor(Number(itemObj.updatedAt)) : 0;
      items[String(rootKey || "")] = {
        projectPath,
        config,
        updatedAt,
      };
    }

    return { version: 2, items };
  } catch {
    return { version: 2, items: {} };
  }
}

/**
 * 中文说明：将项目 IDE 绑定写回磁盘（写入失败忽略，避免阻塞主流程）。
 */
function saveStore(next: StoreShape): void {
  try {
    fs.writeFileSync(getStorePath(), JSON.stringify(next, null, 2), "utf8");
  } catch {}
}

/**
 * 中文说明：判断 targetKey 是否落在 rootKey 下（含相等）。
 */
function isPathWithinRoot(rootKey: string, targetKey: string): boolean {
  const root = String(rootKey || "").trim();
  const target = String(targetKey || "").trim();
  if (!root || !target) return false;
  if (target === root) return true;
  return target.startsWith(`${root}/`);
}

/**
 * 中文说明：读取指定项目根目录绑定的 IDE 配置。
 */
export function getProjectPreferredIde(projectPath: string): ProjectIdePreference | null {
  const abs = toFsPathAbs(projectPath);
  const key = toFsPathKey(abs);
  if (!key) return null;
  const store = loadStore();
  const hit = store.items[key];
  if (!hit || typeof hit !== "object") return null;
  const normalized = normalizeProjectIdePreference((hit as any).config);
  if (!normalized) return null;
  return clonePreference(normalized);
}

/**
 * 中文说明：写入或清除指定项目根目录的 IDE 绑定。
 * - config 为空时表示清除绑定。
 */
export function setProjectPreferredIde(projectPath: string, config: ProjectIdePreference | null): void {
  const abs = toFsPathAbs(projectPath);
  const key = toFsPathKey(abs);
  if (!key) return;

  const store = loadStore();
  const normalized = normalizeProjectIdePreference(config);
  if (!normalized) {
    if (store.items[key]) {
      delete store.items[key];
      saveStore(store);
    }
    return;
  }

  store.items[key] = {
    projectPath: abs || projectPath,
    config: normalized,
    updatedAt: Date.now(),
  };
  saveStore(store);
}

/**
 * 中文说明：按“最长路径前缀”匹配目标文件所属项目，并返回该项目绑定的 IDE 配置。
 */
export function findProjectPreferredIdeForTargetPath(targetPath: string): ProjectIdePreference | null {
  const targetAbs = toFsPathAbs(targetPath);
  const targetKey = toFsPathKey(targetAbs);
  if (!targetKey) return null;

  const store = loadStore();
  let bestConfig: ProjectIdePreference | null = null;
  let bestLen = -1;
  for (const [rootKey, item] of Object.entries(store.items || {})) {
    if (!item || typeof item !== "object") continue;
    const config = normalizeProjectIdePreference((item as any).config);
    if (!config) continue;
    if (!isPathWithinRoot(rootKey, targetKey)) continue;
    if (rootKey.length <= bestLen) continue;
    bestLen = rootKey.length;
    bestConfig = config;
  }
  return bestConfig ? clonePreference(bestConfig) : null;
}
