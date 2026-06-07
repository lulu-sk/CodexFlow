// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCodexRootsFastAsync, isUNCPath, uncToWsl, wslToUNC } from "./wsl";

type SqliteRunResult = { changes: number };
type SqliteScalarRow = { count: number };
type SqliteStatement = {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): SqliteRunResult;
};
type SqliteDatabase = {
  pragma(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R;
  close(): void;
};
type SqliteCtor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => SqliteDatabase;

type ThreadRow = {
  id: string;
  rolloutPath: string;
};

type TargetMatcher = {
  ids: Set<string>;
  pathKeys: Set<string>;
};

type CodexHomeWork = {
  codexHome: string;
  distro?: string;
  source: string;
  matcher: TargetMatcher;
};

type CleanupOptions = {
  repairMissingRollouts?: boolean;
};

export type CodexStateCleanupResult = {
  ok: boolean;
  sqliteAvailable: boolean;
  scannedDbPaths: string[];
  deletedThreadIds: string[];
  deletedThreadRows: number;
  deletedAuxRows: number;
  repairedStaleRows: number;
  skippedRows: number;
  errors: string[];
};

let sqliteCtorCache: SqliteCtor | null | undefined;

/** 创建空的 Codex state 清理统计结果。 */
function createResult(sqliteAvailable: boolean): CodexStateCleanupResult {
  return {
    ok: true,
    sqliteAvailable,
    scannedDbPaths: [],
    deletedThreadIds: [],
    deletedThreadRows: 0,
    deletedAuxRows: 0,
    repairedStaleRows: 0,
    skippedRows: 0,
    errors: [],
  };
}

/** 懒加载 better-sqlite3，缺失或 ABI 不匹配时返回 null 并让调用方降级跳过。 */
function loadSqlite(): SqliteCtor | null {
  if (sqliteCtorCache !== undefined) return sqliteCtorCache;
  try {
    // 使用动态 require，避免主进程编译阶段强绑定原生模块。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqliteCtorCache = require("better-sqlite3") as SqliteCtor;
  } catch {
    sqliteCtorCache = null;
  }
  return sqliteCtorCache;
}

/** 去重字符串数组，并过滤空字符串。 */
function uniqueStrings(values: Iterable<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** 将路径转换为适合跨 Windows/WSL 比较的稳定 key。 */
function pathKey(value: string): string {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^\\\\\?\\UNC\\/i, "\\\\");
  text = text.replace(/^\\\\\?\\/i, "");
  text = text.replace(/\\/g, "/");
  const isUnc = text.startsWith("//");
  text = text.replace(/\/+/g, "/");
  if (isUnc) text = `//${text.replace(/^\/+/, "")}`;
  if (/^[a-zA-Z]:\//.test(text) || text.startsWith("//")) text = text.toLowerCase();
  return text.replace(/\/+$/g, "");
}

/** 将规范化 key 尽量还原为当前 Node 可访问的路径。 */
function accessPathFromKey(key: string): string {
  if (process.platform === "win32" && key.startsWith("//"))
    return key.replace(/\//g, "\\");
  if (process.platform === "win32" && /^[a-z]:\//i.test(key))
    return key.replace(/\//g, "\\");
  return key;
}

/** 暴露给单测的路径规范化内部函数，避免跨 Windows/WSL 路径行为回归。 */
export const __codexStateCleanupTestHooks = {
  pathKey,
  accessPathFromKey,
};

/** 判断文件是否是可访问的普通文件。 */
function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 判断路径是否是可访问的目录。 */
function isExistingDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/** 从 rollout 文件名中提取 Codex thread UUID。 */
function threadIdFromRolloutFileName(filePath: string): string | null {
  const base = path.basename(filePath).replace(/\.jsonl$/i, "");
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1].toLowerCase() : null;
}

/** 将 Windows 盘符路径转换为 WSL /mnt 路径。 */
function windowsDriveToWslPath(filePath: string): string | null {
  const match = filePath.replace(/\\/g, "/").match(/^([a-zA-Z]):\/(.*)$/);
  if (!match) return null;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

/** 将 WSL /mnt 路径转换为 Windows 盘符路径。 */
function wslMntToWindowsPath(filePath: string): string | null {
  const match = filePath.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!match) return null;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

/** 生成一个路径在 Codex/Windows/WSL 之间的等价比较 key。 */
function equivalentPathKeys(filePath: string, distro?: string): Set<string> {
  const keys = new Set<string>();
  const add = (value?: string | null) => {
    const key = pathKey(String(value || ""));
    if (key) keys.add(key);
  };
  add(filePath);
  add(filePath.replace(/\//g, "\\"));
  add(filePath.replace(/\\/g, "/"));
  add(windowsDriveToWslPath(filePath));
  add(wslMntToWindowsPath(filePath));
  if (isUNCPath(filePath)) {
    const unc = uncToWsl(filePath);
    add(unc?.wslPath);
  }
  if (filePath.startsWith("/") && process.platform === "win32") {
    add(wslToUNC(filePath, distro || "Ubuntu-24.04"));
  }
  return keys;
}

/** 从 Codex sessions/archived_sessions 路径推导 Codex home。 */
function codexHomeFromRolloutPath(filePath: string): { codexHome: string; distro?: string } | null {
  const normalized = pathKey(filePath);
  const marker = normalized.match(/^(.*?)(?:\/sessions|\/archived_sessions)\/.+$/);
  if (!marker) return null;
  let homeKey = marker[1];
  if (!homeKey) return null;
  const access = accessPathFromKey(homeKey);
  const unc = isUNCPath(access) ? uncToWsl(access) : null;
  return { codexHome: access, distro: unc?.distro };
}

/** 去掉 TOML 行尾注释，但保留引号内的 # 字符。 */
function stripTomlLineComment(rawLine: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < rawLine.length; index++) {
    const ch = rawLine[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote === "\"" && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return rawLine.slice(0, index);
  }
  return rawLine;
}

/** 安全解析 config.toml 中的 sqlite_home 顶层字符串。 */
function readSqliteHomesFromConfig(codexHome: string, distro?: string): string[] {
  try {
    const configPath = path.join(codexHome, "config.toml");
    if (!fs.existsSync(configPath)) return [];
    const text = fs.readFileSync(configPath, "utf8");
    for (const rawLine of text.split(/\r?\n/g)) {
      const line = stripTomlLineComment(rawLine).trim();
      const match = line.match(/^sqlite_home\s*=\s*(['"])(.*?)\1\s*$/);
      if (!match) continue;
      return resolveConfiguredSqliteHomes(match[2], codexHome, distro, "config");
    }
  } catch {}
  return [];
}

/** 将 Codex 配置或环境变量里的 sqlite_home 转为当前进程可访问路径候选。 */
function resolveConfiguredSqliteHomes(raw: string, codexHome: string, distro: string | undefined, source: "config" | "env"): string[] {
  const value = String(raw || "").trim();
  if (!value) return [];
  if (process.platform === "win32" && value.startsWith("/"))
    return uniqueStrings([wslToUNC(value, distro || "Ubuntu-24.04"), value]);
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || isUNCPath(value)) return [value];
  if (source === "env")
    return uniqueStrings([path.resolve(process.cwd(), value), path.join(codexHome, value)]);
  return [path.join(codexHome, value)];
}

/** 解析一个 Codex home 可能使用的 sqlite home 候选。 */
function resolveSqliteHomes(codexHome: string, distro?: string): string[] {
  const configHomes = readSqliteHomesFromConfig(codexHome, distro);
  const envHomes = resolveConfiguredSqliteHomes(String(process.env.CODEX_SQLITE_HOME || ""), codexHome, distro, "env");
  return uniqueStrings([...configHomes, ...envHomes, codexHome]).filter(isExistingDirectory);
}

/** 创建用于精确匹配已删除 rollout 的 matcher。 */
function matcherFromHistoryPath(filePath: string, distro?: string): TargetMatcher {
  const ids = new Set<string>();
  const pathKeys = equivalentPathKeys(filePath, distro);
  const threadId = threadIdFromRolloutFileName(filePath);
  if (threadId) ids.add(threadId);
  return { ids, pathKeys };
}

/** 合并两个 matcher，保持路径和 thread id 去重。 */
function mergeMatcher(target: TargetMatcher, source: TargetMatcher): void {
  for (const id of source.ids) target.ids.add(id);
  for (const key of source.pathKeys) target.pathKeys.add(key);
}

/** 构建空 matcher。 */
function emptyMatcher(): TargetMatcher {
  return { ids: new Set<string>(), pathKeys: new Set<string>() };
}

/** 把一个 Codex home 加入待处理集合。 */
function upsertHomeWork(map: Map<string, CodexHomeWork>, home: Omit<CodexHomeWork, "matcher">): CodexHomeWork {
  const key = pathKey(home.codexHome);
  const existing = map.get(key);
  if (existing) {
    if (!existing.distro && home.distro) existing.distro = home.distro;
    return existing;
  }
  const work: CodexHomeWork = { ...home, matcher: emptyMatcher() };
  map.set(key, work);
  return work;
}

/** 根据已删除的历史路径推导需要处理的 Codex home。 */
function addHomeWorkForHistoryPath(map: Map<string, CodexHomeWork>, filePath: string): void {
  const home = codexHomeFromRolloutPath(filePath);
  if (!home) return;
  const work = upsertHomeWork(map, { codexHome: home.codexHome, distro: home.distro, source: "history-path" });
  mergeMatcher(work.matcher, matcherFromHistoryPath(filePath, home.distro));
}

/** 获取当前机器上可快速确认的 Codex home。 */
async function addKnownCodexHomes(map: Map<string, CodexHomeWork>): Promise<void> {
  try {
    const roots = await getCodexRootsFastAsync();
    if (roots.windowsCodex && isExistingDirectory(roots.windowsCodex))
      upsertHomeWork(map, { codexHome: roots.windowsCodex, source: "windows" });
    for (const item of roots.wsl) {
      if (!item.codexUNC || !isExistingDirectory(item.codexUNC)) continue;
      upsertHomeWork(map, { codexHome: item.codexUNC, distro: item.distro, source: "wsl" });
    }
  } catch {}
  const fallback = path.join(os.homedir(), ".codex");
  if (isExistingDirectory(fallback))
    upsertHomeWork(map, { codexHome: fallback, source: "fallback" });
}

/** 列出 sqlite home 下某类 Codex runtime DB。 */
async function listRuntimeDbs(sqliteHome: string, kind: "state" | "goals" | "memories"): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(sqliteHome);
  } catch {
    return [];
  }
  const pattern = kind === "state"
    ? /^state(?:[_-]?\d+)?\.sqlite$/i
    : kind === "goals"
      ? /^goals(?:[_-]?\d+)?\.sqlite$/i
      : /^memories(?:[_-]?\d+)?\.sqlite$/i;
  return entries
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(sqliteHome, name));
}

/** 打开 SQLite DB，并设置短忙等待以避开 Codex 正在写入的瞬时锁。 */
function openDatabase(Database: SqliteCtor, dbPath: string): SqliteDatabase {
  const db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
  try { db.pragma("busy_timeout = 5000"); } catch {}
  return db;
}

/** 判断 DB 中是否存在指定表。 */
function hasTable(db: SqliteDatabase, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return !!row;
}

/** 安全引用 SQLite 标识符。 */
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid sqlite identifier: ${name}`);
  return `"${name}"`;
}

/** 判断指定表中是否存在指定列。 */
function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  return rows.some((row) => String(row.name || "") === column);
}

/** 读取 state DB 中可用于清理判断的 threads 行。 */
function readThreadRows(db: SqliteDatabase): ThreadRow[] {
  if (!hasColumn(db, "threads", "id") || !hasColumn(db, "threads", "rollout_path")) return [];
  return db.prepare("SELECT id, rollout_path FROM threads").all().map((row) => ({
    id: String(row.id || ""),
    rolloutPath: String(row.rollout_path || ""),
  })).filter((row) => !!row.id && !!row.rolloutPath);
}

/** 判断 rollout_path 是否位于指定 Codex home 的 sessions 或 archived_sessions 下。 */
function isPathUnderCodexSessions(rowPath: string, work: CodexHomeWork): boolean {
  const rowKeys = equivalentPathKeys(rowPath, work.distro);
  const homeKeys = equivalentPathKeys(work.codexHome, work.distro);
  for (const rowKey of rowKeys) {
    for (const homeKey of homeKeys) {
      if (rowKey.startsWith(`${homeKey}/sessions/`) || rowKey.startsWith(`${homeKey}/archived_sessions/`))
        return true;
    }
  }
  return false;
}

/** 判断 rollout_path 对应文件是否可确认缺失。 */
function isConfirmedMissingRollout(rowPath: string, work: CodexHomeWork): boolean {
  if (!isExistingDirectory(work.codexHome)) return false;
  if (!isPathUnderCodexSessions(rowPath, work)) return false;
  const accessCandidates = Array.from(equivalentPathKeys(rowPath, work.distro)).map(accessPathFromKey);
  return !accessCandidates.some(isExistingFile);
}

/** 判断 threads 行是否命中已删除文件或可安全补救的缺失文件。 */
function shouldDeleteThreadRow(row: ThreadRow, work: CodexHomeWork, repairMissingRollouts: boolean): { delete: boolean; stale: boolean } {
  const rowPathKeys = equivalentPathKeys(row.rolloutPath, work.distro);
  const targetPathMatched = Array.from(rowPathKeys).some((key) => work.matcher.pathKeys.has(key));
  const targetIdMatched = work.matcher.ids.has(row.id.toLowerCase());
  if ((targetPathMatched || targetIdMatched) && isPathUnderCodexSessions(row.rolloutPath, work))
    return { delete: true, stale: false };
  if (repairMissingRollouts && isConfirmedMissingRollout(row.rolloutPath, work))
    return { delete: true, stale: true };
  return { delete: false, stale: false };
}

/** 分块处理 SQLite 参数，避免触发变量数量上限。 */
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 如果表和列存在，则执行按 thread_id 删除的语句。 */
function deleteByThreadId(db: SqliteDatabase, table: string, column: string, ids: string[]): number {
  if (!hasColumn(db, table, column)) return 0;
  let changed = 0;
  for (const group of chunks(ids, 200)) {
    const placeholders = group.map(() => "?").join(", ");
    changed += db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IN (${placeholders})`).run(...group).changes;
  }
  return changed;
}

/** 如果表和列存在，则统计按 thread_id 命中的行数。 */
function countByThreadId(db: SqliteDatabase, table: string, column: string, ids: string[]): number {
  if (!hasColumn(db, table, column)) return 0;
  let total = 0;
  for (const group of chunks(ids, 200)) {
    const placeholders = group.map(() => "?").join(", ");
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IN (${placeholders})`).get(...group) as SqliteScalarRow | undefined;
    total += Number(row?.count || 0);
  }
  return total;
}

/** 统计独立 goals/memories DB 中和 thread id 直接相关的记录。 */
function countAuxDbRows(db: SqliteDatabase, ids: string[]): number {
  let total = 0;
  total += countByThreadId(db, "thread_goals", "thread_id", ids);
  total += countByThreadId(db, "stage1_outputs", "thread_id", ids);
  if (hasColumn(db, "jobs", "kind") && hasColumn(db, "jobs", "job_key")) {
    for (const group of chunks(ids, 200)) {
      const placeholders = group.map(() => "?").join(", ");
      const row = db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE kind = ? AND job_key IN (${placeholders})`).get("memory_stage1", ...group) as SqliteScalarRow | undefined;
      total += Number(row?.count || 0);
    }
  }
  return total;
}

/** 删除 state DB 中和 thread id 直接相关的记录。 */
function deleteFromStateDb(db: SqliteDatabase, ids: string[]): { threadRows: number; auxRows: number } {
  let threadRows = 0;
  let auxRows = 0;
  const run = db.transaction(() => {
    auxRows += deleteByThreadId(db, "thread_dynamic_tools", "thread_id", ids);
    if (hasColumn(db, "thread_spawn_edges", "parent_thread_id"))
      auxRows += deleteByThreadId(db, "thread_spawn_edges", "parent_thread_id", ids);
    if (hasColumn(db, "thread_spawn_edges", "child_thread_id"))
      auxRows += deleteByThreadId(db, "thread_spawn_edges", "child_thread_id", ids);
    auxRows += deleteByThreadId(db, "thread_goals", "thread_id", ids);
    auxRows += deleteByThreadId(db, "stage1_outputs", "thread_id", ids);
    if (hasColumn(db, "jobs", "kind") && hasColumn(db, "jobs", "job_key")) {
      for (const group of chunks(ids, 200)) {
        const placeholders = group.map(() => "?").join(", ");
        auxRows += db.prepare(`DELETE FROM jobs WHERE kind = ? AND job_key IN (${placeholders})`).run("memory_stage1", ...group).changes;
      }
    }
    threadRows += deleteByThreadId(db, "threads", "id", ids);
  });
  run();
  return { threadRows, auxRows };
}

/** 删除 goals/memories 独立 DB 中和 thread id 直接相关的记录。 */
function deleteFromAuxDb(db: SqliteDatabase, ids: string[]): number {
  let changed = 0;
  const run = db.transaction(() => {
    changed += deleteByThreadId(db, "thread_goals", "thread_id", ids);
    changed += deleteByThreadId(db, "stage1_outputs", "thread_id", ids);
    if (hasColumn(db, "jobs", "kind") && hasColumn(db, "jobs", "job_key")) {
      for (const group of chunks(ids, 200)) {
        const placeholders = group.map(() => "?").join(", ");
        changed += db.prepare(`DELETE FROM jobs WHERE kind = ? AND job_key IN (${placeholders})`).run("memory_stage1", ...group).changes;
      }
    }
  });
  run();
  return changed;
}

/** 清理一个 sqlite home 下的 Codex state/goals/memories DB。 */
async function cleanupSqliteHome(Database: SqliteCtor, work: CodexHomeWork, sqliteHome: string, options: Required<CleanupOptions>, result: CodexStateCleanupResult): Promise<void> {
  const idsForAux = new Set<string>(Array.from(work.matcher.ids));
  const stateDbs = await listRuntimeDbs(sqliteHome, "state");
  for (const dbPath of stateDbs) {
    result.scannedDbPaths.push(dbPath);
    let db: SqliteDatabase | null = null;
    try {
      db = openDatabase(Database, dbPath);
      const deadIds: string[] = [];
      let staleCount = 0;
      for (const row of readThreadRows(db)) {
        const decision = shouldDeleteThreadRow(row, work, options.repairMissingRollouts);
        if (!decision.delete) {
          result.skippedRows++;
          continue;
        }
        deadIds.push(row.id);
        idsForAux.add(row.id);
        if (decision.stale) staleCount++;
      }
      if (deadIds.length === 0) continue;
      const changed = deleteFromStateDb(db, deadIds);
      result.deletedThreadRows += changed.threadRows;
      result.deletedAuxRows += changed.auxRows;
      result.repairedStaleRows += staleCount;
      for (const id of deadIds) result.deletedThreadIds.push(id);
    } catch (error) {
      result.ok = false;
      result.errors.push(`${dbPath}: ${String(error)}`);
    } finally {
      try { db?.close(); } catch {}
    }
  }

  const ids = Array.from(idsForAux).filter(Boolean);
  if (ids.length === 0) return;
  for (const kind of ["goals", "memories"] as const) {
    const auxDbs = await listRuntimeDbs(sqliteHome, kind);
    for (const dbPath of auxDbs) {
      result.scannedDbPaths.push(dbPath);
      let db: SqliteDatabase | null = null;
      try {
        db = openDatabase(Database, dbPath);
        const plannedRows = countAuxDbRows(db, ids);
        if (plannedRows === 0) continue;
        result.deletedAuxRows += deleteFromAuxDb(db, ids);
      } catch (error) {
        result.ok = false;
        result.errors.push(`${dbPath}: ${String(error)}`);
      } finally {
        try { db?.close(); } catch {}
      }
    }
  }
}

/** 合并清理结果中的重复 thread id 和 DB 路径。 */
function finalizeResult(result: CodexStateCleanupResult): CodexStateCleanupResult {
  result.deletedThreadIds = uniqueStrings(result.deletedThreadIds);
  result.scannedDbPaths = uniqueStrings(result.scannedDbPaths);
  return result;
}

/** 清理已删除历史文件对应的 Codex sqlite 状态，并可顺带修复旧残留。 */
export async function cleanupCodexStateForDeletedHistoryFiles(filePaths: string[], options?: CleanupOptions): Promise<CodexStateCleanupResult> {
  const Database = loadSqlite();
  const result = createResult(!!Database);
  if (!Database) {
    result.ok = false;
    result.errors.push("better-sqlite3 is unavailable; skipped Codex sqlite cleanup");
    return result;
  }

  const normalizedOptions: Required<CleanupOptions> = {
    repairMissingRollouts: options?.repairMissingRollouts ?? false,
  };
  const works = new Map<string, CodexHomeWork>();
  for (const filePath of uniqueStrings(filePaths)) addHomeWorkForHistoryPath(works, filePath);
  if (normalizedOptions.repairMissingRollouts) await addKnownCodexHomes(works);

  for (const work of works.values()) {
    const sqliteHomes = resolveSqliteHomes(work.codexHome, work.distro);
    for (const sqliteHome of sqliteHomes)
      await cleanupSqliteHome(Database, work, sqliteHome, normalizedOptions, result);
  }
  return finalizeResult(result);
}

/** 扫描已知 Codex home，自动修复已删除 rollout 文件留下的 sqlite 残留。 */
export async function repairMissingCodexRolloutRows(): Promise<CodexStateCleanupResult> {
  return cleanupCodexStateForDeletedHistoryFiles([], {
    repairMissingRollouts: true,
  });
}
