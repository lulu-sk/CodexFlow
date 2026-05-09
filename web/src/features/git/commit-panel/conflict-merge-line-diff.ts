// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Diff/Merge 行级比较流程参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 React/TypeScript 架构重写。

export type ConflictMergeRange = {
  oursStart: number;
  oursEnd: number;
  baseStart: number;
  baseEnd: number;
  theirsStart: number;
  theirsEnd: number;
};

type ConflictMergeComparisonPolicy = "default" | "ignoreWhitespace";

type ConflictMergePairRange = {
  start1: number;
  end1: number;
  start2: number;
  end2: number;
};

type ConflictMergeFairDiff = {
  length1: number;
  length2: number;
  equalRanges: ConflictMergePairRange[];
};

type ConflictMergeDiffOperation = {
  type: "equal" | "delete" | "insert";
};

type ConflictMergeComparisonLine = {
  content: string;
  normalized: string;
  policy: ConflictMergeComparisonPolicy;
  nonSpaceChars: number;
};

type ConflictMergeEqualRangeBuilder<T> = {
  length1: number;
  length2: number;
  index1: number;
  index2: number;
  equalRanges: ConflictMergePairRange[];
  expandGapEquals: boolean;
  objects1: T[];
  objects2: T[];
  isEqual: (left: T, right: T) => boolean;
};

const CONFLICT_MERGE_DIFF_MATRIX_CELL_LIMIT = 4_000_000;
const CONFLICT_MERGE_UNIMPORTANT_LINE_CHAR_COUNT = 3;

/**
 * 去掉逐行 token 末尾的换行符，让行比较语义与 IDEA `LineOffsets.getLineEnd()` 一致。
 */
function stripConflictMergeTokenLineEnding(token: string): string {
  return String(token || "").endsWith("\n")
    ? String(token).slice(0, -1)
    : String(token || "");
}

/**
 * 按比较策略归一化单行文本；当前仅覆盖 merge viewer 用到的默认与忽略空白两种模式。
 */
function normalizeConflictMergeLineForPolicy(
  content: string,
  policy: ConflictMergeComparisonPolicy,
): string {
  if (policy === "ignoreWhitespace") {
    return String(content || "").replace(/[ \t\f\v\r]+/g, "");
  }
  return String(content || "");
}

/**
 * 统计一行中非空白字符数量，供 IDEA `unimportant line` 阈值裁剪复用。
 */
function countConflictMergeNonSpaceChars(content: string): number {
  let count = 0;
  for (const one of String(content || "")) {
    if (one !== " " && one !== "\t" && one !== "\n" && one !== "\r") count += 1;
  }
  return count;
}

/**
 * 把 merge token 转成可复用的比较行对象，统一承载精确比较、忽略空白比较和块优化元数据。
 */
function createConflictMergeComparisonLines(
  tokens: string[],
  policy: ConflictMergeComparisonPolicy,
): ConflictMergeComparisonLine[] {
  return tokens.map((token) => {
    const content = stripConflictMergeTokenLineEnding(token);
    return {
      content,
      normalized: normalizeConflictMergeLineForPolicy(content, policy),
      policy,
      nonSpaceChars: countConflictMergeNonSpaceChars(content),
    };
  });
}

/**
 * 切换比较策略时重建行对象，避免在 exact/IW 两条路径间共享错误的归一化结果。
 */
function convertConflictMergeComparisonLinePolicy(
  lines: ConflictMergeComparisonLine[],
  policy: ConflictMergeComparisonPolicy,
): ConflictMergeComparisonLine[] {
  return lines.map((line) => ({
    content: line.content,
    normalized: normalizeConflictMergeLineForPolicy(line.content, policy),
    policy,
    nonSpaceChars: line.nonSpaceChars,
  }));
}

/**
 * 判断两行在当前策略下是否相等；与 IDEA `Line.equals` 的职责保持一致。
 */
function isConflictMergeComparisonLineEqual(
  left: ConflictMergeComparisonLine | null | undefined,
  right: ConflictMergeComparisonLine | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.policy === right.policy && left.normalized === right.normalized;
}

/**
 * 判断两段文本是否按“忽略空白”规则相等，供二次校正步骤中的 sample 分桶复用。
 */
function isConflictMergeTextEqualIgnoringWhitespace(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left == null || right == null) return false;
  return normalizeConflictMergeLineForPolicy(left, "ignoreWhitespace")
    === normalizeConflictMergeLineForPolicy(right, "ignoreWhitespace");
}

/**
 * 在规模可控时用动态规划生成稳定的编辑脚本，减少重复行场景下的块抖动。
 */
function buildConflictMergeDynamicDiffOperations<T>(
  left: T[],
  right: T[],
  isEqual: (one: T, another: T) => boolean,
): ConflictMergeDiffOperation[] {
  const leftLength = left.length;
  const rightLength = right.length;
  const table = Array.from({ length: leftLength + 1 }, () => new Uint32Array(rightLength + 1));

  for (let leftIndex = 1; leftIndex <= leftLength; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= rightLength; rightIndex += 1) {
      table[leftIndex][rightIndex] = isEqual(left[leftIndex - 1], right[rightIndex - 1])
        ? table[leftIndex - 1][rightIndex - 1] + 1
        : Math.max(table[leftIndex - 1][rightIndex], table[leftIndex][rightIndex - 1]);
    }
  }

  const operations: ConflictMergeDiffOperation[] = [];
  let leftIndex = leftLength;
  let rightIndex = rightLength;
  while (leftIndex > 0 && rightIndex > 0) {
    if (isEqual(left[leftIndex - 1], right[rightIndex - 1])) {
      operations.push({ type: "equal" });
      leftIndex -= 1;
      rightIndex -= 1;
      continue;
    }
    if (table[leftIndex - 1][rightIndex] >= table[leftIndex][rightIndex - 1]) {
      operations.push({ type: "delete" });
      leftIndex -= 1;
      continue;
    }
    operations.push({ type: "insert" });
    rightIndex -= 1;
  }
  while (leftIndex > 0) {
    operations.push({ type: "delete" });
    leftIndex -= 1;
  }
  while (rightIndex > 0) {
    operations.push({ type: "insert" });
    rightIndex -= 1;
  }
  return operations.reverse();
}

/**
 * 在大输入场景下用 Myers 最短编辑脚本回退，避免三方大文件比较被 O(n*m) 撑爆。
 */
function buildConflictMergeMyersDiffOperations<T>(
  left: T[],
  right: T[],
  isEqual: (one: T, another: T) => boolean,
): ConflictMergeDiffOperation[] {
  const leftLength = left.length;
  const rightLength = right.length;
  const maxDepth = leftLength + rightLength;
  const offset = maxDepth;
  const vector = new Array<number>((maxDepth * 2) + 1).fill(0);
  const trace: number[][] = [];

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const previousVector = vector.slice();
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const index = offset + diagonal;
      const goDown = diagonal === -depth
        || (diagonal !== depth && previousVector[index - 1] < previousVector[index + 1]);
      let leftIndex = goDown ? previousVector[index + 1] : previousVector[index - 1] + 1;
      let rightIndex = leftIndex - diagonal;
      while (leftIndex < leftLength
        && rightIndex < rightLength
        && isEqual(left[leftIndex], right[rightIndex])) {
        leftIndex += 1;
        rightIndex += 1;
      }
      vector[index] = leftIndex;
      if (leftIndex >= leftLength && rightIndex >= rightLength) {
        trace.push(vector.slice());
        return buildConflictMergeMyersDiffOperationsFromTrace(trace, left, right, isEqual);
      }
    }
    trace.push(vector.slice());
  }

  return [];
}

/**
 * 根据 Myers trace 回放逐步操作序列，供后续压成 fair equal ranges 复用。
 */
function buildConflictMergeMyersDiffOperationsFromTrace<T>(
  trace: number[][],
  left: T[],
  right: T[],
  isEqual: (one: T, another: T) => boolean,
): ConflictMergeDiffOperation[] {
  const leftLength = left.length;
  const rightLength = right.length;
  const maxDepth = leftLength + rightLength;
  const offset = maxDepth;
  const operations: ConflictMergeDiffOperation[] = [];
  let leftIndex = leftLength;
  let rightIndex = rightLength;

  for (let depth = trace.length - 1; depth > 0; depth -= 1) {
    const vector = trace[depth - 1];
    const diagonal = leftIndex - rightIndex;
    const goDown = diagonal === -depth
      || (diagonal !== depth && vector[offset + diagonal - 1] < vector[offset + diagonal + 1]);
    const previousDiagonal = goDown ? diagonal + 1 : diagonal - 1;
    const previousLeftIndex = vector[offset + previousDiagonal];
    const previousRightIndex = previousLeftIndex - previousDiagonal;

    while (leftIndex > previousLeftIndex && rightIndex > previousRightIndex) {
      operations.push({ type: "equal" });
      leftIndex -= 1;
      rightIndex -= 1;
    }

    if (goDown) {
      operations.push({ type: "insert" });
      rightIndex -= 1;
    } else {
      operations.push({ type: "delete" });
      leftIndex -= 1;
    }
  }

  while (leftIndex > 0 && rightIndex > 0) {
    if (!isEqual(left[leftIndex - 1], right[rightIndex - 1])) break;
    operations.push({ type: "equal" });
    leftIndex -= 1;
    rightIndex -= 1;
  }
  while (leftIndex > 0) {
    operations.push({ type: "delete" });
    leftIndex -= 1;
  }
  while (rightIndex > 0) {
    operations.push({ type: "insert" });
    rightIndex -= 1;
  }

  return operations.reverse();
}

/**
 * 裁掉公共前后缀后再选 diff 算法，参考上游 line compare 常见路径里的性能折中。
 */
function buildConflictMergeDiffOperations<T>(
  left: T[],
  right: T[],
  isEqual: (one: T, another: T) => boolean,
): ConflictMergeDiffOperation[] {
  let prefixLength = 0;
  while (prefixLength < left.length
    && prefixLength < right.length
    && isEqual(left[prefixLength], right[prefixLength])) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (suffixLength < left.length - prefixLength
    && suffixLength < right.length - prefixLength
    && isEqual(left[left.length - 1 - suffixLength], right[right.length - 1 - suffixLength])) {
    suffixLength += 1;
  }

  const middleLeft = left.slice(prefixLength, left.length - suffixLength);
  const middleRight = right.slice(prefixLength, right.length - suffixLength);
  const middleCellCount = middleLeft.length * middleRight.length;
  const middleOperations = middleCellCount <= CONFLICT_MERGE_DIFF_MATRIX_CELL_LIMIT
    ? buildConflictMergeDynamicDiffOperations(middleLeft, middleRight, isEqual)
    : buildConflictMergeMyersDiffOperations(middleLeft, middleRight, isEqual);

  return [
    ...new Array<ConflictMergeDiffOperation>(prefixLength).fill({ type: "equal" }),
    ...middleOperations,
    ...new Array<ConflictMergeDiffOperation>(suffixLength).fill({ type: "equal" }),
  ];
}

/**
 * 创建 fair diff equal range builder；可选开启 gap trimming，参考上游 `ExpandChangeBuilder`。
 */
function createConflictMergeEqualRangeBuilder<T>(args: {
  length1: number;
  length2: number;
  expandGapEquals?: boolean;
  objects1?: T[];
  objects2?: T[];
  isEqual?: (left: T, right: T) => boolean;
}): ConflictMergeEqualRangeBuilder<T> {
  return {
    length1: args.length1,
    length2: args.length2,
    index1: 0,
    index2: 0,
    equalRanges: [],
    expandGapEquals: args.expandGapEquals === true,
    objects1: args.objects1 || [],
    objects2: args.objects2 || [],
    isEqual: args.isEqual || ((left, right) => left === right),
  };
}

/**
 * 把 contiguous equal range 合并入 builder，维持 fair diff 所需的最小块数量。
 */
function pushConflictMergeEqualRange<T>(
  builder: ConflictMergeEqualRangeBuilder<T>,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
): void {
  if (start1 === end1 && start2 === end2) return;
  const last = builder.equalRanges[builder.equalRanges.length - 1];
  if (last && last.end1 === start1 && last.end2 === start2) {
    last.end1 = end1;
    last.end2 = end2;
    return;
  }
  builder.equalRanges.push({ start1, end1, start2, end2 });
}

/**
 * 裁掉 change gap 两端已经完全相等的前后缀，参考上游 `TrimUtil.expand` 在 line diff 里的语义。
 */
function trimConflictMergeEqualEdges<T>(
  objects1: T[],
  objects2: T[],
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  isEqual: (left: T, right: T) => boolean,
): ConflictMergePairRange {
  let nextStart1 = start1;
  let nextStart2 = start2;
  let nextEnd1 = end1;
  let nextEnd2 = end2;

  while (nextStart1 < nextEnd1
    && nextStart2 < nextEnd2
    && isEqual(objects1[nextStart1], objects2[nextStart2])) {
    nextStart1 += 1;
    nextStart2 += 1;
  }
  while (nextStart1 < nextEnd1
    && nextStart2 < nextEnd2
    && isEqual(objects1[nextEnd1 - 1], objects2[nextEnd2 - 1])) {
    nextEnd1 -= 1;
    nextEnd2 -= 1;
  }

  return {
    start1: nextStart1,
    end1: nextEnd1,
    start2: nextStart2,
    end2: nextEnd2,
  };
}

/**
 * 在开启 gap trimming 时，把 gap 两端的真实 equal 前后缀补回 equal ranges。
 */
function emitConflictMergeGapEquals<T>(
  builder: ConflictMergeEqualRangeBuilder<T>,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
): void {
  const trimmed = trimConflictMergeEqualEdges(
    builder.objects1,
    builder.objects2,
    start1,
    start2,
    end1,
    end2,
    builder.isEqual,
  );
  pushConflictMergeEqualRange(builder, start1, start2, trimmed.start1, trimmed.start2);
  pushConflictMergeEqualRange(builder, trimmed.end1, trimmed.end2, end1, end2);
}

/**
 * 向 builder 写入一个 equal range；必要时先把 gap 里的公共前后缀回补成 equal ranges。
 */
function markConflictMergeEqualRange<T>(
  builder: ConflictMergeEqualRangeBuilder<T>,
  start1: number,
  start2: number,
  end1: number,
  end2: number,
): void {
  if (start1 === end1 && start2 === end2) return;
  if (builder.expandGapEquals && (builder.index1 !== start1 || builder.index2 !== start2)) {
    emitConflictMergeGapEquals(builder, builder.index1, builder.index2, start1, start2);
  }
  pushConflictMergeEqualRange(builder, start1, start2, end1, end2);
  builder.index1 = end1;
  builder.index2 = end2;
}

/**
 * 收口 equal range builder，确保最后一个 gap 在 ExpandChangeBuilder 模式下也会补回公共前后缀。
 */
function finishConflictMergeEqualRangeBuilder<T>(
  builder: ConflictMergeEqualRangeBuilder<T>,
): ConflictMergeFairDiff {
  if (builder.expandGapEquals && (builder.index1 !== builder.length1 || builder.index2 !== builder.length2)) {
    emitConflictMergeGapEquals(builder, builder.index1, builder.index2, builder.length1, builder.length2);
  }
  builder.index1 = builder.length1;
  builder.index2 = builder.length2;
  return {
    length1: builder.length1,
    length2: builder.length2,
    equalRanges: builder.equalRanges,
  };
}

/**
 * 把基础 diff 操作压成 fair equal ranges，作为后续 smart corrector 与 merge builder 的统一输入。
 */
function buildConflictMergeFairDiff<T>(
  left: T[],
  right: T[],
  isEqual: (one: T, another: T) => boolean,
): ConflictMergeFairDiff {
  const operations = buildConflictMergeDiffOperations(left, right, isEqual);
  const builder = createConflictMergeEqualRangeBuilder<T>({
    length1: left.length,
    length2: right.length,
    isEqual,
  });
  let leftIndex = 0;
  let rightIndex = 0;
  let runStart1 = 0;
  let runStart2 = 0;
  let inEqualRun = false;

  /**
   * 把累计的 equal run 写入 builder，并清空当前 run 状态。
   */
  const flushEqualRun = (): void => {
    if (!inEqualRun) return;
    markConflictMergeEqualRange(builder, runStart1, runStart2, leftIndex, rightIndex);
    inEqualRun = false;
  };

  for (const operation of operations) {
    if (operation.type === "equal") {
      if (!inEqualRun) {
        runStart1 = leftIndex;
        runStart2 = rightIndex;
        inEqualRun = true;
      }
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    flushEqualRun();
    if (operation.type === "delete") leftIndex += 1;
    else rightIndex += 1;
  }
  flushEqualRun();
  return finishConflictMergeEqualRangeBuilder(builder);
}

/**
 * 提取“大行”集合，参考上游 `compareSmart` 里先用重要行建立骨架的策略。
 */
function getConflictMergeBigLines(
  lines: ConflictMergeComparisonLine[],
): { lines: ConflictMergeComparisonLine[]; indexes: number[] } {
  const importantLines: ConflictMergeComparisonLine[] = [];
  const indexes: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.nonSpaceChars > CONFLICT_MERGE_UNIMPORTANT_LINE_CHAR_COUNT) {
      importantLines.push(lines[index]!);
      indexes.push(index);
    }
  }
  return { lines: importantLines, indexes };
}

/**
 * 对 change gap 做一次局部 exact diff，并把 gap 里真正相等的前后缀和内部 equal 行回写到 builder。
 */
function matchConflictMergeGap<T>(args: {
  builder: ConflictMergeEqualRangeBuilder<T>;
  objects1: T[];
  objects2: T[];
  start1: number;
  end1: number;
  start2: number;
  end2: number;
  isEqual: (left: T, right: T) => boolean;
}): void {
  const trimmed = trimConflictMergeEqualEdges(
    args.objects1,
    args.objects2,
    args.start1,
    args.start2,
    args.end1,
    args.end2,
    args.isEqual,
  );
  markConflictMergeEqualRange(
    args.builder,
    args.start1,
    args.start2,
    trimmed.start1,
    trimmed.start2,
  );
  const innerDiff = buildConflictMergeFairDiff(
    args.objects1.slice(trimmed.start1, trimmed.end1),
    args.objects2.slice(trimmed.start2, trimmed.end2),
    args.isEqual,
  );
  for (const range of innerDiff.equalRanges) {
    markConflictMergeEqualRange(
      args.builder,
      trimmed.start1 + range.start1,
      trimmed.start2 + range.start2,
      trimmed.start1 + range.end1,
      trimmed.start2 + range.end2,
    );
  }
  markConflictMergeEqualRange(
    args.builder,
    trimmed.end1,
    trimmed.end2,
    args.end1,
    args.end2,
  );
}

/**
 * 把大行 diff 投影回完整行序列，参考上游 `SmartLineChangeCorrector` 的纠偏路径。
 */
function buildConflictMergeSmartLineDiff(
  lines1: ConflictMergeComparisonLine[],
  lines2: ConflictMergeComparisonLine[],
): ConflictMergeFairDiff {
  const bigLines1 = getConflictMergeBigLines(lines1);
  const bigLines2 = getConflictMergeBigLines(lines2);
  const bigDiff = buildConflictMergeFairDiff(
    bigLines1.lines,
    bigLines2.lines,
    isConflictMergeComparisonLineEqual,
  );
  const builder = createConflictMergeEqualRangeBuilder<ConflictMergeComparisonLine>({
    length1: lines1.length,
    length2: lines2.length,
    objects1: lines1,
    objects2: lines2,
    isEqual: isConflictMergeComparisonLineEqual,
  });
  let last1 = 0;
  let last2 = 0;

  for (const range of bigDiff.equalRanges) {
    const count = range.end1 - range.start1;
    for (let offset = 0; offset < count; offset += 1) {
      const start1 = bigLines1.indexes[range.start1 + offset] || 0;
      const start2 = bigLines2.indexes[range.start2 + offset] || 0;
      const end1 = start1 + 1;
      const end2 = start2 + 1;
      matchConflictMergeGap({
        builder,
        objects1: lines1,
        objects2: lines2,
        start1: last1,
        end1: start1,
        start2: last2,
        end2: start2,
        isEqual: isConflictMergeComparisonLineEqual,
      });
      markConflictMergeEqualRange(builder, start1, start2, end1, end2);
      last1 = end1;
      last2 = end2;
    }
  }

  matchConflictMergeGap({
    builder,
    objects1: lines1,
    objects2: lines2,
    start1: last1,
    end1: lines1.length,
    start2: last2,
    end2: lines2.length,
    isEqual: isConflictMergeComparisonLineEqual,
  });
  return finishConflictMergeEqualRangeBuilder(builder);
}

/**
 * 计算两段等长观察窗口的公共前缀长度，参考上游 `TrimUtil.expandForward` 的块优化辅助逻辑。
 */
function countConflictMergeForwardEquals<T>(
  objects1: T[],
  objects2: T[],
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  isEqual: (left: T, right: T) => boolean,
): number {
  let next1 = start1;
  let next2 = start2;
  while (next1 < end1 && next2 < end2 && isEqual(objects1[next1]!, objects2[next2]!)) {
    next1 += 1;
    next2 += 1;
  }
  return next1 - start1;
}

/**
 * 计算两段观察窗口的公共后缀长度，供行块边界平移时判断能否合并或偏移。
 */
function countConflictMergeBackwardEquals<T>(
  objects1: T[],
  objects2: T[],
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  isEqual: (left: T, right: T) => boolean,
): number {
  let nextEnd1 = end1;
  let nextEnd2 = end2;
  while (start1 < nextEnd1
    && start2 < nextEnd2
    && isEqual(objects1[nextEnd1 - 1]!, objects2[nextEnd2 - 1]!)) {
    nextEnd1 -= 1;
    nextEnd2 -= 1;
  }
  return end1 - nextEnd1;
}

/**
 * 在指定观察窗口内寻找下一个“不重要行”，用于把插入/删除边界吸附到更稳的空白位置。
 */
function findNextConflictMergeUnimportantLine(
  lines: ConflictMergeComparisonLine[],
  offset: number,
  count: number,
  threshold: number,
): number {
  for (let index = 0; index < count; index += 1) {
    if ((lines[offset + index]?.nonSpaceChars || 0) <= threshold) return index;
  }
  return -1;
}

/**
 * 向后查找上一个“不重要行”，与前向查找一起决定 chunk shift 方向。
 */
function findPreviousConflictMergeUnimportantLine(
  lines: ConflictMergeComparisonLine[],
  offset: number,
  count: number,
  threshold: number,
): number {
  for (let index = 0; index < count; index += 1) {
    if ((lines[offset - index]?.nonSpaceChars || 0) <= threshold) return index;
  }
  return -1;
}

/**
 * 把前向/后向候选 shift 合成最终偏移量，参考上游 `LineChunkOptimizer.getShift`。
 */
function resolveConflictMergeChunkShift(
  shiftForward: number,
  shiftBackward: number,
): number | null {
  if (shiftForward === -1 && shiftBackward === -1) return null;
  if (shiftForward === 0 || shiftBackward === 0) return 0;
  return shiftForward !== -1 ? shiftForward : -shiftBackward;
}

/**
 * 在 unchanged 区域中寻找更稳定的空白边界，让块在折叠未改动片段时更接近 IDEA 的块感知。
 */
function getConflictMergeUnchangedBoundaryShift(args: {
  touchSide: "left" | "right";
  lines1: ConflictMergeComparisonLine[];
  lines2: ConflictMergeComparisonLine[];
  equalForward: number;
  equalBackward: number;
  range1: ConflictMergePairRange;
  range2: ConflictMergePairRange;
  threshold: number;
}): number | null {
  const touchLines = args.touchSide === "left" ? args.lines1 : args.lines2;
  const touchStart = args.touchSide === "left" ? args.range2.start1 : args.range2.start2;
  const shiftForward = findNextConflictMergeUnimportantLine(
    touchLines,
    touchStart,
    args.equalForward + 1,
    args.threshold,
  );
  const shiftBackward = findPreviousConflictMergeUnimportantLine(
    touchLines,
    touchStart - 1,
    args.equalBackward + 1,
    args.threshold,
  );
  return resolveConflictMergeChunkShift(shiftForward, shiftBackward);
}

/**
 * 在 changed 区域中寻找更稳定的空白边界，让删除/插入优先包住空白或短行。
 */
function getConflictMergeChangedBoundaryShift(args: {
  touchSide: "left" | "right";
  lines1: ConflictMergeComparisonLine[];
  lines2: ConflictMergeComparisonLine[];
  equalForward: number;
  equalBackward: number;
  range1: ConflictMergePairRange;
  range2: ConflictMergePairRange;
  threshold: number;
}): number | null {
  const nonTouchLines = args.touchSide === "left" ? args.lines2 : args.lines1;
  const changeStart = args.touchSide === "left" ? args.range1.end2 : args.range1.end1;
  const changeEnd = args.touchSide === "left" ? args.range2.start2 : args.range2.start1;
  const shiftForward = findNextConflictMergeUnimportantLine(
    nonTouchLines,
    changeStart,
    args.equalForward + 1,
    args.threshold,
  );
  const shiftBackward = findPreviousConflictMergeUnimportantLine(
    nonTouchLines,
    changeEnd - 1,
    args.equalBackward + 1,
    args.threshold,
  );
  return resolveConflictMergeChunkShift(shiftForward, shiftBackward);
}

/**
 * 对相邻 equal chunks 做边界吸附与合并，参考上游 `LineChunkOptimizer` 的块稳定化逻辑。
 */
function optimizeConflictMergeLineChunks(
  lines1: ConflictMergeComparisonLine[],
  lines2: ConflictMergeComparisonLine[],
  diff: ConflictMergeFairDiff,
): ConflictMergeFairDiff {
  const ranges: ConflictMergePairRange[] = [];
  for (const range of diff.equalRanges) {
    ranges.push({ ...range });

    /**
     * 只处理末尾两段相邻 equal ranges；若发生合并，则递归继续检查新尾部。
     */
    const processLastRanges = (): void => {
      if (ranges.length < 2) return;
      const previous = ranges[ranges.length - 2]!;
      const current = ranges[ranges.length - 1]!;
      if (previous.end1 !== current.start1 && previous.end2 !== current.start2) return;

      const count1 = previous.end1 - previous.start1;
      const count2 = current.end1 - current.start1;
      const equalForward = countConflictMergeForwardEquals(
        lines1,
        lines2,
        previous.end1,
        previous.end2,
        previous.end1 + count2,
        previous.end2 + count2,
        isConflictMergeComparisonLineEqual,
      );
      const equalBackward = countConflictMergeBackwardEquals(
        lines1,
        lines2,
        current.start1 - count1,
        current.start2 - count1,
        current.start1,
        current.start2,
        isConflictMergeComparisonLineEqual,
      );
      if (equalForward === 0 && equalBackward === 0) return;

      if (equalForward === count2) {
        ranges.splice(ranges.length - 2, 2, {
          start1: previous.start1,
          end1: previous.end1 + count2,
          start2: previous.start2,
          end2: previous.end2 + count2,
        });
        processLastRanges();
        return;
      }
      if (equalBackward === count1) {
        ranges.splice(ranges.length - 2, 2, {
          start1: current.start1 - count1,
          end1: current.end1,
          start2: current.start2 - count1,
          end2: current.end2,
        });
        processLastRanges();
        return;
      }

      const touchSide: "left" | "right" = previous.end1 === current.start1 ? "left" : "right";
      const threshold = CONFLICT_MERGE_UNIMPORTANT_LINE_CHAR_COUNT;
      const unchangedShift = getConflictMergeUnchangedBoundaryShift({
        touchSide,
        lines1,
        lines2,
        equalForward,
        equalBackward,
        range1: previous,
        range2: current,
        threshold: 0,
      });
      const changedShift = unchangedShift == null
        ? getConflictMergeChangedBoundaryShift({
            touchSide,
            lines1,
            lines2,
            equalForward,
            equalBackward,
            range1: previous,
            range2: current,
            threshold: 0,
          })
        : unchangedShift;
      const fallbackUnchangedShift = changedShift == null
        ? getConflictMergeUnchangedBoundaryShift({
            touchSide,
            lines1,
            lines2,
            equalForward,
            equalBackward,
            range1: previous,
            range2: current,
            threshold,
          })
        : changedShift;
      const shift = fallbackUnchangedShift == null
        ? getConflictMergeChangedBoundaryShift({
            touchSide,
            lines1,
            lines2,
            equalForward,
            equalBackward,
            range1: previous,
            range2: current,
            threshold,
          }) || 0
        : fallbackUnchangedShift;
      if (shift === 0) return;

      ranges.splice(ranges.length - 2, 2,
        {
          start1: previous.start1,
          end1: previous.end1 + shift,
          start2: previous.start2,
          end2: previous.end2 + shift,
        },
        {
          start1: current.start1 + shift,
          end1: current.end1,
          start2: current.start2 + shift,
          end2: current.end2,
        });
    };

    processLastRanges();
  }

  return {
    length1: diff.length1,
    length2: diff.length2,
    equalRanges: ranges,
  };
}

/**
 * 在忽略空白的匹配结果上，尽量保留 exact-equal 的最大匹配，参考上游 `correctChangesSecondStep`。
 */
function correctConflictMergeChangesSecondStep(
  lines1: ConflictMergeComparisonLine[],
  lines2: ConflictMergeComparisonLine[],
  diff: ConflictMergeFairDiff,
): ConflictMergeFairDiff {
  const builder = createConflictMergeEqualRangeBuilder<ConflictMergeComparisonLine>({
    length1: lines1.length,
    length2: lines2.length,
    expandGapEquals: true,
    objects1: lines1,
    objects2: lines2,
    isEqual: isConflictMergeComparisonLineEqual,
  });
  let sample: string | null = null;
  let last1 = 0;
  let last2 = 0;

  /**
   * 在一组 IW-equal 候选行中，选出 exact-equal 最多的单调配对。
   */
  const getBestMatchingAlignment = (
    shorter: number[],
    longer: number[],
    shorterLines: ConflictMergeComparisonLine[],
    longerLines: ConflictMergeComparisonLine[],
  ): number[] => {
    const size = shorter.length;
    const combination = new Array<number>(size).fill(0);
    const best = new Array<number>(size).fill(0).map((_, index) => index);
    let bestWeight = 0;

    /**
     * 枚举所有递增组合，沿用 IDEA 原实现的小规模暴力策略。
     */
    const combinations = (start: number, n: number, k: number): void => {
      if (k === size) {
        let weight = 0;
        for (let index = 0; index < size; index += 1) {
          const leftIndex = shorter[index]!;
          const rightIndex = longer[combination[index]!]!;
          if (isConflictMergeComparisonLineEqual(shorterLines[leftIndex], longerLines[rightIndex])) {
            weight += 1;
          }
        }
        if (weight > bestWeight) {
          bestWeight = weight;
          for (let index = 0; index < size; index += 1) best[index] = combination[index]!;
        }
        return;
      }
      for (let index = start; index <= n; index += 1) {
        combination[k] = index;
        combinations(index + 1, n, k + 1);
      }
    };

    combinations(0, longer.length - 1, 0);
    return best;
  };

  /**
   * 把同一个 IW sample 下的候选行按 exact-equal 最大匹配回填到 builder。
   */
  const alignExactMatching = (subLines1: number[], subLines2: number[]): void => {
    const maxSize = Math.max(subLines1.length, subLines2.length);
    const skipBruteforce = maxSize > 10 || subLines1.length === subLines2.length;
    if (skipBruteforce) {
      const count = Math.min(subLines1.length, subLines2.length);
      for (let index = 0; index < count; index += 1) {
        const leftIndex = subLines1[index]!;
        const rightIndex = subLines2[index]!;
        if (isConflictMergeComparisonLineEqual(lines1[leftIndex], lines2[rightIndex])) {
          markConflictMergeEqualRange(builder, leftIndex, rightIndex, leftIndex + 1, rightIndex + 1);
        }
      }
      return;
    }

    if (subLines1.length < subLines2.length) {
      const matching = getBestMatchingAlignment(subLines1, subLines2, lines1, lines2);
      for (let index = 0; index < subLines1.length; index += 1) {
        const leftIndex = subLines1[index]!;
        const rightIndex = subLines2[matching[index]!]!;
        if (isConflictMergeComparisonLineEqual(lines1[leftIndex], lines2[rightIndex])) {
          markConflictMergeEqualRange(builder, leftIndex, rightIndex, leftIndex + 1, rightIndex + 1);
        }
      }
      return;
    }

    const matching = getBestMatchingAlignment(subLines2, subLines1, lines2, lines1);
    for (let index = 0; index < subLines2.length; index += 1) {
      const leftIndex = subLines1[matching[index]!]!;
      const rightIndex = subLines2[index]!;
      if (isConflictMergeComparisonLineEqual(lines1[leftIndex], lines2[rightIndex])) {
        markConflictMergeEqualRange(builder, leftIndex, rightIndex, leftIndex + 1, rightIndex + 1);
      }
    }
  };

  /**
   * 在遇到新的 IW sample 或真正 exact-equal 命中时，回填上一个 sample 的最佳配对。
   */
  const flush = (line1: number, line2: number): void => {
    if (sample == null) return;
    const start1 = Math.max(last1, builder.index1);
    const start2 = Math.max(last2, builder.index2);
    const subLines1: number[] = [];
    const subLines2: number[] = [];
    for (let index = start1; index < line1; index += 1) {
      if (isConflictMergeTextEqualIgnoringWhitespace(sample, lines1[index]?.content || "")) {
        subLines1.push(index);
        last1 = index + 1;
      }
    }
    for (let index = start2; index < line2; index += 1) {
      if (isConflictMergeTextEqualIgnoringWhitespace(sample, lines2[index]?.content || "")) {
        subLines2.push(index);
        last2 = index + 1;
      }
    }
    if (subLines1.length > 0 && subLines2.length > 0) {
      alignExactMatching(subLines1, subLines2);
    }
    sample = null;
  };

  for (const range of diff.equalRanges) {
    const count = range.end1 - range.start1;
    for (let offset = 0; offset < count; offset += 1) {
      const index1 = range.start1 + offset;
      const index2 = range.start2 + offset;
      const line1 = lines1[index1];
      const line2 = lines2[index2];
      if (!isConflictMergeTextEqualIgnoringWhitespace(sample, line1?.content || "")) {
        if (isConflictMergeComparisonLineEqual(line1, line2)) {
          flush(index1, index2);
          markConflictMergeEqualRange(builder, index1, index2, index1 + 1, index2 + 1);
        } else {
          flush(index1, index2);
          sample = line1?.content || "";
        }
      }
    }
  }
  flush(lines1.length, lines2.length);
  return finishConflictMergeEqualRangeBuilder(builder);
}

/**
 * 构造接近 IDEA `ByLine.merge` 的 pair fair diff；这是三方 merge ranges 的基础输入。
 */
function buildConflictMergeLineFairDiff(
  baseTokens: string[],
  targetTokens: string[],
): ConflictMergeFairDiff {
  const exactBaseLines = createConflictMergeComparisonLines(baseTokens, "default");
  const exactTargetLines = createConflictMergeComparisonLines(targetTokens, "default");
  const ignoreWhitespaceBaseLines = convertConflictMergeComparisonLinePolicy(exactBaseLines, "ignoreWhitespace");
  const ignoreWhitespaceTargetLines = convertConflictMergeComparisonLinePolicy(exactTargetLines, "ignoreWhitespace");

  let diff = buildConflictMergeSmartLineDiff(ignoreWhitespaceBaseLines, ignoreWhitespaceTargetLines);
  diff = optimizeConflictMergeLineChunks(exactBaseLines, exactTargetLines, diff);
  return correctConflictMergeChangesSecondStep(exactBaseLines, exactTargetLines, diff);
}

/**
 * 把 pair fair diff 的 equal ranges 转成 merge builder 可直接消费的 unchanged ranges。
 */
function buildConflictMergeUnchangedRanges(
  diff: ConflictMergeFairDiff,
): ConflictMergePairRange[] {
  return diff.equalRanges.map((range) => ({ ...range }));
}

/**
 * 按 IDEA `ComparisonMergeUtil.buildSimple` 的 `FairMergeBuilder` 语义合成最终三方 merge ranges。
 */
function buildConflictMergeRanges(args: {
  baseLength: number;
  oursLength: number;
  theirsLength: number;
  leftDiff: ConflictMergeFairDiff;
  rightDiff: ConflictMergeFairDiff;
}): ConflictMergeRange[] {
  const leftRanges = buildConflictMergeUnchangedRanges(args.leftDiff);
  const rightRanges = buildConflictMergeUnchangedRanges(args.rightDiff);
  const ranges: ConflictMergeRange[] = [];
  let oursIndex = 0;
  let baseIndex = 0;
  let theirsIndex = 0;
  let leftIndex = 0;
  let rightIndex = 0;

  /**
   * 把当前 equal 片段之前尚未消费的区间收口为 merge range；空区间会被自动跳过。
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
   * 识别到三方公共 unchanged 重叠片段后，先输出前一个 change，再推进三侧游标。
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
   * 对齐一组左右 unchanged range；返回下一次应推进的侧别，与 IDEA `FairMergeBuilder.add` 同义。
   */
  const addEqualOverlap = (
    leftRange: ConflictMergePairRange,
    rightRange: ConflictMergePairRange,
  ): "left" | "right" => {
    if (leftRange.end1 <= rightRange.start1) return "left";
    if (rightRange.end1 <= leftRange.start1) return "right";

    const overlapBaseStart = Math.max(leftRange.start1, rightRange.start1);
    const overlapBaseEnd = Math.min(leftRange.end1, rightRange.end1);
    const overlapCount = overlapBaseEnd - overlapBaseStart;
    const overlapLeftShift = overlapBaseStart - leftRange.start1;
    const overlapRightShift = overlapBaseStart - rightRange.start1;
    const overlapOursStart = leftRange.start2 + overlapLeftShift;
    const overlapTheirsStart = rightRange.start2 + overlapRightShift;

    markEqual(
      overlapOursStart,
      overlapBaseStart,
      overlapTheirsStart,
      overlapOursStart + overlapCount,
      overlapBaseEnd,
      overlapTheirsStart + overlapCount,
    );
    return leftRange.end1 <= rightRange.end1 ? "left" : "right";
  };

  while (leftIndex < leftRanges.length && rightIndex < rightRanges.length) {
    const advanceSide = addEqualOverlap(leftRanges[leftIndex]!, rightRanges[rightIndex]!);
    if (advanceSide === "left") leftIndex += 1;
    else rightIndex += 1;
  }

  pushChange(oursIndex, baseIndex, theirsIndex, args.oursLength, args.baseLength, args.theirsLength);
  return ranges;
}

/**
 * 对外暴露的三方 merge range 构建入口；统一参考上游 merge viewer 的块划分基础逻辑。
 */
export function buildConflictMergeLineRanges(args: {
  baseTokens: string[];
  oursTokens: string[];
  theirsTokens: string[];
}): ConflictMergeRange[] {
  const leftDiff = buildConflictMergeLineFairDiff(args.baseTokens, args.oursTokens);
  const rightDiff = buildConflictMergeLineFairDiff(args.baseTokens, args.theirsTokens);
  return buildConflictMergeRanges({
    baseLength: args.baseTokens.length,
    oursLength: args.oursTokens.length,
    theirsLength: args.theirsTokens.length,
    leftDiff,
    rightDiff,
  });
}
