// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import type { SessionsRootCandidate } from "../../wsl";
import { execInWslAsync, getDistroHomeSubPathUNCAsync, listDistrosAsync, wslToUNC } from "../../wsl";

type GrokDiscoverySummary = {
  hidden?: unknown;
  session_kind?: unknown;
};

/**
 * 判断路径是否为目录。
 */
async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    return (await fsp.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 对会话根候选按规范化路径去重。
 */
function dedupeCandidates(candidates: SessionsRootCandidate[]): SessionsRootCandidate[] {
  const byPath = new Map<string, SessionsRootCandidate>();
  for (const candidate of candidates) {
    const key = String(candidate.path || "").replace(/\\/g, "/").toLowerCase();
    if (!key) continue;
    const previous = byPath.get(key);
    if (!previous || (!previous.exists && candidate.exists)) byPath.set(key, candidate);
  }
  return Array.from(byPath.values());
}

/**
 * 读取指定 WSL 发行版自己的 GROK_HOME，并转换为会话目录 UNC 路径。
 */
async function getWslConfiguredGrokSessionsRoot(distro: string): Promise<string> {
  const configuredHome = await execInWslAsync(
    distro,
    "printf '%s' \"${GROK_HOME:-}\"",
    { timeoutMs: 3_000 },
  );
  const normalizedHome = String(configuredHome || "").trim();
  if (!/^\/[^\r\n\\]*$/.test(normalizedHome)) return "";
  return wslToUNC(path.posix.join(normalizedHome, "sessions"), distro);
}

/**
 * 按 Grok Build 官方历史列表规则判断摘要文件是否应显示。
 */
async function shouldIncludeGrokSummary(summaryPath: string): Promise<boolean> {
  try {
    const raw = (await fsp.readFile(summaryPath, "utf8")).replace(/^\uFEFF/, "");
    const summary = JSON.parse(raw) as GrokDiscoverySummary;
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
    if (summary.hidden === true) return false;
    if (summary.hidden === false) return true;
    return typeof summary.session_kind !== "string" || !summary.session_kind.startsWith("subagent");
  } catch {
    return false;
  }
}

/**
 * 获取 Grok Build 会话根候选（Windows 本地与所有 WSL 发行版）。
 */
export async function getGrokRootCandidatesFastAsync(): Promise<SessionsRootCandidate[]> {
  const candidates: SessionsRootCandidate[] = [];
  const push = async (targetPath: string, source: "windows" | "wsl", kind: "local" | "unc", distro?: string) => {
    candidates.push({ path: targetPath, exists: await directoryExists(targetPath), source, kind, distro });
  };

  try {
    const configuredHome = typeof process.env.GROK_HOME === "string" ? process.env.GROK_HOME.trim() : "";
    if (configuredHome) await push(path.join(configuredHome, "sessions"), "windows", "local");
  } catch {}

  try {
    await push(path.join(os.homedir(), ".grok", "sessions"), "windows", "local");
  } catch {}

  if (os.platform() === "win32") {
    try {
      const distros = await listDistrosAsync();
      await Promise.all(distros.map(async (distro) => {
        const [configuredPath, defaultPath] = await Promise.all([
          getWslConfiguredGrokSessionsRoot(distro.name),
          getDistroHomeSubPathUNCAsync(distro.name, ".grok/sessions"),
        ]);
        await Promise.all([
          configuredPath ? push(configuredPath, "wsl", "unc", distro.name) : Promise.resolve(),
          defaultPath ? push(defaultPath, "wsl", "unc", distro.name) : Promise.resolve(),
        ]);
      }));
    } catch {}
  }

  return dedupeCandidates(candidates);
}

/**
 * 扫描 Grok Build 的会话摘要文件。
 * 官方目录结构为 `sessions/<encoded-cwd>/<session-id>/summary.json`。
 * 官方历史列表会排除显式隐藏的会话，以及未显式设为可见的 subagent 会话。
 */
export async function discoverGrokSessionFiles(root: string): Promise<string[]> {
  const sessionFiles: string[] = [];
  const baseRoot = String(root || "").trim();
  if (!baseRoot || !(await directoryExists(baseRoot))) return sessionFiles;

  const projects = await fsp.readdir(baseRoot, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(baseRoot, project.name);
    const sessions = await fsp.readdir(projectDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const summaryPath = path.join(projectDir, session.name, "summary.json");
      if (await shouldIncludeGrokSummary(summaryPath)) sessionFiles.push(summaryPath);
    }
  }

  return sessionFiles;
}
