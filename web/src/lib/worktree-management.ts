import type { DirTreeStore, GitDirInfo, Project } from "@/types/host";

type WorktreeManagementArgs = {
  projectId: string;
  store: DirTreeStore;
  projects: Project[];
  gitInfoByProjectId: Record<string, GitDirInfo>;
};

/**
 * 中文说明：将目录路径标准化为可稳定匹配的 Key（兼容 Windows 大小写不敏感）。
 */
function toPathKey(pathValue: string): string {
  try {
    const raw = String(pathValue || "").trim();
    if (!raw) return "";
    return raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(pathValue || "");
  }
}

/**
 * 中文说明：按主 worktree 路径查找对应的项目节点。
 */
function findProjectIdByMainWorktreePath(projects: Project[], mainWorktreePath: string): string {
  const targetKey = toPathKey(mainWorktreePath);
  if (!targetKey) return "";
  const matched = projects.find((project) => toPathKey(project?.winPath || "") === targetKey) || null;
  return String(matched?.id || "").trim();
}

/**
 * 中文说明：解析单个项目所属 worktree 组的稳定 Key。
 * - 优先使用 `mainWorktree`，保证同一仓库下的主/子 worktree 可归为一组；
 * - 回退到当前目录路径，兼容异常或信息未完全加载的场景。
 */
function resolveProjectWorktreeGroupKey(project: Project | null | undefined, info: GitDirInfo | null | undefined): string {
  return toPathKey(String(info?.mainWorktree || info?.dir || project?.winPath || ""));
}

/**
 * 中文说明：解析当前管理作用域所属的 worktree 组 Key。
 * - 优先使用管理父节点的组 Key；
 * - 若父节点信息缺失，则回退到当前项目。
 */
function resolveManagedWorktreeGroupKey(args: WorktreeManagementArgs, parentProjectId: string): string {
  const parentId = String(parentProjectId || "").trim();
  const parentProject = args.projects.find((project) => String(project?.id || "").trim() === parentId) || null;
  const parentInfo = parentId ? args.gitInfoByProjectId?.[parentId] : undefined;
  const parentKey = resolveProjectWorktreeGroupKey(parentProject, parentInfo);
  if (parentKey) return parentKey;

  const currentProjectId = String(args.projectId || "").trim();
  const currentProject = args.projects.find((project) => String(project?.id || "").trim() === currentProjectId) || null;
  const currentInfo = currentProjectId ? args.gitInfoByProjectId?.[currentProjectId] : undefined;
  return resolveProjectWorktreeGroupKey(currentProject, currentInfo);
}

/**
 * 中文说明：解析当前项目创建/管理 worktree 时应归属到哪个“主工作区节点”。
 * - 若当前节点已挂在某个父节点下，优先沿用该父节点；
 * - 若当前节点是被提升为根级展示的副 worktree，则尝试按 `mainWorktree` 找回主工作区节点；
 * - 若以上都无法判断，则退回当前节点自身。
 */
export function resolveWorktreeManagementParentProjectId(args: WorktreeManagementArgs): string {
  const projectId = String(args.projectId || "").trim();
  if (!projectId) return "";

  const parentId = String(args.store?.parentById?.[projectId] || "").trim();
  if (parentId) return parentId;

  const info = args.gitInfoByProjectId?.[projectId];
  const currentPathKey = toPathKey(String(info?.dir || ""));
  const mainWorktreePath = String(info?.mainWorktree || "").trim();
  const mainWorktreeKey = toPathKey(mainWorktreePath);
  if (!mainWorktreeKey || (currentPathKey && currentPathKey === mainWorktreeKey)) return projectId;

  const mainProjectId = findProjectIdByMainWorktreePath(args.projects, mainWorktreePath);
  return mainProjectId || projectId;
}

/**
 * 中文说明：获取当前项目所属 worktree 组下、可复用的子 worktree 节点列表。
 * - 先保持目录树中已挂到主节点下的子节点顺序；
 * - 再补入被提升为根级展示、但仍属于同一主 worktree 的副节点；
 * - 返回值始终排除主工作区节点自身。
 */
export function listManagedWorktreeChildIds(args: WorktreeManagementArgs): string[] {
  const parentProjectId = resolveWorktreeManagementParentProjectId(args);
  if (!parentProjectId) return [];
  const groupKey = resolveManagedWorktreeGroupKey(args, parentProjectId);
  const result: string[] = [];
  const seen = new Set<string>();

  /**
   * 中文说明：按既定顺序收集同组副 worktree，自动去重并过滤主节点/异组节点。
   */
  const appendIfMatched = (projectId: string): void => {
    const id = String(projectId || "").trim();
    if (!id || id === parentProjectId || seen.has(id)) return;

    const info = args.gitInfoByProjectId?.[id];
    if (!info?.isWorktree) return;

    const project = args.projects.find((item) => String(item?.id || "").trim() === id) || null;
    const candidateGroupKey = resolveProjectWorktreeGroupKey(project, info);
    if (groupKey && candidateGroupKey !== groupKey) return;

    seen.add(id);
    result.push(id);
  };

  const childIds = Array.isArray(args.store?.childOrderByParent?.[parentProjectId]) ? args.store.childOrderByParent[parentProjectId] : [];
  for (const childId of childIds) {
    appendIfMatched(childId);
  }

  const rootIds = Array.isArray(args.store?.rootOrder) ? args.store.rootOrder : [];
  for (const rootId of rootIds) {
    appendIfMatched(rootId);
  }

  for (const project of Array.isArray(args.projects) ? args.projects : []) {
    appendIfMatched(String(project?.id || ""));
  }

  return result;
}
