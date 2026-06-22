import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getOnboardingState, getOnboardingStatePath, updateOnboardingState } from "./onboarding";

const previousBaseUserData = process.env.CODEXFLOW_BASE_USERDATA;

/**
 * 准备隔离的引导状态目录，避免测试读写真实用户配置。
 */
function useTempOnboardingDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-onboarding-"));
  process.env.CODEXFLOW_BASE_USERDATA = dir;
  return dir;
}

afterEach(() => {
  if (previousBaseUserData === undefined)
    delete process.env.CODEXFLOW_BASE_USERDATA;
  else
    process.env.CODEXFLOW_BASE_USERDATA = previousBaseUserData;
});

describe("onboarding state", () => {
  it("缺少状态文件时返回安全默认值", () => {
    useTempOnboardingDir();

    expect(getOnboardingState()).toEqual({
      yoloPromptHandled: false,
      antigravityYoloPromptHandled: false,
    });
  });

  it("会保存 YOLO 明确选择和 Antigravity 继承确认状态", () => {
    useTempOnboardingDir();

    const state = updateOnboardingState({
      yoloPromptHandled: true,
      yoloPreference: "enabled",
      antigravityYoloPromptHandled: true,
    });

    expect(state).toEqual({
      yoloPromptHandled: true,
      yoloPreference: "enabled",
      antigravityYoloPromptHandled: true,
    });
    expect(getOnboardingState()).toEqual(state);
  });

  it("会清理非法偏好值并兼容旧文件", () => {
    useTempOnboardingDir();
    fs.mkdirSync(path.dirname(getOnboardingStatePath()), { recursive: true });
    fs.writeFileSync(getOnboardingStatePath(), JSON.stringify({
      yoloPromptHandled: true,
      yoloPreference: "maybe",
    }), "utf8");

    expect(getOnboardingState()).toEqual({
      yoloPromptHandled: true,
      antigravityYoloPromptHandled: false,
    });
  });
});
