// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type HistorySessionTreeSource = {
  providerId: string;
  id: string;
  codexRelationship?: {
    kind: "main" | "subagent" | "unknown";
    parentThreadId?: string;
  };
};

export type HistorySessionTreeNode<T extends HistorySessionTreeSource> = {
  session: T;
  children: HistorySessionTreeNode<T>[];
  descendantCount: number;
};

export type HistorySessionTree<T extends HistorySessionTreeSource> = {
  roots: HistorySessionTreeNode<T>[];
  byId: Map<string, HistorySessionTreeNode<T>>;
};

/**
 * 规范化会话编号，供父子关系在大小写不同的历史数据间稳定匹配。
 */
function normalizeSessionId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * 判断把当前节点挂到候选父节点后是否会形成循环关系。
 */
function wouldCreateCycle(
  childId: string,
  parentId: string,
  parentById: ReadonlyMap<string, string>,
): boolean {
  const visited = new Set<string>([childId]);
  let current = parentId;
  while (current) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = parentById.get(current) || "";
  }
  return false;
}

/**
 * 递归计算节点下方的全部子孙数量，供主会话的折叠入口显示数量。
 */
function updateDescendantCount<T extends HistorySessionTreeSource>(node: HistorySessionTreeNode<T>): number {
  let count = 0;
  for (const child of node.children) count += 1 + updateDescendantCount(child);
  node.descendantCount = count;
  return count;
}

/**
 * 把 Codex 子代理按 parentThreadId 挂到主会话下；父会话缺失或关系异常时保留为独立根节点。
 */
export function buildHistorySessionTree<T extends HistorySessionTreeSource>(sessions: readonly T[]): HistorySessionTree<T> {
  const nodes = sessions.map((session) => ({ session, children: [], descendantCount: 0 } as HistorySessionTreeNode<T>));
  const byId = new Map<string, HistorySessionTreeNode<T>>();
  for (const node of nodes) {
    const id = normalizeSessionId(node.session.id);
    if (id && !byId.has(id)) byId.set(id, node);
  }

  const parentById = new Map<string, string>();
  for (const node of nodes) {
    const session = node.session;
    if (session.providerId !== "codex" || session.codexRelationship?.kind !== "subagent") continue;
    const childId = normalizeSessionId(session.id);
    const parentId = normalizeSessionId(session.codexRelationship.parentThreadId);
    if (childId && parentId && byId.has(parentId) && childId !== parentId) parentById.set(childId, parentId);
  }

  const attachedIds = new Set<string>();
  for (const node of nodes) {
    const childId = normalizeSessionId(node.session.id);
    const parentId = parentById.get(childId) || "";
    const parent = parentId ? byId.get(parentId) : undefined;
    if (!childId || !parent || wouldCreateCycle(childId, parentId, parentById)) continue;
    parent.children.push(node);
    attachedIds.add(childId);
  }

  const roots = nodes.filter((node) => !attachedIds.has(normalizeSessionId(node.session.id)));
  for (const root of roots) updateDescendantCount(root);
  return { roots, byId };
}

/**
 * 按深度优先顺序展开节点的子孙，便于列表在主会话下按层级渲染。
 */
export function flattenHistorySessionDescendants<T extends HistorySessionTreeSource>(
  node: HistorySessionTreeNode<T>,
): Array<{ node: HistorySessionTreeNode<T>; depth: number }> {
  const result: Array<{ node: HistorySessionTreeNode<T>; depth: number }> = [];
  const append = (parent: HistorySessionTreeNode<T>, depth: number) => {
    for (const child of parent.children) {
      result.push({ node: child, depth });
      append(child, depth + 1);
    }
  };
  append(node, 1);
  return result;
}

/**
 * 判断节点自身或任一子孙是否符合指定条件。
 */
export function historySessionTreeSome<T extends HistorySessionTreeSource>(
  node: HistorySessionTreeNode<T>,
  predicate: (session: T) => boolean,
): boolean {
  if (predicate(node.session)) return true;
  return node.children.some((child) => historySessionTreeSome(child, predicate));
}
