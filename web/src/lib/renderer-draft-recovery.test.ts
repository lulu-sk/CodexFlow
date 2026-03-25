// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearRendererDraftRecovery,
  loadRendererDraftRecovery,
  restoreRecoveryPathChips,
  saveRendererDraftRecovery,
  serializeRecoveryPathChips,
} from "./renderer-draft-recovery";

const RENDERER_DRAFT_RECOVERY_STORAGE_KEY = "codexflow.rendererDraftRecovery.v1";

describe("renderer-draft-recovery（渲染刷新草稿恢复）", () => {
  afterEach(() => {
    clearRendererDraftRecovery();
    window.localStorage.clear();
  });

  it("同一 bootId 下可恢复 tab 输入与 worktree 创建面板的图片 chips", () => {
    const chips = serializeRecoveryPathChips([
      {
        chipKind: "image",
        winPath: "C:\\repo\\.gemini\\tmp\\demo\\images\\shot.png",
        wslPath: "/mnt/c/repo/.gemini/tmp/demo/images/shot.png",
        fileName: "shot.png",
        fromPaste: true,
        fingerprint: "image/png|1280x720|2048",
        type: "image/png",
        size: 2048,
      },
    ]);

    saveRendererDraftRecovery({
      version: 1,
      savedAt: Date.now(),
      bootId: "boot-1",
      tabInputsByTab: {
        "tab-1": {
          draft: "继续修这个问题",
          chips,
        },
      },
      worktreeCreateDraftByRepoId: {
        "repo-1": {
          baseBranch: "main",
          remarkBaseName: "需求A",
          selectedChildWorktreeIds: ["wt-1"],
          promptChips: chips,
          promptDraft: "请先看截图",
          useYolo: false,
          useMultipleModels: true,
          singleProviderId: "gemini",
          multiCounts: { codex: 0, claude: 1, gemini: 2 },
        },
      },
    });

    const restored = loadRendererDraftRecovery({ currentBootId: "boot-1" });
    expect(restored?.tabInputsByTab["tab-1"]?.draft).toBe("继续修这个问题");
    expect(restored?.worktreeCreateDraftByRepoId["repo-1"]?.promptDraft).toBe("请先看截图");

    const restoredChips = restoreRecoveryPathChips(restored?.worktreeCreateDraftByRepoId["repo-1"]?.promptChips);
    expect(restoredChips).toHaveLength(1);
    expect(restoredChips[0]).toMatchObject({
      chipKind: "image",
      winPath: "C:\\repo\\.gemini\\tmp\\demo\\images\\shot.png",
      fileName: "shot.png",
      fromPaste: true,
      previewUrl: "",
      type: "image/png",
    });
  });

  it("bootId 不匹配时应拒绝恢复并清理旧快照", () => {
    saveRendererDraftRecovery({
      version: 1,
      savedAt: Date.now(),
      bootId: "boot-old",
      tabInputsByTab: {
        "tab-1": {
          draft: "old draft",
          chips: [],
        },
      },
      worktreeCreateDraftByRepoId: {},
    });

    expect(loadRendererDraftRecovery({ currentBootId: "boot-new" })).toBeNull();
    expect(window.localStorage.getItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it("快照超过上限时应清理旧快照，避免恢复到陈旧草稿", () => {
    saveRendererDraftRecovery({
      version: 1,
      savedAt: Date.now(),
      bootId: "boot-1",
      tabInputsByTab: {
        "tab-1": {
          draft: "recent draft",
          chips: [],
        },
      },
      worktreeCreateDraftByRepoId: {},
    });

    expect(window.localStorage.getItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY)).not.toBeNull();

    saveRendererDraftRecovery({
      version: 1,
      savedAt: Date.now(),
      bootId: "boot-1",
      tabInputsByTab: {
        "tab-1": {
          draft: "x".repeat(1_300_000),
          chips: [],
        },
      },
      worktreeCreateDraftByRepoId: {},
    });

    expect(window.localStorage.getItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(loadRendererDraftRecovery({ currentBootId: "boot-1" })).toBeNull();
  });

  it("损坏的快照应在读取时被清理", () => {
    window.localStorage.setItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY, "{broken json");

    expect(loadRendererDraftRecovery({ currentBootId: "boot-1" })).toBeNull();
    expect(window.localStorage.getItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY)).toBeNull();
  });
});
