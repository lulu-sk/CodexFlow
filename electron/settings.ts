// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import os from 'node:os';
import wsl, { getSessionsRootsFastAsync } from './wsl';

export type AppSettings = {
  /** 终端类型：WSL 或 Windows 本地终端 */
  terminal?: 'wsl' | 'windows';
  /** WSL 发行版名称（当 terminal=wsl 时生效） */
  distro: string;
  /** 启动 CodexFlow 的命令（渲染层会做包装） */
  codexCmd: string;
  /** 历史根目录（自动探测） */
  historyRoot: string;
  /** 发送行为：仅写入(write_only) 或 写入并回车(write_and_enter) */
  sendMode?: 'write_only' | 'write_and_enter';
  /** 用户首选语言（可选；为空时按系统语言） */
  locale?: string;
  /** 项目内文件路径样式：absolute=全路径；relative=相对路径（相对项目根） */
  projectPathStyle?: 'absolute' | 'relative';
};

function getStorePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function defaultSettings(): AppSettings {
  return {
    terminal: 'wsl',
    distro: 'Ubuntu-24.04',
    // 渲染层会按“每标签独立 tmux 会话”包装该命令；默认仅保存基础命令
    codexCmd: 'codex',
    historyRoot: path.join(os.homedir(), '.codex', 'sessions'),
    sendMode: 'write_and_enter',
    // 默认：发送给 Codex 的项目内文件路径使用“全路径”（WSL 绝对路径）
    projectPathStyle: 'absolute',
  };
}

export function getSettings(): AppSettings {
  try {
    const p = getStorePath();
    if (!fs.existsSync(p)) return defaultSettings();
    const raw = fs.readFileSync(p, 'utf8');
    return Object.assign(defaultSettings(), JSON.parse(raw || '{}')) as AppSettings;
  } catch (e) {
    return defaultSettings();
  }
}

export function updateSettings(partial: Partial<AppSettings>) {
  try {
    const cur = getSettings();
    const next = Object.assign({}, cur, partial);
    fs.writeFileSync(getStorePath(), JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) {
    return getSettings();
  }
}

/**
 * 首次运行/路径缺失时自动探测历史目录，并写回设置。
 * 优先顺序：
 *  1) 当前设置的 historyRoot（若存在）
 *  2) Windows 用户目录下 ~/.codex/sessions
 *  3) 每个 WSL 发行版的 $HOME/.codex/sessions（UNC）
 */
export async function ensureSettingsAutodetect(): Promise<AppSettings> {
  const cur = getSettings();
  const exists = (p?: string) => !!p && typeof p === 'string' && fs.existsSync(p);
  if (exists(cur.historyRoot)) return cur;

  const candidates: string[] = [];
  try { candidates.push(path.join(os.homedir(), '.codex', 'sessions')); } catch {}
  try {
    const roots = await getSessionsRootsFastAsync();
    for (const r of roots) { if (r) candidates.push(r); }
  } catch {}

  for (const c of candidates) {
    try { if (exists(c)) return updateSettings({ historyRoot: c }); } catch {}
  }
  return cur;
}

export default { getSettings, updateSettings };


