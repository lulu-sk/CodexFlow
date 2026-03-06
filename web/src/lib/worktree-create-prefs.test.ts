// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearWorktreeCreatePromptPrefs,
  clearWorktreeCreateTransientPrefs,
  loadWorktreeCreatePrefs,
  saveWorktreeCreatePrefs,
  type WorktreeCreatePrefs,
} from "./worktree-create-prefs";

describe("worktree-create-prefs（创建面板偏好持久化）", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("clearWorktreeCreatePromptPrefs 仅清空初始提示词字段", () => {
    const repoProjectId = "repo-1";
    const prefs: WorktreeCreatePrefs = {
      baseBranch: "main",
      remarkBaseName: "需求A",
      selectedChildWorktreeIds: ["wt-1"],
      promptChips: [{ chipKind: "file", fileName: "README.md", winPath: "C:/repo/README.md" }],
      promptDraft: "请先阅读 README",
      useYolo: false,
      useMultipleModels: true,
      singleProviderId: "claude",
      multiCounts: { codex: 1, claude: 2, gemini: 0 },
    };
    saveWorktreeCreatePrefs(repoProjectId, prefs);

    clearWorktreeCreatePromptPrefs(repoProjectId);

    expect(loadWorktreeCreatePrefs(repoProjectId)).toEqual({
      ...prefs,
      promptChips: [],
      promptDraft: "",
    });
  });

  it("clearWorktreeCreateTransientPrefs 仅保留模型实例相关设置，并支持恢复默认备注", () => {
    const repoProjectId = "repo-2";
    saveWorktreeCreatePrefs(repoProjectId, {
      baseBranch: "release/1.0",
      remarkBaseName: "需求B",
      selectedChildWorktreeIds: ["wt-2", "wt-3"],
      promptChips: [{ chipKind: "rule", rulePath: ".codex/rules.md" }],
      promptDraft: "处理分支问题",
      useYolo: true,
      useMultipleModels: true,
      singleProviderId: "gemini",
      multiCounts: { codex: 0, claude: 1, gemini: 2 },
    });

    clearWorktreeCreateTransientPrefs(repoProjectId, { remarkBaseName: "默认备注" });

    expect(loadWorktreeCreatePrefs(repoProjectId)).toEqual({
      baseBranch: "",
      remarkBaseName: "默认备注",
      selectedChildWorktreeIds: [],
      promptChips: [],
      promptDraft: "",
      useYolo: true,
      useMultipleModels: true,
      singleProviderId: "gemini",
      multiCounts: { codex: 0, claude: 1, gemini: 2 },
    });
  });
});
