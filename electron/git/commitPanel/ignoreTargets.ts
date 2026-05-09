// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import path from "node:path";
import { normalizeRepoPaths } from "./pathUtils";

export type CommitPanelIgnoreTargetKind = "ignore-file" | "create-ignore-file" | "git-exclude";

export type CommitPanelIgnoreTarget = {
  id: string;
  kind: CommitPanelIgnoreTargetKind;
  label: string;
  description: string;
  targetPath: string;
  displayPath: string;
};

type ListIgnoreTargetsArgs = {
  repoRoot: string;
  gitExcludeFile: string;
  pathsInput: any;
};

type ApplyIgnoreTargetArgs = ListIgnoreTargetsArgs & {
  targetInput: any;
};

type IgnoreTargetListing = {
  ok: boolean;
  data?: {
    repoRoot: string;
    paths: string[];
    targets: CommitPanelIgnoreTarget[];
  };
  error?: string;
};

type ApplyIgnoreTargetResult = {
  ok: boolean;
  data?: {
    repoRoot: string;
    paths: string[];
    target: CommitPanelIgnoreTarget;
    addedCount: number;
  };
  error?: string;
};

/**
 * 生成 ignore 目标的稳定 ID，便于前后端在一次会话内精确识别用户选择。
 */
function toIgnoreTargetId(kind: CommitPanelIgnoreTargetKind, targetPath: string): string {
  return `${kind}:${path.resolve(targetPath).replace(/\\/g, "/").toLowerCase()}`;
}

/**
 * 判断目标路径是否为普通文件。
 */
async function isRegularFileAsync(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 判断目标路径是否位于仓库根目录内或与仓库根目录相同。
 */
function isPathInsideRepo(repoRoot: string, targetPath: string): boolean {
  const repoAbs = path.resolve(repoRoot);
  const targetAbs = path.resolve(targetPath);
  const rel = path.relative(repoAbs, targetAbs);
  return !rel || rel === "." || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 将绝对路径转换为适合 UI 展示的路径文本；仓库内路径优先显示为相对路径。
 */
function toDisplayPath(repoRoot: string, targetPath: string): string {
  const repoAbs = path.resolve(repoRoot);
  const targetAbs = path.resolve(targetPath);
  if (!isPathInsideRepo(repoAbs, targetAbs)) return targetAbs.replace(/\\/g, "/");
  const rel = path.relative(repoAbs, targetAbs).replace(/\\/g, "/");
  return rel || ".";
}

/**
 * 收集某个文件可写入的现有 `.gitignore` 候选，规则对齐 IDEA 的“祖先目录上的 ignore 文件都可用”。
 */
async function collectExistingIgnoreFilesAsync(repoRoot: string, repoRelativePath: string): Promise<string[]> {
  const repoAbs = path.resolve(repoRoot);
  const targetAbs = path.resolve(repoRoot, repoRelativePath);
  let cursor = path.dirname(targetAbs);
  const out: string[] = [];
  while (isPathInsideRepo(repoAbs, cursor)) {
    const candidate = path.join(cursor, ".gitignore");
    if (await isRegularFileAsync(candidate)) out.push(path.resolve(candidate));
    if (path.resolve(cursor) === repoAbs) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return out;
}

/**
 * 求多个候选集合的交集，并按“越靠近文件越优先”的顺序排序。
 */
function intersectIgnoreFiles(repoRoot: string, candidateLists: string[][]): string[] {
  if (candidateLists.length === 0) return [];
  const counts = new Map<string, number>();
  for (const list of candidateLists) {
    for (const one of new Set(list.map((item) => path.resolve(item)))) {
      counts.set(one, (counts.get(one) || 0) + 1);
    }
  }
  const repoAbs = path.resolve(repoRoot);
  return Array.from(counts.entries())
    .filter(([, count]) => count === candidateLists.length)
    .map(([filePath]) => filePath)
    .sort((left, right) => {
      const leftDepth = path.relative(repoAbs, left).split(path.sep).filter(Boolean).length;
      const rightDepth = path.relative(repoAbs, right).split(path.sep).filter(Boolean).length;
      if (leftDepth !== rightDepth) return rightDepth - leftDepth;
      return left.localeCompare(right);
    });
}

/**
 * 根据候选数量构建现有 ignore 文件目标文案；只有一个候选时沿用 IDEA 的泛化语义。
 */
function buildExistingIgnoreTarget(repoRoot: string, targetPath: string, candidateCount: number): CommitPanelIgnoreTarget {
  const displayPath = toDisplayPath(repoRoot, targetPath);
  return {
    id: toIgnoreTargetId("ignore-file", targetPath),
    kind: "ignore-file",
    label: candidateCount === 1 ? "添加到 .gitignore" : `添加到 ${displayPath}`,
    description: displayPath === "." ? "仓库根目录下的 .gitignore" : displayPath,
    targetPath: path.resolve(targetPath),
    displayPath,
  };
}

/**
 * 构建“新建仓库根 `.gitignore`”目标，和 IDEA `CreateNewIgnoreFileAction` 对齐。
 */
function buildCreateIgnoreTarget(repoRoot: string): CommitPanelIgnoreTarget {
  const targetPath = path.resolve(repoRoot, ".gitignore");
  return {
    id: toIgnoreTargetId("create-ignore-file", targetPath),
    kind: "create-ignore-file",
    label: "新建 .gitignore",
    description: "在仓库根目录创建 .gitignore 并写入忽略规则",
    targetPath,
    displayPath: ".gitignore",
  };
}

/**
 * 构建 `.git/info/exclude` 目标，和 IDEA `AddToGitExcludeAction` 对齐。
 */
function buildGitExcludeTarget(repoRoot: string, gitExcludeFile: string): CommitPanelIgnoreTarget {
  const targetPath = path.resolve(gitExcludeFile);
  return {
    id: toIgnoreTargetId("git-exclude", targetPath),
    kind: "git-exclude",
    label: "添加到 .git/info/exclude",
    description: "仅当前仓库本地生效，不会进入版本库",
    targetPath,
    displayPath: toDisplayPath(repoRoot, targetPath),
  };
}

/**
 * 列出当前未跟踪文件可用的 ignore 目标，规则对齐 IDEA 的 ignore action group。
 */
export async function listIgnoreTargetsAsync(args: ListIgnoreTargetsArgs): Promise<IgnoreTargetListing> {
  const repoRoot = path.resolve(args.repoRoot);
  const paths = normalizeRepoPaths(repoRoot, args.pathsInput).filter(Boolean);
  if (paths.length === 0) return { ok: false, error: "缺少可忽略的未跟踪文件" };

  const candidateLists = await Promise.all(paths.map((one) => collectExistingIgnoreFilesAsync(repoRoot, one)));
  const existingIgnoreFiles = intersectIgnoreFiles(repoRoot, candidateLists);
  const targets: CommitPanelIgnoreTarget[] = existingIgnoreFiles.map((one) => buildExistingIgnoreTarget(repoRoot, one, existingIgnoreFiles.length));

  const rootIgnoreFile = path.resolve(repoRoot, ".gitignore");
  if (targets.length === 0 && !(await isRegularFileAsync(rootIgnoreFile))) {
    targets.push(buildCreateIgnoreTarget(repoRoot));
  }

  targets.push(buildGitExcludeTarget(repoRoot, args.gitExcludeFile));
  return {
    ok: true,
    data: {
      repoRoot,
      paths,
      targets,
    },
  };
}

/**
 * 将用户输入解析为已存在的 ignore 目标；只允许命中本次预览返回的目标集合。
 */
function resolveIgnoreTarget(targets: CommitPanelIgnoreTarget[], targetInput: any): CommitPanelIgnoreTarget | null {
  const targetId = String(targetInput?.id || "").trim();
  if (targetId) {
    const byId = targets.find((one) => one.id === targetId);
    if (byId) return byId;
  }
  const kind = String(targetInput?.kind || "").trim();
  const targetPath = String(targetInput?.targetPath || "").trim();
  if (!kind || !targetPath) return null;
  const resolvedPath = path.resolve(targetPath);
  return targets.find((one) => (
    path.resolve(one.targetPath) === resolvedPath
    && (one.kind === kind || (kind === "create-ignore-file" && one.kind === "ignore-file"))
  )) || null;
}

/**
 * 确保目标 ignore 文件存在，必要时自动创建父目录与空文件。
 */
async function ensureIgnoreFileExistsAsync(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fsp.access(filePath);
  } catch {
    await fsp.writeFile(filePath, "", "utf8");
  }
}

/**
 * 把仓库内路径转换为 ignore 文件中的规则行，统一写成锚定到 ignore 根的绝对相对路径。
 */
async function buildIgnoreRuleLinesAsync(repoRoot: string, target: CommitPanelIgnoreTarget, repoRelativePaths: string[]): Promise<string[]> {
  const baseDir = target.kind === "git-exclude"
    ? path.resolve(repoRoot)
    : path.resolve(path.dirname(target.targetPath));
  const out: string[] = [];
  for (const one of repoRelativePaths) {
    const absolutePath = path.resolve(repoRoot, one);
    const rel = path.relative(baseDir, absolutePath).replace(/\\/g, "/");
    if (!rel || rel === "." || rel.startsWith("../") || rel === "..") continue;
    let line = `/${rel.replace(/^\/+/, "")}`;
    try {
      const stat = await fsp.stat(absolutePath);
      if (stat.isDirectory() && !line.endsWith("/")) line = `${line}/`;
    } catch {
      // 未跟踪文件可能在用户操作后被立即删除，此时保持文件规则即可。
    }
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * 把 ignore 规则归一化为便于比较的模式文本；对注释/反向规则返回空值，避免错误去重。
 */
function normalizeIgnoreRuleForCompare(line: string): string {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return "";
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!normalized) return "";
  if (normalized.endsWith("/")) return `${normalized.replace(/\/+$/, "")}/`;
  return normalized;
}

/**
 * 判断某条已有 ignore 规则是否已经覆盖候选规则；目录规则会覆盖其内部所有文件。
 */
function isIgnoreRuleCovered(existingRules: Set<string>, candidateLine: string): boolean {
  const candidate = normalizeIgnoreRuleForCompare(candidateLine);
  if (!candidate) return true;
  if (existingRules.has(candidate)) return true;
  const comparable = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
  if (existingRules.has(comparable) || existingRules.has(`${comparable}/`)) return true;
  const segments = comparable.split("/").filter(Boolean);
  let current = "";
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = current ? `${current}/${segments[index]}` : segments[index];
    if (existingRules.has(`${current}/`)) return true;
  }
  return false;
}

/**
 * 把候选规则按路径深度和字典序稳定排序，避免重复拖拽后文件尾部顺序抖动。
 */
function sortIgnoreRuleLines(lines: string[]): string[] {
  return [...lines].sort((left, right) => {
    const leftDepth = left.split("/").filter(Boolean).length;
    const rightDepth = right.split("/").filter(Boolean).length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return left.localeCompare(right);
  });
}

/**
 * 稳定合并 ignore 文件内容；会做规则覆盖判断、重复去重，并统一收敛文件尾换行。
 */
async function appendIgnoreRuleLinesAsync(filePath: string, lines: string[]): Promise<number> {
  const content = await fsp.readFile(filePath, "utf8").catch(() => "");
  const existingRules = new Set(
    content
      .split(/\r?\n/)
      .map((one) => normalizeIgnoreRuleForCompare(one))
      .filter(Boolean),
  );
  const nextLines = sortIgnoreRuleLines(Array.from(new Set(lines))).filter((one) => !isIgnoreRuleCovered(existingRules, one));
  if (nextLines.length === 0) return 0;
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
  const baseContent = normalizedContent.trimEnd();
  const mergedContent = baseContent
    ? `${baseContent}\n${nextLines.join("\n")}\n`
    : `${nextLines.join("\n")}\n`;
  await fsp.writeFile(filePath, mergedContent, "utf8");
  return nextLines.length;
}

/**
 * 按用户选择把未跟踪文件写入 ignore 目标。
 */
export async function applyIgnoreTargetAsync(args: ApplyIgnoreTargetArgs): Promise<ApplyIgnoreTargetResult> {
  const listing = await listIgnoreTargetsAsync(args);
  if (!listing.ok || !listing.data) return { ok: false, error: listing.error || "读取 ignore 目标失败" };
  const target = resolveIgnoreTarget(listing.data.targets, args.targetInput);
  if (!target) return { ok: false, error: "未找到目标 ignore 文件" };

  const ruleLines = await buildIgnoreRuleLinesAsync(listing.data.repoRoot, target, listing.data.paths);
  if (ruleLines.length === 0) return { ok: false, error: "没有可写入的忽略规则" };

  await ensureIgnoreFileExistsAsync(target.targetPath);
  const addedCount = await appendIgnoreRuleLinesAsync(target.targetPath, ruleLines);
  return {
    ok: true,
    data: {
      repoRoot: listing.data.repoRoot,
      paths: listing.data.paths,
      target,
      addedCount,
    },
  };
}
