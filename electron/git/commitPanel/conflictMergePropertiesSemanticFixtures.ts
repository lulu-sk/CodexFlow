// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type GitConflictMergePropertiesSemanticFixtureBlock = {
  oursStart: number;
  oursEnd: number;
  baseStart: number;
  baseEnd: number;
  theirsStart: number;
  theirsEnd: number;
  canResolve: boolean;
  expectedText: string | null;
};

export type GitConflictMergePropertiesSemanticFixture = {
  name: string;
  baseText: string;
  oursText: string;
  theirsText: string;
  blocks: GitConflictMergePropertiesSemanticFixtureBlock[];
};

/**
 * 按测试夹具统一构造带末尾换行的 `.properties` 文本，便于覆盖上游样例。
 */
function buildPropertiesFixtureText(lines: string[]): string {
  return lines.join("\n");
}

/**
 * 整理自 IDEA `PropertiesMergeConflictResolverTest` 的关键语义夹具，覆盖可解/不可解、注释、重复 key、排序与多行属性回归。
 */
export function createConflictMergePropertiesSemanticFixtures(): GitConflictMergePropertiesSemanticFixture[] {
  return [
    {
      name: "simpleMerge",
      baseText: "",
      oursText: buildPropertiesFixtureText([
        "left.key = left value",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "right.key = right value",
        "",
      ]),
      blocks: [{
        oursStart: 0,
        oursEnd: 1,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 1,
        canResolve: true,
        expectedText: buildPropertiesFixtureText([
          "left.key=left value",
          "right.key=right value",
        ]),
      }],
    },
    {
      name: "doNotMergeDifferentComment",
      baseText: "",
      oursText: buildPropertiesFixtureText([
        "! Second part of the comment",
        "left.key = left value",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "! but different comment",
        "left.key = left value",
        "",
      ]),
      blocks: [{
        oursStart: 0,
        oursEnd: 2,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 2,
        canResolve: false,
        expectedText: null,
      }],
    },
    {
      name: "mergeWithEmptyCommentLeft",
      baseText: "",
      oursText: buildPropertiesFixtureText([
        "right.key = right value",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "! Some comment",
        "right.key = right value",
        "",
      ]),
      blocks: [{
        oursStart: 0,
        oursEnd: 1,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 2,
        canResolve: true,
        expectedText: buildPropertiesFixtureText([
          "! Some comment",
          "right.key=right value",
        ]),
      }],
    },
    {
      name: "sortsProperties",
      baseText: "",
      oursText: buildPropertiesFixtureText([
        "c = c value",
        "a = a value",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "d = d value",
        "b = b value",
        "",
      ]),
      blocks: [{
        oursStart: 0,
        oursEnd: 2,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 2,
        canResolve: true,
        expectedText: buildPropertiesFixtureText([
          "a=a value",
          "b=b value",
          "c=c value",
          "d=d value",
        ]),
      }],
    },
    {
      name: "outerDuplicatesLeftToRight",
      baseText: buildPropertiesFixtureText([
        "base.key.fst = base value fst",
        "base.key.snd = base value snd",
        "",
      ]),
      oursText: buildPropertiesFixtureText([
        "left.key.above = left value above",
        "base.key.fst = base value fst",
        "left.key.below = left value below",
        "base.key.snd = base value snd",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "right.key.above = right value above",
        "base.key.fst = base value fst",
        "right.key.below = right value below",
        "base.key.snd = base value snd",
        "left.key.above = left value below",
        "",
      ]),
      blocks: [
        {
          oursStart: 0,
          oursEnd: 1,
          baseStart: 0,
          baseEnd: 0,
          theirsStart: 0,
          theirsEnd: 1,
          canResolve: false,
          expectedText: null,
        },
        {
          oursStart: 2,
          oursEnd: 3,
          baseStart: 1,
          baseEnd: 1,
          theirsStart: 2,
          theirsEnd: 3,
          canResolve: true,
          expectedText: buildPropertiesFixtureText([
            "left.key.below=left value below",
            "right.key.below=right value below",
          ]),
        },
      ],
    },
    {
      name: "ignoreEmptyLines",
      baseText: "",
      oursText: buildPropertiesFixtureText([
        "left.key.1 = left value 1",
        "",
        "left.key.2 = left value 2",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "right.key.1 = right value 1",
        "",
        "",
        "right.key.2 = right value 2",
        "",
      ]),
      blocks: [{
        oursStart: 0,
        oursEnd: 3,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 4,
        canResolve: true,
        expectedText: buildPropertiesFixtureText([
          "left.key.1=left value 1",
          "left.key.2=left value 2",
          "right.key.1=right value 1",
          "right.key.2=right value 2",
        ]),
      }],
    },
    {
      name: "ignoreDelimiters",
      baseText: "",
      oursText: buildPropertiesFixtureText([
        "base.key = base value",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "base.key : base value",
        "",
      ]),
      blocks: [{
        oursStart: 0,
        oursEnd: 1,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 1,
        canResolve: true,
        expectedText: "base.key=base value",
      }],
    },
    {
      name: "ignoreUnescapedKey",
      baseText: "",
      oursText: buildPropertiesFixtureText([
        "base.\\",
        "multiline.\\",
        "key = base value",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "base.multiline.key = base value",
        "",
      ]),
      blocks: [{
        oursStart: 0,
        oursEnd: 3,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 1,
        canResolve: true,
        expectedText: buildPropertiesFixtureText([
          "base.\\",
          "multiline.\\",
          "key=base value",
        ]),
      }],
    },
    {
      name: "mergeWithMultilineProperties",
      baseText: "",
      oursText: buildPropertiesFixtureText([
        "left.key.multiline = line 1 \\",
        "                   line 2 \\",
        "                   line 3",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "right.key.multiline = line 1 \\",
        "                    line 2 \\",
        "                    line 3",
        "",
      ]),
      blocks: [{
        oursStart: 0,
        oursEnd: 3,
        baseStart: 0,
        baseEnd: 0,
        theirsStart: 0,
        theirsEnd: 3,
        canResolve: true,
        expectedText: buildPropertiesFixtureText([
          "left.key.multiline=line 1 \\",
          "                   line 2 \\",
          "                   line 3",
          "right.key.multiline=line 1 \\",
          "                    line 2 \\",
          "                    line 3",
        ]),
      }],
    },
    {
      name: "changeInMultilinePropertyIsIgnored",
      baseText: buildPropertiesFixtureText([
        "base.key = line 1 \\",
        "           line 2 \\",
        "           line 3 \\",
        "           line 4",
        "",
      ]),
      oursText: buildPropertiesFixtureText([
        "base.key = line 1 \\",
        "           left line 2 \\",
        "           line 3 \\",
        "           left line 4",
        "",
      ]),
      theirsText: buildPropertiesFixtureText([
        "base.key = line 1 \\",
        "           right line 2 \\",
        "           line 3 \\",
        "           right line 4",
        "",
      ]),
      blocks: [
        {
          oursStart: 1,
          oursEnd: 2,
          baseStart: 1,
          baseEnd: 2,
          theirsStart: 1,
          theirsEnd: 2,
          canResolve: false,
          expectedText: null,
        },
        {
          oursStart: 3,
          oursEnd: 4,
          baseStart: 3,
          baseEnd: 4,
          theirsStart: 3,
          theirsEnd: 4,
          canResolve: false,
          expectedText: null,
        },
      ],
    },
  ];
}
