import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { buildUpdateSessionResultViewState, buildUpdateSessionViewState, isUpdateSessionProgressSettled } from "./session-store";
import zhGit from "../../../locales/zh/git.json";

/**
 * 为 Git 相关测试初始化最小 i18n 运行时，确保默认值插值与实际界面保持一致。
 */
async function ensureGitI18nReady(): Promise<void> {
  if (i18next.isInitialized) {
    i18next.addResourceBundle("zh-CN", "git", zhGit, true, true);
    await i18next.changeLanguage("zh-CN");
    return;
  }

  await i18next.use(initReactI18next).init({
    lng: "zh-CN",
    fallbackLng: "zh-CN",
    interpolation: {
      escapeValue: false,
    },
    resources: {
      "zh-CN": {
        git: zhGit,
      },
    },
  });
}

/**
 * 构造最小运行中快照，供会话视图排序与标签断言复用。
 */
function createRunningSnapshot() {
  return {
    requestedRepoRoot: "/repo",
    currentPhase: "root-update" as const,
    activeRepoRoot: "/repo/packages/a",
    activeRootName: "a",
    activePhase: "root-update" as const,
    cancelled: false,
    totalRoots: 2,
    completedRoots: 1,
    runningRoots: 1,
    remainingRoots: 1,
    multiRoot: true,
    roots: [
      {
        repoRoot: "/repo",
        rootName: "root",
        kind: "repository" as const,
        currentPhase: "fetch" as const,
        resultCode: "SUCCESS" as const,
      },
      {
        repoRoot: "/repo/packages/a",
        rootName: "a",
        kind: "repository" as const,
        currentPhase: "root-update" as const,
        fetchResult: {
          status: "success" as const,
          strategy: "tracked-remote" as const,
          remotes: ["origin"],
          fetchedRemotes: ["origin"],
          failedRemotes: [],
        },
        preservingState: {
          saveChangesPolicy: "shelve" as const,
          status: "kept-saved" as const,
          localChangesRestorePolicy: "keep-saved" as const,
          savedLocalChangesDisplayName: "搁置记录 #1",
          savedChangesAction: {
            kind: "open-saved-changes" as const,
            label: "查看搁置记录",
            repoRoot: "/repo/packages/a",
            payload: {
              repoRoot: "/repo/packages/a",
              saveChangesPolicy: "shelve" as const,
              viewKind: "shelf",
            },
          },
        },
      },
    ],
  };
}

beforeAll(async () => {
  await ensureGitI18nReady();
});

describe("update session store", () => {
  it("运行中会话应优先展示活动 root，并补齐阶段标签", () => {
    const viewState = buildUpdateSessionViewState(createRunningSnapshot());
    expect(viewState).not.toBeNull();
    expect(viewState?.activeRootName).toBe("a");
    expect(viewState?.activePhaseLabel).toBe("执行更新");
    expect(viewState?.roots[0]?.rootName).toBe("a");
    expect(viewState?.roots[0]?.summaryLabel).toContain("获取");
    expect(viewState?.roots[0]?.badges).toContain("获取完成");
    expect(viewState?.roots[0]?.badges).toContain("保留已保存");
    expect(viewState?.roots[1]?.resultLabel).toBe("成功");
  });

  it("已完成所有 root 且无剩余任务时应视为可关闭进度", () => {
    const runningViewState = buildUpdateSessionViewState(createRunningSnapshot());
    const settledViewState = buildUpdateSessionViewState({
      requestedRepoRoot: "/repo",
      currentPhase: "result-aggregation",
      activeRepoRoot: "",
      activeRootName: "",
      activePhase: "result-aggregation",
      cancelled: false,
      totalRoots: 1,
      completedRoots: 1,
      runningRoots: 0,
      remainingRoots: 0,
      multiRoot: false,
      roots: [
        {
          repoRoot: "/repo",
          rootName: "root",
          kind: "repository" as const,
          currentPhase: "result-aggregation" as const,
          resultCode: "NOTHING_TO_UPDATE" as const,
        },
      ],
    });

    expect(isUpdateSessionProgressSettled(runningViewState)).toBe(false);
    expect(isUpdateSessionProgressSettled(settledViewState)).toBe(true);
  });

  it("完成态结果应提取多范围摘要、root 详情与 skipped 摘要，供结果卡片与查看提交入口复用", () => {
    const resultView = buildUpdateSessionResultViewState(
      {
        title: "2 个文件已更新",
        description: "已同步远端提交",
        updatedFilesCount: 3,
        receivedCommitsCount: 2,
        filteredCommitsCount: 2,
        ranges: [
          {
            repoRoot: "/repo",
            rootName: "root",
            range: {
              start: "11111111aaaaaaaa",
              end: "22222222bbbbbbbb",
            },
            commitCount: 1,
            fileCount: 2,
          },
          {
            repoRoot: "/repo/packages/lib",
            rootName: "lib-repo",
            range: {
              start: "33333333aaaaaaaa",
              end: "44444444bbbbbbbb",
            },
            commitCount: 1,
            fileCount: 1,
          },
        ],
        primaryRange: {
          repoRoot: "/repo",
          rootName: "root",
          range: {
            start: "11111111aaaaaaaa",
            end: "22222222bbbbbbbb",
          },
          commitCount: 1,
          fileCount: 2,
        },
        skippedRoots: [
          {
            repoRoot: "/repo/modules/lib",
            rootName: "lib",
            kind: "submodule" as const,
            reasonCode: "updated-by-parent" as const,
            reason: "由父仓递归更新",
          },
        ],
        postActions: [
          { kind: "view-commits", label: "查看提交" },
          { kind: "copy-revision-range", label: "复制提交范围", revision: "11111111aaaaaaaa..22222222bbbbbbbb" },
        ],
      },
      {
        roots: [
          {
            repoRoot: "/repo",
            rootName: "root",
            kind: "repository",
            resultCode: "SUCCESS",
            method: "rebase",
            updatedRange: {
              start: "11111111aaaaaaaa",
              end: "22222222bbbbbbbb",
            },
          },
          {
            repoRoot: "/repo/modules/lib",
            rootName: "lib",
            kind: "submodule",
            resultCode: "SKIPPED",
            skippedReason: "由父仓递归更新",
            submoduleUpdate: {
              mode: "detached",
              strategy: "updated-by-parent",
              recursive: true,
              detachedHead: true,
              parentRepoRoot: "/repo",
            },
          },
        ],
      },
    );
    expect(resultView).not.toBeNull();
    expect(resultView?.rangeText).toContain("2 个更新范围");
    expect(resultView?.roots[0]?.detail).toContain("变基");
    expect(resultView?.roots[1]?.resultLabel).toBe("已跳过");
    expect(resultView?.roots[1]?.detailLines[0]).toContain("由父仓递归更新");
    expect(resultView?.roots[1]?.badges).toContain("游离 HEAD 子模块");
    expect(resultView?.skippedSummary).toContain("lib（由父仓递归更新）");
  });

  it("完成态结果应为失败仓、冲突仓、保留改动仓与 detached 子模块生成直接动作链", () => {
    const resultView = buildUpdateSessionResultViewState(null, {
      roots: [
        {
          repoRoot: "/repo",
          rootName: "root",
          kind: "repository",
          resultCode: "INCOMPLETE",
          unfinishedState: {
            code: "merge-conflicts",
            stage: "update",
            localChangesRestorePolicy: "restore",
            message: "仍有未解决冲突",
          },
        },
        {
          repoRoot: "/repo/packages/lib",
          rootName: "lib",
          kind: "repository",
          resultCode: "ERROR",
          fetchResult: {
            status: "failed",
            strategy: "tracked-remote",
            remotes: ["origin"],
            fetchedRemotes: [],
            failedRemotes: [{ remote: "origin", error: "network" }],
          },
          preservingState: {
            saveChangesPolicy: "stash",
            status: "kept-saved",
            localChangesRestorePolicy: "keep-saved",
            savedLocalChangesRef: "stash@{0}",
            savedChangesAction: {
              kind: "open-saved-changes",
              label: "查看暂存列表",
              repoRoot: "/repo/packages/lib",
              payload: {
                repoRoot: "/repo/packages/lib",
                ref: "stash@{0}",
                saveChangesPolicy: "stash",
                viewKind: "stash",
              },
            },
          },
        },
        {
          repoRoot: "/repo/modules/sub",
          rootName: "sub",
          kind: "submodule",
          resultCode: "SKIPPED",
          skippedReasonCode: "updated-by-parent",
          skippedReason: "由父仓递归更新",
          submoduleUpdate: {
            mode: "detached",
            strategy: "updated-by-parent",
            recursive: true,
            detachedHead: true,
            parentRepoRoot: "/repo",
          },
        },
      ],
    });

    expect(resultView?.roots[0]?.actions.map((action) => action.kind)).toContain("resolve-conflicts");
    expect(resultView?.roots[0]?.actions.find((action) => action.kind === "resolve-conflicts")?.label).toBe("处理该仓冲突");
    expect(resultView?.roots[1]?.actions.map((action) => action.kind)).toEqual(["retry-update-root", "open-saved-changes"]);
    expect(resultView?.roots[2]?.actions.map((action) => action.kind)).toEqual(["open-parent-repo"]);
    expect(resultView?.postActions.map((action) => action.kind)).toEqual(["resolve-conflicts", "retry-update-root"]);
  });
});
