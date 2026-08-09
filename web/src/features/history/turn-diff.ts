// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type HistoryDiffLineKind = "meta" | "hunk" | "context" | "addition" | "deletion";

export type HistoryDiffLine = {
  kind: HistoryDiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  /** 当前 hunk 前被省略的未修改旧文件行数。 */
  unchangedLines?: number;
};

export type HistoryDiffFile = {
  path: string;
  additions: number;
  deletions: number;
  lines: HistoryDiffLine[];
};

export type HistoryTurnDiff = {
  files: HistoryDiffFile[];
  /** 按文件路径合并后的摘要列表，供对话中的紧凑卡片使用。 */
  summaryFiles: HistoryDiffFile[];
  additions: number;
  deletions: number;
  /** 审核视图中的原始差异段数量。 */
  rawFileCount: number;
  format: "unified" | "apply_patch";
};

export type HistoryDiffSplitRow =
  | { kind: "hunk"; unchangedLines: number }
  | { kind: "content"; left: HistoryDiffLine | null; right: HistoryDiffLine | null };

/**
 * 将统一差异行转换为左右比较行，并在同一修改块内按顺序配对删除与新增内容。
 */
export function buildHistoryDiffSplitRows(lines: readonly HistoryDiffLine[]): HistoryDiffSplitRow[] {
  const rows: HistoryDiffSplitRow[] = [];
  let deletions: HistoryDiffLine[] = [];
  let additions: HistoryDiffLine[] = [];

  /**
   * 输出当前连续修改块，数量不足的一侧使用空白单元格补齐。
   */
  const flushChanges = (): void => {
    const rowCount = Math.max(deletions.length, additions.length);
    for (let index = 0; index < rowCount; index += 1) {
      rows.push({
        kind: "content",
        left: deletions[index] || null,
        right: additions[index] || null,
      });
    }
    deletions = [];
    additions = [];
  };

  for (const line of lines) {
    if (line.kind === "deletion") {
      deletions.push(line);
      continue;
    }
    if (line.kind === "addition") {
      additions.push(line);
      continue;
    }

    flushChanges();
    if (line.kind === "context") {
      rows.push({ kind: "content", left: line, right: line });
      continue;
    }
    if (line.kind === "hunk") {
      const unchangedLines = Math.max(0, Number(line.unchangedLines || 0));
      if (unchangedLines > 0) rows.push({ kind: "hunk", unchangedLines });
    }
  }

  flushChanges();
  return rows;
}

/**
 * 规范化 Git 差异头中的文件路径，供差异摘要与审核标题使用。
 */
function normalizeDiffPath(rawPath: string): string {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed || trimmed === "/dev/null") return "";
  let value = trimmed;
  if (value.startsWith('"') && value.endsWith('"')) {
    try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
  }
  return value.replace(/^[ab]\//, "");
}

/**
 * 从 diff --git 头中提取目标文件路径，兼容常见的空格文件名。
 */
function resolveDiffGitTargetPath(line: string): string {
  const markerIndex = line.lastIndexOf(" b/");
  if (markerIndex < 0) return "";
  return normalizeDiffPath(line.slice(markerIndex + 1));
}

/**
 * 创建一个用于逐行累计的历史差异文件对象。
 */
function createHistoryDiffFile(path: string): HistoryDiffFile {
  return { path: path || "unknown", additions: 0, deletions: 0, lines: [] };
}

/**
 * 生成跨平台的文件路径比较键，避免同一文件因斜杠或大小写不同被拆成多个摘要项。
 */
function historyDiffPathKey(value: string): string {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

/**
 * 将审核用的原始差异段按文件路径合并为摘要文件列表。
 */
function mergeHistoryDiffFiles(files: HistoryDiffFile[]): HistoryDiffFile[] {
  const merged: HistoryDiffFile[] = [];
  const byPath = new Map<string, HistoryDiffFile>();
  for (const file of files) {
    const key = historyDiffPathKey(file.path);
    const existing = byPath.get(key);
    if (!existing) {
      const copy: HistoryDiffFile = { ...file, lines: [...file.lines] };
      byPath.set(key, copy);
      merged.push(copy);
      continue;
    }
    existing.additions += file.additions;
    existing.deletions += file.deletions;
    existing.lines.push(...file.lines);
  }
  return merged;
}

/**
 * 按 Codex 插件的路径口径显示差异文件：工作目录内显示相对路径，跨目录文件保留规范化绝对路径。
 */
export function formatHistoryDiffPath(rawPath: string, cwd?: string, projectWinPath?: string): string {
  const normalize = (value: string): string => String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  const candidate = normalize(rawPath);
  if (!candidate || candidate === "/dev/null") return candidate;
  const bases = [normalize(cwd || ""), normalize(projectWinPath || "")].filter(Boolean);
  for (const base of bases) {
    const caseInsensitive = /^[a-z]:\//i.test(candidate) || /^[a-z]:\//i.test(base) || candidate.startsWith("//") || base.startsWith("//");
    const left = caseInsensitive ? candidate.toLowerCase() : candidate;
    const right = caseInsensitive ? base.toLowerCase() : base;
    if (left === right) return candidate.split("/").pop() || candidate;
    if (left.startsWith(`${right}/`)) return candidate.slice(base.length + 1);
  }
  return candidate;
}

/**
 * 解析统一差异块的行号起点。
 */
function parseHunkStart(line: string): { oldStart: number; newStart: number } | null {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

/**
 * 解析 Codex `apply_patch` 记录，供缺少标准 turn_diff 事件的历史会话显示改动摘要与审核内容。
 */
function parseHistoryApplyPatch(patchText: string): HistoryTurnDiff {
  const sourceLines = String(patchText || "").replace(/\r\n?/g, "\n").split("\n");
  const files: HistoryDiffFile[] = [];
  const filesByPath = new Map<string, HistoryDiffFile>();
  let current: HistoryDiffFile | null = null;
  let insidePatch = false;

  for (const line of sourceLines) {
    if (line === "*** Begin Patch") {
      insidePatch = true;
      current = null;
      continue;
    }
    if (line === "*** End Patch") {
      insidePatch = false;
      current = null;
      continue;
    }
    if (!insidePatch) continue;

    const fileHeader = /^\*\*\* (Update|Add|Delete) File:\s*(.+)$/.exec(line);
    if (fileHeader) {
      const path = normalizeDiffPath(fileHeader[2] || "") || "unknown";
      current = filesByPath.get(path) || createHistoryDiffFile(path);
      if (!filesByPath.has(path)) {
        filesByPath.set(path, current);
        files.push(current);
      }
      current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (!current) continue;

    const moveHeader = /^\*\*\* Move to:\s*(.+)$/.exec(line);
    if (moveHeader) {
      const targetPath = normalizeDiffPath(moveHeader[1] || "");
      if (targetPath) current.path = `${current.path} -> ${targetPath}`;
      current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("@@")) {
      current.lines.push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("+")) {
      current.additions += 1;
      current.lines.push({ kind: "addition", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("-")) {
      current.deletions += 1;
      current.lines.push({ kind: "deletion", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith(" ")) {
      current.lines.push({ kind: "context", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.trim()) current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
  }

  return {
    files,
    summaryFiles: files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    rawFileCount: files.length,
    format: "apply_patch",
  };
}

/**
 * 解析 Codex turn_diff 中的统一差异，生成按文件分组的可渲染结构和增删统计。
 */
export function parseHistoryTurnDiff(diffText: string): HistoryTurnDiff {
  if (/^\*\*\* Begin Patch$/m.test(String(diffText || "")))
    return parseHistoryApplyPatch(diffText);

  const sourceLines = String(diffText || "").replace(/\r\n?/g, "\n").split("\n");
  const files: HistoryDiffFile[] = [];
  let current: HistoryDiffFile | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const line of sourceLines) {
    if (line.startsWith("diff --git ")) {
      current = createHistoryDiffFile(resolveDiffGitTargetPath(line));
      files.push(current);
      current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      oldLine = null;
      newLine = null;
      continue;
    }

    if (!current) {
      if (!line.trim()) continue;
      current = createHistoryDiffFile("");
      files.push(current);
    }

    if (line.startsWith("+++ ")) {
      const nextPath = normalizeDiffPath(line.slice(4));
      if (nextPath) current.path = nextPath;
      current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("--- ")) {
      const previousPath = normalizeDiffPath(line.slice(4));
      if ((current.path === "unknown" || !current.path) && previousPath) current.path = previousPath;
      current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }

    const hunkStart = parseHunkStart(line);
    if (hunkStart) {
      const unchangedLines = Math.max(0, hunkStart.oldStart - (oldLine ?? 1));
      oldLine = hunkStart.oldStart;
      newLine = hunkStart.newStart;
      current.lines.push({ kind: "hunk", text: line, oldLine: null, newLine: null, unchangedLines });
      continue;
    }

    if (oldLine !== null && newLine !== null && line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
      current.lines.push({ kind: "addition", text: line, oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (oldLine !== null && newLine !== null && line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
      current.lines.push({ kind: "deletion", text: line, oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    if (oldLine !== null && newLine !== null && line.startsWith(" ")) {
      current.lines.push({ kind: "context", text: line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    current.lines.push({ kind: "meta", text: line, oldLine: null, newLine: null });
  }

  return {
    files,
    summaryFiles: mergeHistoryDiffFiles(files),
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    rawFileCount: files.length,
    format: "unified",
  };
}
