import type { Dirent } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { toFsPathAbs, toFsPathKey } from "../pathKey";
import type {
  GitUpdateAggregatedSession,
  GitUpdateRepositoryGraph,
  GitUpdateRepositoryGraphRuntime,
  GitUpdateRepositoryKind,
  GitUpdateRepositoryNode,
  GitUpdateResultCode,
  GitUpdateRootSessionResult,
  GitUpdateSkipReasonCode,
  GitUpdateSkippedRoot,
} from "./types";

const DISCOVERY_IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
  ".yarn",
  "coverage",
  "dist",
  "build",
  "out",
  "tmp",
  "temp",
  "node_modules",
]);

const RESULT_PRIORITY: Record<GitUpdateResultCode, number> = {
  NOTHING_TO_UPDATE: 1,
  SUCCESS: 2,
  INCOMPLETE: 4,
  CANCEL: 5,
  ERROR: 6,
  NOT_READY: 7,
};

/**
 * 将任意值安全规整为字符串数组，并过滤空值。
 */
function toStringList(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

/**
 * 生成仓库根目录的展示名，优先使用目录名。
 */
function toRootName(repoRoot: string): string {
  const abs = toFsPathAbs(repoRoot);
  const base = path.basename(abs);
  return base || abs;
}

/**
 * 判断一个路径是否为另一路径的祖先目录。
 */
function isAncestorPath(ancestorPath: string, targetPath: string): boolean {
  const ancestorKey = toFsPathKey(ancestorPath);
  const targetKey = toFsPathKey(targetPath);
  if (!ancestorKey || !targetKey || ancestorKey === targetKey) return false;
  return targetKey.startsWith(`${ancestorKey}/`);
}

/**
 * 判断目录名是否应在多仓扫描时剪枝，避免无意义的大目录遍历。
 */
function shouldPruneDiscoveryDir(name: string): boolean {
  const normalized = String(name || "").trim();
  if (!normalized) return true;
  return DISCOVERY_IGNORED_DIR_NAMES.has(normalized);
}

/**
 * 从 `git submodule status --recursive` 输出中提取子模块相对路径列表。
 */
function parseSubmoduleStatusPaths(output: string): string[] {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) return "";
      const normalized = trimmed.replace(/^[ +\-U]?/, "").trim();
      const matched = normalized.match(/^[0-9a-f]+\s+(.+?)(?:\s+\(.+\))?$/i);
      return String(matched?.[1] || "").trim();
    })
    .filter(Boolean);
}

/**
 * 读取目录项；遇到权限或不存在等异常时返回空数组，保证扫描不中断。
 */
async function readDirectoryEntriesAsync(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 判断目录下是否存在 `.git` 标记（目录或文件），用于发现 Git 根目录。
 */
async function hasGitMarkerAsync(dir: string): Promise<boolean> {
  try {
    await fsp.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * 将任意目录解析为其所属的 Git 根目录；无法解析时返回空字符串。
 */
async function resolveRepositoryRootFromPathAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  repoPath: string,
): Promise<string> {
  const cwd = toFsPathAbs(repoPath);
  if (!cwd) return "";
  const topRes = await runtime.runGitExecAsync(cwd, ["rev-parse", "--show-toplevel"], 8_000);
  if (!topRes.ok) return "";
  return toFsPathAbs(String(topRes.stdout || "").trim());
}

/**
 * 解析本次更新的根仓搜索入口，兼容未来显式传入多个 roots 的场景。
 */
async function resolveDiscoverySeedRootsAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  requestedRepoRoot: string,
  payload: any,
): Promise<string[]> {
  const explicitRoots = [
    ...toStringList(payload?.repoRoots),
    ...toStringList(payload?.roots),
    ...toStringList(payload?.additionalRepoRoots),
  ];
  const rawRoots = explicitRoots.length > 0 ? explicitRoots : [requestedRepoRoot];
  const resolvedRoots = new Map<string, string>();
  for (const rawRoot of rawRoots) {
    const resolvedRoot = await resolveRepositoryRootFromPathAsync(runtime, rawRoot);
    const absRoot = toFsPathAbs(resolvedRoot || rawRoot);
    const rootKey = toFsPathKey(absRoot);
    if (!rootKey) continue;
    resolvedRoots.set(rootKey, absRoot);
  }
  if (resolvedRoots.size === 0) {
    const fallbackRoot = toFsPathAbs(requestedRepoRoot);
    const fallbackKey = toFsPathKey(fallbackRoot);
    if (fallbackKey) resolvedRoots.set(fallbackKey, fallbackRoot);
  }
  return Array.from(resolvedRoots.values());
}

/**
 * 解析调用方显式指定的 skip roots，并尽量归一化到真实 Git 根目录。
 */
async function resolveRequestedSkipRootKeysAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  payload: any,
): Promise<Set<string>> {
  const requestedRoots = [
    ...toStringList(payload?.skipRoots),
    ...toStringList(payload?.skippedRoots),
  ];
  const keys = new Set<string>();
  for (const rawRoot of requestedRoots) {
    const resolvedRoot = await resolveRepositoryRootFromPathAsync(runtime, rawRoot);
    const absRoot = toFsPathAbs(resolvedRoot || rawRoot);
    const rootKey = toFsPathKey(absRoot);
    if (rootKey) keys.add(rootKey);
  }
  return keys;
}

/**
 * 递归扫描指定目录下的全部 Git roots，并保留父子仓结构所需的嵌套信息。
 */
async function discoverGitRootsUnderAsync(scanRoot: string, maxDepth: number): Promise<string[]> {
  const rootDir = toFsPathAbs(scanRoot);
  if (!rootDir) return [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  const visitedDirs = new Set<string>();
  const discoveredRoots = new Map<string, string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const currentKey = toFsPathKey(current.dir);
    if (!currentKey || visitedDirs.has(currentKey)) continue;
    visitedDirs.add(currentKey);

    if (await hasGitMarkerAsync(current.dir)) {
      discoveredRoots.set(currentKey, current.dir);
    }
    if (current.depth >= maxDepth) continue;

    const entries = await readDirectoryEntriesAsync(current.dir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.isSymbolicLink()) continue;
      if (shouldPruneDiscoveryDir(entry.name)) continue;
      queue.push({
        dir: path.join(current.dir, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return Array.from(discoveredRoots.values());
}

/**
 * 从显式根仓派生全部子模块根目录，仅依赖 Git 子模块元数据，不扫描任意嵌套仓。
 */
async function discoverSubmoduleRootsAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  seedRoots: string[],
): Promise<Map<string, string>> {
  const discovered = new Map<string, string>();
  for (const seedRoot of seedRoots) {
    const repoRoot = toFsPathAbs(seedRoot);
    if (!repoRoot) continue;
    const statusRes = await runtime.runGitExecAsync(repoRoot, ["submodule", "status", "--recursive"], 20_000);
    if (!statusRes.ok) continue;
    for (const relativePath of parseSubmoduleStatusPaths(statusRes.stdout || "")) {
      const candidatePath = toFsPathAbs(path.join(repoRoot, relativePath));
      if (!candidatePath) continue;
      const resolvedRoot = await resolveRepositoryRootFromPathAsync(runtime, candidatePath);
      const repoPath = toFsPathAbs(resolvedRoot || candidatePath);
      const repoKey = toFsPathKey(repoPath);
      if (!repoKey) continue;
      discovered.set(repoKey, repoPath);
    }
  }
  return discovered;
}

/**
 * 读取仓库是否处于 Detached HEAD，并在可能时补齐 short SHA。
 */
async function resolveHeadStateAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  repoRoot: string,
): Promise<{ detachedHead: boolean; headSha?: string }> {
  const branchRes = await runtime.runGitExecAsync(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 8_000);
  const branch = String(branchRes.stdout || "").trim();
  if (branch) return { detachedHead: false };
  const shaRes = await runtime.runGitExecAsync(repoRoot, ["rev-parse", "--short", "HEAD"], 8_000);
  const headSha = shaRes.ok ? String(shaRes.stdout || "").trim() : "";
  return {
    detachedHead: true,
    headSha: headSha || undefined,
  };
}

/**
 * 读取仓库所在的 superproject 根目录；若不是子模块则返回空字符串。
 */
async function resolveSuperprojectRootAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  repoRoot: string,
): Promise<string> {
  const res = await runtime.runGitExecAsync(repoRoot, ["rev-parse", "--show-superproject-working-tree"], 8_000);
  if (!res.ok) return "";
  return toFsPathAbs(String(res.stdout || "").trim());
}

/**
 * 为指定仓库寻找最近的父级 Git root，用于建立父子仓依赖关系。
 */
function resolveNearestParentRoot(
  repoRoot: string,
  rootMap: Map<string, string>,
): string | undefined {
  let hit = "";
  for (const candidate of rootMap.values()) {
    if (!isAncestorPath(candidate, repoRoot)) continue;
    if (!hit || candidate.length > hit.length) {
      hit = candidate;
    }
  }
  return hit || undefined;
}

/**
 * 根据父级仓/子模块关系计算层级深度，便于后续稳定排序。
 */
function resolveRootDepth(
  repoRoot: string,
  parentRootByKey: Map<string, string | undefined>,
): number {
  let depth = 0;
  let currentKey = toFsPathKey(repoRoot);
  const visited = new Set<string>();
  while (currentKey && !visited.has(currentKey)) {
    visited.add(currentKey);
    const parentRoot = parentRootByKey.get(currentKey);
    const parentKey = toFsPathKey(parentRoot || "");
    if (!parentKey) break;
    depth++;
    currentKey = parentKey;
  }
  return depth;
}

/**
 * 按 IDEA 的依赖顺序稳定排序 roots：父仓优先，同层按路径排序。
 */
function compareRepositoryNodes(left: GitUpdateRepositoryNode, right: GitUpdateRepositoryNode): number {
  if (left.depth !== right.depth) return left.depth - right.depth;
  return toFsPathKey(left.repoRoot).localeCompare(toFsPathKey(right.repoRoot));
}

/**
 * 基于 root 节点信息构建统一的 skipped root 描述。
 */
export function buildSkippedRoot(
  root: Pick<GitUpdateRepositoryNode, "repoRoot" | "rootName" | "kind" | "parentRepoRoot">,
  reasonCode: GitUpdateSkipReasonCode,
  reason: string,
): GitUpdateSkippedRoot {
  return {
    repoRoot: root.repoRoot,
    rootName: root.rootName,
    kind: root.kind,
    parentRepoRoot: root.parentRepoRoot,
    reasonCode,
    reason,
  };
}

/**
 * 构建多仓 Update Project 的 Root Graph，并区分普通仓与子模块。
 */
export async function buildRepositoryGraphAsync(
  runtime: GitUpdateRepositoryGraphRuntime,
  payload: any,
): Promise<GitUpdateRepositoryGraph> {
  const requestedRepoRoot = toFsPathAbs(runtime.repoRoot);
  const includeNestedRoots = payload?.includeDiscoveredNestedRoots === true || payload?.includeNestedRoots === true;
  const maxDepth = Math.max(0, Math.min(12, Math.floor(Number(payload?.rootScanMaxDepth) || 8)));
  const seedRoots = await resolveDiscoverySeedRootsAsync(runtime, requestedRepoRoot, payload);
  const skipRootKeys = await resolveRequestedSkipRootKeysAsync(runtime, payload);

  const discoveredRootMap = new Map<string, string>();
  for (const seedRoot of seedRoots) {
    const repoRoot = await resolveRepositoryRootFromPathAsync(runtime, seedRoot);
    const normalizedRoot = toFsPathAbs(repoRoot || seedRoot);
    const repoKey = toFsPathKey(normalizedRoot);
    if (!repoKey) continue;
    discoveredRootMap.set(repoKey, normalizedRoot);
  }
  for (const [repoKey, repoRoot] of await discoverSubmoduleRootsAsync(runtime, seedRoots)) {
    discoveredRootMap.set(repoKey, repoRoot);
  }
  if (includeNestedRoots) {
    for (const seedRoot of seedRoots) {
      for (const discoveredRoot of await discoverGitRootsUnderAsync(seedRoot, maxDepth)) {
        const resolvedRoot = await resolveRepositoryRootFromPathAsync(runtime, discoveredRoot);
        const repoRoot = toFsPathAbs(resolvedRoot || discoveredRoot);
        const repoKey = toFsPathKey(repoRoot);
        if (!repoKey) continue;
        discoveredRootMap.set(repoKey, repoRoot);
      }
    }
  }

  const requestedKey = toFsPathKey(requestedRepoRoot);
  if (requestedKey && !discoveredRootMap.has(requestedKey)) {
    discoveredRootMap.set(requestedKey, requestedRepoRoot);
  }

  const parentRootByKey = new Map<string, string | undefined>();
  const submoduleParentByKey = new Map<string, string>();
  for (const repoRoot of discoveredRootMap.values()) {
    const repoKey = toFsPathKey(repoRoot);
    const superprojectRoot = await resolveSuperprojectRootAsync(runtime, repoRoot);
    const superprojectKey = toFsPathKey(superprojectRoot);
    if (repoKey && superprojectKey) {
      const resolvedSuperprojectRoot = discoveredRootMap.get(superprojectKey) || superprojectRoot;
      submoduleParentByKey.set(repoKey, resolvedSuperprojectRoot);
      parentRootByKey.set(repoKey, resolvedSuperprojectRoot);
      continue;
    }
    parentRootByKey.set(repoKey, resolveNearestParentRoot(repoRoot, discoveredRootMap));
  }

  const nodes: GitUpdateRepositoryNode[] = [];
  for (const repoRoot of discoveredRootMap.values()) {
    const repoKey = toFsPathKey(repoRoot);
    const parentRepoRoot = parentRootByKey.get(repoKey);
    const headState = await resolveHeadStateAsync(runtime, repoRoot);
    const kind: GitUpdateRepositoryKind = submoduleParentByKey.has(repoKey) ? "submodule" : "repository";
    const node: GitUpdateRepositoryNode = {
      repoRoot,
      rootName: toRootName(repoRoot),
      kind,
      submoduleMode: kind === "submodule" ? (headState.detachedHead ? "detached" : "branch") : undefined,
      parentRepoRoot,
      depth: resolveRootDepth(repoRoot, parentRootByKey),
      detachedHead: headState.detachedHead,
      headSha: headState.headSha,
    };
    if (skipRootKeys.has(repoKey)) {
      node.requestedSkip = buildSkippedRoot(node, "requested", "已按本次 Update 配置跳过该仓库");
    }
    nodes.push(node);
  }
  nodes.sort(compareRepositoryNodes);

  return {
    requestedRepoRoot,
    roots: nodes,
    discoveredRepoRoots: nodes.map((node) => node.repoRoot),
  };
}

/**
 * 聚合 root 级更新结果，对齐 IDEA `GitUpdateResult.join()` 的优先级语义。
 */
export function aggregateUpdateRootResults(results: GitUpdateRootSessionResult[]): GitUpdateAggregatedSession {
  const successRoots: string[] = [];
  const failedRoots: string[] = [];
  const skippedRoots: GitUpdateSkippedRoot[] = [];
  const fetchSuccessRoots: string[] = [];
  const fetchFailedRoots: string[] = [];
  const fetchSkippedRoots: string[] = [];
  const nothingToUpdateRoots: string[] = [];
  const updatedRoots: string[] = [];
  const executedRoots: string[] = [];
  let compoundResult: GitUpdateResultCode | null = null;

  for (const result of results) {
    const fetchStatus = result.fetchResult?.status;
    if (fetchStatus === "success") fetchSuccessRoots.push(result.repoRoot);
    if (fetchStatus === "failed" || fetchStatus === "cancelled") fetchFailedRoots.push(result.repoRoot);
    if (fetchStatus === "skipped") fetchSkippedRoots.push(result.repoRoot);

    if (result.resultCode === "SKIPPED") {
      skippedRoots.push({
        repoRoot: result.repoRoot,
        rootName: result.rootName,
        kind: result.kind,
        parentRepoRoot: result.parentRepoRoot,
        reasonCode: result.skippedReasonCode || "requested",
        reason: result.skippedReason || "已跳过该仓库",
      });
      continue;
    }

    executedRoots.push(result.repoRoot);
    const resultCode = result.resultCode;
    if (!compoundResult || RESULT_PRIORITY[resultCode] > RESULT_PRIORITY[compoundResult]) {
      compoundResult = resultCode;
    }
    if (result.ok) {
      successRoots.push(result.repoRoot);
      if (result.nothingToUpdate === true || result.resultCode === "NOTHING_TO_UPDATE") {
        nothingToUpdateRoots.push(result.repoRoot);
      } else {
        updatedRoots.push(result.repoRoot);
      }
    } else {
      failedRoots.push(result.repoRoot);
    }
  }

  if (!compoundResult) {
    const hasSoftConfigurationSkip = skippedRoots.some((root) =>
      root.reasonCode === "detached-head" || root.reasonCode === "no-tracked-branch" || root.reasonCode === "remote-missing"
    );
    compoundResult = hasSoftConfigurationSkip ? "NOT_READY" : "NOTHING_TO_UPDATE";
  }

  return {
    resultCode: compoundResult,
    roots: results,
    successRoots,
    failedRoots,
    skippedRoots,
    fetchSuccessRoots,
    fetchFailedRoots,
    fetchSkippedRoots,
    nothingToUpdateRoots,
    updatedRoots,
    executedRoots,
    multiRoot: results.length > 1,
  };
}
