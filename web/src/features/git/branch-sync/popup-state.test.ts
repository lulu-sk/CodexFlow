// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadGitBranchPopupState, saveGitBranchPopupState } from "./popup-state";

describe("branch popup state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("应在缺省场景回退到默认 popup tree state", () => {
    expect(loadGitBranchPopupState()).toEqual({
      selectedRepoRoot: "",
      step: "branches",
      groupOpen: {
        favorites: true,
        recent: true,
        local: true,
        remote: true,
      },
    });
  });

  it("应持久化选中仓、step 与分组展开状态", () => {
    saveGitBranchPopupState({
      selectedRepoRoot: "/repo/app",
      step: "repositories",
      groupOpen: {
        favorites: false,
        recent: true,
        local: false,
        remote: true,
      },
    });

    expect(loadGitBranchPopupState()).toEqual({
      selectedRepoRoot: "/repo/app",
      step: "repositories",
      groupOpen: {
        favorites: false,
        recent: true,
        local: false,
        remote: true,
      },
    });
  });
});
