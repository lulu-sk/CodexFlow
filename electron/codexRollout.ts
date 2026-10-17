// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { isHistoryDeleteStagingName } from "./historyFastDelete";

type RolloutSummary = { providerId?: string; id: string; filePath: string; date: number };
type HistoryBase = { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number };
type Segment = { filePath: string; end?: number; ordinalEnd?: number };
const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const ROLLOUT_NAME = new RegExp(`^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${UUID})(?:_(${UUID}))?\\.jsonl$`, "i");

/** 提取文件的创建时间与物理记录编号；回退后的记录编号不同于会话编号。 */
export function parseCodexRolloutFileName(filePath: string): { timestamp: string; rolloutId: string } | undefined {
  const match = filePath.replace(/\\/g, "/").split("/").pop()?.match(ROLLOUT_NAME);
  return match ? { timestamp: match[1], rolloutId: (match[3] || match[2]).toLowerCase() } : undefined;
}

/** 按 Codex 的文件创建顺序选择当前版本，避免旧文件的修改时间覆盖回退结果。 */
export function isNewerCodexRollout(candidate: RolloutSummary, previous: RolloutSummary): boolean {
  const next = parseCodexRolloutFileName(candidate.filePath);
  const prev = parseCodexRolloutFileName(previous.filePath);
  if (next && prev && next.timestamp !== prev.timestamp) return next.timestamp > prev.timestamp;
  return candidate.date > previous.date
    || (candidate.date === previous.date && candidate.filePath > previous.filePath);
}

/** 同一 Codex 会话只展示当前版本；真实分叉保留独立编号，其它提供方仍按路径合并。 */
export function selectCurrentHistorySummaries<T extends RolloutSummary>(items: readonly T[]): T[] {
  const selected = new Map<string, T>();
  for (const item of items) {
    const isCodex = !item.providerId || item.providerId === "codex";
    const id = String(item.id || "").trim().toLowerCase();
    const key = isCodex && id ? `codex:${id}` : `${item.providerId}:${item.filePath || item.id}`;
    const previous = selected.get(key);
    if (!previous || (isCodex ? isNewerCodexRollout(item, previous) : item.date > previous.date)) selected.set(key, item);
  }
  return Array.from(selected.values()).sort((a, b) => b.date - a.date);
}

/** 只读取第一条记录，避免为普通会话额外加载完整文件。 */
async function readHeader(filePath: string): Promise<string> {
  const input = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 16 * 1024 });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line.replace(/^\uFEFF/, "");
    return "";
  } finally {
    lines.close();
    input.destroy();
  }
}

/** 校验历史前缀边界，拒绝无法安全拼接的引用。 */
function readHistoryBase(header: string): HistoryBase | undefined {
  let record: any;
  try { record = JSON.parse(header); } catch { return undefined; }
  const base = record?.type === "session_meta" ? record.payload?.history_base : undefined;
  if (!base) return undefined;
  if (typeof base.thread_id !== "string" || !new RegExp(`^${UUID}$`, "i").test(base.thread_id)
    || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 0
    || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 0)
    throw new Error("Codex 历史前缀引用格式无效");
  return base;
}

/** 确定当前记录所属存储目录，仅在同一 Codex 数据目录内查找前缀。 */
function historyRoots(filePath: string): string[] {
  let dir = path.dirname(filePath);
  while (path.dirname(dir) !== dir) {
    if (["sessions", "archived_sessions"].includes(path.basename(dir))) {
      const home = path.dirname(dir);
      return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
    }
    dir = path.dirname(dir);
  }
  const parent = path.dirname(filePath);
  if (/[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}$/.test(parent))
    return [path.resolve(parent, "../../..")];
  return [parent];
}

/** 收集物理记录编号，不跟随符号链接，也不把同一会话的最新版本当成旧前缀。 */
async function collectRolloutPaths(root: string, files: Map<string, string>): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory() && !isHistoryDeleteStagingName(entry.name)) await collectRolloutPaths(filePath, files);
    else if (entry.isFile()) {
      const name = parseCodexRolloutFileName(entry.name);
      if (name && !files.has(name.rolloutId)) files.set(name.rolloutId, filePath);
    }
  }
}

/** 按字节与记录编号双重边界读取一段历史，省略继承文件自身的会话头。 */
async function* readSegment(segment: Segment): AsyncGenerator<string> {
  if (segment.end === 0) return;
  const input = fs.createReadStream(segment.filePath, {
    encoding: "utf8", highWaterMark: 64 * 1024,
    ...(segment.end === undefined ? {} : { end: segment.end - 1 }),
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let first = true;
  try {
    for await (const line of lines) {
      if (first) { first = false; continue; }
      if (segment.ordinalEnd !== undefined) {
        let ordinal: unknown;
        try { ordinal = JSON.parse(line).ordinal; } catch {}
        if (typeof ordinal === "number" && ordinal >= segment.ordinalEnd) break;
      }
      yield `${line}\n`;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/** 先输出当前会话头，再按顺序输出继承前缀和当前版本的记录。 */
async function* readSegments(header: string, segments: Segment[]): AsyncGenerator<string> {
  yield `${header}\n`;
  for (const segment of segments) yield* readSegment(segment);
}

/** 打开逻辑会话流，兼容回退与分叉的多层历史前缀；引用缺失时拒绝返回不完整详情。 */
export async function openCodexHistoryStream(filePath: string, highWaterMark: number, opts?: { rawBytes?: boolean }): Promise<Readable> {
  const header = await readHeader(filePath);
  let base = readHistoryBase(header);
  if (!base) return fs.createReadStream(filePath, { encoding: opts?.rawBytes ? undefined : "utf8", highWaterMark });
  const paths = new Map<string, string>();
  for (const root of historyRoots(filePath)) await collectRolloutPaths(root, paths);
  const segments: Segment[] = [{ filePath }];
  const visited = new Set<string>([path.resolve(filePath)]);
  let ordinalEnd = Number.POSITIVE_INFINITY;
  while (base) {
    const basePath = paths.get(base.thread_id.toLowerCase());
    if (!basePath) throw new Error(`Codex 历史前缀文件缺失：${base.thread_id}`);
    if (visited.has(path.resolve(basePath)) || visited.size >= 128) throw new Error("Codex 历史前缀存在循环或层级过深");
    visited.add(path.resolve(basePath));
    const stat = await fsp.stat(basePath);
    if (stat.size < base.end_byte_offset) throw new Error("Codex 历史前缀文件被截断");
    ordinalEnd = Math.min(ordinalEnd, base.end_ordinal_exclusive);
    segments.unshift({ filePath: basePath, end: base.end_byte_offset, ordinalEnd });
    base = readHistoryBase(await readHeader(basePath));
  }
  return Readable.from(readSegments(header, segments), { encoding: "utf8", highWaterMark, objectMode: false });
}
