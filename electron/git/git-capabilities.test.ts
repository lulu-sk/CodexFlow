import { describe, expect, it } from "vitest";
import {
  buildGitCapabilityState,
  isGitVersionAtLeast,
  parseGitVersionOutput,
} from "./git-capabilities";

describe("git capabilities", () => {
  it("应解析带平台后缀的 git version 输出", () => {
    expect(parseGitVersionOutput("git version 2.39.3.windows.1")).toEqual({
      major: 2,
      minor: 39,
      patch: 3,
    });
    expect(parseGitVersionOutput("git version 2.43.0")).toEqual({
      major: 2,
      minor: 43,
      patch: 0,
    });
  });

  it("应按 major/minor/patch 顺序比较版本", () => {
    expect(isGitVersionAtLeast({ major: 2, minor: 13, patch: 0 }, { major: 2, minor: 13, patch: 0 })).toBe(true);
    expect(isGitVersionAtLeast({ major: 2, minor: 13, patch: 1 }, { major: 2, minor: 13, patch: 0 })).toBe(true);
    expect(isGitVersionAtLeast({ major: 2, minor: 12, patch: 9 }, { major: 2, minor: 13, patch: 0 })).toBe(false);
    expect(isGitVersionAtLeast(null, { major: 2, minor: 13, patch: 0 })).toBe(false);
  });

  it("应按 IDEA 的 stash pathspec 门槛生成能力状态", () => {
    expect(buildGitCapabilityState("git version 2.39.3.windows.1")).toEqual({
      stashPushPathspecSupported: true,
    });
    expect(buildGitCapabilityState("git version 2.12.9")).toEqual({
      stashPushPathspecSupported: false,
    });
    expect(buildGitCapabilityState("unknown")).toEqual({
      stashPushPathspecSupported: false,
    });
  });
});
