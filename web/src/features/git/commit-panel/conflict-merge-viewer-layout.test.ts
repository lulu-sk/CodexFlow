import { describe, expect, it } from "vitest";
import type { ConflictMergeBlock } from "./conflict-merge-model";
import {
  buildConflictMergeViewerFoldingPlan,
  buildConflictMergeViewerScrollMaps,
  countConflictMergeViewerLogicalLines,
  transferConflictMergeViewerLine,
} from "./conflict-merge-viewer-layout";

/**
 * 构造最小 block 测试桩，仅覆写当前断言关心的三方行坐标。
 */
function createLayoutBlock(args: {
  index?: number;
  oursStart: number;
  oursEnd: number;
  resultStart: number;
  resultEnd: number;
  theirsStart: number;
  theirsEnd: number;
}): ConflictMergeBlock {
  return {
    index: args.index || 0,
    kind: "change",
    conflictType: "MODIFIED",
    resolutionStrategy: "DEFAULT",
    semanticResolverId: null,
    semanticResolvedText: null,
    isImportChange: false,
    summary: "block",
    hasBase: true,
    baseText: "",
    oursText: "",
    theirsText: "",
    resultText: "",
    changedInOurs: true,
    changedInTheirs: true,
    resolvedOurs: false,
    resolvedTheirs: false,
    resolved: false,
    modified: false,
    onesideApplied: false,
    baseRange: null,
    oursRange: null,
    theirsRange: null,
    resultRange: null,
    baseStart: args.resultStart,
    baseEnd: args.resultEnd,
    oursStart: args.oursStart,
    oursEnd: args.oursEnd,
    theirsStart: args.theirsStart,
    theirsEnd: args.theirsEnd,
    resultStart: args.resultStart,
    resultEnd: args.resultEnd,
  };
}

describe("conflict-merge-viewer-layout", () => {
  it("应按 merge model 的逻辑行口径统计文本行数", () => {
    expect(countConflictMergeViewerLogicalLines("alpha\nbeta\n")).toBe(2);
    expect(countConflictMergeViewerLogicalLines("alpha\nbeta")).toBe(2);
    expect(countConflictMergeViewerLogicalLines("")).toBe(1);
  });

  it("应按三方块边界映射折叠后的滚动位置，而不是复制同一个 scrollTop", () => {
    const block = createLayoutBlock({
      oursStart: 4,
      oursEnd: 4,
      resultStart: 10,
      resultEnd: 12,
      theirsStart: 4,
      theirsEnd: 4,
    });
    const scrollMaps = buildConflictMergeViewerScrollMaps({
      blocks: [block],
      lineCounts: {
        left: 20,
        result: 28,
        right: 20,
      },
    });

    expect(transferConflictMergeViewerLine(8, scrollMaps.leftToResult)).toBe(16);
    expect(transferConflictMergeViewerLine(16, scrollMaps.resultToLeft)).toBe(8);
    expect(transferConflictMergeViewerLine(16, scrollMaps.resultToRight)).toBe(8);
  });

  it("应为 collapsed unchanged group 保留跨栏错位的隐藏区间与分隔线锚点", () => {
    const block = createLayoutBlock({
      oursStart: 4,
      oursEnd: 4,
      resultStart: 10,
      resultEnd: 12,
      theirsStart: 4,
      theirsEnd: 4,
    });
    const foldingPlan = buildConflictMergeViewerFoldingPlan({
      blocks: [block],
      lineCounts: {
        left: 20,
        result: 28,
        right: 20,
      },
      contextRange: 4,
    });

    expect(foldingPlan.hiddenAreas.left).toEqual([{ startLine: 9, endLine: 20 }]);
    expect(foldingPlan.hiddenAreas.result).toEqual([
      { startLine: 1, endLine: 6 },
      { startLine: 17, endLine: 28 },
    ]);
    expect(foldingPlan.hiddenAreas.right).toEqual([{ startLine: 9, endLine: 20 }]);
    expect(foldingPlan.separators).toEqual([
      { side: "left", sourceLine: 9, targetLine: 17 },
      { side: "right", sourceLine: 17, targetLine: 9 },
    ]);
  });
});
