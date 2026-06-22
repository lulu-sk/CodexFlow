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
 * 对根路径候选做去重，优先保留存在的路径。
 */
function dedupeCandidates(list: SessionsRootCandidate[]): SessionsRootCandidate[] {
  const seen = new Map<string, SessionsRootCandidate>();
  for (const item of list) {
    const key = String(item.path || "").replace(/\\/g, "/").toLowerCase();
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev || (!prev.exists && item.exists)) seen.set(key, item);
  }
  return Array.from(seen.values());
}

/**
 * 获取 Antigravity CLI conversation DB 根路径候选（Windows 本地 + WSL UNC）。
 */
export async function getAntigravityRootCandidatesFastAsync(): Promise<SessionsRootCandidate[]> {
  const list: SessionsRootCandidate[] = [];
  const push = async (p: string, source: "windows" | "wsl", kind: "local" | "unc", distro?: string) => {
    list.push({ path: p, exists: await directoryExists(p), source, kind, distro });
  };

  try {
    const envRoot = typeof process.env.ANTIGRAVITY_HOME === "string" ? process.env.ANTIGRAVITY_HOME.trim() : "";
    if (envRoot) await push(path.join(envRoot, "conversations"), "windows", "local");
  } catch {}

  try {
    const geminiHome = typeof process.env.GEMINI_HOME === "string" ? process.env.GEMINI_HOME.trim() : "";
    if (geminiHome) await push(path.join(geminiHome, "antigravity-cli", "conversations"), "windows", "local");
  } catch {}

  try {
    await push(path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations"), "windows", "local");
  } catch {}

  if (os.platform() === "win32") {
    try {
      const distros = await listDistrosAsync();
      await Promise.all(distros.map(async (d) => {
        const unc = await getDistroHomeSubPathUNCAsync(d.name, ".gemini/antigravity-cli/conversations");
        if (!unc) return;
        await push(unc, "wsl", "unc", d.name);
      }));
    } catch {}
  }

  return dedupeCandidates(list);
}

/**
 * 扫描 Antigravity CLI 会话 DB 文件。
 */
export async function discoverAntigravitySessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const baseRoot = String(root || "").trim();
    if (!baseRoot || !(await directoryExists(baseRoot))) return out;
    const entries = await fsp.readdir(baseRoot, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const name = ent.name;
      const lower = name.toLowerCase();
      if (!lower.endsWith(".db")) continue;
      if (lower.endsWith(".db-wal") || lower.endsWith(".db-shm")) continue;
      out.push(path.join(baseRoot, name));
    }
  } catch {}
  return out;
}
