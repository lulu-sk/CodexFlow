// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getDistroHomeSubPathUNCAsync, uncToWsl } from "../wsl";

export const GEMINI_WSL_EDITOR_ENV_KEYS = {
  source: "CF_GEMINI_WSL_EDITOR_SOURCE",
  status: "CF_GEMINI_WSL_EDITOR_STATUS",
  helperScript: "CF_GEMINI_WSL_EDITOR_HELPER",
  wrapperScript: "CF_GEMINI_WSL_EDITOR_WRAP",
} as const;

export type GeminiWslEditorStatus = {
  state?: "idle" | "pending" | "done" | "error";
  requestId?: string;
  bufferPath?: string;
  message?: string;
  updatedAt?: string;
};

type GeminiWslEditorTabOptions = {
  tabId: string;
  distro: string;
};

type GeminiWslEditorWriteOptions = GeminiWslEditorTabOptions & {
  content: string;
};

type GeminiWslEditorRoots = {
  winRoot: string;
  wslRoot: string;
};

type GeminiWslEditorResolvedPaths = {
  sessionDirWin: string;
  sourcePathWin: string;
  statusPathWin: string;
  helperPathWin: string;
  wrapperPathWin: string;
  sourcePathWsl: string;
  statusPathWsl: string;
  helperPathWsl: string;
  wrapperPathWsl: string;
};

const geminiWslEditorRootByDistro = new Map<string, GeminiWslEditorRoots>();

/**
 * 中文说明：将 tabId 归一化为安全目录名，避免出现非法路径字符。
 * @param tabId 标签页标识
 * @returns 安全目录名
 */
function sanitizeTabId(tabId: string): string {
  const normalized = String(tabId || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
  return normalized || "default";
}

/**
 * 中文说明：确保目录存在；若目录已存在则忽略异常。
 * @param dir 目录路径
 */
function ensureDirSync(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/**
 * 中文说明：以 UTF-8 无 BOM 方式原子写入文本文件，避免 helper 读取到半写入状态。
 * @param targetPath 目标文件
 * @param content 文本内容
 */
async function writeTextFileAtomic(targetPath: string, content: string): Promise<void> {
  const tempPath = `${targetPath}.tmp-${Math.random().toString(36).slice(2, 8)}`;
  const encoding = new TextEncoder();
  await fsp.writeFile(tempPath, encoding.encode(content));
  await fsp.rename(tempPath, targetPath);
}

/**
 * 中文说明：将状态对象规范化为渲染层易消费的最小结构。
 * @param value 原始状态对象
 * @returns 规范化状态
 */
function normalizeGeminiWslEditorStatus(value: unknown): GeminiWslEditorStatus {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const state = String(source.state || "").trim();
  return {
    state: state === "pending" || state === "done" || state === "error" || state === "idle" ? state : undefined,
    requestId: String(source.requestId || "").trim() || undefined,
    bufferPath: String(source.bufferPath || "").trim() || undefined,
    message: String(source.message || "").trim() || undefined,
    updatedAt: String(source.updatedAt || "").trim() || undefined,
  };
}

/**
 * 中文说明：解析指定 distro 对应的 WSL 编辑器根目录。
 * - Windows 主进程通过 UNC 路径读写；
 * - Gemini / helper 在 WSL 内通过 POSIX 路径访问同一组文件。
 *
 * @param distro WSL 发行版名称
 * @returns Windows UNC 与 WSL POSIX 双路径
 */
async function resolveGeminiWslEditorRoots(distro: string): Promise<GeminiWslEditorRoots> {
  const normalizedDistro = String(distro || "").trim();
  if (!normalizedDistro)
    throw new Error("missing distro");
  const cached = geminiWslEditorRootByDistro.get(normalizedDistro);
  if (cached) return cached;

  const winRoot = String(
    await getDistroHomeSubPathUNCAsync(normalizedDistro, ".codexflow/gemini-wsl-editor"),
  ).trim();
  if (!winRoot)
    throw new Error(`failed to resolve WSL editor root for distro: ${normalizedDistro}`);

  const parsed = uncToWsl(winRoot);
  const wslRoot = String(parsed?.wslPath || "").trim();
  if (!wslRoot)
    throw new Error(`failed to convert WSL editor root to POSIX path: ${winRoot}`);

  const roots = { winRoot, wslRoot };
  geminiWslEditorRootByDistro.set(normalizedDistro, roots);
  return roots;
}

/**
 * 中文说明：解析指定 tab 在 WSL 编辑器桥接中的全部路径。
 * @param options 会话参数
 * @returns Windows/WSL 双路径集合
 */
async function resolveGeminiWslEditorPaths(
  options: GeminiWslEditorTabOptions,
): Promise<GeminiWslEditorResolvedPaths> {
  const roots = await resolveGeminiWslEditorRoots(options.distro);
  const sessionName = sanitizeTabId(options.tabId);
  return {
    sessionDirWin: path.win32.join(roots.winRoot, sessionName),
    sourcePathWin: path.win32.join(roots.winRoot, sessionName, "source.txt"),
    statusPathWin: path.win32.join(roots.winRoot, sessionName, "status.json"),
    helperPathWin: path.win32.join(roots.winRoot, "gemini-editor-helper.sh"),
    wrapperPathWin: path.win32.join(roots.winRoot, "gemini-editor-wrapper.sh"),
    sourcePathWsl: path.posix.join(roots.wslRoot, sessionName, "source.txt"),
    statusPathWsl: path.posix.join(roots.wslRoot, sessionName, "status.json"),
    helperPathWsl: path.posix.join(roots.wslRoot, "gemini-editor-helper.sh"),
    wrapperPathWsl: path.posix.join(roots.wslRoot, "gemini-editor-wrapper.sh"),
  };
}

/**
 * 中文说明：返回 Gemini WSL 外部编辑器 helper 的 Shell 脚本内容。
 * - 仅依赖 POSIX `sh`、`sed`、`mkdir`、`cat`、`date`；
 * - 不依赖脚本可执行位，由 wrapper 显式使用 `sh` 调起。
 *
 * @returns helper 脚本文本
 */
function getGeminiWslEditorHelperScriptContent(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    "",
    "json_escape() {",
    "  printf '%s' \"${1:-}\" | sed ':a;N;$!ba;s/\\\\r/ /g;s/\\\\n/ /g;s/\\\\/\\\\\\\\/g;s/\"/\\\\\"/g'",
    "}",
    "",
    "read_request_id() {",
    "  status_path=\"$1\"",
    "  if [ -z \"$status_path\" ] || [ ! -f \"$status_path\" ]; then",
    "    return 0",
    "  fi",
    "  sed -n 's/.*\"requestId\":\"\\([^\"]*\\)\".*/\\1/p' \"$status_path\" | head -n 1",
    "}",
    "",
    "write_status() {",
    "  status_path=\"$1\"",
    "  state=\"$2\"",
    "  request_id=\"$3\"",
    "  buffer_path=\"$4\"",
    "  message=\"$5\"",
    "  if [ -z \"$status_path\" ]; then",
    "    return 0",
    "  fi",
    "  mkdir -p \"$(dirname \"$status_path\")\"",
    "  escaped_request_id=$(json_escape \"$request_id\")",
    "  escaped_buffer_path=$(json_escape \"$buffer_path\")",
    "  escaped_message=$(json_escape \"$message\")",
    "  updated_at=$(date -u +\"%Y-%m-%dT%H:%M:%SZ\")",
    "  printf '{\"state\":\"%s\",\"requestId\":\"%s\",\"bufferPath\":\"%s\",\"message\":\"%s\",\"updatedAt\":\"%s\"}' \\",
    "    \"$state\" \"$escaped_request_id\" \"$escaped_buffer_path\" \"$escaped_message\" \"$updated_at\" > \"$status_path\"",
    "}",
    "",
    "resolve_buffer_path() {",
    "  last_existing=\"\"",
    "  last_non_flag=\"\"",
    "  for candidate in \"$@\"; do",
    "    if [ -z \"$candidate\" ]; then",
    "      continue",
    "    fi",
    "    if [ -e \"$candidate\" ]; then",
    "      last_existing=\"$candidate\"",
    "    fi",
    "    case \"$candidate\" in",
    "      -*) ;;",
    "      *) last_non_flag=\"$candidate\" ;;",
    "    esac",
    "  done",
    "  if [ -n \"$last_existing\" ]; then",
    "    printf '%s' \"$last_existing\"",
    "    return 0",
    "  fi",
    "  printf '%s' \"$last_non_flag\"",
    "}",
    "",
    `source_path="${"${"}${GEMINI_WSL_EDITOR_ENV_KEYS.source}:-}"`,
    `status_path="${"${"}${GEMINI_WSL_EDITOR_ENV_KEYS.status}:-}"`,
    "buffer_path=\"\"",
    "request_id=\"\"",
    "",
    "if [ -z \"$source_path\" ]; then",
    "  write_status \"$status_path\" \"error\" \"$request_id\" \"$buffer_path\" \"missing source path\"",
    "  exit 1",
    "fi",
    "",
    "buffer_path=$(resolve_buffer_path \"$@\")",
    "request_id=$(read_request_id \"$status_path\")",
    "",
    "if [ -z \"$buffer_path\" ]; then",
    "  write_status \"$status_path\" \"error\" \"$request_id\" \"$buffer_path\" \"missing buffer path\"",
    "  exit 1",
    "fi",
    "",
    "mkdir -p \"$(dirname \"$buffer_path\")\"",
    "if [ -f \"$source_path\" ]; then",
    "  cat \"$source_path\" > \"$buffer_path\"",
    "else",
    "  : > \"$buffer_path\"",
    "fi",
    "",
    "write_status \"$status_path\" \"done\" \"$request_id\" \"$buffer_path\" \"\"",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * 中文说明：返回 Gemini WSL 外部编辑器 wrapper 的 Shell 脚本内容。
 * - `EDITOR/VISUAL` 统一设置为 `sh <wrapper>`；
 * - wrapper 再显式用 `sh` 执行 helper，避免依赖可执行位。
 *
 * @returns wrapper 脚本文本
 */
function getGeminiWslEditorWrapperScriptContent(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `exec sh "${"${"}${GEMINI_WSL_EDITOR_ENV_KEYS.helperScript}}" "$@"`,
    "",
  ].join("\n");
}

/**
 * 中文说明：写入 JSON 状态文件。
 * @param statusPath 状态文件路径
 * @param status 状态内容
 */
async function writeGeminiWslEditorStatusFile(
  statusPath: string,
  status: GeminiWslEditorStatus,
): Promise<void> {
  await writeTextFileAtomic(statusPath, JSON.stringify(status));
}

/**
 * 中文说明：确保指定 tab 的 source/status 文件存在。
 * @param options 会话参数
 * @returns 已准备好的路径集合
 */
async function ensureGeminiWslEditorSessionFiles(
  options: GeminiWslEditorTabOptions,
): Promise<GeminiWslEditorResolvedPaths> {
  const paths = await resolveGeminiWslEditorPaths(options);
  ensureDirSync(paths.sessionDirWin);

  if (!fs.existsSync(paths.sourcePathWin))
    await writeTextFileAtomic(paths.sourcePathWin, "");

  if (!fs.existsSync(paths.statusPathWin)) {
    await writeGeminiWslEditorStatusFile(paths.statusPathWin, {
      state: "idle",
      updatedAt: new Date().toISOString(),
    });
  }

  return paths;
}

/**
 * 中文说明：确保 Gemini WSL 外部编辑器脚本已写入对应 distro 的 `$HOME/.codexflow`。
 * @param options 会话参数
 * @returns 已准备好的路径集合
 */
async function ensureGeminiWslEditorScripts(
  options: GeminiWslEditorTabOptions,
): Promise<GeminiWslEditorResolvedPaths> {
  const paths = await resolveGeminiWslEditorPaths(options);
  ensureDirSync(path.win32.dirname(paths.helperPathWin));
  await writeTextFileAtomic(paths.helperPathWin, getGeminiWslEditorHelperScriptContent());
  await writeTextFileAtomic(paths.wrapperPathWin, getGeminiWslEditorWrapperScriptContent());
  return paths;
}

/**
 * 中文说明：为指定 WSL Gemini tab 预创建外部编辑器桥接环境，并返回 PTY 启动 env。
 * @param options 会话参数
 * @returns 供 PTY 注入的环境变量与文件路径
 */
export async function prepareGeminiWslEditorEnv(
  options: GeminiWslEditorTabOptions,
): Promise<{ ok: true; env: Record<string, string>; sourcePath: string; statusPath: string } | { ok: false; error: string }> {
  try {
    const paths = await ensureGeminiWslEditorSessionFiles(options);
    await ensureGeminiWslEditorScripts(options);
    const command = `sh ${paths.wrapperPathWsl}`;
    return {
      ok: true,
      env: {
        EDITOR: command,
        VISUAL: command,
        [GEMINI_WSL_EDITOR_ENV_KEYS.helperScript]: paths.helperPathWsl,
        [GEMINI_WSL_EDITOR_ENV_KEYS.wrapperScript]: paths.wrapperPathWsl,
        [GEMINI_WSL_EDITOR_ENV_KEYS.source]: paths.sourcePathWsl,
        [GEMINI_WSL_EDITOR_ENV_KEYS.status]: paths.statusPathWsl,
      },
      sourcePath: paths.sourcePathWin,
      statusPath: paths.statusPathWin,
    };
  } catch (error: any) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 中文说明：为下一次 Gemini WSL 外部编辑器发送写入 source/status 文件。
 * @param options 写入参数
 * @returns 本次发送的 requestId 与会话文件路径
 */
export async function writeGeminiWslEditorSource(
  options: GeminiWslEditorWriteOptions,
): Promise<{ ok: true; requestId: string; sourcePath: string; statusPath: string } | { ok: false; error: string }> {
  try {
    const paths = await ensureGeminiWslEditorSessionFiles(options);
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeTextFileAtomic(paths.sourcePathWin, String(options.content ?? ""));
    await writeGeminiWslEditorStatusFile(paths.statusPathWin, {
      state: "pending",
      requestId,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, requestId, sourcePath: paths.sourcePathWin, statusPath: paths.statusPathWin };
  } catch (error: any) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 中文说明：读取指定 WSL tab 的 Gemini 外部编辑器状态文件。
 * @param options 会话参数
 * @returns 规范化状态
 */
export async function readGeminiWslEditorStatus(
  options: GeminiWslEditorTabOptions,
): Promise<{ ok: true; status: GeminiWslEditorStatus | null } | { ok: false; error: string }> {
  try {
    const paths = await resolveGeminiWslEditorPaths(options);
    if (!fs.existsSync(paths.statusPathWin))
      return { ok: true, status: null };
    const raw = await fsp.readFile(paths.statusPathWin, "utf8");
    if (!String(raw || "").trim())
      return { ok: true, status: null };
    const parsed = JSON.parse(raw) as unknown;
    return { ok: true, status: normalizeGeminiWslEditorStatus(parsed) };
  } catch (error: any) {
    return { ok: false, error: String(error) };
  }
}

export default {
  prepareGeminiWslEditorEnv,
  writeGeminiWslEditorSource,
  readGeminiWslEditorStatus,
};
