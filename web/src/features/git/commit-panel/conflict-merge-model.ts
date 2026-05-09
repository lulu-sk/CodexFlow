// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// 三方冲突视图状态模型参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 React/TypeScript 架构重写。

import { resolveConflictMergeSemanticBlocks } from "../../../../../electron/git/commitPanel/conflictMergeSemantic";
import { tryResolveConflictMergeText } from "../../../../../electron/git/commitPanel/conflictMergeTextResolve";
import type {
  GitConflictMergeImportMetadata,
  GitConflictMergeResolutionStrategy,
  GitConflictMergeSnapshot,
} from "../types";

export type ConflictMergeBlockResolution = "base" | "ours" | "theirs" | "both";

export type ConflictMergeAutoResolution = ConflictMergeBlockResolution | "auto";

export type ConflictMergeLineRange = {
  startLine: number;
  endLine: number;
  anchorLine: number;
  empty?: boolean;
};

export type ConflictMergeBlockKind = "change" | "conflict";

export type ConflictMergeBlock = {
  index: number;
  kind: ConflictMergeBlockKind;
  conflictType: "INSERTED" | "DELETED" | "MODIFIED" | "CONFLICT";
  resolutionStrategy: GitConflictMergeResolutionStrategy;
  semanticResolverId: string | null;
  semanticResolvedText: string | null;
  isImportChange: boolean;
  summary: string;
  hasBase: boolean;
  baseText: string;
  oursText: string;
  theirsText: string;
  resultText: string;
  changedInOurs: boolean;
  changedInTheirs: boolean;
  resolvedOurs: boolean;
  resolvedTheirs: boolean;
  resolved: boolean;
  modified: boolean;
  onesideApplied: boolean;
  baseRange: ConflictMergeLineRange | null;
  oursRange: ConflictMergeLineRange | null;
  theirsRange: ConflictMergeLineRange | null;
  resultRange: ConflictMergeLineRange | null;
  baseStart: number;
  baseEnd: number;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
  resultStart: number;
  resultEnd: number;
};

export type ConflictMergeApplyNonConflictsTarget = "ours" | "all" | "theirs";

export type ConflictMergeViewerState = {
  path: string;
  lineEnding: string;
  baseTokens: string[];
  oursTokens: string[];
  theirsTokens: string[];
  resultTokens: string[];
  initialResultTokens: string[];
  resultText: string;
  initialResultText: string;
  importMetadata: GitConflictMergeImportMetadata | null;
  resultImportRange: { start: number; end: number } | null;
  blocks: ConflictMergeBlock[];
};

type ConflictMergeDiffOperation = {
  type: "equal" | "delete" | "insert";
};

type ConflictMergeSemanticHydration = {
  resolverId: string | null;
  textByBlockIndex: Map<number, string>;
};

type ConflictMergeDiffSegment = {
  baseStart: number;
  baseEnd: number;
  targetStart: number;
  targetEnd: number;
  changed: boolean;
};

type ConflictMergeUnchangedRange = {
  baseStart: number;
  baseEnd: number;
  targetStart: number;
  targetEnd: number;
};

type ConflictMergeMergeRange = {
  oursStart: number;
  oursEnd: number;
  baseStart: number;
  baseEnd: number;
  theirsStart: number;
  theirsEnd: number;
};

const CONFLICT_MERGE_DIFF_MATRIX_CELL_LIMIT = 4_000_000;

/**
 * 将文本拆成逐行 token；每个 token 保留原始换行，便于后续按行替换后直接拼回文本。
 */
function splitConflictMergeTokens(text: string): string[] {
  return String(text || "").match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * 把逐行 token 重新拼回完整文本，统一复用到结果区与块内容提取。
 */
function joinConflictMergeTokens(tokens: string[]): string {
  return tokens.join("");
}

/**
 * 按当前目标换行风格输出结果文本，避免内部统一用 LF 比较后把原文件 CRLF 破坏掉。
 */
function serializeConflictMergeTokens(tokens: string[], lineEnding: string): string {
  const normalizedText = joinConflictMergeTokens(tokens);
  return lineEnding === "\n"
    ? normalizedText
    : normalizedText.replace(/\n/g, lineEnding);
}

/**
 * 推断当前快照的主换行风格，后续结果区手工编辑回写时优先沿用该风格。
 */
function resolveConflictMergeLineEnding(snapshot: GitConflictMergeSnapshot): string {
  const candidates = [
    snapshot.working.text,
    snapshot.base.text,
    snapshot.ours.text,
    snapshot.theirs.text,
  ];
  return candidates.some((text) => String(text || "").includes("\r\n")) ? "\r\n" : "\n";
}

/**
 * 将文本按统一换行风格标准化，避免 CRLF/LF 混用导致 diff 与自动解决判定漂移。
 */
function normalizeConflictMergeText(text: string): string {
  return String(text || "").replace(/\r\n/g, "\n");
}

/**
 * 判断两段文本在标准化换行后是否等价，供冲突类型与自动解决逻辑共用。
 */
function isConflictMergeTextEquivalent(left: string, right: string): boolean {
  return normalizeConflictMergeText(left) === normalizeConflictMergeText(right);
}

/**
 * 从三方文本中提炼块摘要，优先展示第一条非空有效内容，便于右侧列表快速辨识。
 */
function resolveConflictMergeBlockSummary(args: {
  index: number;
  oursText: string;
  theirsText: string;
  baseText: string;
}): string {
  const candidates = [
    ...String(args.oursText || "").split(/\r?\n/),
    ...String(args.theirsText || "").split(/\r?\n/),
    ...String(args.baseText || "").split(/\r?\n/),
  ];
  const hit = candidates.map((line) => String(line || "").trim()).find(Boolean);
  return hit || `更改块 ${args.index + 1}`;
}

/**
 * 在规模可控时使用 LCS 动态规划生成更稳定的逐行编辑脚本，减少删除/修改边界被错位吸附到相邻公共行的问题。
 */
function buildConflictMergeDynamicDiffOperations(baseTokens: string[], targetTokens: string[]): ConflictMergeDiffOperation[] {
  const baseLength = baseTokens.length;
  const targetLength = targetTokens.length;
  const table = Array.from({ length: baseLength + 1 }, () => new Uint32Array(targetLength + 1));

  for (let baseIndex = 1; baseIndex <= baseLength; baseIndex += 1) {
    for (let targetIndex = 1; targetIndex <= targetLength; targetIndex += 1) {
      table[baseIndex][targetIndex] = baseTokens[baseIndex - 1] === targetTokens[targetIndex - 1]
        ? table[baseIndex - 1][targetIndex - 1] + 1
        : Math.max(table[baseIndex - 1][targetIndex], table[baseIndex][targetIndex - 1]);
    }
  }

  const operations: ConflictMergeDiffOperation[] = [];
  let baseIndex = baseLength;
  let targetIndex = targetLength;

  while (baseIndex > 0 && targetIndex > 0) {
    if (baseTokens[baseIndex - 1] === targetTokens[targetIndex - 1]) {
      operations.push({ type: "equal" });
      baseIndex -= 1;
      targetIndex -= 1;
      continue;
    }
    if (table[baseIndex - 1][targetIndex] >= table[baseIndex][targetIndex - 1]) {
      operations.push({ type: "delete" });
      baseIndex -= 1;
      continue;
    }
    operations.push({ type: "insert" });
    targetIndex -= 1;
  }

  while (baseIndex > 0) {
    operations.push({ type: "delete" });
    baseIndex -= 1;
  }
  while (targetIndex > 0) {
    operations.push({ type: "insert" });
    targetIndex -= 1;
  }

  return operations.reverse();
}

/**
 * 通过 Myers 算法回溯生成最短编辑脚本，作为超大输入下的性能回退路径。
 */
function buildConflictMergeMyersDiffOperations(baseTokens: string[], targetTokens: string[]): ConflictMergeDiffOperation[] {
  const baseLength = baseTokens.length;
  const targetLength = targetTokens.length;
  const maxDepth = baseLength + targetLength;
  const offset = maxDepth;
  const vector = new Array<number>((maxDepth * 2) + 1).fill(0);
  const trace: number[][] = [];

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const previousVector = vector.slice();
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const index = offset + diagonal;
      const goDown = diagonal === -depth
        || (diagonal !== depth && previousVector[index - 1] < previousVector[index + 1]);
      let baseIndex = goDown ? previousVector[index + 1] : previousVector[index - 1] + 1;
      let targetIndex = baseIndex - diagonal;
      while (baseIndex < baseLength
        && targetIndex < targetLength
        && baseTokens[baseIndex] === targetTokens[targetIndex]) {
        baseIndex += 1;
        targetIndex += 1;
      }
      vector[index] = baseIndex;
      if (baseIndex >= baseLength && targetIndex >= targetLength) {
        trace.push(vector.slice());
        return buildConflictMergeMyersDiffOperationsFromTrace(trace, baseTokens, targetTokens);
      }
    }
    trace.push(vector.slice());
  }

  return [];
}

/**
 * 根据 Myers trace 回放出逐步操作序列，供后续压缩成 line segment 使用。
 */
function buildConflictMergeMyersDiffOperationsFromTrace(
  trace: number[][],
  baseTokens: string[],
  targetTokens: string[],
): ConflictMergeDiffOperation[] {
  const baseLength = baseTokens.length;
  const targetLength = targetTokens.length;
  const maxDepth = baseLength + targetLength;
  const offset = maxDepth;
  const operations: ConflictMergeDiffOperation[] = [];
  let baseIndex = baseLength;
  let targetIndex = targetLength;

  for (let depth = trace.length - 1; depth > 0; depth -= 1) {
    const vector = trace[depth - 1];
    const diagonal = baseIndex - targetIndex;
    const goDown = diagonal === -depth
      || (diagonal !== depth && vector[offset + diagonal - 1] < vector[offset + diagonal + 1]);
    const previousDiagonal = goDown ? diagonal + 1 : diagonal - 1;
    const previousBaseIndex = vector[offset + previousDiagonal];
    const previousTargetIndex = previousBaseIndex - previousDiagonal;

    while (baseIndex > previousBaseIndex && targetIndex > previousTargetIndex) {
      operations.push({ type: "equal" });
      baseIndex -= 1;
      targetIndex -= 1;
    }

    if (goDown) {
      operations.push({ type: "insert" });
      targetIndex -= 1;
    } else {
      operations.push({ type: "delete" });
      baseIndex -= 1;
    }
  }

  while (baseIndex > 0 && targetIndex > 0) {
    if (baseTokens[baseIndex - 1] !== targetTokens[targetIndex - 1]) break;
    operations.push({ type: "equal" });
    baseIndex -= 1;
    targetIndex -= 1;
  }
  while (baseIndex > 0) {
    operations.push({ type: "delete" });
    baseIndex -= 1;
  }
  while (targetIndex > 0) {
    operations.push({ type: "insert" });
    targetIndex -= 1;
  }

  return operations.reverse();
}

/**
 * 按公共前后缀裁剪后选择 diff 算法，在准确性与性能之间取一个更稳妥的折中。
 */
function buildConflictMergeDiffOperations(baseTokens: string[], targetTokens: string[]): ConflictMergeDiffOperation[] {
  let prefixLength = 0;
  while (prefixLength < baseTokens.length
    && prefixLength < targetTokens.length
    && baseTokens[prefixLength] === targetTokens[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (suffixLength < baseTokens.length - prefixLength
    && suffixLength < targetTokens.length - prefixLength
    && baseTokens[baseTokens.length - 1 - suffixLength] === targetTokens[targetTokens.length - 1 - suffixLength]) {
    suffixLength += 1;
  }

  const middleBaseTokens = baseTokens.slice(prefixLength, baseTokens.length - suffixLength);
  const middleTargetTokens = targetTokens.slice(prefixLength, targetTokens.length - suffixLength);
  const middleCellCount = middleBaseTokens.length * middleTargetTokens.length;
  const middleOperations = middleCellCount <= CONFLICT_MERGE_DIFF_MATRIX_CELL_LIMIT
    ? buildConflictMergeDynamicDiffOperations(middleBaseTokens, middleTargetTokens)
    : buildConflictMergeMyersDiffOperations(middleBaseTokens, middleTargetTokens);

  return [
    ...new Array<ConflictMergeDiffOperation>(prefixLength).fill({ type: "equal" }),
    ...middleOperations,
    ...new Array<ConflictMergeDiffOperation>(suffixLength).fill({ type: "equal" }),
  ];
}

/**
 * 将最短编辑脚本压缩为 base/target 坐标段，统一用于左右两侧的三方块构建。
 */
function buildConflictMergeDiffSegments(baseTokens: string[], targetTokens: string[]): ConflictMergeDiffSegment[] {
  const operations = buildConflictMergeDiffOperations(baseTokens, targetTokens);
  const segments: ConflictMergeDiffSegment[] = [];
  let baseIndex = 0;
  let targetIndex = 0;

  /**
   * 把当前累计片段写入段列表，并在同类型连续片段上做一次轻量合并。
   */
  const pushSegment = (segment: ConflictMergeDiffSegment): void => {
    const last = segments[segments.length - 1];
    if (last
      && last.changed === segment.changed
      && last.baseEnd === segment.baseStart
      && last.targetEnd === segment.targetStart) {
      last.baseEnd = segment.baseEnd;
      last.targetEnd = segment.targetEnd;
      return;
    }
    if (segment.baseStart === segment.baseEnd && segment.targetStart === segment.targetEnd) return;
    segments.push(segment);
  };

  let runType: ConflictMergeDiffOperation["type"] | null = null;
  let runBaseStart = 0;
  let runTargetStart = 0;

  /**
   * 结束当前操作 run，并将其映射到 changed/unchanged segment。
   */
  const flushRun = (): void => {
    if (!runType) return;
    pushSegment({
      baseStart: runBaseStart,
      baseEnd: baseIndex,
      targetStart: runTargetStart,
      targetEnd: targetIndex,
      changed: runType !== "equal",
    });
    runType = null;
  };

  for (const operation of operations) {
    if (runType !== operation.type) {
      flushRun();
      runType = operation.type;
      runBaseStart = baseIndex;
      runTargetStart = targetIndex;
    }
    if (operation.type === "equal" || operation.type === "delete") baseIndex += 1;
    if (operation.type === "equal" || operation.type === "insert") targetIndex += 1;
  }
  flushRun();

  if (segments.length <= 0) {
    segments.push({
      baseStart: 0,
      baseEnd: baseTokens.length,
      targetStart: 0,
      targetEnd: targetTokens.length,
      changed: false,
    });
  }

  return segments;
}

/**
 * 把旧结果列中的行下标投影到新结果列；若命中真实编辑段，则起点收敛到新段起点、终点收敛到新段终点。
 */
function mapConflictMergeResultIndex(args: {
  segments: ConflictMergeDiffSegment[];
  index: number;
  preferEnd: boolean;
}): number {
  for (const segment of args.segments) {
    if (args.index < segment.baseStart || args.index > segment.baseEnd) continue;
    if (!segment.changed) return segment.targetStart + (args.index - segment.baseStart);
    if (args.index <= segment.baseStart) return segment.targetStart;
    if (args.index >= segment.baseEnd) return segment.targetEnd;
    return args.preferEnd ? segment.targetEnd : segment.targetStart;
  }
  return args.index;
}

/**
 * 提取一侧 diff 中的 unchanged range，作为前端版 `FairMergeBuilder` 的输入。
 */
function buildConflictMergeUnchangedRanges(
  segments: ConflictMergeDiffSegment[],
): ConflictMergeUnchangedRange[] {
  return segments
    .filter((segment) => !segment.changed && segment.baseEnd > segment.baseStart)
    .map((segment) => ({
      baseStart: segment.baseStart,
      baseEnd: segment.baseEnd,
      targetStart: segment.targetStart,
      targetEnd: segment.targetEnd,
    }));
}

/**
 * 按 IDEA `ComparisonMergeUtil.buildSimple` 的 `FairMergeBuilder` 语义，把左右两侧相对 base 的 unchanged range 合成为三方 merge range。
 */
function buildConflictMergeRanges(args: {
  baseLength: number;
  oursLength: number;
  theirsLength: number;
  leftSegments: ConflictMergeDiffSegment[];
  rightSegments: ConflictMergeDiffSegment[];
}): ConflictMergeMergeRange[] {
  const leftRanges = buildConflictMergeUnchangedRanges(args.leftSegments);
  const rightRanges = buildConflictMergeUnchangedRanges(args.rightSegments);
  const ranges: ConflictMergeMergeRange[] = [];
  let oursIndex = 0;
  let baseIndex = 0;
  let theirsIndex = 0;
  let leftIndex = 0;
  let rightIndex = 0;

  /**
   * 把当前 equal 片段之前尚未消费的区间收口为一个 merge range；空区间会被自动跳过。
   */
  const pushChange = (
    startOurs: number,
    startBase: number,
    startTheirs: number,
    endOurs: number,
    endBase: number,
    endTheirs: number,
  ): void => {
    if (startOurs === endOurs && startBase === endBase && startTheirs === endTheirs) return;
    ranges.push({
      oursStart: startOurs,
      oursEnd: endOurs,
      baseStart: startBase,
      baseEnd: endBase,
      theirsStart: startTheirs,
      theirsEnd: endTheirs,
    });
  };

  /**
   * 在识别到三方公共 unchanged 重叠片段时，先把前一个 changed 区间输出，再推进三侧游标。
   */
  const markEqual = (
    startOurs: number,
    startBase: number,
    startTheirs: number,
    endOurs: number,
    endBase: number,
    endTheirs: number,
  ): void => {
    pushChange(oursIndex, baseIndex, theirsIndex, startOurs, startBase, startTheirs);
    oursIndex = endOurs;
    baseIndex = endBase;
    theirsIndex = endTheirs;
  };

  /**
   * 对齐一组左右 unchanged range；返回下一个应继续推进的侧别，与 IDEA `FairMergeBuilder.add` 保持同义。
   */
  const addEqualOverlap = (
    leftRange: ConflictMergeUnchangedRange,
    rightRange: ConflictMergeUnchangedRange,
  ): "left" | "right" => {
    if (leftRange.baseEnd <= rightRange.baseStart) return "left";
    if (rightRange.baseEnd <= leftRange.baseStart) return "right";

    const overlapBaseStart = Math.max(leftRange.baseStart, rightRange.baseStart);
    const overlapBaseEnd = Math.min(leftRange.baseEnd, rightRange.baseEnd);
    const overlapCount = overlapBaseEnd - overlapBaseStart;
    const overlapLeftShift = overlapBaseStart - leftRange.baseStart;
    const overlapRightShift = overlapBaseStart - rightRange.baseStart;
    const overlapOursStart = leftRange.targetStart + overlapLeftShift;
    const overlapTheirsStart = rightRange.targetStart + overlapRightShift;

    markEqual(
      overlapOursStart,
      overlapBaseStart,
      overlapTheirsStart,
      overlapOursStart + overlapCount,
      overlapBaseEnd,
      overlapTheirsStart + overlapCount,
    );

    return leftRange.baseEnd <= rightRange.baseEnd ? "left" : "right";
  };

  while (leftIndex < leftRanges.length && rightIndex < rightRanges.length) {
    const advanceSide = addEqualOverlap(leftRanges[leftIndex], rightRanges[rightIndex]);
    if (advanceSide === "left") leftIndex += 1;
    else rightIndex += 1;
  }

  pushChange(oursIndex, baseIndex, theirsIndex, args.oursLength, args.baseLength, args.theirsLength);
  return ranges;
}

/**
 * 把 token 下标范围转换成 Monaco 友好的 1-based 行范围；空范围保留 anchorLine 以便放置 gutter 控件。
 */
function buildConflictMergeLineRange(
  start: number,
  end: number,
  totalLineCount: number,
): ConflictMergeLineRange | null {
  const normalizedStart = Math.max(0, Math.floor(Number(start) || 0));
  const normalizedEnd = Math.max(normalizedStart, Math.floor(Number(end) || 0));
  if (totalLineCount <= 0 && normalizedStart === 0 && normalizedEnd === 0) {
    return {
      startLine: 1,
      endLine: 1,
      anchorLine: 1,
      empty: true,
    };
  }
  if (normalizedStart === normalizedEnd) {
    const anchorLine = Math.max(1, Math.min(Math.max(1, totalLineCount), normalizedStart + 1));
    return {
      startLine: anchorLine,
      endLine: anchorLine,
      anchorLine,
      empty: true,
    };
  }
  return {
    startLine: normalizedStart + 1,
    endLine: normalizedEnd,
    anchorLine: normalizedStart + 1,
  };
}

/**
 * 基于当前三方与结果列文本批量重算 semantic resolver 结果，确保 `.properties` 等整文件 resolver 可以在编辑后正确失效或恢复。
 */
function resolveConflictMergeViewerSemanticHydration(state: ConflictMergeViewerState): ConflictMergeSemanticHydration {
  const semanticBlocks = state.blocks.map((block) => {
    const baseText = joinConflictMergeTokens(state.resultTokens.slice(block.resultStart, block.resultEnd));
    const oursText = joinConflictMergeTokens(state.oursTokens.slice(block.oursStart, block.oursEnd));
    const theirsText = joinConflictMergeTokens(state.theirsTokens.slice(block.theirsStart, block.theirsEnd));
    return {
      path: state.path,
      blockIndex: block.index,
      kind: block.kind,
      baseText,
      oursText,
      theirsText,
      resultText: baseText,
      baseRange: {
        start: block.resultStart,
        end: block.resultEnd,
      },
      oursRange: {
        start: block.oursStart,
        end: block.oursEnd,
      },
      theirsRange: {
        start: block.theirsStart,
        end: block.theirsEnd,
      },
      resultRange: {
        start: block.resultStart,
        end: block.resultEnd,
      },
    };
  });
  const semanticResolution = resolveConflictMergeSemanticBlocks({
    path: state.path,
    baseText: joinConflictMergeTokens(state.resultTokens),
    oursText: joinConflictMergeTokens(state.oursTokens),
    theirsText: joinConflictMergeTokens(state.theirsTokens),
    resultText: joinConflictMergeTokens(state.resultTokens),
    blocks: semanticBlocks,
  });
  const textByBlockIndex = new Map<number, string>();
  semanticResolution?.texts.forEach((text, index) => {
    const block = semanticBlocks[index];
    if (!block || text == null) return;
    textByBlockIndex.set(block.blockIndex, text);
  });
  return {
    resolverId: semanticResolution?.resolverId || null,
    textByBlockIndex,
  };
}

/**
 * 根据块当前状态与结果区 token 重建可直接渲染的 block 视图。
 */
function hydrateConflictMergeBlock(args: {
  block: ConflictMergeBlock;
  semanticHydration: ConflictMergeSemanticHydration;
  baseTokens: string[];
  oursTokens: string[];
  theirsTokens: string[];
  resultTokens: string[];
}): ConflictMergeBlock {
  const baseText = joinConflictMergeTokens(args.baseTokens.slice(args.block.baseStart, args.block.baseEnd));
  const oursText = joinConflictMergeTokens(args.oursTokens.slice(args.block.oursStart, args.block.oursEnd));
  const theirsText = joinConflictMergeTokens(args.theirsTokens.slice(args.block.theirsStart, args.block.theirsEnd));
  const resultText = joinConflictMergeTokens(args.resultTokens.slice(args.block.resultStart, args.block.resultEnd));
  const semanticResolvedText = args.block.kind === "conflict"
    ? args.semanticHydration.textByBlockIndex.get(args.block.index) || null
    : null;
  const resolutionStrategy = args.block.kind === "conflict"
    ? (args.block.resolutionStrategy === "TEXT"
        ? "TEXT"
        : semanticResolvedText != null
          ? "SEMANTIC"
          : null)
    : "DEFAULT";
  return {
    ...args.block,
    baseText,
    oursText,
    theirsText,
    resultText,
    semanticResolverId: semanticResolvedText != null
      ? (args.semanticHydration.resolverId || args.block.semanticResolverId)
      : args.block.semanticResolverId,
    semanticResolvedText,
    resolutionStrategy,
    hasBase: args.block.baseEnd > args.block.baseStart,
    changedInOurs: !isConflictMergeTextEquivalent(oursText, baseText),
    changedInTheirs: !isConflictMergeTextEquivalent(theirsText, baseText),
    resolved: args.block.resolvedOurs && args.block.resolvedTheirs,
    modified: args.block.modified,
    baseRange: buildConflictMergeLineRange(args.block.baseStart, args.block.baseEnd, args.baseTokens.length),
    oursRange: buildConflictMergeLineRange(args.block.oursStart, args.block.oursEnd, args.oursTokens.length),
    theirsRange: buildConflictMergeLineRange(args.block.theirsStart, args.block.theirsEnd, args.theirsTokens.length),
    resultRange: buildConflictMergeLineRange(args.block.resultStart, args.block.resultEnd, args.resultTokens.length),
  };
}

/**
 * 判断 diff 片段是否触达指定结果范围；同时覆盖普通区间、空块锚点与纯插入片段。
 */
function doesConflictMergeDiffSegmentTouchRange(
  rangeStart: number,
  rangeEnd: number,
  segmentStart: number,
  segmentEnd: number,
): boolean {
  if (rangeStart === rangeEnd) {
    return segmentStart <= rangeStart && rangeStart <= segmentEnd;
  }
  if (segmentStart === segmentEnd) {
    return rangeStart <= segmentStart && segmentStart <= rangeEnd;
  }
  return Math.max(rangeStart, segmentStart) < Math.min(rangeEnd, segmentEnd);
}

/**
 * 统一刷新 state 中的结果文本与块视图，保证对外暴露的数据始终与最新 token 对齐。
 */
function hydrateConflictMergeViewerState(state: ConflictMergeViewerState): ConflictMergeViewerState {
  const resultText = serializeConflictMergeTokens(state.resultTokens, state.lineEnding);
  const initialResultText = serializeConflictMergeTokens(state.initialResultTokens, state.lineEnding);
  const semanticHydration = resolveConflictMergeViewerSemanticHydration(state);
  return {
    ...state,
    resultText,
    initialResultText,
    blocks: state.blocks.map((block) => hydrateConflictMergeBlock({
      block,
      semanticHydration,
      baseTokens: state.baseTokens,
      oursTokens: state.oursTokens,
      theirsTokens: state.theirsTokens,
      resultTokens: state.resultTokens,
    })),
  };
}

/**
 * 基于三方 revision 构造接近 IDEA `MergeConflictModel` 的前端块状态，结果列默认以基线文本初始化。
 */
export function createConflictMergeViewerState(snapshot: GitConflictMergeSnapshot): ConflictMergeViewerState {
  const baseTokens = splitConflictMergeTokens(normalizeConflictMergeText(snapshot.base.text));
  const oursTokens = splitConflictMergeTokens(normalizeConflictMergeText(snapshot.ours.text));
  const theirsTokens = splitConflictMergeTokens(normalizeConflictMergeText(snapshot.theirs.text));
  const blocks: ConflictMergeBlock[] = snapshot.merge.blocks.reduce<ConflictMergeBlock[]>((acc, blockData) => {
    const baseBlockTokens = baseTokens.slice(blockData.baseStart, blockData.baseEnd);
    const oursBlockTokens = oursTokens.slice(blockData.oursStart, blockData.oursEnd);
    const theirsBlockTokens = theirsTokens.slice(blockData.theirsStart, blockData.theirsEnd);
    const baseText = joinConflictMergeTokens(baseBlockTokens);
    const oursText = joinConflictMergeTokens(oursBlockTokens);
    const theirsText = joinConflictMergeTokens(theirsBlockTokens);
    const index = acc.length;
    const autoResolvedImport = blockData.isImportChange && snapshot.merge.importMetadata?.autoResolveEnabled === true;
    acc.push({
      index,
      kind: blockData.kind,
      conflictType: blockData.conflictType,
      resolutionStrategy: blockData.kind === "change" ? "DEFAULT" : blockData.resolutionStrategy,
      semanticResolverId: blockData.semanticResolverId,
      semanticResolvedText: blockData.semanticResolvedText,
      isImportChange: blockData.isImportChange,
      summary: resolveConflictMergeBlockSummary({
        index,
        oursText,
        theirsText,
        baseText,
      }),
      hasBase: baseBlockTokens.length > 0,
      baseText,
      oursText,
      theirsText,
      resultText: baseText,
      changedInOurs: blockData.changedInOurs,
      changedInTheirs: blockData.changedInTheirs,
      resolvedOurs: autoResolvedImport,
      resolvedTheirs: autoResolvedImport,
      resolved: autoResolvedImport,
      modified: false,
      onesideApplied: false,
      baseRange: null,
      oursRange: null,
      theirsRange: null,
      resultRange: null,
      baseStart: blockData.baseStart,
      baseEnd: blockData.baseEnd,
      oursStart: blockData.oursStart,
      oursEnd: blockData.oursEnd,
      theirsStart: blockData.theirsStart,
      theirsEnd: blockData.theirsEnd,
      resultStart: blockData.baseStart,
      resultEnd: blockData.baseEnd,
    });
    return acc;
  }, []);

  const state: ConflictMergeViewerState = {
    path: snapshot.path,
    lineEnding: resolveConflictMergeLineEnding(snapshot),
    baseTokens,
    oursTokens,
    theirsTokens,
    resultTokens: baseTokens.slice(),
    initialResultTokens: baseTokens.slice(),
    resultText: serializeConflictMergeTokens(baseTokens, resolveConflictMergeLineEnding(snapshot)),
    initialResultText: serializeConflictMergeTokens(baseTokens, resolveConflictMergeLineEnding(snapshot)),
    importMetadata: snapshot.merge.importMetadata,
    resultImportRange: snapshot.merge.importMetadata?.baseRange
      ? {
          start: snapshot.merge.importMetadata.baseRange.start,
          end: snapshot.merge.importMetadata.baseRange.end,
        }
      : null,
    blocks,
  };

  return hydrateConflictMergeViewerState(state);
}

/**
 * 根据当前结果区替换动作推导新的 import 区范围；插入命中 import 区边界时也要把新增导入纳入范围，避免后续引用迁移重复补同一条语句。
 */
function resolveNextConflictMergeResultImportRange(args: {
  importRange: { start: number; end: number };
  replaceStart: number;
  replaceEnd: number;
  nextTokensLength: number;
}): { start: number; end: number } {
  const delta = args.nextTokensLength - (args.replaceEnd - args.replaceStart);
  if (args.replaceStart === args.replaceEnd) {
    if (args.replaceStart < args.importRange.start) {
      return {
        start: args.importRange.start + delta,
        end: args.importRange.end + delta,
      };
    }
    if (args.replaceStart > args.importRange.end) {
      return { ...args.importRange };
    }
    return {
      start: args.importRange.start,
      end: args.importRange.end + args.nextTokensLength,
    };
  }
  if (args.importRange.end <= args.replaceStart) return { ...args.importRange };
  if (args.importRange.start >= args.replaceEnd) {
    return {
      start: args.importRange.start + delta,
      end: args.importRange.end + delta,
    };
  }
  return {
    start: Math.min(args.importRange.start, args.replaceStart),
    end: Math.max(args.replaceStart + args.nextTokensLength, args.importRange.end + delta),
  };
}

/**
 * 按 token 替换结果区指定范围，并同步平移后续 block 的 result 范围。
 */
function replaceConflictMergeResultTokens(args: {
  state: ConflictMergeViewerState;
  blockIndex?: number | null;
  replaceStart: number;
  replaceEnd: number;
  nextTokens: string[];
  nextBlockPatch: Partial<ConflictMergeBlock>;
}): ConflictMergeViewerState {
  const targetBlock = typeof args.blockIndex === "number"
    ? args.state.blocks.find((block) => block.index === args.blockIndex) || null
    : null;
  const normalizedStart = Math.max(0, Math.min(args.replaceStart, args.replaceEnd));
  const normalizedEnd = Math.max(normalizedStart, args.replaceEnd);
  const nextResultTokens = [
    ...args.state.resultTokens.slice(0, normalizedStart),
    ...args.nextTokens,
    ...args.state.resultTokens.slice(normalizedEnd),
  ];
  const delta = args.nextTokens.length - (normalizedEnd - normalizedStart);
  const nextBlocks = args.state.blocks.map((block) => {
    if (targetBlock && block.index === targetBlock.index) {
      const nextStart = normalizedStart === normalizedEnd ? block.resultStart : normalizedStart;
      const nextEnd = normalizedStart === normalizedEnd
        ? block.resultEnd + args.nextTokens.length
        : normalizedStart + args.nextTokens.length;
      return {
        ...block,
        ...args.nextBlockPatch,
        resultStart: nextStart,
        resultEnd: nextEnd,
      };
    }
    if (block.resultStart >= normalizedEnd) {
      return {
        ...block,
        resultStart: block.resultStart + delta,
        resultEnd: block.resultEnd + delta,
      };
    }
    if (!targetBlock && block.resultStart >= normalizedStart) {
      return {
        ...block,
        resultStart: block.resultStart + delta,
        resultEnd: block.resultEnd + delta,
      };
    }
    return block;
  });
  const importMetadata = args.state.importMetadata
    ? { ...args.state.importMetadata }
    : null;
  const nextResultImportRange = args.state.resultImportRange
    ? resolveNextConflictMergeResultImportRange({
        importRange: args.state.resultImportRange,
        replaceStart: normalizedStart,
        replaceEnd: normalizedEnd,
        nextTokensLength: args.nextTokens.length,
      })
    : null;
  return hydrateConflictMergeViewerState({
    ...args.state,
    resultTokens: nextResultTokens,
    importMetadata,
    resultImportRange: nextResultImportRange,
    blocks: nextBlocks,
  });
}

/**
 * 将“两侧都保留”拼成结果 token；若任一侧为空则直接退化为另一侧。
 */
function combineConflictMergeBothTokens(oursTokens: string[], theirsTokens: string[]): string[] {
  if (oursTokens.length <= 0) return theirsTokens.slice();
  if (theirsTokens.length <= 0) return oursTokens.slice();
  return [...oursTokens, ...theirsTokens];
}

/**
 * 按块当前策略获取自动解决后的 token；`TEXT` 走 IDEA 对齐算法，`SEMANTIC` 直接采用 resolver 结果。
 */
function resolveConflictMergeBlockAutomatically(
  block: ConflictMergeBlock,
): string[] | null {
  if (block.kind !== "conflict" || block.modified || block.resolvedOurs || block.resolvedTheirs) return null;
  if (block.resolutionStrategy === "TEXT") {
    const resolvedText = tryResolveConflictMergeText(block.oursText, block.baseText, block.theirsText);
    return resolvedText == null ? null : splitConflictMergeTokens(normalizeConflictMergeText(resolvedText));
  }
  if (block.resolutionStrategy === "SEMANTIC" && block.semanticResolvedText != null) {
    return splitConflictMergeTokens(normalizeConflictMergeText(block.semanticResolvedText));
  }
  return null;
}

/**
 * 为普通更改块推导自动处理决议，参考上游 `canResolveChangeAutomatically(BASE)` 对 non-conflict change 的选择规则。
 */
function resolveConflictMergeChangeAutoResolution(
  block: ConflictMergeBlock,
): ConflictMergeBlockResolution | null {
  if (block.kind !== "change" || block.resolved || block.modified || block.isImportChange) return null;
  if (block.changedInOurs) return "ours";
  if (block.changedInTheirs) return "theirs";
  return null;
}

/**
 * 判断当前块是否满足 IDEA `canResolveChangeAutomatically` 的前端等价条件；普通变更块与简单冲突块都纳入自动处理入口。
 */
export function canResolveConflictMergeBlockAutomatically(block: ConflictMergeBlock): boolean {
  if (block.isImportChange || block.onesideApplied) return false;
  if (block.kind === "change") {
    return !!resolveConflictMergeChangeAutoResolution(block);
  }
  if (block.resolutionStrategy === "TEXT") {
    return resolveConflictMergeBlockAutomatically(block) != null;
  }
  return block.resolutionStrategy === "SEMANTIC" && block.semanticResolvedText != null;
}

/**
 * 把自动解决结果归并成用户可理解的决议类型；普通变更块直接回收为对应侧，复杂文本冲突则保留 `auto`。
 */
export function resolveConflictMergeAutoResolution(block: ConflictMergeBlock): ConflictMergeAutoResolution | null {
  const changeResolution = resolveConflictMergeChangeAutoResolution(block);
  if (changeResolution) return changeResolution;

  const resolvedTokens = resolveConflictMergeBlockAutomatically(block);
  if (!resolvedTokens) return null;

  const resolvedText = joinConflictMergeTokens(resolvedTokens);
  if (isConflictMergeTextEquivalent(resolvedText, block.baseText)) return "base";
  if (isConflictMergeTextEquivalent(resolvedText, block.oursText)) return "ours";
  if (isConflictMergeTextEquivalent(resolvedText, block.theirsText)) return "theirs";

  const combinedText = joinConflictMergeTokens(combineConflictMergeBothTokens(
    splitConflictMergeTokens(normalizeConflictMergeText(block.oursText)),
    splitConflictMergeTokens(normalizeConflictMergeText(block.theirsText)),
  ));
  if (isConflictMergeTextEquivalent(resolvedText, combinedText)) return "both";
  return "auto";
}

/**
 * 对指定块执行自动处理，并把结果完整写回结果列；普通变更块会直接采用目标侧，复杂冲突块则走文本自动合并。
 */
export function applyConflictMergeBlockAutoResolution(
  state: ConflictMergeViewerState,
  blockIndex: number,
): ConflictMergeViewerState {
  const block = state.blocks.find((item) => item.index === blockIndex);
  if (!block) return state;
  const changeResolution = resolveConflictMergeChangeAutoResolution(block);
  if (changeResolution) {
    return applyConflictMergeBlockResolution(state, block.index, changeResolution);
  }
  const resolvedTokens = resolveConflictMergeBlockAutomatically(block);
  if (!resolvedTokens) return state;
  const nextState = replaceConflictMergeResultTokens({
    state,
    blockIndex: block.index,
    replaceStart: block.resultStart,
    replaceEnd: block.resultEnd,
    nextTokens: resolvedTokens,
    nextBlockPatch: {
      resolvedOurs: true,
      resolvedTheirs: true,
      onesideApplied: false,
      modified: false,
    },
  });
  return nextState;
}

/**
 * 判断当前块是否可作为某个非冲突目标的一部分被自动应用。
 */
function canApplyConflictMergeNonConflictBlock(
  block: ConflictMergeBlock,
  target: ConflictMergeApplyNonConflictsTarget,
): boolean {
  if (block.kind !== "change" || block.resolved || block.modified || block.isImportChange) return false;
  if (target === "ours") return block.changedInOurs;
  if (target === "theirs") return block.changedInTheirs;
  return block.changedInOurs || block.changedInTheirs;
}

/**
 * 为非冲突块解析真正要使用的来源；“所有”语义下优先用左侧，否则退回右侧。
 */
function resolveConflictMergeNonConflictTargetResolution(
  block: ConflictMergeBlock,
  target: ConflictMergeApplyNonConflictsTarget,
): ConflictMergeBlockResolution | null {
  if (!canApplyConflictMergeNonConflictBlock(block, target)) return null;
  if (target === "ours") return "ours";
  if (target === "theirs") return "theirs";
  return block.changedInOurs ? "ours" : block.changedInTheirs ? "theirs" : null;
}

/**
 * 统计当前 state 中仍未处理的更改块数量，供顶部状态与应用确认提示复用。
 */
export function countConflictMergeUnresolvedChanges(state: ConflictMergeViewerState): number {
  return state.blocks.filter((block) => !block.resolved).length;
}

/**
 * 统计当前 state 中仍未解决的真正冲突块数量，供接近 IDEA 的“部分解决”提示复用。
 */
export function countConflictMergeUnresolvedConflicts(state: ConflictMergeViewerState): number {
  return state.blocks.filter((block) => block.kind === "conflict" && !block.resolved).length;
}

/**
 * 对指定块执行快速采用动作，完整保留 IDEA 的单侧应用、单侧追加与最终 resolved 状态迁移语义。
 */
export function applyConflictMergeBlockResolution(
  state: ConflictMergeViewerState,
  blockIndex: number,
  resolution: ConflictMergeBlockResolution,
): ConflictMergeViewerState {
  const block = state.blocks.find((item) => item.index === blockIndex);
  if (!block) return state;
  if (resolution === "base") {
    return replaceConflictMergeResultTokens({
      state,
      blockIndex: block.index,
      replaceStart: block.resultStart,
      replaceEnd: block.resultEnd,
      nextTokens: state.baseTokens.slice(block.baseStart, block.baseEnd),
      nextBlockPatch: {
        resolvedOurs: true,
        resolvedTheirs: true,
        modified: false,
        onesideApplied: false,
      },
    });
  }
  if (resolution === "both") {
    const nextTokens = combineConflictMergeBothTokens(
      state.oursTokens.slice(block.oursStart, block.oursEnd),
      state.theirsTokens.slice(block.theirsStart, block.theirsEnd),
    );
    const nextState = replaceConflictMergeResultTokens({
      state,
      blockIndex: block.index,
      replaceStart: block.resultStart,
      replaceEnd: block.resultEnd,
      nextTokens,
      nextBlockPatch: {
        resolvedOurs: true,
        resolvedTheirs: true,
        modified: false,
        onesideApplied: false,
      },
    });
    return nextState;
  }

  const sourceIsOurs = resolution === "ours";
  const sourceTokens = sourceIsOurs
    ? state.oursTokens.slice(block.oursStart, block.oursEnd)
    : state.theirsTokens.slice(block.theirsStart, block.theirsEnd);
  const nextPatch: Partial<ConflictMergeBlock> = sourceIsOurs
    ? { resolvedOurs: true, modified: false }
    : { resolvedTheirs: true, modified: false };

  if (block.kind !== "conflict") {
    const nextState = replaceConflictMergeResultTokens({
      state,
      blockIndex: block.index,
      replaceStart: block.resultStart,
      replaceEnd: block.resultEnd,
      nextTokens: sourceTokens,
      nextBlockPatch: {
        ...nextPatch,
        resolvedOurs: true,
        resolvedTheirs: true,
        onesideApplied: false,
      },
    });
    return nextState;
  }

  const oppositeTokens = sourceIsOurs
    ? state.theirsTokens.slice(block.theirsStart, block.theirsEnd)
    : state.oursTokens.slice(block.oursStart, block.oursEnd);
  const targetResolved = sourceIsOurs ? block.resolvedOurs : block.resolvedTheirs;
  if (targetResolved) return state;
  const oppositeResolved = sourceIsOurs ? block.resolvedTheirs : block.resolvedOurs;
  const shouldResolveCompletely = oppositeTokens.length <= 0 || oppositeResolved;

  if (block.onesideApplied) {
    const nextState = replaceConflictMergeResultTokens({
      state,
      blockIndex: block.index,
      replaceStart: block.resultEnd,
      replaceEnd: block.resultEnd,
      nextTokens: sourceTokens,
      nextBlockPatch: {
        resolvedOurs: sourceIsOurs ? true : block.resolvedOurs,
        resolvedTheirs: sourceIsOurs ? block.resolvedTheirs : true,
        onesideApplied: false,
        modified: false,
      },
    });
    return nextState;
  }

  const nextState = replaceConflictMergeResultTokens({
    state,
    blockIndex: block.index,
    replaceStart: block.resultStart,
    replaceEnd: block.resultEnd,
    nextTokens: sourceTokens,
    nextBlockPatch: {
      resolvedOurs: shouldResolveCompletely ? true : (sourceIsOurs ? true : block.resolvedOurs),
      resolvedTheirs: shouldResolveCompletely ? true : (sourceIsOurs ? block.resolvedTheirs : true),
      onesideApplied: !shouldResolveCompletely,
      modified: false,
    },
  });
  return nextState;
}

/**
 * 忽略指定侧的更改；非冲突块会直接按“保持当前结果并视作已处理”收口，冲突块则只标记该侧已解决。
 */
export function ignoreConflictMergeBlockSide(
  state: ConflictMergeViewerState,
  blockIndex: number,
  side: "ours" | "theirs",
): ConflictMergeViewerState {
  const block = state.blocks.find((item) => item.index === blockIndex);
  if (!block) return state;
  if (block.kind !== "conflict") {
    return hydrateConflictMergeViewerState({
      ...state,
      blocks: state.blocks.map((item) => item.index === blockIndex
        ? {
            ...item,
            resolvedOurs: true,
            resolvedTheirs: true,
            modified: false,
            onesideApplied: false,
          }
        : item),
    });
  }
  return hydrateConflictMergeViewerState({
    ...state,
    blocks: state.blocks.map((item) => {
      if (item.index !== blockIndex) return item;
      return side === "ours"
        ? { ...item, resolvedOurs: true, modified: false }
        : { ...item, resolvedTheirs: true, modified: false };
    }),
  });
}

/**
 * 批量应用某个范围内的不冲突更改，对齐 IDEA `ApplyNonConflictsAction` 的左/所有/右三种语义。
 */
export function applyConflictMergeNonConflictedChanges(
  state: ConflictMergeViewerState,
  target: ConflictMergeApplyNonConflictsTarget,
): { state: ConflictMergeViewerState; resolvedCount: number } {
  let nextState = state;
  let resolvedCount = 0;
  const pendingBlocks = [...state.blocks].sort((left, right) => right.index - left.index);
  for (const block of pendingBlocks) {
    const resolution = resolveConflictMergeNonConflictTargetResolution(block, target);
    if (!resolution) continue;
    nextState = applyConflictMergeBlockResolution(nextState, block.index, resolution);
    resolvedCount += 1;
  }
  return {
    state: nextState,
    resolvedCount,
  };
}

/**
 * 批量处理所有可安全自动处理的块，对齐 IDEA `MagicResolvedConflictsAction` 会同时覆盖 non-conflict change 与 simple conflict 的行为。
 */
export function applyResolvableConflictMergeBlocks(
  state: ConflictMergeViewerState,
): { state: ConflictMergeViewerState; resolvedCount: number } {
  let nextState = state;
  let resolvedCount = 0;
  const pendingBlocks = [...state.blocks]
    .filter((block) => !block.resolved)
    .sort((left, right) => right.index - left.index);
  for (const block of pendingBlocks) {
    if (!canResolveConflictMergeBlockAutomatically(block)) continue;
    nextState = applyConflictMergeBlockAutoResolution(nextState, block.index);
    resolvedCount += 1;
  }
  return {
    state: nextState,
    resolvedCount,
  };
}

/**
 * 在结果区发生直接编辑后，用 token 级最小变更范围更新块坐标，并把受影响块标记为手工编辑。
 */
export function updateConflictMergeViewerResultText(
  state: ConflictMergeViewerState,
  nextText: string,
): ConflictMergeViewerState {
  const nextTokens = splitConflictMergeTokens(normalizeConflictMergeText(nextText));
  if (joinConflictMergeTokens(state.resultTokens) === joinConflictMergeTokens(nextTokens)) return state;
  const segments = buildConflictMergeDiffSegments(state.resultTokens, nextTokens);
  const changedSegments = segments.filter((segment) => segment.changed);
  const mapIndex = (index: number, preferEnd: boolean): number => mapConflictMergeResultIndex({
    segments,
    index,
    preferEnd,
  });

  const nextBlocks = state.blocks.map((block) => {
    const nextStart = mapIndex(block.resultStart, false);
    const nextEnd = mapIndex(block.resultEnd, true);
    const modified = block.modified || changedSegments.some((segment) => {
      return doesConflictMergeDiffSegmentTouchRange(
        block.resultStart,
        block.resultEnd,
        segment.baseStart,
        segment.baseEnd,
      ) || doesConflictMergeDiffSegmentTouchRange(
        nextStart,
        nextEnd,
        segment.targetStart,
        segment.targetEnd,
      );
    });
    return {
      ...block,
      modified,
      resultStart: nextStart,
      resultEnd: nextEnd,
    };
  });
  const nextResultImportRange = state.resultImportRange
    ? {
        start: mapIndex(state.resultImportRange.start, false),
        end: mapIndex(state.resultImportRange.end, true),
      }
    : null;

  return hydrateConflictMergeViewerState({
    ...state,
    resultTokens: nextTokens,
    resultImportRange: nextResultImportRange,
    blocks: nextBlocks,
  });
}

/**
 * 判断文本中是否仍包含 Git 冲突 marker；保留该检测用于用户手工粘贴 marker 的兜底提醒。
 */
export function hasConflictMergeBlocks(text: string): boolean {
  const normalizedText = normalizeConflictMergeText(text);
  return normalizedText.includes("<<<<<<<")
    && normalizedText.includes("=======")
    && normalizedText.includes(">>>>>>>");
}
