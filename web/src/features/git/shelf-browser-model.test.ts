import { describe, expect, it } from "vitest";
import {
  buildShelfBrowserRows,
  formatShelfBrowserDirectorySummary,
  normalizeShelfBrowserGroupingKeys,
} from "./shelf-browser-model";
import type { GitShelfItem } from "./types";

/**
 * 创建最小化的 shelf 条目夹具，便于聚焦验证 browser 树模型而不是无关业务字段。
 */
function createShelfItem(input: Partial<GitShelfItem> & Pick<GitShelfItem, "ref" | "createdAt" | "paths">): GitShelfItem {
  return {
    ref: input.ref,
    repoRoot: input.repoRoot || "/repo",
    repoRoots: input.repoRoots || ["/repo"],
    message: input.message || input.ref,
    createdAt: input.createdAt,
    source: input.source || "manual",
    saveChangesPolicy: "shelve",
    state: input.state || "saved",
    displayName: input.displayName || input.message || input.ref,
    hasIndexPatch: input.hasIndexPatch === true,
    hasWorktreePatch: input.hasWorktreePatch !== false,
    hasUntrackedFiles: input.hasUntrackedFiles === true,
    paths: input.paths,
    originalChangeListName: input.originalChangeListName,
    lastError: input.lastError,
  };
}

describe("shelf-browser-model", () => {
  it("分组 key 归一化后应仅保留唯一的 directory", () => {
    expect(normalizeShelfBrowserGroupingKeys(["directory", "directory"])).toEqual(["directory"]);
  });

  it("默认应输出活动 shelf 与最近删除标签，并隐藏回收区条目", () => {
    const rows = buildShelfBrowserRows({
      items: [
        createShelfItem({
          ref: "shelf@{active}",
          createdAt: "2026-03-26T10:00:00.000Z",
          paths: ["src/keep.ts"],
        }),
        createShelfItem({
          ref: "shelf@{recycled}",
          createdAt: "2026-03-26T10:01:00.000Z",
          state: "recycled",
          paths: ["src/recycled.ts"],
        }),
        createShelfItem({
          ref: "shelf@{deleted}",
          createdAt: "2026-03-26T10:02:00.000Z",
          state: "deleted",
          paths: ["src/deleted.ts"],
        }),
      ],
      showRecycled: false,
    });

    expect(rows.some((row) => row.kind === "tag" && row.label === "最近删除")).toBe(true);
    expect(rows.some((row) => row.kind === "shelf" && row.shelf.ref === "shelf@{recycled}")).toBe(false);
    expect(rows.find((row) => row.kind === "shelf" && row.shelf.ref === "shelf@{deleted}")?.depth).toBe(1);
  });

  it("扁平模式应按 IDEA 风格优先按文件名排序", () => {
    const rows = buildShelfBrowserRows({
      items: [
        createShelfItem({
          ref: "shelf@{sort}",
          createdAt: "2026-03-26T10:03:00.000Z",
          paths: ["web/src/zeta.ts", "docs/beta.ts", "web/src/alpha.ts"],
        }),
      ],
      showRecycled: false,
      groupingKeys: [],
    });

    expect(rows.filter((row) => row.kind === "file").map((row) => row.path)).toEqual([
      "web/src/alpha.ts",
      "docs/beta.ts",
      "web/src/zeta.ts",
    ]);
  });

  it("目录分组开启后应输出目录行，并复用提交树摘要格式", () => {
    const rows = buildShelfBrowserRows({
      items: [
        createShelfItem({
          ref: "shelf@{directory}",
          createdAt: "2026-03-26T10:04:00.000Z",
          paths: ["src/a.ts", "src/nested/b.ts"],
        }),
      ],
      showRecycled: false,
      groupingKeys: ["directory"],
    });

    const directoryRow = rows.find((row) => row.kind === "directory");
    expect(directoryRow).toEqual(expect.objectContaining({
      kind: "directory",
      label: "src",
      depth: 1,
    }));
    expect(directoryRow && formatShelfBrowserDirectorySummary(directoryRow)).toBe("1 个目录，2 个文件");
  });
});
