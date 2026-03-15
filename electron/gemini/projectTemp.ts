// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDistroHomeSubPathUNCAsync } from "../wsl";

export type GeminiRuntimeEnv = "wsl" | "windows" | "pwsh";

export type ResolveGeminiProjectTempOptions = {
  projectWinRoot?: string;
  projectWslRoot?: string;
  runtimeEnv?: GeminiRuntimeEnv;
  distro?: string;
};

type GeminiRegistryData = {
  projects?: Record<string, string>;
};

const GEMINI_PROJECT_ROOT_MARKER = ".project_root";

/**
 * 中文说明：清理路径候选，统一去除包裹引号、JSON 转义反斜杠与尾部分隔符。
 */
function tidyPathCandidate(value: string): string {
  try {
    let s = String(value || "")
      .replace(/\\n/g, "")
      .replace(/^"|"$/g, "")
      .replace(/^'|'$/g, "")
      .trim();
    if (s.startsWith("\\\\"))
      s = `\\\\${s.slice(2).replace(/\\\\/g, "\\")}`;
    else
      s = s.replace(/\\\\/g, "\\");
    s = s.trim();
    s = s.replace(/[\\/]+$/g, "");
    return s;
  } catch {
    return String(value || "").trim();
  }
}

/**
 * 中文说明：判断当前路径是否为 Windows/UNC 风格，用于选择与 Gemini 一致的路径规范化策略。
 */
function isWindowsStylePath(inputPath: string): boolean {
  const value = tidyPathCandidate(inputPath);
  return /^([a-zA-Z]:[\\/]|\\\\)/.test(value);
}

/**
 * 中文说明：按 Gemini `ProjectRegistry.normalizePath` 语义规范化项目路径。
 * - Windows/UNC 路径统一用 `path.win32.resolve` 且转小写
 * - POSIX/WSL 路径统一用 `path.posix.resolve`
 */
function normalizeGeminiProjectPath(inputPath: string): string {
  const raw = tidyPathCandidate(inputPath);
  if (!raw) return "";
  if (isWindowsStylePath(raw)) {
    const normalized = raw.replace(/\//g, "\\");
    return path.win32.resolve(normalized).toLowerCase();
  }
  return path.posix.resolve(raw.replace(/\\/g, "/"));
}

/**
 * 中文说明：根据路径风格选择合适的 join，避免在非 Windows 平台拼接 UNC 路径时分隔符被破坏。
 */
function joinByPathStyle(basePath: string, ...segments: string[]): string {
  if (isWindowsStylePath(basePath))
    return path.win32.join(basePath, ...segments);
  return path.posix.join(basePath, ...segments);
}

/**
 * 中文说明：按 Gemini `ProjectRegistry.slugify` 规则生成目录 slug。
 */
function slugifyGeminiProjectName(inputName: string): string {
  return (
    String(inputName || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "project"
  );
}

/**
 * 中文说明：读取 Gemini `projects.json`，损坏或缺失时回退为空映射。
 */
async function readGeminiRegistryData(registryPath: string): Promise<Record<string, string>> {
  try {
    const raw = await fsp.readFile(registryPath, "utf8");
    const data = JSON.parse(raw) as GeminiRegistryData;
    const projects = data?.projects;
    return projects && typeof projects === "object" ? projects : {};
  } catch {
    return {};
  }
}

/**
 * 中文说明：读取目录 ownership marker，对应 Gemini `ProjectRegistry` 的 `.project_root` 文件。
 */
async function readGeminiProjectOwner(markerPath: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(markerPath, "utf8");
    const normalized = normalizeGeminiProjectPath(raw);
    return normalized || null;
  } catch {
    return null;
  }
}

/**
 * 中文说明：校验 registry 中的 shortId 是否仍属于当前项目。
 * - 若 marker 缺失，按 Gemini 原实现视为可接受
 * - 若任一 marker 指向其他项目，则判定该 shortId 不可用
 */
async function verifyGeminiProjectIdOwnership(
  projectId: string,
  baseDirs: string[],
  normalizedProjectRoot: string,
): Promise<boolean> {
  for (const baseDir of baseDirs) {
    const markerPath = joinByPathStyle(baseDir, projectId, GEMINI_PROJECT_ROOT_MARKER);
    if (!fs.existsSync(markerPath)) continue;
    const owner = await readGeminiProjectOwner(markerPath);
    if (!owner) return false;
    if (owner !== normalizedProjectRoot) return false;
  }
  return true;
}

/**
 * 中文说明：扫描 Gemini temp/history 目录下的 marker，反查当前项目已占用的 shortId。
 */
async function findExistingGeminiProjectId(
  baseDirs: string[],
  normalizedProjectRoot: string,
): Promise<string | null> {
  for (const baseDir of baseDirs) {
    if (!baseDir || !fs.existsSync(baseDir)) continue;
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(baseDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const markerPath = joinByPathStyle(baseDir, entry, GEMINI_PROJECT_ROOT_MARKER);
      if (!fs.existsSync(markerPath)) continue;
      const owner = await readGeminiProjectOwner(markerPath);
      if (owner === normalizedProjectRoot) return entry;
    }
  }
  return null;
}

/**
 * 中文说明：收集 registry 与 marker 已占用的 shortId，避免与其他项目发生 slug 冲突。
 */
async function collectTakenGeminiProjectIds(
  registryProjects: Record<string, string>,
  baseDirs: string[],
  normalizedProjectRoot: string,
): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const [projectRoot, projectId] of Object.entries(registryProjects || {})) {
    const normalizedRoot = normalizeGeminiProjectPath(projectRoot);
    if (!projectId) continue;
    if (normalizedRoot && normalizedRoot !== normalizedProjectRoot)
      taken.add(String(projectId));
  }
  for (const baseDir of baseDirs) {
    if (!baseDir || !fs.existsSync(baseDir)) continue;
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(baseDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const markerPath = joinByPathStyle(baseDir, entry, GEMINI_PROJECT_ROOT_MARKER);
      if (!fs.existsSync(markerPath)) continue;
      const owner = await readGeminiProjectOwner(markerPath);
      if (owner && owner !== normalizedProjectRoot)
        taken.add(entry);
    }
  }
  return taken;
}

/**
 * 中文说明：为当前项目声明一个 Gemini shortId。
 * - 仅在 temp 根目录创建 marker，避免额外写入 history 目录
 * - 使用 `wx` 原子写入 marker，尽量贴近 Gemini 原始实现的并发安全语义
 */
async function claimGeminiProjectId(
  tempBaseDir: string,
  scanBaseDirs: string[],
  registryProjects: Record<string, string>,
  normalizedProjectRoot: string,
  rawProjectRoot: string,
): Promise<string | null> {
  const baseName = isWindowsStylePath(rawProjectRoot)
    ? path.win32.basename(tidyPathCandidate(rawProjectRoot))
    : path.posix.basename(tidyPathCandidate(rawProjectRoot).replace(/\\/g, "/"));
  const baseSlug = slugifyGeminiProjectName(baseName || "project");
  const taken = await collectTakenGeminiProjectIds(registryProjects, scanBaseDirs, normalizedProjectRoot);

  for (let index = 0; index < 10_000; index++) {
    const candidate = index === 0 ? baseSlug : `${baseSlug}-${index}`;
    if (taken.has(candidate)) continue;

    let hasCollision = false;
    for (const baseDir of scanBaseDirs) {
      const markerPath = joinByPathStyle(baseDir, candidate, GEMINI_PROJECT_ROOT_MARKER);
      if (!fs.existsSync(markerPath)) continue;
      const owner = await readGeminiProjectOwner(markerPath);
      if (owner && owner !== normalizedProjectRoot) {
        hasCollision = true;
        break;
      }
    }
    if (hasCollision) continue;

    try {
      const projectDir = joinByPathStyle(tempBaseDir, candidate);
      const markerPath = joinByPathStyle(projectDir, GEMINI_PROJECT_ROOT_MARKER);
      await fsp.mkdir(projectDir, { recursive: true });
      try {
        await fsp.writeFile(markerPath, normalizedProjectRoot, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error: any) {
        if (String(error?.code || "") !== "EEXIST")
          throw error;
        const owner = await readGeminiProjectOwner(markerPath);
        if (owner !== normalizedProjectRoot) {
          taken.add(candidate);
          continue;
        }
      }
      return candidate;
    } catch {
      taken.add(candidate);
    }
  }
  return null;
}

/**
 * 中文说明：根据运行环境选择当前 Gemini 项目的“真实项目根路径”。
 * - WSL 优先使用 WSL 根路径
 * - Windows/Pwsh 优先使用 Windows 根路径
 */
function resolveGeminiProjectRoot(options: ResolveGeminiProjectTempOptions): string {
  const runtimeEnv = options.runtimeEnv || "windows";
  const preferredRoot =
    runtimeEnv === "wsl"
      ? String(options.projectWslRoot || options.projectWinRoot || "").trim()
      : String(options.projectWinRoot || options.projectWslRoot || "").trim();
  if (preferredRoot) return preferredRoot;
  return runtimeEnv === "wsl"
    ? String(options.projectWinRoot || "").trim()
    : String(options.projectWslRoot || "").trim();
}

/**
 * 中文说明：解析 Windows/Pwsh 模式下 Gemini 主目录。
 * - 优先兼容 Gemini CLI 的 `GEMINI_CLI_HOME`
 * - 未配置时回退到 `%USERPROFILE%\\.gemini`
 */
function resolveGeminiHomeWindows(): string {
  const configured = String(process.env.GEMINI_CLI_HOME || "").trim();
  if (configured) return configured;
  return path.win32.join(os.homedir(), ".gemini");
}

/**
 * 中文说明：将 Windows 主进程中读取到的 `GEMINI_CLI_HOME` 转换为 WSL 运行时可直接访问的路径。
 * - Windows/UNC 路径直接复用
 * - WSL 绝对路径转成 `\\\\wsl.localhost\\<distro>\\...`
 * - `~/...` 与相对路径按 `$HOME/<subPath>` 解析为 UNC
 */
async function resolveConfiguredGeminiHomeForWindowsWsl(
  configuredHome: string,
  distro: string,
): Promise<string | null> {
  const value = tidyPathCandidate(configuredHome);
  if (!value) return null;
  if (isWindowsStylePath(value)) return value;

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    const tail = normalized.replace(/^\/+/, "").split("/").filter(Boolean).join("\\");
    return tail
      ? `\\\\wsl.localhost\\${distro}\\${tail}`
      : `\\\\wsl.localhost\\${distro}`;
  }

  const homeRelative = normalized === "~"
    ? "."
    : normalized.startsWith("~/")
      ? normalized.slice(2)
      : normalized.replace(/^\.\//, "");
  const unc = await getDistroHomeSubPathUNCAsync(distro, homeRelative || ".");
  const cleaned = tidyPathCandidate(unc || "");
  return cleaned || null;
}

/**
 * 中文说明：解析当前运行环境下、主进程可访问的 Gemini 根目录。
 * - 非 WSL 场景优先直接使用 `GEMINI_CLI_HOME`
 * - Windows 主进程 + WSL 运行时若 `GEMINI_CLI_HOME` 已是 Windows/UNC 路径，则无需 distro 也可直接复用
 * - Windows 主进程 + WSL 运行时若 `GEMINI_CLI_HOME` 为 POSIX 路径，则转成 UNC
 * - WSL on Windows 返回 UNC 路径
 * - WSL 单元测试/非 Windows 环境优先使用 `GEMINI_CLI_HOME`，否则返回 POSIX `~/.gemini`
 * - Windows/Pwsh 返回本机 `%USERPROFILE%\\.gemini`
 */
async function resolveGeminiHomePath(
  options: ResolveGeminiProjectTempOptions,
): Promise<string | null> {
  const configuredHome = String(process.env.GEMINI_CLI_HOME || "").trim();
  const runtimeEnv = options.runtimeEnv || "windows";
  if (runtimeEnv !== "wsl") return resolveGeminiHomeWindows();
  if (os.platform() !== "win32")
    return configuredHome || path.posix.join(os.homedir(), ".gemini");
  if (configuredHome && isWindowsStylePath(configuredHome))
    return tidyPathCandidate(configuredHome);
  const distro = String(options.distro || "").trim();
  if (!distro) return null;
  if (configuredHome) {
    const converted = await resolveConfiguredGeminiHomeForWindowsWsl(configuredHome, distro);
    if (converted) return converted;
  }
  const uncBase = await getDistroHomeSubPathUNCAsync(distro, ".gemini");
  return uncBase || null;
}

/**
 * 中文说明：解析 Gemini 当前项目的 shortId。
 * - 先读 `projects.json`
 * - 再扫描 temp/history 目录中的 `.project_root`
 * - 最后按 Gemini slug 规则在 temp 根目录原子声明一个 shortId
 */
export async function resolveGeminiProjectIdentifier(
  options: ResolveGeminiProjectTempOptions,
): Promise<string | null> {
  try {
    const rawProjectRoot = resolveGeminiProjectRoot(options);
    const normalizedProjectRoot = normalizeGeminiProjectPath(rawProjectRoot);
    if (!normalizedProjectRoot) return null;

    const geminiHome = await resolveGeminiHomePath(options);
    if (!geminiHome) return null;

    const registryPath = joinByPathStyle(geminiHome, "projects.json");
    const tempBaseDir = joinByPathStyle(geminiHome, "tmp");
    const historyBaseDir = joinByPathStyle(geminiHome, "history");
    const scanBaseDirs = [tempBaseDir, historyBaseDir];
    const registryProjects = await readGeminiRegistryData(registryPath);

    const mappedProjectId = String(registryProjects[normalizedProjectRoot] || "").trim();
    if (mappedProjectId) {
      const isOwned = await verifyGeminiProjectIdOwnership(
        mappedProjectId,
        scanBaseDirs,
        normalizedProjectRoot,
      );
      if (isOwned) return mappedProjectId;
    }

    const existingProjectId = await findExistingGeminiProjectId(scanBaseDirs, normalizedProjectRoot);
    if (existingProjectId) return existingProjectId;

    return await claimGeminiProjectId(
      tempBaseDir,
      scanBaseDirs,
      registryProjects,
      normalizedProjectRoot,
      rawProjectRoot,
    );
  } catch {
    return null;
  }
}

/**
 * 中文说明：解析 Gemini 项目的 temp 根目录（Windows 可访问路径，WSL 模式返回 UNC）。
 */
export async function resolveGeminiProjectTempRootWinPath(
  options: ResolveGeminiProjectTempOptions,
): Promise<string | null> {
  const projectId = await resolveGeminiProjectIdentifier(options);
  if (!projectId) return null;

  const geminiHome = await resolveGeminiHomePath(options);
  if (!geminiHome) return null;
  return joinByPathStyle(geminiHome, "tmp", projectId);
}

/**
 * 中文说明：解析 Gemini 图片临时目录（Windows 可访问路径，WSL 模式返回 UNC）。
 */
export async function resolveGeminiImageDirWinPath(
  options: ResolveGeminiProjectTempOptions,
): Promise<string | null> {
  const tempRoot = await resolveGeminiProjectTempRootWinPath(options);
  if (!tempRoot) return null;
  return joinByPathStyle(tempRoot, "images");
}
