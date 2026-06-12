// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";

const CODEX_GOALS_DB_FILENAME = "goals_1.sqlite";
const CODEX_STATE_DB_FILENAME = "state_5.sqlite";
const UNFINISHED_GOAL_STATUSES = new Set(["active", "budget_limited"]);

type SqliteStatement = {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
};
type SqliteDatabase = {
  pragma(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
type SqliteCtor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => SqliteDatabase;

export type CodexNotifyStateEntry = {
  threadId?: string;
  cwd?: string;
  sqliteHome?: string;
};

export type CodexNotifyStateDecision = {
  completionKind?: "subagent";
  dropReason?: string;
  agentId?: string;
  goalStatus?: string;
};

type SubagentThreadMatch = {
  parentThreadId: string;
};

let sqliteCtorCache: SqliteCtor | null | undefined;

/** 懒加载 SQLite 原生模块，缺失时通知桥自动降级为不查状态。 */
function loadSqlite(): SqliteCtor | null {
  if (sqliteCtorCache !== undefined) return sqliteCtorCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqliteCtorCache = require("better-sqlite3") as SqliteCtor;
  } catch {
    sqliteCtorCache = null;
  }
  return sqliteCtorCache;
}

/** 规范化字符串字段，避免空白值参与状态查询。 */
function normalizeText(value: unknown): string {
  return String(value || "").trim();
}

/** 判断文件是否存在，失败按不存在处理。 */
function isExistingFile(filePath: string): boolean {
  try {
    return !!filePath && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 打开只读 SQLite DB，并设置短忙等待以避开 Codex 正在写入的瞬时锁。 */
function openReadonlyDatabase(Database: SqliteCtor, dbPath: string): SqliteDatabase | null {
  if (!isExistingFile(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    try { db.pragma("busy_timeout = 1000"); } catch {}
    try { db.pragma("query_only = ON"); } catch {}
    return db;
  } catch {
    return null;
  }
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

/** 从 notify 文件路径反推出 Codex home。 */
function codexHomeFromNotifySource(sourcePath?: string): string {
  const filePath = normalizeText(sourcePath);
  if (!filePath) return "";
  return path.dirname(filePath);
}

/** 从 WSL UNC notify 路径中提取发行版名称。 */
function distroFromWslUncPath(sourcePath?: string): string {
  const normalized = normalizeText(sourcePath).replace(/\//g, "\\");
  const match = normalized.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i);
  return match ? match[1] || "" : "";
}

/** 将 WSL 内部绝对路径按 notify 来源映射为 Windows 可访问 UNC 路径。 */
function mapWslAbsolutePathFromSource(sourcePath: string | undefined, value: string): string {
  const text = normalizeText(value);
  if (!text.startsWith("/")) return "";
  const distro = distroFromWslUncPath(sourcePath);
  if (!distro) return "";
  return `\\\\wsl.localhost\\${distro}${text.replace(/\//g, "\\")}`;
}

/** 判断是否为 UNC 绝对路径。 */
function isUNCPath(value: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(String(value || ""));
}

/** 去掉 TOML 行内注释，保留引号内的 # 字符。 */
function stripTomlLineComment(rawLine: string): string {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < rawLine.length; index += 1) {
    const ch = rawLine[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (quote === "'") {
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

/** 将 Codex 配置或环境变量中的 sqlite_home 转成当前进程可访问的候选路径。 */
function resolveConfiguredSqliteHomes(raw: string, entry: CodexNotifyStateEntry, sourcePath: string | undefined, source: "config" | "env"): string[] {
  const value = normalizeText(raw);
  if (!value) return [];

  const codexHome = codexHomeFromNotifySource(sourcePath);
  const cwd = normalizeText(entry.cwd);
  const out: string[] = [];
  const add = (candidate: string) => {
    const text = normalizeText(candidate);
    if (text) out.push(text);
  };

  if (value.startsWith("/")) {
    add(mapWslAbsolutePathFromSource(sourcePath, value));
    add(value);
    return out;
  }

  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || isUNCPath(value)) {
    add(value);
    return out;
  }

  if (source === "env") {
    if (cwd.startsWith("/")) {
      add(mapWslAbsolutePathFromSource(sourcePath, path.posix.resolve(cwd, value)));
    } else if (cwd) {
      add(path.resolve(cwd, value));
    }
  }
  if (codexHome) add(path.join(codexHome, value));
  return out;
}

/** 读取 config.toml 顶层 sqlite_home 配置。 */
function readSqliteHomesFromConfig(codexHome: string, entry: CodexNotifyStateEntry, sourcePath?: string): string[] {
  if (!codexHome) return [];
  try {
    const configPath = path.join(codexHome, "config.toml");
    if (!isExistingFile(configPath)) return [];
    const text = fs.readFileSync(configPath, "utf8");
    for (const rawLine of text.split(/\r?\n/g)) {
      const line = stripTomlLineComment(rawLine).trim();
      const match = line.match(/^sqlite_home\s*=\s*(['"])(.*?)\1\s*$/);
      if (!match) continue;
      return resolveConfiguredSqliteHomes(match[2], entry, sourcePath, "config");
    }
  } catch {}
  return [];
}

/** 列出可尝试读取 Codex SQLite 状态的目录。 */
function candidateSqliteHomes(entry: CodexNotifyStateEntry, sourcePath?: string): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const text = normalizeText(value);
    if (!text) return;
    const key = text.replace(/\\/g, "/").toLowerCase();
    if (out.some((item) => item.replace(/\\/g, "/").toLowerCase() === key)) return;
    out.push(text);
  };

  const codexHome = codexHomeFromNotifySource(sourcePath);
  const sqliteHome = normalizeText(entry.sqliteHome);
  if (sqliteHome) {
    for (const home of resolveConfiguredSqliteHomes(sqliteHome, entry, sourcePath, "env"))
      add(home);
  }
  for (const home of readSqliteHomesFromConfig(codexHome, entry, sourcePath))
    add(home);
  add(codexHome);
  return out;
}

/** 列出某类 Codex runtime SQLite DB，文件名升级时保持兼容。 */
function listRuntimeDbPaths(sqliteHome: string, kind: "state" | "goals"): string[] {
  const fallback = path.join(sqliteHome, kind === "state" ? CODEX_STATE_DB_FILENAME : CODEX_GOALS_DB_FILENAME);
  try {
    const entries = fs.readdirSync(sqliteHome, { withFileTypes: true });
    const pattern = kind === "state"
      ? /^state(?:[_-]?\d+)?\.sqlite$/i
      : /^goals(?:[_-]?\d+)?\.sqlite$/i;
    const paths = entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => path.join(sqliteHome, entry.name))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }));
    return paths.length > 0 ? paths : [fallback];
  } catch {
    return [fallback];
  }
}

/** 从指定 state DB 读取线程是否为 thread-spawned 子代理线程。 */
function readSubagentThreadMatchFromDb(Database: SqliteCtor, dbPath: string, threadId: string): SubagentThreadMatch | null {
  const db = openReadonlyDatabase(Database, dbPath);
  if (!db) return null;
  try {
    if (!hasColumn(db, "thread_spawn_edges", "child_thread_id") || !hasColumn(db, "thread_spawn_edges", "parent_thread_id"))
      return null;
    const row = db
      .prepare("SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id = ? LIMIT 1")
      .get(threadId);
    const parentThreadId = normalizeText(row?.parent_thread_id);
    return parentThreadId ? { parentThreadId } : null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

/** 从指定 goals DB 读取线程的 goal 状态，找不到记录时返回 null。 */
function readThreadGoalStatusFromDb(Database: SqliteCtor, dbPath: string, threadId: string): string | null {
  const db = openReadonlyDatabase(Database, dbPath);
  if (!db) return null;
  try {
    if (!hasColumn(db, "thread_goals", "thread_id") || !hasColumn(db, "thread_goals", "status"))
      return null;
    const row = db
      .prepare("SELECT status FROM thread_goals WHERE thread_id = ? LIMIT 1")
      .get(threadId);
    if (!row) return null;
    return normalizeText(row.status).toLowerCase();
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

/** 根据 Codex 本地状态判断 legacy notify 是否应降级为子代理或被丢弃。 */
export function getCodexNotifyStateDecision(entry: CodexNotifyStateEntry, sourcePath?: string): CodexNotifyStateDecision {
  const threadId = normalizeText(entry.threadId);
  if (!threadId) return {};
  const Database = loadSqlite();
  if (!Database) return {};

  const homes = candidateSqliteHomes(entry, sourcePath);
  let subagentMatch: SubagentThreadMatch | null = null;
  for (const home of homes) {
    for (const dbPath of listRuntimeDbPaths(home, "state")) {
      subagentMatch = readSubagentThreadMatchFromDb(Database, dbPath, threadId);
      if (subagentMatch) break;
    }
    if (subagentMatch) break;
  }

  for (const home of homes) {
    for (const dbPath of listRuntimeDbPaths(home, "goals")) {
      const status = readThreadGoalStatusFromDb(Database, dbPath, threadId);
      if (status === null) continue;
      if (UNFINISHED_GOAL_STATUSES.has(status))
        return { dropReason: `unfinished-goal-${status}`, goalStatus: status };
      break;
    }
  }

  if (subagentMatch)
    return { completionKind: "subagent", agentId: threadId };

  return {};
}

export const __testing = {
  candidateSqliteHomes,
  codexHomeFromNotifySource,
  distroFromWslUncPath,
  getCodexNotifyStateDecision,
  listRuntimeDbPaths,
  mapWslAbsolutePathFromSource,
  readSqliteHomesFromConfig,
  resolveConfiguredSqliteHomes,
  stripTomlLineComment,
};
