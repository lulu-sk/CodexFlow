import { describe, expect, it } from "vitest";
import type { GitBranchPopupRepository } from "../types";
import {
  buildBranchCompareDialogConfig,
  buildBranchCompareRevision,
  collectBranchCompareRefOptions,
  formatBranchCompareLabel,
  resolveDefaultBranchCompareRef,
} from "./compare-model";

/**
 * 构造最小仓库快照夹具，便于覆盖分支比较模型的候选项与默认值分支逻辑。
 */
function createRepository(): GitBranchPopupRepository {
  return {
    repoRoot: "/repo",
    rootName: "repo",
    kind: "repository",
    currentBranch: "main",
    detached: false,
    syncEnabled: true,
    remotes: [],
    groups: {
      favorites: [],
      recent: [],
      local: [
        { name: "main", current: true, secondaryText: "origin/main" },
        { name: "feature/a" },
      ],
      remote: [
        { name: "origin/main" },
        { name: "origin/release" },
      ],
    },
  };
}

describe("branch compare model", () => {
  it("应优先输出本地分支，并为当前分支补齐说明文案", () => {
    const options = collectBranchCompareRefOptions(createRepository());

    expect(options.map((option) => option.value)).toEqual([
      "main",
      "feature/a",
      "origin/main",
      "origin/release",
    ]);
    expect(options[0]).toEqual(expect.objectContaining({
      value: "main",
      description: "当前分支 · origin/main",
      section: "local",
    }));
  });

  it("默认比较对象应优先回落到当前分支，若目标就是当前分支则选择第一个其他候选项", () => {
    const repository = createRepository();

    expect(resolveDefaultBranchCompareRef({ repository, targetRef: "feature/a" })).toBe("main");
    expect(resolveDefaultBranchCompareRef({ repository, targetRef: "main" })).toBe("feature/a");
  });

  it("应构造任意两分支比较对话框，并过滤掉当前目标本身", () => {
    const config = buildBranchCompareDialogConfig({
      repository: createRepository(),
      targetRef: "feature/a",
      mode: "files",
    });

    expect(config?.confirmText).toBe("查看文件差异");
    expect(config?.fields[0]?.options?.some((option) => option.value === "feature/a")).toBe(false);
    expect(config?.fields[0]?.options?.find((option) => option.value === "origin/release")).toEqual(
      expect.objectContaining({
        badge: "远端",
      }),
    );
    expect(config?.defaults).toEqual({ otherRef: "main" });
  });

  it("应统一输出 range 与比较标题文案", () => {
    expect(buildBranchCompareRevision("feature/a", "main")).toBe("feature/a...main");
    expect(formatBranchCompareLabel("feature/a", "origin/main")).toBe("feature/a ↔ origin/main");
    expect(formatBranchCompareLabel("origin/main")).toBe("origin/main ↔ Working Tree");
  });
});
