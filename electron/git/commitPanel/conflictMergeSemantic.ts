// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { conflictMergePropertiesSemanticResolver } from "./conflictMergePropertiesSemantic";

export type GitConflictMergeSemanticResolverContext = {
  path: string;
  blockIndex: number;
  baseText: string;
  oursText: string;
  theirsText: string;
  resultText: string;
};

export type GitConflictMergeSemanticResolverRange = {
  start: number;
  end: number;
};

export type GitConflictMergeSemanticResolverBlockContext = GitConflictMergeSemanticResolverContext & {
  kind: "change" | "conflict";
  baseRange: GitConflictMergeSemanticResolverRange;
  oursRange: GitConflictMergeSemanticResolverRange;
  theirsRange: GitConflictMergeSemanticResolverRange;
  resultRange: GitConflictMergeSemanticResolverRange;
};

export type GitConflictMergeSemanticResolverFileContext = {
  path: string;
  baseText: string;
  oursText: string;
  theirsText: string;
  resultText: string;
  blocks: GitConflictMergeSemanticResolverBlockContext[];
};

export type GitConflictMergeSemanticResolver = {
  id: string;
  isApplicable(path: string): boolean;
  resolve?(context: GitConflictMergeSemanticResolverContext): string | null;
  resolveAll?(context: GitConflictMergeSemanticResolverFileContext): Array<string | null> | null;
};

let testingResolvers: GitConflictMergeSemanticResolver[] | null = null;

/**
 * 返回当前生效的 semantic resolver 列表；测试注入 resolver 会优先于内建 resolver 命中。
 */
function getConflictMergeSemanticResolvers(): GitConflictMergeSemanticResolver[] {
  const builtinResolvers = [conflictMergePropertiesSemanticResolver];
  return testingResolvers ? [...testingResolvers, ...builtinResolvers] : builtinResolvers;
}

/**
 * 查找当前文件可用的 semantic resolver。
 */
export function findConflictMergeSemanticResolver(path: string): GitConflictMergeSemanticResolver | null {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) return null;
  for (const resolver of getConflictMergeSemanticResolvers()) {
    try {
      if (resolver.isApplicable(cleanPath)) return resolver;
    } catch {}
  }
  return null;
}

/**
 * 在整文件语义上下文里批量执行 semantic 解析；无 resolver、返回长度不匹配或抛错时统一降级为 null。
 */
export function resolveConflictMergeSemanticBlocks(
  context: GitConflictMergeSemanticResolverFileContext,
): { resolverId: string; texts: Array<string | null> } | null {
  const resolver = findConflictMergeSemanticResolver(context.path);
  if (!resolver) return null;
  try {
    const texts = resolver.resolveAll
      ? resolver.resolveAll(context)
      : context.blocks.map((block) => resolver.resolve?.({
          path: block.path,
          blockIndex: block.blockIndex,
          baseText: block.baseText,
          oursText: block.oursText,
          theirsText: block.theirsText,
          resultText: block.resultText,
        }) ?? null);
    if (!texts || texts.length !== context.blocks.length) return null;
    return {
      resolverId: resolver.id,
      texts: [...texts],
    };
  } catch {
    return null;
  }
}

/**
 * 执行单块 semantic 解析；优先复用批量 resolver 能力，确保内建 `.properties` 也能被单块调用覆盖。
 */
export function resolveConflictMergeSemantically(
  context: GitConflictMergeSemanticResolverContext,
): { resolverId: string; text: string } | null {
  const result = resolveConflictMergeSemanticBlocks({
    path: context.path,
    baseText: context.baseText,
    oursText: context.oursText,
    theirsText: context.theirsText,
    resultText: context.resultText,
    blocks: [{
      ...context,
      kind: "conflict",
      baseRange: { start: 0, end: 0 },
      oursRange: { start: 0, end: 0 },
      theirsRange: { start: 0, end: 0 },
      resultRange: { start: 0, end: 0 },
    }],
  });
  const text = result?.texts[0] ?? null;
  if (text == null || !result) return null;
  return {
    resolverId: result.resolverId,
    text,
  };
}

/**
 * 仅供测试注入 semantic resolver，用于覆盖“可解/不可解”两条语义链。
 */
export function setConflictMergeSemanticResolversForTesting(
  resolvers: GitConflictMergeSemanticResolver[] | null,
): void {
  testingResolvers = resolvers ? [...resolvers] : null;
}
