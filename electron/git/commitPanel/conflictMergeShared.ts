// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type GitConflictMergeBlockKind = "change" | "conflict";

export type GitConflictMergeConflictType = "INSERTED" | "DELETED" | "MODIFIED" | "CONFLICT";

export type GitConflictMergeResolutionStrategy = "DEFAULT" | "TEXT" | "SEMANTIC" | null;

export type GitConflictMergeSide = "ours" | "theirs";

export type GitConflictMergeTokenRange = {
  start: number;
  end: number;
};

export type GitConflictMergeBlockData = {
  index: number;
  kind: GitConflictMergeBlockKind;
  conflictType: GitConflictMergeConflictType;
  resolutionStrategy: GitConflictMergeResolutionStrategy;
  semanticResolverId: string | null;
  semanticResolvedText: string | null;
  isImportChange: boolean;
  changedInOurs: boolean;
  changedInTheirs: boolean;
  baseStart: number;
  baseEnd: number;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
};

export type GitConflictMergeImportEntry = {
  statement: string;
  importedSymbols: string[];
  moduleSpecifier: string | null;
  lineStart: number;
  lineEnd: number;
};

export type GitConflictMergeImportMetadata = {
  supported: boolean;
  autoResolveEnabled: boolean;
  baseRange: GitConflictMergeTokenRange | null;
  oursRange: GitConflictMergeTokenRange | null;
  theirsRange: GitConflictMergeTokenRange | null;
  oursEntries: GitConflictMergeImportEntry[];
  theirsEntries: GitConflictMergeImportEntry[];
};

export type GitConflictMergeMetadata = {
  blocks: GitConflictMergeBlockData[];
  importMetadata: GitConflictMergeImportMetadata | null;
  semanticResolverId: string | null;
};

/**
 * 统一按 LF 标准化文本，避免比较与分块时被 CRLF 干扰。
 */
export function normalizeConflictMergeText(text: string): string {
  return String(text || "").replace(/\r\n/g, "\n");
}

/**
 * 按逐行 token 拆分文本，并保留每行末尾换行，便于后续精确回写。
 */
export function splitConflictMergeLineTokens(text: string): string[] {
  return normalizeConflictMergeText(text).match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * 把 token 数组重新拼回完整文本。
 */
export function joinConflictMergeTokens(tokens: string[]): string {
  return tokens.join("");
}

/**
 * 判断两段文本在标准化换行后是否等价。
 */
export function isConflictMergeTextEquivalent(left: string, right: string): boolean {
  return normalizeConflictMergeText(left) === normalizeConflictMergeText(right);
}

/**
 * 把普通文本拆成按词/空白/符号分组的 token，供 IDEA 风格文本自动解决复用。
 */
export function splitConflictMergeWordTokens(text: string): string[] {
  return normalizeConflictMergeText(text).match(/\r\n|\n|[^\S\r\n]+|[A-Za-z0-9_$]+|./g) || [];
}

/**
 * 按策略归一化 token 文本，当前只需要默认与忽略空白两种模式。
 */
export function normalizeConflictMergeTokenForPolicy(
  token: string,
  policy: "default" | "ignoreWhitespace",
): string {
  if (policy === "ignoreWhitespace") return String(token || "").replace(/\s+/g, "");
  return String(token || "");
}

/**
 * 从文本中抽取可能的标识符集合，供 import reference transfer 判断是否需要补 import。
 */
export function extractConflictMergeIdentifiers(text: string): Set<string> {
  const result = new Set<string>();
  const source = String(text || "");
  const matches = source.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
  for (const one of matches) {
    result.add(one);
  }
  return result;
}

/**
 * 把 import 语句归一化为稳定键，用于去重和“已存在”判断。
 */
export function normalizeConflictMergeImportStatement(statement: string): string {
  return String(statement || "").trim().replace(/\s+/g, " ");
}
