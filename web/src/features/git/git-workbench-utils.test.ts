import i18next from "i18next";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CommitDiffOpenRequest } from "./commit-panel/main-chain";
import type { GitConsoleEntry, GitLogItem, GitStatusEntry } from "./types";
import {
  buildCommitPatchPathspecs,
  buildCommitDetailsRequestKey,
  buildCommitLineStatsSummary,
  buildCommitDiffRequestSignature,
  buildCommitDiffSnapshotSignature,
  buildCommitSelectionSignature,
  buildGitStageAllOperationBatches,
  buildGitLogCheckoutMenuModel,
  buildGitConsoleCopyText,
  buildGitStageOperationBatches,
  buildPatchExportFileName,
  buildWorkingTreePatchRequests,
  canUseDiffPartialCommit,
  resolveLoadedFileHistoryPath,
  resolveLogActionExecutionHashes,
  resolveOperationProblemConflictResolverRequest,
  resolveOperationControlFailureFeedback,
  resolvePendingLogSelectionItem,
  resolveLogActionOperationFailureFeedback,
  resolveGitWorkbenchBootstrapRefresh,
  resolvePartialCommitValidationDiffMode,
  shouldFinalizeCherryPickByCommit,
  shouldRefreshAfterClosingOperationProblem,
  shouldSkipCommitDetailsRequest,
  shouldAutoPreviewCommitSelection,
  shouldShowDiffPartialCommit,
} from "./git-workbench-utils";

let originalGitI18nInitialized = false;

/**
 * 为纯函数测试补一个最小 i18n 桩，确保 `resolveGitText` 在未挂载 React i18n 上下文时也能按用户可见文案完成占位符插值。
 */
function interpolateTemplate(template: string, values?: Record<string, unknown>): string {
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    const value = values?.[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

beforeAll(() => {
  originalGitI18nInitialized = i18next.isInitialized;
  vi.spyOn(i18next, "t").mockImplementation(((key: string, options?: Record<string, unknown>) => {
    const fallback = String(options?.defaultValue || key || "");
    return interpolateTemplate(fallback, options);
  }) as typeof i18next.t);
  (i18next as { isInitialized: boolean }).isInitialized = true;
});

afterAll(() => {
  vi.restoreAllMocks();
  (i18next as { isInitialized: boolean }).isInitialized = originalGitI18nInitialized;
});

/**
 * 构造最小 Diff 打开请求，供签名稳定性测试复用。
 */
function createDiffRequest(input?: Partial<CommitDiffOpenRequest>): CommitDiffOpenRequest {
  return {
    path: "src/app.ts",
    mode: "working",
    hash: undefined,
    hashes: [],
    selectionPaths: ["src/app.ts"],
    selectionKind: "single",
    selectionIndex: 0,
    ...input,
  };
}

/**
 * 构造最小 Git 控制台条目，避免测试重复拼装样板数据。
 */
function createConsoleEntry(input?: Partial<GitConsoleEntry>): GitConsoleEntry {
  return {
    id: 1,
    timestamp: Date.UTC(2026, 2, 11, 6, 0, 0),
    cwd: "G:/Repo",
    repoRootKey: "g:/repo",
    command: "git status --short",
    ok: true,
    exitCode: 0,
    durationMs: 12,
    stdout: "M src/app.ts",
    stderr: "",
    error: undefined,
    running: false,
    ...input,
  };
}

/**
 * 构造最小日志项，供文件历史路径解析测试复用。
 */
function createLogItem(input?: Partial<GitLogItem>): GitLogItem {
  return {
    hash: "abc123",
    shortHash: "abc123",
    parents: [],
    authorName: "tester",
    authorEmail: "tester@example.com",
    authorDate: "2026-03-26T12:00:00+08:00",
    subject: "test commit",
    decorations: "",
    ...input,
  };
}

/**
 * 构造最小状态条目，供 partial commit 可用性测试复用。
 */
function createStatusEntry(input?: Partial<{ staged: boolean; untracked: boolean; ignored: boolean }>): {
  staged: boolean;
  untracked: boolean;
  ignored: boolean;
} {
  return {
    staged: false,
    untracked: false,
    ignored: false,
    ...input,
  };
}

/**
 * 构造最小 Git 状态条目，供 patch / stage batching 相关测试复用。
 */
function createWorkbenchStatusEntry(input?: Partial<GitStatusEntry>): GitStatusEntry {
  return {
    path: "src/app.ts",
    x: ".",
    y: "M",
    staged: false,
    unstaged: true,
    untracked: false,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: "已修改",
    changeListId: "default",
    ...input,
  };
}

describe("git workbench utils", () => {
  it("提交树选区签名应按顺序稳定拼接", () => {
    expect(buildCommitSelectionSignature(["group:default", "node:file-a"])).toBe("group:default|node:file-a");
    expect(buildCommitSelectionSignature(["", "node:file-a"])).toBe("node:file-a");
  });

  it("日志右键 Checkout 菜单应仅收敛非当前本地分支，并在存在分支项时切换为子菜单", () => {
    expect(buildGitLogCheckoutMenuModel({
      localBranchRefs: ["master", "release", "master"],
      currentBranch: "master",
    })).toEqual({
      checkoutBranchNames: ["release"],
      useSubmenu: true,
    });

    expect(buildGitLogCheckoutMenuModel({
      localBranchRefs: ["master"],
      currentBranch: "master",
    })).toEqual({
      checkoutBranchNames: [],
      useSubmenu: false,
    });
  });

  it("提交详情请求键应按仓库与哈希选区稳定归一，并支持已加载/进行中去重", () => {
    const requestKey = buildCommitDetailsRequestKey("G:\\Repo\\", "abc123|def456");
    expect(requestKey).toBe("G:/Repo::abc123|def456");
    expect(shouldSkipCommitDetailsRequest({
      requestKey,
      loadedRequestKey: requestKey,
      requestedRequestKey: "",
    })).toBe(true);
    expect(shouldSkipCommitDetailsRequest({
      requestKey,
      loadedRequestKey: "",
      requestedRequestKey: requestKey,
    })).toBe(true);
    expect(shouldSkipCommitDetailsRequest({
      requestKey,
      loadedRequestKey: "G:/Repo::zzz999",
      requestedRequestKey: "",
    })).toBe(false);
  });

  it("相同 Diff 请求应得到相同签名，不同选择集应区分签名", () => {
    const base = createDiffRequest({
      hashes: ["abc123", "def456"],
      selectionPaths: ["src/app.ts", "src/test.ts"],
      selectionKind: "change",
      selectionIndex: 1,
    });
    expect(buildCommitDiffRequestSignature(base)).toBe(buildCommitDiffRequestSignature(createDiffRequest({
      hashes: ["abc123", "def456"],
      selectionPaths: ["src/app.ts", "src/test.ts"],
      selectionKind: "change",
      selectionIndex: 1,
    })));
    expect(buildCommitDiffRequestSignature(base)).not.toBe(buildCommitDiffRequestSignature(createDiffRequest({
      hashes: ["abc123", "def456"],
      selectionPaths: ["src/test.ts", "src/app.ts"],
      selectionKind: "change",
      selectionIndex: 0,
    })));
  });

  it("shelfRef 应参与 Diff 请求签名，避免 shelf 与普通工作区 Diff 互相误判复用", () => {
    expect(buildCommitDiffRequestSignature(createDiffRequest({
      mode: "shelf",
      shelfRef: "shelf@{1}",
    }))).not.toBe(buildCommitDiffRequestSignature(createDiffRequest({
      mode: "shelf",
      shelfRef: "shelf@{2}",
    })));
  });

  it("当前 Diff 快照签名应与等价请求保持一致", () => {
    const request = createDiffRequest({
      mode: "staged",
      hash: "abc123",
      hashes: ["abc123", "def456"],
      selectionPaths: ["src/app.ts", "src/test.ts"],
      selectionKind: "change",
      selectionIndex: 1,
    });
    expect(buildCommitDiffSnapshotSignature({
      path: request.path,
      mode: request.mode,
      hash: request.hash,
      hashes: request.hashes,
      selectionPaths: request.selectionPaths,
      selectionKind: request.selectionKind,
      selectionIndex: request.selectionIndex,
      isBinary: false,
      leftText: "",
      rightText: "",
      leftTitle: "HEAD",
      rightTitle: "Index",
    })).toBe(buildCommitDiffRequestSignature(request));
  });

  it("文件历史日志项已携带 historyPath 时，应直接复用并跳过额外路径解析", () => {
    expect(resolveLoadedFileHistoryPath({
      selectedHash: "rename",
      fallbackPath: "src/new-name.ts",
      logItems: [
        createLogItem({ hash: "head", historyPath: "src/new-name.ts" }),
        createLogItem({ hash: "rename", historyPath: "src\\old-name.ts" }),
      ],
    })).toEqual({
      path: "src/old-name.ts",
      fromLogItem: true,
    });

    expect(resolveLoadedFileHistoryPath({
      selectedHash: "missing",
      fallbackPath: "src/new-name.ts",
      logItems: [createLogItem({ hash: "head", historyPath: "src/new-name.ts" })],
    })).toEqual({
      path: "src/new-name.ts",
      fromLogItem: false,
    });
  });

  it("文件历史模式下应等待带 historyPath 的新日志项到位后再应用 pending 选中", () => {
    expect(resolvePendingLogSelectionItem({
      targetHash: "same-hash",
      requireHistoryPath: true,
      logItems: [createLogItem({ hash: "same-hash" })],
    })).toBeNull();

    expect(resolvePendingLogSelectionItem({
      targetHash: "same-hash",
      requireHistoryPath: true,
      logItems: [createLogItem({ hash: "same-hash", historyPath: "src/history.ts" })],
    })?.historyPath).toBe("src/history.ts");

    expect(resolvePendingLogSelectionItem({
      targetHash: "same-hash",
      requireHistoryPath: false,
      logItems: [createLogItem({ hash: "same-hash" })],
    })?.hash).toBe("same-hash");
  });

  it("关闭 merge-conflict 问题弹窗后应触发刷新，其它问题不需要", () => {
    expect(shouldRefreshAfterClosingOperationProblem(null)).toBe(false);
    expect(shouldRefreshAfterClosingOperationProblem({
      operation: "cherry-pick",
      kind: "merge-conflict",
      title: "Cherry-pick 出现冲突",
      description: "已进入进行中状态",
      files: ["src/app.ts"],
      source: "smart-operation",
      actions: [],
    })).toBe(true);
    expect(shouldRefreshAfterClosingOperationProblem({
      operation: "cherry-pick",
      kind: "local-changes-overwritten",
      title: "本地改动会被覆盖",
      description: "需要先处理本地改动",
      files: ["src/app.ts"],
      source: "smart-operation",
      actions: [],
    })).toBe(false);
  });

  it("同一激活周期内，同仓库首刷只应触发一次；失活后重新激活可再次触发", () => {
    expect(resolveGitWorkbenchBootstrapRefresh({
      active: true,
      repoPath: "G:/Repo",
      lastBootstrapRepoPath: "",
    })).toEqual({
      shouldRefresh: true,
      nextBootstrapRepoPath: "G:/Repo",
    });
    expect(resolveGitWorkbenchBootstrapRefresh({
      active: true,
      repoPath: "G:/Repo",
      lastBootstrapRepoPath: "G:/Repo",
    })).toEqual({
      shouldRefresh: false,
      nextBootstrapRepoPath: "G:/Repo",
    });
    expect(resolveGitWorkbenchBootstrapRefresh({
      active: false,
      repoPath: "G:/Repo",
      lastBootstrapRepoPath: "G:/Repo",
    })).toEqual({
      shouldRefresh: false,
      nextBootstrapRepoPath: "",
    });
    expect(resolveGitWorkbenchBootstrapRefresh({
      active: true,
      repoPath: "G:/Repo",
      lastBootstrapRepoPath: "",
    })).toEqual({
      shouldRefresh: true,
      nextBootstrapRepoPath: "G:/Repo",
    });
  });

  it("提交详情行统计文案应保留 + / - / 共，并额外输出净增减", () => {
    expect(buildCommitLineStatsSummary({ additions: 209, deletions: 25 })).toEqual({
      additions: 209,
      deletions: 25,
      total: 234,
      net: 184,
      netDirection: "increase",
      totalText: "共 234 行",
      additionsText: "+209",
      deletionsText: "-25",
      netText: "净增 184 行",
    });
  });

  it("详情树激活时，主提交树不应再覆盖当前 Diff 预览", () => {
    expect(shouldAutoPreviewCommitSelection({
      activeSelectionScope: "detail",
      previewEnabled: true,
      hasLoadedDiff: true,
    })).toBe(false);
    expect(shouldAutoPreviewCommitSelection({
      activeSelectionScope: "commit",
      previewEnabled: true,
      hasLoadedDiff: true,
      diffPinned: false,
    })).toBe(true);
    expect(shouldAutoPreviewCommitSelection({
      activeSelectionScope: null,
      previewEnabled: true,
      hasLoadedDiff: false,
    })).toBe(true);
    expect(shouldAutoPreviewCommitSelection({
      activeSelectionScope: "commit",
      previewEnabled: true,
      hasLoadedDiff: true,
      diffPinned: true,
    })).toBe(false);
  });

  it("stage batching 应按 repoRoot 聚合同仓路径，并保留路径去重", () => {
    expect(buildGitStageOperationBatches({
      fallbackRepoRoot: "/repo",
      entries: [
        createWorkbenchStatusEntry({ path: "src/a.ts", repositoryRoot: "/repo" }),
        createWorkbenchStatusEntry({ path: "src/a.ts", repositoryRoot: "/repo" }),
        createWorkbenchStatusEntry({ path: "pkg/b.ts", repositoryRoot: "/repo-lib" }),
      ],
    })).toEqual([
      { repoRoot: "/repo", paths: ["src/a.ts"] },
      { repoRoot: "/repo-lib", paths: ["pkg/b.ts"] },
    ]);
  });

  it("Git.Stage.Add.All batching 应覆盖 tracked unstaged 与 untracked，并排除 ignored/staged-only 条目", () => {
    expect(buildGitStageAllOperationBatches({
      fallbackRepoRoot: "/repo",
      entries: [
        createWorkbenchStatusEntry({ path: "src/tracked.ts", repositoryRoot: "/repo", unstaged: true, untracked: false }),
        createWorkbenchStatusEntry({ path: "src/new.ts", repositoryRoot: "/repo", untracked: true, unstaged: true }),
        createWorkbenchStatusEntry({ path: "src/ignored.ts", repositoryRoot: "/repo", untracked: true, unstaged: true, ignored: true }),
        createWorkbenchStatusEntry({ path: "pkg/staged.ts", repositoryRoot: "/repo-lib", staged: true, unstaged: false, untracked: false }),
        createWorkbenchStatusEntry({ path: "pkg/changed.ts", repositoryRoot: "/repo-lib", staged: false, unstaged: true, untracked: false }),
      ],
    })).toEqual([
      { repoRoot: "/repo", paths: ["src/tracked.ts", "src/new.ts"] },
      { repoRoot: "/repo-lib", paths: ["pkg/changed.ts"] },
    ]);
  });

  it("本地变更 create patch 应把 mixed/untracked 视为 working patch，并保留 rename oldPath", () => {
    expect(buildWorkingTreePatchRequests({
      fallbackRepoRoot: "/repo",
      entries: [
        createWorkbenchStatusEntry({ path: "src/app.ts", staged: true, unstaged: true }),
        createWorkbenchStatusEntry({ path: "src/new.ts", untracked: true, staged: false, unstaged: true }),
        createWorkbenchStatusEntry({ path: "src/renamed.ts", oldPath: "src/old.ts", renamed: true, staged: true, unstaged: false }),
      ],
    })).toEqual([
      { repoRoot: "/repo", path: "src/app.ts", oldPath: undefined, mode: "working" },
      { repoRoot: "/repo", path: "src/new.ts", oldPath: undefined, mode: "working" },
      { repoRoot: "/repo", path: "src/renamed.ts", oldPath: "src/old.ts", mode: "staged" },
    ]);
  });

  it("提交 patch pathspec 应在 rename/copy 场景带上旧路径", () => {
    expect(buildCommitPatchPathspecs([
      { path: "src/new-name.ts", oldPath: "src/old-name.ts", status: "R100" },
      { path: "src/plain.ts" },
    ])).toEqual([
      "src/new-name.ts",
      "src/old-name.ts",
      "src/plain.ts",
    ]);
  });

  it("patch 导出文件名应优先保留提交哈希，其次保留单文件名", () => {
    expect(buildPatchExportFileName({
      hash: "abcdef1234567890",
      paths: ["src/app.ts"],
    })).toBe("commit-abcdef1-app.ts.patch");
    expect(buildPatchExportFileName({
      paths: ["src/app.ts"],
    })).toBe("app.ts.patch");
    expect(buildPatchExportFileName({
      paths: ["src/app.ts", "src/lib.ts"],
    })).toBe("changes.patch");
  });

  it("working 与 staged 的已跟踪 Diff 都应允许 partial commit，但 untracked/ignored/非本地 Diff 不允许", () => {
    expect(canUseDiffPartialCommit({
      diff: {
        path: "src/app.ts",
        mode: "working",
        isBinary: false,
        leftTitle: "HEAD",
        rightTitle: "Working Tree",
      },
      entry: createStatusEntry(),
    })).toBe(true);
    expect(canUseDiffPartialCommit({
      diff: {
        path: "src/app.ts",
        mode: "staged",
        isBinary: false,
        leftTitle: "HEAD",
        rightTitle: "Index",
      },
      entry: createStatusEntry({ staged: true }),
    })).toBe(true);
    expect(canUseDiffPartialCommit({
      diff: {
        path: "src/app.ts",
        mode: "staged",
        isBinary: false,
        leftTitle: "HEAD",
        rightTitle: "Index",
      },
      entry: createStatusEntry({ staged: false }),
    })).toBe(false);
    expect(canUseDiffPartialCommit({
      diff: {
        path: "src/app.ts",
        mode: "working",
        isBinary: false,
        leftTitle: "HEAD",
        rightTitle: "Working Tree",
      },
      entry: createStatusEntry({ untracked: true }),
    })).toBe(false);
    expect(canUseDiffPartialCommit({
      diff: {
        path: "src/app.ts",
        mode: "commit",
        isBinary: false,
        leftTitle: "a1b2c3d4",
        rightTitle: "b2c3d4e5",
      },
      entry: createStatusEntry({ staged: true }),
    })).toBe(false);
  });

  it("仅在具备可选 hunk 时才应显示 partial commit 控件", () => {
    expect(shouldShowDiffPartialCommit({
      diff: {
        path: "src/app.ts",
        mode: "staged",
        isBinary: false,
        leftTitle: "HEAD",
        rightTitle: "Index",
        hunks: [],
      },
      entry: createStatusEntry({ staged: true }),
    })).toBe(false);
    expect(shouldShowDiffPartialCommit({
      diff: {
        path: "src/app.ts",
        mode: "staged",
        isBinary: false,
        leftTitle: "HEAD",
        rightTitle: "Index",
        hunks: [{
          id: "hunk-1",
          header: "@@ -1,1 +1,1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          preview: "changed",
          patch: "@@ -1,1 +1,1 @@\n-a\n+b\n",
          lines: [
            { kind: "del", content: "a", oldLineNumber: 1 },
            { kind: "add", content: "b", newLineNumber: 1 },
          ],
        }],
      },
      entry: createStatusEntry({ staged: true }),
    })).toBe(true);
  });

  it("partial commit 提交前校验应优先复用已记录的 Diff mode", () => {
    expect(resolvePartialCommitValidationDiffMode({
      partialEntry: { diffMode: "staged" },
      entry: createStatusEntry(),
    })).toBe("staged");
    expect(resolvePartialCommitValidationDiffMode({
      partialEntry: { diffMode: "working" },
      entry: createStatusEntry({ staged: true }),
    })).toBe("working");
    expect(resolvePartialCommitValidationDiffMode({
      partialEntry: null,
      entry: createStatusEntry({ staged: true }),
    })).toBe("staged");
    expect(resolvePartialCommitValidationDiffMode({
      partialEntry: null,
      entry: createStatusEntry(),
    })).toBe("working");
  });

  it("日志动作失败但仓库已进入进行中状态时，应返回更适合 UI 的 warning 提示", () => {
    expect(resolveLogActionOperationFailureFeedback({
      action: "cherryPick",
      error: [
        "Auto-merging web/src/App.tsx",
        "CONFLICT (content): Merge conflict in web/src/App.tsx",
        "error: could not apply e612c53... feat(worktree): 删除对话框支持按目标分支重置",
      ].join("\n"),
      data: {
        shouldRefresh: true,
        operationState: "grafting",
      },
    })).toEqual({
      shouldRefresh: true,
      operationState: "grafting",
      message: "优选发生冲突，仓库已进入 优选 状态，可继续或中止",
    });

    expect(resolveLogActionOperationFailureFeedback({
      action: "revert",
      error: "error: revert is not possible because you have unmerged files",
      data: {
        shouldRefresh: true,
        operationState: "reverting",
      },
    })).toEqual({
      shouldRefresh: true,
      operationState: "reverting",
      message: "还原提交未自动完成，仓库已进入 还原 状态，可继续或中止",
    });

    expect(resolveLogActionOperationFailureFeedback({
      action: "cherryPick",
      error: "fatal: bad revision",
      data: {
        shouldRefresh: false,
        operationState: "normal",
      },
    })).toBeNull();
  });

  it("continue/abort 失败但仓库仍处于进行中状态时，应返回更适合 UI 的 warning 提示", () => {
    expect(resolveOperationControlFailureFeedback({
      control: "continue",
      error: [
        "Auto-merging sequence.txt",
        "CONFLICT (content): Merge conflict in sequence.txt",
        "error: could not apply 1b675583de... 处理",
      ].join("\n"),
      data: {
        shouldRefresh: true,
        operationState: "grafting",
      },
    })).toEqual({
      shouldRefresh: true,
      operationState: "grafting",
      message: "继续 优选 时再次发生冲突，仓库仍处于进行中状态",
    });

    expect(resolveOperationControlFailureFeedback({
      control: "abort",
      error: "fatal: revert --abort failed",
      data: {
        shouldRefresh: true,
        operationState: "reverting",
      },
    })).toEqual({
      shouldRefresh: true,
      operationState: "reverting",
      message: "还原 尚未中止，仓库仍处于进行中状态",
    });

    expect(resolveOperationControlFailureFeedback({
      control: "continue",
      error: "fatal: bad revision",
      data: {
        shouldRefresh: false,
        operationState: "normal",
      },
    })).toBeNull();
  });

  it("merge-conflict 问题应优先投影为 resolver 打开请求", () => {
    expect(resolveOperationProblemConflictResolverRequest({
      problem: {
        operation: "cherry-pick",
        kind: "merge-conflict",
        title: "Cherry-pick 过程中出现冲突",
        description: "请先解决冲突。",
        files: ["src/conflict.ts"],
        source: "smart-operation",
        repoRoot: "G:/Repo",
        actions: [],
      },
      workspaceRepoRoot: "G:/Repo",
      entries: [
        {
          path: "src/conflict.ts",
          conflictState: "conflict",
          repositoryRoot: "G:/Repo",
        },
        {
          path: "src/resolved.ts",
          conflictState: "resolved",
          repositoryRoot: "G:/Repo",
        },
      ],
    })).toEqual({
      title: "Cherry-pick 过程中出现冲突",
      description: "请先解决冲突。",
      scopeRepoRoot: undefined,
      focusPath: "src/conflict.ts",
      checkedPaths: ["src/conflict.ts"],
    });

    expect(resolveOperationProblemConflictResolverRequest({
      problem: {
        operation: "merge",
        kind: "merge-conflict",
        title: "Merge 过程中出现冲突",
        description: "请先解决冲突。",
        files: [],
        source: "merge-failure",
        repoRoot: "G:/Repo/packages/lib",
        actions: [],
      },
      workspaceRepoRoot: "G:/Repo",
      entries: [{
        path: "src/lib.ts",
        conflictState: "conflict",
        repositoryRoot: "G:/Repo/packages/lib",
      }],
    })).toEqual({
      title: "Merge 过程中出现冲突",
      description: "请先解决冲突。",
      scopeRepoRoot: "packages/lib",
      focusPath: "src/lib.ts",
      checkedPaths: [],
    });

    expect(resolveOperationProblemConflictResolverRequest({
      problem: {
        operation: "cherry-pick",
        kind: "merge-conflict",
        title: "Cherry-pick 过程中出现冲突",
        description: "请先解决冲突。",
        files: ["src/conflict.ts"],
        source: "smart-operation",
        repoRoot: "G:/Elsewhere",
        actions: [],
      },
      workspaceRepoRoot: "G:/Repo",
      entries: [{
        path: "src/conflict.ts",
        conflictState: "conflict",
        repositoryRoot: "G:/Elsewhere",
      }],
    })).toBeNull();
  });

  it("Cherry-pick 只要无未解决冲突且存在建议提交消息，就应进入提交收尾阶段", () => {
    expect(shouldFinalizeCherryPickByCommit({
      status: {
        operationState: "grafting",
        operationSuggestedCommitMessage: "picked commit message",
      },
      unresolvedConflictCount: 0,
      hasChanges: true,
    })).toBe(true);

    expect(shouldFinalizeCherryPickByCommit({
      status: {
        operationState: "grafting",
        operationSuggestedCommitMessage: "",
      },
      unresolvedConflictCount: 0,
      hasChanges: true,
    })).toBe(false);

    expect(shouldFinalizeCherryPickByCommit({
      status: {
        operationState: "grafting",
        operationSuggestedCommitMessage: "picked commit message",
      },
      unresolvedConflictCount: 1,
      hasChanges: true,
    })).toBe(false);

    expect(shouldFinalizeCherryPickByCommit({
      status: {
        operationState: "grafting",
        operationSuggestedCommitMessage: "picked commit message",
      },
      unresolvedConflictCount: 0,
      hasChanges: false,
    })).toBe(false);
  });

  it("Cherry-pick 多选提交应按旧到新执行，其余日志动作保持 UI 顺序", () => {
    expect(resolveLogActionExecutionHashes({
      action: "cherryPick",
      hashesNewestFirst: ["newest", "middle", "oldest"],
    })).toEqual(["oldest", "middle", "newest"]);

    expect(resolveLogActionExecutionHashes({
      action: "revert",
      hashesNewestFirst: ["newest", "middle", "oldest"],
    })).toEqual(["newest", "middle", "oldest"]);
  });

  it("Git 控制台复制文本应包含头信息、命令与输出", () => {
    const text = buildGitConsoleCopyText([
      createConsoleEntry(),
      createConsoleEntry({
        id: 2,
        ok: false,
        exitCode: 1,
        durationMs: 25,
        command: "git diff --name-only",
        stdout: "",
        stderr: "fatal: bad revision",
      }),
    ]);
    expect(text).toContain("[2026-03-11T06:00:00.000Z] OK 12ms G:/Repo");
    expect(text).toContain("exitCode: 0");
    expect(text).toContain("$ git status --short");
    expect(text).toContain("M src/app.ts");
    expect(text).toContain("FAIL 25ms");
    expect(text).toContain("exitCode: 1");
    expect(text).toContain("fatal: bad revision");
  });
});
