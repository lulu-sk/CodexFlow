// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// 文本冲突自动解决流程参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 Electron/TypeScript 架构重写。

import { buildConflictMergeRanges } from "./conflictMergeDiff";
import {
  joinConflictMergeTokens,
  normalizeConflictMergeText,
  normalizeConflictMergeTokenForPolicy,
  splitConflictMergeWordTokens,
} from "./conflictMergeShared";

type ConflictMergeWordPolicy = "default" | "ignoreWhitespace";

type ConflictMergeTypeResult = {
  type: "INSERTED" | "DELETED" | "MODIFIED" | "CONFLICT";
  changedInOurs: boolean;
  changedInTheirs: boolean;
};

type ConflictMergeWhitespaceLayout = {
  tokens: string[];
  gaps: string[];
};

type ConflictMergeTokenMatch = {
  baseIndex: number;
  contentIndex: number;
};

/**
 * 按忽略空白策略归一化整段文本，供 IDEA 兼容的“等价空白形态收口”复用。
 */
function normalizeConflictMergeTextIgnoringWhitespace(text: string): string {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\s+/g, "");
}

/**
 * 把文本拆成“非空白 token + 相邻空白 gap”结构，供 whitespace-only 合并分支精确复用原始空白布局。
 */
function buildConflictMergeWhitespaceLayout(text: string): ConflictMergeWhitespaceLayout {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const tokens: string[] = [];
  const gaps: string[] = [];
  let gapBuffer = "";

  for (const part of source.match(/\s+|[^\s]+/g) || []) {
    if (/^\s+$/.test(part)) {
      gapBuffer += part;
      continue;
    }
    gaps.push(gapBuffer);
    gapBuffer = "";
    tokens.push(part);
  }
  gaps.push(gapBuffer);
  return {
    tokens,
    gaps,
  };
}

/**
 * 对两组非空白 token 构造 LCS 对齐结果；只用于判断“内容侧是否为 base + 插入”的受限分支。
 */
function buildConflictMergeTokenMatches(
  baseTokens: string[],
  contentTokens: string[],
): ConflictMergeTokenMatch[] {
  const table = Array.from({ length: baseTokens.length + 1 }, () => new Uint32Array(contentTokens.length + 1));

  for (let baseIndex = 1; baseIndex <= baseTokens.length; baseIndex += 1) {
    for (let contentIndex = 1; contentIndex <= contentTokens.length; contentIndex += 1) {
      table[baseIndex][contentIndex] = baseTokens[baseIndex - 1] === contentTokens[contentIndex - 1]
        ? table[baseIndex - 1][contentIndex - 1] + 1
        : Math.max(table[baseIndex - 1][contentIndex], table[baseIndex][contentIndex - 1]);
    }
  }

  const matches: ConflictMergeTokenMatch[] = [];
  let baseIndex = baseTokens.length;
  let contentIndex = contentTokens.length;
  while (baseIndex > 0 && contentIndex > 0) {
    if (baseTokens[baseIndex - 1] === contentTokens[contentIndex - 1]) {
      matches.push({
        baseIndex: baseIndex - 1,
        contentIndex: contentIndex - 1,
      });
      baseIndex -= 1;
      contentIndex -= 1;
      continue;
    }
    if (table[baseIndex - 1][contentIndex] >= table[baseIndex][contentIndex - 1]) {
      baseIndex -= 1;
      continue;
    }
    contentIndex -= 1;
  }
  return matches.reverse();
}

/**
 * 判断内容侧是否可视作“在 base 原词骨架间只做插入”，从而允许复用另一侧的空白布局。
 */
function isConflictMergeInsertionOnlyAgainstBase(
  baseLayout: ConflictMergeWhitespaceLayout,
  contentLayout: ConflictMergeWhitespaceLayout,
  matches: ConflictMergeTokenMatch[],
): boolean {
  if (matches.length !== baseLayout.tokens.length) return false;
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index]?.baseIndex !== index) return false;
  }
  return true;
}

/**
 * 在一侧只改空白、另一侧仅做插入时，按 IDEA 官方回归夹具的语义组合两侧结果。
 */
function tryResolveConflictMergeWhitespaceOnlyInsertions(args: {
  baseText: string;
  whitespaceText: string;
  contentText: string;
}): string | null {
  const baseLayout = buildConflictMergeWhitespaceLayout(args.baseText);
  const whitespaceLayout = buildConflictMergeWhitespaceLayout(args.whitespaceText);
  const contentLayout = buildConflictMergeWhitespaceLayout(args.contentText);
  if (baseLayout.tokens.length !== whitespaceLayout.tokens.length) return null;
  for (let index = 0; index < baseLayout.tokens.length; index += 1) {
    if (baseLayout.tokens[index] !== whitespaceLayout.tokens[index]) return null;
  }

  const matches = buildConflictMergeTokenMatches(baseLayout.tokens, contentLayout.tokens);
  if (!isConflictMergeInsertionOnlyAgainstBase(baseLayout, contentLayout, matches)) return null;

  let result = "";
  for (let baseIndex = 0; baseIndex <= baseLayout.tokens.length; baseIndex += 1) {
    const previousContentIndex = baseIndex === 0 ? -1 : (matches[baseIndex - 1]?.contentIndex ?? -1);
    const nextContentIndex = baseIndex === baseLayout.tokens.length
      ? contentLayout.tokens.length
      : (matches[baseIndex]?.contentIndex ?? contentLayout.tokens.length);
    const contentPrefix = contentLayout.gaps[previousContentIndex + 1] || "";
    const baseGap = baseLayout.gaps[baseIndex] || "";
    const whitespaceGap = whitespaceLayout.gaps[baseIndex] || "";
    const insertedCount = nextContentIndex - previousContentIndex - 1;

    if (insertedCount <= 0) {
      result += contentPrefix === baseGap ? whitespaceGap : contentPrefix;
    } else {
      result += contentPrefix === baseGap ? whitespaceGap : contentPrefix;
      for (let contentIndex = previousContentIndex + 1; contentIndex < nextContentIndex; contentIndex += 1) {
        result += contentLayout.tokens[contentIndex] || "";
        result += contentLayout.gaps[contentIndex + 1] || "";
      }
    }

    if (baseIndex < baseLayout.tokens.length) {
      result += contentLayout.tokens[nextContentIndex] || "";
    }
  }
  return result;
}

/**
 * 处理“一侧仅在 base 外层包裹前后缀，另一侧改写主体内容”的场景，对齐 IDEA 在真实代码块上的自动收敛行为。
 */
function tryResolveConflictMergeWrappedBaseText(args: {
  baseText: string;
  wrappedText: string;
  modifiedText: string;
}): string | null {
  const baseText = normalizeConflictMergeText(args.baseText);
  const wrappedText = normalizeConflictMergeText(args.wrappedText);
  const modifiedText = normalizeConflictMergeText(args.modifiedText);
  if (!baseText || wrappedText === baseText) return null;

  const firstIndex = wrappedText.indexOf(baseText);
  if (firstIndex < 0) return null;
  const lastIndex = wrappedText.lastIndexOf(baseText);
  if (firstIndex !== lastIndex) return null;

  const prefix = wrappedText.slice(0, firstIndex);
  const suffix = wrappedText.slice(firstIndex + baseText.length);
  if (!prefix && !suffix) return null;
  if ((prefix && modifiedText.startsWith(prefix)) || (suffix && modifiedText.endsWith(suffix))) return null;

  return `${prefix}${modifiedText}${suffix}`;
}

/**
 * 当三侧内容在忽略空白后完全等价时，选择最短文本作为稳定结果，对齐 IDEA 在回归夹具中的空白收口行为。
 */
function resolveConflictMergeEquivalentWhitespaceText(
  oursText: string,
  baseText: string,
  theirsText: string,
  resolvedText: string,
): string {
  const normalizedOurs = normalizeConflictMergeTextIgnoringWhitespace(oursText);
  const normalizedBase = normalizeConflictMergeTextIgnoringWhitespace(baseText);
  const normalizedTheirs = normalizeConflictMergeTextIgnoringWhitespace(theirsText);
  if (normalizedOurs !== normalizedBase || normalizedBase !== normalizedTheirs) return resolvedText;

  const candidates = [resolvedText, oursText, baseText, theirsText];
  let best = candidates[0] || "";
  for (const candidate of candidates.slice(1)) {
    if (normalizeConflictMergeTextIgnoringWhitespace(candidate) !== normalizedBase) continue;
    if (candidate.length < best.length) {
      best = candidate;
      continue;
    }
    if (candidate.length === best.length && candidate < best) {
      best = candidate;
    }
  }
  return best;
}

/**
 * 比较两个 token 片段在当前策略下是否等价。
 */
function isConflictMergeTokenSliceEqual(
  leftTokens: string[],
  rightTokens: string[],
  policy: ConflictMergeWordPolicy,
): boolean {
  return joinConflictMergeTokens(leftTokens.map((one) => normalizeConflictMergeTokenForPolicy(one, policy)))
    === joinConflictMergeTokens(rightTokens.map((one) => normalizeConflictMergeTokenForPolicy(one, policy)));
}

/**
 * 按 IDEA `MergeRangeUtil.getMergeType` 的核心语义推导当前三方 token 片段类型。
 */
function resolveConflictMergeType(args: {
  oursTokens: string[];
  baseTokens: string[];
  theirsTokens: string[];
  policy: ConflictMergeWordPolicy;
}): ConflictMergeTypeResult {
  const oursEmpty = args.oursTokens.length <= 0;
  const baseEmpty = args.baseTokens.length <= 0;
  const theirsEmpty = args.theirsTokens.length <= 0;
  const unchangedOurs = isConflictMergeTokenSliceEqual(args.baseTokens, args.oursTokens, args.policy);
  const unchangedTheirs = isConflictMergeTokenSliceEqual(args.baseTokens, args.theirsTokens, args.policy);

  if (baseEmpty) {
    if (oursEmpty) {
      return { type: "INSERTED", changedInOurs: false, changedInTheirs: true };
    }
    if (theirsEmpty) {
      return { type: "INSERTED", changedInOurs: true, changedInTheirs: false };
    }
    if (isConflictMergeTokenSliceEqual(args.oursTokens, args.theirsTokens, args.policy)) {
      return { type: "INSERTED", changedInOurs: true, changedInTheirs: true };
    }
    return { type: "CONFLICT", changedInOurs: true, changedInTheirs: true };
  }

  if (oursEmpty && theirsEmpty) {
    return { type: "DELETED", changedInOurs: true, changedInTheirs: true };
  }
  if (unchangedOurs && unchangedTheirs) {
    return { type: "MODIFIED", changedInOurs: false, changedInTheirs: false };
  }
  if (unchangedOurs) {
    return { type: theirsEmpty ? "DELETED" : "MODIFIED", changedInOurs: false, changedInTheirs: true };
  }
  if (unchangedTheirs) {
    return { type: oursEmpty ? "DELETED" : "MODIFIED", changedInOurs: true, changedInTheirs: false };
  }
  if (isConflictMergeTokenSliceEqual(args.oursTokens, args.theirsTokens, args.policy)) {
    return { type: "MODIFIED", changedInOurs: true, changedInTheirs: true };
  }
  return { type: "CONFLICT", changedInOurs: true, changedInTheirs: true };
}

/**
 * 按 IDEA `ComparisonMergeUtil.tryResolveConflict` 的默认路径，在词级范围内尝试简单自动解决。
 */
function tryResolveConflictMergeTextWithPolicy(
  oursText: string,
  baseText: string,
  theirsText: string,
  policy: ConflictMergeWordPolicy,
): string | null {
  const oursTokens = splitConflictMergeWordTokens(oursText);
  const baseTokens = splitConflictMergeWordTokens(baseText);
  const theirsTokens = splitConflictMergeWordTokens(theirsText);
  const ranges = buildConflictMergeRanges({
    baseItems: baseTokens,
    oursItems: oursTokens,
    theirsItems: theirsTokens,
    isEqual: (left, right) => normalizeConflictMergeTokenForPolicy(left, policy) === normalizeConflictMergeTokenForPolicy(right, policy),
  });

  const resolvedTokens: string[] = [];
  let baseCursor = 0;
  for (const range of ranges) {
    if (range.baseStart > baseCursor) {
      resolvedTokens.push(...baseTokens.slice(baseCursor, range.baseStart));
    }
    const type = resolveConflictMergeType({
      oursTokens: oursTokens.slice(range.oursStart, range.oursEnd),
      baseTokens: baseTokens.slice(range.baseStart, range.baseEnd),
      theirsTokens: theirsTokens.slice(range.theirsStart, range.theirsEnd),
      policy,
    });
    if (type.type === "CONFLICT") return null;
    if (type.changedInOurs) {
      resolvedTokens.push(...oursTokens.slice(range.oursStart, range.oursEnd));
    } else {
      resolvedTokens.push(...theirsTokens.slice(range.theirsStart, range.theirsEnd));
    }
    baseCursor = range.baseEnd;
  }
  if (baseCursor < baseTokens.length) {
    resolvedTokens.push(...baseTokens.slice(baseCursor));
  }
  return joinConflictMergeTokens(resolvedTokens);
}

/**
 * 参考上游 `ComparisonMergeUtil.tryResolveConflict` 的默认行为，先 exact，再忽略空白回退。
 */
export function tryResolveConflictMergeText(
  oursText: string,
  baseText: string,
  theirsText: string,
): string | null {
  const defaultResolvedText = tryResolveConflictMergeTextWithPolicy(oursText, baseText, theirsText, "default");
  if (defaultResolvedText != null) {
    return resolveConflictMergeEquivalentWhitespaceText(oursText, baseText, theirsText, defaultResolvedText);
  }
  const wrappedResolvedText = tryResolveConflictMergeWrappedBaseText({
    baseText,
    wrappedText: oursText,
    modifiedText: theirsText,
  }) ?? tryResolveConflictMergeWrappedBaseText({
    baseText,
    wrappedText: theirsText,
    modifiedText: oursText,
  });
  if (wrappedResolvedText != null) return wrappedResolvedText;
  if (normalizeConflictMergeTextIgnoringWhitespace(oursText) === normalizeConflictMergeTextIgnoringWhitespace(baseText)) {
    const mergedText = tryResolveConflictMergeWhitespaceOnlyInsertions({
      baseText,
      whitespaceText: oursText,
      contentText: theirsText,
    });
    if (mergedText != null) return mergedText;
  }
  if (normalizeConflictMergeTextIgnoringWhitespace(theirsText) === normalizeConflictMergeTextIgnoringWhitespace(baseText)) {
    const mergedText = tryResolveConflictMergeWhitespaceOnlyInsertions({
      baseText,
      whitespaceText: theirsText,
      contentText: oursText,
    });
    if (mergedText != null) return mergedText;
  }
  const fallbackResolvedText = tryResolveConflictMergeTextWithPolicy(oursText, baseText, theirsText, "ignoreWhitespace");
  if (fallbackResolvedText == null) return null;
  return resolveConflictMergeEquivalentWhitespaceText(oursText, baseText, theirsText, fallbackResolvedText);
}
