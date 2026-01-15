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
 * 获取 Claude Code 的根路径候选（Windows 本地 + 所有 WSL 发行版 UNC）。
 */
export async function getClaudeRootCandidatesFastAsync(): Promise<SessionsRootCandidate[]> {
  const list: SessionsRootCandidate[] = [];
  const push = async (p: string, source: "windows" | "wsl", kind: "local" | "unc", distro?: string) => {
    list.push({ path: p, exists: await directoryExists(p), source, kind, distro });
  };

  // 1) 显式环境变量（优先）
  try {
    const envCandidates = [
      process.env.CLAUDE_HOME,
      process.env.CLAUDE_CONFIG_DIR,
    ]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    for (const p of envCandidates) {
      await push(p, os.platform() === "win32" ? "windows" : "windows", "local");
    }
  } catch {}

  // 2) 默认位置：~/.claude
  try {
    await push(path.join(os.homedir(), ".claude"), "windows", "local");
  } catch {}

  // 3) Windows 下聚合 WSL：\\wsl.localhost\<distro>\home\<user>\.claude
  if (os.platform() === "win32") {
    try {
      const distros = await listDistrosAsync();
      await Promise.all(distros.map(async (d) => {
        const unc = await getDistroHomeSubPathUNCAsync(d.name, ".claude");
        if (!unc) return;
        await push(unc, "wsl", "unc", d.name);
      }));
    } catch {}
  }

  return dedupeCandidates(list);
}

/**
 * 扫描 Claude Code 会话文件：
 * - 优先扫描 `root/projects`（避免拾取 root 下无关的 JSONL）
 * - 递归收集 `.jsonl` 与 `.ndjson`
 */
export type ClaudeDiscoveryOptions = {
  /** 是否包含 Claude Code 的 Agent 历史（例如 agent-*.jsonl；默认 false）。 */
  includeAgentHistory?: boolean;
};

/**
 * 判断文件名是否为 Claude Code Agent 历史（agent-*.jsonl）。
 */
function isClaudeAgentHistoryFileName(fileName: string): boolean {
  try {
    const lower = String(fileName || "").toLowerCase();
    return lower.startsWith("agent-") && lower.endsWith(".jsonl");
  } catch {
    return false;
  }
}

/**
 * 发现 Claude Code 会话文件（支持按设置过滤 Agent 历史）。
 */
export async function discoverClaudeSessionFiles(root: string, opts?: ClaudeDiscoveryOptions): Promise<string[]> {
  const out: string[] = [];
  try {
    const baseRoot = String(root || "").trim();
    if (!baseRoot) return out;
    if (!(await directoryExists(baseRoot))) return out;

    const includeAgentHistory = !!opts?.includeAgentHistory;

    const projectsRoot = path.join(baseRoot, "projects");
    const scanRoot = (await directoryExists(projectsRoot)) ? projectsRoot : baseRoot;

    const stack: string[] = [scanRoot];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let entries: Array<import("node:fs").Dirent> = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const name = ent.name;
        if (!name) continue;
        const full = path.join(dir, name);
        if (ent.isDirectory()) {
          // 跳过明显无关的超大目录
          if (name === "node_modules" || name === ".git") continue;
          stack.push(full);
          continue;
        }
        if (!ent.isFile()) continue;
        const lower = name.toLowerCase();
        if (!includeAgentHistory && isClaudeAgentHistoryFileName(lower)) continue;
        if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
          out.push(full);
        }
      }
    }
  } catch {}
  return out;
}

