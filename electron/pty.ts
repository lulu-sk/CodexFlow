// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from 'node:os';
import wsl from './wsl.js';
import settings from './settings.js';
import { resolveWindowsShell } from './shells.js';
import type { IPty } from '@lydell/node-pty';
import * as pty from '@lydell/node-pty';
import { BrowserWindow } from 'electron';
import { perfLogger } from './log.js';
import { getDebugConfig } from './debugConfig.js';

// 终端日志总开关（主进程）。默认关闭，由统一调试配置控制，也可通过 IPC 置位。
let TERM_DEBUG = (() => { try { return !!(getDebugConfig().terminal.pty.debug); } catch { return false; } })();
export function setTermDebug(flag: boolean) { TERM_DEBUG = !!flag; try { perfLogger.log(`[pty] debugTerm=${TERM_DEBUG ? 'on' : 'off'}`); } catch {} }
const dlog = (msg: string) => { if (TERM_DEBUG) { try { perfLogger.log(msg); } catch {} } };

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class PTYManager {
  private sessions = new Map<string, IPty>();
  private getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  openWSLConsole(opts: { distro?: string; wslPath?: string; winPath?: string; cols?: number; rows?: number; startupCmd?: string }): string {
    const distro = opts.distro || 'Ubuntu-22.04';
    const wslPath = opts.wslPath || '~';
    const winPath = String(opts.winPath || '').trim();
    const cols = opts.cols || 80;
    const rows = opts.rows || 24;
    const startupCmd = opts.startupCmd || '';

    const id = uid();

    const env = { ...process.env } as Record<string, string>;

    // 根据设置选择 WSL 或 Windows 本地终端
    const termMode = (settings.getSettings().terminal || 'wsl');
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
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: undefined,
        env
      });
    }

    this.sessions.set(id, proc);

    dlog(`[pty] open id=${id} mode=${os.platform() === 'win32' ? (termMode || 'wsl') : 'posix'} cols=${cols} rows=${rows} winCwd=${winPath || ''} wslCwd=${wslPath || ''}`);

    proc.onData((data: string) => {
      const win = this.getWindow();
      if (win) win.webContents.send('pty:data', { id, data });
    });

    proc.onExit((evt: { exitCode: number; signal?: number }) => {
      this.sessions.delete(id);
      const win = this.getWindow();
      if (win) win.webContents.send('pty:exit', { id, exitCode: evt?.exitCode });
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
          p.write(`bash -lc "${startupCmd.replace(/"/g, '\\"')}"\r`);
          dlog(`[pty] startupCmd executed (wsl) id=${id}`);
        } else {
          p.write(`${startupCmd}\r`);
          dlog(`[pty] startupCmd executed (posix) id=${id}`);
        }
      });
    }

    return id;
  }

  write(id: string, data: string) {
    const p = this.sessions.get(id);
    if (p) p.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const p = this.sessions.get(id);
    if (p) {
      const c = Math.max(2, cols);
      const r = Math.max(2, rows);
      dlog(`[pty] resize id=${id} cols=${c} rows=${r}`);
      p.resize(c, r);
    }
  }

  close(id: string) {
    const p = this.sessions.get(id);
    if (p) {
      try { p.kill(); } catch { /* noop */ }
      this.sessions.delete(id);
    }
  }

  // 可选：在前端重排期间暂停/恢复数据，降低竞态导致的错位/叠字
  pause(id: string) {
    const p = this.sessions.get(id);
    dlog(`[pty] pause id=${id}`);
    try { p?.pause(); } catch {}
  }

  resume(id: string) {
    const p = this.sessions.get(id);
    dlog(`[pty] resume id=${id}`);
    try { p?.resume(); } catch {}
  }

  // 与前端清屏同步，通知 ConPTY 清除其内部缓冲（仅 Windows/ConPTY 有效，其他平台为 no-op）
  clear(id: string) {
    const p = this.sessions.get(id);
    try { (p as any)?.clear?.(); } catch {}
  }

  // 强制清理所有会话（例如应用退出时调用）
  disposeAll() {
    for (const [id, p] of Array.from(this.sessions.entries())) {
      try { p.kill(); } catch {}
      this.sessions.delete(id);
    }
  }
}
