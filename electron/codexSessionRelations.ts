// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { getSessionsRootsFastAsync } from "./wsl";
import { isHistoryDeleteStagingName } from "./historyFastDelete";

export type CodexSessionKind = "main" | "subagent" | "unknown";

export type CodexSessionRelationship = {
  kind: CodexSessionKind;
  threadSpawn?: boolean;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  agentDepth?: number;
  forkedFromId?: string;
  historyBaseThreadId?: string;
};

export type CodexSessionRecord = {
  id: string;
  filePath: string;
  mtimeMs: number;
  size: number;
  relationship: CodexSessionRelationship;
};

export type CodexRelationPlanItem = CodexSessionRecord & {
  title: string;
  depth: number;
};

export type CodexRelationDeletePlan = {
  supported: boolean;
  targetId?: string;
  rootId?: string;
  version?: string;
  items: CodexRelationPlanItem[];
  externalReferenceIds: string[];
  reason?: string;
};

export type CodexRelationPlanFileCheck = {
  ok: boolean;
  reason?: "missing" | "changed";
};

const FIRST_LINE_MAX_BYTES = 128 * 1024;

/**
 * 规范化会话编号，避免因空白或历史数据大小写差异导致关系匹配失败。
 */
function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * 规范化用于跨 Windows 与 WSL 比对的会话文件路径。
 */
function pathKey(filePath: string): string {
  return String(filePath || "").replace(/\\/g, "/").toLowerCase();
}

/**
 * 从首条 JSONL 记录提取 Codex 现代会话元数据。
 */
function getSessionMeta(record: unknown): Record<string, any> | null {
  if (!record || typeof record !== "object") return null;
  const source = record as Record<string, any>;
  if (source.type === "session_meta" && source.payload && typeof source.payload === "object")
    return source.payload as Record<string, any>;
  if (source.type === "session_meta") return source;
  return null;
}

/**
 * 从 Codex 的 serde 枚举形状中查找 thread_spawn 载荷。
 */
function findThreadSpawnSource(source: unknown): Record<string, any> | null {
  if (!source || typeof source !== "object") return null;
  const sourceObject = source as Record<string, any>;
  const subagent = sourceObject.subagent ?? sourceObject.sub_agent;
  if (!subagent || typeof subagent !== "object") return null;
  const subagentObject = subagent as Record<string, any>;
  const threadSpawn = subagentObject.thread_spawn ?? subagentObject.threadSpawn;
  return threadSpawn && typeof threadSpawn === "object" ? threadSpawn as Record<string, any> : null;
}

/**
 * 判断会话来源是否由 Codex 子代理产生；review、compact 等内部子代理可能没有 thread_spawn 载荷。
 */
function hasNonRootAgentSource(source: unknown): boolean {
  if (!source || typeof source !== "object") return false;
  const sourceObject = source as Record<string, any>;
  const subagent = sourceObject.subagent ?? sourceObject.sub_agent;
  const internal = sourceObject.internal ?? sourceObject.internal_session;
  const hasVariant = (value: unknown) => typeof value === "string" ? value.trim().length > 0 : !!value && typeof value === "object";
  return hasVariant(subagent) || hasVariant(internal);
}

/**
 * 将 Codex 会话元数据转换为界面与清理逻辑共用的关系描述。
 */
export function extractCodexSessionRelationship(record: unknown): CodexSessionRelationship {
  const meta = getSessionMeta(record);
  if (!meta) return { kind: "unknown" };
  const threadSpawn = findThreadSpawnSource(meta.source);
  const parentThreadId = normalizeId(meta.parent_thread_id ?? threadSpawn?.parent_thread_id);
  const agentDepthRaw = threadSpawn?.depth;
  const agentDepth = typeof agentDepthRaw === "number" && Number.isFinite(agentDepthRaw)
    ? Math.max(0, Math.floor(agentDepthRaw))
    : undefined;
  const forkedFromId = normalizeId(meta.forked_from_id);
  const historyBase = meta.history_base && typeof meta.history_base === "object"
    ? meta.history_base as Record<string, any>
    : null;
  const historyBaseThreadId = normalizeId(historyBase?.thread_id ?? historyBase?.threadId);
  const isSubagent = hasNonRootAgentSource(meta.source);
  const agentNicknameRaw = meta.agent_nickname ?? threadSpawn?.agent_nickname ?? threadSpawn?.agentNickname;
  const agentRoleRaw = meta.agent_role ?? meta.agent_type
    ?? threadSpawn?.agent_role ?? threadSpawn?.agentRole ?? threadSpawn?.agent_type ?? threadSpawn?.agentType;
  return {
    kind: isSubagent ? "subagent" : "main",
    threadSpawn: !!threadSpawn,
    parentThreadId: parentThreadId || undefined,
    agentNickname: typeof agentNicknameRaw === "string" && agentNicknameRaw.trim() ? agentNicknameRaw.trim() : undefined,
    agentRole: typeof agentRoleRaw === "string" && agentRoleRaw.trim() ? agentRoleRaw.trim() : undefined,
    agentDepth,
    forkedFromId: forkedFromId || undefined,
    historyBaseThreadId: historyBaseThreadId || undefined,
  };
}

/**
 * 读取 JSONL 文件首行；解析失败时返回 null，调用方必须采取保守策略。
 */
async function readFirstJsonLine(filePath: string): Promise<unknown | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(filePath, "r");
    const buffer = Buffer.alloc(FIRST_LINE_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "");
    const line = raw.split(/\r?\n/, 1)[0]?.trim();
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  } finally {
    try { await handle?.close(); } catch {}
  }
}

/**
 * 递归收集指定目录下的 JSONL 会话文件，并忽略符号链接以避免跳出 Codex 数据目录。
 */
async function collectJsonlFiles(root: string, output: string[]): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const itemPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (isHistoryDeleteStagingName(entry.name)) continue;
      await collectJsonlFiles(itemPath, output);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) output.push(itemPath);
  }
}

/**
 * 返回活跃和已归档的 Codex 会话根目录，便于完整判断父会话是否仍然存在。
 */
async function getCodexSessionRoots(): Promise<string[]> {
  const activeRoots = await getSessionsRootsFastAsync().catch(() => [] as string[]);
  const roots = new Set<string>();
  for (const activeRoot of activeRoots) {
    const normalized = String(activeRoot || "").trim();
    if (!normalized) continue;
    roots.add(normalized);
    if (path.basename(normalized).toLowerCase() === "sessions")
      roots.add(path.join(path.dirname(normalized), "archived_sessions"));
  }
  const existing: string[] = [];
  for (const root of roots) {
    try {
      if ((await fsp.stat(root)).isDirectory()) existing.push(root);
    } catch {}
  }
  return existing;
}

/**
 * 全量扫描当前可访问的 Codex 会话元数据；只保留稳定、可解析的现代 JSONL 文件。
 */
export async function collectCodexSessionRecords(): Promise<CodexSessionRecord[]> {
  const roots = await getCodexSessionRoots();
  const filePaths: string[] = [];
  for (const root of roots) await collectJsonlFiles(root, filePaths);
  const seenPaths = new Set<string>();
  const records: CodexSessionRecord[] = [];
  for (const filePath of filePaths) {
    const key = pathKey(filePath);
    if (!key || seenPaths.has(key)) continue;
    seenPaths.add(key);
    try {
      const before = await fsp.stat(filePath);
      if (!before.isFile()) continue;
      const record = await readFirstJsonLine(filePath);
      const meta = getSessionMeta(record);
      const id = normalizeId(meta?.id ?? meta?.session_id);
      if (!id) continue;
      const after = await fsp.stat(filePath);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) continue;
      records.push({
        id,
        filePath,
        mtimeMs: after.mtimeMs,
        size: after.size,
        relationship: extractCodexSessionRelationship(record),
      });
    } catch {}
  }
  return records;
}

/**
 * 以会话编号去重，优先选择最近更新的文件，避免归档迁移短暂重叠时重复删除。
 */
function uniqueRecordsById(records: readonly CodexSessionRecord[]): CodexSessionRecord[] {
  const byId = new Map<string, CodexSessionRecord>();
  for (const record of records) {
    const previous = byId.get(record.id);
    if (!previous || record.mtimeMs >= previous.mtimeMs) byId.set(record.id, record);
  }
  return Array.from(byId.values());
}

/**
 * 根据最新文件元数据计算关联删除树，并检查树外的分叉历史引用。
 */
export function buildCodexRelationDeletePlan(
  targetFilePath: string,
  records: readonly CodexSessionRecord[],
  titleById: ReadonlyMap<string, string>,
): CodexRelationDeletePlan {
  const uniqueRecords = uniqueRecordsById(records);
  const targetKey = pathKey(targetFilePath);
  const target = uniqueRecords.find((record) => pathKey(record.filePath) === targetKey);
  if (!target) return { supported: false, items: [], externalReferenceIds: [], reason: "not_found" };
  if (target.relationship.kind === "unknown")
    return { supported: false, items: [], externalReferenceIds: [], reason: "unrecognized" };

  const byId = new Map(uniqueRecords.map((record) => [record.id, record]));
  let root = target;
  const visitedParents = new Set<string>([target.id]);
  while (root.relationship.parentThreadId) {
    const parent = byId.get(root.relationship.parentThreadId);
    if (!parent || visitedParents.has(parent.id)) break;
    visitedParents.add(parent.id);
    root = parent;
  }

  const children = new Map<string, CodexSessionRecord[]>();
  for (const record of uniqueRecords) {
    const parentId = record.relationship.parentThreadId;
    if (!parentId) continue;
    const existing = children.get(parentId) || [];
    existing.push(record);
    children.set(parentId, existing);
  }
  for (const childList of children.values()) childList.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const items: CodexRelationPlanItem[] = [];
  const queued = new Set<string>();
  const queue: Array<{ record: CodexSessionRecord; depth: number }> = [{ record: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || queued.has(current.record.id)) continue;
    queued.add(current.record.id);
    items.push({
      ...current.record,
      title: titleById.get(current.record.id) || current.record.id,
      depth: current.depth,
    });
    for (const child of children.get(current.record.id) || []) queue.push({ record: child, depth: current.depth + 1 });
  }

  const plannedIds = new Set(items.map((item) => item.id));
  const externalReferenceIds = uniqueRecords
    .filter((record) => !plannedIds.has(record.id))
    .filter((record) => {
      const relation = record.relationship;
      return !!relation.forkedFromId && plannedIds.has(relation.forkedFromId)
        || !!relation.historyBaseThreadId && plannedIds.has(relation.historyBaseThreadId);
    })
    .map((record) => record.id)
    .sort();
  const versionSource = [
    ...items.map((item) => `${item.id}|${pathKey(item.filePath)}|${item.mtimeMs}|${item.size}`),
    ...externalReferenceIds.map((id) => `external|${id}`),
  ].join("\n");
  return {
    supported: true,
    targetId: target.id,
    rootId: root.id,
    version: crypto.createHash("sha256").update(versionSource).digest("hex"),
    items,
    externalReferenceIds,
  };
}

/**
 * 从关联删除计划中选取仅当前会话或整棵关联树的删除目标。
 */
export function selectCodexRelationDeleteItems(
  plan: CodexRelationDeletePlan,
  mode: "current" | "tree",
): CodexRelationPlanItem[] {
  if (mode === "tree") return plan.items;
  return plan.items.filter((item) => item.id === plan.targetId);
}

/**
 * 仅复核指定文件签名，避免确认删除当前会话时再次扫描全部历史目录。
 * 未传入文件列表时复核整棵计划，用于整树删除的安全校验。
 */
export async function verifyCodexRelationPlanFiles(
  plan: CodexRelationDeletePlan,
  items: readonly CodexRelationPlanItem[] = plan.items,
): Promise<CodexRelationPlanFileCheck> {
  if (!plan.supported || !plan.version || items.length === 0)
    return { ok: false, reason: "missing" };
  const checks = await Promise.all(items.map(async (item) => {
    try {
      const stat = await fsp.stat(item.filePath);
      return stat.isFile() && stat.mtimeMs === item.mtimeMs && stat.size === item.size;
    } catch {
      return false;
    }
  }));
  return checks.every(Boolean) ? { ok: true } : { ok: false, reason: "changed" };
}
