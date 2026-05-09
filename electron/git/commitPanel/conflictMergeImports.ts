// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type {
  GitConflictMergeImportEntry,
  GitConflictMergeImportMetadata,
  GitConflictMergeTokenRange,
} from "./conflictMergeShared";
import {
  extractConflictMergeIdentifiers,
  joinConflictMergeTokens,
  normalizeConflictMergeImportStatement,
  splitConflictMergeLineTokens,
} from "./conflictMergeShared";

type ConflictMergeImportBlock = {
  range: GitConflictMergeTokenRange;
  entries: GitConflictMergeImportEntry[];
};

type ConflictMergeJSImportClause = {
  prefix: string;
  suffix: string;
  items: string[];
  multiline: boolean;
  indent: string;
};

type ConflictMergeImportLanguage = "java" | "kotlin";

/**
 * 按文件后缀识别当前是否存在 IDEA 社区基线可证明的 import provider；本轮仅保留 Java / Kotlin / KTS。
 */
function resolveConflictMergeImportLanguage(path: string): ConflictMergeImportLanguage | null {
  const normalizedPath = String(path || "").trim().toLowerCase();
  if (normalizedPath.endsWith(".java")) return "java";
  if (normalizedPath.endsWith(".kt") || normalizedPath.endsWith(".kts")) return "kotlin";
  return null;
}

/**
 * 判断当前文件后缀是否支持 import-specific 识别与 reference transfer。
 */
function isConflictMergeImportSupported(path: string): boolean {
  return resolveConflictMergeImportLanguage(path) != null;
}

/**
 * 把多行 import 语句压成一段文本并解析出可用于引用迁移的符号列表。
 */
function buildConflictMergeImportEntry(
  statement: string,
  lineStart: number,
  lineEnd: number,
): GitConflictMergeImportEntry {
  const normalized = String(statement || "").trim();
  const importedSymbols = new Set<string>();
  let moduleSpecifier: string | null = null;

  const jsModuleMatch = normalized.match(/from\s+["']([^"']+)["']/);
  if (jsModuleMatch?.[1]) moduleSpecifier = jsModuleMatch[1];

  const jsDefaultMatch = normalized.match(/^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|from)/);
  if (jsDefaultMatch?.[1]) importedSymbols.add(jsDefaultMatch[1]);

  const jsNamespaceMatch = normalized.match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (jsNamespaceMatch?.[1]) importedSymbols.add(jsNamespaceMatch[1]);

  const jsNamedMatch = normalized.match(/\{([^}]+)\}/);
  if (jsNamedMatch?.[1]) {
    for (const one of jsNamedMatch[1].split(",")) {
      const clean = String(one || "").trim();
      if (!clean) continue;
      const aliasMatch = clean.match(/(?:^|as\s+)([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (aliasMatch?.[1]) importedSymbols.add(aliasMatch[1]);
    }
  }

  const javaLikeMatch = normalized.match(/^import\s+(?:static\s+)?([\w.]+)(?:\.\*)?(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?;?$/);
  if (javaLikeMatch?.[1]) {
    const alias = javaLikeMatch[2];
    const parts = javaLikeMatch[1].split(".");
    const tail = alias || parts[parts.length - 1];
    if (tail) importedSymbols.add(tail);
    moduleSpecifier = javaLikeMatch[1];
  }

  const pythonImportMatch = normalized.match(/^import\s+(.+)$/);
  if (pythonImportMatch?.[1]) {
    for (const one of pythonImportMatch[1].split(",")) {
      const clean = String(one || "").trim();
      if (!clean) continue;
      const aliasMatch = clean.match(/(?:^|as\s+)([A-Za-z_][A-Za-z0-9_]*)$/);
      if (aliasMatch?.[1]) importedSymbols.add(aliasMatch[1]);
    }
  }

  const pythonFromMatch = normalized.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
  if (pythonFromMatch?.[1]) {
    moduleSpecifier = pythonFromMatch[1];
    for (const one of pythonFromMatch[2].split(",")) {
      const clean = String(one || "").trim();
      if (!clean || clean === "*") continue;
      const aliasMatch = clean.match(/(?:^|as\s+)([A-Za-z_][A-Za-z0-9_]*)$/);
      if (aliasMatch?.[1]) importedSymbols.add(aliasMatch[1]);
    }
  }

  return {
    statement: normalized.endsWith("\n") ? normalized : `${normalized}\n`,
    importedSymbols: Array.from(importedSymbols),
    moduleSpecifier,
    lineStart,
    lineEnd,
  };
}

/**
 * 从单个 named import 片段中提取最终绑定到当前文件作用域的标识符名，供 import 合并时对齐顺序与去重。
 */
function extractConflictMergeImportSpecifierName(specifier: string): string | null {
  const clean = String(specifier || "").trim().replace(/^type\s+/, "");
  if (!clean) return null;
  const aliasMatch = clean.match(/(?:^|as\s+)([A-Za-z_$][A-Za-z0-9_$]*)$/);
  return aliasMatch?.[1] || null;
}

/**
 * 解析 JS/TS 的 `{ ... } from "x"` import 子句；仅在能安全按符号级别合并时返回结构化结果。
 */
function parseConflictMergeJSImportClause(statement: string): ConflictMergeJSImportClause | null {
  const source = String(statement || "");
  const match = source.match(/^(import\s+(?:type\s+)?)([\s\S]*?)\{([\s\S]*?)\}(\s*from\s+["'][^"']+["'];?\s*)$/);
  if (!match) return null;
  const body = match[3] || "";
  return {
    prefix: `${match[1] || ""}${match[2] || ""}`,
    suffix: match[4] || "",
    items: body.split(",").map((item) => String(item || "").trim()).filter(Boolean),
    multiline: body.includes("\n") || source.includes("\n"),
    indent: body.match(/\n([ \t]+)\S/)?.[1] || "  ",
  };
}

/**
 * 按当前 import 的既有格式重建 named import 语句；多行语句保留缩进与尾随逗号风格。
 */
function buildConflictMergeJSImportClause(clause: ConflictMergeJSImportClause): string {
  const suffix = clause.suffix.endsWith("\n") ? clause.suffix : `${clause.suffix}\n`;
  if (!clause.multiline) {
    return `${clause.prefix}{ ${clause.items.join(", ")} }${suffix.trimStart()}`;
  }
  const body = clause.items.map((item) => `${clause.indent}${item},\n`).join("");
  return `${clause.prefix}{\n${body}}${suffix}`;
}

/**
 * 在同模块的 JS/TS named import 之间做并集合并；若结构不兼容则返回 null，交由上层按“新增语句”处理。
 */
function mergeConflictMergeImportStatements(
  currentEntry: GitConflictMergeImportEntry,
  requiredEntry: GitConflictMergeImportEntry,
): string | null {
  if (!currentEntry.moduleSpecifier || currentEntry.moduleSpecifier !== requiredEntry.moduleSpecifier) return null;
  const currentClause = parseConflictMergeJSImportClause(currentEntry.statement);
  const requiredClause = parseConflictMergeJSImportClause(requiredEntry.statement);
  if (!currentClause || !requiredClause) return null;

  const currentItemByName = new Map<string, string>();
  currentClause.items.forEach((item) => {
    const name = extractConflictMergeImportSpecifierName(item);
    if (name) currentItemByName.set(name, item);
  });

  const mergedItems: string[] = [];
  const seenNames = new Set<string>();
  requiredClause.items.forEach((item) => {
    const name = extractConflictMergeImportSpecifierName(item);
    if (!name || seenNames.has(name)) return;
    seenNames.add(name);
    mergedItems.push(currentItemByName.get(name) || item);
  });
  currentClause.items.forEach((item) => {
    const name = extractConflictMergeImportSpecifierName(item);
    if (!name || seenNames.has(name)) return;
    seenNames.add(name);
    mergedItems.push(item);
  });

  if (mergedItems.length <= 0) return null;
  return buildConflictMergeJSImportClause({
    ...currentClause,
    items: mergedItems,
  });
}

/**
 * 判断当前行是否为空白或注释；黑盒等价扫描里允许这类行穿过 import block。
 */
function isConflictMergeImportSpacerLine(line: string): boolean {
  const trimmed = String(line || "").trim();
  return !trimmed
    || /^\/\//.test(trimmed)
    || /^#/.test(trimmed)
    || /^\/\*/.test(trimmed)
    || /^\*/.test(trimmed)
    || /^\*\/$/.test(trimmed);
}

/**
 * 判断当前行是否可作为 Java import 声明起点，黑盒贴近 `PsiJavaFile.importList` 的语法边界。
 */
function isConflictMergeJavaImportLine(line: string): boolean {
  const trimmed = String(line || "").trim();
  return /^import\s+(?:static\s+)?[\w.]+(?:\.\*)?\s*;\s*$/.test(trimmed);
}

/**
 * 判断当前行是否可作为 Kotlin / KTS import 声明起点，覆盖 alias import 与可选分号。
 */
function isConflictMergeKotlinImportLine(line: string): boolean {
  const trimmed = String(line || "").trim();
  return /^import\s+[`A-Za-z_][\w.`]*(?:\.\*)?(?:\s+as\s+[`A-Za-z_][\w`]*)?\s*;?\s*$/.test(trimmed);
}

/**
 * 判断当前行是否仍属于 Java 文件头部允许出现的 package / 空白 / 注释区域。
 */
function isConflictMergeJavaPreambleLine(line: string): boolean {
  const trimmed = String(line || "").trim();
  return !trimmed
    || /^package\s+[\w.]+\s*;\s*$/.test(trimmed)
    || isConflictMergeImportSpacerLine(line);
}

/**
 * 判断当前行是否仍属于 Kotlin / KTS 的 shebang / file annotation / package / 空白 / 注释前导区域。
 */
function isConflictMergeKotlinPreambleLine(line: string): boolean {
  const trimmed = String(line || "").trim();
  return !trimmed
    || /^#!\//.test(trimmed)
    || /^@file:/.test(trimmed)
    || /^package\s+[\w.]+\s*;?\s*$/.test(trimmed)
    || isConflictMergeImportSpacerLine(line);
}

/**
 * 按语言前导规则定位 import block 起点；若前导区后不是合法 import，则视为当前文件无 provider-support import range。
 */
function resolveConflictMergeImportBlockStart(
  tokens: string[],
  language: ConflictMergeImportLanguage,
): number | null {
  let index = 0;
  while (index < tokens.length) {
    const line = tokens[index] || "";
    const isPreambleLine = language === "java"
      ? isConflictMergeJavaPreambleLine(line)
      : isConflictMergeKotlinPreambleLine(line);
    if (!isPreambleLine) break;
    index += 1;
  }

  if (index >= tokens.length) return null;
  const isImportLine = language === "java"
    ? isConflictMergeJavaImportLine(tokens[index] || "")
    : isConflictMergeKotlinImportLine(tokens[index] || "");
  return isImportLine ? index : null;
}

/**
 * 从 provider-support 的逐行 token 中识别 import block，并抽取后续 UI / 降级逻辑所需的 import entry。
 */
function detectConflictMergeImportBlock(
  tokens: string[],
  language: ConflictMergeImportLanguage,
): ConflictMergeImportBlock | null {
  const start = resolveConflictMergeImportBlockStart(tokens, language);
  if (start == null) return null;

  const entries: GitConflictMergeImportEntry[] = [];
  let index = start;
  while (index < tokens.length) {
    const current = tokens[index] || "";
    if (isConflictMergeImportSpacerLine(current)) {
      index += 1;
      continue;
    }
    const isImportLine = language === "java"
      ? isConflictMergeJavaImportLine(current)
      : isConflictMergeKotlinImportLine(current);
    if (!isImportLine) break;

    const statementStart = index;
    let statement = current;
    let lastLine = current;
    index += 1;
    while (index < tokens.length) {
      const trimmed = lastLine.trim();
      if (/[;)]\s*$/.test(trimmed) || /^from\b.+\bimport\b/.test(trimmed) || /^import\s+["']/.test(trimmed)) break;
      const nextLine = tokens[index] || "";
      statement += nextLine;
      lastLine = nextLine;
      index += 1;
      if (/[;)]\s*$/.test(nextLine.trim())) break;
    }
    entries.push(buildConflictMergeImportEntry(statement, statementStart, index));
  }

  return {
    range: {
      start,
      end: index,
    },
    entries,
  };
}

/**
 * 解析当前文本中的顶部 import block，并返回完整语句级条目；用于结果列 import 去重、合并与顺序维护。
 */
export function parseConflictMergeImportBlock(args: {
  path: string;
  text: string;
}): ConflictMergeImportBlock | null {
  const language = resolveConflictMergeImportLanguage(args.path);
  if (!language) return null;
  const block = detectConflictMergeImportBlock(splitConflictMergeLineTokens(args.text), language);
  if (!block) return null;
  return {
    range: { ...block.range },
    entries: block.entries.map((entry) => ({ ...entry })),
  };
}

/**
 * 按源码侧 import 顺序推导新语句的插入行；优先找后继锚点，其次找前驱锚点，最后退回 import block 末尾。
 */
function resolveConflictMergeImportInsertLine(args: {
  currentBlock: ConflictMergeImportBlock;
  preferredEntries: GitConflictMergeImportEntry[];
  requiredEntry: GitConflictMergeImportEntry;
}): number {
  const normalizedCurrentEntries = new Map(
    args.currentBlock.entries.map((entry) => [normalizeConflictMergeImportStatement(entry.statement), entry] as const),
  );
  const requiredIndex = args.preferredEntries.findIndex(
    (entry) => normalizeConflictMergeImportStatement(entry.statement) === normalizeConflictMergeImportStatement(args.requiredEntry.statement),
  );
  if (requiredIndex >= 0) {
    for (let index = requiredIndex + 1; index < args.preferredEntries.length; index += 1) {
      const nextEntry = normalizedCurrentEntries.get(normalizeConflictMergeImportStatement(args.preferredEntries[index]?.statement || ""));
      if (nextEntry) return nextEntry.lineStart;
    }
    for (let index = requiredIndex - 1; index >= 0; index -= 1) {
      const previousEntry = normalizedCurrentEntries.get(normalizeConflictMergeImportStatement(args.preferredEntries[index]?.statement || ""));
      if (previousEntry) return previousEntry.lineEnd;
    }
  }

  const sameModuleEntry = args.currentBlock.entries.find(
    (entry) => entry.moduleSpecifier && entry.moduleSpecifier === args.requiredEntry.moduleSpecifier,
  );
  if (sameModuleEntry) return sameModuleEntry.lineEnd;
  return args.currentBlock.range.end;
}

/**
 * 把“当前结果列 import block”与来源侧所需 import 做语句级合并；已存在语句直接跳过，同模块 named import 会并入现有声明，其余按来源顺序插回 import block。
 */
export function reconcileConflictMergeImportBlock(args: {
  path: string;
  currentText: string;
  preferredEntries: GitConflictMergeImportEntry[];
  requiredEntries: GitConflictMergeImportEntry[];
}): string | null {
  if (args.requiredEntries.length <= 0) return args.currentText;
  const language = resolveConflictMergeImportLanguage(args.path);
  if (!language) return null;
  let workingTokens = splitConflictMergeLineTokens(args.currentText);

  for (const requiredEntry of args.requiredEntries) {
    const currentBlock = detectConflictMergeImportBlock(workingTokens, language);
    if (!currentBlock) return null;

    const normalizedRequired = normalizeConflictMergeImportStatement(requiredEntry.statement);
    if (currentBlock.entries.some((entry) => normalizeConflictMergeImportStatement(entry.statement) === normalizedRequired)) continue;

    const mergeTarget = currentBlock.entries.find((entry) => {
      if (!entry.moduleSpecifier || entry.moduleSpecifier !== requiredEntry.moduleSpecifier) return false;
      return mergeConflictMergeImportStatements(entry, requiredEntry) != null;
    });
    if (mergeTarget) {
      const mergedStatement = mergeConflictMergeImportStatements(mergeTarget, requiredEntry);
      if (mergedStatement) {
        workingTokens = [
          ...workingTokens.slice(0, mergeTarget.lineStart),
          ...splitConflictMergeLineTokens(mergedStatement),
          ...workingTokens.slice(mergeTarget.lineEnd),
        ];
        continue;
      }
    }

    const insertLine = resolveConflictMergeImportInsertLine({
      currentBlock,
      preferredEntries: args.preferredEntries,
      requiredEntry,
    });
    workingTokens = [
      ...workingTokens.slice(0, insertLine),
      ...splitConflictMergeLineTokens(requiredEntry.statement),
      ...workingTokens.slice(insertLine),
    ];
  }

  return joinConflictMergeTokens(workingTokens);
}

/**
 * 分析三侧 import block 元数据；只有三侧都能识别到顶部 import block 时才开启 import-specific。
 */
export function analyzeConflictMergeImportMetadata(args: {
  path: string;
  baseText: string;
  oursText: string;
  theirsText: string;
}): GitConflictMergeImportMetadata | null {
  const language = resolveConflictMergeImportLanguage(args.path);
  if (!language) return null;

  const baseBlock = detectConflictMergeImportBlock(splitConflictMergeLineTokens(args.baseText), language);
  const oursBlock = detectConflictMergeImportBlock(splitConflictMergeLineTokens(args.oursText), language);
  const theirsBlock = detectConflictMergeImportBlock(splitConflictMergeLineTokens(args.theirsText), language);
  if (!baseBlock || !oursBlock || !theirsBlock) return null;

  return {
    supported: true,
    autoResolveEnabled: true,
    baseRange: baseBlock.range,
    oursRange: oursBlock.range,
    theirsRange: theirsBlock.range,
    oursEntries: oursBlock.entries,
    theirsEntries: theirsBlock.entries,
  };
}

/**
 * 从给定 import entry 列表中过滤出当前文本真正引用到的 import 语句。
 */
export function collectConflictMergeRequiredImports(args: {
  text: string;
  entries: GitConflictMergeImportEntry[];
  existingStatements: Iterable<string>;
}): GitConflictMergeImportEntry[] {
  const identifiers = extractConflictMergeIdentifiers(args.text);
  const existing = new Set(Array.from(args.existingStatements, (one) => normalizeConflictMergeImportStatement(one)));
  const result: GitConflictMergeImportEntry[] = [];

  for (const entry of args.entries) {
    if (!entry.importedSymbols.some((one) => identifiers.has(one))) continue;
    const key = normalizeConflictMergeImportStatement(entry.statement);
    if (existing.has(key)) continue;
    existing.add(key);
    result.push(entry);
  }
  return result;
}
