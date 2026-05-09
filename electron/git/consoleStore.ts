// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitExecResult } from "./exec";
import { toFsPathAbs, toFsPathKey } from "./pathKey";

export type GitConsoleEntry = {
  id: number;
  timestamp: number;
  cwd: string;
  repoRootKey: string;
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
  running?: boolean;
};

export type GitConsoleListMode = "view" | "copy";

const GIT_CONSOLE_MAX_ENTRIES = 500;
const GIT_CONSOLE_VIEW_MAX_TEXT = 64_000;
const GIT_CONSOLE_COPY_MAX_TEXT = 256_000;

/**
 * 按给定上限裁剪控制台文本，避免单条记录无限增长。
 */
function clampConsoleText(raw: string, maxLen: number): string {
  const text = String(raw || "");
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * 把命令参数转为可读字符串，尽量保留空格与特殊字符语义。
 */
function quoteArgForConsole(raw: string): string {
  const text = String(raw || "");
  if (!text) return "\"\"";
  if (/^[\w./:@=+-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * 格式化 Git 命令行为单行文本，供控制台展示与复制复用。
 */
function formatGitCommandForConsole(gitPath: string, argv: string[]): string {
  const head = String(gitPath || "git");
  return [head, ...argv.map((one) => quoteArgForConsole(one))].join(" ");
}

/**
 * 管理 Git 控制台内存记录。
 * - 存储层保留较长文本，保证“复制日志”尽量拿到完整输出；
 * - 列表层默认再做一次轻量裁剪，避免大文本直接进入渲染树。
 */
export class GitConsoleStore {
  private readonly entries: GitConsoleEntry[] = [];
  private seq = 0;

  /**
   * 追加一条已完成的 Git 控制台记录。
   */
  appendCompletedEntry(args: {
    cwd: string;
    gitPath: string;
    argv: string[];
    result: GitExecResult;
    durationMs: number;
  }): void {
    const cwd = toFsPathAbs(String(args.cwd || ""));
    const repoRootKey = toFsPathKey(cwd);
    const entry: GitConsoleEntry = {
      id: ++this.seq,
      timestamp: Date.now(),
      cwd,
      repoRootKey,
      command: formatGitCommandForConsole(args.gitPath, args.argv),
      ok: !!args.result.ok,
      exitCode: Number(args.result.exitCode || 0),
      durationMs: Math.max(0, Math.floor(Number(args.durationMs) || 0)),
      stdout: clampConsoleText(String(args.result.stdout || ""), GIT_CONSOLE_COPY_MAX_TEXT),
      stderr: clampConsoleText(String(args.result.stderr || ""), GIT_CONSOLE_COPY_MAX_TEXT),
      error: String(args.result.error || "").trim() || undefined,
    };
    this.entries.push(entry);
    this.trimToCapacity();
  }

  /**
   * 创建一条运行中的 Git 控制台记录，供流式输出持续追加。
   */
  createRunningEntry(args: {
    cwd: string;
    gitPath: string;
    argv: string[];
  }): GitConsoleEntry {
    const cwd = toFsPathAbs(String(args.cwd || ""));
    const repoRootKey = toFsPathKey(cwd);
    const entry: GitConsoleEntry = {
      id: ++this.seq,
      timestamp: Date.now(),
      cwd,
      repoRootKey,
      command: formatGitCommandForConsole(args.gitPath, args.argv),
      ok: false,
      exitCode: 0,
      durationMs: 0,
      stdout: "",
      stderr: "",
      running: true,
    };
    this.entries.push(entry);
    this.trimToCapacity();
    return entry;
  }

  /**
   * 向运行中的记录追加流式输出，并同步刷新已耗时。
   */
  appendRunningOutput(
    entryId: number,
    patch: {
      stdoutChunk?: string;
      stderrChunk?: string;
    },
  ): void {
    const entry = this.findEntryById(entryId);
    if (!entry) return;
    if (patch.stdoutChunk) entry.stdout = clampConsoleText(`${entry.stdout}${patch.stdoutChunk}`, GIT_CONSOLE_COPY_MAX_TEXT);
    if (patch.stderrChunk) entry.stderr = clampConsoleText(`${entry.stderr}${patch.stderrChunk}`, GIT_CONSOLE_COPY_MAX_TEXT);
    entry.durationMs = Math.max(0, Date.now() - entry.timestamp);
  }

  /**
   * 用最终执行结果收口运行中的记录。
   */
  finishRunningEntry(entryId: number, result: GitExecResult, durationMs: number): void {
    const entry = this.findEntryById(entryId);
    if (!entry) return;
    entry.ok = !!result.ok;
    entry.exitCode = Number(result.exitCode || 0);
    entry.durationMs = Math.max(0, Math.floor(Number(durationMs) || 0));
    entry.stdout = clampConsoleText(String(result.stdout || ""), GIT_CONSOLE_COPY_MAX_TEXT);
    entry.stderr = clampConsoleText(String(result.stderr || ""), GIT_CONSOLE_COPY_MAX_TEXT);
    entry.error = String(result.error || "").trim() || undefined;
    entry.running = false;
  }

  /**
   * 按仓库读取控制台记录；默认返回适合 UI 展示的短文本。
   */
  listEntries(repoRootOrPath: string, limitInput: number, mode: GitConsoleListMode = "view"): GitConsoleEntry[] {
    const limit = Math.max(20, Math.min(500, Math.floor(Number(limitInput) || 200)));
    const abs = toFsPathAbs(String(repoRootOrPath || "").trim());
    const key = toFsPathKey(abs);
    const source = key
      ? this.entries.filter((entry) => entry.repoRootKey === key || (!entry.repoRootKey && entry.cwd === abs))
      : this.entries;
    const start = Math.max(0, source.length - limit);
    return source.slice(start).map((entry) => this.cloneEntryForMode(entry, mode));
  }

  /**
   * 按仓库清空控制台记录；未指定仓库时清空全部。
   */
  clearEntries(repoRootOrPath: string): number {
    const abs = toFsPathAbs(String(repoRootOrPath || "").trim());
    const key = toFsPathKey(abs);
    if (!key) {
      const cleared = this.entries.length;
      this.entries.length = 0;
      return cleared;
    }

    let removed = 0;
    for (let idx = this.entries.length - 1; idx >= 0; idx -= 1) {
      const hit = this.entries[idx];
      if (hit.repoRootKey === key || (!hit.repoRootKey && hit.cwd === abs)) {
        this.entries.splice(idx, 1);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 按 ID 查找控制台记录；不存在时返回 null。
   */
  private findEntryById(entryId: number): GitConsoleEntry | null {
    const id = Math.max(0, Math.floor(Number(entryId) || 0));
    if (!id) return null;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.id === id) return entry;
    }
    return null;
  }

  /**
   * 按模式复制一条记录；展示模式会把正文压到较短长度。
   */
  private cloneEntryForMode(entry: GitConsoleEntry, mode: GitConsoleListMode): GitConsoleEntry {
    const durationMs = entry.running ? Math.max(entry.durationMs, Date.now() - entry.timestamp) : entry.durationMs;
    if (mode === "copy") {
      return {
        ...entry,
        durationMs,
      };
    }
    return {
      ...entry,
      durationMs,
      stdout: clampConsoleText(entry.stdout, GIT_CONSOLE_VIEW_MAX_TEXT),
      stderr: clampConsoleText(entry.stderr, GIT_CONSOLE_VIEW_MAX_TEXT),
    };
  }

  /**
   * 维持固定条数的环形缓存，避免控制台记录无限增长。
   */
  private trimToCapacity(): void {
    if (this.entries.length <= GIT_CONSOLE_MAX_ENTRIES) return;
    this.entries.splice(0, this.entries.length - GIT_CONSOLE_MAX_ENTRIES);
  }
}
