// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export type FeatureFlags = {
  /** 是否启用“多实例（Profile）”（实验性） */
  multiInstanceEnabled: boolean;
};

const FLAGS_FILE_NAME = "feature-flags.json";
const DEFAULT_FLAGS: FeatureFlags = { multiInstanceEnabled: false };

/**
 * 解析并归一化 feature flags（缺失字段自动回退默认值）。
 */
function normalizeFlags(raw: unknown): FeatureFlags {
  try {
    const obj = raw && typeof raw === "object" ? (raw as any) : {};
    return {
      multiInstanceEnabled: obj.multiInstanceEnabled === true,
    };
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

/**
 * 获取基础 userData 目录（跨 profile 共享），用于存储全局 feature flags。
 */
export function getBaseUserDataDir(): string {
  try {
    const fromEnv = String(process.env.CODEXFLOW_BASE_USERDATA || "").trim();
    if (fromEnv) return fromEnv;
  } catch {}
  try { return app.getPath("userData"); } catch { return process.cwd(); }
}

/**
 * 解析 feature-flags.json 路径（全局共享，不随 profile 隔离）。
 */
export function getFeatureFlagsPath(): string {
  return path.join(getBaseUserDataDir(), FLAGS_FILE_NAME);
}

/**
 * 读取 feature flags（失败回退默认值）。
 */
export function getFeatureFlags(): FeatureFlags {
  try {
    const p = getFeatureFlagsPath();
    if (!fs.existsSync(p)) return { ...DEFAULT_FLAGS };
    const raw = fs.readFileSync(p, "utf8");
    return normalizeFlags(JSON.parse(raw || "{}"));
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

/**
 * 更新 feature flags（原子写入；失败回退当前值）。
 */
export function updateFeatureFlags(patch: Partial<FeatureFlags>): FeatureFlags {
  try {
    const prev = getFeatureFlags();
    const next = normalizeFlags({ ...prev, ...(patch || {}) });
    const p = getFeatureFlagsPath();
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
    const tmp = `${p}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    try { fs.renameSync(tmp, p); } catch {
      try { fs.rmSync(p, { force: true }); } catch {}
      fs.renameSync(tmp, p);
    }
    return next;
  } catch {
    return getFeatureFlags();
  }
}

