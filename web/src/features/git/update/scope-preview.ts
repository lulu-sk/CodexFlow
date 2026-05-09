import type { GitUpdateOptions, GitUpdateScopePreview, GitUpdateScopePreviewRoot } from "./types";

type GitUpdateScopeTextResolver = (key: string, fallback: string, values?: Record<string, unknown>) => string;

/**
 * 将仓库路径规整为稳定键值，便于前端列表去重、排序和匹配。
 */
export function toRepoRootKey(value: string): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 在前端保持仓库根路径列表有序去重，避免大小写或分隔符差异导致重复路径。
 */
export function dedupeRepoRoots(items: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const item of items) {
    const repoRoot = String(item || "").trim();
    const repoKey = toRepoRootKey(repoRoot);
    if (!repoRoot || !repoKey || byKey.has(repoKey)) continue;
    byKey.set(repoKey, repoRoot);
  }
  return Array.from(byKey.values());
}

/**
 * 把多仓来源类型转换为界面短标签，统一复用在持久化与运行期范围对话框。
 */
export function getScopeSourceLabel(source: GitUpdateScopePreviewRoot["source"], resolveText?: GitUpdateScopeTextResolver): string {
  const resolveLabel = (key: string, fallback: string): string => {
    return resolveText ? resolveText(key, fallback) : fallback;
  };
  switch (source) {
    case "linked":
      return resolveLabel("dialogs.updateScope.source.linked", "关联仓");
    case "nested":
      return resolveLabel("dialogs.updateScope.source.nested", "嵌套仓");
    case "submodule":
      return resolveLabel("dialogs.updateScope.source.submodule", "子模块");
    default:
      return resolveLabel("dialogs.updateScope.source.current", "当前仓");
  }
}

/**
 * 判断指定预览仓是否允许在界面中切换纳入状态；当前仓始终固定纳入。
 */
export function canToggleScopeRoot(root: GitUpdateScopePreviewRoot): boolean {
  return root.source !== "current";
}

/**
 * 按“当前仓 -> 已纳入 -> 深度 -> 路径”的顺序稳定排序预览仓列表，避免刷新时抖动。
 */
export function sortScopePreviewRoots(roots: readonly GitUpdateScopePreviewRoot[]): GitUpdateScopePreviewRoot[] {
  return [...roots].sort((left, right) => {
    if (left.source === "current" && right.source !== "current") return -1;
    if (left.source !== "current" && right.source === "current") return 1;
    if (left.included !== right.included) return left.included ? -1 : 1;
    if (left.depth !== right.depth) return left.depth - right.depth;
    return left.repoRoot.localeCompare(right.repoRoot);
  });
}

/**
 * 判断当前 Update Project 是否存在可供用户一次性调整的运行期范围。
 */
export function shouldPromptRuntimeUpdateScope(preview: GitUpdateScopePreview): boolean {
  return preview.roots.some((root) => canToggleScopeRoot(root));
}

/**
 * 根据运行期勾选结果构造本次 Update Project 的显式范围 payload，避免覆盖持久化默认值。
 */
export function buildRuntimeUpdateScopePayload(
  snapshot: Pick<GitUpdateOptions, "scope"> | { scope: GitUpdateOptions["scope"] },
  preview: GitUpdateScopePreview,
  includedRepoRootsInput: readonly string[],
): Record<string, any> {
  const requestedRepoRoot = String(preview.requestedRepoRoot || "").trim();
  const requestedKey = toRepoRootKey(requestedRepoRoot);
  const includedRepoRoots = dedupeRepoRoots(includedRepoRootsInput);
  const includedKeySet = new Set(includedRepoRoots.map((repoRoot) => toRepoRootKey(repoRoot)).filter(Boolean));

  if (requestedKey) includedKeySet.add(requestedKey);

  const runtimeRepoRoots = dedupeRepoRoots(
    preview.roots
      .map((root) => root.repoRoot)
      .filter((repoRoot) => includedKeySet.has(toRepoRootKey(repoRoot))),
  );
  const skipRoots = dedupeRepoRoots(
    preview.roots
      .filter((root) => canToggleScopeRoot(root))
      .map((root) => root.repoRoot)
      .filter((repoRoot) => !includedKeySet.has(toRepoRootKey(repoRoot))),
  );

  return {
    repoRoots: runtimeRepoRoots.length > 0 ? runtimeRepoRoots : [requestedRepoRoot],
    skipRoots,
    includeNestedRoots: snapshot.scope.includeNestedRoots,
    rootScanMaxDepth: snapshot.scope.rootScanMaxDepth,
  };
}
