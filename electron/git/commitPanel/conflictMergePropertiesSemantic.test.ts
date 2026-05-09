import { describe, expect, it } from "vitest";
import { buildConflictMergeMetadata } from "./conflictMergeMetadata";
import {
  createConflictMergePropertiesSemanticFixtures,
  type GitConflictMergePropertiesSemanticFixture,
} from "./conflictMergePropertiesSemanticFixtures";
import {
  CONFLICT_MERGE_PROPERTIES_SEMANTIC_RESOLVER_ID,
} from "./conflictMergePropertiesSemantic";
import { resolveConflictMergeSemanticBlocks } from "./conflictMergeSemantic";

/**
 * 把官方 fixture 的行区间转换为仓库 semantic resolver 统一上下文，便于直接验证整文件批量语义。
 */
function buildFixtureSemanticContext(fixture: GitConflictMergePropertiesSemanticFixture): Parameters<typeof resolveConflictMergeSemanticBlocks>[0] {
  return {
    path: `fixtures/${fixture.name}.properties`,
    baseText: fixture.baseText,
    oursText: fixture.oursText,
    theirsText: fixture.theirsText,
    resultText: fixture.baseText,
    blocks: fixture.blocks.map((block, index) => ({
      path: `fixtures/${fixture.name}.properties`,
      blockIndex: index,
      kind: "conflict" as const,
      baseText: "",
      oursText: "",
      theirsText: "",
      resultText: "",
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
    })),
  };
}

/**
 * 为单块 `.properties` 官方边界样本构造 semantic 上下文，避免额外修改现有 fixture 计数口径。
 */
function buildSinglePropertiesSemanticContext(args: {
  name: string;
  baseText: string;
  oursText: string;
  theirsText: string;
  block: {
    oursStart: number;
    oursEnd: number;
    baseStart: number;
    baseEnd: number;
    theirsStart: number;
    theirsEnd: number;
  };
}): Parameters<typeof resolveConflictMergeSemanticBlocks>[0] {
  return buildFixtureSemanticContext({
    name: args.name,
    baseText: args.baseText,
    oursText: args.oursText,
    theirsText: args.theirsText,
    blocks: [{
      ...args.block,
      canResolve: false,
      expectedText: null,
    }],
  });
}

describe("conflict merge properties semantic resolver", () => {
  it("应对齐 IDEA PropertiesMergeConflictResolverTest 的关键语义夹具", () => {
    for (const fixture of createConflictMergePropertiesSemanticFixtures()) {
      const semanticResolution = resolveConflictMergeSemanticBlocks(buildFixtureSemanticContext(fixture));
      expect(semanticResolution?.resolverId).toBe(CONFLICT_MERGE_PROPERTIES_SEMANTIC_RESOLVER_ID);
      expect(semanticResolution?.texts).toEqual(fixture.blocks.map((block) => block.expectedText));
    }
  });

  it("真实 .properties metadata 应进入 SEMANTIC 分支，而不是只靠测试注入 resolver", () => {
    const simpleMergeFixture = createConflictMergePropertiesSemanticFixtures().find((fixture) => fixture.name === "simpleMerge");
    expect(simpleMergeFixture).toBeTruthy();
    if (!simpleMergeFixture) return;

    const metadata = buildConflictMergeMetadata({
      path: "src/messages.properties",
      baseText: simpleMergeFixture.baseText,
      oursText: simpleMergeFixture.oursText,
      theirsText: simpleMergeFixture.theirsText,
    });

    expect(metadata.semanticResolverId).toBe(CONFLICT_MERGE_PROPERTIES_SEMANTIC_RESOLVER_ID);
    expect(metadata.blocks[0]).toMatchObject({
      kind: "conflict",
      resolutionStrategy: "SEMANTIC",
      semanticResolverId: CONFLICT_MERGE_PROPERTIES_SEMANTIC_RESOLVER_ID,
      semanticResolvedText: simpleMergeFixture.blocks[0]?.expectedText,
    });
  });

  it("应对齐 IDEA COMMENT_INTERSECTIONS 的 split comment / comment spaces 边界", () => {
    const doNotMergeWithSplitedComment = resolveConflictMergeSemanticBlocks(buildSinglePropertiesSemanticContext({
      name: "doNotMergeWithSplitedComment",
      baseText: "",
      oursText: "! First part of the comment\n\n! Second part of the comment\nleft.key = left value",
      theirsText: "right.key = right value",
      block: {
        oursStart: 0,
        oursEnd: 4,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 1,
      },
    }));
    expect(doNotMergeWithSplitedComment?.texts).toEqual([null]);

    const doNotMergeWithSplitedCommentAfterProperty = resolveConflictMergeSemanticBlocks(buildSinglePropertiesSemanticContext({
      name: "doNotMergeWithSplitedCommentAfterProperty",
      baseText: "base.key = base value",
      oursText: "base.key=base value\n! First part of the comment\n\n! Second part of the comment\nleft.key = left value",
      theirsText: "base.key=base value\nright.key = right value",
      block: {
        oursStart: 1,
        oursEnd: 5,
        baseStart: 1,
        baseEnd: 1,
        theirsStart: 1,
        theirsEnd: 2,
      },
    }));
    expect(doNotMergeWithSplitedCommentAfterProperty?.texts).toEqual([null]);

    const mergeWithCommentAndSpaces = resolveConflictMergeSemanticBlocks(buildSinglePropertiesSemanticContext({
      name: "mergeWithCommentAndSpaces",
      baseText: "",
      oursText: "\n\n! Second part of the comment\nleft.key = left value",
      theirsText: "right.key = right value",
      block: {
        oursStart: 0,
        oursEnd: 4,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 1,
      },
    }));
    expect(mergeWithCommentAndSpaces?.texts).toEqual([
      "! Second part of the comment\nleft.key=left value\nright.key=right value",
    ]);

    const mergeWithCommentAndSpacesAfterProperty = resolveConflictMergeSemanticBlocks(buildSinglePropertiesSemanticContext({
      name: "mergeWithCommentAndSpacesAfterProperty",
      baseText: "base.key = base value",
      oursText: "base.key = base value\n\n\n! Second part of the comment\nleft.key = left value",
      theirsText: "base.key = base value\nright.key = right value",
      block: {
        oursStart: 1,
        oursEnd: 5,
        baseStart: 1,
        baseEnd: 1,
        theirsStart: 1,
        theirsEnd: 2,
      },
    }));
    expect(mergeWithCommentAndSpacesAfterProperty?.texts).toEqual([
      "! Second part of the comment\nleft.key=left value\nright.key=right value",
    ]);
  });
});
