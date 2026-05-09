// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Properties 语义合并流程参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 Electron/TypeScript 架构重写。

import type {
  GitConflictMergeSemanticResolver,
  GitConflictMergeSemanticResolverBlockContext,
  GitConflictMergeSemanticResolverFileContext,
  GitConflictMergeSemanticResolverRange,
} from "./conflictMergeSemantic";
import { normalizeConflictMergeText, splitConflictMergeLineTokens } from "./conflictMergeShared";

type PropertiesPropertyInfo = {
  rawKey: string;
  rawValue: string;
  normalizedKey: string;
  normalizedValue: string;
  commentText: string | null;
  commentStartLine: number | null;
  propertyStartLine: number;
  propertyEndLine: number;
  borderStartLine: number;
  previousPropertyEndLine: number;
};

type PropertiesParsedFile = {
  lines: string[];
  properties: PropertiesPropertyInfo[];
  keySet: Set<string>;
};

type PropertiesConflictInfoHolder = {
  left: PropertiesSideConflictInfo;
  base: PropertiesSideConflictInfo;
  right: PropertiesSideConflictInfo;
};

type PropertiesSideConflictInfo = {
  lines: string[];
  rangeList: GitConflictMergeSemanticResolverRange[];
  keySet: Set<string>;
  conflictToPropertiesMap: Map<number, Map<string, PropertiesPropertyInfo>>;
};

/**
 * 内建 `.properties` semantic resolver 的稳定标识，供 metadata 与测试统一断言。
 */
export const CONFLICT_MERGE_PROPERTIES_SEMANTIC_RESOLVER_ID = "properties";

/**
 * 判断当前路径是否为 `.properties` 文件，保持与 IDEA language 级别选择器的最小等价语义。
 */
function isPropertiesSemanticPath(path: string): boolean {
  return /\.properties$/i.test(String(path || "").trim());
}

/**
 * 去掉逐行 token 末尾的 LF，便于按 Java properties 的“物理行”规则继续解析。
 */
function stripPropertiesLineEnding(lineToken: string): string {
  return lineToken.endsWith("\n") ? lineToken.slice(0, -1) : lineToken;
}

/**
 * 把文本标准化为 properties 解析所需的物理行列表，统一复用到三方文件扫描。
 */
function buildPropertiesPhysicalLines(text: string): string[] {
  return splitConflictMergeLineTokens(normalizeConflictMergeText(text)).map(stripPropertiesLineEnding);
}

/**
 * 判断物理行末尾是否存在奇数个反斜杠，从而决定 logical line 是否继续向下拼接。
 */
function hasPropertiesLineContinuation(line: string): boolean {
  let count = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1)
    count += 1;
  return count % 2 === 1;
}

/**
 * 按 Java properties 规则跳过 `\` 引出的转义序列，并正确吞掉续行后的前导空白。
 */
function skipPropertiesEscapedSequence(text: string, index: number): number {
  if (text[index] !== "\\") return index + 1;
  const next = text[index + 1];
  if (next === "\r" && text[index + 2] === "\n") {
    let cursor = index + 3;
    while (cursor < text.length && /[ \t\f]/.test(text[cursor]))
      cursor += 1;
    return cursor;
  }
  if (next === "\n" || next === "\r") {
    let cursor = index + 2;
    while (cursor < text.length && /[ \t\f]/.test(text[cursor]))
      cursor += 1;
    return cursor;
  }
  return Math.min(text.length, index + 2);
}

/**
 * 判断一个字符是否属于 properties 语法里的空白分隔符。
 */
function isPropertiesWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\f";
}

/**
 * 识别注释行，允许前导空白后再出现 `#`/`!`，贴近 IDEA/Java properties 的解析口径。
 */
function isPropertiesCommentLine(line: string): boolean {
  const trimmed = String(line || "").trimStart();
  return trimmed.startsWith("#") || trimmed.startsWith("!");
}

/**
 * 识别空白行，供注释归属与 split comment 检测复用。
 */
function isPropertiesBlankLine(line: string): boolean {
  return String(line || "").trim().length <= 0;
}

/**
 * 从某个物理行起构造一条 logical line，并保留原始续行文本用于后续格式化输出。
 */
function readPropertiesLogicalLine(lines: string[], startLine: number): { text: string; endLine: number } {
  const parts = [lines[startLine] || ""];
  let endLine = startLine + 1;
  while (endLine < lines.length && hasPropertiesLineContinuation(lines[endLine - 1] || "")) {
    parts.push(lines[endLine] || "");
    endLine += 1;
  }
  return {
    text: parts.join("\n"),
    endLine,
  };
}

/**
 * 按 properties 语法在 logical line 中定位 key/value 的边界，并保留原始 key/value 文本。
 */
function parsePropertiesLogicalProperty(logicalText: string): { rawKey: string; rawValue: string } | null {
  let startIndex = 0;
  while (startIndex < logicalText.length && isPropertiesWhitespace(logicalText[startIndex] || ""))
    startIndex += 1;
  if (startIndex >= logicalText.length) return null;
  const firstChar = logicalText[startIndex] || "";
  if (firstChar === "#" || firstChar === "!") return null;

  let cursor = startIndex;
  let keyEnd = logicalText.length;
  let valueStart = logicalText.length;

  while (cursor < logicalText.length) {
    const current = logicalText[cursor] || "";
    if (current === "\\") {
      cursor = skipPropertiesEscapedSequence(logicalText, cursor);
      continue;
    }
    if (current === "=" || current === ":") {
      keyEnd = cursor;
      valueStart = cursor + 1;
      break;
    }
    if (isPropertiesWhitespace(current)) {
      keyEnd = cursor;
      valueStart = cursor + 1;
      while (valueStart < logicalText.length && isPropertiesWhitespace(logicalText[valueStart] || ""))
        valueStart += 1;
      if ((logicalText[valueStart] || "") === "=" || (logicalText[valueStart] || "") === ":") {
        valueStart += 1;
        while (valueStart < logicalText.length && isPropertiesWhitespace(logicalText[valueStart] || ""))
          valueStart += 1;
      }
      break;
    }
    cursor += 1;
  }

  return {
    rawKey: logicalText.slice(startIndex, keyEnd),
    rawValue: logicalText.slice(valueStart),
  };
}

/**
 * 对 key/value 执行 Java properties 风格反转义，供 key 唯一性与 value 等值比较使用。
 */
function unescapePropertiesText(text: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    const current = text[cursor] || "";
    if (current !== "\\") {
      result += current;
      cursor += 1;
      continue;
    }

    const next = text[cursor + 1] || "";
    if (next === "t") {
      result += "\t";
      cursor += 2;
      continue;
    }
    if (next === "n") {
      result += "\n";
      cursor += 2;
      continue;
    }
    if (next === "r") {
      result += "\r";
      cursor += 2;
      continue;
    }
    if (next === "f") {
      result += "\f";
      cursor += 2;
      continue;
    }
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(cursor + 2, cursor + 6))) {
      result += String.fromCharCode(Number.parseInt(text.slice(cursor + 2, cursor + 6), 16));
      cursor += 6;
      continue;
    }
    if (next === "\r" && text[cursor + 2] === "\n") {
      cursor = skipPropertiesEscapedSequence(text, cursor);
      continue;
    }
    if (next === "\n" || next === "\r") {
      cursor = skipPropertiesEscapedSequence(text, cursor);
      continue;
    }
    if (next) {
      result += next;
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  return result;
}

/**
 * 向上收集紧邻属性的连续注释块；一旦中间出现空行，就视为注释归属已经断开。
 */
function resolvePropertiesCommentStart(lines: string[], propertyStartLine: number, previousPropertyEndLine: number): number | null {
  const immediateLine = propertyStartLine - 1;
  if (immediateLine < previousPropertyEndLine) return null;
  if (!isPropertiesCommentLine(lines[immediateLine] || "")) return null;

  let startLine = immediateLine;
  while (startLine - 1 >= previousPropertyEndLine && isPropertiesCommentLine(lines[startLine - 1] || ""))
    startLine -= 1;
  return startLine;
}

/**
 * 把注释物理行恢复成 resolver 需要的原始注释文本，并补上属性前的换行。
 */
function buildPropertiesCommentText(lines: string[], commentStartLine: number | null, propertyStartLine: number): string | null {
  if (commentStartLine == null) return null;
  return `${lines.slice(commentStartLine, propertyStartLine).join("\n")}\n`;
}

/**
 * 解析整个 `.properties` 文件，提取唯一 key 集、属性文本与注释归属；遇到重复 key 时直接按 IDEA 语义降级为不可解析。
 */
function parsePropertiesFile(text: string): PropertiesParsedFile | null {
  const lines = buildPropertiesPhysicalLines(text);
  const properties: PropertiesPropertyInfo[] = [];
  const keySet = new Set<string>();
  let previousPropertyEndLine = 0;
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor] || "";
    if (isPropertiesBlankLine(line) || isPropertiesCommentLine(line)) {
      cursor += 1;
      continue;
    }

    const logicalLine = readPropertiesLogicalLine(lines, cursor);
    const parsedProperty = parsePropertiesLogicalProperty(logicalLine.text);
    if (!parsedProperty) {
      cursor = logicalLine.endLine;
      continue;
    }

    const normalizedKey = unescapePropertiesText(parsedProperty.rawKey);
    if (keySet.has(normalizedKey)) return null;
    keySet.add(normalizedKey);

    const commentStartLine = resolvePropertiesCommentStart(lines, cursor, previousPropertyEndLine);
    properties.push({
      rawKey: parsedProperty.rawKey,
      rawValue: parsedProperty.rawValue,
      normalizedKey,
      normalizedValue: unescapePropertiesText(parsedProperty.rawValue),
      commentText: buildPropertiesCommentText(lines, commentStartLine, cursor),
      commentStartLine,
      propertyStartLine: cursor,
      propertyEndLine: logicalLine.endLine,
      borderStartLine: commentStartLine ?? cursor,
      previousPropertyEndLine,
    });

    previousPropertyEndLine = logicalLine.endLine;
    cursor = logicalLine.endLine;
  }

  return {
    lines,
    properties,
    keySet,
  };
}

/**
 * 判断两个半开区间是否有交集，统一复用到属性命中与注释越界判断。
 */
function intersectsPropertiesRange(left: GitConflictMergeSemanticResolverRange, start: number, end: number): boolean {
  return start < left.end && end > left.start;
}

/**
 * 把某一侧文件与全部 chunk range 绑定起来，得到“chunk -> properties”映射。
 */
function buildPropertiesSideConflictInfo(
  parsedFile: PropertiesParsedFile,
  rangeList: GitConflictMergeSemanticResolverRange[],
): PropertiesSideConflictInfo {
  const conflictToPropertiesMap = new Map<number, Map<string, PropertiesPropertyInfo>>();
  for (const property of parsedFile.properties) {
    rangeList.forEach((range, index) => {
      if (!intersectsPropertiesRange(range, property.propertyStartLine, property.propertyEndLine)) return;
      const currentMap = conflictToPropertiesMap.get(index) || new Map<string, PropertiesPropertyInfo>();
      currentMap.set(property.normalizedKey, property);
      conflictToPropertiesMap.set(index, currentMap);
    });
  }
  return {
    lines: parsedFile.lines,
    rangeList,
    keySet: parsedFile.keySet,
    conflictToPropertiesMap,
  };
}

/**
 * 按当前三方文件与 chunk ranges 构造等价于 IDEA `ThreeSideConflictInfoHolder` 的简化持有器。
 */
function createPropertiesConflictInfoHolder(context: GitConflictMergeSemanticResolverFileContext): PropertiesConflictInfoHolder | null {
  const leftFile = parsePropertiesFile(context.oursText);
  const baseFile = parsePropertiesFile(context.baseText);
  const rightFile = parsePropertiesFile(context.theirsText);
  if (!leftFile || !baseFile || !rightFile) return null;

  return {
    left: buildPropertiesSideConflictInfo(leftFile, context.blocks.map((block) => block.oursRange)),
    base: buildPropertiesSideConflictInfo(baseFile, context.blocks.map((block) => block.baseRange)),
    right: buildPropertiesSideConflictInfo(rightFile, context.blocks.map((block) => block.theirsRange)),
  };
}

/**
 * 读取指定 chunk 在三侧命中的 property map，保持后续 filter 逻辑只处理当前块关心的数据。
 */
function getPropertiesConflictMaps(holder: PropertiesConflictInfoHolder, index: number): {
  leftMap: Map<string, PropertiesPropertyInfo>;
  baseMap: Map<string, PropertiesPropertyInfo>;
  rightMap: Map<string, PropertiesPropertyInfo>;
} {
  return {
    leftMap: holder.left.conflictToPropertiesMap.get(index) || new Map<string, PropertiesPropertyInfo>(),
    baseMap: holder.base.conflictToPropertiesMap.get(index) || new Map<string, PropertiesPropertyInfo>(),
    rightMap: holder.right.conflictToPropertiesMap.get(index) || new Map<string, PropertiesPropertyInfo>(),
  };
}

/**
 * 参考上游 `OUTSIDE_INTERSECTIONS`，防止把与文件其他位置同 key 的属性错误折进当前块。
 */
function hasPropertiesOutsideIntersection(
  currentMap: Map<string, PropertiesPropertyInfo>,
  baseMap: Map<string, PropertiesPropertyInfo>,
  oppositeMap: Map<string, PropertiesPropertyInfo>,
  holder: PropertiesConflictInfoHolder,
  oppositeSide: "left" | "right",
): boolean {
  for (const key of currentMap.keys()) {
    if (!oppositeMap.has(key) && holder[oppositeSide].keySet.has(key)) return true;
    if (!baseMap.has(key) && holder.base.keySet.has(key)) return true;
  }
  return false;
}

/**
 * 参考上游 `INNER_INCONSISTENCY`，阻止 base 中同组属性只在单侧局部出现时被误判为可合并。
 */
function hasPropertiesInnerInconsistency(
  leftMap: Map<string, PropertiesPropertyInfo>,
  baseMap: Map<string, PropertiesPropertyInfo>,
  rightMap: Map<string, PropertiesPropertyInfo>,
): boolean {
  for (const key of baseMap.keys()) {
    if ((leftMap.has(key) && !rightMap.has(key)) || (!leftMap.has(key) && rightMap.has(key)))
      return true;
  }
  return false;
}

/**
 * 判断指定行区间内是否存在落在 chunk 内的非空白内容，用于 split comment 检测。
 */
function hasPropertiesNonBlankLineIntersection(
  lines: string[],
  startLine: number,
  endLine: number,
  conflictRange: GitConflictMergeSemanticResolverRange,
): boolean {
  for (let line = startLine; line < endLine; line += 1) {
    if (!intersectsPropertiesRange(conflictRange, line, line + 1)) continue;
    if (!isPropertiesBlankLine(lines[line] || "")) return true;
  }
  return false;
}

/**
 * 判断属性的注释边界是否已经越过当前 chunk 起点，贴近 IDEA `borderElement !in conflictRange` 的首层守卫。
 */
function hasPropertiesCommentBorderOutsideConflict(
  property: PropertiesPropertyInfo,
  conflictRange: GitConflictMergeSemanticResolverRange,
): boolean {
  return property.commentStartLine != null && property.commentStartLine < conflictRange.start;
}

/**
 * 判断属性与前一个 property 之间是否存在落入当前 chunk 的非空白内容，贴近 IDEA `findSiblingBackward` 的 split comment 检测。
 */
function hasPropertiesCommentBodyIntersection(
  lines: string[],
  property: PropertiesPropertyInfo,
  conflictRange: GitConflictMergeSemanticResolverRange,
): boolean {
  return hasPropertiesNonBlankLineIntersection(
    lines,
    property.previousPropertyEndLine,
    property.borderStartLine,
    conflictRange,
  );
}

/**
 * 参考上游 `COMMENT_INTERSECTIONS`，要求属性注释必须完整落在当前 chunk 内，且不能被其他 comment/内容割裂。
 */
function hasPropertiesCommentIntersection(
  holder: PropertiesConflictInfoHolder,
  side: "left" | "right",
  index: number,
): boolean {
  const sideInfo = holder[side];
  const conflictRange = sideInfo.rangeList[index] || { start: 0, end: 0 };
  const propertyMap = sideInfo.conflictToPropertiesMap.get(index) || new Map<string, PropertiesPropertyInfo>();
  for (const property of propertyMap.values()) {
    if (hasPropertiesCommentBorderOutsideConflict(property, conflictRange)) return true;
    if (hasPropertiesCommentBodyIntersection(sideInfo.lines, property, conflictRange)) return true;
  }
  return false;
}

/**
 * 参考上游 `COMMENT_INCONSISTENCY`，只要 base comment 存在且两侧一有一无，就禁止语义合并。
 */
function hasPropertiesCommentInconsistency(
  currentMap: Map<string, PropertiesPropertyInfo>,
  baseMap: Map<string, PropertiesPropertyInfo>,
  oppositeMap: Map<string, PropertiesPropertyInfo>,
): boolean {
  for (const [key, currentInfo] of currentMap.entries()) {
    const baseInfo = baseMap.get(key);
    const oppositeInfo = oppositeMap.get(key);
    if (!baseInfo || !oppositeInfo) return false;

    const currentComment = currentInfo.commentText;
    const baseComment = baseInfo.commentText;
    const oppositeComment = oppositeInfo.commentText;
    if (baseComment != null && ((currentComment == null && oppositeComment != null) || (currentComment != null && oppositeComment == null)))
      return true;
  }
  return false;
}

/**
 * 把四个官方 filter 串起来，完整决定某个 chunk 是否还能继续进入真正的属性合并阶段。
 */
function canResolvePropertiesConflictSemantically(holder: PropertiesConflictInfoHolder, index: number): boolean {
  const { leftMap, baseMap, rightMap } = getPropertiesConflictMaps(holder, index);
  if (hasPropertiesOutsideIntersection(leftMap, baseMap, rightMap, holder, "right")) return false;
  if (hasPropertiesOutsideIntersection(rightMap, baseMap, leftMap, holder, "left")) return false;
  if (hasPropertiesInnerInconsistency(leftMap, baseMap, rightMap)) return false;
  if (hasPropertiesCommentIntersection(holder, "left", index)) return false;
  if (hasPropertiesCommentIntersection(holder, "right", index)) return false;
  if (hasPropertiesCommentInconsistency(leftMap, baseMap, rightMap)) return false;
  if (hasPropertiesCommentInconsistency(rightMap, baseMap, leftMap)) return false;
  return true;
}

/**
 * 参考上游 `tryMergeProperties`，只在 key 相同、反转义 value 相同、comment 兼容时合并左右属性集合。
 */
function tryMergePropertiesConflict(
  leftMap: Map<string, PropertiesPropertyInfo>,
  rightMap: Map<string, PropertiesPropertyInfo>,
): PropertiesPropertyInfo[] | null {
  const mergedMap = new Map<string, PropertiesPropertyInfo>(leftMap);
  for (const [key, property] of rightMap.entries()) {
    const existingProperty = mergedMap.get(key);
    if (!existingProperty) {
      mergedMap.set(key, property);
      continue;
    }
    if (property.normalizedValue !== existingProperty.normalizedValue) return null;
    if (property.commentText != null && existingProperty.commentText != null && property.commentText !== existingProperty.commentText)
      return null;
    if (property.commentText != null && existingProperty.commentText == null) {
      mergedMap.set(key, {
        ...existingProperty,
        commentText: property.commentText,
      });
    }
  }
  return Array.from(mergedMap.entries())
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([, property]) => property);
}

/**
 * 按当前仓库的最小格式化口径恢复属性文本，默认收敛为 `key=value`，但保留 key-only 与多行 value 原始内容。
 */
function serializePropertiesProperty(property: PropertiesPropertyInfo): string {
  const prefix = property.commentText || "";
  if (property.rawValue.length <= 0) return `${prefix}${property.rawKey}`;
  return `${prefix}${property.rawKey}=${property.rawValue}`;
}

/**
 * 执行 `.properties` 整文件 semantic merge，返回与输入 blocks 对齐的 resolved text 列表。
 */
function resolvePropertiesSemanticBlocks(context: GitConflictMergeSemanticResolverFileContext): Array<string | null> | null {
  const holder = createPropertiesConflictInfoHolder(context);
  if (!holder) return null;

  return context.blocks.map((block, index) => {
    if (block.kind !== "conflict") return null;
    if (!canResolvePropertiesConflictSemantically(holder, index)) return null;
    const { leftMap, rightMap } = getPropertiesConflictMaps(holder, index);
    const mergedProperties = tryMergePropertiesConflict(leftMap, rightMap);
    if (!mergedProperties) return null;
    return mergedProperties.map(serializePropertiesProperty).join("\n");
  });
}

/**
 * 导出真实 `.properties` semantic resolver，并接入当前仓库的统一 registry。
 */
export const conflictMergePropertiesSemanticResolver: GitConflictMergeSemanticResolver = {
  id: CONFLICT_MERGE_PROPERTIES_SEMANTIC_RESOLVER_ID,
  isApplicable(path: string): boolean {
    return isPropertiesSemanticPath(path);
  },
  resolveAll(context: GitConflictMergeSemanticResolverFileContext): Array<string | null> | null {
    return resolvePropertiesSemanticBlocks(context);
  },
  resolve(context: GitConflictMergeSemanticResolverBlockContext): string | null {
    const result = resolvePropertiesSemanticBlocks({
      path: context.path,
      baseText: context.baseText,
      oursText: context.oursText,
      theirsText: context.theirsText,
      resultText: context.resultText,
      blocks: [context],
    });
    return result?.[0] ?? null;
  },
};
