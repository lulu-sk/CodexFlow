// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { toFsPathAbs, toFsPathKey } from "../git/pathKey";

export type BuildRunBackend =
  | { kind: "system" }
  | { kind: "pwsh" }
  | { kind: "git_bash" }
  | { kind: "wsl"; distro?: string }
  | { kind: "custom"; command: string };

export type EnvRow = { key: string; value: string };

export type BuildRunCommandConfig = {
  /** 配置模式：simple=脚本文本；advanced=cmd/args 结构化 */
  mode: "simple" | "advanced";
  /** simple 模式命令文本（允许换行） */
  commandText?: string;
  /** advanced 模式命令 */
  cmd?: string;
  /** advanced 模式参数 */
  args?: string[];
  /** 可选工作目录（为空则默认使用目录节点本身） */
  cwd?: string;
  /** 环境变量表（空 key 忽略；同名以最后一项为准） */
  env?: EnvRow[];
  /** 外部终端后端选择（仅影响 Build/Run，不影响其它模块） */
  backend?: BuildRunBackend;
};

export type DirBuildRunConfig = {
  build?: BuildRunCommandConfig;
  run?: BuildRunCommandConfig;
};

type StoreShape = {
  version: 1;
  items: Record<string, DirBuildRunConfig>;
};

/**
 * 获取 Build/Run 配置存储文件路径（位于 userData，避免写入仓库）。
 */
function getStorePath(): string {
  const dir = app.getPath("userData");
  return path.join(dir, "build-run.json");
}

/**
 * 从磁盘读取 Build/Run 配置（失败则返回空对象）。
 */
function loadStore(): StoreShape {
  try {
    const fp = getStorePath();
    if (!fs.existsSync(fp)) return { version: 1, items: {} };
    const raw = fs.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw || "{}") as Partial<StoreShape>;
    const items = parsed && typeof parsed === "object" && (parsed as any).items && typeof (parsed as any).items === "object" ? (parsed as any).items : {};
    return { version: 1, items: items as any };
  } catch {
    return { version: 1, items: {} };
  }
}

/**
 * 将 Build/Run 配置写回磁盘（写入失败忽略，避免阻塞主流程）。
 */
function saveStore(next: StoreShape): void {
  try {
    fs.writeFileSync(getStorePath(), JSON.stringify(next, null, 2), "utf8");
  } catch {}
}

/**
 * 读取指定目录的 Build/Run 配置（按“目录绝对路径 key”查找）。
 */
export function getDirBuildRunConfig(dirPath: string): DirBuildRunConfig | null {
  const abs = toFsPathAbs(dirPath);
  const key = toFsPathKey(abs);
  if (!key) return null;
  const store = loadStore();
  const hit = store.items[key];
  return hit && typeof hit === "object" ? (hit as DirBuildRunConfig) : null;
}

/**
 * 写入指定目录的 Build/Run 配置（按“目录绝对路径 key”覆盖）。
 */
export function setDirBuildRunConfig(dirPath: string, cfg: DirBuildRunConfig): void {
  const abs = toFsPathAbs(dirPath);
  const key = toFsPathKey(abs);
  if (!key) return;
  const store = loadStore();
  store.items[key] = cfg;
  saveStore(store);
}
