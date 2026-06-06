// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { getBaseUserDataDir } from "./featureFlags";

export type OnboardingState = {
  /** 是否已经处理过启动时 YOLO 权限模式推荐提示。 */
  yoloPromptHandled?: boolean;
};

const ONBOARDING_FILE_NAME = "onboarding.json";
const DEFAULT_STATE: OnboardingState = {
  yoloPromptHandled: false,
};

/**
 * 解析并归一化引导状态。
 */
function normalizeState(raw: unknown): OnboardingState {
  try {
    const obj = raw && typeof raw === "object" ? (raw as any) : {};
    return {
      ...DEFAULT_STATE,
      yoloPromptHandled: obj.yoloPromptHandled === true,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * 获取全局引导状态文件路径。
 */
export function getOnboardingStatePath(): string {
  return path.join(getBaseUserDataDir(), ONBOARDING_FILE_NAME);
}

/**
 * 读取引导状态（失败回退默认值）。
 */
export function getOnboardingState(): OnboardingState {
  try {
    const p = getOnboardingStatePath();
    if (!fs.existsSync(p)) return { ...DEFAULT_STATE };
    const raw = fs.readFileSync(p, "utf8");
    return normalizeState(JSON.parse(raw || "{}"));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * 更新引导状态（原子写入；失败回退当前值）。
 */
export function updateOnboardingState(patch: Partial<OnboardingState>): OnboardingState {
  try {
    const prev = getOnboardingState();
    const next = normalizeState({ ...prev, ...(patch || {}) });
    const p = getOnboardingStatePath();
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
    const tmp = `${p}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    try { fs.renameSync(tmp, p); } catch {
      try { fs.rmSync(p, { force: true }); } catch {}
      fs.renameSync(tmp, p);
    }
    return next;
  } catch {
    return getOnboardingState();
  }
}

export default { getOnboardingState, updateOnboardingState };
