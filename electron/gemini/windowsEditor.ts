// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

export const GEMINI_WINDOWS_EDITOR_ENV_KEYS = {
  source: "CF_GEMINI_WIN_EDITOR_SOURCE",
  status: "CF_GEMINI_WIN_EDITOR_STATUS",
  helperScript: "CF_GEMINI_WIN_EDITOR_HELPER",
  wrapperScript: "CF_GEMINI_WIN_EDITOR_WRAP",
} as const;

export type GeminiWindowsEditorStatus = {
  state?: "idle" | "pending" | "done" | "error";
  requestId?: string;
  bufferPath?: string;
  message?: string;
  updatedAt?: string;
};

type GeminiWindowsEditorTabOptions = {
  tabId: string;
};

type GeminiWindowsEditorWriteOptions = GeminiWindowsEditorTabOptions & {
  content: string;
};

/**
 * 中文说明：获取 Gemini Windows editor 会话根目录。
 * - 优先写入应用 userData，避免污染用户项目目录；
 * - 若 Electron `app` 尚不可用，则回退到用户主目录下的 `.codexflow`。
 *
 * @returns 会话根目录
 */
function getGeminiWindowsEditorRoot(): string {
  try {
    return path.join(app.getPath("userData"), "gemini-windows-editor");
  } catch {
    return path.join(os.homedir(), ".codexflow", "gemini-windows-editor");
  }
}

/**
 * 中文说明：获取 Gemini Windows 外部编辑器 helper 脚本路径。
 * @returns helper 脚本完整路径
 */
function getGeminiWindowsEditorHelperScriptPath(): string {
  return path.join(getGeminiWindowsEditorRoot(), "gemini-editor-helper.ps1");
}

/**
 * 中文说明：获取 Gemini Windows 外部编辑器包装脚本路径。
 * @returns wrapper 脚本完整路径
 */
function getGeminiWindowsEditorWrapperScriptPath(): string {
  return path.join(getGeminiWindowsEditorRoot(), "gemini-editor-wrapper.cmd");
}

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
 * 中文说明：解析指定 tab 对应的 Gemini Windows editor 会话文件路径。
 * @param options 会话参数
 * @returns source/status 文件路径
 */
function resolveGeminiWindowsEditorPaths(options: GeminiWindowsEditorTabOptions): {
  sessionDir: string;
  sourcePath: string;
  statusPath: string;
} {
  const sessionDir = path.join(getGeminiWindowsEditorRoot(), sanitizeTabId(options.tabId));
  return {
    sessionDir,
    sourcePath: path.join(sessionDir, "source.txt"),
    statusPath: path.join(sessionDir, "status.json"),
  };
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
function normalizeGeminiWindowsEditorStatus(value: unknown): GeminiWindowsEditorStatus {
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
 * 中文说明：返回 Gemini Windows 外部编辑器 helper 的 PowerShell 脚本内容。
 * - 脚本保持 ASCII，避免 Windows PowerShell 5.1 在无 BOM 文件上的编码歧义；
 * - 运行时依赖固定 env：source/status 路径，以及 Gemini 传入的 buffer 文件路径。
 *
 * @returns helper 脚本文本
 */
function getGeminiWindowsEditorHelperScriptContent(): string {
  return [
    "param([Parameter(ValueFromRemainingArguments = $true)][string[]]$EditorArgs)",
    "$ErrorActionPreference = 'Stop'",
    "",
    "function Resolve-CodexFlowBufferPath {",
    "  param([string[]]$ArgsList)",
    "  if ($null -eq $ArgsList -or $ArgsList.Count -eq 0) { return '' }",
    "  for ($i = $ArgsList.Count - 1; $i -ge 0; $i--) {",
    "    $candidate = [string]$ArgsList[$i]",
    "    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }",
    "    if (Test-Path -LiteralPath $candidate) { return [string]$candidate }",
    "  }",
    "  for ($i = $ArgsList.Count - 1; $i -ge 0; $i--) {",
    "    $candidate = [string]$ArgsList[$i]",
    "    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }",
    "    if ($candidate.StartsWith('-')) { continue }",
    "    return [string]$candidate",
    "  }",
    "  return ''",
    "}",
    "",
    "function Read-CodexFlowStatus {",
    "  param([string]$StatusPath)",
    "  if ([string]::IsNullOrWhiteSpace($StatusPath) -or -not (Test-Path -LiteralPath $StatusPath)) { return $null }",
    "  try {",
    "    $utf8 = [System.Text.Encoding]::UTF8",
    "    $raw = [System.IO.File]::ReadAllText($StatusPath, $utf8)",
    "    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }",
    "    return $raw | ConvertFrom-Json",
    "  } catch {",
    "    return $null",
    "  }",
    "}",
    "",
    "function Write-CodexFlowStatus {",
    "  param([string]$StatusPath, [string]$State, [string]$RequestId, [string]$BufferPath, [string]$Message)",
    "  if ([string]::IsNullOrWhiteSpace($StatusPath)) { return }",
    "  $payload = @{",
    "    state = $State",
    "    requestId = $RequestId",
    "    bufferPath = $BufferPath",
    "    message = $Message",
    "    updatedAt = [DateTime]::UtcNow.ToString('o')",
    "  }",
    "  $json = $payload | ConvertTo-Json -Compress",
    "  $dir = Split-Path -Parent $StatusPath",
    "  if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }",
    "  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
    "  [System.IO.File]::WriteAllText($StatusPath, $json, $utf8NoBom)",
    "}",
    `$sourcePath = [string]$env:${GEMINI_WINDOWS_EDITOR_ENV_KEYS.source}`,
    `$statusPath = [string]$env:${GEMINI_WINDOWS_EDITOR_ENV_KEYS.status}`,
    "$bufferPath = ''",
    "$requestId = ''",
    "try {",
    "  if ([string]::IsNullOrWhiteSpace($sourcePath)) { throw 'missing source path' }",
    "  $bufferPath = Resolve-CodexFlowBufferPath $EditorArgs",
    "  if ([string]::IsNullOrWhiteSpace($bufferPath)) { throw 'missing buffer path' }",
    "  $status = Read-CodexFlowStatus $statusPath",
    "  if ($status -and $status.requestId) { $requestId = [string]$status.requestId }",
    "  $content = ''",
    "  if (Test-Path -LiteralPath $sourcePath) {",
    "    $utf8 = [System.Text.Encoding]::UTF8",
    "    $content = [System.IO.File]::ReadAllText($sourcePath, $utf8)",
    "  }",
    "  $bufferDir = Split-Path -Parent $bufferPath",
    "  if (-not [string]::IsNullOrWhiteSpace($bufferDir)) { [System.IO.Directory]::CreateDirectory($bufferDir) | Out-Null }",
    "  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
    "  [System.IO.File]::WriteAllText($bufferPath, $content, $utf8NoBom)",
    "  Write-CodexFlowStatus $statusPath 'done' $requestId $bufferPath ''",
    "  exit 0",
    "} catch {",
    "  $message = $_.Exception.Message",
    "  Write-CodexFlowStatus $statusPath 'error' $requestId $bufferPath $message",
    "  exit 1",
    "}",
    "",
  ].join("\n");
}

/**
 * 中文说明：返回 Gemini Windows 外部编辑器 wrapper 的 CMD 脚本内容。
 * - Gemini 只需要启动这个 `.cmd`，由它再把全部参数 `%*` 明确转发给 PowerShell helper；
 * - 这样即使 Gemini 因环境变量字符串误判而额外插入 `--wait`，helper 也能自行解析出真正的 buffer 路径；
 * - 同时避开 `spawn(..., { shell: true })` 下多段 PowerShell 参数的兼容问题。
 *
 * @returns wrapper 脚本文本
 */
function getGeminiWindowsEditorWrapperScriptContent(): string {
  return [
    "@echo off",
    "setlocal",
    `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File %${GEMINI_WINDOWS_EDITOR_ENV_KEYS.helperScript}% %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

/**
 * 中文说明：确保 Gemini Windows 外部编辑器 helper 脚本已写入本地。
 * @returns helper 脚本路径
 */
async function ensureGeminiWindowsEditorHelperScript(): Promise<string> {
  const rootDir = getGeminiWindowsEditorRoot();
  const helperPath = getGeminiWindowsEditorHelperScriptPath();
  ensureDirSync(rootDir);
  await writeTextFileAtomic(helperPath, getGeminiWindowsEditorHelperScriptContent());
  return helperPath;
}

/**
 * 中文说明：确保 Gemini Windows 外部编辑器 wrapper 脚本已写入本地。
 * @returns wrapper 脚本路径
 */
async function ensureGeminiWindowsEditorWrapperScript(): Promise<string> {
  const rootDir = getGeminiWindowsEditorRoot();
  const wrapperPath = getGeminiWindowsEditorWrapperScriptPath();
  ensureDirSync(rootDir);
  await writeTextFileAtomic(wrapperPath, getGeminiWindowsEditorWrapperScriptContent());
  return wrapperPath;
}

/**
 * 中文说明：写入 JSON 状态文件。
 * @param statusPath 状态文件路径
 * @param status 状态内容
 */
async function writeGeminiWindowsEditorStatusFile(
  statusPath: string,
  status: GeminiWindowsEditorStatus,
): Promise<void> {
  await writeTextFileAtomic(statusPath, JSON.stringify(status));
}

/**
 * 中文说明：确保指定 tab 的 source/status 文件存在。
 * @param options 会话参数
 * @returns 已准备好的文件路径
 */
async function ensureGeminiWindowsEditorSessionFiles(options: GeminiWindowsEditorTabOptions): Promise<{
  sessionDir: string;
  sourcePath: string;
  statusPath: string;
}> {
  const paths = resolveGeminiWindowsEditorPaths(options);
  ensureDirSync(paths.sessionDir);

  if (!fs.existsSync(paths.sourcePath))
    await writeTextFileAtomic(paths.sourcePath, "");

  if (!fs.existsSync(paths.statusPath)) {
    await writeGeminiWindowsEditorStatusFile(paths.statusPath, {
      state: "idle",
      updatedAt: new Date().toISOString(),
    });
  }

  return paths;
}

/**
 * 中文说明：为指定 tab 预创建 Gemini Windows editor 所需文件，并返回 PTY 启动环境变量。
 * @param options 会话参数
 * @returns 供 PTY 注入的环境变量与文件路径
 */
export async function prepareGeminiWindowsEditorEnv(
  options: GeminiWindowsEditorTabOptions,
): Promise<{ ok: true; env: Record<string, string>; sourcePath: string; statusPath: string } | { ok: false; error: string }> {
  try {
    const paths = await ensureGeminiWindowsEditorSessionFiles(options);
    const helperPath = await ensureGeminiWindowsEditorHelperScript();
    const wrapperPath = await ensureGeminiWindowsEditorWrapperScript();
    const command = `%${GEMINI_WINDOWS_EDITOR_ENV_KEYS.wrapperScript}%`;
    return {
      ok: true,
      env: {
        EDITOR: command,
        VISUAL: command,
        [GEMINI_WINDOWS_EDITOR_ENV_KEYS.helperScript]: `"${helperPath}"`,
        [GEMINI_WINDOWS_EDITOR_ENV_KEYS.wrapperScript]: `"${wrapperPath}"`,
        [GEMINI_WINDOWS_EDITOR_ENV_KEYS.source]: paths.sourcePath,
        [GEMINI_WINDOWS_EDITOR_ENV_KEYS.status]: paths.statusPath,
      },
      sourcePath: paths.sourcePath,
      statusPath: paths.statusPath,
    };
  } catch (error: any) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 中文说明：为下一次 `Ctrl+X` 外部编辑器发送写入 source/status 文件。
 * - source 文件承载本次完整正文；
 * - status 文件会先被置为 `pending`，helper 完成后再改为 `done/error`。
 *
 * @param options 写入参数
 * @returns 本次发送的 requestId 与会话文件路径
 */
export async function writeGeminiWindowsEditorSource(
  options: GeminiWindowsEditorWriteOptions,
): Promise<{ ok: true; requestId: string; sourcePath: string; statusPath: string } | { ok: false; error: string }> {
  try {
    const paths = await ensureGeminiWindowsEditorSessionFiles(options);
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeTextFileAtomic(paths.sourcePath, String(options.content ?? ""));
    await writeGeminiWindowsEditorStatusFile(paths.statusPath, {
      state: "pending",
      requestId,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, requestId, sourcePath: paths.sourcePath, statusPath: paths.statusPath };
  } catch (error: any) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 中文说明：读取指定 tab 的 Gemini Windows editor 状态文件。
 * @param options 会话参数
 * @returns 当前状态；文件缺失/损坏时返回 `null`
 */
export async function readGeminiWindowsEditorStatus(
  options: GeminiWindowsEditorTabOptions,
): Promise<{ ok: true; status: GeminiWindowsEditorStatus | null } | { ok: false; error: string }> {
  try {
    const { statusPath } = resolveGeminiWindowsEditorPaths(options);
    if (!fs.existsSync(statusPath))
      return { ok: true, status: null };
    const raw = await fsp.readFile(statusPath, "utf8");
    if (!String(raw || "").trim())
      return { ok: true, status: null };
    const parsed = JSON.parse(raw) as unknown;
    return { ok: true, status: normalizeGeminiWindowsEditorStatus(parsed) };
  } catch (error: any) {
    return { ok: false, error: String(error) };
  }
}

export default {
  prepareGeminiWindowsEditorEnv,
  writeGeminiWindowsEditorSource,
  readGeminiWindowsEditorStatus,
};
