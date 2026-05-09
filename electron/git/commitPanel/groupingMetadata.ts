// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import { promises as fsp } from "node:fs";

export type CommitPanelGroupingKey = "directory" | "module" | "repository";

type GroupingRuntime = {
  runGitExecAsync: (repoRoot: string, argv: string[], timeoutMs?: number) => Promise<{ ok: boolean; stdout?: string }>;
};

type RepositoryDescriptor = {
  id: string;
  rootPath: string;
  relativeRootPath: string;
  displayName: string;
  parentId?: string;
  external: boolean;
};

type ModuleDescriptor = {
  id: string;
  rootPath: string;
  relativeRootPath: string;
  displayName: string;
  internal: boolean;
};

type EntryGroupingMetadata = {
  repositoryId?: string;
  repositoryRoot?: string;
  repositoryName?: string;
  repositoryExternal?: boolean;
  repositoryParentId?: string;
  moduleId?: string;
  moduleName?: string;
  moduleInternal?: boolean;
};

export type CommitPanelGroupingSnapshot = {
  availableKeys: CommitPanelGroupingKey[];
  entryMetadataByPath: Record<string, EntryGroupingMetadata>;
};

/**
 * 统一归一化仓库相对路径，避免 Windows/WSL 分隔符差异影响分组命中。
 */
function normalizeRelativePath(pathText: string): string {
  return String(pathText || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * 安全读取 JSON 文件；文件缺失或损坏时返回空对象，避免阻塞主流程。
 */
async function readJsonFileSafe(filePath: string): Promise<any> {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/**
 * 从 `git submodule status --recursive` 输出中提取子模块相对路径列表。
 */
function parseSubmoduleStatusPaths(output: string): string[] {
  const rows = String(output || "").split(/\r?\n/).map((one) => one.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const row of rows) {
    const trimmed = row.replace(/^[+\- U]/, "").trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^[0-9a-fA-F]+\s+(.+?)(?:\s+\(.+\))?$/);
    const relativePath = normalizeRelativePath(match?.[1] || "");
    if (relativePath) out.add(relativePath);
  }
  return Array.from(out);
}

/**
 * 按当前仓库发现可用于 repository grouping 的根路径集合，优先覆盖根仓与递归子模块。
 */
async function discoverRepositoriesAsync(runtime: GroupingRuntime, repoRoot: string): Promise<RepositoryDescriptor[]> {
  const normalizedRepoRoot = path.resolve(repoRoot);
  const rootId = normalizeRelativePath(path.basename(normalizedRepoRoot)) || "root";
  const repositories: RepositoryDescriptor[] = [{
    id: rootId,
    rootPath: normalizedRepoRoot,
    relativeRootPath: "",
    displayName: path.basename(normalizedRepoRoot) || normalizedRepoRoot,
    external: false,
  }];

  const submoduleRes = await runtime.runGitExecAsync(normalizedRepoRoot, ["submodule", "status", "--recursive"], 20_000);
  if (!submoduleRes.ok) return repositories;

  const relativeRoots = parseSubmoduleStatusPaths(submoduleRes.stdout || "");
  const normalizedRoots = relativeRoots
    .map((relativeRootPath) => ({
      rootPath: path.resolve(normalizedRepoRoot, relativeRootPath),
      relativeRootPath,
    }))
    .sort((left, right) => left.relativeRootPath.length - right.relativeRootPath.length || left.relativeRootPath.localeCompare(right.relativeRootPath));

  for (const item of normalizedRoots) {
    const parent = [...repositories]
      .sort((left, right) => right.relativeRootPath.length - left.relativeRootPath.length)
      .find((candidate) => (
        candidate.relativeRootPath !== item.relativeRootPath
        && (candidate.relativeRootPath === "" || item.relativeRootPath.startsWith(`${candidate.relativeRootPath}/`))
      ));
    repositories.push({
      id: normalizeRelativePath(item.relativeRootPath),
      rootPath: item.rootPath,
      relativeRootPath: item.relativeRootPath,
      displayName: path.basename(item.relativeRootPath) || item.relativeRootPath,
      parentId: parent?.id,
      external: false,
    });
  }

  return repositories.sort((left, right) => right.relativeRootPath.length - left.relativeRootPath.length || left.displayName.localeCompare(right.displayName));
}

/**
 * 把 workspace pattern 展开为候选模块目录；当前仅支持最常见的精确路径与 `/*` 通配。
 */
async function expandWorkspacePatternAsync(repoRoot: string, patternText: string): Promise<string[]> {
  const pattern = normalizeRelativePath(patternText);
  if (!pattern) return [];
  if (!pattern.includes("*")) return [pattern];
  if (!pattern.endsWith("/*")) return [];
  const baseDir = pattern.slice(0, -2);
  const absoluteBaseDir = path.resolve(repoRoot, baseDir);
  try {
    const entries = await fsp.readdir(absoluteBaseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeRelativePath(path.posix.join(baseDir.replace(/\\/g, "/"), entry.name)));
  } catch {
    return [];
  }
}

/**
 * 从 package.json / pnpm-workspace / lerna / tsconfig references 中收集模块根目录。
 */
async function discoverModuleRootsAsync(repoRoot: string): Promise<string[]> {
  const candidates = new Set<string>();

  const packageJson = await readJsonFileSafe(path.join(repoRoot, "package.json"));
  const workspacePatterns = Array.isArray(packageJson?.workspaces)
    ? packageJson.workspaces
    : (Array.isArray(packageJson?.workspaces?.packages) ? packageJson.workspaces.packages : []);
  for (const patternText of workspacePatterns) {
    for (const one of await expandWorkspacePatternAsync(repoRoot, String(patternText || ""))) candidates.add(one);
  }

  const lernaJson = await readJsonFileSafe(path.join(repoRoot, "lerna.json"));
  const lernaPatterns = Array.isArray(lernaJson?.packages) ? lernaJson.packages : [];
  for (const patternText of lernaPatterns) {
    for (const one of await expandWorkspacePatternAsync(repoRoot, String(patternText || ""))) candidates.add(one);
  }

  try {
    const pnpmWorkspaceText = await fsp.readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    let inPackages = false;
    for (const rawLine of pnpmWorkspaceText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!inPackages) {
        if (line === "packages:" || line.startsWith("packages:")) inPackages = true;
        continue;
      }
      const match = line.match(/^-\s*["']?(.+?)["']?$/);
      if (!match) {
        if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t")) break;
        continue;
      }
      for (const one of await expandWorkspacePatternAsync(repoRoot, match[1] || "")) candidates.add(one);
    }
  } catch {}

  const tsconfigJson = await readJsonFileSafe(path.join(repoRoot, "tsconfig.json"));
  const references = Array.isArray(tsconfigJson?.references) ? tsconfigJson.references : [];
  for (const reference of references) {
    const refPath = normalizeRelativePath(reference?.path || "");
    if (refPath) candidates.add(refPath);
  }

  return Array.from(candidates)
    .map((one) => normalizeRelativePath(one))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

/**
 * 按模块根目录读取可显示的模块名称；优先取 package.json.name，其次回退目录名。
 */
async function buildModulesAsync(repoRoot: string): Promise<ModuleDescriptor[]> {
  const moduleRoots = await discoverModuleRootsAsync(repoRoot);
  const out: ModuleDescriptor[] = [];
  for (const relativeRootPath of moduleRoots) {
    const absoluteRootPath = path.resolve(repoRoot, relativeRootPath);
    const packageJson = await readJsonFileSafe(path.join(absoluteRootPath, "package.json"));
    const displayName = String(packageJson?.name || path.basename(relativeRootPath) || relativeRootPath).trim();
    const internal = relativeRootPath === "" || /(?:^|\/)node_modules(?:\/|$)/.test(relativeRootPath);
    out.push({
      id: relativeRootPath,
      rootPath: absoluteRootPath,
      relativeRootPath,
      displayName: displayName || relativeRootPath,
      internal,
    });
  }
  return out.filter((moduleDescriptor) => !moduleDescriptor.internal);
}

/**
 * 为单个路径命中最深层 repository/module 根目录，确保子模块与子 package 优先级正确。
 */
function resolveDeepestDescriptor<T extends { relativeRootPath: string }>(descriptors: T[], relativePath: string): T | undefined {
  const cleanPath = normalizeRelativePath(relativePath);
  return descriptors.find((descriptor) => (
    descriptor.relativeRootPath === ""
    || cleanPath === descriptor.relativeRootPath
    || cleanPath.startsWith(`${descriptor.relativeRootPath}/`)
  ));
}

/**
 * 将子仓元数据提升到可见父仓，避免把已归属于父仓的子模块再重复暴露成独立 repository grouping。
 */
function resolveEffectiveRepository(
  repositoriesById: Map<string, RepositoryDescriptor>,
  repository: RepositoryDescriptor | undefined,
): RepositoryDescriptor | undefined {
  let current = repository;
  while (current?.parentId) {
    const parent = repositoriesById.get(current.parentId);
    if (!parent || parent.external) break;
    current = parent;
  }
  return current;
}

/**
 * 为提交面板条目补齐 repository/module 元数据，并输出当前可用 grouping key 集合。
 */
export async function buildCommitPanelGroupingSnapshotAsync(
  runtime: GroupingRuntime,
  repoRoot: string,
  entryPaths: string[],
): Promise<CommitPanelGroupingSnapshot> {
  const repositories = await discoverRepositoriesAsync(runtime, repoRoot);
  const modules = await buildModulesAsync(repoRoot);
  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository] as const));
  const metadataByPath: Record<string, EntryGroupingMetadata> = {};
  const effectiveRepositoryIds = new Set<string>();
  const effectiveModuleIds = new Set<string>();
  for (const rawPath of entryPaths) {
    const relativePath = normalizeRelativePath(rawPath);
    if (!relativePath) continue;
    const repository = resolveEffectiveRepository(repositoryById, resolveDeepestDescriptor(repositories, relativePath));
    const moduleHit = resolveDeepestDescriptor(modules, relativePath);
    if (repository?.id) effectiveRepositoryIds.add(repository.id);
    if (moduleHit?.id) effectiveModuleIds.add(moduleHit.id);
    metadataByPath[relativePath] = {
      repositoryId: repository?.id,
      repositoryRoot: repository?.relativeRootPath || "",
      repositoryName: repository?.displayName,
      repositoryExternal: repository?.external,
      repositoryParentId: repository?.parentId,
      moduleId: moduleHit?.id,
      moduleName: moduleHit?.displayName,
      moduleInternal: moduleHit?.internal,
    };
  }

  const hasMultipleRepositoryRoots = repositories.filter((repository) => !repository.external).length > 1
    || effectiveRepositoryIds.size > 1;
  const availableKeys: CommitPanelGroupingKey[] = ["directory"];
  if (hasMultipleRepositoryRoots) availableKeys.push("repository");
  if (effectiveModuleIds.size > 0) availableKeys.push("module");

  return {
    availableKeys,
    entryMetadataByPath: metadataByPath,
  };
}
