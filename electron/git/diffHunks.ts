// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import crypto from "node:crypto";

export type ParsedGitDiffHunkLine = {
  kind: "context" | "add" | "del";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type ParsedGitDiffHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  preview: string;
  patch: string;
  lines: ParsedGitDiffHunkLine[];
};

export type ParsedGitDiffPatch = {
  patch: string;
  patchHeader: string;
  fingerprint: string;
  hunks: ParsedGitDiffHunk[];
};

/**
 * 解析 unified diff hunk 头，提取 old/new 行号区间。
 */
function parseUnifiedHunkHeader(headerLine: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} | null {
  const match = String(headerLine || "").match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: Math.max(0, Number(match[1] || 0)),
    oldLines: Math.max(0, Number(match[2] || 1)),
    newStart: Math.max(0, Number(match[3] || 0)),
    newLines: Math.max(0, Number(match[4] || 1)),
  };
}

/**
 * 为 hunk 生成稳定 id，避免前端刷新后无法恢复已选 hunk。
 */
function buildHunkId(headerLine: string, patchText: string): string {
  return crypto.createHash("sha1").update(`${String(headerLine || "")}\n${String(patchText || "")}`).digest("hex");
}

/**
 * 从 hunk 行列表中提取第一条真正的改动文本，供列表预览与按钮提示复用。
 */
function buildHunkPreview(lines: ParsedGitDiffHunkLine[]): string {
  const changed = lines.find((line) => line.kind === "add" || line.kind === "del");
  const previewSource = changed || lines[0];
  if (!previewSource) return "空 hunk";
  return String(previewSource.content || "").replace(/^[ +-]/, "").trim() || "空 hunk";
}

/**
 * 将 hunk 内逐行 patch 文本解析成带 old/new 行号的结构化行数组。
 */
function parseHunkLines(hunkBodyLines: string[], oldStart: number, newStart: number): ParsedGitDiffHunkLine[] {
  const out: ParsedGitDiffHunkLine[] = [];
  let currentOldLine = oldStart;
  let currentNewLine = newStart;
  for (const rawLine of hunkBodyLines) {
    const marker = rawLine[0];
    if (marker === "\\") continue;
    if (marker === " ") {
      out.push({
        kind: "context",
        content: rawLine,
        oldLineNumber: currentOldLine,
        newLineNumber: currentNewLine,
      });
      currentOldLine += 1;
      currentNewLine += 1;
      continue;
    }
    if (marker === "+") {
      out.push({
        kind: "add",
        content: rawLine,
        newLineNumber: currentNewLine,
      });
      currentNewLine += 1;
      continue;
    }
    if (marker === "-") {
      out.push({
        kind: "del",
        content: rawLine,
        oldLineNumber: currentOldLine,
      });
      currentOldLine += 1;
    }
  }
  return out;
}

/**
 * 解析单文件 unified diff，提取可直接驱动 partial commit 的 header/hunk/指纹信息。
 */
export function parseGitUnifiedPatch(patchText: string): ParsedGitDiffPatch | null {
  const normalizedPatch = String(patchText || "");
  if (!normalizedPatch.trim()) return null;

  const lines = normalizedPatch.split("\n");
  const firstHunkIndex = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunkIndex < 0) return null;

  const patchHeader = `${lines.slice(0, firstHunkIndex).join("\n")}\n`;
  const hunks: ParsedGitDiffHunk[] = [];
  let index = firstHunkIndex;
  while (index < lines.length) {
    const headerLine = lines[index];
    if (!String(headerLine || "").startsWith("@@ ")) {
      index += 1;
      continue;
    }
    const hunkMeta = parseUnifiedHunkHeader(headerLine);
    if (!hunkMeta) {
      index += 1;
      continue;
    }
    const hunkLines: string[] = [headerLine];
    const hunkBodyLines: string[] = [];
    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      hunkLines.push(lines[index]);
      hunkBodyLines.push(lines[index]);
      index += 1;
    }
    const hunkPatch = `${hunkLines.join("\n")}\n`;
    const parsedLines = parseHunkLines(hunkBodyLines, hunkMeta.oldStart, hunkMeta.newStart);
    hunks.push({
      id: buildHunkId(headerLine, hunkPatch),
      header: headerLine,
      oldStart: hunkMeta.oldStart,
      oldLines: hunkMeta.oldLines,
      newStart: hunkMeta.newStart,
      newLines: hunkMeta.newLines,
      preview: buildHunkPreview(parsedLines),
      patch: hunkPatch,
      lines: parsedLines,
    });
  }

  if (hunks.length === 0) return null;
  return {
    patch: normalizedPatch,
    patchHeader,
    fingerprint: crypto.createHash("sha1").update(normalizedPatch).digest("hex"),
    hunks,
  };
}
