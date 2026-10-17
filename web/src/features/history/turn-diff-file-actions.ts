// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { parseHistoryTurnDiff } from "./turn-diff";

export type HistoryDiffSource = "apply_patch" | "file_change" | "turn_diff";

/** 按差异来源选择相对路径基准，兼容缺少来源字段的旧历史记录。 */
export function resolveHistoryDiffPathBase(options: {
  source?: HistoryDiffSource;
  format: "unified" | "apply_patch";
  projectWinPath?: string;
  cwd?: string;
}): string | undefined {
  const relativeToCwd = options.source ? options.source !== "turn_diff" : options.format === "apply_patch";
  return relativeToCwd ? options.cwd || options.projectWinPath : options.projectWinPath || options.cwd;
}

/** 生成与历史差异摘要一致的路径比较键，保留 Linux 文件名的大小写区别。 */
export function historyDiffFileKey(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(normalized) || value.startsWith("\\\\") || value.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

/** 按原文文件头切分差异，避免按路径聚合后改变跨文件操作的先后顺序。 */
function splitHistoryDiffFileSections(diffText: string, applyPatch: boolean): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let insidePatch = !applyPatch;
  for (const line of diffText.replace(/\r\n?/g, "\n").split("\n")) {
    if (applyPatch && (line === "*** Begin Patch" || line === "*** End Patch")) {
      if (current.length > 0) sections.push(current.join("\n"));
      current = [];
      insidePatch = line === "*** Begin Patch";
      continue;
    }
    if (!insidePatch) continue;
    const fileHeader = applyPatch ? /^\*\*\* (Update|Add|Delete) File:/.test(line) : line.startsWith("diff --git ");
    if (fileHeader) {
      if (current.length > 0) sections.push(current.join("\n"));
      current = [line];
    } else if (current.length > 0 || !applyPatch) current.push(line);
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

/** 仅提取指定文件的原始差异段，保留重复修改顺序、移动信息和补丁元数据。 */
export function selectHistoryTurnDiffFiles(diffText: string, paths: readonly string[]): string {
  const selectedKeys = new Set(paths.map(historyDiffFileKey));
  if (selectedKeys.size === 0 || selectedKeys.has("unknown")) return "";
  const parsed = parseHistoryTurnDiff(diffText);
  if (parsed.files.length === 0) return "";
  // 全部文件仍使用原文，避免改变补丁边界与换行格式。
  if (parsed.files.every((file) => selectedKeys.has(historyDiffFileKey(file.path)))) return diffText;
  const applyPatch = parsed.format === "apply_patch";
  const selectedSources = new Set(paths.map((path) => historyDiffFileKey(path.split(" -> ")[0])));
  const sections = splitHistoryDiffFileSections(diffText, applyPatch).filter((section) => {
    const sectionPatch = applyPatch ? `*** Begin Patch\n${section}\n*** End Patch` : section;
    const files = parseHistoryTurnDiff(sectionPatch).files;
    return files.length === 1 && files[0].path !== "unknown"
      && (selectedKeys.has(historyDiffFileKey(files[0].path))
        || (applyPatch && selectedSources.has(historyDiffFileKey(files[0].path.split(" -> ")[0]))));
  });
  if (sections.length === 0) return "";
  const body = sections.join("\n").replace(/\n*$/, "\n");
  return applyPatch ? `*** Begin Patch\n${body}*** End Patch\n` : body;
}

/** 解析文件当前路径；移动记录使用目标路径，WSL 挂载盘转换为 Windows 路径。 */
export function resolveHistoryDiffFilePath(filePath: string, projectWinPath?: string, cwd?: string): string {
  const rawPath = String(filePath.split(" -> ").pop() || "").trim();
  if (!rawPath || rawPath === "unknown" || rawPath === "/dev/null") return "";
  const basePath = String(cwd || projectWinPath || "").trim();
  const resolved = /^[a-z]:[\\/]/i.test(rawPath) || rawPath.startsWith("/") || rawPath.startsWith("\\\\")
    ? rawPath
    : basePath ? `${basePath.replace(/[\\/]$/, "")}/${rawPath}` : "";
  const mountedPath = /^\/mnt\/([a-z])\/(.*)$/i.exec(resolved.replace(/\\/g, "/"));
  if (mountedPath) return `${mountedPath[1].toUpperCase()}:\\${mountedPath[2].replace(/\//g, "\\")}`;
  return /^[a-z]:[\\/]/i.test(resolved) || resolved.startsWith("\\\\") ? resolved.replace(/\//g, "\\") : resolved;
}
