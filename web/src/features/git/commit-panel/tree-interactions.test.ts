import { describe, expect, it } from "vitest";
import {
  buildCommitTreeCopyText,
  findCommitSpeedSearchMatch,
  findCommitSpeedSearchRanges,
  navigateCommitTreeRows,
} from "./tree-interactions";
import type { CommitPanelRenderRow } from "./types";

const rows: CommitPanelRenderRow[] = [
  {
    key: "group:default",
    kind: "group",
    group: { key: "cl:default", label: "默认", entries: [], kind: "changelist", treeNodes: [], treeRows: [] } as any,
    textPresentation: "默认",
  },
  {
    key: "node:dir",
    kind: "node",
    group: { key: "cl:default", label: "默认", entries: [], kind: "changelist", treeNodes: [], treeRows: [] } as any,
    node: { key: "dir", name: "src", fullPath: "src", isFile: false, count: 1, filePaths: ["src/a.ts"], kind: "directory", children: [] } as any,
    depth: 0,
    textPresentation: "src",
  },
  {
    key: "node:file",
    kind: "node",
    group: { key: "cl:default", label: "默认", entries: [], kind: "changelist", treeNodes: [], treeRows: [] } as any,
    node: { key: "file", name: "a.ts", fullPath: "src/a.ts", isFile: true, count: 1, filePaths: ["src/a.ts"], kind: "file", children: [] } as any,
    depth: 1,
    textPresentation: "a.ts",
  },
];

describe("commit tree interactions", () => {
  it("speed search 应按统一 text presentation 命中树行", () => {
    expect(findCommitSpeedSearchMatch({
      rows,
      query: "a.ts",
      currentRowKey: "group:default",
    })).toBe("node:file");
  });

  it("speed search 应支持向前查找，供 Shift+F3 复用", () => {
    expect(findCommitSpeedSearchMatch({
      rows,
      query: "s",
      currentRowKey: "node:file",
      direction: "previous",
    })).toBe("node:dir");
  });

  it("speed search 应支持 IDEA 风格的宽松字符序列匹配", () => {
    expect(findCommitSpeedSearchRanges({
      text: "Font_cjkFonts_Medium_FontAssets.asset",
      query: "fc",
    })).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ]);
  });

  it("copy provider 应按屏幕顺序输出选中文本", () => {
    expect(buildCommitTreeCopyText({
      rows,
      selectedRowKeys: ["node:file", "group:default"],
    })).toBe("默认\na.ts");
  });

  it("ArrowRight 在未展开目录上应先返回 toggle node 结果", () => {
    expect(navigateCommitTreeRows({
      rows,
      currentRowKey: "node:dir",
      key: "ArrowRight",
      isExpanded: () => false,
      findParentRowKey: () => "group:default",
    })).toEqual({
      focusRowKey: "node:dir",
      toggleNodeKey: "dir",
    });
  });

  it("group 行左右键应优先处理展开/收起，而不是跳过 changelist 头部", () => {
    expect(navigateCommitTreeRows({
      rows,
      currentRowKey: "group:default",
      key: "ArrowRight",
      isExpanded: () => false,
      findParentRowKey: () => "group:default",
    })).toEqual({
      focusRowKey: "group:default",
      toggleGroupKey: "cl:default",
    });
  });
});
