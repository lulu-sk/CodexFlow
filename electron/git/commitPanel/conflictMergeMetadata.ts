// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  buildConflictMergeLineRanges as buildIdeaParityConflictMergeLineRanges,
  intersectsConflictMergeRange,
  offsetConflictMergeRange,
  type ConflictMergeRange,
} from "./conflictMergeDiff";
import { analyzeConflictMergeImportMetadata } from "./conflictMergeImports";
import { resolveConflictMergeSemanticBlocks } from "./conflictMergeSemantic";
import { tryResolveConflictMergeText } from "./conflictMergeTextResolve";
import type {
  GitConflictMergeBlockData,
  GitConflictMergeConflictType,
  GitConflictMergeMetadata,
  GitConflictMergeResolutionStrategy,
} from "./conflictMergeShared";
import {
  joinConflictMergeTokens,
  splitConflictMergeLineTokens,
} from "./conflictMergeShared";

type ConflictMergeTypeResult = {
  type: GitConflictMergeConflictType;
  changedInOurs: boolean;
  changedInTheirs: boolean;
  resolutionStrategy: GitConflictMergeResolutionStrategy;
};

/**
 * 判断一组逐行 token 是否为空区间，参考上游 `isLineMergeIntervalEmpty` 的 line-range 语义。
 */
function isConflictMergeTokenSliceEmpty(tokens: string[]): boolean {
  return tokens.length <= 0;
}

/**
 * 按 IDEA `compareLineMergeContents` 的可观察语义比较两个逐行 token 区间；当前 viewer 固定走默认比较策略，因此逐行精确比较即可。
 */
function isConflictMergeTokenSliceEqual(leftTokens: string[], rightTokens: string[]): boolean {
  if (leftTokens.length !== rightTokens.length) return false;
  return leftTokens.every((token, index) => token === rightTokens[index]);
}

/**
 * 按 IDEA `MergeRangeUtil.getLineMergeType` 的核心分支，为行级块推导类型与自动解决策略。
 */
function resolveConflictMergeLineType(args: {
  oursTokens: string[];
  baseTokens: string[];
  theirsTokens: string[];
}): ConflictMergeTypeResult {
  const oursText = joinConflictMergeTokens(args.oursTokens);
  const baseText = joinConflictMergeTokens(args.baseTokens);
  const theirsText = joinConflictMergeTokens(args.theirsTokens);
  const oursEmpty = isConflictMergeTokenSliceEmpty(args.oursTokens);
  const baseEmpty = isConflictMergeTokenSliceEmpty(args.baseTokens);
  const theirsEmpty = isConflictMergeTokenSliceEmpty(args.theirsTokens);
  const unchangedOurs = isConflictMergeTokenSliceEqual(args.baseTokens, args.oursTokens);
  const unchangedTheirs = isConflictMergeTokenSliceEqual(args.baseTokens, args.theirsTokens);

  if (baseEmpty) {
    if (oursEmpty) {
      return { type: "INSERTED", changedInOurs: false, changedInTheirs: true, resolutionStrategy: "DEFAULT" };
    }
    if (theirsEmpty) {
      return { type: "INSERTED", changedInOurs: true, changedInTheirs: false, resolutionStrategy: "DEFAULT" };
    }
    if (isConflictMergeTokenSliceEqual(args.oursTokens, args.theirsTokens)) {
      return { type: "INSERTED", changedInOurs: true, changedInTheirs: true, resolutionStrategy: "DEFAULT" };
    }
    const resolvedText = tryResolveConflictMergeText(oursText, baseText, theirsText);
    return {
      type: "CONFLICT",
      changedInOurs: true,
      changedInTheirs: true,
      resolutionStrategy: resolvedText == null ? null : "TEXT",
    };
  }

  if (oursEmpty && theirsEmpty) {
    return { type: "DELETED", changedInOurs: true, changedInTheirs: true, resolutionStrategy: "DEFAULT" };
  }
  if (unchangedOurs && unchangedTheirs) {
    return { type: "MODIFIED", changedInOurs: false, changedInTheirs: false, resolutionStrategy: "DEFAULT" };
  }
  if (unchangedOurs) {
    return {
      type: theirsEmpty ? "DELETED" : "MODIFIED",
      changedInOurs: false,
      changedInTheirs: true,
      resolutionStrategy: "DEFAULT",
    };
  }
  if (unchangedTheirs) {
    return {
      type: oursEmpty ? "DELETED" : "MODIFIED",
      changedInOurs: true,
      changedInTheirs: false,
      resolutionStrategy: "DEFAULT",
    };
  }
  if (isConflictMergeTokenSliceEqual(args.oursTokens, args.theirsTokens)) {
    return { type: "MODIFIED", changedInOurs: true, changedInTheirs: true, resolutionStrategy: "DEFAULT" };
  }
  const resolvedText = tryResolveConflictMergeText(oursText, baseText, theirsText);
  return {
    type: "CONFLICT",
    changedInOurs: true,
    changedInTheirs: true,
    resolutionStrategy: resolvedText == null ? null : "TEXT",
  };
}

/**
 * 基于三方逐行 token 构造基础 merge ranges。
 */
function buildConflictMergeLineRanges(args: {
  baseTokens: string[];
  oursTokens: string[];
  theirsTokens: string[];
}): ConflictMergeRange[] {
  return buildIdeaParityConflictMergeLineRanges({
    baseTokens: args.baseTokens,
    oursTokens: args.oursTokens,
    theirsTokens: args.theirsTokens,
  });
}

/**
 * 按 import 前/中/后三段重新切 merge ranges，确保 import block 可单独标记。
 */
function buildConflictMergeRangesWithImports(args: {
  baseTokens: string[];
  oursTokens: string[];
  theirsTokens: string[];
  importMetadata: NonNullable<GitConflictMergeMetadata["importMetadata"]>;
}): Array<{ range: ConflictMergeRange; isImportChange: boolean }> {
  const segments = [
    {
      isImportChange: false,
      baseStart: 0,
      baseEnd: args.importMetadata.baseRange?.start || 0,
      oursStart: 0,
      oursEnd: args.importMetadata.oursRange?.start || 0,
      theirsStart: 0,
      theirsEnd: args.importMetadata.theirsRange?.start || 0,
    },
    {
      isImportChange: true,
      baseStart: args.importMetadata.baseRange?.start || 0,
      baseEnd: args.importMetadata.baseRange?.end || 0,
      oursStart: args.importMetadata.oursRange?.start || 0,
      oursEnd: args.importMetadata.oursRange?.end || 0,
      theirsStart: args.importMetadata.theirsRange?.start || 0,
      theirsEnd: args.importMetadata.theirsRange?.end || 0,
    },
    {
      isImportChange: false,
      baseStart: args.importMetadata.baseRange?.end || 0,
      baseEnd: args.baseTokens.length,
      oursStart: args.importMetadata.oursRange?.end || 0,
      oursEnd: args.oursTokens.length,
      theirsStart: args.importMetadata.theirsRange?.end || 0,
      theirsEnd: args.theirsTokens.length,
    },
  ];

  const result: Array<{ range: ConflictMergeRange; isImportChange: boolean }> = [];
  for (const segment of segments) {
    const localRanges = buildConflictMergeLineRanges({
      baseTokens: args.baseTokens.slice(segment.baseStart, segment.baseEnd),
      oursTokens: args.oursTokens.slice(segment.oursStart, segment.oursEnd),
      theirsTokens: args.theirsTokens.slice(segment.theirsStart, segment.theirsEnd),
    });
    for (const range of localRanges) {
      result.push({
        range: offsetConflictMergeRange(range, {
          base: segment.baseStart,
          ours: segment.oursStart,
          theirs: segment.theirsStart,
        }),
        isImportChange: segment.isImportChange,
      });
    }
  }
  return result;
}

/**
 * 把 metadata block 映射为 semantic resolver 的整文件上下文，确保 `.properties` 这类 resolver 能一次看见全部 chunk。
 */
function buildConflictMergeSemanticBlockContexts(args: {
  path: string;
  baseTokens: string[];
  oursTokens: string[];
  theirsTokens: string[];
  blocks: GitConflictMergeBlockData[];
}): Parameters<typeof resolveConflictMergeSemanticBlocks>[0]["blocks"] {
  return args.blocks.map((block) => {
    const baseText = joinConflictMergeTokens(args.baseTokens.slice(block.baseStart, block.baseEnd));
    const oursText = joinConflictMergeTokens(args.oursTokens.slice(block.oursStart, block.oursEnd));
    const theirsText = joinConflictMergeTokens(args.theirsTokens.slice(block.theirsStart, block.theirsEnd));
    return {
      path: args.path,
      blockIndex: block.index,
      kind: block.kind,
      baseText,
      oursText,
      theirsText,
      resultText: baseText,
      baseRange: {
        start: block.baseStart,
        end: block.baseEnd,
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
        start: block.baseStart,
        end: block.baseEnd,
      },
    };
  });
}

/**
 * 分析冲突快照的 merge metadata，供前端直接消费而不再自行猜策略。
 */
export function buildConflictMergeMetadata(args: {
  path: string;
  baseText: string;
  oursText: string;
  theirsText: string;
}): GitConflictMergeMetadata {
  const baseTokens = splitConflictMergeLineTokens(args.baseText);
  const oursTokens = splitConflictMergeLineTokens(args.oursText);
  const theirsTokens = splitConflictMergeLineTokens(args.theirsText);
  const importMetadata = analyzeConflictMergeImportMetadata(args);
  const ranges = importMetadata
    ? buildConflictMergeRangesWithImports({
        baseTokens,
        oursTokens,
        theirsTokens,
        importMetadata,
      })
    : buildConflictMergeLineRanges({
        baseTokens,
        oursTokens,
        theirsTokens,
      }).map((range) => ({
        range,
        isImportChange: false,
      }));

  const blocks: GitConflictMergeBlockData[] = [];

  for (const item of ranges) {
    const range = item.range;
    const baseRangeTokens = baseTokens.slice(range.baseStart, range.baseEnd);
    const oursRangeTokens = oursTokens.slice(range.oursStart, range.oursEnd);
    const theirsRangeTokens = theirsTokens.slice(range.theirsStart, range.theirsEnd);
    const baseText = joinConflictMergeTokens(baseRangeTokens);
    const oursText = joinConflictMergeTokens(oursRangeTokens);
    const theirsText = joinConflictMergeTokens(theirsRangeTokens);
    const lineType = resolveConflictMergeLineType({
      oursTokens: oursRangeTokens,
      baseTokens: baseRangeTokens,
      theirsTokens: theirsRangeTokens,
    });
    if (!lineType.changedInOurs && !lineType.changedInTheirs) continue;

    blocks.push({
      index: blocks.length,
      kind: lineType.type === "CONFLICT" ? "conflict" : "change",
      conflictType: lineType.type,
      resolutionStrategy: lineType.resolutionStrategy,
      semanticResolverId: null,
      semanticResolvedText: null,
      isImportChange: item.isImportChange
        || intersectsConflictMergeRange(importMetadata?.baseRange || null, range.baseStart, range.baseEnd)
        || intersectsConflictMergeRange(importMetadata?.oursRange || null, range.oursStart, range.oursEnd)
        || intersectsConflictMergeRange(importMetadata?.theirsRange || null, range.theirsStart, range.theirsEnd),
      changedInOurs: lineType.changedInOurs,
      changedInTheirs: lineType.changedInTheirs,
      baseStart: range.baseStart,
      baseEnd: range.baseEnd,
      oursStart: range.oursStart,
      oursEnd: range.oursEnd,
      theirsStart: range.theirsStart,
      theirsEnd: range.theirsEnd,
    });
  }

  let semanticResolverId: string | null = null;
  const semanticResolution = resolveConflictMergeSemanticBlocks({
    path: args.path,
    baseText: joinConflictMergeTokens(baseTokens),
    oursText: joinConflictMergeTokens(oursTokens),
    theirsText: joinConflictMergeTokens(theirsTokens),
    resultText: joinConflictMergeTokens(baseTokens),
    blocks: buildConflictMergeSemanticBlockContexts({
      path: args.path,
      baseTokens,
      oursTokens,
      theirsTokens,
      blocks,
    }),
  });

  if (semanticResolution) {
    semanticResolution.texts.forEach((resolvedText, index) => {
      const currentBlock = blocks[index];
      if (!currentBlock) return;
      if (currentBlock.kind !== "conflict" || currentBlock.resolutionStrategy != null || resolvedText == null) return;
      blocks[index] = {
        ...currentBlock,
        resolutionStrategy: "SEMANTIC",
        semanticResolverId: semanticResolution.resolverId,
        semanticResolvedText: resolvedText,
      };
      semanticResolverId = semanticResolution.resolverId;
    });
  }

  return {
    blocks,
    importMetadata,
    semanticResolverId,
  };
}
