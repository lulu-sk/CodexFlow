// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { isNetworkPath, normalizeWinPath } from "./wsl";
import { dirKeyFromCwd } from "./agentSessions/shared/path";
import { filterCodexHistoryPreviewText } from "./agentSessions/shared/preview";
import { extractCodexSessionRelationship } from "./codexSessionRelations";
import type { HistorySummary } from "./history";

export type CodexStateSnapshotEntry = {
  summary: HistorySummary;
  sig: { mtimeMs: number; size: number };
  cwd: string;
};

type StateDb = {
  pragma(sql: string): Array<{ name: string }>;
  prepare(sql: string): { all(): Array<Record<string, unknown>> };
  close(): void;
};

/** 读取有上限的会话头，正文和大图片不会进入摘要恢复流程。 */
function readSessionHeader(filePath: string): any {
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(8 * 1024);
    for (let offset = 0; offset < 256 * 1024;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (!count) break;
      const end = chunk.subarray(0, count).indexOf(10);
      chunks.push(Buffer.from(chunk.subarray(0, end < 0 ? count : end)));
      if (end >= 0) return JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
      offset += count;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
  } finally {
    fs.closeSync(fd);
  }
}

/** 只接受当前会话根内的真实文件，排除归档、残留行和跨目录引用。 */
function resolveRootFilePath(filePath: string, root: string, physicalRoot: string): string {
  const relative = path.relative(root, filePath);
  if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) return filePath;
  // Codex home 可能是目录联接，数据库记录物理盘符而扫描入口使用逻辑盘符。
  const physicalRelative = path.relative(physicalRoot, fs.realpathSync(filePath));
  if (!physicalRelative || physicalRelative.startsWith(`..${path.sep}`) || physicalRelative === ".." || path.isAbsolute(physicalRelative)) return "";
  return path.join(root, physicalRelative);
}

/** 在后台进程只读查询官方摘要，并用真实文件头核对身份、项目和父子关系。 */
export function readCodexStateSnapshot(
  roots: readonly string[],
  Database = require("better-sqlite3") as new (filePath: string, options: object) => StateDb,
): CodexStateSnapshotEntry[] {
  const result: CodexStateSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (isNetworkPath(root)) continue;
    const home = path.dirname(root);
    let names: string[];
    let physicalRoot: string;
    try {
      physicalRoot = fs.realpathSync(root);
      names = fs.readdirSync(home).filter((name) => /^state[_-]?\d*\.sqlite$/i.test(name));
    } catch { continue; }
    names.sort((a, b) => Number(b.match(/\d+/)?.[0] || 0) - Number(a.match(/\d+/)?.[0] || 0));
    for (const name of names) {
      let db: StateDb | undefined;
      try {
        db = new Database(path.join(home, name), { readonly: true, fileMustExist: true, timeout: 100 });
        const columns = new Set(db.pragma("table_info(threads)").map((column) => column.name));
        if (!["id", "rollout_path", "cwd", "title", "first_user_message"].every((column) => columns.has(column))) continue;
        const nameField = columns.has("name") ? "substr(name, 1, 4096)" : "''";
        const rows = db.prepare(`SELECT id, rollout_path, cwd, substr(title, 1, 4096) AS title,
          substr(first_user_message, 1, 4096) AS first_user_message, ${nameField} AS name FROM threads`).all();
        for (const row of rows) {
          try {
            const rawFilePath = String(row.rollout_path || "");
            const normalizedFilePath = process.platform === "win32" ? normalizeWinPath(rawFilePath) : rawFilePath;
            if (!normalizedFilePath || isNetworkPath(normalizedFilePath)) continue;
            const filePath = resolveRootFilePath(normalizedFilePath, root, physicalRoot);
            if (!filePath || seen.has(filePath)) continue;
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || !stat.size) continue;
            const header = readSessionHeader(filePath);
            const modern = header?.type === "session_meta";
            const meta = modern ? header.payload : header;
            if (String(meta?.id || "") !== String(row.id || "")) continue;
            // 继承历史仍走逻辑流解析，以保留引用缺失和回退版本的原有保护。
            if (meta?.history_base) continue;
            const cwd = String(meta?.cwd || row.cwd || "").trim();
            const request = filterCodexHistoryPreviewText(String(row.first_user_message || ""));
            if (!cwd || !request) continue;
            const preview = String(row.name || "").trim() || filterCodexHistoryPreviewText(String(row.title || "")) || request;
            const after = fs.statSync(filePath);
            if (after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) continue;
            seen.add(filePath);
            result.push({
              cwd,
              sig: { mtimeMs: stat.mtimeMs, size: stat.size },
              summary: {
                providerId: "codex", id: String(row.id), filePath, date: stat.mtimeMs,
                title: preview.length > 96 ? `${preview.slice(0, 95)}…` : preview,
                preview, dirKey: dirKeyFromCwd(cwd), rawDate: header.timestamp,
                resumeMode: modern ? "modern" : "legacy", resumeId: String(row.id), runtimeShell: "windows",
                codexRelationship: extractCodexSessionRelationship(header),
              },
            });
          } catch { /* 单条残留或损坏记录交给常规扫描处理。 */ }
        }
        // 只采用最新兼容数据库，防止旧版数据库把过期回退版本重新引入。
        break;
      } catch { /* 数据库缺失、占用或版本不兼容时保留文件扫描。 */ }
      finally { try { db?.close(); } catch {} }
    }
  }
  return result;
}

const snapshotTasks = new Map<string, { expiresAt: number; task: Promise<CodexStateSnapshotEntry[]> }>();

/** 合并启动时的项目与历史读取，在独立进程查询；超时自动回退且不阻塞界面。 */
export function loadCodexStateSnapshot(roots: readonly string[]): Promise<CodexStateSnapshotEntry[]> {
  const localRoots = Array.from(new Set(roots.filter((root) => root && !isNetworkPath(root)))).sort();
  if (!localRoots.length) return Promise.resolve([]);
  const key = localRoots.join("|");
  const cached = snapshotTasks.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.task;
  const task = new Promise<CodexStateSnapshotEntry[]>((resolve) => {
    let worker: ChildProcess | undefined;
    let settled = false;
    /** 统一结束后台任务，超时或启动失败时释放子进程。 */
    const finish = (entries: CodexStateSnapshotEntry[], terminate = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate) worker?.kill();
      resolve(entries);
    };
    const timer = setTimeout(() => finish([], true), 5_000);
    try {
      // 原生驱动使用独立进程，超时和驱动退出不会影响应用主进程。
      const options: ForkOptions & { windowsHide: boolean } = {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      };
      worker = fork(path.join(__dirname, "codexStateSnapshotWorker.js"), [], options);
      worker.once("message", (message) => {
        const entries = message && typeof message === "object" && "entries" in message ? message.entries : undefined;
        finish(Array.isArray(entries) ? entries : []);
      });
      worker.once("error", () => finish([]));
      worker.once("exit", () => finish([]));
      worker.send({ roots: localRoots });
    } catch { finish([]); }
  });
  snapshotTasks.set(key, { expiresAt: Date.now() + 5_000, task });
  return task;
}
