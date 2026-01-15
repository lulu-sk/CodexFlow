// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import type { SessionsRootCandidate } from "../../wsl";
import { getDistroHomeSubPathUNCAsync, listDistrosAsync } from "../../wsl";

/**
 * 快速判断目录是否存在。
 */
async function directoryExists(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 对根路径候选做去重（大小写不敏感、分隔符统一）。
 */
function dedupeCandidates(list: SessionsRootCandidate[]): SessionsRootCandidate[] {
  const seen = new Map<string, SessionsRootCandidate>();
  for (const item of list) {
    const key = String(item.path || "").replace(/\\/g, "/").toLowerCase();
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, item);
      continue;
    }
    if (!prev.exists && item.exists) seen.set(key, item);
  }
  return Array.from(seen.values());
}

/**
 * 获取 Gemini CLI 的根路径候选（Windows 本地 + 所有 WSL 发行版 UNC）。
 *
 * 参考：Agent Sessions (macOS) 的 discovery 约定为 `~/.gemini/tmp`。
 */
export async function getGeminiRootCandidatesFastAsync(): Promise<SessionsRootCandidate[]> {
  const list: SessionsRootCandidate[] = [];
  const push = async (p: string, source: "windows" | "wsl", kind: "local" | "unc", distro?: string) => {
    list.push({ path: p, exists: await directoryExists(p), source, kind, distro });
  };

  // 1) 显式环境变量（优先）：GEMINI_HOME 指向 ~/.gemini（则 sessions 在 tmp 下）
  try {
    const env = typeof process.env.GEMINI_HOME === "string" ? process.env.GEMINI_HOME.trim() : "";
    if (env) {
      await push(path.join(env, "tmp"), "windows", "local");
    }
  } catch {}

  // 2) 默认位置：~/.gemini/tmp
  try {
    await push(path.join(os.homedir(), ".gemini", "tmp"), "windows", "local");
  } catch {}

  // 3) Windows 下聚合 WSL：\\wsl.localhost\<distro>\home\<user>\.gemini\tmp
  if (os.platform() === "win32") {
    try {
      const distros = await listDistrosAsync();
      await Promise.all(distros.map(async (d) => {
        const unc = await getDistroHomeSubPathUNCAsync(d.name, ".gemini/tmp");
        if (!unc) return;
        await push(unc, "wsl", "unc", d.name);
      }));
    } catch {}
  }

  return dedupeCandidates(list);
}

/**
 * 扫描 Gemini CLI 会话文件：
 * - 目录结构：`root/<projectHash>/chats/session-*.json`（优先）
 * - 兼容：`root/<projectHash>/session-*.json`
 */
export async function discoverGeminiSessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const baseRoot = String(root || "").trim();
    if (!baseRoot) return out;
    if (!(await directoryExists(baseRoot))) return out;

    const projects = await fsp.readdir(baseRoot, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    for (const ent of projects) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (!name) continue;
      // 过滤：Gemini 项目目录通常是 hash（32~64 hex）
      if (!(name.length >= 32 && name.length <= 64 && /^[0-9a-fA-F]+$/.test(name))) continue;
      const projDir = path.join(baseRoot, name);

      // chats/session-*.json
      const chatsDir = path.join(projDir, "chats");
      if (await directoryExists(chatsDir)) {
        const files = await fsp.readdir(chatsDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
        for (const f of files) {
          if (!f.isFile()) continue;
          const fn = f.name.toLowerCase();
          if (fn.startsWith("session-") && fn.endsWith(".json")) out.push(path.join(chatsDir, f.name));
        }
      }

      // fallback: project dir session-*.json
      const files2 = await fsp.readdir(projDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
      for (const f of files2) {
        if (!f.isFile()) continue;
        const fn = f.name.toLowerCase();
        if (fn.startsWith("session-") && fn.endsWith(".json")) out.push(path.join(projDir, f.name));
      }
    }
  } catch {}
  return out;
}

