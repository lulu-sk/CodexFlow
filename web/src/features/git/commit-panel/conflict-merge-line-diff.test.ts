import { describe, expect, it } from "vitest";
import { buildConflictMergeLineRanges } from "./conflict-merge-line-diff";

/**
 * 统一给测试样本补齐 LF，保持与 merge viewer 内部 token 语义一致。
 */
function withConflictMergeTestLf(lines: string[]): string[] {
  return lines.map((line) => `${line}\n`);
}

/**
 * 构造带大量重复上下文的 57 组变更样本，回归覆盖“块数量被误拆膨胀”的风险。
 */
function createLargeConflictMergeBlockFixture(): {
  baseTokens: string[];
  oursTokens: string[];
  theirsTokens: string[];
} {
  const baseLines: string[] = [];
  const oursLines: string[] = [];
  const theirsLines: string[] = [];

  for (let index = 0; index < 57; index += 1) {
    const repeatCount = 2 + (index % 3);

    baseLines.push("section:start");
    oursLines.push("section:start");
    theirsLines.push("section:start");

    for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
      baseLines.push("repeated-context");
      oursLines.push("repeated-context");
      theirsLines.push("repeated-context");
    }

    baseLines.push(`anchor:${index}`);
    baseLines.push("section:end");

    if (index % 3 === 0) {
      oursLines.push(`ours:${index}`);
      oursLines.push(`anchor:${index}`);
      oursLines.push("section:end");
      theirsLines.push(`anchor:${index}`);
      theirsLines.push("section:end");
      continue;
    }

    if (index % 3 === 1) {
      oursLines.push(`anchor:${index}`);
      oursLines.push("section:end");
      theirsLines.push(`theirs:${index}`);
      theirsLines.push(`anchor:${index}`);
      theirsLines.push("section:end");
      continue;
    }

    oursLines.push(`ours:${index}`);
    oursLines.push(`anchor:${index}`);
    oursLines.push("section:end");
    theirsLines.push(`theirs:${index}`);
    theirsLines.push(`anchor:${index}`);
    theirsLines.push("section:end");
  }

  baseLines.push("tail");
  oursLines.push("tail");
  theirsLines.push("tail");

  return {
    baseTokens: withConflictMergeTestLf(baseLines),
    oursTokens: withConflictMergeTestLf(oursLines),
    theirsTokens: withConflictMergeTestLf(theirsLines),
  };
}

describe("conflict-merge-line-diff", () => {
  it("应在大量重复上下文场景下稳定产出 57 个三方块", () => {
    const fixture = createLargeConflictMergeBlockFixture();
    const lastAnchorIndex = fixture.baseTokens.lastIndexOf("anchor:56\n");

    const ranges = buildConflictMergeLineRanges(fixture);

    expect(ranges).toHaveLength(57);
    expect(ranges[0]).toMatchObject({
      oursStart: 3,
      baseStart: 3,
      theirsStart: 3,
    });
    expect(ranges[56]).toMatchObject({
      baseStart: lastAnchorIndex,
      baseEnd: lastAnchorIndex,
    });
  });
});
