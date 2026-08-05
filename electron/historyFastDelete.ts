// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";

/** 删除暂存项使用的目录名前缀；索引器和各 Provider 扫描器会跳过此类项。 */
export const HISTORY_DELETE_STAGING_PREFIX = ".codexflow-delete-";

/** 待后台清理的历史路径。 */
export type HistoryDeleteTarget = {
  filePath: string;
  recursive: boolean;
  queueRecordPath?: string;
};

/** 快速摘除所需的持久化队列配置。 */
export type HistoryDetachOptions = {
  queueDirectory: string;
};

/** 快速摘除结果；摘除后原路径立即不可见，实际内容由后台清理。 */
export type HistoryDetachResult = {
  filePath: string;
  ok: boolean;
  queuedCleanup?: HistoryDeleteTarget;
  error?: unknown;
};

/**
 * 判断目录或文件名是否为删除过程中的暂存项。
 */
export function isHistoryDeleteStagingName(name: string): boolean {
  return path.basename(String(name || "")).toLowerCase().startsWith(HISTORY_DELETE_STAGING_PREFIX);
}

/**
 * 生成同目录临时名称，确保 rename（改名）不会跨盘，从而保持快速的元数据操作。
 */
function createDetachedPath(filePath: string): string {
  const directory = path.dirname(filePath);
  const suffix = `${process.pid}-${Date.now().toString(36)}-${randomUUID()}`;
  return path.join(directory, `${HISTORY_DELETE_STAGING_PREFIX}${suffix}.pending`);
}

/**
 * 写入一个独立的后台清理记录；先落盘再改名，确保应用退出后仍能续删。
 */
async function createHistoryDeleteQueueRecord(
  queueDirectory: string,
  target: HistoryDeleteTarget,
): Promise<string> {
  const directory = String(queueDirectory || "").trim();
  if (!directory) throw new Error("invalid queueDirectory");
  await fsp.mkdir(directory, { recursive: true });
  const queueRecordPath = path.join(directory, `${randomUUID()}.json`);
  await fsp.writeFile(queueRecordPath, JSON.stringify({
    version: 1,
    filePath: target.filePath,
    recursive: target.recursive === true,
  }), { encoding: "utf8", flag: "wx" });
  return queueRecordPath;
}

/**
 * 快速摘除一个历史文件或目录；只等待队列记录和同目录改名，不等待物理删除。
 */
export async function detachHistoryPath(
  target: HistoryDeleteTarget,
  options: HistoryDetachOptions,
): Promise<HistoryDetachResult> {
  const filePath = String(target?.filePath || "").trim();
  if (!filePath) return { filePath, ok: false, error: "invalid filePath" };
  const recursive = target.recursive === true;
  const detachedPath = createDetachedPath(filePath);
  let queueRecordPath = "";
  try {
    queueRecordPath = await createHistoryDeleteQueueRecord(options?.queueDirectory, {
      filePath: detachedPath,
      recursive,
    });
    await fsp.rename(filePath, detachedPath);
    return {
      filePath,
      ok: true,
      queuedCleanup: { filePath: detachedPath, recursive, queueRecordPath },
    };
  } catch (error) {
    if (queueRecordPath)
      await fsp.rm(queueRecordPath, { force: true }).catch(() => undefined);
    return { filePath, ok: false, error };
  }
}

/**
 * 读取上次运行遗留的后台清理记录；仅接受本模块生成的暂存名称。
 */
export async function readHistoryDeleteQueue(queueDirectory: string): Promise<HistoryDeleteTarget[]> {
  const directory = String(queueDirectory || "").trim();
  if (!directory) return [];
  await fsp.mkdir(directory, { recursive: true });
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  const targets = await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") return null;
    const queueRecordPath = path.join(directory, entry.name);
    try {
      const raw = (await fsp.readFile(queueRecordPath, "utf8")).replace(/^\uFEFF/, "");
      const record = JSON.parse(raw) as { version?: unknown; filePath?: unknown; recursive?: unknown };
      const filePath = typeof record.filePath === "string" ? record.filePath.trim() : "";
      if (record.version !== 1 || !path.isAbsolute(filePath) || !isHistoryDeleteStagingName(path.basename(filePath))) return null;
      return { filePath, recursive: record.recursive === true, queueRecordPath } satisfies HistoryDeleteTarget;
    } catch {
      return null;
    }
  }));
  const validTargets: HistoryDeleteTarget[] = [];
  for (const target of targets) {
    if (target) validTargets.push(target);
  }
  return validTargets;
}

/**
 * 物理清理已摘除路径；成功后删除持久化队列记录。
 */
export async function cleanupDetachedHistoryPath(target: HistoryDeleteTarget): Promise<void> {
  await fsp.rm(target.filePath, {
    force: true,
    recursive: target.recursive === true,
    maxRetries: 3,
    retryDelay: 100,
  });
  if (target.queueRecordPath)
    await fsp.rm(target.queueRecordPath, { force: true });
}
