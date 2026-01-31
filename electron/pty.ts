// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from 'node:os';
import wsl from './wsl.js';
import settings from './settings.js';
import { resolveWindowsShell, type TerminalMode } from './shells.js';
import type { IPty } from '@lydell/node-pty';
import * as pty from '@lydell/node-pty';
import { BrowserWindow } from 'electron';
import { perfLogger } from './log.js';
import { getDebugConfig } from './debugConfig.js';
import { safeWindowSend } from './ipcSafe';

// 终端日志总开关（主进程）。默认关闭，由统一调试配置控制，也可通过 IPC 置位。
let TERM_DEBUG = (() => { try { return !!(getDebugConfig().terminal.pty.debug); } catch { return false; } })();
export function setTermDebug(flag: boolean) { TERM_DEBUG = !!flag; try { perfLogger.log(`[pty] debugTerm=${TERM_DEBUG ? 'on' : 'off'}`); } catch {} }
const dlog = (msg: string) => { if (TERM_DEBUG) { try { perfLogger.log(msg); } catch {} } };

// PTY 输出尾部缓冲上限（字符数）。
// 说明：用于渲染进程意外 reload/HMR 后恢复“滚动区”内容，避免用户误以为任务丢失。
// 取值策略：与 xterm scrollback(10000) 的量级匹配，避免无限增长占用内存。
const PTY_BACKLOG_MAX_CHARS = 1_200_000;
// PTY 输出合并：将高频碎片输出合并为较少的 IPC 消息，减少主/渲染进程消息队列压力。
// 说明：该值越小越“实时”，但 IPC 次数越多；16ms 约等于 60fps，实践中对 UI/CPU 更友好。
const PTY_IPC_FLUSH_MS = 16;
// 中文说明：单个 PTY 在一次 flush 窗口内允许积累的最大字符数（超过则裁剪旧数据）。
// 目的：避免渲染卡顿/不可见时 IPC 队列与字符串拼接无上限增长，最终导致白屏/崩溃。
const PTY_IPC_MAX_PENDING_CHARS = 280_000;

/**
 * 将字符串转换为 Bash 单引号安全字面量。
 *
 * 说明：
 * - 主要用于构造 `bash -lc '...'` 的参数；
 * - 避免外层 shell 在双引号中对反引号/`$()` 做命令替换，导致把用户输入当作命令执行。
 */
function bashSingleQuote(value: string): string {
  const s = String(value ?? "");
  if (s.length === 0) return "''";
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 中文说明：用于保存 PTY 输出的“尾部环形缓冲”。
 * - 写入为 O(1) 追加；超过上限后仅从头部裁剪；
 * - 读取时按需截取尾部，避免 join 全量导致的额外开销。
 */
class PtyBacklogBuffer {
  private chunks: string[] = [];
  private totalChars = 0;
  private maxChars: number;

  /**
   * 创建一个尾部缓冲。
   * @param maxChars - 最大保留字符数（<=0 表示禁用缓冲）。
   */
  constructor(maxChars: number) {
    const n = Number(maxChars);
    this.maxChars = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }

  /**
   * 追加一段输出。
   */
  append(data: string): void {
    if (!this.maxChars) return;
    const s = String(data || "");
    if (!s) return;
    this.chunks.push(s);
    this.totalChars += s.length;
    this.trimIfNeeded();
  }

  /**
   * 读取尾部最多 `maxChars` 字符（默认读取缓冲上限）。
   */
  readTail(maxChars?: number): string {
    if (!this.maxChars || this.totalChars <= 0) return "";
    const req = typeof maxChars === "number" && Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : this.maxChars;
    const limit = Math.min(req, this.maxChars, this.totalChars);
    if (limit <= 0) return "";

    let remaining = limit;
    const parts: string[] = [];
    for (let i = this.chunks.length - 1; i >= 0 && remaining > 0; i--) {
      const chunk = this.chunks[i];
      if (!chunk) continue;
      if (chunk.length <= remaining) {
        parts.push(chunk);
        remaining -= chunk.length;
      } else {
        parts.push(chunk.slice(chunk.length - remaining));
        remaining = 0;
      }
    }
    parts.reverse();
    return parts.join("");
  }

  /**
   * 清空缓冲（释放内存）。
   */
  clear(): void {
    this.chunks = [];
    this.totalChars = 0;
  }

  /**
   * 按 maxChars 对尾部裁剪（仅裁剪头部）。
   */
  private trimIfNeeded(): void {
    if (!this.maxChars) return;
    if (this.totalChars <= this.maxChars) return;

    while (this.chunks.length > 0 && this.totalChars > this.maxChars) {
      const first = this.chunks[0] || "";
      const overflow = this.totalChars - this.maxChars;
      // 需要裁剪的溢出量小于首块长度：只裁剪首块前缀并结束
      if (overflow < first.length) {
        this.chunks[0] = first.slice(overflow);
        this.totalChars = this.maxChars;
        return;
      }
      // 直接丢弃整块
      this.chunks.shift();
      this.totalChars -= first.length;
    }
    if (this.totalChars < 0) this.totalChars = 0;
  }
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 中文说明：合并额外环境变量，避免空 key 与非字符串值。
 */
function mergeExtraEnv(base: Record<string, string>, extra?: Record<string, string>): Record<string, string> {
  const next = { ...base };
  if (!extra || typeof extra !== "object") return next;
  for (const [key, value] of Object.entries(extra)) {
    const k = String(key || "").trim();
    if (!k) continue;
    if (value === undefined || value === null) continue;
    const v = typeof value === "string" ? value : String(value);
    next[k] = v;
  }
  return next;
}

/**
 * 中文说明：将指定环境变量名追加到 WSLENV，确保传递到 WSL。
 */
function appendWslEnv(existing: string | undefined, keys: string[]): string {
  const list = String(existing || "").split(":").filter(Boolean);
  const seen = new Set<string>();
  for (const item of list) {
    const base = String(item || "").split("/")[0];
    if (base) seen.add(base);
  }
  for (const key of keys) {
    if (!key || seen.has(key)) continue;
    list.push(key);
    seen.add(key);
  }
  return list.join(":");
}

type PtyIpcPendingState = {
  timer: NodeJS.Timeout | null;
  chunks: string[];
  totalChars: number;
  droppedChars: number;
};

export class PTYManager {
  private sessions = new Map<string, IPty>();
  private backlogs = new Map<string, PtyBacklogBuffer>();
  private ipcPendingById = new Map<string, PtyIpcPendingState>();
  private getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  /**
   * 中文说明：安全向渲染进程发送 PTY 事件。
   * - 渲染进程 reload/导航切换期间 mainFrame 可能暂不可用，此时自动跳过并短暂退避；
   * - 避免控制台刷屏或触发主进程未捕获异常导致崩溃。
   * @param channel - IPC 通道名
   * @param payload - 发送负载
   */
  private sendToRenderer(channel: string, payload: unknown): void {
    safeWindowSend(this.getWindow(), channel, payload, {
      tag: 'pty',
      suppressMs: 800,
      logger: TERM_DEBUG ? dlog : undefined,
    });
  }

  /**
   * 中文说明：将 PTY 输出合并后再发送到渲染进程，降低高频输出下的 IPC 消息数量。
   *
   * 设计目标：
   * - 多终端并发 + 大量输出场景下，避免主/渲染进程消息队列被淹没；
   * - 避免渲染层因事件分发与 xterm 写入过于频繁而出现“白屏但任务仍在跑”的假死状态。
   *
   * @param id - PTY 会话 id
   * @param data - 本次新增输出片段
   */
  private enqueuePtyData(id: string, data: string): void {
    const key = String(id || "").trim();
    if (!key) return;
    const chunk = String(data || "");
    if (!chunk) return;

    let state = this.ipcPendingById.get(key);
    if (!state) {
      state = { timer: null, chunks: [], totalChars: 0, droppedChars: 0 };
      this.ipcPendingById.set(key, state);
    }

    state.chunks.push(chunk);
    state.totalChars += chunk.length;

    // 过载保护：仅保留尾部，避免 pending 在渲染侧卡顿时无限增长
    if (state.totalChars > PTY_IPC_MAX_PENDING_CHARS) {
      let overflow = state.totalChars - PTY_IPC_MAX_PENDING_CHARS;
      while (overflow > 0 && state.chunks.length > 0) {
        const first = state.chunks[0] || "";
        if (first.length <= overflow) {
          state.chunks.shift();
          overflow -= first.length;
          state.totalChars -= first.length;
          state.droppedChars += first.length;
          continue;
        }
        state.chunks[0] = first.slice(overflow);
        state.totalChars -= overflow;
        state.droppedChars += overflow;
        overflow = 0;
      }
    }

    if (state.timer) return;
    state.timer = setTimeout(() => {
      try { this.flushPtyData(key); } catch {}
    }, PTY_IPC_FLUSH_MS);
    try { (state.timer as any).unref?.(); } catch {}
  }

  /**
   * 中文说明：立刻发送一次合并后的 PTY 输出，并清空 pending。
   * @param id - PTY 会话 id
   */
  private flushPtyData(id: string): void {
    const state = this.ipcPendingById.get(id);
    if (!state) return;
    try {
      if (state.timer) {
        try { clearTimeout(state.timer); } catch {}
      }
    } finally {
      state.timer = null;
    }

    const dropped = state.droppedChars;
    state.droppedChars = 0;
    const data = state.chunks.length > 0 ? state.chunks.join("") : "";
    state.chunks = [];
    state.totalChars = 0;
    this.ipcPendingById.delete(id);

    if (!data && !dropped) return;
    if (dropped > 0) {
      // 中文说明：不把提示字样注入到终端输出流，避免破坏 TUI 的屏幕状态；仅在调试时记录。
      try { dlog(`[pty] ipc.drop id=${id} dropped=${dropped}`); } catch {}
    }
    this.sendToRenderer('pty:data', { id, data });
  }

  /**
   * 中文说明：在会话关闭/退出时清理 pending 定时器与缓存，避免泄漏。
   * 注意：此方法不会发送残留数据；需要保留“最后一批输出”的场景应调用 flushPtyData。
   * @param id - PTY 会话 id
   */
  private clearPendingPtyData(id: string): void {
    const state = this.ipcPendingById.get(id);
    if (!state) return;
    try {
      if (state.timer) {
        try { clearTimeout(state.timer); } catch {}
      }
    } catch {} finally {
      this.ipcPendingById.delete(id);
    }
  }

  /**
   * 获取当前仍处于活跃状态的 PTY 会话数量。
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * 中文说明：判断指定 id 的 PTY 会话是否仍然存活。
   */
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * 中文说明：读取指定 PTY 的尾部输出缓存（用于渲染进程 reload 后恢复终端内容）。
   * @param id - PTY id
   * @param maxChars - 读取字符上限（不传则使用默认上限）
   */
  getBacklog(id: string, maxChars?: number): string {
    const buf = this.backlogs.get(id);
    if (!buf) return "";
    return buf.readTail(maxChars);
  }

  /**
   * 打开一个 PTY 会话。
   * - 允许通过 opts.terminal 覆盖全局 settings.terminal，用于实现 Provider 级别环境隔离。
   */
  openWSLConsole(opts: { terminal?: TerminalMode; distro?: string; wslPath?: string; winPath?: string; cols?: number; rows?: number; startupCmd?: string; env?: Record<string, string> }): string {
    const distro = opts.distro || 'Ubuntu-22.04';
    const wslPath = opts.wslPath || '~';
    const winPath = String(opts.winPath || '').trim();
    const cols = opts.cols || 80;
    const rows = opts.rows || 24;
    const startupCmd = opts.startupCmd || '';

    const id = uid();

    let env = { ...process.env } as Record<string, string>;
    env = mergeExtraEnv(env, opts.env);

    // 根据设置选择 WSL 或 Windows 本地终端
    const termMode = (opts.terminal || settings.getSettings().terminal || 'wsl');
    let proc: IPty;
    if (os.platform() !== 'win32') {
      // 在非 Windows 环境使用本地 shell 便于开发调试
      const shell = process.env.SHELL || '/bin/bash';
      const args: string[] = [];
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: undefined,
        env
      });
    } else if (termMode === 'windows' || termMode === 'pwsh') {
      // Windows 本地终端（PowerShell / PowerShell 7）
      const resolved = resolveWindowsShell(termMode === 'pwsh' ? 'pwsh' : 'windows');
      const shell = resolved.command;
      const args: string[] = ['-NoLogo'];
      const cwd = winPath && winPath.trim().length > 0 ? winPath : undefined;
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env
      });
    } else {
      // WSL 模式
      let shell = 'wsl.exe';
      let args: string[] = [];
      if (os.platform() === 'win32') {
        try {
          // 如果指定了发行版且存在，则使用 -d <distro>
          if (opts.distro && wsl.distroExists(opts.distro)) {
            args = ['-d', distro];
          } else {
            // 否则回退到默认发行版（不传 -d）
            args = [];
          }
        } catch {
          args = [];
        }
        if (opts.wslPath) {
          args.push('--cd', wslPath);
        }
      }
      if (os.platform() === 'win32' && opts.env && Object.keys(opts.env).length > 0) {
        const keys = Object.keys(opts.env).map((k) => String(k || "").trim()).filter(Boolean);
        if (keys.length > 0) env.WSLENV = appendWslEnv(env.WSLENV, keys);
      }
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: undefined,
        env
      });
    }

    this.sessions.set(id, proc);
    // 为该会话建立尾部缓冲，支持渲染进程 reload 后恢复滚动区
    this.backlogs.set(id, new PtyBacklogBuffer(PTY_BACKLOG_MAX_CHARS));

    dlog(`[pty] open id=${id} mode=${os.platform() === 'win32' ? (termMode || 'wsl') : 'posix'} cols=${cols} rows=${rows} winCwd=${winPath || ''} wslCwd=${wslPath || ''}`);

    proc.onData((data: string) => {
      try { this.backlogs.get(id)?.append(data); } catch {}
      this.enqueuePtyData(id, data);
    });

    proc.onExit((evt: { exitCode: number; signal?: number }) => {
      // 中文说明：在退出前先 flush，避免最后一批输出被合并队列吞掉（例如短命令 < 16ms 即退出）。
      try { this.flushPtyData(id); } catch {}
      this.sessions.delete(id);
      try { this.backlogs.get(id)?.clear(); } catch {}
      this.backlogs.delete(id);
      this.sendToRenderer('pty:exit', { id, exitCode: evt?.exitCode });
    });

    // 关键修复：延迟执行 startupCmd，确保前端有足够时间订阅 'pty:data' 事件
    // 使用 setImmediate 让前端的 IPC 订阅先完成，避免早期输出（包括 OSC 通知）丢失
    if (startupCmd) {
      const isWin = os.platform() === 'win32';
      const mode = isWin ? (termMode || 'wsl') : 'posix';
      const isWinShell = mode === 'windows' || mode === 'pwsh';
      setImmediate(() => {
        const p = this.sessions.get(id);
        if (!p) return; // PTY 可能已关闭
        if (isWinShell) {
          // PowerShell / PowerShell 7 中直接执行命令（cwd 已设置）
          p.write(`${startupCmd}\r`);
          dlog(`[pty] startupCmd executed (windows) id=${id} shell=${mode}`);
        } else if (isWin) {
          // WSL：通过 bash -lc 执行
          p.write(`bash -lc ${bashSingleQuote(startupCmd)}\r`);
          dlog(`[pty] startupCmd executed (wsl) id=${id}`);
        } else {
          p.write(`${startupCmd}\r`);
          dlog(`[pty] startupCmd executed (posix) id=${id}`);
        }
      });
    }

    return id;
  }

  /**
   * 向指定 PTY 写入数据（等价于用户在终端中输入）。
   * @param id - PTY id
   * @param data - 写入内容
   */
  write(id: string, data: string) {
    const p = this.sessions.get(id);
    if (p) p.write(data);
  }

  /**
   * 调整指定 PTY 的终端尺寸。
   * @param id - PTY id
   * @param cols - 列数
   * @param rows - 行数
   */
  resize(id: string, cols: number, rows: number) {
    const p = this.sessions.get(id);
    if (p) {
      const c = Math.max(2, cols);
      const r = Math.max(2, rows);
      dlog(`[pty] resize id=${id} cols=${c} rows=${r}`);
      p.resize(c, r);
    }
  }

  /**
   * 关闭并清理指定 PTY 会话。
   * @param id - PTY id
   */
  close(id: string) {
    const p = this.sessions.get(id);
    if (p) {
      try { p.kill(); } catch { /* noop */ }
      this.sessions.delete(id);
    }
    // 中文说明：关闭时尽量把最后的 pending 输出发送出去，避免 UI 看到“少一截”。
    try { this.flushPtyData(id); } catch {}
    try { this.clearPendingPtyData(id); } catch {}
    try { this.backlogs.get(id)?.clear(); } catch {}
    this.backlogs.delete(id);
  }

  // 可选：在前端重排期间暂停/恢复数据，降低竞态导致的错位/叠字
  /**
   * 暂停指定 PTY 的数据流（若底层实现支持）。
   * @param id - PTY id
   */
  pause(id: string) {
    const p = this.sessions.get(id);
    dlog(`[pty] pause id=${id}`);
    try { p?.pause(); } catch {}
  }

  /**
   * 恢复指定 PTY 的数据流（若底层实现支持）。
   * @param id - PTY id
   */
  resume(id: string) {
    const p = this.sessions.get(id);
    dlog(`[pty] resume id=${id}`);
    try { p?.resume(); } catch {}
  }

  // 与前端清屏同步，通知 ConPTY 清除其内部缓冲（仅 Windows/ConPTY 有效，其他平台为 no-op）
  /**
   * 请求底层 PTY 清理内部缓冲（仅部分实现支持，如 Windows/ConPTY）。
   * @param id - PTY id
   */
  clear(id: string) {
    const p = this.sessions.get(id);
    try { (p as any)?.clear?.(); } catch {}
  }

  // 强制清理所有会话（例如应用退出时调用）
  /**
   * 强制清理所有 PTY 会话（通常用于应用退出流程）。
   */
  disposeAll() {
    for (const [id, p] of Array.from(this.sessions.entries())) {
      try { p.kill(); } catch {}
      this.sessions.delete(id);
      // 中文说明：同 close(id)，在全量清理时也尽量 flush 尾部输出。
      try { this.flushPtyData(id); } catch {}
      try { this.clearPendingPtyData(id); } catch {}
      try { this.backlogs.get(id)?.clear(); } catch {}
      this.backlogs.delete(id);
    }
  }
}
